import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitMutation, type GitExecutionResult } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import {
  observeGitPushRemoteHead,
  preflightGitPush,
  revalidateGitPushPreflight,
  type GitPushPreflight,
  type GitPushRemoteObservation
} from "./gitPushPreflight.js";

export type GitPushFailureReason = "cas-stale" | "mutation-failed" | "mutation-uncertain" | "postcondition";

const FAILURE_MESSAGES: Record<GitPushFailureReason, string> = {
  "cas-stale": "Git push compare-and-swap was stale; the remote branch changed before mutation.",
  "mutation-failed": "Git push mutation failed; the remote branch was not confirmed as updated.",
  "mutation-uncertain": "Git push mutation outcome could not be confirmed.",
  postcondition: "Git push completed without a matching remote branch postcondition."
};

/** Constant-message mutation failure; Git/auth output is never exposed. */
export class GitPushError extends CodexProError {
  constructor(
    readonly reason: GitPushFailureReason,
    readonly facts: {
      readonly workspace_id: string;
      readonly root: string;
      readonly remote: string;
      readonly branch: string;
      readonly source_head: string;
      readonly expected_remote_head: string;
      readonly remote_head?: string;
    }
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitPushError";
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

export type GitPushConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes" | "toolMode" | "writeMode" | "gitPushPolicy">;

export interface GitPushResult {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly remote: string;
  readonly branch: string;
  readonly destination_ref: string;
  readonly source_head: string;
  readonly expected_remote_head: string;
  readonly remote_head: string;
  readonly push_attempts: 1;
}

/** Fixed controls prevent ambient push behaviors while retaining hooks/auth. */
export const GIT_PUSH_FIXED_OPTIONS = Object.freeze([
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

/**
 * Construct the only permitted remote update. The caller cannot provide any
 * part of the lease, source, destination, refspec, URL, or push options.
 */
export function buildGitPushArgs(preflight: GitPushPreflight): readonly string[] {
  const destination = `refs/heads/${preflight.branch}`;
  if (preflight.destination_ref !== destination || preflight.source_ref !== destination) {
    throw new GitPushError("postcondition", {
      workspace_id: preflight.workspace_id,
      root: preflight.root,
      remote: preflight.remote,
      branch: preflight.branch,
      source_head: preflight.expected_local_head,
      expected_remote_head: preflight.expected_remote_head
    });
  }
  const lease = `--force-with-lease=${destination}:${preflight.expected_remote_head}`;
  const refspec = `${preflight.expected_local_head}:${destination}`;
  return Object.freeze([
    ...GIT_PUSH_FIXED_OPTIONS,
    lease,
    "--",
    preflight.remote,
    refspec
  ]);
}

function pushFacts(preflight: GitPushPreflight, remoteHead?: string) {
  return {
    workspace_id: preflight.workspace_id,
    root: preflight.root,
    remote: preflight.remote,
    branch: preflight.branch,
    source_head: preflight.expected_local_head,
    expected_remote_head: preflight.expected_remote_head,
    ...(remoteHead === undefined ? {} : { remote_head: remoteHead })
  } as const;
}

function failPush(preflight: GitPushPreflight, reason: GitPushFailureReason, remoteHead?: string): never {
  throw new GitPushError(reason, pushFacts(preflight, remoteHead));
}

async function executePush(
  config: GitPushConfig,
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

async function observeAfterPush(
  config: GitPushConfig,
  workspace: Workspace,
  preflight: GitPushPreflight,
  endpoint: string
): Promise<GitPushRemoteObservation> {
  return observeGitPushRemoteHead(
    config,
    workspace,
    endpoint,
    preflight.destination_ref,
    preflight.object_format
  );
}

/**
 * Perform one exact remote CAS push after the accepted immutable preflight.
 * There is no retry, fetch, pull, merge, rebase, or caller-controlled Git
 * mutation input in this path.
 */
export async function gitPush(
  config: GitPushConfig,
  workspace: Workspace,
  rawInput: unknown
): Promise<GitPushResult> {
  const initial = await preflightGitPush(config, workspace, rawInput);
  const { preflight, endpoint } = await revalidateGitPushPreflight(config, workspace, initial);
  const args = buildGitPushArgs(preflight);
  const execution = await executePush(config, workspace, args);
  const observed = await observeAfterPush(config, workspace, preflight, endpoint);

  if (execution.failed || execution.result?.exitCode !== 0 || execution.result?.signal !== null || execution.result?.timedOut || execution.result?.stdoutOverflow || execution.result?.stderrOverflow) {
    if (observed.status === "head") {
      if (observed.head === preflight.expected_remote_head) {
        return failPush(preflight, "mutation-failed", observed.head);
      }
      if (observed.head === preflight.expected_local_head) {
        return failPush(preflight, "mutation-uncertain", observed.head);
      }
      return failPush(preflight, "cas-stale", observed.head);
    }
    if (observed.status === "absent") {
      return failPush(preflight, "cas-stale");
    }
    return failPush(preflight, "mutation-failed");
  }

  if (observed.status !== "head" || observed.head !== preflight.expected_local_head) {
    return failPush(preflight, "postcondition", observed.status === "head" ? observed.head : undefined);
  }

  return Object.freeze({
    schema_version: 1 as const,
    workspace_id: preflight.workspace_id,
    root: preflight.root,
    remote: preflight.remote,
    branch: preflight.branch,
    destination_ref: preflight.destination_ref,
    source_head: preflight.expected_local_head,
    expected_remote_head: preflight.expected_remote_head,
    remote_head: observed.head,
    push_attempts: 1 as const
  });
}
