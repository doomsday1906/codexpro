import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitMutation, type GitExecutionResult } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import { configSourcesCovered, GitPushConfigLockError, withGitPushConfigLocks, type GitPushConfigLock } from "./gitPushConfigLock.js";
import {
  observeGitPushRemoteHead,
  preflightGitPush,
  revalidateGitPushPreflight,
  resolveGitPushMutationEndpoint,
  type GitPushPreflight,
  type GitPushExpectedRemoteHead,
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
      readonly expected_remote_head: GitPushExpectedRemoteHead;
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
  readonly expected_remote_head: GitPushExpectedRemoteHead;
  readonly remote_head: string;
  readonly push_attempts: 1;
}

/** Fixed controls prevent ambient push behaviors while retaining hooks/auth. */
export const GIT_PUSH_FIXED_OPTIONS = Object.freeze([
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
  // Git's empty expected value is the native absence-CAS spelling. The public
  // contract uses the explicit, non-ambiguous sentinel "absent" instead of
  // exposing an empty field that could be confused with omission.
  const leaseExpected = preflight.expected_remote_head === "absent" ? "" : preflight.expected_remote_head;
  const lease = `--force-with-lease=${destination}:${leaseExpected}`;
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

function sameConfigSourceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (sourcePath: string): string => process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
  const expected = new Set(left.map(normalize));
  return right.every((sourcePath) => expected.has(normalize(sourcePath)));
}

async function withGitPushConfigLock<T>(preflight: GitPushPreflight, action: (locks: readonly GitPushConfigLock[]) => Promise<T>): Promise<T> {
  try {
    return await withGitPushConfigLocks(preflight.config_sources, action);
  } catch (error) {
    if (error instanceof GitPushConfigLockError) return failPush(preflight, "mutation-failed");
    throw error;
  }
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
  preflight: GitPushPreflight
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
  config: GitPushConfig,
  workspace: Workspace,
  preflight: GitPushPreflight
): Promise<boolean> {
  try {
    return (await resolveGitPushMutationEndpoint(config, workspace, preflight.remote, preflight.endpoint)) === preflight.endpoint;
  } catch {
    return false;
  }
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
  return withGitPushConfigLock(initial, async (locks) => {
    const { preflight } = await revalidateGitPushPreflight(config, workspace, initial);
    // The first inventory was collected before the native locks existed. The
    // complete inventory must be identical under those locks, and every
    // source that is currently writable must be represented by one held lock.
    // A changed or newly writable source fails closed before any network
    // mutation rather than allowing observation and mutation to diverge.
    if (!sameConfigSourceSet(initial.config_sources, preflight.config_sources) || !(await configSourcesCovered(preflight.config_sources, locks))) {
      return failPush(initial, "mutation-failed");
    }
    const args = buildGitPushArgs(preflight);
    const execution = await executePush(config, workspace, args);
    const postRouteValid = await postRouteMatchesPolicy(config, workspace, preflight);
    const observed = postRouteValid
      ? await observeAfterPush(config, workspace, preflight)
      : { status: "execution" as const };

    if (execution.failed || execution.result?.exitCode !== 0 || execution.result?.signal !== null || execution.result?.timedOut || execution.result?.stdoutOverflow || execution.result?.stderrOverflow) {
      if (!postRouteValid) return failPush(preflight, "mutation-failed");
      if (observed.status === "head") {
        if (preflight.expected_remote_head !== "absent" && observed.head === preflight.expected_remote_head) {
          return failPush(preflight, "mutation-failed", observed.head);
        }
        if (observed.head === preflight.expected_local_head) {
          return failPush(preflight, "mutation-uncertain", observed.head);
        }
        return failPush(preflight, "cas-stale", observed.head);
      }
      if (observed.status === "absent") {
        // A still-absent branch after a failed first-publication attempt is
        // not evidence of a concurrent writer; classify it as an ordinary
        // mutation failure. Existing-branch disappearance remains stale CAS.
        return failPush(preflight, preflight.expected_remote_head === "absent" ? "mutation-failed" : "cas-stale");
      }
      return failPush(preflight, "mutation-failed");
    }

    if (!postRouteValid) return failPush(preflight, "postcondition");
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
  });
}
