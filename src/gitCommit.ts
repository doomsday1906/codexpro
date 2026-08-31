import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
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
  | "preflight-changed"
  | "no-changes"
  | "postcondition"
  | "recovery-required";

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
  "preflight-changed": "Git commit preflight changed while waiting for its locks; retry.",
  "no-changes": "Git commit selection has no tree changes.",
  postcondition: "Git commit postcondition could not be proven; recovery is required.",
  "recovery-required": "Git commit failure left state that requires manual recovery."
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
  /** Raw hexadecimal index visibility flags from Git's debug producer. */
  readonly flags: string;
}

export type GitWorktreeEntryKind = "missing" | "file" | "symlink" | "directory" | "other";

export interface GitWorktreeEntryState {
  readonly kind: GitWorktreeEntryKind;
  readonly mode: number | null;
  readonly size: number | null;
  /** SHA-256 of the exact bytes exposed by the worktree (or symlink target). */
  readonly rawContentHash: string | null;
  /** Git object id for the same bytes without Git clean filters. */
  readonly contentHash: string | null;
  /** Git object id Git's ordinary clean/filter path would commit. */
  readonly gitBlobId: string | null;
  readonly linkTarget: string | null;
}

export interface GitCommitPathPreflight {
  readonly path: string;
  readonly absPath: string;
  readonly status: string;
  readonly indexEntries: readonly GitIndexEntry[];
  readonly headEntry: GitTreeEntry | undefined;
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

/** Internal-only derived index scope; callers never supply arbitrary Git env. */
interface GitIndexScope {
  readonly indexFile: string;
}

/** Fixed internal modes that disable a configured fsmonitor helper. */
type GitCheckedMode = "passive-observation" | "intent-preparation";

const PASSIVE_OBSERVATION_GIT_ARGS = ["-c", "core.fsmonitor=false"] as const;

async function runGitChecked(
  config: GitCommitConfig,
  workspace: Workspace,
  args: readonly string[],
  indexScope?: GitIndexScope,
  mode?: GitCheckedMode
): Promise<GitExecutionResult> {
  try {
    const checkedArgs = mode === undefined ? args : [...PASSIVE_OBSERVATION_GIT_ARGS, ...args];
    return await runGitMutation(
      config,
      workspace,
      checkedArgs,
      indexScope === undefined ? undefined : { indexFile: indexScope.indexFile }
    );
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

function parseDebugIndexEntries(
  bytes: Buffer,
  format: "sha1" | "sha256",
  selected?: ReadonlySet<string>
): Map<string, GitIndexEntry[]> {
  const text = decodeGitUtf8(bytes);
  if (text.length === 0) return new Map();
  const entries = new Map<string, GitIndexEntry[]>();
  const headerPattern = /^(\d{6}) ([0-9a-f]+) ([0-3])\t(.+)$/iu;
  const debugFlagsPattern = /(?:^|\n)[^\n]*\bflags:\s*([0-9a-f]+)\s*(?:\n|$)/giu;
  let cursor = 0;
  while (cursor < text.length) {
    const separator = text.indexOf("\u0000", cursor);
    if (separator <= cursor) return fail("malformed-output");
    const header = text.slice(cursor, separator);
    const match = headerPattern.exec(header);
    if (
      !match ||
      !objectIdPattern(format).test(match[2]) ||
      CONTROL_CHARACTER_PATTERN.test(match[4]) ||
      (selected !== undefined && !selected.has(match[4]))
    ) {
      return fail("malformed-output");
    }

    const debugStart = separator + 1;
    const nextHeader = text.slice(debugStart).search(/\n(?=\d{6} [0-9a-f]+ [0-3]\t)/iu);
    const debugEnd = nextHeader < 0 ? text.length : debugStart + nextHeader + 1;
    const debug = text.slice(debugStart, debugEnd);
    const flagMatches = [...debug.matchAll(debugFlagsPattern)];
    if (flagMatches.length !== 1) return fail("malformed-output");
    const flags = flagMatches[0][1].toLowerCase();
    try {
      BigInt(`0x${flags}`);
    } catch {
      return fail("malformed-output");
    }

    const entry: GitIndexEntry = {
      mode: match[1],
      objectId: match[2].toLowerCase(),
      stage: Number(match[3]),
      path: match[4],
      flags
    };
    const prior = entries.get(entry.path) ?? [];
    prior.push(entry);
    entries.set(entry.path, prior);
    if (nextHeader < 0) break;
    cursor = debugEnd;
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

function nulPathList(bytes: Buffer): string[] {
  const paths: string[] = [];
  for (const field of nulFields(bytes)) {
    const relativePath = decodeGitUtf8(field);
    if (!relativePath || CONTROL_CHARACTER_PATTERN.test(relativePath)) return fail("malformed-output");
    paths.push(relativePath);
  }
  return paths;
}

interface GitRepositorySnapshot {
  readonly index: Map<string, GitIndexEntry[]>;
  readonly statuses: Map<string, string>;
  readonly worktree: Map<string, GitWorktreeEntryState>;
  /** Complete local ref and repository-local config snapshots, base64 encoded. */
  readonly localRefs: string;
  readonly localConfig: string;
}

interface GitBranchState {
  readonly ref: string;
  readonly branch: string;
  readonly head: string;
}

interface GitIntentReceipt {
  readonly path: string;
  readonly indexEntries: readonly GitIndexEntry[];
  readonly status: string;
  readonly intentFlags: string;
}

interface GitRawDiffEntry {
  readonly path: string;
  readonly status: string;
  readonly oldMode: string;
  readonly newMode: string;
  readonly newBlobId: string | null;
}

interface GitTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly objectId: string;
  readonly path: string;
}

function sameIndexEntries(left: readonly GitIndexEntry[], right: readonly GitIndexEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Git's split-index writer may move an unchanged entry into or out of the
// shared-index base while rewriting the index for an intent-to-add entry. The
// producer exposes that storage marker as 0x08000000. It is not one of the
// visibility bits (assume-unchanged/skip-worktree) that controls whether a
// hidden tracked change can be observed, so preserve comparisons ignore only
// this representation detail and retain every other raw flag.
const SPLIT_INDEX_BASE_FLAG = 0x08000000n;

function preservedIndexFlags(flags: string): string {
  try {
    return (BigInt(`0x${flags}`) & ~SPLIT_INDEX_BASE_FLAG).toString(16);
  } catch {
    return flags;
  }
}

function samePreservedIndexEntries(left: readonly GitIndexEntry[], right: readonly GitIndexEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.mode === other.mode &&
        entry.objectId === other.objectId &&
        entry.stage === other.stage &&
        entry.path === other.path &&
        preservedIndexFlags(entry.flags) === preservedIndexFlags(other.flags)
      );
    }
  );
}

function sameWorktreeState(left: GitWorktreeEntryState | undefined, right: GitWorktreeEntryState | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameRawWorktreeState(left: GitWorktreeEntryState | undefined, right: GitWorktreeEntryState | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify({
    kind: left.kind,
    mode: left.mode,
    size: left.size,
    rawContentHash: left.rawContentHash,
    linkTarget: left.linkTarget
  }) === JSON.stringify({
    kind: right.kind,
    mode: right.mode,
    size: right.size,
    rawContentHash: right.rawContentHash,
    linkTarget: right.linkTarget
  });
}

function mapKeys(...maps: ReadonlyMap<string, unknown>[]): Set<string> {
  const keys = new Set<string>();
  for (const map of maps) {
    for (const key of map.keys()) keys.add(key);
  }
  return keys;
}

function assertUnselectedSnapshotPreserved(
  before: GitRepositorySnapshot,
  after: GitRepositorySnapshot,
  selected: ReadonlySet<string>
): boolean {
  for (const relativePath of mapKeys(before.index, after.index, before.statuses, after.statuses, before.worktree, after.worktree)) {
    if (selected.has(relativePath)) continue;
    if (!samePreservedIndexEntries(before.index.get(relativePath) ?? [], after.index.get(relativePath) ?? [])) return false;
    if ((before.statuses.get(relativePath) ?? "") !== (after.statuses.get(relativePath) ?? "")) return false;
    if (!sameWorktreeState(before.worktree.get(relativePath), after.worktree.get(relativePath))) return false;
  }
  return true;
}

function sameSnapshotMetadata(left: GitRepositorySnapshot, right: GitRepositorySnapshot): boolean {
  return left.localRefs === right.localRefs && left.localConfig === right.localConfig;
}

function assertPreparedSnapshotPreserved(
  before: GitRepositorySnapshot,
  after: GitRepositorySnapshot,
  preflight: GitCommitPreflight,
  receipts: readonly GitIntentReceipt[]
): boolean {
  if (!sameSnapshotMetadata(before, after)) return false;
  const owned = new Map(receipts.map((receipt) => [receipt.path, receipt]));
  if (!assertUnselectedSnapshotPreserved(before, after, new Set(owned.keys()))) return false;
  for (const selected of preflight.selected) {
    const receipt = owned.get(selected.path);
    const afterEntries = after.index.get(selected.path) ?? [];
    const afterStatus = after.statuses.get(selected.path) ?? "";
    if (receipt === undefined) {
      if (
        !sameIndexEntries(selected.indexEntries, afterEntries) ||
        selected.status !== afterStatus ||
        !sameRawWorktreeState(selected.worktree, after.worktree.get(selected.path))
      ) {
        return false;
      }
      continue;
    }
    if (
      !sameIndexEntries(receipt.indexEntries, afterEntries) ||
      receipt.status !== afterStatus ||
      !sameRawWorktreeState(selected.worktree, after.worktree.get(selected.path))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Before a ref advance, an ordinary failure under the supported concurrency
 * model (RepoConnect-owned writers, ordinary Git-lock-cooperative writers,
 * and synchronous cooperative hooks) may leave selected-path drift
 * attributable to the caller/helper.
 * Unselected physical state and repository metadata must still be unchanged
 * by RepoConnect mechanics while ownership remains provable; otherwise the
 * failure is recovery truth rather than an ordinary execution/preflight
 * result. This check does not claim atomic restoration against
 * NON_COOPERATIVE_LOCAL_INTERFERENCE.
 */
async function assertPreAdvanceStatePreserved(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  baselineRemoteRefs: string
): Promise<void> {
  try {
    const current = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
    if (
      !sameSnapshotMetadata(baseline, current) ||
      !assertUnselectedSnapshotPreserved(baseline, current, new Set(preflight.request.paths)) ||
      (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs
    ) {
      return fail("recovery-required");
    }
  } catch (error) {
    if (error instanceof GitCommitError && error.reason === "recovery-required") throw error;
    return fail("recovery-required");
  }
}

async function captureRepositorySnapshot(
  config: GitCommitConfig,
  workspace: Workspace,
  format: "sha1" | "sha256",
  indexScope?: GitIndexScope
): Promise<GitRepositorySnapshot> {
  // Keep the census readers ordered. Git's split-index implementation can
  // materialize/normalize index metadata while a reader is starting; sibling
  // readers would otherwise race and make a stable raw index appear to drift.
  const indexResult = await runGitChecked(
    config,
    workspace,
    ["ls-files", "--debug", "--stage", "-z"],
    indexScope,
    "passive-observation"
  );
  const statusResult = await runGitChecked(
    config,
    workspace,
    ["status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=all"],
    indexScope,
    "passive-observation"
  );
  const ignoredResult = await runGitChecked(
    config,
    workspace,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    indexScope,
    "passive-observation"
  );
  const refsResult = await runGitChecked(config, workspace, ["for-each-ref", "--format=%(refname)=%(objectname)"], indexScope);
  const configResult = await runGitChecked(config, workspace, ["config", "--local", "--null", "--list"], indexScope);
  const index = parseDebugIndexEntries(indexResult.copyStdoutBytes(), format);
  const statuses = parseStatusPaths(statusResult.copyStdoutBytes());
  const ignoredFiles = nulPathList(ignoredResult.copyStdoutBytes());
  const allPaths = mapKeys(index, statuses, new Map(ignoredFiles.map((relativePath) => [relativePath, true])));
  const worktree = new Map<string, GitWorktreeEntryState>();
  for (const relativePath of allPaths) {
    const inspected = await inspectWorktreeState(config, workspace, relativePath, format, false);
    worktree.set(relativePath, inspected.state);
  }
  return {
    index,
    statuses,
    worktree,
    localRefs: refsResult.copyStdoutBytes().toString("base64"),
    localConfig: configResult.copyStdoutBytes().toString("base64")
  };
}

function parseRawDiffEntries(
  bytes: Buffer,
  format: "sha1" | "sha256",
  selected: ReadonlySet<string>
): Map<string, GitRawDiffEntry> {
  const fields = nulFields(bytes);
  if (fields.length % 2 !== 0) return fail("malformed-output");
  const entries = new Map<string, GitRawDiffEntry>();
  for (let index = 0; index < fields.length; index += 2) {
    const header = decodeGitUtf8(fields[index]);
    const relativePath = decodeGitUtf8(fields[index + 1]);
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/iu.exec(header);
    if (!match || !selected.has(relativePath) || CONTROL_CHARACTER_PATTERN.test(relativePath)) {
      return fail("malformed-output");
    }
    const [oldMode, newMode, oldBlobId, newBlobId, status] = match.slice(1);
    const fullLength = format === "sha1" ? 40 : 64;
    if (
      !/^[0-9a-f]+$/iu.test(oldBlobId) ||
      !/^[0-9a-f]+$/iu.test(newBlobId) ||
      oldBlobId.length > fullLength ||
      newBlobId.length > fullLength
    ) {
      return fail("malformed-output");
    }
    if (entries.has(relativePath)) return fail("malformed-output");
    entries.set(relativePath, {
      path: relativePath,
      status,
      oldMode,
      newMode,
      newBlobId:
        newMode === "000000" || /^0+$/u.test(newBlobId) || newBlobId.length !== fullLength
          ? null
          : newBlobId.toLowerCase()
    });
  }
  return entries;
}

function parseChangedPathRecords(bytes: Buffer): Map<string, string> {
  const fields = nulFields(bytes);
  if (fields.length % 2 !== 0) return fail("malformed-output");
  const entries = new Map<string, string>();
  for (let index = 0; index < fields.length; index += 2) {
    const status = decodeGitUtf8(fields[index]);
    const relativePath = decodeGitUtf8(fields[index + 1]);
    if (!/^[A-Z]$/u.test(status) || !relativePath || CONTROL_CHARACTER_PATTERN.test(relativePath)) {
      return fail("malformed-output");
    }
    if (entries.has(relativePath)) return fail("malformed-output");
    entries.set(relativePath, status);
  }
  return entries;
}

function parseTreeEntries(
  bytes: Buffer,
  format: "sha1" | "sha256",
  selected: ReadonlySet<string>
): Map<string, GitTreeEntry> {
  const entries = new Map<string, GitTreeEntry>();
  for (const field of nulFields(bytes)) {
    const tab = field.indexOf(0x09);
    if (tab <= 0) return fail("malformed-output");
    const header = decodeGitUtf8(field.subarray(0, tab));
    const relativePath = decodeGitUtf8(field.subarray(tab + 1));
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)$/iu.exec(header);
    if (!match || !selected.has(relativePath) || CONTROL_CHARACTER_PATTERN.test(relativePath)) {
      return fail("malformed-output");
    }
    if (!objectIdPattern(format).test(match[3])) return fail("malformed-output");
    if (entries.has(relativePath)) return fail("malformed-output");
    entries.set(relativePath, {
      mode: match[1],
      type: match[2] as GitTreeEntry["type"],
      objectId: match[3].toLowerCase(),
      path: relativePath
    });
  }
  return entries;
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

async function hashFileBytes(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function gitBlobIdForBytes(value: Uint8Array, format: "sha1" | "sha256"): string {
  const bytes = Buffer.from(value);
  return createHash(format)
    .update(Buffer.from(`blob ${bytes.length}\u0000`, "utf8"))
    .update(bytes)
    .digest("hex");
}

async function stableRegularFileState(
  config: GitCommitConfig,
  workspace: Workspace,
  absPath: string,
  relativePath: string,
  format: "sha1" | "sha256",
  includeGitIdentity: boolean
): Promise<GitWorktreeEntryState> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let before: Awaited<ReturnType<typeof fsp.lstat>>;
    try {
      before = await fsp.lstat(absPath);
    } catch {
      return {
        kind: "missing",
        mode: null,
        size: null,
        rawContentHash: null,
        contentHash: null,
        gitBlobId: null,
        linkTarget: null
      };
    }
    if (!before.isFile()) return fail("unsupported-path");
    let rawContentHash: string;
    let contentHash: string | null = null;
    let gitBlobId: string | null = null;
    try {
      if (includeGitIdentity) {
        const [rawContentHashResult, hashResult, cleanResult] = await Promise.all([
          hashFileBytes(absPath),
          runGitChecked(config, workspace, ["hash-object", "--no-filters", "--", relativePath]),
          runGitChecked(config, workspace, ["hash-object", `--path=${relativePath}`, "--", relativePath])
        ]);
        rawContentHash = rawContentHashResult;
        contentHash = parseObjectId(oneLine(hashResult), format);
        gitBlobId = parseObjectId(oneLine(cleanResult), format);
      } else {
        rawContentHash = await hashFileBytes(absPath);
      }
    } catch (error) {
      if (error instanceof GitCommitError) throw error;
      return fail("execution");
    }
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
      (contentHash === null || contentHash.length === (format === "sha1" ? 40 : 64))
    ) {
      return {
        kind: "file",
        mode: modeBits(after.mode),
        size: after.size,
        rawContentHash,
        contentHash,
        gitBlobId,
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
  format: "sha1" | "sha256",
  includeGitIdentity = false
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
      return {
        absPath,
        state: {
          kind: "missing",
          mode: null,
          size: null,
          rawContentHash: null,
          contentHash: null,
          gitBlobId: null,
          linkTarget: null
        }
      };
    }
    return fail("invalid-path");
  }
  if (stat.isDirectory()) {
    return {
      absPath,
      state: {
        kind: "directory",
        mode: modeBits(stat.mode),
        size: null,
        rawContentHash: null,
        contentHash: null,
        gitBlobId: null,
        linkTarget: null
      }
    };
  }
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = await fsp.readlink(absPath, "utf8");
    } catch {
      return fail("invalid-path");
    }
    const linkBytes = Buffer.from(target, "utf8");
    return {
      absPath,
      state: {
        kind: "symlink",
        mode: modeBits(stat.mode),
        size: linkBytes.length,
        rawContentHash: hashBytes(linkBytes),
        contentHash: includeGitIdentity ? gitBlobIdForBytes(linkBytes, format) : null,
        gitBlobId: includeGitIdentity ? gitBlobIdForBytes(linkBytes, format) : null,
        linkTarget: target
      }
    };
  }
  if (stat.isFile()) {
    return {
      absPath,
      state: await stableRegularFileState(config, workspace, absPath, relativePath, format, includeGitIdentity)
    };
  }
  return {
    absPath,
    state: {
      kind: "other",
      mode: modeBits(stat.mode),
      size: stat.size,
      rawContentHash: null,
      contentHash: null,
      gitBlobId: null,
      linkTarget: null
    }
  };
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

  const unmerged = await runGitChecked(
    config,
    workspace,
    ["ls-files", "--unmerged", "-z"],
    undefined,
    "passive-observation"
  );
  if (nulFields(unmerged.copyStdoutBytes()).length > 0) return fail("unmerged");

  const selected = new Set(request.paths);
  for (const relativePath of request.paths) {
    if (guard.isBlockedRelativePath(relativePath)) return fail("blocked-path");
  }
  const indexOutput = await runGitChecked(
    config,
    workspace,
    ["ls-files", "--debug", "--stage", "-z", "--", ...request.paths],
    undefined,
    "passive-observation"
  );
  const indexEntries = parseDebugIndexEntries(indexOutput.copyStdoutBytes(), objectFormat, selected);
  const statusOutput = await runGitChecked(
    config,
    workspace,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ...request.paths],
    undefined,
    "passive-observation"
  );
  const statuses = parseStatusPaths(statusOutput.copyStdoutBytes());
  const headEntries = await treeEntries(config, workspace, head, request.paths, objectFormat);

  const pathStates: GitCommitPathPreflight[] = [];
  for (const relativePath of request.paths) {
    const entries = indexEntries.get(relativePath) ?? [];
    const headEntry = headEntries.get(relativePath);
    if (headEntry?.mode === "160000" || headEntry?.type === "commit") return fail("gitlink");
    if (entries.some((entry) => entry.mode === "160000")) return fail("gitlink");
    const inspected = await inspectWorktreeState(config, workspace, relativePath, objectFormat);
    if (inspected.state.kind === "directory") return fail("directory");
    if (inspected.state.kind === "other") return fail("unsupported-path");
    if (entries.length === 0 && headEntry === undefined && await isIgnored(config, workspace, relativePath)) return fail("ignored");
    if (entries.length === 0 && inspected.state.kind === "missing" && headEntry === undefined) {
      return fail("missing-path");
    }
    pathStates.push({
      path: relativePath,
      absPath: inspected.absPath,
      status: statusForPath(statuses, relativePath),
      indexEntries: entries,
      headEntry,
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
  task: (preflight: GitCommitPreflight) => Promise<T> | T,
  onInitialPreflight?: () => void
): Promise<T> {
  const first = await preflightGitCommit(config, guard, workspace, rawInput);
  onInitialPreflight?.();
  return withGitMutationLock(workspace, async () => {
    return withFileWriteLocks(first.selected.map((entry) => entry.absPath), async () => {
      const locked = await preflightGitCommit(config, guard, workspace, rawInput);
      if (!sameGitCommitPreflight(first, locked)) return fail("preflight-changed");
      return task(locked);
    });
  });
}

export interface GitCommitResult {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly branch: string;
  readonly old_head: string;
  readonly new_head: string;
  readonly requested_path_count: number;
  readonly committed_path_count: number;
  readonly committed_paths: readonly string[];
}

function sameRepositorySnapshot(left: GitRepositorySnapshot, right: GitRepositorySnapshot): boolean {
  if (!sameSnapshotMetadata(left, right)) return false;
  for (const relativePath of mapKeys(left.index, right.index, left.statuses, right.statuses, left.worktree, right.worktree)) {
    if (!samePreservedIndexEntries(left.index.get(relativePath) ?? [], right.index.get(relativePath) ?? [])) return false;
    if ((left.statuses.get(relativePath) ?? "") !== (right.statuses.get(relativePath) ?? "")) return false;
    if (!sameWorktreeState(left.worktree.get(relativePath), right.worktree.get(relativePath))) return false;
  }
  return true;
}

function parseRefSnapshot(encoded: string): Map<string, string> | undefined {
  let text: string;
  try {
    text = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const refs = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0 || refs.has(line.slice(0, separator))) return undefined;
    refs.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return refs;
}

function localRefsChangedOnlyForBranch(
  before: GitRepositorySnapshot,
  after: GitRepositorySnapshot,
  branchRef: string,
  oldHead: string,
  newHead: string
): boolean {
  const beforeRefs = parseRefSnapshot(before.localRefs);
  const afterRefs = parseRefSnapshot(after.localRefs);
  if (beforeRefs === undefined || afterRefs === undefined) return false;
  const keys = mapKeys(beforeRefs, afterRefs);
  for (const ref of keys) {
    if (ref === branchRef) {
      if (beforeRefs.get(ref) !== oldHead || afterRefs.get(ref) !== newHead) return false;
    } else if (beforeRefs.get(ref) !== afterRefs.get(ref)) {
      return false;
    }
  }
  return beforeRefs.get(branchRef) === oldHead && afterRefs.get(branchRef) === newHead;
}

async function currentBranchState(
  config: GitCommitConfig,
  workspace: Workspace,
  format: "sha1" | "sha256"
): Promise<GitBranchState | undefined> {
  try {
    const ref = oneLine(await runGitChecked(config, workspace, ["symbolic-ref", "--quiet", "HEAD"]));
    if (!ref.startsWith("refs/heads/") || ref.length <= "refs/heads/".length) return undefined;
    const head = parseObjectId(
      oneLine(await runGitChecked(config, workspace, ["rev-parse", "--verify", "HEAD^{commit}"])),
      format
    );
    return { ref, branch: ref.slice("refs/heads/".length), head };
  } catch {
    return undefined;
  }
}

async function remoteRefsSnapshot(config: GitCommitConfig, workspace: Workspace): Promise<string> {
  const result = await runGitChecked(config, workspace, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]);
  const value = decodeGitUtf8(result.copyStdoutBytes());
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return fail("malformed-output");
  return value;
}

async function selectedWorktreeStates(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight
): Promise<Map<string, GitWorktreeEntryState>> {
  const states = new Map<string, GitWorktreeEntryState>();
  for (const selected of preflight.selected) {
    const inspected = await inspectWorktreeState(config, workspace, selected.path, preflight.objectFormat);
    states.set(selected.path, inspected.state);
  }
  return states;
}

/** Resolve Git clean/filter identities only after the passive baseline exists. */
async function selectedGitIdentityStates(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight
): Promise<Map<string, GitWorktreeEntryState>> {
  const states = new Map<string, GitWorktreeEntryState>();
  for (const selected of preflight.selected) {
    const inspected = await inspectWorktreeState(config, workspace, selected.path, preflight.objectFormat, true);
    states.set(selected.path, inspected.state);
  }
  return states;
}

function selectedWorktreeStatesMatch(
  preflight: GitCommitPreflight,
  states: ReadonlyMap<string, GitWorktreeEntryState>
): boolean {
  return preflight.selected.every((selected) => sameWorktreeState(selected.worktree, states.get(selected.path)));
}

function selectedRawWorktreeStatesMatch(
  preflight: GitCommitPreflight,
  states: ReadonlyMap<string, GitWorktreeEntryState>
): boolean {
  return preflight.selected.every((selected) => sameRawWorktreeState(selected.worktree, states.get(selected.path)));
}

function selectedSnapshotMatchesPreflight(
  preflight: GitCommitPreflight,
  snapshot: GitRepositorySnapshot,
  states: ReadonlyMap<string, GitWorktreeEntryState>
): boolean {
  return preflight.selected.every(
    (selected) =>
      sameIndexEntries(selected.indexEntries, snapshot.index.get(selected.path) ?? []) &&
      selected.status === (snapshot.statuses.get(selected.path) ?? "") &&
      sameWorktreeState(selected.worktree, states.get(selected.path))
  );
}

function worktreeDiffersFromHead(
  selected: GitCommitPathPreflight,
  state: GitWorktreeEntryState
): boolean {
  const head = selected.headEntry;
  if (head === undefined) return state.kind !== "missing";
  if (state.kind === "missing") return true;
  if (state.kind !== "file" && state.kind !== "symlink") return true;
  const mode = state.kind === "symlink" ? "120000" : (state.mode !== null && (state.mode & 0o111) !== 0 ? "100755" : "100644");
  return head.type !== "blob" || head.mode !== mode || state.gitBlobId === null || head.objectId !== state.gitBlobId;
}

function isIntentToAddFlags(flags: string): boolean {
  try {
    return (BigInt(`0x${flags}`) & 0x20000000n) !== 0n;
  } catch {
    return false;
  }
}

function collectIntentReceipts(
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  current: GitRepositorySnapshot
): GitIntentReceipt[] | undefined {
  const receipts: GitIntentReceipt[] = [];
  const emptyBlobId = gitBlobIdForBytes(Buffer.alloc(0), preflight.objectFormat);
  for (const selected of preflight.selected) {
    if (selected.indexEntries.length !== 0) continue;
    const currentEntries = current.index.get(selected.path) ?? [];
    const currentStatus = current.statuses.get(selected.path) ?? "";
    if (currentEntries.length === 0) {
      if (
        currentStatus !== (baseline.statuses.get(selected.path) ?? "") ||
        !sameWorktreeState(selected.worktree, current.worktree.get(selected.path))
      ) {
        return undefined;
      }
      continue;
    }
    if (
      currentEntries.length !== 1 ||
      currentEntries[0].stage !== 0 ||
      currentEntries[0].objectId !== emptyBlobId ||
      currentStatus !== ".A" ||
      !isIntentToAddFlags(currentEntries[0].flags) ||
      !sameWorktreeState(selected.worktree, current.worktree.get(selected.path))
    ) {
      return undefined;
    }
    receipts.push({
      path: selected.path,
      indexEntries: currentEntries,
      status: currentStatus,
      intentFlags: currentEntries[0].flags
    });
  }
  return receipts;
}

interface GitFileIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

interface GitIndexSnapshot {
  readonly identity: GitFileIdentity;
  readonly contentHash: string;
  readonly mode: number;
}

interface GitIndexBaseline extends GitIndexSnapshot {
  /** Exact main-index bytes captured before selected intent preparation. */
  readonly bytes: Buffer;
  readonly path: string;
}

interface OwnedIndexCandidate {
  readonly path: string;
  readonly identity: GitFileIdentity;
}

function fileIdentity(stat: import("node:fs").Stats): GitFileIdentity {
  return { device: stat.dev, inode: stat.ino, mode: modeBits(stat.mode) };
}

function sameFileIdentity(left: GitFileIdentity, right: GitFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

async function readIndexSnapshot(indexPath: string): Promise<GitIndexSnapshot> {
  try {
    const stat = await fsp.lstat(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return fail("recovery-required");
    return {
      identity: fileIdentity(stat),
      contentHash: await hashFileBytes(indexPath),
      mode: modeBits(stat.mode)
    };
  } catch (error) {
    if (error instanceof GitCommitError) throw error;
    return fail("recovery-required");
  }
}

async function readIndexBaseline(indexPath: string): Promise<GitIndexBaseline> {
  try {
    const bytes = await fsp.readFile(indexPath);
    const snapshot = await readIndexSnapshot(indexPath);
    if (hashBytes(bytes) !== snapshot.contentHash) return fail("recovery-required");
    return { ...snapshot, bytes, path: indexPath };
  } catch (error) {
    if (error instanceof GitCommitError) throw error;
    return fail("recovery-required");
  }
}

async function syncFile(filePath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    // fsync does not require write access. Opening read-only also permits
    // restoring an index whose call-entry mode intentionally denies writes;
    // the candidate is written while owned and writable, then chmoded to the
    // sealed baseline mode before rename.
    handle = await fsp.open(filePath, "r");
    await handle.sync();
  } catch {
    return fail("recovery-required");
  } finally {
    try {
      await handle?.close();
    } catch {
      // A failed close is surfaced as recovery truth by the caller's next
      // identity check; never broaden cleanup to another path.
    }
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(directoryPath, "r");
    await handle.sync();
  } catch {
    return fail("recovery-required");
  } finally {
    try {
      await handle?.close();
    } catch {
      // Keep the bounded recovery verdict; do not attempt alternate cleanup.
    }
  }
}

async function actualGitIndexPath(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight
): Promise<string> {
  try {
    const raw = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    if (!raw || !path.isAbsolute(raw) || CONTROL_CHARACTER_PATTERN.test(raw) || path.basename(raw) !== "index") {
      return fail("recovery-required");
    }
    const indexPath = path.normalize(raw);
    const gitDir = await fsp.realpath(preflight.gitDir);
    const parent = await fsp.realpath(path.dirname(indexPath));
    if (!isSubpath(parent, gitDir)) return fail("recovery-required");
    return indexPath;
  } catch (error) {
    if (error instanceof GitCommitError) throw error;
    return fail("recovery-required");
  }
}

interface OwnedIndexLock {
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof fsp.open>>;
  readonly identity: GitFileIdentity;
}

async function acquireActualIndexLock(indexPath: string): Promise<OwnedIndexLock> {
  const lockPath = `${indexPath}.lock`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    // wx maps to O_CREAT|O_EXCL. A pre-existing lock is never adopted or
    // removed, regardless of its apparent contents.
    handle = await fsp.open(lockPath, "wx", 0o600);
    const stat = await handle.stat();
    const onDisk = await fsp.lstat(lockPath);
    const identity = fileIdentity(stat);
    if (!sameFileIdentity(identity, fileIdentity(onDisk))) return fail("recovery-required");
    return { path: lockPath, handle, identity };
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // The lock identity remains unknown; report recovery rather than
      // guessing at ownership.
    }
    if (error instanceof GitCommitError) throw error;
    return fail("recovery-required");
  }
}

async function removeOwnedIndexLock(lock: OwnedIndexLock): Promise<void> {
  let sameIdentity = false;
  try {
    const stat = await fsp.lstat(lock.path);
    sameIdentity = sameFileIdentity(lock.identity, fileIdentity(stat));
  } catch {
    // A missing or unreadable lock is not proof that this invocation still
    // owns the path. Close our descriptor, then surface recovery truth.
  }
  try {
    await lock.handle.close();
  } catch {
    return fail("recovery-required");
  }
  if (!sameIdentity) return fail("recovery-required");
  try {
    await fsp.unlink(lock.path);
  } catch {
    return fail("recovery-required");
  }
}

async function createOwnedIndexCandidate(indexPath: string, source: GitIndexSnapshot): Promise<OwnedIndexCandidate> {
  const directory = path.dirname(indexPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      directory,
      `.codexpro-index-${process.pid}-${randomBytes(12).toString("hex")}.tmp`
    );
    let createdCandidate: OwnedIndexCandidate | undefined;
    try {
      const handle = await fsp.open(candidate, "wx", 0o600);
      const createdStat = await handle.stat();
      createdCandidate = { path: candidate, identity: fileIdentity(createdStat) };
      await handle.close();
      await fsp.copyFile(indexPath, candidate);
      await fsp.chmod(candidate, 0o600);
      await syncFile(candidate);
      const copied = await readIndexSnapshot(candidate);
      if (copied.contentHash !== source.contentHash) return fail("recovery-required");
      return { path: candidate, identity: copied.identity };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (createdCandidate !== undefined) {
        // The candidate path was created O_EXCL by this invocation. Verify
        // its inode before retiring it; a replacement or disappearance is
        // recovery truth, never permission to unlink by pathname alone.
        await removeOwnedCandidate(createdCandidate);
      }
      if (error instanceof GitCommitError) throw error;
      return fail("recovery-required");
    }
  }
  return fail("recovery-required");
}

async function removeOwnedCandidate(candidate: OwnedIndexCandidate): Promise<void> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(candidate.path);
  } catch (error) {
    // A deleted candidate is not proof that our owned artifact was safely
    // retired. Leave recovery to the caller instead of guessing.
    return fail("recovery-required");
  }
  if (!sameFileIdentity(candidate.identity, fileIdentity(stat))) return fail("recovery-required");
  try {
    await fsp.unlink(candidate.path);
  } catch {
    return fail("recovery-required");
  }
}

async function assertPreparedIntentState(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  baselineRemoteRefs: string,
  current: GitRepositorySnapshot,
  receipts: readonly GitIntentReceipt[]
): Promise<void> {
  const branch = await currentBranchState(config, workspace, preflight.objectFormat);
  const states = await selectedWorktreeStates(config, workspace, preflight);
  if (
    branch === undefined ||
    branch.ref !== `refs/heads/${preflight.branch}` ||
    branch.head !== preflight.head ||
    (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs ||
    !assertPreparedSnapshotPreserved(baseline, current, preflight, receipts) ||
    !selectedWorktreeStatesMatch(preflight, states)
  ) {
    return fail("recovery-required");
  }
}

async function restoreOwnedIntentEntries(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  baselineRemoteRefs: string,
  baselineIndex: GitIndexBaseline,
  receipts: readonly GitIntentReceipt[]
): Promise<void> {
  if (receipts.length === 0) return;

  let lock: OwnedIndexLock | undefined;
  let candidate: OwnedIndexCandidate | undefined;
  let candidateLockPath: string | undefined;
  let renamed = false;
  try {
    // This passive check closes the common writer-before-lock window. The
    // actual lock and receipt revalidation below remain authoritative.
    const beforeLock = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
    await assertPreparedIntentState(config, workspace, preflight, baseline, baselineRemoteRefs, beforeLock, receipts);

    const indexPath = await actualGitIndexPath(config, workspace, preflight);
    if (indexPath !== baselineIndex.path) return fail("recovery-required");
    const source = await readIndexSnapshot(indexPath);
    lock = await acquireActualIndexLock(indexPath);
    const lockedSource = await readIndexSnapshot(indexPath);
    if (
      !sameFileIdentity(source.identity, lockedSource.identity) ||
      source.contentHash !== lockedSource.contentHash
    ) {
      return fail("recovery-required");
    }

    candidate = await createOwnedIndexCandidate(indexPath, source);
    candidateLockPath = `${candidate.path}.lock`;
    await syncDirectory(path.dirname(indexPath));
    try {
      await fsp.lstat(candidateLockPath);
      return fail("recovery-required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("recovery-required");
    }

    const candidateScope: GitIndexScope = { indexFile: candidate.path };
    const candidateBefore = await captureRepositorySnapshot(config, workspace, preflight.objectFormat, candidateScope);
    if (!sameRepositorySnapshot(beforeLock, candidateBefore)) return fail("recovery-required");
    await assertPreparedIntentState(config, workspace, preflight, baseline, baselineRemoteRefs, candidateBefore, receipts);

    let updateError: unknown;
    try {
      await runGitMutation(
        config,
        workspace,
        ["update-index", "--force-remove", "--", ...receipts.map((receipt) => receipt.path)],
        { indexFile: candidate.path }
      );
    } catch (error) {
      updateError = error;
    }

    if (updateError !== undefined) {
      // A normally exiting Git child may leave its own candidate lock on an
      // ordinary command failure; a signal/timeout is ambiguous and leaves
      // the exact artifact for manual recovery.
      if (updateError instanceof GitExecutionError && updateError.failure !== "exit") {
        return fail("recovery-required");
      }
      return fail("recovery-required");
    }
    // Git normally replaces the candidate with its own candidate.lock. Track
    // the resulting inode before any later validation so cleanup can still
    // prove ownership of the exact path without deleting a replacement.
    candidate = { ...candidate, identity: (await readIndexSnapshot(candidate.path)).identity };
    try {
      await fsp.lstat(candidateLockPath);
      return fail("recovery-required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("recovery-required");
    }

    const candidateAfter = await captureRepositorySnapshot(config, workspace, preflight.objectFormat, candidateScope);
    const candidateStates = await selectedWorktreeStates(config, workspace, preflight);
    if (
      !sameRepositorySnapshot(baseline, candidateAfter) ||
      !selectedWorktreeStatesMatch(preflight, candidateStates) ||
      (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs
    ) {
      return fail("recovery-required");
    }

    // A split-index rewrite may move unchanged entries between the main and
    // shared index, changing only Git's storage marker. Once the candidate
    // has passed the narrow receipt/semantic proof, restore the exact
    // call-entry index bytes into that owned candidate so the live main index
    // retains its original representation and permissions.
    const candidateBeforeExact = await readIndexSnapshot(candidate.path);
    if (!sameFileIdentity(candidate.identity, candidateBeforeExact.identity)) return fail("recovery-required");
    if (candidateBeforeExact.contentHash !== baselineIndex.contentHash) {
      await fsp.writeFile(candidate.path, baselineIndex.bytes, { mode: baselineIndex.mode });
      await syncFile(candidate.path);
    }
    const candidateExact = await readIndexSnapshot(candidate.path);
    if (
      !sameFileIdentity(candidate.identity, candidateExact.identity) ||
      candidateExact.contentHash !== baselineIndex.contentHash
    ) {
      return fail("recovery-required");
    }
    const candidateExactSnapshot = await captureRepositorySnapshot(config, workspace, preflight.objectFormat, candidateScope);
    if (!sameRepositorySnapshot(baseline, candidateExactSnapshot)) return fail("recovery-required");

    const mainBeforeRename = await readIndexSnapshot(indexPath);
    if (
      !sameFileIdentity(source.identity, mainBeforeRename.identity) ||
      source.contentHash !== mainBeforeRename.contentHash
    ) {
      return fail("recovery-required");
    }
    const candidateBeforeRename = await readIndexSnapshot(candidate.path);
    if (
      !sameFileIdentity(candidate.identity, candidateBeforeRename.identity) ||
      candidateBeforeRename.contentHash !== baselineIndex.contentHash
    ) {
      return fail("recovery-required");
    }
    await fsp.chmod(candidate.path, baselineIndex.mode);
    await syncFile(candidate.path);
    const candidateAfterMode = await readIndexSnapshot(candidate.path);
    if (
      candidate.identity.device !== candidateAfterMode.identity.device ||
      candidate.identity.inode !== candidateAfterMode.identity.inode ||
      candidateAfterMode.contentHash !== baselineIndex.contentHash ||
      candidateAfterMode.mode !== baselineIndex.mode
    ) {
      return fail("recovery-required");
    }
    await syncDirectory(path.dirname(indexPath));
    await fsp.rename(candidate.path, indexPath);
    candidate = undefined;
    renamed = true;
    await syncDirectory(path.dirname(indexPath));
  } catch (error) {
    if (error instanceof GitCommitError && error.reason === "recovery-required") throw error;
    return fail("recovery-required");
  } finally {
    let cleanupError: unknown;
    if (!renamed && candidate !== undefined) {
      // The candidate path was created O_EXCL by this invocation. A leftover
      // candidate lock is ambiguous (for example after a killed child), so
      // leave both exact artifacts for recovery rather than guessing.
      let candidateLockExists = false;
      if (candidateLockPath !== undefined) {
        try {
          await fsp.lstat(candidateLockPath);
          candidateLockExists = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") candidateLockExists = true;
        }
      }
      if (!candidateLockExists) {
        try {
          await removeOwnedCandidate(candidate);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (lock !== undefined) {
      try {
        await removeOwnedIndexLock(lock);
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
}

async function prepareIntentEntries(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  baselineRemoteRefs: string,
  baselineIndex: GitIndexBaseline
): Promise<GitIntentReceipt[]> {
  const candidates = preflight.selected.filter(
    (selected) => selected.indexEntries.length === 0 && selected.worktree.kind !== "missing"
  );
  if (candidates.length === 0) return [];

  let commandError: unknown;
  try {
    await runGitChecked(
      config,
      workspace,
      ["add", "-N", "--", ...candidates.map((candidate) => candidate.path)],
      undefined,
      "intent-preparation"
    );
  } catch (error) {
    commandError = error;
  }

  let current: GitRepositorySnapshot;
  try {
    current = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
  } catch {
    return fail("recovery-required");
  }
  const receipts = collectIntentReceipts(preflight, baseline, current);
  const owned = new Set((receipts ?? []).map((receipt) => receipt.path));
  if (receipts === undefined || !assertUnselectedSnapshotPreserved(baseline, current, owned)) {
    return fail("recovery-required");
  }
  if (commandError !== undefined || receipts.length !== candidates.length) {
    if (receipts.length > 0) {
      await restoreOwnedIntentEntries(config, workspace, preflight, baseline, baselineRemoteRefs, baselineIndex, receipts);
    }
    if (commandError instanceof GitCommitError) throw commandError;
    return fail("execution");
  }
  return receipts;
}

async function expectedTreeChanges(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  selectedStates: ReadonlyMap<string, GitWorktreeEntryState>
): Promise<Map<string, GitRawDiffEntry>> {
  const selected = new Set(preflight.request.paths);
  const diff = await runGitChecked(config, workspace, [
    "diff",
    "--raw",
    "-z",
    "--full-index",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    preflight.head,
    "--",
    ...preflight.request.paths
  ], undefined, "passive-observation");
  const entries = parseRawDiffEntries(diff.copyStdoutBytes(), preflight.objectFormat, selected);
  for (const entry of entries.values()) {
    const selectedState = selectedStates.get(entry.path);
    if (selectedState === undefined) return fail("malformed-output");
    if (entry.newMode === "000000") {
      if (selectedState.kind !== "missing") return fail("preflight-changed");
      continue;
    }
    if (selectedState.kind !== "file" && selectedState.kind !== "symlink") {
      return fail("preflight-changed");
    }
    const expectedBlobId = selectedState.gitBlobId;
    if (expectedBlobId === null) return fail("preflight-changed");
    if (entry.newBlobId !== null && entry.newBlobId !== expectedBlobId) return fail("preflight-changed");
    entries.set(entry.path, { ...entry, newBlobId: expectedBlobId });
  }
  // Git's assume-unchanged/skip-worktree flags can hide a raw worktree change
  // from `diff HEAD`. Refuse that ambiguous state instead of reporting a
  // false no-change result or silently committing stale index content.
  for (const selectedPath of preflight.selected) {
    const state = selectedStates.get(selectedPath.path);
    if (state === undefined) return fail("malformed-output");
    if (worktreeDiffersFromHead(selectedPath, state) && !entries.has(selectedPath.path)) {
      return fail("preflight-changed");
    }
  }
  return entries;
}

async function treeEntries(
  config: GitCommitConfig,
  workspace: Workspace,
  commit: string,
  paths: readonly string[],
  format: "sha1" | "sha256"
): Promise<Map<string, GitTreeEntry>> {
  const result = await runGitChecked(config, workspace, ["ls-tree", "-z", "--full-tree", commit, "--", ...paths]);
  return parseTreeEntries(result.copyStdoutBytes(), format, new Set(paths));
}

async function changedTreePaths(
  config: GitCommitConfig,
  workspace: Workspace,
  oldHead: string,
  newHead: string
): Promise<Map<string, string>> {
  const result = await runGitChecked(config, workspace, [
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--name-status",
    "-z",
    "--no-renames",
    oldHead,
    newHead
  ]);
  return parseChangedPathRecords(result.copyStdoutBytes());
}

async function commitFailureRestoration(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  baselineRemoteRefs: string,
  baselineIndex: GitIndexBaseline,
  receipts: readonly GitIntentReceipt[]
): Promise<void> {
  try {
    const current = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
    const states = await selectedWorktreeStates(config, workspace, preflight);
    const branch = await currentBranchState(config, workspace, preflight.objectFormat);
    if (
      branch === undefined ||
      branch.ref !== `refs/heads/${preflight.branch}` ||
      branch.head !== preflight.head ||
      (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs ||
      !sameSnapshotMetadata(baseline, current)
    ) {
      return fail("recovery-required");
    }
    if (receipts.length === 0) {
      if (!sameRepositorySnapshot(baseline, current) || !selectedWorktreeStatesMatch(preflight, states)) {
        return fail("recovery-required");
      }
      return;
    }
    await restoreOwnedIntentEntries(config, workspace, preflight, baseline, baselineRemoteRefs, baselineIndex, receipts);
  } catch (error) {
    if (error instanceof GitCommitError && error.reason === "recovery-required") throw error;
    return fail("recovery-required");
  }
}

async function verifyCommitPostconditions(
  config: GitCommitConfig,
  workspace: Workspace,
  preflight: GitCommitPreflight,
  baseline: GitRepositorySnapshot,
  baselineRemoteRefs: string,
  expectedChanges: ReadonlyMap<string, GitRawDiffEntry>
): Promise<GitCommitResult> {
  try {
    const branch = await currentBranchState(config, workspace, preflight.objectFormat);
    if (
      branch === undefined ||
      branch.ref !== `refs/heads/${preflight.branch}` ||
      branch.head === preflight.head
    ) {
      return fail("postcondition");
    }
    const parentLine = oneLine(await runGitChecked(config, workspace, ["rev-list", "--parents", "--max-count=1", branch.head]));
    const parents = parentLine.split(" ").filter(Boolean);
    if (parents.length !== 2 || parents[0] !== branch.head || parents[1] !== preflight.head) return fail("postcondition");

    const actualChanges = await changedTreePaths(config, workspace, preflight.head, branch.head);
    const selected = new Set(preflight.request.paths);
    if (
      actualChanges.size !== expectedChanges.size ||
      [...actualChanges.keys()].some((relativePath) => !expectedChanges.has(relativePath)) ||
      [...expectedChanges.keys()].some((relativePath) => actualChanges.get(relativePath) !== expectedChanges.get(relativePath)?.status)
    ) {
      return fail("postcondition");
    }
    if ([...actualChanges.keys()].some((relativePath) => !selected.has(relativePath))) return fail("postcondition");

    const oldTree = await treeEntries(config, workspace, preflight.head, preflight.request.paths, preflight.objectFormat);
    const newTree = await treeEntries(config, workspace, branch.head, preflight.request.paths, preflight.objectFormat);
    for (const relativePath of preflight.request.paths) {
      const oldEntry = oldTree.get(relativePath);
      const newEntry = newTree.get(relativePath);
      if (JSON.stringify(oldEntry ?? null) !== JSON.stringify(newEntry ?? null) && !expectedChanges.has(relativePath)) {
        return fail("postcondition");
      }
      const expected = expectedChanges.get(relativePath);
      if (expected === undefined) continue;
      if (expected.newMode === "000000") {
        if (newEntry !== undefined) return fail("postcondition");
      } else if (
        newEntry === undefined ||
        newEntry.type !== "blob" ||
        newEntry.mode !== expected.newMode ||
        newEntry.objectId !== expected.newBlobId
      ) {
        return fail("postcondition");
      }
    }

    const after = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
    const selectedPaths = new Set(preflight.request.paths);
    if (
      !assertUnselectedSnapshotPreserved(baseline, after, selectedPaths) ||
      [...after.statuses.keys()].some((relativePath) => selectedPaths.has(relativePath)) ||
      (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs ||
      after.localConfig !== baseline.localConfig ||
      !localRefsChangedOnlyForBranch(
        baseline,
        after,
        `refs/heads/${preflight.branch}`,
        preflight.head,
        branch.head
      )
    ) {
      return fail("postcondition");
    }
    if (
      preflight.selected.some(
        (selected) => {
          const afterState = after.worktree.get(selected.path);
          if (selected.worktree.kind === "missing") {
            return afterState !== undefined && afterState.kind !== "missing";
          }
          return !sameRawWorktreeState(selected.worktree, afterState);
        }
      )
    ) {
      return fail("postcondition");
    }
    for (const relativePath of preflight.request.paths) {
      const treeEntry = newTree.get(relativePath);
      const indexEntries = after.index.get(relativePath) ?? [];
      if (treeEntry === undefined) {
        if (indexEntries.length !== 0) return fail("postcondition");
      } else if (
        indexEntries.length !== 1 ||
        indexEntries[0].stage !== 0 ||
        indexEntries[0].mode !== treeEntry.mode ||
        indexEntries[0].objectId !== treeEntry.objectId
      ) {
        return fail("postcondition");
      }
    }
    return {
      schema_version: 1,
      workspace_id: preflight.workspaceId,
      root: preflight.root,
      branch: preflight.branch,
      old_head: preflight.head,
      new_head: branch.head,
      requested_path_count: preflight.request.paths.length,
      committed_path_count: actualChanges.size,
      committed_paths: [...actualChanges.keys()]
    };
  } catch (error) {
    if (error instanceof GitCommitError && error.reason === "postcondition") throw error;
    return fail("postcondition");
  }
}

/**
 * Execute one ordinary local commit for an already explicit workspace. The
 * operation owns only selected-path intent preparation; all other state is
 * observed and compared, never broadly repaired.
 */
export async function gitCommit(
  config: GitCommitConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitCommitResult> {
  return withGitCommitLocks(config, guard, workspace, rawInput, async (preflight) => {
    const baseline = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
    const baselineIndexPath = await actualGitIndexPath(config, workspace, preflight);
    const baselineIndex = await readIndexBaseline(baselineIndexPath);
    const baselineRemoteRefs = await remoteRefsSnapshot(config, workspace);
    const baselineBranch = await currentBranchState(config, workspace, preflight.objectFormat);
    const initialStates = await selectedWorktreeStates(config, workspace, preflight);
    if (
      baselineBranch === undefined ||
      baselineBranch.ref !== `refs/heads/${preflight.branch}` ||
      baselineBranch.head !== preflight.head ||
      !selectedSnapshotMatchesPreflight(preflight, baseline, initialStates)
    ) {
      return fail("preflight-changed");
    }

    let receipts: GitIntentReceipt[] = [];
    let commitAttempted = false;
    try {
      receipts = await prepareIntentEntries(config, workspace, preflight, baseline, baselineRemoteRefs, baselineIndex);
      const selectedAfterPreparation = await selectedWorktreeStates(config, workspace, preflight);
      const preparedSnapshot = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
      if (
        !selectedWorktreeStatesMatch(preflight, selectedAfterPreparation) ||
        !assertPreparedSnapshotPreserved(baseline, preparedSnapshot, preflight, receipts) ||
        (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs
      ) {
        return fail("preflight-changed");
      }

      const selectedIdentityStates = await selectedGitIdentityStates(config, workspace, preflight);
      const afterIdentityResolution = await captureRepositorySnapshot(config, workspace, preflight.objectFormat);
      if (
        !selectedRawWorktreeStatesMatch(preflight, selectedIdentityStates) ||
        !assertPreparedSnapshotPreserved(baseline, afterIdentityResolution, preflight, receipts) ||
        (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs
      ) {
        return fail("postcondition");
      }

      const expectedChanges = await expectedTreeChanges(config, workspace, preflight, selectedIdentityStates);
      if (expectedChanges.size === 0) {
        await restoreOwnedIntentEntries(config, workspace, preflight, baseline, baselineRemoteRefs, baselineIndex, receipts);
        receipts = [];
        return fail("no-changes");
      }
      const beforeCommitBranch = await currentBranchState(config, workspace, preflight.objectFormat);
      if (
        beforeCommitBranch === undefined ||
        beforeCommitBranch.ref !== `refs/heads/${preflight.branch}` ||
        beforeCommitBranch.head !== preflight.head ||
        (await remoteRefsSnapshot(config, workspace)) !== baselineRemoteRefs
      ) {
        return fail("preflight-changed");
      }

      commitAttempted = true;
      try {
        await runGitMutation(config, workspace, [
          "commit",
          "--only",
          "--message",
          preflight.request.message,
          "--",
          ...preflight.request.paths
        ]);
      } catch (error) {
        await commitFailureRestoration(config, workspace, preflight, baseline, baselineRemoteRefs, baselineIndex, receipts);
        if (error instanceof GitCommitError) throw error;
        return fail("execution");
      }
      return await verifyCommitPostconditions(config, workspace, preflight, baseline, baselineRemoteRefs, expectedChanges);
    } catch (error) {
      if (!commitAttempted && receipts.length > 0) {
        await restoreOwnedIntentEntries(config, workspace, preflight, baseline, baselineRemoteRefs, baselineIndex, receipts);
      }
      if (!commitAttempted) {
        await assertPreAdvanceStatePreserved(config, workspace, preflight, baseline, baselineRemoteRefs);
      }
      throw error;
    }
  });
}
