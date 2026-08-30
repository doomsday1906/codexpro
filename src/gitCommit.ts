import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import { withFileWriteLocks } from "./fsOps.js";
import { GitExecutionError, runGitMutation, type GitExecutionResult } from "./gitOps.js";
import { CodexProError, isSubpath, type PathGuard, type Workspace } from "./guard.js";

/** Internal bounds shared by the preflight and the later public schema. */
export const GIT_COMMIT_MAX_PATHS = 100;
export const GIT_COMMIT_MAX_PATH_BYTES = 4_096;
export const GIT_COMMIT_MAX_MESSAGE_BYTES = 20_000;

export interface GitCommitRequest {
  readonly workspace_id: string;
  readonly paths: readonly string[];
  readonly message: string;
  readonly expected_head: string;
}

export type GitCommitFailureReason =
  | "invalid-input"
  | "workspace"
  | "repository"
  | "detached"
  | "unborn"
  | "in-progress"
  | "head-mismatch"
  | "unmerged"
  | "invalid-path"
  | "blocked-path"
  | "directory"
  | "missing-path"
  | "gitlink"
  | "ignored"
  | "unsupported-path"
  | "malformed-output"
  | "execution"
  | "preflight-changed";

const FAILURE_MESSAGES: Record<GitCommitFailureReason, string> = {
  "invalid-input": "Git commit input is invalid.",
  workspace: "Git commit workspace identity is invalid.",
  repository: "Git commit requires the exact root of a non-bare Git worktree.",
  detached: "Git commit requires an attached local branch.",
  unborn: "Git commit requires an existing HEAD commit.",
  "in-progress": "Git commit is unavailable during an in-progress history operation.",
  "head-mismatch": "Git commit expected_head does not match the current HEAD.",
  unmerged: "Git commit is unavailable while the index has unmerged entries.",
  "invalid-path": "Git commit path input is invalid.",
  "blocked-path": "Git commit path is blocked by safety rules.",
  directory: "Git commit paths must identify individual files or symlink entries.",
  "missing-path": "Git commit path is neither present nor tracked for deletion.",
  gitlink: "Git commit does not accept gitlink or submodule paths.",
  ignored: "Git commit does not force-add ignored untracked paths.",
  "unsupported-path": "Git commit path has an unsupported filesystem type.",
  "malformed-output": "Git returned malformed commit preflight output.",
  execution: "Git commit preflight failed during local Git execution.",
  "preflight-changed": "Git commit preflight changed while waiting for its locks; retry."
};

/** Constant-message, JSON-safe internal failure. Caller data is never echoed. */
export class GitCommitError extends CodexProError {
  constructor(readonly reason: GitCommitFailureReason) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitCommitError";
  }

  toJSON(): object {
    return { name: this.name, message: this.message, reason: this.reason };
  }
}

export interface GitIndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: number;
  readonly path: string;
}

export type GitWorktreeEntryKind = "missing" | "file" | "symlink" | "directory" | "other";

export interface GitWorktreeEntryState {
  readonly kind: GitWorktreeEntryKind;
  readonly mode: number | null;
  readonly size: number | null;
  readonly contentHash: string | null;
  readonly linkTarget: string | null;
}

export interface GitCommitPathPreflight {
  readonly path: string;
  readonly absPath: string;
  readonly status: string;
  readonly indexEntries: readonly GitIndexEntry[];
  readonly worktree: GitWorktreeEntryState;
}

export interface GitCommitPreflight {
  readonly request: GitCommitRequest;
  readonly workspaceId: string;
  readonly root: string;
  readonly gitDir: string;
  readonly objectFormat: "sha1" | "sha256";
  readonly branch: string;
  readonly head: string;
  readonly selected: readonly GitCommitPathPreflight[];
}

export type GitCommitConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes">;

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const GIT_HISTORY_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer"
] as const;

function fail(reason: GitCommitFailureReason): never {
  throw new GitCommitError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalInputPath(rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) return fail("invalid-path");
  if (Buffer.byteLength(rawPath, "utf8") > GIT_COMMIT_MAX_PATH_BYTES) return fail("invalid-path");
  if (CONTROL_CHARACTER_PATTERN.test(rawPath)) return fail("invalid-path");
  if (rawPath.startsWith("/") || rawPath.startsWith("\\") || WINDOWS_DRIVE_PREFIX_PATTERN.test(rawPath)) {
    return fail("invalid-path");
  }
  if (rawPath.endsWith("/") || rawPath.endsWith("\\")) return fail("invalid-path");

  const normalized = rawPath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.startsWith("//")) return fail("invalid-path");
  const components = normalized.split("/");
  if (components.some((component) => component === "..")) return fail("invalid-path");
  const canonicalComponents = components.filter((component) => component.length > 0 && component !== ".");
  if (canonicalComponents.length === 0) return fail("invalid-path");
  // Reject the Git pathspec magic forms while retaining ordinary filenames
  // such as `:notes` as data. The mutation runner also fixes literal mode.
  if (/^:(?:\(|[!^/]|$)/u.test(normalized)) return fail("invalid-path");
  if (canonicalComponents.some((component) => component === ".git")) return fail("invalid-path");
  return canonicalComponents.join("/");
}

/** Strict internal transport validation; no default workspace is consulted. */
export function validateGitCommitRequest(raw: unknown): GitCommitRequest {
  if (!isRecord(raw)) return fail("invalid-input");
  const keys = Object.keys(raw);
  if (
    keys.length !== 4 ||
    !keys.every((key) => key === "workspace_id" || key === "paths" || key === "message" || key === "expected_head")
  ) {
    return fail("invalid-input");
  }

  const workspaceId = raw.workspace_id;
  if (
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    workspaceId.length > 128 ||
    workspaceId.trim() !== workspaceId
  ) {
    return fail("invalid-input");
  }

  if (!Array.isArray(raw.paths) || raw.paths.length < 1 || raw.paths.length > GIT_COMMIT_MAX_PATHS) {
    return fail("invalid-input");
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of raw.paths) {
    const normalized = canonicalInputPath(rawPath);
    if (seen.has(normalized)) return fail("invalid-path");
    seen.add(normalized);
    paths.push(normalized);
  }

  const message = raw.message;
  if (
    typeof message !== "string" ||
    Buffer.byteLength(message, "utf8") === 0 ||
    Buffer.byteLength(message, "utf8") > GIT_COMMIT_MAX_MESSAGE_BYTES ||
    message.trim().length === 0 ||
    message.includes("\u0000")
  ) {
    return fail("invalid-input");
  }

  const expectedHead = raw.expected_head;
  if (
    typeof expectedHead !== "string" ||
    expectedHead.length === 0 ||
    expectedHead.trim() !== expectedHead ||
    Buffer.byteLength(expectedHead, "utf8") > 64 ||
    !OBJECT_ID_PATTERN.test(expectedHead)
  ) {
    return fail("invalid-input");
  }

  return { workspace_id: workspaceId, paths, message, expected_head: expectedHead.toLowerCase() };
}

function decodeGitUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    return fail("malformed-output");
  }
}

function nulFields(bytes: Buffer): Buffer[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) return fail("malformed-output");
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(Buffer.from(bytes.subarray(start, index)));
    start = index + 1;
  }
  if (start !== bytes.length) return fail("malformed-output");
  return fields;
}

function oneLine(result: GitExecutionResult): string {
  const text = decodeGitUtf8(result.copyStdoutBytes());
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || lines[0].includes("\r")) return fail("malformed-output");
  return lines[0];
}

function objectFormatFromResult(result: GitExecutionResult): "sha1" | "sha256" {
  const value = oneLine(result);
  if (value === "sha1" || value === "sha256") return value;
  return fail("malformed-output");
}

function objectIdPattern(format: "sha1" | "sha256"): RegExp {
  return format === "sha1" ? /^[0-9a-f]{40}$/iu : /^[0-9a-f]{64}$/iu;
}

function parseObjectId(value: string, format: "sha1" | "sha256"): string {
  const normalized = value.toLowerCase();
  if (!objectIdPattern(format).test(normalized)) return fail("malformed-output");
  return normalized;
}

async function runGitChecked(config: GitCommitConfig, workspace: Workspace, args: readonly string[]): Promise<GitExecutionResult> {
  try {
    return await runGitMutation(config, workspace, args);
  } catch (error) {
    if (error instanceof GitCommitError) throw error;
    if (error instanceof GitExecutionError) return fail("execution");
    return fail("execution");
  }
}

async function runGitAllowExit(
  config: GitCommitConfig,
  workspace: Workspace,
  args: readonly string[],
  allowedExitCode: number
): Promise<GitExecutionResult | undefined> {
  try {
    return await runGitMutation(config, workspace, args, { literalPathspecs: false });
  } catch (error) {
    if (error instanceof GitExecutionError && error.failure === "exit" && error.result.exitCode === allowedExitCode) {
      return undefined;
    }
    return fail("execution");
  }
}

function parseIndexEntries(bytes: Buffer, format: "sha1" | "sha256", selected: ReadonlySet<string>): Map<string, GitIndexEntry[]> {
  const entries = new Map<string, GitIndexEntry[]>();
  for (const field of nulFields(bytes)) {
    const tab = field.indexOf(0x09);
    if (tab <= 0) return fail("malformed-output");
    const header = decodeGitUtf8(field.subarray(0, tab));
    const entryPath = decodeGitUtf8(field.subarray(tab + 1));
    if (!selected.has(entryPath) || CONTROL_CHARACTER_PATTERN.test(entryPath)) return fail("malformed-output");
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/iu.exec(header);
    if (!match || !objectIdPattern(format).test(match[2])) return fail("malformed-output");
    const entry: GitIndexEntry = {
      mode: match[1],
      objectId: match[2].toLowerCase(),
      stage: Number(match[3]),
      path: entryPath
    };
    const prior = entries.get(entryPath) ?? [];
    prior.push(entry);
    entries.set(entryPath, prior);
  }
  for (const values of entries.values()) values.sort((left, right) => left.stage - right.stage);
  return entries;
}

function parseStatusPaths(bytes: Buffer): Map<string, string> {
  const fields = nulFields(bytes);
  const statuses = new Map<string, string>();
  const pathAfterFields = (record: string, fieldsBeforePath: number): string => {
    let separator = -1;
    for (let count = 0; count < fieldsBeforePath; count += 1) {
      separator = record.indexOf(" ", separator + 1);
      if (separator < 0) return fail("malformed-output");
    }
    return record.slice(separator + 1);
  };
  for (let index = 0; index < fields.length; index += 1) {
    const record = decodeGitUtf8(fields[index]);
    if (record.startsWith("# ")) continue;
    if (record.startsWith("? ") || record.startsWith("! ")) {
      const entryPath = record.slice(2);
      if (!entryPath || CONTROL_CHARACTER_PATTERN.test(entryPath)) return fail("malformed-output");
      statuses.set(entryPath, record.slice(0, 2));
      continue;
    }
    if (record.startsWith("1 ") || record.startsWith("u ")) {
      const entryPath = pathAfterFields(record, record.startsWith("1 ") ? 8 : 10);
      if (!entryPath || CONTROL_CHARACTER_PATTERN.test(entryPath)) return fail("malformed-output");
      statuses.set(entryPath, record.slice(2, 4));
      continue;
    }
    if (record.startsWith("2 ")) {
      if (index + 1 >= fields.length) return fail("malformed-output");
      const newPath = pathAfterFields(record, 9);
      const oldPath = decodeGitUtf8(fields[++index]);
      if (
        !newPath ||
        !oldPath ||
        CONTROL_CHARACTER_PATTERN.test(newPath) ||
        CONTROL_CHARACTER_PATTERN.test(oldPath)
      ) {
        return fail("malformed-output");
      }
      statuses.set(newPath, record.slice(2, 4));
      statuses.set(oldPath, record.slice(2, 4));
      continue;
    }
    return fail("malformed-output");
  }
  return statuses;
}

async function assertParentChain(root: string, absPath: string): Promise<void> {
  const relative = path.relative(root, absPath);
  if (!isSubpath(absPath, root) || relative === "") return fail("invalid-path");
  const components = relative.split(path.sep);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return fail("invalid-path");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return;
      return fail("invalid-path");
    }
  }
}

function modeBits(mode: number): number {
  return mode & 0o7777;
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function stableRegularFileState(
  config: GitCommitConfig,
  workspace: Workspace,
  absPath: string,
  relativePath: string,
  format: "sha1" | "sha256"
): Promise<GitWorktreeEntryState> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      before = await fsp.lstat(absPath);
    } catch {
      return { kind: "missing", mode: null, size: null, contentHash: null, linkTarget: null };
    }
    if (!before.isFile()) return fail("unsupported-path");
    const hashResult = await runGitChecked(config, workspace, ["hash-object", "--no-filters", "--", relativePath]);
    const contentHash = parseObjectId(oneLine(hashResult), format);
    let after: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      after = await fsp.lstat(absPath);
    } catch {
      continue;
    }
    if (
      after.isFile() &&
      after.size === before.size &&
      modeBits(after.mode) === modeBits(before.mode) &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs &&
      contentHash.length === (format === "sha1" ? 40 : 64)
    ) {
      return {
        kind: "file",
        mode: modeBits(after.mode),
        size: after.size,
        contentHash,
        linkTarget: null
      };
    }
  }
  return fail("execution");
}

async function inspectWorktreeState(
  config: GitCommitConfig,
  workspace: Workspace,
  relativePath: string,
  format: "sha1" | "sha256"
): Promise<{ readonly absPath: string; readonly state: GitWorktreeEntryState }> {
  const absPath = path.resolve(workspace.root, ...relativePath.split("/"));
  if (!isSubpath(absPath, workspace.root)) return fail("invalid-path");
  await assertParentChain(workspace.root, absPath);
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { absPath, state: { kind: "missing", mode: null, size: null, contentHash: null, linkTarget: null } };
    }
    return fail("invalid-path");
  }
  if (stat.isDirectory()) {
    return { absPath, state: { kind: "directory", mode: modeBits(stat.mode), size: null, contentHash: null, linkTarget: null } };
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await fsp.readlink(absPath, "utf8");
    } catch {
      return fail("invalid-path");
    }
    return {
      absPath,
      state: {
        kind: "symlink",
        mode: modeBits(stat.mode),
        size: Buffer.byteLength(target, "utf8"),
        contentHash: hashBytes(Buffer.from(target, "utf8")),
        linkTarget: target
      }
    };
  }
  if (stat.isFile()) {
    return { absPath, state: await stableRegularFileState(config, workspace, absPath, relativePath, format) };
  }
  return { absPath, state: { kind: "other", mode: modeBits(stat.mode), size: stat.size, contentHash: null, linkTarget: null } };
}

async function markerPath(config: GitCommitConfig, workspace: Workspace, marker: string): Promise<string> {
  const result = await runGitChecked(config, workspace, ["rev-parse", "--git-path", marker]);
  const raw = oneLine(result);
  if (!raw || CONTROL_CHARACTER_PATTERN.test(raw)) return fail("malformed-output");
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace.root, raw);
  return resolved;
}

async function assertNoHistoryOperation(config: GitCommitConfig, workspace: Workspace): Promise<void> {
  const paths = await Promise.all(GIT_HISTORY_MARKERS.map((marker) => markerPath(config, workspace, marker)));
  for (const marker of paths) {
    try {
      await fsp.lstat(marker);
      return fail("in-progress");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("in-progress");
    }
  }
}

async function repositoryRoot(config: GitCommitConfig, workspace: Workspace): Promise<{ readonly root: string; readonly gitDir: string }> {
  const inside = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--is-inside-work-tree"]));
  const bare = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--is-bare-repository"]));
  if (inside !== "true" || bare !== "false") return fail("repository");
  const topText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--show-toplevel"]));
  let top: string;
  try {
    top = await fsp.realpath(path.isAbsolute(topText) ? topText : path.resolve(workspace.root, topText));
  } catch {
    return fail("repository");
  }
  let root: string;
  try {
    root = await fsp.realpath(workspace.root);
  } catch {
    return fail("workspace");
  }
  if (root !== workspace.root || top !== root) return fail("repository");

  const gitDirText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--git-dir"]));
  const gitDir = path.isAbsolute(gitDirText) ? path.resolve(gitDirText) : path.resolve(root, gitDirText);
  return { root, gitDir };
}

async function isIgnored(
  config: GitCommitConfig,
  workspace: Workspace,
  relativePath: string
): Promise<boolean> {
  const result = await runGitAllowExit(config, workspace, ["check-ignore", "--quiet", "--no-index", "--", relativePath], 1);
  return result !== undefined;
}

function statusForPath(statuses: ReadonlyMap<string, string>, relativePath: string): string {
  return statuses.get(relativePath) ?? "";
}

/**
 * Validate repository, branch, index, and selected filesystem identity using
 * only sealed direct Git producers. This does not move refs or prepare the
 * index; TASK-003 owns selected-path commit mechanics.
 */
export async function preflightGitCommit(
  config: GitCommitConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitCommitPreflight> {
  const request = validateGitCommitRequest(rawInput);
  if (typeof workspace.id !== "string" || workspace.id !== request.workspace_id) return fail("workspace");
  if (!path.isAbsolute(workspace.root)) return fail("workspace");

  const repository = await repositoryRoot(config, workspace);
  const objectFormat = objectFormatFromResult(
    await runGitChecked(config, workspace, ["rev-parse", "--show-object-format=storage"])
  );
  if (request.expected_head.length !== (objectFormat === "sha1" ? 40 : 64)) return fail("invalid-input");

  let branchRef: string;
  try {
    branchRef = oneLine(await runGitChecked(config, workspace, ["symbolic-ref", "--quiet", "HEAD"]));
  } catch {
    return fail("detached");
  }
  if (!branchRef.startsWith("refs/heads/") || branchRef.length <= "refs/heads/".length) return fail("detached");
  const branch = branchRef.slice("refs/heads/".length);

  let head: string;
  try {
    head = parseObjectId(
      oneLine(await runGitChecked(config, workspace, ["rev-parse", "--verify", "HEAD^{commit}"])),
      objectFormat
    );
  } catch (error) {
    if (error instanceof GitCommitError && (error.reason === "execution" || error.reason === "malformed-output")) {
      return fail("unborn");
    }
    throw error;
  }
  if (head !== request.expected_head) return fail("head-mismatch");
  await assertNoHistoryOperation(config, workspace);

  const unmerged = await runGitChecked(config, workspace, ["ls-files", "--unmerged", "-z"]);
  if (nulFields(unmerged.copyStdoutBytes()).length > 0) return fail("unmerged");

  const selected = new Set(request.paths);
  for (const relativePath of request.paths) {
    if (guard.isBlockedRelativePath(relativePath)) return fail("blocked-path");
  }
  const indexOutput = await runGitChecked(config, workspace, ["ls-files", "--stage", "-z", "--", ...request.paths]);
  const indexEntries = parseIndexEntries(indexOutput.copyStdoutBytes(), objectFormat, selected);
  const statusOutput = await runGitChecked(config, workspace, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...request.paths]);
  const statuses = parseStatusPaths(statusOutput.copyStdoutBytes());

  const pathStates: GitCommitPathPreflight[] = [];
  for (const relativePath of request.paths) {
    const entries = indexEntries.get(relativePath) ?? [];
    if (entries.some((entry) => entry.mode === "160000")) return fail("gitlink");
    const inspected = await inspectWorktreeState(config, workspace, relativePath, objectFormat);
    if (inspected.state.kind === "directory") return fail("directory");
    if (inspected.state.kind === "other") return fail("unsupported-path");
    if (entries.length === 0 && await isIgnored(config, workspace, relativePath)) return fail("ignored");
    if (entries.length === 0 && inspected.state.kind === "missing") {
      return fail("missing-path");
    }
    pathStates.push({
      path: relativePath,
      absPath: inspected.absPath,
      status: statusForPath(statuses, relativePath),
      indexEntries: entries,
      worktree: inspected.state
    });
  }

  return {
    request,
    workspaceId: workspace.id,
    root: repository.root,
    gitDir: repository.gitDir,
    objectFormat,
    branch,
    head,
    selected: pathStates
  };
}

/** Stable deep comparison used for the post-lock load-bearing revalidation. */
export function sameGitCommitPreflight(left: GitCommitPreflight, right: GitCommitPreflight): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const gitMutationLocks = new Map<string, Promise<void>>();

function workspaceLockKey(workspace: Workspace): string {
  const normalized = path.normalize(workspace.root);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function acquireGitMutationLock(workspace: Workspace): Promise<() => void> {
  const key = workspaceLockKey(workspace);
  const previous = gitMutationLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  gitMutationLocks.set(key, current);
  await previous;
  return () => {
    releaseCurrent();
    if (gitMutationLocks.get(key) === current) gitMutationLocks.delete(key);
  };
}

/** Serialize all RepoConnect-owned Git mutations for one workspace root. */
export async function withGitMutationLock<T>(workspace: Workspace, task: () => Promise<T> | T): Promise<T> {
  const release = await acquireGitMutationLock(workspace);
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * Acquire the repository lock and selected-file locks in one deterministic
 * boundary, then repeat the complete preflight before invoking the caller's
 * mutation callback. The callback is the only place later tasks may move the
 * index/ref state.
 */
export async function withGitCommitLocks<T>(
  config: GitCommitConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  rawInput: unknown,
  task: (preflight: GitCommitPreflight) => Promise<T> | T
): Promise<T> {
  const first = await preflightGitCommit(config, guard, workspace, rawInput);
  return withGitMutationLock(workspace, async () => {
    return withFileWriteLocks(first.selected.map((entry) => entry.absPath), async () => {
      const locked = await preflightGitCommit(config, guard, workspace, rawInput);
      if (!sameGitCommitPreflight(first, locked)) return fail("preflight-changed");
      return task(locked);
    });
  });
}
