import { randomBytes } from "node:crypto";
import type { CodexProConfig } from "./config.js";
import { GitExecutionError, GitExecutionResult, runGitMutation } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import {
  assertGitPushDefaultReceivePack,
  assertGitPushNoHistoryOperation,
  discoverGitPushConfigSourcesForMutation,
  inspectGitPushRepository,
  observeGitPushRemoteHead,
  resolveGitPushMutationEndpointUrl,
  GitPushPreflightError,
  type GitPushPreflightConfig,
  type GitPushRemoteObservation
} from "./gitPushPreflight.js";
import { evaluateGitPushPolicy } from "./gitPushPolicy.js";
import { configSourcesCovered, GitPushConfigLockError, withGitPushConfigLocks, type GitPushConfigLock } from "./gitPushConfigLock.js";

const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const GLOB_TOKEN = /[*?\[\]]/u;
const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{24}$/u;
const FULL_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const FULL_SHA256_PATTERN = /^[0-9a-f]{64}$/iu;
const MAX_WORKSPACE_ID_BYTES = 128;
const MAX_REMOTE_BYTES = 256;
const MAX_BRANCH_BYTES = 256;
const MAX_HEAD_BYTES = 64;
const MAX_AUTHORITY_BYTES = 4_096;

const PROTECTED_EXACT_BRANCHES = new Set(["main", "master", "develop", "trunk", "head"]);
const PROTECTED_BRANCH_PREFIXES = Object.freeze(["main/", "master/", "develop/", "trunk/", "head/", "refs/"]);

export type GitRetirePreservationRoute =
  | {
      readonly type: "published";
      readonly remote: string;
      readonly branch: string;
      readonly expected_head: string;
    }
  | {
      readonly type: "integrated";
      readonly remote: string;
      readonly branch: string;
      readonly expected_head: string;
      readonly integration_mode: "FAST_FORWARD" | "COMMIT_PRESERVING_MERGE";
    };

export interface GitRetirePreservation {
  readonly accepted_candidate: string;
  readonly acceptance_authority: string;
  readonly evidence_sha256: string;
  readonly route: GitRetirePreservationRoute;
}

export interface GitRetireRemoteBranchRequest {
  readonly workspace_id: string;
  readonly remote: string;
  readonly branch: string;
  readonly expected_remote_head: string;
  readonly preservation: GitRetirePreservation;
}

export type GitRetireFailureReason =
  | "cas-stale"
  | "mutation-failed"
  | "mutation-uncertain"
  | "postcondition";

const FAILURE_MESSAGES: Record<GitRetireFailureReason, string> = {
  "cas-stale": "Git remote branch retirement compare-and-swap was stale; the target branch changed before mutation.",
  "mutation-failed": "Git remote branch retirement mutation failed; the target branch was not confirmed as retired.",
  "mutation-uncertain": "Git remote branch retirement outcome could not be confirmed.",
  postcondition: "Git remote branch retirement completed without matching target and preservation postconditions."
};

/** Constant-message mutation failure; Git/auth output is never exposed. */
export class GitRetireRemoteBranchError extends CodexProError {
  constructor(
    readonly reason: GitRetireFailureReason,
    readonly facts: {
      readonly workspace_id: string;
      readonly root: string;
      readonly remote: string;
      readonly branch: string;
      readonly expected_remote_head: string;
      readonly remote_head?: string;
    }
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitRetireRemoteBranchError";
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

export type GitRetirePreflightFailureReason =
  | "invalid-input"
  | "mode"
  | "write-mode"
  | "workspace"
  | "repository"
  | "config-source"
  | "in-progress"
  | "invalid-head"
  | "invalid-remote-or-branch"
  | "invalid-receipt"
  | "protected-target"
  | "policy-disabled"
  | "invalid-policy"
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
  | "target-absent"
  | "target-observation"
  | "target-head-mismatch"
  | "preservation-remote-mismatch"
  | "preservation-same-target"
  | "preservation-target-invalid"
  | "preservation-missing"
  | "preservation-changed"
  | "preservation-not-ancestor"
  | "non-default-receive-pack"
  | "execution";

const PREFLIGHT_FAILURE_MESSAGES: Record<GitRetirePreflightFailureReason, string> = {
  "invalid-input": "Git remote branch retirement request is invalid.",
  mode: "Git remote branch retirement requires full tool mode.",
  "write-mode": "Git remote branch retirement requires workspace write mode.",
  workspace: "Git remote branch retirement workspace identity is invalid.",
  repository: "Git remote branch retirement requires the exact root of a non-bare Git worktree.",
  "config-source": "Git remote branch retirement configuration sources could not be safely enumerated.",
  "in-progress": "Git remote branch retirement is unavailable during an in-progress history operation.",
  "invalid-head": "Git remote branch retirement heads are not full object-format SHAs.",
  "invalid-remote-or-branch": "Git remote branch retirement remote or branch is invalid.",
  "invalid-receipt": "Git remote branch retirement requires a complete explicit preservation receipt.",
  "protected-target": "Git remote branch retirement cannot target a canonical or protected branch.",
  "policy-disabled": "Git remote branch retirement policy is disabled.",
  "invalid-policy": "Git remote branch retirement policy is invalid.",
  "remote-or-branch-not-allowlisted": "Git remote branch retirement target is not allowlisted.",
  "ambiguous-policy-rule": "Git remote branch retirement policy has an ambiguous target rule.",
  "effective-endpoint-not-allowlisted": "Git remote branch retirement endpoint is not allowlisted.",
  "effective-endpoint-unavailable": "Git remote branch retirement endpoint could not be observed.",
  "zero-effective-push-endpoints": "Git remote branch retirement remote has no effective endpoint.",
  "ambiguous-multiple-effective-push-endpoints": "Git remote branch retirement remote has ambiguous effective endpoints.",
  "credential-bearing-endpoint": "Git remote branch retirement remote endpoint is not credential-safe.",
  "disallowed-remote-helper": "Git remote branch retirement remote helper is not allowed.",
  "disallowed-file-endpoint": "Git remote branch retirement file endpoint is not allowed.",
  "disallowed-endpoint-scheme": "Git remote branch retirement endpoint scheme is not allowed.",
  "invalid-endpoint": "Git remote branch retirement endpoint is invalid.",
  "disallowed-local-or-helper-endpoint": "Git remote branch retirement local or helper endpoint is not allowed.",
  "disallowed-local-endpoint": "Git remote branch retirement local endpoint is not allowed.",
  "target-absent": "Git remote branch retirement target branch is absent.",
  "target-observation": "Git remote branch retirement target observation was not trustworthy.",
  "target-head-mismatch": "Git remote branch retirement target branch does not match expected_remote_head.",
  "preservation-remote-mismatch": "Git remote branch retirement preservation must use the same named remote.",
  "preservation-same-target": "Git remote branch retirement preservation must not equal the target ref.",
  "preservation-target-invalid": "Git remote branch retirement preservation target is invalid for its route.",
  "preservation-missing": "Git remote branch retirement preservation was not observed at the expected head.",
  "preservation-changed": "Git remote branch retirement preservation changed from its accepted head.",
  "preservation-not-ancestor": "Git remote branch retirement accepted candidate is not preserved in canonical history.",
  "non-default-receive-pack": "Git remote branch retirement requires Git's default receive-pack route.",
  execution: "Git remote branch retirement preflight failed during local Git execution."
};

/** Constant-message preflight failure; caller receipt text is never echoed. */
export class GitRetireRemoteBranchPreflightError extends CodexProError {
  constructor(
    readonly reason: GitRetirePreflightFailureReason,
    readonly policyReason?: string
  ) {
    super(PREFLIGHT_FAILURE_MESSAGES[reason]);
    this.name = "GitRetireRemoteBranchPreflightError";
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

export type GitRetireRemoteBranchConfig = Pick<
  CodexProConfig,
  "maxGitTimeoutMs" | "maxOutputBytes" | "toolMode" | "writeMode" | "gitPushPolicy"
>;

export interface GitRetireRemoteBranchResult {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly remote: string;
  readonly branch: string;
  readonly destination_ref: string;
  readonly expected_remote_head: string;
  readonly remote_head: "absent";
  readonly accepted_candidate: string;
  readonly acceptance_authority: string;
  readonly evidence_sha256: string;
  readonly preservation: GitRetirePreservation;
  readonly push_attempts: 1;
  readonly status: "retired";
}

interface GitRetireRemoteBranchPreflight {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly git_dir: string;
  readonly config_path: string;
  readonly config_sources: readonly string[];
  readonly object_format: "sha1" | "sha256";
  readonly remote: string;
  readonly endpoint: string;
  /** Exact policy-validated push URL used for the native deletion attempt. */
  readonly mutation_endpoint: string;
  /** Raw configured URL reproduced in an ephemeral command-line remote. */
  readonly configured_endpoint: string;
  /** Per-call command-line remote name; never persisted in the workspace. */
  readonly mutation_remote: string;
  readonly branch: string;
  readonly destination_ref: string;
  readonly expected_remote_head: string;
  readonly preservation: GitRetirePreservation;
}

function failPreflight(reason: GitRetirePreflightFailureReason, policyReason?: string): never {
  throw new GitRetireRemoteBranchPreflightError(reason, policyReason);
}

function newMutationRemoteName(): string {
  return `__codexpro_retire_${randomBytes(16).toString("hex")}`;
}

function mutationRemoteGlobalArgs(
  mutationRemote: string,
  configuredEndpoint: string,
  effectiveEndpoint: string
): readonly string[] {
  // `git ls-remote` follows `insteadOf`, while `git push` may follow
  // `pushInsteadOf`. Reproduce the already policy-validated push route for
  // both operations on the ephemeral remote. The mapping is omitted when the
  // configured spelling is already the observed effective endpoint, avoiding
  // a self-rewrite. Git applies one rewrite step, so a configured alias is
  // not accidentally fed through a second local rewrite chain.
  return Object.freeze([
    "-c",
    `remote.${mutationRemote}.url=${configuredEndpoint}`,
    ...(configuredEndpoint === effectiveEndpoint
      ? []
      : ["-c", `url.${effectiveEndpoint}.insteadOf=${configuredEndpoint}`])
  ]);
}

function failRetirement(
  preflight: GitRetireRemoteBranchPreflight,
  reason: GitRetireFailureReason,
  remoteHead?: string
): never {
  throw new GitRetireRemoteBranchError(reason, {
    workspace_id: preflight.workspace_id,
    root: preflight.root,
    remote: preflight.remote,
    branch: preflight.branch,
    expected_remote_head: preflight.expected_remote_head,
    ...(remoteHead === undefined ? {} : { remote_head: remoteHead })
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBoundedString(value: unknown, maxBytes: number, allowInternalWhitespace = false): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !CONTROL_CHARACTERS.test(value)
    && (allowInternalWhitespace || !CONTROL_OR_WHITESPACE.test(value));
}

function validateRemote(value: unknown): string {
  if (!validBoundedString(value, MAX_REMOTE_BYTES) || value.startsWith("-") || GLOB_TOKEN.test(value) || value.includes("::")) {
    return failPreflight("invalid-remote-or-branch");
  }
  return value;
}

function validateBranch(value: unknown): string {
  if (!validBoundedString(value, MAX_BRANCH_BYTES)) return failPreflight("invalid-remote-or-branch");
  const branch = value;
  const components = branch.split("/");
  if (
    branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.endsWith(".lock")
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || branch.includes("~")
    || branch.includes("^")
    || branch.includes(":")
    || branch.includes("\\")
    || branch === "@"
    || branch === "."
    || branch === ".."
    || GLOB_TOKEN.test(branch)
    || components.some((component) => component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"))
  ) {
    return failPreflight("invalid-remote-or-branch");
  }
  return branch;
}

function validateObjectId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || Buffer.byteLength(value, "utf8") > MAX_HEAD_BYTES
    || !FULL_OBJECT_ID_PATTERN.test(value)
  ) {
    return failPreflight("invalid-head");
  }
  return value.toLowerCase();
}

function validateEvidenceDigest(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !FULL_SHA256_PATTERN.test(value)) {
    return failPreflight("invalid-receipt");
  }
  return value.toLowerCase();
}

function validateAuthority(value: unknown): string {
  if (!validBoundedString(value, MAX_AUTHORITY_BYTES, true)) return failPreflight("invalid-receipt");
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function protectedBranch(value: string): boolean {
  const lowered = value.toLowerCase();
  return PROTECTED_EXACT_BRANCHES.has(lowered) || PROTECTED_BRANCH_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function parsePreservationRoute(value: unknown): GitRetirePreservationRoute {
  if (!isRecord(value) || typeof value.type !== "string") return failPreflight("invalid-receipt");
  if (value.type === "published") {
    if (!exactKeys(value, ["type", "remote", "branch", "expected_head"])) return failPreflight("invalid-receipt");
    return Object.freeze({
      type: "published" as const,
      remote: validateRemote(value.remote),
      branch: validateBranch(value.branch),
      expected_head: validateObjectId(value.expected_head)
    });
  }
  if (value.type === "integrated") {
    if (!exactKeys(value, ["type", "remote", "branch", "expected_head", "integration_mode"])) return failPreflight("invalid-receipt");
    if (value.integration_mode !== "FAST_FORWARD" && value.integration_mode !== "COMMIT_PRESERVING_MERGE") {
      return failPreflight("invalid-receipt");
    }
    return Object.freeze({
      type: "integrated" as const,
      remote: validateRemote(value.remote),
      branch: validateBranch(value.branch),
      expected_head: validateObjectId(value.expected_head),
      integration_mode: value.integration_mode
    });
  }
  return failPreflight("invalid-receipt");
}

function parseRequest(rawInput: unknown): GitRetireRemoteBranchRequest {
  if (!isRecord(rawInput) || !exactKeys(rawInput, ["workspace_id", "remote", "branch", "expected_remote_head", "preservation"])) {
    return failPreflight("invalid-input");
  }
  if (
    typeof rawInput.workspace_id !== "string"
    || rawInput.workspace_id.length === 0
    || rawInput.workspace_id.trim() !== rawInput.workspace_id
    || Buffer.byteLength(rawInput.workspace_id, "utf8") > MAX_WORKSPACE_ID_BYTES
    || !WORKSPACE_ID_PATTERN.test(rawInput.workspace_id)
  ) {
    return failPreflight("invalid-input");
  }
  if (!isRecord(rawInput.preservation) || !exactKeys(rawInput.preservation, ["accepted_candidate", "acceptance_authority", "evidence_sha256", "route"])) {
    return failPreflight("invalid-receipt");
  }
  const preservation = rawInput.preservation;
  return Object.freeze({
    workspace_id: rawInput.workspace_id,
    remote: validateRemote(rawInput.remote),
    branch: validateBranch(rawInput.branch),
    expected_remote_head: validateObjectId(rawInput.expected_remote_head),
    preservation: Object.freeze({
      accepted_candidate: validateObjectId(preservation.accepted_candidate),
      acceptance_authority: validateAuthority(preservation.acceptance_authority),
      evidence_sha256: validateEvidenceDigest(preservation.evidence_sha256),
      route: parsePreservationRoute(preservation.route)
    })
  });
}

function objectIdLength(objectFormat: "sha1" | "sha256"): number {
  return objectFormat === "sha1" ? 40 : 64;
}

function assertObjectFormat(value: string, objectFormat: "sha1" | "sha256"): void {
  if (value.length !== objectIdLength(objectFormat)) return failPreflight("invalid-head");
}

function policyFailureReason(reason: string | undefined): GitRetirePreflightFailureReason {
  const known = new Set<GitRetirePreflightFailureReason>([
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
  return reason !== undefined && known.has(reason as GitRetirePreflightFailureReason)
    ? reason as GitRetirePreflightFailureReason
    : "invalid-policy";
}

function observationFailure(observation: GitPushRemoteObservation): GitRetirePreflightFailureReason {
  if (observation.status === "absent") return "preservation-missing";
  if (observation.status === "head") return "preservation-changed";
  return "target-observation";
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
    return new GitExecutionResult(Buffer.alloc(0), Buffer.alloc(0), null, null, false, false, false);
  }
}

function oneLine(result: GitExecutionResult): string | undefined {
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) return undefined;
  const text = result.copyStdoutBytes().toString("utf8");
  if (!text.endsWith("\n")) return undefined;
  const line = text.slice(0, -1);
  return line && !line.includes("\n") && !line.includes("\r") ? line : undefined;
}

async function assertLocalCommitObject(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  objectId: string
): Promise<void> {
  const result = await runGitExitAware(config, workspace, ["cat-file", "-t", objectId]);
  if (oneLine(result) !== "commit") return failPreflight("preservation-not-ancestor");
}

async function assertCandidateAncestry(
  config: GitPushPreflightConfig,
  workspace: Workspace,
  candidate: string,
  canonicalHead: string
): Promise<void> {
  await assertLocalCommitObject(config, workspace, candidate);
  await assertLocalCommitObject(config, workspace, canonicalHead);
  const result = await runGitExitAware(config, workspace, ["merge-base", "--is-ancestor", candidate, canonicalHead]);
  if (result.exitCode === 1 && result.signal === null && !result.timedOut && !result.stdoutOverflow && !result.stderrOverflow) {
    return failPreflight("preservation-not-ancestor");
  }
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.stdoutOverflow || result.stderrOverflow) {
    return failPreflight("execution");
  }
}

async function assertPreservation(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  request: GitRetireRemoteBranchRequest,
  objectFormat: "sha1" | "sha256",
  mutationRemote: string,
  mutationGlobalArgs: readonly string[]
): Promise<void> {
  const route = request.preservation.route;
  if (route.remote !== request.remote) return failPreflight("preservation-remote-mismatch");
  if (route.branch === request.branch) return failPreflight("preservation-same-target");
  if (request.preservation.accepted_candidate !== request.expected_remote_head) return failPreflight("invalid-receipt");
  assertObjectFormat(request.expected_remote_head, objectFormat);
  assertObjectFormat(request.preservation.accepted_candidate, objectFormat);
  assertObjectFormat(route.expected_head, objectFormat);

  if (route.type === "published") {
    if (protectedBranch(route.branch) || route.expected_head !== request.preservation.accepted_candidate) {
      return failPreflight("preservation-target-invalid");
    }
  } else if (route.branch.toLowerCase().startsWith("refs/") || !protectedBranch(route.branch)) {
    return failPreflight("preservation-target-invalid");
  }

  let observed: GitPushRemoteObservation;
  try {
    observed = await observeGitPushRemoteHead(
      config,
      workspace,
      mutationRemote,
      `refs/heads/${route.branch}`,
      objectFormat,
      { globalArgs: mutationGlobalArgs }
    );
  } catch {
    return failPreflight("execution");
  }
  if (observed.status !== "head") return failPreflight(observationFailure(observed));
  if (observed.head !== route.expected_head) return failPreflight("preservation-changed");
  if (route.type === "integrated") {
    await assertCandidateAncestry(config, workspace, request.preservation.accepted_candidate, route.expected_head);
  }
}

async function preflightRetirement(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  rawInput: unknown,
  mutationRemote: string
): Promise<GitRetireRemoteBranchPreflight> {
  const request = parseRequest(rawInput);
  if (config.toolMode !== "full") return failPreflight("mode");
  if (config.writeMode !== "workspace") return failPreflight("write-mode");
  if (
    typeof workspace.id !== "string"
    || workspace.id !== request.workspace_id
    || !WORKSPACE_ID_PATTERN.test(workspace.id)
  ) return failPreflight("workspace");

  if (protectedBranch(request.branch)) return failPreflight("protected-target");

  let repository: Awaited<ReturnType<typeof inspectGitPushRepository>>;
  try {
    repository = await inspectGitPushRepository(config, workspace);
  } catch {
    return failPreflight("repository");
  }
  assertObjectFormat(request.expected_remote_head, repository.objectFormat);
  assertObjectFormat(request.preservation.accepted_candidate, repository.objectFormat);
  assertObjectFormat(request.preservation.route.expected_head, repository.objectFormat);

  let configSources: readonly string[];
  try {
    configSources = await discoverGitPushConfigSourcesForMutation(
      config,
      workspace,
      repository.configPath,
      repository.worktreeConfigPath
    );
  } catch {
    return failPreflight("config-source");
  }
  try {
    await assertGitPushNoHistoryOperation(config, workspace);
  } catch {
    return failPreflight("in-progress");
  }
  let policy: ReturnType<typeof evaluateGitPushPolicy>;
  try {
    policy = evaluateGitPushPolicy(repository.root, config.gitPushPolicy, request.remote, request.branch);
  } catch {
    return failPreflight("invalid-policy");
  }
  if (!policy.allowed) return failPreflight(policyFailureReason(policy.reason), policy.reason);
  if (!policy.endpoint) return failPreflight("invalid-policy", "missing-effective-endpoint");
  let mutationEndpoint: {
    readonly endpoint: string;
    readonly identity: string;
    readonly configured_endpoint: string;
  };
  try {
    mutationEndpoint = await resolveGitPushMutationEndpointUrl(config, workspace, request.remote, policy.endpoint);
    if (mutationEndpoint.identity !== policy.endpoint) return failPreflight("effective-endpoint-not-allowlisted");
  } catch (error) {
    if (error instanceof GitPushPreflightError) {
      return failPreflight(policyFailureReason(error.reason), error.reason);
    }
    return failPreflight("effective-endpoint-not-allowlisted");
  }

  const mutationGlobalArgs = mutationRemoteGlobalArgs(
    mutationRemote,
    mutationEndpoint.configured_endpoint,
    mutationEndpoint.endpoint
  );
  try {
    await assertGitPushDefaultReceivePack(config, workspace, request.remote);
  } catch (error) {
    if (error instanceof GitPushPreflightError && error.reason === "non-default-receive-pack") {
      return failPreflight("non-default-receive-pack");
    }
    return failPreflight("execution");
  }

  await assertPreservation(config, workspace, request, repository.objectFormat, mutationRemote, mutationGlobalArgs);

  const targetObservation = await observeGitPushRemoteHead(
    config,
    workspace,
    mutationRemote,
    `refs/heads/${request.branch}`,
    repository.objectFormat,
    { globalArgs: mutationGlobalArgs }
  );
  if (targetObservation.status === "absent") return failPreflight("target-absent");
  if (targetObservation.status !== "head") return failPreflight("target-observation");
  if (targetObservation.head !== request.expected_remote_head) return failPreflight("target-head-mismatch");

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
    mutation_endpoint: mutationEndpoint.endpoint,
    configured_endpoint: mutationEndpoint.configured_endpoint,
    mutation_remote: mutationRemote,
    branch: request.branch,
    destination_ref: `refs/heads/${request.branch}`,
    expected_remote_head: request.expected_remote_head,
    preservation: request.preservation
  });
}

function sameConfigSourceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (sourcePath: string): string => process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
  const expected = new Set(left.map(normalize));
  return right.every((sourcePath) => expected.has(normalize(sourcePath)));
}

function samePreservation(left: GitRetirePreservation, right: GitRetirePreservation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function revalidateRetirement(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  initial: GitRetireRemoteBranchPreflight
): Promise<GitRetireRemoteBranchPreflight> {
  const refreshed = await preflightRetirement(config, workspace, {
    workspace_id: initial.workspace_id,
    remote: initial.remote,
    branch: initial.branch,
    expected_remote_head: initial.expected_remote_head,
    preservation: initial.preservation
  }, initial.mutation_remote);
  if (
    refreshed.root !== initial.root
    || refreshed.git_dir !== initial.git_dir
    || refreshed.config_path !== initial.config_path
    || refreshed.object_format !== initial.object_format
    || refreshed.remote !== initial.remote
    || refreshed.endpoint !== initial.endpoint
    || refreshed.mutation_endpoint !== initial.mutation_endpoint
    || refreshed.configured_endpoint !== initial.configured_endpoint
    || refreshed.mutation_remote !== initial.mutation_remote
    || refreshed.branch !== initial.branch
    || refreshed.destination_ref !== initial.destination_ref
    || refreshed.expected_remote_head !== initial.expected_remote_head
    || !samePreservation(refreshed.preservation, initial.preservation)
    || !sameConfigSourceSet(refreshed.config_sources, initial.config_sources)
  ) return failPreflight("execution");
  return refreshed;
}

/** Fixed controls retain hooks/auth while preventing caller-controlled routes. */
export const GIT_RETIRE_REMOTE_BRANCH_FIXED_OPTIONS = Object.freeze([
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
  "--no-prune",
  "--no-set-upstream"
] as const);

/** Construct only the internal exact-head deletion CAS. */
function buildGitRetireRemoteBranchArgsForRemote(
  preflight: Pick<GitRetireRemoteBranchPreflight, "branch" | "remote" | "expected_remote_head" | "destination_ref">,
  remoteArgument: string
): readonly string[] {
  validateBranch(preflight.branch);
  if (protectedBranch(preflight.branch)) return failPreflight("protected-target");
  validateRemote(remoteArgument);
  const destination = `refs/heads/${preflight.branch}`;
  if (preflight.destination_ref !== destination || !FULL_OBJECT_ID_PATTERN.test(preflight.expected_remote_head)) {
    return failPreflight("invalid-head");
  }
  return Object.freeze([
    ...GIT_RETIRE_REMOTE_BRANCH_FIXED_OPTIONS,
    `--force-with-lease=${destination}:${preflight.expected_remote_head}`,
    "--",
    remoteArgument,
    `:${destination}`
  ]);
}

/** Construct the inspected named-remote deletion arguments for unit tests. */
export function buildGitRetireRemoteBranchArgs(
  preflight: Pick<GitRetireRemoteBranchPreflight, "branch" | "remote" | "expected_remote_head" | "destination_ref">
): readonly string[] {
  return buildGitRetireRemoteBranchArgsForRemote(preflight, preflight.remote);
}

async function executeRetirement(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  preflight: GitRetireRemoteBranchPreflight
): Promise<{ readonly result?: GitExecutionResult; readonly failed: boolean }> {
  try {
    const mutationArgs = buildGitRetireRemoteBranchArgsForRemote(preflight, preflight.mutation_remote);
    const result = await runGitMutation(
      config,
      workspace,
      [
        ...mutationRemoteGlobalArgs(preflight.mutation_remote, preflight.configured_endpoint, preflight.mutation_endpoint),
        "push",
        ...mutationArgs
      ],
      { clearPushOptions: true }
    );
    return { result, failed: false };
  } catch (error) {
    if (error instanceof GitExecutionError) return { result: error.result, failed: true };
    return { failed: true };
  }
}

async function postRouteMatchesPolicy(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  preflight: GitRetireRemoteBranchPreflight
): Promise<boolean> {
  try {
    const policy = evaluateGitPushPolicy(preflight.root, config.gitPushPolicy, preflight.remote, preflight.branch);
    if (!policy.allowed || policy.endpoint !== preflight.endpoint) return false;
    const resolved = await resolveGitPushMutationEndpointUrl(config, workspace, preflight.remote, preflight.endpoint);
    if (
      resolved.identity !== preflight.endpoint
      || resolved.endpoint !== preflight.mutation_endpoint
      || resolved.configured_endpoint !== preflight.configured_endpoint
    ) return false;
    return true;
  } catch {
    return false;
  }
}

async function observeTarget(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  preflight: GitRetireRemoteBranchPreflight
): Promise<GitPushRemoteObservation> {
  return observeGitPushRemoteHead(
    config,
    workspace,
    preflight.mutation_remote,
    preflight.destination_ref,
    preflight.object_format,
    { globalArgs: mutationRemoteGlobalArgs(preflight.mutation_remote, preflight.configured_endpoint, preflight.mutation_endpoint) }
  );
}

async function preservationStillValid(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  preflight: GitRetireRemoteBranchPreflight
): Promise<boolean> {
  const route = preflight.preservation.route;
  const observed = await observeGitPushRemoteHead(
    config,
    workspace,
    preflight.mutation_remote,
    `refs/heads/${route.branch}`,
    preflight.object_format,
    { globalArgs: mutationRemoteGlobalArgs(preflight.mutation_remote, preflight.configured_endpoint, preflight.mutation_endpoint) }
  );
  if (observed.status !== "head" || observed.head !== route.expected_head) return false;
  if (route.type !== "integrated") return true;
  try {
    await assertCandidateAncestry(config, workspace, preflight.preservation.accepted_candidate, route.expected_head);
    return true;
  } catch {
    return false;
  }
}

async function withRetirementConfigLocks<T>(
  preflight: GitRetireRemoteBranchPreflight,
  action: (locks: readonly GitPushConfigLock[]) => Promise<T>
): Promise<T> {
  try {
    return await withGitPushConfigLocks(preflight.config_sources, action);
  } catch (error) {
    if (error instanceof GitPushConfigLockError) return failRetirement(preflight, "mutation-failed");
    throw error;
  }
}

/**
 * Retire one explicitly leased non-canonical remote working branch after a
 * caller-supplied acceptance receipt and independently observed preservation.
 * The route performs no local ref/worktree/config mutation and makes one
 * native Git push attempt at most.
 */
export async function gitRetireRemoteBranch(
  config: GitRetireRemoteBranchConfig,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitRetireRemoteBranchResult> {
  const mutationRemote = newMutationRemoteName();
  const initial = await preflightRetirement(config, workspace, rawInput, mutationRemote);
  return withRetirementConfigLocks(initial, async (locks) => {
    const preflight = await revalidateRetirement(config, workspace, initial);
    if (!sameConfigSourceSet(initial.config_sources, preflight.config_sources) || !(await configSourcesCovered(preflight.config_sources, locks))) {
      return failRetirement(initial, "mutation-failed");
    }

    const execution = await executeRetirement(config, workspace, preflight);
    const postRouteValid = await postRouteMatchesPolicy(config, workspace, preflight);
    const observed = postRouteValid ? await observeTarget(config, workspace, preflight) : { status: "execution" as const };

    if (
      execution.failed
      || execution.result?.exitCode !== 0
      || execution.result?.signal !== null
      || execution.result?.timedOut
      || execution.result?.stdoutOverflow
      || execution.result?.stderrOverflow
    ) {
      if (!postRouteValid) return failRetirement(preflight, "mutation-uncertain");
      if (observed.status === "head") {
        if (observed.head === preflight.expected_remote_head) return failRetirement(preflight, "mutation-failed", observed.head);
        return failRetirement(preflight, "cas-stale", observed.head);
      }
      if (observed.status === "absent") return failRetirement(preflight, "mutation-uncertain");
      return failRetirement(preflight, "mutation-uncertain");
    }

    if (!postRouteValid) return failRetirement(preflight, "postcondition");
    if (observed.status !== "absent") {
      return failRetirement(preflight, observed.status === "head" ? "postcondition" : "mutation-uncertain", observed.status === "head" ? observed.head : undefined);
    }
    if (!(await preservationStillValid(config, workspace, preflight))) return failRetirement(preflight, "postcondition");

    return Object.freeze({
      schema_version: 1 as const,
      workspace_id: preflight.workspace_id,
      root: preflight.root,
      remote: preflight.remote,
      branch: preflight.branch,
      destination_ref: preflight.destination_ref,
      expected_remote_head: preflight.expected_remote_head,
      remote_head: "absent" as const,
      accepted_candidate: preflight.preservation.accepted_candidate,
      acceptance_authority: preflight.preservation.acceptance_authority,
      evidence_sha256: preflight.preservation.evidence_sha256,
      preservation: preflight.preservation,
      push_attempts: 1 as const,
      status: "retired" as const
    });
  });
}
