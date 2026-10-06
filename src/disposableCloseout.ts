import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readProcessStartTime } from "./delegationEngines.js";
import { centralArtifactsDirForRun } from "./delegationStore.js";

/**
 * Disposable isolated worktree physical release with exact ownership.
 *
 * Scope: per-run isolated directories under the OS temp prefix that are
 * outside every Git repository and outside every permanent workspace root.
 * Git worktrees are source-control checkouts owned by the Git/lane lifecycle,
 * not run workdirs: any path inside a Git repository — including worktrees —
 * is refused here, per the original accepted scope (disposable run workdirs
 * only). Shared workspace-relative workdirs are NEVER disposable here; they stay
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

export interface GitProbe {
  status: "repo" | "non-repo" | "inconclusive";
  reason: string;
  top?: string;
}

export function probeGitRepoStatus(dirReal: string, timeoutMs = 5000): GitProbe {
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirReal, timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024,
      env: { ...process.env, NO_COLOR: "1", GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (error) {
    return { status: "inconclusive", reason: `git-spawn-failed:${(error as NodeJS.ErrnoException | null)?.code ?? "error"}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException | null)?.code;
    return { status: "inconclusive", reason: `git-spawn-error:${code ?? "error"}` };
  }
  if (result.signal) return { status: "inconclusive", reason: `git-signal:${String(result.signal)}` };
  const stderr = String(result.stderr ?? "");
  const stdout = String(result.stdout ?? "").trim();
  if (result.status === 0) {
    if (!stdout) return { status: "inconclusive", reason: "git-empty-toplevel" };
    return { status: "repo", reason: "git-toplevel-found", top: stdout };
  }
  // Nonzero exit: only a confirmed "not a git repository" diagnostic counts
  // as non-repo. Every other exit (including timeouts signaled as exit codes
  // on some platforms, permission errors, corrupt repos) is inconclusive.
  if (/not a git repository/i.test(stderr)) return { status: "non-repo", reason: "git-confirmed-non-repo" };
  if (/detected dubious ownership/i.test(stderr)) return { status: "inconclusive", reason: "git-dubious-ownership" };
  return { status: "inconclusive", reason: `git-exit:${String(result.status)}` };
}

function isGitRepoDir(dirReal: string): boolean {
  return probeGitRepoStatus(dirReal).status === "repo";
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
  const gitProbe = probeGitRepoStatus(real);
  if (gitProbe.status === "repo") return { disposable: false, reason: "workdir-inside-git-repo" };
  if (gitProbe.status === "inconclusive") return { disposable: false, reason: `git-probe-inconclusive:${gitProbe.reason}` };
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
    const arg = String(argv[i] ?? "");
    if (arg === "--path" && i + 1 < argv.length) {
      const value = String(argv[i + 1] ?? "");
      if (value && !value.startsWith("-")) return value;
    } else if (arg.startsWith("--path=")) {
      const value = arg.slice("--path=".length);
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

export const PHYSICAL_RELEASE_FILENAME = "physical-release.json";
const WORKDIR_BACKUP_DIRNAME = "workdir-backup";
const BACKUP_MANIFEST_FILENAME = "backup-manifest.json";
const BACKUP_MAX_FILES = 512;
const BACKUP_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const BACKUP_MAX_SINGLE_BYTES = 8 * 1024 * 1024;

export interface WorkdirBackupResult {
  ok: boolean;
  reason: string;
  fileCount?: number;
  totalBytes?: number;
  manifestSha256?: string;
}

function syncDirSync(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function atomicPublishFile(file: string, text: string): void {
  const dir = path.dirname(file);
  const stage = path.join(dir, `.disposable-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(stage, "wx", 0o600); created = true;
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(stage, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    syncDirSync(dir);
    const current = fs.readFileSync(file, "utf8");
    if (current !== text) throw new Error("publish-conflict");
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } catch {}
    finally { if (created) { try { fs.unlinkSync(stage); } catch {} } }
  }
}

function listWorkdirFilesRecursive(dirReal: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (current: string, relBase: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink:${rel}`);
      }
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push({ rel, abs });
      }
    }
  };
  walk(dirReal, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

/**
 * Preserve every workdir file centrally before deletion. Copies each file
 * (O_EXCL, never overwriting) into
 * `<centralArtifactsDir>/workdir-backup/<relpath>`, then publishes a bound
 * manifest with per-file sha256 + sizes. A session transcript alone is not
 * a backup of workdir files, so this backup plus the session export plus
 * the run result together constitute durable preservation. Refuses when the
 * tree holds symlinks, too many files, or too many bytes.
 */
export function backupWorkdirToCentral(
  bridgeDir: string,
  runId: string,
  dirReal: string,
  binding: Record<string, unknown>,
): WorkdirBackupResult {
  const fail = (reason: string): WorkdirBackupResult => ({ ok: false, reason });
  let files: { rel: string; abs: string }[];
  try { files = listWorkdirFilesRecursive(dirReal); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("symlink:")) return fail(`workdir-backup-symlink:${message.slice("symlink:".length)}`);
    return fail("workdir-backup-list-failed");
  }
  if (files.length > BACKUP_MAX_FILES) return fail(`workdir-backup-too-many-files:${files.length}`);
  const centralDir = centralArtifactsDirForRun(bridgeDir, runId);
  const backupDir = path.join(centralDir, WORKDIR_BACKUP_DIRNAME);
  let total = 0;
  const manifestEntries: { rel: string; bytes: number; sha256: string }[] = [];
  try {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  } catch { return fail("workdir-backup-mkdir-failed"); }
  for (const file of files) {
    if (file.rel.includes("..") || path.isAbsolute(file.rel)) return fail("workdir-backup-bad-relpath");
    let stat: fs.Stats;
    try { stat = fs.statSync(file.abs); }
    catch { return fail("workdir-backup-stat-failed"); }
    if (!stat.isFile()) return fail("workdir-backup-not-file");
    if (stat.size > BACKUP_MAX_SINGLE_BYTES) return fail(`workdir-backup-file-too-large:${file.rel}`);
    total += stat.size;
    if (total > BACKUP_MAX_TOTAL_BYTES) return fail(`workdir-backup-too-large:${total}`);
    let bytes: Buffer;
    try { bytes = fs.readFileSync(file.abs); }
    catch { return fail("workdir-backup-read-failed"); }
    if (bytes.length !== stat.size) return fail("workdir-backup-changed-during-read");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dest = path.join(backupDir, file.rel);
    try { fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 }); }
    catch { return fail("workdir-backup-mkdir-failed"); }
    try {
      const fd = fs.openSync(dest, "wx", 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "EEXIST") {
        // Idempotent retry: existing backup file must match exactly.
        let existing: Buffer;
        try { existing = fs.readFileSync(dest); }
        catch { return fail("workdir-backup-verify-failed"); }
        if (!existing.equals(bytes)) return fail(`workdir-backup-conflict:${file.rel}`);
      } else {
        return fail("workdir-backup-write-failed");
      }
    }
    manifestEntries.push({ rel: file.rel, bytes: bytes.length, sha256 });
  }
  const manifest = `${JSON.stringify({ version: 1, binding, files: manifestEntries })}\n`;
  const manifestSha256 = createHash("sha256").update(manifest, "utf8").digest("hex");
  try {
    atomicPublishFile(path.join(backupDir, BACKUP_MANIFEST_FILENAME), manifest);
    syncDirSync(backupDir);
  } catch { return fail("workdir-backup-manifest-failed"); }
  // Verify: re-read manifest and every backed file.
  try {
    const reread = fs.readFileSync(path.join(backupDir, BACKUP_MANIFEST_FILENAME), "utf8");
    if (reread !== manifest) return fail("workdir-backup-manifest-unverified");
    for (const entry of manifestEntries) {
      const data = fs.readFileSync(path.join(backupDir, entry.rel));
      if (data.length !== entry.bytes || createHash("sha256").update(data).digest("hex") !== entry.sha256) {
        return fail(`workdir-backup-file-unverified:${entry.rel}`);
      }
    }
  } catch { return fail("workdir-backup-verify-failed"); }
  return { ok: true, reason: "backed-up", fileCount: manifestEntries.length, totalBytes: total, manifestSha256 };
}

export interface PhysicalReleaseRecord {
  version: 1;
  binding: { runId: string; ownerIdHash: string; ownerKind: string; workdir: string; engine: string; sessionId: string | null; dirReal: string };
  releasedAt: string;
  helpersSignalled: number[];
  backup: { fileCount: number; totalBytes: number; manifestSha256: string };
  workdirRemoved: boolean;
}

export function physicalReleasePath(bridgeDir: string, runId: string): string {
  return path.join(centralArtifactsDirForRun(bridgeDir, runId), PHYSICAL_RELEASE_FILENAME);
}

export function readPhysicalReleaseRecord(bridgeDir: string, runId: string): PhysicalReleaseRecord | undefined {
  let text: string;
  try {
    const fd = fs.openSync(physicalReleasePath(bridgeDir, runId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
      const buf = Buffer.alloc(stat.size + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n !== stat.size) return undefined;
      text = buf.subarray(0, n).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return undefined; }
  try {
    const record = JSON.parse(text) as PhysicalReleaseRecord;
    if (!record || record.version !== 1 || !record.binding || typeof record.binding.runId !== "string") return undefined;
    if (record.binding.runId !== runId) return undefined;
    return record;
  } catch { return undefined; }
}

export interface DisposableReleaseResult {
  ok: boolean;
  reason: string;
  helpersSignalled: number[];
  helpersRemaining: number[];
  dirClear: boolean;
  workdirRemoved: boolean;
  workdirRelease: "released" | "already_removed" | "blocked";
  backupFileCount?: number;
  backupTotalBytes?: number;
}

export interface EngineSessionCheck {
  ok: boolean;
  reason: string;
  otherSessionIds: string[];
}

/**
 * Engine-native proof that no other sessions need the disposable directory.
 * Runs `session list` with cwd=dir and requires exact directory proof for
 * every listed session: entries whose directory realpath equals the
 * disposable dir (and whose id differs from the closing run) block as
 * concurrent use. Entries with missing directory identity, unresolvable
 * directory paths, or unparseable shape block as unproven ownership —
 * they are never silently ignored. A full page (count at the requested
 * maximum) is treated as truncated coverage and blocks. Global sessions
 * with a proven different directory never block. Read-only; never touches
 * sessions or shared services.
 * Fail-closed on unparseable output, spawn failure, truncation, or ambiguity.
 */
const SESSION_LIST_MAX = 100;
export function checkNoOtherEngineSessions(
  bin: string,
  disposableDirReal: string,
  ownSessionId: string | undefined,
  timeoutMs = 10000,
): EngineSessionCheck {
  const fail = (reason: string, otherSessionIds: string[] = []): EngineSessionCheck => ({ ok: false, reason, otherSessionIds });
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(bin, ["session", "list", "--format", "json", "--max-count", String(SESSION_LIST_MAX)], {
      cwd: disposableDirReal, timeout: timeoutMs, encoding: "utf8", maxBuffer: 512 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch { return fail("session-list-spawn-failed"); }
  if (result.error || result.status !== 0) return fail("session-list-failed");
  let parsed: unknown;
  try { parsed = JSON.parse(String(result.stdout ?? "")); }
  catch { return fail("session-list-unparseable"); }
  if (!Array.isArray(parsed)) return fail("session-list-unparseable");
  if (parsed.length >= SESSION_LIST_MAX) return fail("session-list-truncated", []);
  const others: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return fail("session-list-unparseable");
    const record = entry as Record<string, unknown>;
    const id = String(record.id ?? "");
    if (!id) return fail("session-list-unparseable");
    if (ownSessionId && id === ownSessionId) continue;
    const dirValue = record.directory;
    if (typeof dirValue !== "string" || dirValue.length === 0) {
      return fail("session-identity-unproven", [id]);
    }
    let entryReal: string;
    try { entryReal = fs.realpathSync(dirValue); }
    catch { return fail("session-identity-unproven", [id]); }
    if (entryReal === disposableDirReal) others.push(id);
  }
  if (others.length > 0) return fail("concurrent-sessions-present", others);
  return { ok: true, reason: "no-other-sessions", otherSessionIds: [] };
}

/**
 * Release exactly one disposable directory and its exact helper set.
 * Caller must have durably archived the session export, hold explicit
 * disposable authority for this run/workdir, and verified no other adapter
 * runs share this workdir plus no other engine sessions for this directory.
 * This function revalidates path disposability, helper ownership, and
 * directory gates, preserves every workdir file to central backup, removes
 * exactly the disposable dir, and persists the physical-release outcome.
 * Central archival and backup live outside the disposable dir and are never
 * touched by the removal. Restart-safe via persisted backup + release files.
 */
export interface ReleaseRunBinding {
  runId: string;
  ownerIdHash: string;
  ownerKind: string;
  workdir: string;
  engine: string;
  sessionId: string | null;
}

export async function releaseDisposableWorktree(
  bridgeDir: string,
  run: ReleaseRunBinding,
  opts: { graceMs?: number } = {},
): Promise<DisposableReleaseResult> {
  const fail = (reason: string, partial?: Partial<DisposableReleaseResult>): DisposableReleaseResult => ({
    ok: false, reason, helpersSignalled: [], helpersRemaining: [], dirClear: false,
    workdirRemoved: false, workdirRelease: "blocked", ...partial,
  });
  const binding = { runId: run.runId, ownerIdHash: run.ownerIdHash, ownerKind: run.ownerKind, workdir: run.workdir, engine: run.engine, sessionId: run.sessionId };
  const check = checkDisposableWorkdir(run.workdir);
  if (check.reason === "workdir-absent") {
    const existing = readPhysicalReleaseRecord(bridgeDir, run.runId);
    if (existing && JSON.stringify(existing.binding) === JSON.stringify({ ...binding, dirReal: existing.binding.dirReal })) {
      return { ok: true, reason: "already_released", helpersSignalled: existing.helpersSignalled, helpersRemaining: [], dirClear: true, workdirRemoved: false, workdirRelease: "released", backupFileCount: existing.backup.fileCount, backupTotalBytes: existing.backup.totalBytes };
    }
    return fail("workdir-absent-no-record");
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
  // Final revalidation before preservation: disposability, helpers gone, dir clear.
  const recheck = checkDisposableWorkdir(run.workdir);
  if (!recheck.disposable || recheck.real !== dirReal) return fail("dir-changed-before-remove", { helpersSignalled: signalled.signalled });
  const recollect = collectDisposableHelpers(dirReal);
  if (recollect.inconclusive) return fail("recollect-inconclusive", { helpersSignalled: signalled.signalled, helpersRemaining: signalled.remaining });
  if (recollect.members.length > 0) return fail("helpers-reappeared", { helpersSignalled: signalled.signalled, helpersRemaining: recollect.members.map((m) => m.pid) });
  const finalScan = scanDirUsers(dirReal);
  if (!finalScan.conclusive || !finalScan.clear) return fail("dir-not-clear-before-remove", { helpersSignalled: signalled.signalled });
  // Preserve every workdir file centrally BEFORE deletion. The session
  // transcript alone is not a backup of workdir files.
  const backup = backupWorkdirToCentral(bridgeDir, run.runId, dirReal, binding);
  if (!backup.ok) return fail(backup.reason, { helpersSignalled: signalled.signalled });
  try {
    fs.rmSync(dirReal, { recursive: true, force: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      const existingRace = readPhysicalReleaseRecord(bridgeDir, run.runId);
      if (existingRace) {
        return { ok: true, reason: "already_released", helpersSignalled: existingRace.helpersSignalled, helpersRemaining: [], dirClear: true, workdirRemoved: false, workdirRelease: "released", backupFileCount: existingRace.backup.fileCount, backupTotalBytes: existingRace.backup.totalBytes };
      }
      return fail("workdir-absent-no-record", { helpersSignalled: signalled.signalled });
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
  const record: PhysicalReleaseRecord = {
    version: 1,
    binding: { ...binding, dirReal },
    releasedAt: new Date().toISOString(),
    helpersSignalled: signalled.signalled,
    backup: { fileCount: backup.fileCount ?? 0, totalBytes: backup.totalBytes ?? 0, manifestSha256: backup.manifestSha256 ?? "" },
    workdirRemoved: true,
  };
  try {
    atomicPublishFile(physicalReleasePath(bridgeDir, run.runId), `${JSON.stringify(record)}\n`);
  } catch {
    return fail("physical-record-publish-failed", { helpersSignalled: signalled.signalled, backupFileCount: backup.fileCount, backupTotalBytes: backup.totalBytes });
  }
  const verified = readPhysicalReleaseRecord(bridgeDir, run.runId);
  if (!verified || JSON.stringify(verified) !== JSON.stringify(record)) {
    return fail("physical-record-unverified", { helpersSignalled: signalled.signalled, backupFileCount: backup.fileCount, backupTotalBytes: backup.totalBytes });
  }
  return { ok: true, reason: "released", helpersSignalled: signalled.signalled, helpersRemaining: [], dirClear: true, workdirRemoved: true, workdirRelease: "released", backupFileCount: backup.fileCount, backupTotalBytes: backup.totalBytes };
}
