import { constants as fsConstants, type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitMutation, type GitExecutionResult } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";
import {
  observeGitPushRemoteHead,
  preflightGitPush,
  revalidateGitPushPreflight,
  resolveGitPushMutationEndpoint,
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

interface GitPushConfigLock {
  readonly source_path: string;
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof fsp.open>>;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

function lockIdentity(stat: Stats): Pick<GitPushConfigLock, "device" | "inode" | "mode"> {
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode & 0o7777
  };
}

function sameLockIdentity(
  left: Pick<GitPushConfigLock, "device" | "inode" | "mode">,
  right: Pick<GitPushConfigLock, "device" | "inode" | "mode">
): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode;
}

/**
 * Determine whether a config source can be changed by an ordinary writer.
 * The containing directory matters: Git replaces a read-only file by
 * renaming its lock when the directory is writable. Missing top-level global
 * files are therefore covered whenever their parent already exists and is
 * writable. A missing parent cannot be reached by an ordinary `git config`
 * writer and is left out of the lock set; a later appearance is caught by the
 * under-lock coverage check.
 */
async function writableConfigDirectory(directory: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(directory);
    if (!stat.isDirectory()) return false;
    await fsp.access(directory, fsConstants.W_OK | fsConstants.X_OK);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return false;
    throw new CodexProError("Git push configuration sources could not be safely enumerated.");
  }
}

async function configSourceNeedsLock(sourcePath: string): Promise<boolean> {
  let sourceStat: Stats;
  try {
    sourceStat = await fsp.stat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw new CodexProError("Git push configuration sources could not be safely enumerated.");
    return writableConfigDirectory(path.dirname(sourcePath));
  }

  const parentWritable = await writableConfigDirectory(path.dirname(sourcePath));
  if (!sourceStat.isFile()) {
    if (parentWritable) throw new CodexProError("Git push configuration source is not a regular file.");
    return false;
  }
  let sourceWritable = false;
  try {
    await fsp.access(sourcePath, fsConstants.W_OK);
    sourceWritable = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      throw new CodexProError("Git push configuration sources could not be safely enumerated.");
    }
  }
  return sourceWritable || parentWritable;
}

/** Acquire one exact native `<config-file>.lock` identity. */
async function acquireGitPushConfigLock(sourcePath: string): Promise<GitPushConfigLock> {
  const lockPath = `${sourcePath}.lock`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(lockPath, "wx", 0o600);
    const identity = lockIdentity(await handle.stat());
    const onDisk = await fsp.lstat(lockPath);
    if (!onDisk.isFile() || !sameLockIdentity(identity, lockIdentity(onDisk))) throw new Error("lock identity changed");
    return { source_path: sourcePath, path: lockPath, handle, ...identity };
  } catch {
    try {
      await handle?.close();
    } catch {
      // The lock identity is not safe to infer after an acquisition failure.
    }
    throw new CodexProError("Git push configuration is busy.");
  }
}

async function releaseGitPushConfigLock(lock: GitPushConfigLock): Promise<void> {
  let sameIdentity = false;
  try {
    const onDisk = await fsp.lstat(lock.path);
    sameIdentity = onDisk.isFile() && sameLockIdentity(lock, lockIdentity(onDisk));
  } catch {
    // Missing/unreadable lock is not proof that this invocation still owns it.
  }
  try {
    await lock.handle.close();
  } catch {
    throw new CodexProError("Git push configuration lock could not be released.");
  }
  if (!sameIdentity) throw new CodexProError("Git push configuration lock ownership was lost.");
  try {
    await fsp.unlink(lock.path);
  } catch {
    throw new CodexProError("Git push configuration lock could not be released.");
  }
}

async function acquireGitPushConfigLocks(preflight: GitPushPreflight): Promise<readonly GitPushConfigLock[]> {
  const locks: GitPushConfigLock[] = [];
  try {
    const sourcePaths = [...preflight.config_sources].sort((left, right) => {
      const leftKey = process.platform === "win32" ? left.toLowerCase() : left;
      const rightKey = process.platform === "win32" ? right.toLowerCase() : right;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const seen = new Set<string>();
    for (const sourcePath of sourcePaths) {
      const sourceKey = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      if (await configSourceNeedsLock(sourcePath)) locks.push(await acquireGitPushConfigLock(sourcePath));
    }
    return Object.freeze(locks);
  } catch {
    await releaseGitPushConfigLocks(locks).catch(() => {});
    throw new CodexProError("Git push configuration sources could not be locked.");
  }
}

async function releaseGitPushConfigLocks(locks: readonly GitPushConfigLock[]): Promise<void> {
  let releaseFailed = false;
  for (let index = locks.length - 1; index >= 0; index -= 1) {
    try {
      await releaseGitPushConfigLock(locks[index]);
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed) throw new CodexProError("Git push configuration locks could not be released.");
}

function sameConfigSourceSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalize = (sourcePath: string): string => process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
  const expected = new Set(left.map(normalize));
  return right.every((sourcePath) => expected.has(normalize(sourcePath)));
}

async function configSourcesCovered(
  preflight: GitPushPreflight,
  locks: readonly GitPushConfigLock[]
): Promise<boolean> {
  const locked = new Set(locks.map((lock) => process.platform === "win32" ? lock.source_path.toLowerCase() : lock.source_path));
  for (const sourcePath of preflight.config_sources) {
    if (await configSourceNeedsLock(sourcePath)) {
      const key = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
      if (!locked.has(key)) return false;
    }
  }
  return true;
}

async function withGitPushConfigLock<T>(preflight: GitPushPreflight, action: (locks: readonly GitPushConfigLock[]) => Promise<T>): Promise<T> {
  let locks: readonly GitPushConfigLock[];
  try {
    locks = await acquireGitPushConfigLocks(preflight);
  } catch {
    return failPush(preflight, "mutation-failed");
  }

  let value: T | undefined;
  let actionError: unknown;
  try {
    value = await action(locks);
  } catch (error) {
    actionError = error;
  }

  let releaseError: unknown;
  try {
    await releaseGitPushConfigLocks(locks);
  } catch (error) {
    releaseError = error;
  }
  if (releaseError !== undefined) return failPush(preflight, "mutation-failed");
  if (actionError !== undefined) throw actionError;
  return value as T;
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
    if (!sameConfigSourceSet(initial.config_sources, preflight.config_sources) || !(await configSourcesCovered(preflight, locks))) {
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
