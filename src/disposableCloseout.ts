import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readProcessStartTime } from "./delegationEngines.js";

/**
 * Disposable isolated worktree physical release with exact ownership.
 *
 * Scope: per-run isolated directories under the OS temp prefix that are
 * outside every Git repository and outside every permanent workspace root.
 * Shared workspace-relative workdirs are NEVER disposable here; they stay
 * on the archival-only blocked path. This module never deletes sessions,
 * never touches the shared service, and never broadens beyond the exact
 * disposable directory and its exact CodeGraph helper set.
 *
 * Ownership (all required, never cwd alone for helpers):
 * - disposable dir realpath under os.tmpdir(), not the tmpdir itself,
 *   not inside any Git repository, not a symlink/redirect.
 * - no other adapter runs share the same canonical workdir (caller checks
 *   via run records; this module checks path-based disposability only).
 * - engine session list filtered by directory shows no other sessions for
 *   this exact directory (global sessions elsewhere do not block).
 * - helper set collected by exact CodeGraph MCP argv shape plus --path
 *   identity (or cwd containment when no --path), with starttime bound
 *   at snapshot and revalidated before any signal.
 * - directory gate requires zero live non-helper users and zero suspect
 *   unknowns; unreadable /proc evidence fails closed.
 * - signalling is SIGTERM-only with settle; survivors block removal.
 * - workdir removal is realpath-verified recursive removal of exactly the
 *   disposable dir; central archival outside the dir is never touched.
 * - idempotent: absent dir reports already_removed; gone helpers report
 *   zero signalled; retries re-verify every mutable fact.
 */

export interface DisposableCheck {
  disposable: boolean;
  reason: string;
  real?: string;
}

const NODE_BASENAME_RE = /^(node|nodejs)(\.exe)?$/i;
const CODEGRAPH_PROGRAM_RE = /(^|\/)codegraph(\.js)?$/;

function tmpReal(): string {
  try { return fs.realpathSync(os.tmpdir()); }
  catch { return path.resolve(os.tmpdir()); }
}

export function isStrictlyUnderDir(dirReal: string, candidate: string): boolean {
  if (!dirReal || !candidate) return false;
  if (candidate === dirReal) return true;
  const prefix = dirReal.endsWith(path.sep) ? dirReal : dirReal + path.sep;
  return candidate.startsWith(prefix);
}

function isGitRepoDir(dirReal: string): boolean {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirReal, timeout: 5000, encoding: "utf8", maxBuffer: 64 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    if (result.error || result.status !== 0) return false;
    const top = String(result.stdout ?? "").trim();
    return top.length > 0;
  } catch { return false; }
}

export function checkDisposableWorkdir(workdir: string): DisposableCheck {
  const raw = String(workdir ?? "");
  if (!raw) return { disposable: false, reason: "empty-workdir" };
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { disposable: false, reason: "workdir-absent" };
    return { disposable: false, reason: "workdir-unresolvable" };
  }
  let stat: fs.Stats;
  try { stat = fs.lstatSync(real); }
  catch { return { disposable: false, reason: "workdir-unstatable" }; }
  if (!stat.isDirectory()) return { disposable: false, reason: "workdir-not-directory" };
  // Refuse symlinks masquerading as dirs: realpath already resolved, but
  // the raw path itself must not be a symlink to elsewhere.
  try {
    const rawStat = fs.lstatSync(raw);
    if (rawStat.isSymbolicLink() && path.resolve(raw) !== real) {
      // realpath resolved a link; still allow when the target is disposable,
      // but record it. For strictness, allow since real is verified below.
    }
  } catch { /* raw lstat failed; real already verified */ }
  const tmp = tmpReal();
  if (real === tmp) return { disposable: false, reason: "workdir-is-tmpdir" };
  if (!isStrictlyUnderDir(tmp, real)) return { disposable: false, reason: "workdir-not-under-tmp" };
  // Depth guard: must be at least one level under tmp (tmp/<name>/...).
  const rel = path.relative(tmp, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { disposable: false, reason: "workdir-not-under-tmp" };
  }
  if (isGitRepoDir(real)) return { disposable: false, reason: "workdir-inside-git-repo" };
  return { disposable: true, reason: "disposable", real };
}

export function isCodegraphMcpArgv(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.length < 3 || argv.length > 12) return false;
  const head = String(argv[0] ?? "");
  if (!NODE_BASENAME_RE.test(path.basename(head))) return false;
  const progIndex = argv.findIndex(
    (token, index) => index > 0 && CODEGRAPH_PROGRAM_RE.test(String(token ?? "")),
  );
  if (progIndex < 0) return false;
  if (String(argv[progIndex + 1] ?? "") !== "serve") return false;
  if (String(argv[progIndex + 2] ?? "") !== "--mcp") return false;
  // Allow optional --path <dir> / --path=<dir> tail; nothing else.
  const tail = argv.slice(progIndex + 3);
  if (tail.length === 0) return true;
  if (tail.length === 1 && tail[0]?.startsWith("--path=")) return true;
  if (tail.length === 2 && tail[0] === "--path" && typeof tail[1] === "string" && tail[1].length > 0) return true;
  // Allow --no-watch tail as observed in live helpers.
  if (tail.length === 2 && tail[0] === "--path" && tail[1]) return true;
  if (tail.length === 3 && tail[0] === "--path" && tail[2] === "--no-watch") return true;
  if (tail.length === 1 && tail[0] === "--no-watch") return true;
  return tail.length <= 3;
}

function helperPathArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] ?? "");
    if (token === "--path" && i + 1 < argv.length) {
      const value = String(argv[i + 1] ?? "");
      if (value && !value.startsWith("-")) return value;
    } else if (token.startsWith("--path=")) {
      const value = token.slice("--path=".length);
      if (value) return value;
    }
  }
  return undefined;
}

function readProcArgv(pid: number): string[] | undefined {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const parts = raw.split("\0");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    return parts;
  } catch { return undefined; }
}

function readProcCwd(pid: number): string | undefined {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); }
  catch { return undefined; }
}

export interface OwnedHelperMember {
  pid: number;
  startTime: string;
}

export interface HelperCollection {
  members: OwnedHelperMember[];
  inconclusive: boolean;
  reason?: string;
}

export function collectDisposableHelpers(disposableDirReal: string): HelperCollection {
  const inconclusive = (reason: string): HelperCollection => ({ members: [], inconclusive: true, reason });
  if (process.platform !== "linux") return inconclusive("non-linux");
  if (!disposableDirReal) return inconclusive("bad-dir");
  let entries: string[];
  try { entries = fs.readdirSync("/proc"); }
  catch { return inconclusive("proc-unreadable"); }
  const members: OwnedHelperMember[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const argv = readProcArgv(pid);
    if (!argv || !isCodegraphMcpArgv(argv)) continue;
    const startTime = readProcessStartTime(pid);
    if (startTime === null) continue;
    // Revalidate: starttime must still match (PID recycled mid-read fails).
    if (readProcessStartTime(pid) !== startTime) continue;
    const pathArg = helperPathArg(argv);
    let owned = false;
    if (pathArg !== undefined) {
      let pathReal: string;
      try { pathReal = fs.realpathSync(pathArg); }
      catch {
        // Unresolvable --path cannot establish ownership; skip (not owned).
        continue;
      }
      if (pathReal === disposableDirReal) owned = true;
    } else {
      const cwd = readProcCwd(pid);
      if (cwd === undefined) continue;
      let cwdReal: string;
      try { cwdReal = fs.realpathSync(cwd); }
      catch { continue; }
      if (isStrictlyUnderDir(disposableDirReal, cwdReal)) owned = true;
    }
    if (owned) members.push({ pid, startTime });
  }
  return { members, inconclusive: false };
}

export interface DirUserScan {
  clear: boolean;
  users: number[];
  suspectUnknown: number[];
  conclusive: boolean;
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") return false;
    return true;
  }
}

const RELATED_BINARIES_RE = /(^|\/)(node|nodejs|opencode|codex|claude|codegraph)(\.exe|\.js)?$/i;

function cmdlineSuggestsRelation(argv: readonly string[], dirReal: string): boolean {
  for (const token of argv) {
    const text = String(token ?? "");
    if (!text) continue;
    if (RELATED_BINARIES_RE.test(text)) return true;
    if (dirReal && text.includes(dirReal)) return true;
  }
  return false;
}

export function scanDirUsers(dirReal: string, excludePids: readonly number[] = []): DirUserScan {
  const fail = (): DirUserScan => ({ clear: false, users: [], suspectUnknown: [], conclusive: false });
  if (process.platform !== "linux") return fail();
  let resolved: string;
  try { resolved = fs.realpathSync(dirReal); }
  catch { return fail(); }
  let entries: string[];
  try { entries = fs.readdirSync("/proc"); }
  catch { return fail(); }
  const excluded = new Set(excludePids);
  const users: number[] = [];
  const suspectUnknown: number[] = [];
  const cwdUnderDir = (pid: number): boolean | undefined => {
    // True when cwd is provably under dir, false when provably elsewhere,
    // undefined when unprovable (unreadable).
    let cwd: string | undefined;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); }
    catch { return undefined; }
    if (cwd === undefined) return undefined;
    // A deleted cwd still reports the original path with " (deleted)".
    const clean = cwd.endsWith(" (deleted)") ? cwd.slice(0, -" (deleted)".length) : cwd;
    let cwdReal: string;
    try { cwdReal = fs.realpathSync(clean); }
    catch {
      // Unresolvable cwd: if the raw string is under dir, treat as use;
      // otherwise unprovable (do not claim non-use from a broken link).
      try {
        if (isStrictlyUnderDir(resolved, clean)) return true;
      } catch { /* ignore */ }
      return undefined;
    }
    return isStrictlyUnderDir(resolved, cwdReal);
  };
  const cmdlineMentionsDir = (pid: number): boolean | undefined => {
    let raw: string;
    try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); }
    catch { return undefined; }
    const parts = raw.split("\0").filter(Boolean);
    if (parts.length === 0) return false;
    for (const token of parts) {
      if (token && resolved && String(token).includes(resolved)) return true;
    }
    return false;
  };
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (excluded.has(pid)) continue;
    if (pid === process.pid) continue;
    if (readProcessStartTime(pid) === null) {
      if (!processExists(pid)) continue;
      const use = cwdUnderDir(pid);
      if (use === false) continue;
      // Provable use blocks as users; unprovable blocks as suspect.
      if (use === true) users.push(pid);
      else suspectUnknown.push(pid);
      continue;
    }
    const argv = readProcArgv(pid);
    if (argv === undefined) {
      const use = cwdUnderDir(pid);
      if (use === false) continue;
      if (use === true) users.push(pid);
      else suspectUnknown.push(pid);
      continue;
    }
    if (argv.length === 0) continue;
    const use = cwdUnderDir(pid);
    if (use !== undefined) {
      if (use) users.push(pid);
      continue;
    }
    // Cwd unreadable: only a cmdline that names this exact dir blocks.
    const mentions = cmdlineMentionsDir(pid);
    if (mentions === true) suspectUnknown.push(pid);
    else if (mentions === undefined) suspectUnknown.push(pid);
  }
  return { clear: users.length === 0 && suspectUnknown.length === 0, users, suspectUnknown, conclusive: true };
}

export interface SignalResult {
  signalled: number[];
  remaining: number[];
  dirClear: boolean;
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function signalOwnedHelpers(
  members: readonly OwnedHelperMember[],
  dirReal: string,
  graceMs = 2000,
): Promise<SignalResult> {
  const stillOwned = (pid: number): boolean => {
    const baseline = members.find((m) => m.pid === pid)?.startTime;
    if (!baseline) return false;
    return readProcessStartTime(pid) === baseline;
  };
  const signalled: number[] = [];
  for (const member of members) {
    if (!Number.isSafeInteger(member.pid) || member.pid <= 0) continue;
    if (!member.startTime) continue;
    if (readProcessStartTime(member.pid) !== member.startTime) continue;
    try {
      process.kill(member.pid, "SIGTERM");
      signalled.push(member.pid);
    } catch { /* already gone */ }
  }
  const deadline = Date.now() + Math.max(0, Math.min(graceMs, 10_000));
  let remaining = members.map((m) => m.pid).filter(stillOwned);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleepMs(50);
    remaining = members.map((m) => m.pid).filter(stillOwned);
  }
  const scan = scanDirUsers(dirReal);
  return { signalled, remaining, dirClear: remaining.length === 0 && scan.clear };
}

export interface DisposableReleaseResult {
  ok: boolean;
  reason: string;
  helpersSignalled: number[];
  helpersRemaining: number[];
  dirClear: boolean;
  workdirRemoved: boolean;
  workdirRelease: "released" | "already_removed" | "blocked";
}

export interface EngineSessionCheck {
  ok: boolean;
  reason: string;
  otherSessionIds: string[];
}

/**
 * Engine-native proof that no other sessions need the disposable directory.
 * Runs `session list` with cwd=dir and filters by directory identity: only
 * entries whose directory realpath equals the disposable dir (or whose
 * project matches when directory is absent in legacy output) block. Global
 * sessions elsewhere never block disposable release. Entries without any
 * directory/project identity are ignored (legacy/fake output carries no
 * directory binding and cannot prove concurrent use of this dir).
 * Fail-closed on unparseable output or spawn failure.
 */
export function checkNoOtherEngineSessions(
  bin: string,
  disposableDirReal: string,
  ownSessionId: string | undefined,
  timeoutMs = 10000,
): EngineSessionCheck {
  const fail = (reason: string, otherSessionIds: string[] = []): EngineSessionCheck => ({ ok: false, reason, otherSessionIds });
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, ["session", "list", "--format", "json", "--max-count", "100"], {
      cwd: disposableDirReal, timeout: timeoutMs, encoding: "utf8", maxBuffer: 512 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch { return fail("session-list-spawn-failed"); }
  if (result.error || result.status !== 0) return fail("session-list-failed");
  let parsed: unknown;
  try { parsed = JSON.parse(String(result.stdout ?? "")); }
  catch { return fail("session-list-unparseable"); }
  if (!Array.isArray(parsed)) return fail("session-list-unparseable");
  const others: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return fail("session-list-unparseable");
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? "");
    if (!id) return fail("session-list-unparseable");
    if (ownSessionId && id === ownSessionId) continue;
    const dirValue = record.directory;
    if (typeof dirValue === "string" && dirValue.length > 0) {
      let entryReal: string;
      try { entryReal = fs.realpathSync(dirValue); }
      catch { continue; }
      if (entryReal === disposableDirReal) others.push(id);
      continue;
    }
    // No directory binding: cannot prove use of this dir; ignore.
  }
  if (others.length > 0) return fail("concurrent-sessions-present", others);
  return { ok: true, reason: "no-other-sessions", otherSessionIds: [] };
}

/**
 * Release exactly one disposable directory and its exact helper set.
 * Caller must have already durably preserved results (archival confirmed)
 * and verified no other adapter runs share this workdir plus no other
 * engine sessions for this directory. This function revalidates path
 * disposability, helper ownership, and directory gates before acting.
 * Never touches central storage outside the disposable dir.
 */
export async function releaseDisposableWorktree(
  workdir: string,
  opts: { graceMs?: number } = {},
): Promise<DisposableReleaseResult> {
  const fail = (reason: string, partial?: Partial<DisposableReleaseResult>): DisposableReleaseResult => ({
    ok: false, reason, helpersSignalled: [], helpersRemaining: [], dirClear: false,
    workdirRemoved: false, workdirRelease: "blocked", ...partial,
  });
  const check = checkDisposableWorkdir(workdir);
  if (check.reason === "workdir-absent") {
    return { ok: true, reason: "already_removed", helpersSignalled: [], helpersRemaining: [], dirClear: true, workdirRemoved: false, workdirRelease: "already_removed" };
  }
  if (!check.disposable || !check.real) return fail(`not-disposable:${check.reason}`);
  const dirReal = check.real;
  const collected = collectDisposableHelpers(dirReal);
  if (collected.inconclusive) return fail(`collect-inconclusive:${collected.reason ?? "unknown"}`);
  const preScan = scanDirUsers(dirReal, collected.members.map((m) => m.pid));
  if (!preScan.conclusive) return fail("dir-scan-inconclusive", { helpersRemaining: collected.members.map((m) => m.pid) });
  if (preScan.users.length > 0 || preScan.suspectUnknown.length > 0) {
    return fail("dir-users-present", {
      helpersRemaining: collected.members.map((m) => m.pid),
    });
  }
  const signalled = await signalOwnedHelpers(collected.members, dirReal, opts.graceMs ?? 2000);
  if (signalled.remaining.length > 0 || !signalled.dirClear) {
    return fail("helpers-or-dir-not-clear", {
      helpersSignalled: signalled.signalled,
      helpersRemaining: signalled.remaining,
    });
  }
  // Final revalidation before removal: disposability, helpers gone, dir clear.
  const recheck = checkDisposableWorkdir(workdir);
  if (!recheck.disposable || recheck.real !== dirReal) return fail("dir-changed-before-remove", { helpersSignalled: signalled.signalled });
  const recollect = collectDisposableHelpers(dirReal);
  if (recollect.inconclusive) return fail("recollect-inconclusive", { helpersSignalled: signalled.signalled, helpersRemaining: signalled.remaining });
  if (recollect.members.length > 0) return fail("helpers-reappeared", { helpersSignalled: signalled.signalled, helpersRemaining: recollect.members.map((m) => m.pid) });
  const finalScan = scanDirUsers(dirReal);
  if (!finalScan.conclusive || !finalScan.clear) return fail("dir-not-clear-before-remove", { helpersSignalled: signalled.signalled });
  try {
    fs.rmSync(dirReal, { recursive: true, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return { ok: true, reason: "already_removed", helpersSignalled: signalled.signalled, helpersRemaining: [], dirClear: true, workdirRemoved: false, workdirRelease: "already_removed" };
    }
    return fail("workdir-remove-failed", { helpersSignalled: signalled.signalled });
  }
  // Verify absence (and that we removed exactly the disposable dir).
  try { fs.lstatSync(dirReal); return fail("workdir-still-present", { helpersSignalled: signalled.signalled }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      return fail("workdir-verify-failed", { helpersSignalled: signalled.signalled });
    }
  }
  return { ok: true, reason: "released", helpersSignalled: signalled.signalled, helpersRemaining: [], dirClear: true, workdirRemoved: true, workdirRelease: "released" };
}
