import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitMutation, type GitExecutionResult } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import { configSourcesCovered, GitPushConfigLockError, withGitPushConfigLocks, type GitPushConfigLock } from "./gitPushConfigLock.js";
import {
  assertGitPushDefaultReceivePack,
  assertGitPushNoHistoryOperation,
  discoverGitPushConfigSourcesForMutation,
  inspectGitPushRepository,
  observeGitPushRemoteHead,
  type GitPushRemoteObservation
} from "./gitPushPreflight.js";
import { evaluateGitPromotePolicy } from "./gitPromotePolicy.js";
import { resolveEffectivePromoteEndpoint } from "./gitPromotePolicy.js";

/**
 * Canonical promotion primitive.
 *
 * Intended flow (documented semantics, no new orchestration framework):
 *   1. resolve exact current canonical remote-main SHA;
 *   2. create an integration branch/worktree from exactly that SHA;
 *   3. incorporate the accepted candidate there with the normal Git
 *      operation appropriate to its ancestry (merge / fast-forward);
 *   4. resolve conflicts only in the integration lane;
 *   5. run qualification there;
 *   6. freeze the resulting exact integration SHA;
 *   7. call `git_promote` with source = frozen SHA and
 *      expected_remote_head = the exact SHA the lane was based on,
 *      unless canonical state was deliberately refreshed/requalified;
 *   8. verify remote main equals the frozen SHA;
 *   9. only then retire integration/worker branches as policy permits.
 *
 * No step requires a checked-out local `main`. Local `refs/heads/main` may
 * be refreshed to mirror canonical state after successful promotion
 * (ordinary `git fetch <remote> <branch>:<branch>` from the integration
 * worktree), but that is bookkeeping only.
 *
 * This operation performs exactly one remote CAS ref update and never
 * merges, rebases, cherry-picks, or forces. Ordinary branch publication
 * remains owned by `git_push`; promotion requires separate explicit
 * promotion authority and never infers it from push permission.
 */

export interface GitPromoteRequest {
  readonly workspace_id: string;
  readonly remote: string;
  readonly branch: string;
  readonly source_commit: string;
  readonly expected_remote_head: string;
}

export type GitPromoteFailureReason = "cas-stale" | "mutation-failed" | "mutation-uncertain" | "postcondition";

const FAILURE_MESSAGES: Record<GitPromoteFailureReason, string> = {
  "cas-stale": "Git promote compare-and-swap was stale; the canonical branch changed before promotion.",
  "mutation-failed": "Git promote mutation failed; the canonical branch was not confirmed as updated.",
  "mutation-uncertain": "Git promote mutation outcome could not be confirmed.",
  postcondition: "Git promote completed without a matching canonical branch postcondition."
};

/** Constant-message mutation failure; Git/auth output is never exposed. */
export class GitPromoteError extends CodexProError {
  constructor(
    readonly reason: GitPromoteFailureReason,
    readonly facts: {
      readonly workspace_id: string;
      readonly root: string;
      readonly remote: string;
      readonly branch: string;
      readonly source_commit: string;
      readonly expected_remote_head: string;
      readonly remote_head?: string;
    }
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitPromoteError";
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      ...this.facts
    };
  }
}

export type GitPromotePreflightFailureReason =
  | "invalid-input"
  | "mode"
  | "write-mode"
  | "workspace"
  | "repository"
  | "in-progress"
  | "invalid-head"
  | "missing-source-object"
  | "source-not-commit"
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
  | "non-fast-forward"
  | "malformed-output"
  | "execution";

const PREFLIGHT_FAILURE_MESSAGES: Record<GitPromotePreflightFailureReason, string> = {
  "invalid-input": "Git promote input is invalid.",
  mode: "Git promote requires full tool mode.",
  "write-mode": "Git promote requires workspace write mode.",
  workspace: "Git promote workspace identity is invalid.",
  repository: "Git promote requires the exact root of a non-bare Git worktree.",
  "in-progress": "Git promote is unavailable during an in-progress history operation.",
  "invalid-head": "Git promote heads are not full object-format SHAs.",
  "missing-source-object": "Git promote source commit is not available as a local object.",
  "source-not-commit": "Git promote source is not a local commit object.",
  "policy-disabled": "Git promote policy is disabled.",
  "invalid-policy": "Git promote policy is invalid.",
  "invalid-remote-or-branch": "Git promote remote or branch is invalid.",
  "remote-or-branch-not-allowlisted": "Git promote remote and branch are not allowlisted for canonical promotion.",
  "ambiguous-policy-rule": "Git promote policy has an ambiguous remote and branch rule.",
  "effective-endpoint-not-allowlisted": "Git promote effective endpoint is not allowlisted.",
  "effective-endpoint-unavailable": "Git promote effective endpoint could not be observed.",
  "zero-effective-push-endpoints": "Git promote remote has no effective push endpoint.",
  "ambiguous-multiple-effective-push-endpoints": "Git promote remote has ambiguous effective push endpoints.",
  "credential-bearing-endpoint": "Git promote remote endpoint is not credential-safe.",
  "disallowed-remote-helper": "Git promote remote helper is not allowed.",
  "disallowed-file-endpoint": "Git promote file endpoint is not allowed.",
  "disallowed-endpoint-scheme": "Git promote endpoint scheme is not allowed.",
  "invalid-endpoint": "Git promote endpoint is invalid.",
  "disallowed-local-or-helper-endpoint": "Git promote local or helper endpoint is not allowed.",
  "disallowed-local-endpoint": "Git promote local endpoint is not allowed.",
  "non-default-receive-pack": "Git promote configured receive-pack is not the default.",
  "config-source-discovery": "Git promote configuration sources could not be safely enumerated.",
  "dynamic-config-source": "Git promote configuration includes an unsupported dynamic source.",
  "remote-absent": "Git promote canonical branch does not exist.",
  "remote-ambiguous": "Git promote canonical branch observation was ambiguous.",
  "remote-head-mismatch": "Git promote canonical branch does not match expected_remote_head.",
  "remote-malformed": "Git promote canonical branch observation was malformed.",
  "non-fast-forward": "Git promote source history is not a descendant of expected_remote_head.",
  "malformed-output": "Git promote returned malformed preflight output.",
  execution: "Git promote preflight failed during local Git execution."
};

/** Constant-message, JSON-safe preflight failure. Git/auth output is never returned. */
export class GitPromotePreflightError extends CodexProError {
  constructor(
    readonly reason: GitPromotePreflightFailureReason,
    readonly policyReason?: string
  ) {
    super(PREFLIGHT_FAILURE_MESSAGES[reason]);
    this.name = "GitPromotePreflightError";
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

export interface GitPromotePreflight {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly git_dir: string;
  readonly config_path: string;
  readonly config_sources: readonly string[];
  readonly object_format: "sha1" | "sha256";
  readonly remote: string;
  readonly endpoint: string;
  readonly branch: string;
  readonly destination_ref: string;
  readonly source_commit: string;
  readonly expected_remote_head: string;
}

export type GitPromoteConfig = Pick<
  CodexProConfig,
  "maxGitTimeoutMs" | "maxOutputBytes" | "toolMode" | "writeMode" | "gitPushPolicy" | "gitPromotePolicy"
>;

export interface GitPromoteResult {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly remote: string;
  readonly branch: string;
  readonly destination_ref: string;
  readonly source_commit: string;
  readonly expected_remote_head: string;
  readonly remote_head: string;
  readonly push_attempts: 1;
}

/** Fixed controls prevent ambient push behaviors while retaining hooks/auth. */
export const GIT_PROMOTE_FIXED_OPTIONS = Object.freeze([
  "--receive-pack=git-receive-pack",
  "--no-follow-tags",
  "--no-force-if-includes",
  "--no-signed",
  "--recurse-submodules=no",
  "--no-push-option",
  "--no-thin",
  "--no-atomic",
  "--no-all",
  "--no-tags",
  "--no-mirror",
  "--no-delete",
  "--no-prune",
  "--no-set-upstream"
] as const);

const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/u;
const GLOB_TOKEN = /[*?\[\]]/u;
const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{24}$/u;
const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const MAX_WORKSPACE_ID_BYTES = 128;
const MAX_REMOTE_BYTES = 256;
const MAX_BRANCH_BYTES = 256;
const MAX_HEAD_BYTES = 64;

function failPreflight(reason: GitPromotePreflightFailureReason, policyReason?: string): never {
  throw new GitPromotePreflightError(reason, policyReason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && Buffer.byteLength(value, "utf8") <= maxBytes && !CONTROL_OR_WHITESPACE.test(value);
}

function validateRemote(value: unknown): string {
  if (!validBoundedString(value, MAX_REMOTE_BYTES) || (value as string).startsWith("-") || GLOB_TOKEN.test(value as string) || (value as string).includes("::")) {
    return failPreflight("invalid-remote-or-branch");
  }
  return value as string;
}

function validateBranch(value: unknown): string {
  if (!validBoundedString(value, MAX_BRANCH_BYTES)) return failPreflight("invalid-remote-or-branch");
  const branch = value as string;
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
    return failPreflight("invalid-remote-or-branch");
  }
  return branch;
}

function validateHead(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || Buffer.byteLength(value, "utf8") > MAX_HEAD_BYTES || !FULL_OBJECT_ID_PATTERN.test(value)) {
    return failPreflight("invalid-head");
  }
  return value.toLowerCase();
}

/** Strict internal request validator; the public wrapper owns its own schema surface. */
export function validateGitPromoteRequest(raw: unknown): GitPromoteRequest {
  if (!isRecord(raw)) return failPreflight("invalid-input");
  const keys = Object.keys(raw);
  const allowed = new Set(["workspace_id", "remote", "branch", "source_commit", "expected_remote_head"]);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) return failPreflight("invalid-input");

  const workspaceId = raw.workspace_id;
  if (
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    Buffer.byteLength(workspaceId, "utf8") > MAX_WORKSPACE_ID_BYTES ||
    workspaceId.trim() !== workspaceId ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    return failPreflight("invalid-input");
  }

  return {
    workspace_id: workspaceId,
    remote: validateRemote(raw.remote),
    branch: validateBranch(raw.branch),
    source_commit: validateHead(raw.source_commit),
    expected_remote_head: validateHead(raw.expected_remote_head)
  };
}

function policyFailureReason(reason: string | undefined): GitPromotePreflightFailureReason {
  const known = new Set<GitPromotePreflightFailureReason>([
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
  return reason !== undefined && known.has(reason as GitPromotePreflightFailureReason)
    ? reason as GitPromotePreflightFailureReason
    : "invalid-policy";
}

async function runGitExitAware(
  config: GitPromoteConfig,
  workspace: Workspace,
  args: readonly string[]
): Promise<GitExecutionResult> {
  try {
    return await runGitMutation(config, workspace, args);
  } catch (error) {
    if (error instanceof GitExecutionError) return error.result;
    return failPreflight("execution");
  }
}

async function runGitChecked(
  config: GitPromoteConfig,
  workspace: Workspace,
  args: readonly string[]
): Promise<GitExecutionResult> {
  const result = await runGitExitAware(config, workspace, args);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return failPreflight("execution");
  }
  return result;
}

function oneLine(result: GitExecutionResult): string {
  const text = result.stdout;
  if (!text.endsWith("\n")) return failPreflight("malformed-output");
  const line = text.slice(0, -1);
  if (!line || line.includes("\n") || line.includes("\r")) return failPreflight("malformed-output");
  return line;
}

function objectIdPattern(objectFormat: "sha1" | "sha256"): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/iu : /^[0-9a-f]{64}$/iu;
}

function parseObjectId(value: string, objectFormat: "sha1" | "sha256"): string {
  const normalized = value.toLowerCase();
  if (!objectIdPattern(objectFormat).test(normalized)) return failPreflight("malformed-output");
  return normalized;
}

async function assertSourceCommit(
  config: GitPromoteConfig,
  workspace: Workspace,
  sourceCommit: string
): Promise<void> {
  const result = await runGitExitAware(config, workspace, ["cat-file", "-t", sourceCommit]);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return failPreflight("missing-source-object");
  }
  if (oneLine(result) !== "commit") return failPreflight("source-not-commit");
}

async function assertRemoteHead(
  config: GitPromoteConfig,
  workspace: Workspace,
  remote: string,
  destinationRef: string,
  objectFormat: "sha1" | "sha256",
  expectedRemoteHead: string
): Promise<void> {
  const observed = await observeGitPushRemoteHead(config, workspace, remote, destinationRef, objectFormat);
  if (observed.status === "absent") return failPreflight("remote-absent");
  if (observed.status === "ambiguous") return failPreflight("remote-ambiguous");
  if (observed.status === "malformed") return failPreflight("remote-malformed");
  if (observed.status === "execution") return failPreflight("execution");
  if (observed.status !== "head") return failPreflight("execution");
  if (observed.head !== expectedRemoteHead) return failPreflight("remote-head-mismatch");
}

/**
 * Validate one explicit workspace and exact source/remote promotion precondition.
 * This function never checks out the destination branch, never merges,
 * rebases, cherry-picks, or forces. It only observes.
 */
export async function preflightGitPromote(
  config: GitPromoteConfig,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitPromotePreflight> {
  const request = validateGitPromoteRequest(rawInput);
  if (config.toolMode !== "full") return failPreflight("mode");
  if (config.writeMode !== "workspace") return failPreflight("write-mode");
  if (typeof workspace.id !== "string" || workspace.id !== request.workspace_id || !WORKSPACE_ID_PATTERN.test(workspace.id)) {
    return failPreflight("workspace");
  }

  let repository: Awaited<ReturnType<typeof inspectGitPushRepository>>;
  try {
    repository = await inspectGitPushRepository(config, workspace);
  } catch {
    return failPreflight("repository");
  }
  if (
    request.source_commit.length !== (repository.objectFormat === "sha1" ? 40 : 64) ||
    request.expected_remote_head.length !== (repository.objectFormat === "sha1" ? 40 : 64)
  ) {
    return failPreflight("invalid-head");
  }

  // Deliberately no attached-branch check: promotion must NOT require the
  // current worktree to be attached to the canonical branch. The integration
  // lane stays attached to its own integration branch.
  try {
    await assertGitPushNoHistoryOperation(config, workspace);
  } catch {
    return failPreflight("in-progress");
  }

  let configSources: readonly string[];
  try {
    configSources = await discoverGitPushConfigSourcesForMutation(
      config,
      workspace,
      repository.configPath,
      repository.worktreeConfigPath
    );
  } catch (error) {
    if (error instanceof GitPromotePreflightError) throw error;
    return failPreflight("config-source-discovery");
  }

  const policy = evaluateGitPromotePolicy(repository.root, config.gitPromotePolicy, request.remote, request.branch);
  if (!policy.allowed) return failPreflight(policyFailureReason(policy.reason), policy.reason);
  if (!policy.endpoint) return failPreflight("invalid-policy", "missing-effective-endpoint");
  const effective = resolveEffectivePromoteEndpoint(repository.root, request.remote);
  if (!effective.ok) return failPreflight(policyFailureReason(effective.reason), effective.reason);
  if (effective.identity !== policy.endpoint) return failPreflight("effective-endpoint-not-allowlisted");

  // Source must be clean immutable history, not working-tree state.
  await assertSourceCommit(config, workspace, request.source_commit);
  // Expected head must also be a local commit so ancestry can be proven
  // without network mutation.
  {
    const expectedType = await runGitExitAware(config, workspace, ["cat-file", "-t", request.expected_remote_head]);
    if (expectedType.exitCode !== 0 || expectedType.signal !== null || expectedType.timedOut || expectedType.stdoutOverflow || expectedType.stderrOverflow) {
      return failPreflight("missing-source-object");
    }
    if (oneLine(expectedType) !== "commit") return failPreflight("source-not-commit");
  }

  // Fast-forward only: expected must be an ancestor of source.
  {
    const ancestry = await runGitExitAware(config, workspace, ["merge-base", "--is-ancestor", request.expected_remote_head, request.source_commit]);
    if (ancestry.exitCode === 1 && ancestry.signal === null && !ancestry.timedOut && !ancestry.stdoutOverflow && !ancestry.stderrOverflow) {
      return failPreflight("non-fast-forward");
    }
    if (ancestry.exitCode !== 0 || ancestry.signal !== null || ancestry.timedOut || ancestry.stdoutOverflow || ancestry.stderrOverflow) {
      return failPreflight("execution");
    }
  }

  try {
    await assertGitPushDefaultReceivePack(config, workspace, request.remote);
  } catch {
    return failPreflight("non-default-receive-pack");
  }
  await assertRemoteHead(config, workspace, request.remote, `refs/heads/${request.branch}`, repository.objectFormat, request.expected_remote_head);

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
    destination_ref: `refs/heads/${request.branch}`,
    source_commit: request.source_commit.toLowerCase(),
    expected_remote_head: request.expected_remote_head.toLowerCase()
  });
}

/**
 * Re-run the complete immutable preflight immediately before mutation. This
 * closes the mutable local/policy/remote observation window without changing
 * the accepted one-shot CAS contract.
 */
export async function revalidateGitPromotePreflight(
  config: GitPromoteConfig,
  workspace: Workspace,
  initial: GitPromotePreflight
): Promise<{ readonly preflight: GitPromotePreflight }> {
  const refreshed = await preflightGitPromote(config, workspace, {
    workspace_id: initial.workspace_id,
    remote: initial.remote,
    branch: initial.branch,
    source_commit: initial.source_commit,
    expected_remote_head: initial.expected_remote_head
  });
  if (refreshed.endpoint !== initial.endpoint) return failPreflight("effective-endpoint-not-allowlisted");
  const effective = resolveEffectivePromoteEndpoint(refreshed.root, refreshed.remote);
  if (!effective.ok || effective.identity !== refreshed.endpoint || effective.identity !== initial.endpoint) {
    return failPreflight("effective-endpoint-not-allowlisted");
  }
  return Object.freeze({ preflight: refreshed });
}

/**
 * Construct the only permitted canonical update. The caller cannot provide any
 * part of the lease, source, destination, refspec, URL, or push options.
 * No force, no merge/rebase/cherry-pick is representable here.
 */
export function buildGitPromoteArgs(preflight: GitPromotePreflight): readonly string[] {
  const destination = `refs/heads/${preflight.branch}`;
  if (preflight.destination_ref !== destination) {
    throw new GitPromoteError("postcondition", {
      workspace_id: preflight.workspace_id,
      root: preflight.root,
      remote: preflight.remote,
      branch: preflight.branch,
      source_commit: preflight.source_commit,
      expected_remote_head: preflight.expected_remote_head
    });
  }
  const lease = `--force-with-lease=${destination}:${preflight.expected_remote_head}`;
  const refspec = `${preflight.source_commit}:${destination}`;
  return Object.freeze([
    ...GIT_PROMOTE_FIXED_OPTIONS,
    lease,
    "--",
    preflight.remote,
    refspec
  ]);
}

function pushFacts(preflight: GitPromotePreflight, remoteHead?: string) {
  return {
    workspace_id: preflight.workspace_id,
    root: preflight.root,
    remote: preflight.remote,
    branch: preflight.branch,
    source_commit: preflight.source_commit,
    expected_remote_head: preflight.expected_remote_head,
    ...(remoteHead === undefined ? {} : { remote_head: remoteHead })
  } as const;
}

function failPromote(preflight: GitPromotePreflight, reason: GitPromoteFailureReason, remoteHead?: string): never {
  throw new GitPromoteError(reason, pushFacts(preflight, remoteHead));
}

function sameConfigSourceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (sourcePath: string): string => process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
  const expected = new Set(left.map(normalize));
  return right.every((sourcePath) => expected.has(normalize(sourcePath)));
}

async function withPromoteConfigLock<T>(preflight: GitPromotePreflight, action: (locks: readonly GitPushConfigLock[]) => Promise<T>): Promise<T> {
  try {
    return await withGitPushConfigLocks(preflight.config_sources, action);
  } catch (error) {
    if (error instanceof GitPushConfigLockError) return failPromote(preflight, "mutation-failed");
    throw error;
  }
}

async function executePromote(
  config: GitPromoteConfig,
  workspace: Workspace,
  args: readonly string[]
): Promise<{ readonly result?: GitExecutionResult; readonly failed: boolean }> {
  try {
    const result = await runGitMutation(config, workspace, ["push", ...args], {
      clearPushOptions: true
    });
    return {
      result,
      failed: false
    };
  } catch (error) {
    if (error instanceof GitExecutionError) {
      return { result: error.result, failed: true };
    }
    return { failed: true };
  }
}

async function observeAfterPromote(
  config: GitPromoteConfig,
  workspace: Workspace,
  preflight: GitPromotePreflight
): Promise<GitPushRemoteObservation> {
  return observeGitPushRemoteHead(
    config,
    workspace,
    preflight.remote,
    preflight.destination_ref,
    preflight.object_format
  );
}

async function postRouteMatchesPolicy(
  config: GitPromoteConfig,
  workspace: Workspace,
  preflight: GitPromotePreflight
): Promise<boolean> {
  try {
    const policy = evaluateGitPromotePolicy(preflight.root, config.gitPromotePolicy, preflight.remote, preflight.branch);
    if (!policy.allowed || policy.endpoint !== preflight.endpoint) return false;
    const effective = resolveEffectivePromoteEndpoint(preflight.root, preflight.remote);
    return effective.ok === true && effective.identity === preflight.endpoint;
  } catch {
    return false;
  }
}

/**
 * Promote one already-qualified local integration commit to the configured
 * canonical remote branch without checking that branch out. There is no
 * retry, fetch, pull, merge, rebase, cherry-pick, or caller-controlled Git
 * mutation input in this path.
 */
export async function gitPromote(
  config: GitPromoteConfig,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitPromoteResult> {
  const initial = await preflightGitPromote(config, workspace, rawInput);
  return withPromoteConfigLock(initial, async (locks) => {
    const { preflight } = await revalidateGitPromotePreflight(config, workspace, initial);
    if (!sameConfigSourceSet(initial.config_sources, preflight.config_sources) || !(await configSourcesCovered(preflight.config_sources, locks))) {
      return failPromote(initial, "mutation-failed");
    }
    const args = buildGitPromoteArgs(preflight);
    const execution = await executePromote(config, workspace, args);
    const postRouteValid = await postRouteMatchesPolicy(config, workspace, preflight);
    const observed = postRouteValid
      ? await observeAfterPromote(config, workspace, preflight)
      : { status: "execution" as const };

    if (execution.failed || execution.result?.exitCode !== 0 || execution.result?.signal !== null || execution.result?.timedOut || execution.result?.stdoutOverflow || execution.result?.stderrOverflow) {
      if (!postRouteValid) return failPromote(preflight, "mutation-failed");
      if (observed.status === "head") {
        if (observed.head === preflight.expected_remote_head) {
          return failPromote(preflight, "mutation-failed", observed.head);
        }
        if (observed.head === preflight.source_commit) {
          return failPromote(preflight, "mutation-uncertain", observed.head);
        }
        return failPromote(preflight, "cas-stale", observed.head);
      }
      if (observed.status === "absent") {
        return failPromote(preflight, "cas-stale");
      }
      return failPromote(preflight, "mutation-failed");
    }

    if (!postRouteValid) return failPromote(preflight, "postcondition");
    if (observed.status !== "head" || observed.head !== preflight.source_commit) {
      return failPromote(preflight, "postcondition", observed.status === "head" ? observed.head : undefined);
    }

    return Object.freeze({
      schema_version: 1 as const,
      workspace_id: preflight.workspace_id,
      root: preflight.root,
      remote: preflight.remote,
      branch: preflight.branch,
      destination_ref: preflight.destination_ref,
      source_commit: preflight.source_commit,
      expected_remote_head: preflight.expected_remote_head,
      remote_head: observed.head,
      push_attempts: 1 as const
    });
  });
}
