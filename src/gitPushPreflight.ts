import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitMutation, type GitExecutionResult } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import { evaluateGitPushPolicy, inspectGitPushEndpoint } from "./gitPushPolicy.js";

/** The exact internal input carried from the later public wrapper. */
export interface GitPushRequest {
  readonly workspace_id: string;
  readonly remote: string;
  readonly branch: string;
  readonly expected_local_head: string;
  readonly expected_remote_head: string;
}

/** Configuration needed by the preflight; no public tool registration is implied. */
export type GitPushPreflightConfig = Pick<
  CodexProConfig,
  "maxGitTimeoutMs" | "maxOutputBytes" | "toolMode" | "writeMode" | "gitPushPolicy"
>;

export type GitPushPreflightFailureReason =
  | "invalid-input"
  | "mode"
  | "write-mode"
  | "workspace"
  | "repository"
  | "detached"
  | "branch-mismatch"
  | "unborn"
  | "in-progress"
  | "invalid-head"
  | "head-mismatch"
  | "missing-remote-object"
  | "remote-object-not-commit"
  | "non-fast-forward"
  | "policy-disabled"
  | "invalid-policy"
  | "invalid-remote-or-branch"
  | "remote-or-branch-not-allowlisted"
  | "ambiguous-policy-rule"
  | "effective-endpoint-not-allowlisted"
  | "effective-endpoint-unavailable"
  | "zero-effective-push-endpoints"
  | "ambiguous-multiple-effective-push-endpoints"
  | "credential-bearing-endpoint"
  | "disallowed-remote-helper"
  | "disallowed-file-endpoint"
  | "disallowed-endpoint-scheme"
  | "invalid-endpoint"
  | "disallowed-local-or-helper-endpoint"
  | "disallowed-local-endpoint"
  | "non-default-receive-pack"
  | "config-source-discovery"
  | "dynamic-config-source"
  | "remote-absent"
  | "remote-ambiguous"
  | "remote-head-mismatch"
  | "remote-malformed"
  | "malformed-output"
  | "execution";

const FAILURE_MESSAGES: Record<GitPushPreflightFailureReason, string> = {
  "invalid-input": "Git push preflight input is invalid.",
  mode: "Git push requires full tool mode.",
  "write-mode": "Git push requires workspace write mode.",
  workspace: "Git push workspace identity is invalid.",
  repository: "Git push requires the exact root of a non-bare Git worktree.",
  detached: "Git push requires an attached local branch.",
  "branch-mismatch": "Git push requested branch does not match the attached local branch.",
  unborn: "Git push requires an existing local HEAD commit.",
  "in-progress": "Git push is unavailable during an in-progress history operation.",
  "invalid-head": "Git push expected heads are not full object-format SHAs.",
  "head-mismatch": "Git push expected_local_head does not match the current HEAD.",
  "missing-remote-object": "Git push expected_remote_head is not available as a local object.",
  "remote-object-not-commit": "Git push expected_remote_head is not a local commit object.",
  "non-fast-forward": "Git push local history is not a descendant of expected_remote_head.",
  "policy-disabled": "Git push policy is disabled.",
  "invalid-policy": "Git push policy is invalid.",
  "invalid-remote-or-branch": "Git push remote or branch is invalid.",
  "remote-or-branch-not-allowlisted": "Git push remote and branch are not allowlisted.",
  "ambiguous-policy-rule": "Git push policy has an ambiguous remote and branch rule.",
  "effective-endpoint-not-allowlisted": "Git push effective endpoint is not allowlisted.",
  "effective-endpoint-unavailable": "Git push effective endpoint could not be observed.",
  "zero-effective-push-endpoints": "Git push remote has no effective push endpoint.",
  "ambiguous-multiple-effective-push-endpoints": "Git push remote has ambiguous effective push endpoints.",
  "credential-bearing-endpoint": "Git push remote endpoint is not credential-safe.",
  "disallowed-remote-helper": "Git push remote helper is not allowed.",
  "disallowed-file-endpoint": "Git push file endpoint is not allowed.",
  "disallowed-endpoint-scheme": "Git push endpoint scheme is not allowed.",
  "invalid-endpoint": "Git push endpoint is invalid.",
  "disallowed-local-or-helper-endpoint": "Git push local or helper endpoint is not allowed.",
  "disallowed-local-endpoint": "Git push local endpoint is not allowed.",
  "non-default-receive-pack": "Git push configured receive-pack is not the default.",
  "config-source-discovery": "Git push configuration sources could not be safely enumerated.",
  "dynamic-config-source": "Git push configuration includes an unsupported dynamic source.",
  "remote-absent": "Git push remote branch does not exist.",
  "remote-ambiguous": "Git push remote branch observation was ambiguous.",
  "remote-head-mismatch": "Git push remote branch does not match expected_remote_head.",
  "remote-malformed": "Git push remote branch observation was malformed.",
  "malformed-output": "Git push returned malformed preflight output.",
  execution: "Git push preflight failed during local Git execution."
};

/** Constant-message, JSON-safe internal failure. Git/auth output is never returned. */
export class GitPushPreflightError extends CodexProError {
  constructor(
    readonly reason: GitPushPreflightFailureReason,
    readonly policyReason?: string
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitPushPreflightError";
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      ...(this.policyReason === undefined ? {} : { policy_reason: this.policyReason })
    };
  }
}

/** Exact internal source/destination facts consumed by the mutation leaf. */
export interface GitPushPreflight {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly git_dir: string;
  readonly config_path: string;
  /** Every active file origin plus all bounded config/include targets. */
  readonly config_sources: readonly string[];
  readonly object_format: "sha1" | "sha256";
  readonly remote: string;
  readonly endpoint: string;
  readonly branch: string;
  readonly source_ref: string;
  readonly destination_ref: string;
  readonly expected_local_head: string;
  readonly expected_remote_head: string;
}

export type GitPushRemoteObservation =
  | { readonly status: "head"; readonly head: string }
  | { readonly status: "absent" | "ambiguous" | "malformed" | "execution" };

const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const GLOB_TOKEN = /[*?\[\]]/u;
const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{24}$/u;
const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const MAX_WORKSPACE_ID_BYTES = 128;
const MAX_REMOTE_BYTES = 256;
const MAX_BRANCH_BYTES = 256;
const MAX_HEAD_BYTES = 64;
const MAX_REMOTE_OBSERVATION_BYTES = 16 * 1024;
const MAX_CONFIG_SOURCE_BYTES = 128 * 1024;
const MAX_CONFIG_SOURCE_COUNT = 512;
const MAX_CONFIG_SOURCE_PATH_BYTES = 8 * 1024;
const MAX_CONFIG_INCLUDE_QUERY_BYTES = 32 * 1024;
const MAX_CONFIG_INCLUDE_DEPTH = 64;
const INTERNAL_CONFIG_ORIGIN = "command line:";
const INTERNAL_CONFIG_KEYS = new Set(["color.ui"]);
const INCLUDE_PATH_QUERY_PATTERNS = Object.freeze(["^include\\.path$", "^includeif\\..*\\.path$"] as const);
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
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

function fail(reason: GitPushPreflightFailureReason, policyReason?: string): never {
  throw new GitPushPreflightError(reason, policyReason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && Buffer.byteLength(value, "utf8") <= maxBytes && !CONTROL_OR_WHITESPACE.test(value);
}

function validateRemote(value: unknown): string {
  if (!validBoundedString(value, MAX_REMOTE_BYTES) || value.startsWith("-") || GLOB_TOKEN.test(value) || value.includes("::")) {
    return fail("invalid-remote-or-branch");
  }
  return value;
}

function validateBranch(value: unknown): string {
  if (!validBoundedString(value, MAX_BRANCH_BYTES)) return fail("invalid-remote-or-branch");
  const branch = value;
  const components = branch.split("/");
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.includes("~") ||
    branch.includes("^") ||
    branch.includes(":") ||
    branch.includes("\\") ||
    branch === "@" ||
    branch === "." ||
    branch === ".." ||
    GLOB_TOKEN.test(branch) ||
    components.some((component) => component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"))
  ) {
    return fail("invalid-remote-or-branch");
  }
  return branch;
}

function validateHead(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || Buffer.byteLength(value, "utf8") > MAX_HEAD_BYTES || !FULL_OBJECT_ID_PATTERN.test(value)) {
    return fail("invalid-head");
  }
  return value.toLowerCase();
}

/** Strict internal request validator; the public wrapper owns its own schema surface. */
export function validateGitPushRequest(raw: unknown): GitPushRequest {
  if (!isRecord(raw)) return fail("invalid-input");
  const keys = Object.keys(raw);
  const allowed = new Set(["workspace_id", "remote", "branch", "expected_local_head", "expected_remote_head"]);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) return fail("invalid-input");

  const workspaceId = raw.workspace_id;
  if (
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    Buffer.byteLength(workspaceId, "utf8") > MAX_WORKSPACE_ID_BYTES ||
    workspaceId.trim() !== workspaceId ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    return fail("invalid-input");
  }

  return {
    workspace_id: workspaceId,
    remote: validateRemote(raw.remote),
    branch: validateBranch(raw.branch),
    expected_local_head: validateHead(raw.expected_local_head),
    expected_remote_head: validateHead(raw.expected_remote_head)
  };
}

function decodeUtf8(result: GitExecutionResult): string {
  try {
    return UTF8_FATAL.decode(result.copyStdoutBytes());
  } catch {
    return fail("malformed-output");
  }
}

function oneLine(result: GitExecutionResult): string {
  const text = decodeUtf8(result);
  if (!text.endsWith("\n")) return fail("malformed-output");
  const line = text.slice(0, -1);
  if (!line || line.includes("\n") || line.includes("\r")) return fail("malformed-output");
  return line;
}

async function runGitExitAware(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  args: readonly string[]
): Promise<GitExecutionResult> {
  try {
    return await runGitMutation(config, workspace, args);
  } catch (error) {
    if (error instanceof GitExecutionError) return error.result;
    return fail("execution");
  }
}

async function runGitChecked(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  args: readonly string[]
): Promise<GitExecutionResult> {
  const result = await runGitExitAware(config, workspace, args);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return fail("execution");
  }
  return result;
}

function objectFormatFromResult(result: GitExecutionResult): "sha1" | "sha256" {
  const value = oneLine(result);
  if (value === "sha1" || value === "sha256") return value;
  return fail("malformed-output");
}

function objectIdPattern(objectFormat: "sha1" | "sha256"): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/iu : /^[0-9a-f]{64}$/iu;
}

function parseObjectId(value: string, objectFormat: "sha1" | "sha256"): string {
  const normalized = value.toLowerCase();
  if (!objectIdPattern(objectFormat).test(normalized)) return fail("malformed-output");
  return normalized;
}

function compareConfigSourcePaths(left: string, right: string): number {
  const leftKey = process.platform === "win32" ? left.toLowerCase() : left;
  const rightKey = process.platform === "win32" ? right.toLowerCase() : right;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function configSourcePathKey(sourcePath: string): string {
  return process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
}

function normalizeConfigSourcePath(origin: string, workspaceRoot: string): string {
  if (!origin.startsWith("file:")) return fail("dynamic-config-source");
  const rawPath = origin.slice("file:".length);
  if (!rawPath || Buffer.byteLength(rawPath, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(rawPath)) return fail("config-source-discovery");
  const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(workspaceRoot, rawPath);
  if (!path.isAbsolute(resolved) || Buffer.byteLength(resolved, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(resolved)) return fail("config-source-discovery");
  return resolved;
}

function trustedHomeDirectory(): string {
  const home = process.env.HOME ?? os.homedir();
  if (!home || CONTROL_CHARACTERS.test(home) || !path.isAbsolute(home)) return fail("config-source-discovery");
  return path.normalize(home);
}

function normalizeConfigTargetPath(rawPath: string, baseDirectory: string): string {
  if (!rawPath || Buffer.byteLength(rawPath, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(rawPath)) {
    return fail("config-source-discovery");
  }
  let expanded = rawPath;
  if (expanded === "~" || expanded.startsWith("~/")) {
    const home = trustedHomeDirectory();
    expanded = expanded === "~" ? home : path.join(home, expanded.slice(2));
  } else if (expanded.startsWith("~")) {
    // `~user` expansion is not tied to the trusted process HOME and is not
    // needed by the accepted Git configuration route.
    return fail("config-source-discovery");
  }
  // Git include globs and other prefix substitutions do not identify one
  // exact native lock target. Refuse them instead of guessing or expanding a
  // potentially unbounded set of files.
  if (GLOB_TOKEN.test(expanded) || expanded.includes("%")) return fail("config-source-discovery");
  const resolved = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDirectory, expanded);
  if (!path.isAbsolute(resolved) || Buffer.byteLength(resolved, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(resolved)) return fail("config-source-discovery");
  return resolved;
}

function trustedGlobalConfigTargets(): readonly string[] {
  const home = trustedHomeDirectory();

  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const xdgRoot = xdgConfigHome === undefined || xdgConfigHome === ""
    ? path.join(home, ".config")
    : xdgConfigHome;
  if (CONTROL_CHARACTERS.test(xdgRoot) || !path.isAbsolute(xdgRoot)) return fail("config-source-discovery");

  // Git 2.43 writes `git config --global` to $HOME/.gitconfig on this
  // platform. The XDG target is also included because it is a valid global
  // source when present and can be the active file for included config.
  return Object.freeze([
    path.normalize(path.join(home, ".gitconfig")),
    path.normalize(path.join(xdgRoot, "git", "config"))
  ]);
}

type GitConfigPathVariable = "GIT_CONFIG_SYSTEM" | "GIT_CONFIG_GLOBAL";

function parseGitConfigPathVariable(bytes: Buffer, workspaceRoot: string): readonly string[] {
  if (bytes.length === 0 || bytes.length > MAX_CONFIG_SOURCE_BYTES || bytes.at(-1) !== 0x0a) {
    return fail("config-source-discovery");
  }
  const targets = new Map<string, string>();
  let lineCount = 0;
  const addTarget = (rawPath: string): void => {
    if (!path.isAbsolute(rawPath)) return fail("config-source-discovery");
    const normalized = normalizeConfigTargetPath(rawPath, workspaceRoot);
    const key = configSourcePathKey(normalized);
    if (!targets.has(key)) targets.set(key, normalized);
    if (targets.size > MAX_CONFIG_SOURCE_COUNT) return fail("config-source-discovery");
  };

  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) return fail("config-source-discovery");
    const line = bytes.subarray(offset, newline);
    if (line.length === 0) return fail("config-source-discovery");
    lineCount += 1;
    if (lineCount > MAX_CONFIG_SOURCE_COUNT) return fail("config-source-discovery");
    let rawPath: string;
    try {
      rawPath = UTF8_FATAL.decode(line);
    } catch {
      return fail("config-source-discovery");
    }
    addTarget(rawPath);
    offset = newline + 1;
  }

  if (lineCount === 0 || targets.size === 0) return fail("config-source-discovery");
  return Object.freeze([...targets.values()]);
}

async function discoverGitConfigPathVariable(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  variable: GitConfigPathVariable
): Promise<readonly string[]> {
  // Git exposes these two sealed variables as path-only, newline-delimited
  // output. Keep the queries separate so no broad variable/config listing can
  // capture unrelated effective values such as credentials or remote URLs.
  const result = await runGitExitAware(config, workspace, ["var", variable]);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow || result.copyStderrBytes().length > 0) {
    return fail("config-source-discovery");
  }
  return parseGitConfigPathVariable(result.copyStdoutBytes(), workspace.root);
}

function parseIncludeQueryRecords(bytes: Buffer, sourcePath: string, workspaceRoot: string): readonly string[] {
  if (bytes.length > MAX_CONFIG_INCLUDE_QUERY_BYTES) return fail("config-source-discovery");
  if (bytes.length === 0) return Object.freeze([]);
  if (bytes.at(-1) !== 0) return fail("config-source-discovery");
  let text: string;
  try {
    text = UTF8_FATAL.decode(bytes);
  } catch {
    return fail("config-source-discovery");
  }
  const fields = text.split("\u0000");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return fail("config-source-discovery");
  const sourceKey = configSourcePathKey(path.normalize(sourcePath));
  const targets: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const origin = fields[index];
    const record = fields[index + 1];
    if (!origin || !record || CONTROL_CHARACTERS.test(origin)) return fail("config-source-discovery");
    const separator = record.indexOf("\n");
    if (separator <= 0 || record.indexOf("\n", separator + 1) >= 0) return fail("config-source-discovery");
    const key = record.slice(0, separator);
    const rawPath = record.slice(separator + 1);
    if (!key || !rawPath || CONTROL_CHARACTERS.test(key) || CONTROL_CHARACTERS.test(rawPath)) return fail("config-source-discovery");
    const originPath = normalizeConfigSourcePath(origin, workspaceRoot);
    if (configSourcePathKey(originPath) !== sourceKey) return fail("config-source-discovery");
    const loweredKey = key.toLowerCase();
    if (loweredKey !== "include.path" && !/^includeif\..*\.path$/u.test(loweredKey)) {
      return fail("dynamic-config-source");
    }
    targets.push(normalizeConfigTargetPath(rawPath, path.dirname(sourcePath)));
    if (targets.length > MAX_CONFIG_SOURCE_COUNT) return fail("config-source-discovery");
  }
  return Object.freeze(targets);
}

async function discoverIncludeTargets(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  sourcePath: string
): Promise<readonly string[]> {
  let stat;
  try {
    stat = await fsp.stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    return fail("config-source-discovery");
  }
  if (!stat.isFile()) return Object.freeze([]);

  const targets: string[] = [];
  for (const queryPattern of INCLUDE_PATH_QUERY_PATTERNS) {
    const result = await runGitExitAware(config, workspace, [
      "config",
      "--file",
      sourcePath,
      "--no-includes",
      "--show-origin",
      "--null",
      "--type",
      "path",
      "--get-regexp",
      queryPattern
    ]);
    const output = result.copyStdoutBytes();
    const diagnostics = result.copyStderrBytes();
    if (result.exitCode === 1 && result.signal === null && !result.timedOut && !result.stdoutOverflow && !result.stderrOverflow && output.length === 0 && diagnostics.length === 0) {
      continue;
    }
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow || diagnostics.length > 0) {
      return fail("config-source-discovery");
    }
    const queryTargets = parseIncludeQueryRecords(output, sourcePath, workspace.root);
    if (targets.length + queryTargets.length > MAX_CONFIG_SOURCE_COUNT) return fail("config-source-discovery");
    targets.push(...queryTargets);
  }
  return Object.freeze(targets);
}

/**
 * Enumerate the ordinary active config origins and key names. `--name-only`
 * is intentional: values (including URLs and credentials) never enter this
 * inventory or any public result. Include path values are collected by the
 * separate bounded exact-key path-only queries above so empty targets can be
 * covered without reading values from unrelated `include*` sections.
 * Git emits origin/key pairs as NUL-delimited fields; recursive active
 * includes are enabled explicitly.
 */
async function discoverGitPushConfigSources(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  repositoryConfigPath: string,
  worktreeConfigPath: string
): Promise<readonly string[]> {
  const sourceResult = await runGitExitAware(config, workspace, [
    "config",
    "--show-origin",
    "--name-only",
    "--null",
    "--list",
    "--includes"
  ]);
  if (sourceResult.exitCode !== 0 || sourceResult.signal !== null || sourceResult.timedOut || sourceResult.stdoutOverflow || sourceResult.stderrOverflow) {
    return fail("config-source-discovery");
  }
  const bytes = sourceResult.copyStdoutBytes();
  if (bytes.length > MAX_CONFIG_SOURCE_BYTES) return fail("config-source-discovery");
  let text: string;
  try {
    text = UTF8_FATAL.decode(bytes);
  } catch {
    return fail("config-source-discovery");
  }

  if (text.length > 0 && !text.endsWith("\u0000")) return fail("config-source-discovery");
  const fields = text.length === 0 ? [] : text.split("\u0000");
  if (fields.length > 0 && fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) return fail("config-source-discovery");
  const paths = new Map<string, string>();
  const addPath = (sourcePath: string): void => {
    const normalized = path.normalize(sourcePath);
    if (!path.isAbsolute(normalized) || Buffer.byteLength(normalized, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(normalized)) {
      return fail("config-source-discovery");
    }
    const key = configSourcePathKey(normalized);
    if (!paths.has(key)) paths.set(key, normalized);
    if (paths.size > MAX_CONFIG_SOURCE_COUNT) fail("config-source-discovery");
  };

  for (let index = 0; index < fields.length; index += 2) {
    const origin = fields[index];
    const key = fields[index + 1];
    if (!origin || !key || CONTROL_CHARACTERS.test(key)) return fail("config-source-discovery");
    if (origin.startsWith("file:")) {
      addPath(normalizeConfigSourcePath(origin, workspace.root));
      continue;
    }
    // runGitMutation supplies only this fixed command-line setting. Any other
    // dynamic origin could redirect the named remote outside the lock set.
    if (origin !== INTERNAL_CONFIG_ORIGIN || !INTERNAL_CONFIG_KEYS.has(key)) {
      return fail("dynamic-config-source");
    }
  }

  const systemConfigTargets = await discoverGitConfigPathVariable(config, workspace, "GIT_CONFIG_SYSTEM");
  const globalConfigTargets = await discoverGitConfigPathVariable(config, workspace, "GIT_CONFIG_GLOBAL");
  for (const target of systemConfigTargets) addPath(target);
  for (const target of globalConfigTargets) addPath(target);
  addPath(repositoryConfigPath);
  addPath(worktreeConfigPath);
  for (const target of trustedGlobalConfigTargets()) addPath(target);

  // `--list --includes --name-only` cannot report an empty or missing include
  // file. Query each known file directly for include path metadata only, then
  // recurse over every exactly resolved target. Conditional include targets
  // are intentionally over-locked; their path is still exact even when the
  // condition is inactive, while unsupported path forms fail closed above.
  const queued = [...paths.values()];
  const depths = new Map<string, number>(queued.map((sourcePath) => [configSourcePathKey(sourcePath), 0]));
  for (let index = 0; index < queued.length; index += 1) {
    const sourcePath = queued[index];
    const depth = depths.get(configSourcePathKey(sourcePath)) ?? 0;
    if (depth >= MAX_CONFIG_INCLUDE_DEPTH) return fail("config-source-discovery");
    for (const target of await discoverIncludeTargets(config, workspace, sourcePath)) {
      addPath(target);
      const targetKey = configSourcePathKey(target);
      if (!depths.has(targetKey)) {
        depths.set(targetKey, depth + 1);
        queued.push(target);
      }
    }
  }

  return Object.freeze([...paths.values()].sort(compareConfigSourcePaths));
}

async function repositoryRoot(
  config: GitPushPreflightConfig,
  workspace: Workspace
): Promise<{
  readonly root: string;
  readonly gitDir: string;
  readonly configPath: string;
  readonly worktreeConfigPath: string;
  readonly objectFormat: "sha1" | "sha256";
}> {
  if (!path.isAbsolute(workspace.root)) return fail("workspace");
  let root: string;
  try {
    root = await fsp.realpath(workspace.root);
  } catch {
    return fail("workspace");
  }
  if (root !== workspace.root) return fail("workspace");

  const inside = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--is-inside-work-tree"]));
  const bare = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--is-bare-repository"]));
  if (inside !== "true" || bare !== "false") return fail("repository");

  const topText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--show-toplevel"]));
  let top: string;
  try {
    top = await fsp.realpath(path.isAbsolute(topText) ? topText : path.resolve(root, topText));
  } catch {
    return fail("repository");
  }
  if (top !== root) return fail("repository");

  const gitDirText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--git-dir"]));
  let gitDir: string;
  try {
    gitDir = await fsp.realpath(path.isAbsolute(gitDirText) ? gitDirText : path.resolve(root, gitDirText));
  } catch {
    return fail("repository");
  }
  const configPathText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--path-format=absolute", "--git-path", "config"]));
  if (!path.isAbsolute(configPathText) || Buffer.byteLength(configPathText, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(configPathText) || path.basename(configPathText) !== "config") {
    return fail("repository");
  }
  const configPath = path.normalize(configPathText);
  try {
    const configStat = await fsp.stat(configPath);
    if (!configStat.isFile()) return fail("repository");
  } catch {
    return fail("repository");
  }
  const worktreeConfigPathText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--path-format=absolute", "--git-path", "config.worktree"]));
  if (!path.isAbsolute(worktreeConfigPathText) || Buffer.byteLength(worktreeConfigPathText, "utf8") > MAX_CONFIG_SOURCE_PATH_BYTES || CONTROL_CHARACTERS.test(worktreeConfigPathText) || path.basename(worktreeConfigPathText) !== "config.worktree") {
    return fail("repository");
  }
  const worktreeConfigPath = path.normalize(worktreeConfigPathText);
  const objectFormat = objectFormatFromResult(
    await runGitChecked(config, workspace, ["rev-parse", "--show-object-format=storage"])
  );
  return { root, gitDir, configPath, worktreeConfigPath, objectFormat };
}

async function assertNoHistoryOperation(
  config: GitPushPreflightConfig,
  workspace: Workspace
): Promise<void> {
  for (const marker of GIT_HISTORY_MARKERS) {
    const markerText = oneLine(await runGitChecked(config, workspace, ["rev-parse", "--git-path", marker]));
    if (CONTROL_OR_WHITESPACE.test(markerText)) return fail("malformed-output");
    const markerPath = path.isAbsolute(markerText) ? path.resolve(markerText) : path.resolve(workspace.root, markerText);
    try {
      await fsp.lstat(markerPath);
      return fail("in-progress");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("in-progress");
    }
  }
}

function policyFailureReason(reason: string | undefined): GitPushPreflightFailureReason {
  const known = new Set<GitPushPreflightFailureReason>([
    "policy-disabled",
    "invalid-policy",
    "invalid-remote-or-branch",
    "remote-or-branch-not-allowlisted",
    "ambiguous-policy-rule",
    "effective-endpoint-not-allowlisted",
    "effective-endpoint-unavailable",
    "zero-effective-push-endpoints",
    "ambiguous-multiple-effective-push-endpoints",
    "credential-bearing-endpoint",
    "disallowed-remote-helper",
    "disallowed-file-endpoint",
    "disallowed-endpoint-scheme",
    "invalid-endpoint",
    "disallowed-local-or-helper-endpoint",
    "disallowed-local-endpoint"
  ]);
  return reason !== undefined && known.has(reason as GitPushPreflightFailureReason)
    ? reason as GitPushPreflightFailureReason
    : "invalid-policy";
}

async function assertRemoteObject(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  expectedRemoteHead: string
): Promise<void> {
  const result = await runGitExitAware(config, workspace, ["cat-file", "-t", expectedRemoteHead]);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return fail("missing-remote-object");
  }
  if (oneLine(result) !== "commit") return fail("remote-object-not-commit");
}

const DEFAULT_RECEIVE_PACK = "git-receive-pack";

async function assertDefaultReceivePack(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  remote: string
): Promise<void> {
  const result = await runGitExitAware(config, workspace, ["config", "--null", "--get-all", `remote.${remote}.receivepack`]);
  const output = result.copyStdoutBytes();
  const diagnostics = result.copyStderrBytes();
  if (result.exitCode === 1 && result.signal === null && !result.timedOut && !result.stdoutOverflow && !result.stderrOverflow && output.length === 0 && diagnostics.length === 0) {
    return;
  }
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return fail("execution");
  }
  const bytes = output;
  if (bytes.length > MAX_REMOTE_OBSERVATION_BYTES) return fail("malformed-output");
  let text: string;
  try {
    text = UTF8_FATAL.decode(bytes);
  } catch {
    return fail("malformed-output");
  }
  if (!text) return fail("malformed-output");
  if (!text.endsWith("\u0000")) return fail("malformed-output");
  const values = text.slice(0, -1).split("\u0000");
  if (values.length !== 1 || values[0] !== DEFAULT_RECEIVE_PACK) return fail("non-default-receive-pack");
}

export async function observeGitPushRemoteHead(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  remote: string,
  destinationRef: string,
  objectFormat: "sha1" | "sha256"
): Promise<GitPushRemoteObservation> {
  let result: GitExecutionResult;
  try {
    result = await runGitExitAware(config, workspace, ["ls-remote", "--refs", "--heads", "--", remote, destinationRef]);
  } catch {
    return { status: "execution" };
  }
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return { status: "execution" };
  }
  const bytes = result.copyStdoutBytes();
  if (bytes.length > MAX_REMOTE_OBSERVATION_BYTES) return { status: "ambiguous" };
  let text: string;
  try {
    text = decodeUtf8(result);
  } catch {
    return { status: "malformed" };
  }
  if (text.length === 0) return { status: "absent" };
  if (!text.endsWith("\n")) return { status: "malformed" };
  const body = text.slice(0, -1);
  if (!body) return { status: "absent" };
  const lines = body.split("\n");
  if (lines.length !== 1) return { status: "ambiguous" };
  const separator = lines[0].indexOf("\t");
  if (separator <= 0 || lines[0].indexOf("\t", separator + 1) >= 0) return { status: "malformed" };
  let head: string;
  try {
    head = parseObjectId(lines[0].slice(0, separator), objectFormat);
  } catch {
    return { status: "malformed" };
  }
  if (lines[0].slice(separator + 1) !== destinationRef) return { status: "malformed" };
  return { status: "head", head };
}

async function assertRemoteHead(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  remote: string,
  destinationRef: string,
  objectFormat: "sha1" | "sha256",
  expectedRemoteHead: string
): Promise<void> {
  const observed = await observeGitPushRemoteHead(config, workspace, remote, destinationRef, objectFormat);
  if (observed.status === "absent") return fail("remote-absent");
  if (observed.status === "ambiguous") return fail("remote-ambiguous");
  if (observed.status === "malformed") return fail("remote-malformed");
  if (observed.status === "execution") return fail("execution");
  if (observed.status !== "head") return fail("execution");
  if (observed.head !== expectedRemoteHead) return fail("remote-head-mismatch");
}

async function effectivePushEndpoint(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  remote: string,
  expectedIdentity: string
): Promise<string> {
  const result = await runGitChecked(config, workspace, ["remote", "get-url", "--push", "--all", remote]);
  const bytes = result.copyStdoutBytes();
  if (bytes.length > MAX_REMOTE_OBSERVATION_BYTES) return fail("ambiguous-multiple-effective-push-endpoints");
  const text = decodeUtf8(result);
  if (!text.endsWith("\n")) return fail("effective-endpoint-unavailable");
  const body = text.slice(0, -1);
  if (!body) return fail("zero-effective-push-endpoints");
  const lines = body.split("\n");
  if (lines.length !== 1) return fail("ambiguous-multiple-effective-push-endpoints");
  const rawEndpoint = lines[0];
  const parsed = inspectGitPushEndpoint(rawEndpoint);
  if (!parsed.ok) return fail(policyFailureReason(parsed.reason), parsed.reason);
  if (parsed.identity !== expectedIdentity) return fail("effective-endpoint-not-allowlisted");
  return parsed.identity;
}

/**
 * Re-resolve one credential-free effective push endpoint through the trusted
 * named-remote configuration. Callers receive only its policy identity; the
 * raw endpoint is never reused as a Git repository argument.
 */
export async function resolveGitPushMutationEndpoint(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  remote: string,
  authorizedIdentity: string
): Promise<string> {
  return effectivePushEndpoint(config, workspace, remote, authorizedIdentity);
}

/**
 * Validate one explicit workspace and exact local/remote/policy push precondition.
 * Every Git invocation uses the sealed trusted-config runner and only fixed
 * direct argv. This function never invokes push or any local/remote mutation.
 */
export async function preflightGitPush(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitPushPreflight> {
  const request = validateGitPushRequest(rawInput);
  if (config.toolMode !== "full") return fail("mode");
  if (config.writeMode !== "workspace") return fail("write-mode");
  if (typeof workspace.id !== "string" || workspace.id !== request.workspace_id || !WORKSPACE_ID_PATTERN.test(workspace.id)) {
    return fail("workspace");
  }

  const repository = await repositoryRoot(config, workspace);
  const configSources = await discoverGitPushConfigSources(
    config,
    workspace,
    repository.configPath,
    repository.worktreeConfigPath
  );
  if (request.expected_local_head.length !== (repository.objectFormat === "sha1" ? 40 : 64) || request.expected_remote_head.length !== (repository.objectFormat === "sha1" ? 40 : 64)) {
    return fail("invalid-head");
  }

  const branchRef = `refs/heads/${request.branch}`;
  const symbolicResult = await runGitExitAware(config, workspace, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolicResult.exitCode !== 0 || symbolicResult.signal !== null || symbolicResult.timedOut) return fail("detached");
  const attachedRef = oneLine(symbolicResult);
  if (attachedRef !== branchRef) return fail("branch-mismatch");

  const headResult = await runGitExitAware(config, workspace, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (headResult.exitCode !== 0 || headResult.signal !== null || headResult.timedOut) return fail("unborn");
  const currentHead = parseObjectId(oneLine(headResult), repository.objectFormat);
  if (currentHead !== request.expected_local_head) return fail("head-mismatch");

  await assertNoHistoryOperation(config, workspace);

  const policy = evaluateGitPushPolicy(repository.root, config.gitPushPolicy, request.remote, request.branch);
  if (!policy.allowed) return fail(policyFailureReason(policy.reason), policy.reason);
  if (!policy.endpoint) return fail("invalid-policy", "missing-effective-endpoint");
  await effectivePushEndpoint(config, workspace, request.remote, policy.endpoint);

  await assertRemoteObject(config, workspace, request.expected_remote_head);
  const ancestry = await runGitExitAware(config, workspace, ["merge-base", "--is-ancestor", request.expected_remote_head, request.expected_local_head]);
  if (ancestry.exitCode === 1 && ancestry.signal === null && !ancestry.timedOut) return fail("non-fast-forward");
  if (ancestry.exitCode !== 0 || ancestry.signal !== null || ancestry.timedOut) return fail("execution");

  await assertDefaultReceivePack(config, workspace, request.remote);
  await assertRemoteHead(config, workspace, request.remote, branchRef, repository.objectFormat, request.expected_remote_head);

  return Object.freeze({
    schema_version: 1 as const,
    workspace_id: request.workspace_id,
    root: repository.root,
    git_dir: repository.gitDir,
    config_path: repository.configPath,
    config_sources: configSources,
    object_format: repository.objectFormat,
    remote: request.remote,
    endpoint: policy.endpoint,
    branch: request.branch,
    source_ref: branchRef,
    destination_ref: branchRef,
    expected_local_head: request.expected_local_head,
    expected_remote_head: request.expected_remote_head
  });
}

/**
 * Re-run the complete immutable preflight immediately before mutation. This
 * closes the mutable local/policy/remote observation window without changing
 * the accepted one-shot CAS contract. A final endpoint identity resolution
 * binds the named-remote push route to the authorized policy identity; the
 * caller never receives or reuses the raw endpoint string.
 */
export async function revalidateGitPushPreflight(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  initial: GitPushPreflight
): Promise<{ readonly preflight: GitPushPreflight }> {
  const refreshed = await preflightGitPush(config, workspace, {
    workspace_id: initial.workspace_id,
    remote: initial.remote,
    branch: initial.branch,
    expected_local_head: initial.expected_local_head,
    expected_remote_head: initial.expected_remote_head
  });
  if (refreshed.endpoint !== initial.endpoint) return fail("effective-endpoint-not-allowlisted");
  const endpointIdentity = await resolveGitPushMutationEndpoint(config, workspace, refreshed.remote, refreshed.endpoint);
  if (endpointIdentity !== refreshed.endpoint || endpointIdentity !== initial.endpoint) return fail("effective-endpoint-not-allowlisted");
  return Object.freeze({ preflight: refreshed });
}
