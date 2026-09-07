import { constants as fsConstants, type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CodexProError } from "./guard.js";

/** The exact native config-file lock held across a remote Git mutation. */
export interface GitPushConfigLock {
  readonly source_path: string;
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof fsp.open>>;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
}

export type GitPushConfigLockFailure = "acquire" | "release";

/** Constant internal lock failure; callers decide their public error surface. */
export class GitPushConfigLockError extends CodexProError {
  constructor(readonly phase: GitPushConfigLockFailure) {
    super(phase === "acquire" ? "Git push configuration sources could not be locked." : "Git push configuration locks could not be released.");
    this.name = "GitPushConfigLockError";
  }
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

async function acquireGitPushConfigLocks(configSources: readonly string[]): Promise<readonly GitPushConfigLock[]> {
  const locks: GitPushConfigLock[] = [];
  try {
    const sourcePaths = [...configSources].sort((left, right) => {
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
    throw new GitPushConfigLockError("acquire");
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
  if (releaseFailed) throw new GitPushConfigLockError("release");
}

/** Confirm every currently writable source is represented by one held lock. */
export async function configSourcesCovered(
  configSources: readonly string[],
  locks: readonly GitPushConfigLock[]
): Promise<boolean> {
  const locked = new Set(locks.map((lock) => process.platform === "win32" ? lock.source_path.toLowerCase() : lock.source_path));
  for (const sourcePath of configSources) {
    if (await configSourceNeedsLock(sourcePath)) {
      const key = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
      if (!locked.has(key)) return false;
    }
  }
  return true;
}

/** Run one remote mutation while holding the exact active config-source set. */
export async function withGitPushConfigLocks<T>(
  configSources: readonly string[],
  action: (locks: readonly GitPushConfigLock[]) => Promise<T>
): Promise<T> {
  const locks = await acquireGitPushConfigLocks(configSources);
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
  if (releaseError !== undefined) throw releaseError;
  if (actionError !== undefined) throw actionError;
  return value as T;
}
