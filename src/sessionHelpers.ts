import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isProcessIdentityAlive, readProcessStartTime } from "./delegationEngines.js";

/**
 * Retirement of service-owned per-project MCP helper processes.
 *
 * Proven lifecycle (live evidence 2026-10-05, opencode v2.0.22 + codegraph):
 * `opencode run --standalone` turns EAGERLY spawn one `codegraph serve --mcp`
 * helper per project directory, parented to the long-lived background
 * `opencode serve --service` daemon — NOT to the standalone private-server
 * tree. The helper persists after the turn ends AND after
 * `opencode session delete <id>` (the record goes, the process stays; the
 * service reuses it for later sessions in the same directory, so at most one
 * helper per project directory accumulates). `cancelOwnedTree` therefore
 * provably never covers these helpers: they live outside every run-owned
 * tree.
 *
 * Because one helper is SHARED by every session in its project directory
 * (proven: a second turn with a new session id reused the surviving helper),
 * retirement is permitted ONLY under the explicit terminal condition
 * enforced by retireSessionWorkdir:
 *   1. the caller proves terminal run state (state in the caller-supplied
 *      terminal set — success/failure/timeout/cancel — never a live turn);
 *   2. the session record is exported (preserved) then deleted via the
 *      supported session API;
 *   3. `session list` for the project shows NO other session (engine-native
 *      proof no concurrent/resumable session needs the helper);
 *   4. the service pid is identity-bound (argv shape + live starttime);
 *   5. helpers are collected by (service-parent + argv shape + strict
 *      containment), descendants only through a revalidated parent chain;
 *   6. signalling revalidates every identity (double read) and the directory
 *      gate requires zero live users and zero SUSPECT unknowns (stat- or
 *      cwd-unreadable pids that cannot be excluded by readable cmdline
 *      evidence; kernel threads and cmdline-identified system binaries are
 *      reported, not blocking — permission-denied reads never become proof).
 * The routine NEVER deletes the directory itself: the caller deletes only
 * when the returned receipt reports clear. Ordinary turn completion,
 * follow-up, and concurrent sessions always fail one of the gates.
 *
 * Identity rule (all required, never cwd alone): live-verified service ppid,
 * exact argv shape, strict realpath containment, starttime bound at snapshot
 * and revalidated before any signal. Anything unprovable — including
 * permission-denied /proc reads — fails closed and is reported, never
 * treated as absence.
 */

export interface ServiceHelperIdentity {
  pid: number;
  ppid: number;
  startTime: string;
  cwd: string;
  argv: string[];
}

export interface ServiceHelperMember {
  pid: number;
  startTime: string;
}

const NODE_BASENAME_RE = /^(node|nodejs)(\.exe)?$/i;
const CODEGRAPH_PROGRAM_RE = /(^|\/)codegraph(\.js)?$/;

/** Exact argv shape of a codegraph MCP server launch (wrapper or engine). */
export function isCodegraphMcpArgv(argv: readonly string[]): boolean {
  if (!Array.isArray(argv) || argv.length < 3 || argv.length > 8) return false;
  const head = String(argv[0] ?? "");
  if (!NODE_BASENAME_RE.test(path.basename(head))) return false;
  const progIndex = argv.findIndex(
    (token, index) => index > 0 && CODEGRAPH_PROGRAM_RE.test(String(token ?? ""))
  );
  if (progIndex < 0) return false;
  return (
    String(argv[progIndex + 1] ?? "") === "serve" &&
    String(argv[progIndex + 2] ?? "") === "--mcp" &&
    progIndex + 3 === argv.length
  );
}

/** `opencode session export <id>` argv (record preservation before delete). */
export function buildSessionExportArgv(sessionId: string): string[] {
  return ["session", "export", String(sessionId ?? "").trim()];
}

/** `opencode session delete <id>` argv (record removal; does NOT reap helpers). */
export function buildSessionDeleteArgv(sessionId: string): string[] {
  return ["session", "delete", String(sessionId ?? "").trim()];
}

/** `opencode session list --format json` argv (concurrent-session proof). */
export function buildSessionListArgv(maxCount = 100): string[] {
  const n = Number.isSafeInteger(maxCount) && maxCount > 0 ? Math.min(maxCount, 1000) : 100;
  return ["session", "list", "--format", "json", "--max-count", String(n)];
}

/** Strict containment: candidate must equal dir or live under it (separator boundary). */
export function isStrictlyUnderDir(dirReal: string, candidate: string): boolean {
  if (!dirReal || !candidate) return false;
  if (candidate === dirReal) return true;
  return candidate.startsWith(dirReal.endsWith(path.sep) ? dirReal : dirReal + path.sep);
}

function readProcArgv(pid: number): string[] | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return undefined;
  }
  const parts = raw.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function readProcCwd(pid: number): string | undefined {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

function readProcPpid(pid: number): number | undefined {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
}

/**
 * Snapshot read with binding: all four fields are read, then the starttime
 * is re-read and must still match. A PID recycled mid-read fails. Returns
 * undefined for anything unprovable (non-Linux, gone, unreadable).
 */
export function readServiceHelperIdentity(pid: number): ServiceHelperIdentity | undefined {
  if (process.platform !== "linux") return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const startTime = readProcessStartTime(pid);
  const ppid = readProcPpid(pid);
  const cwd = readProcCwd(pid);
  const argv = readProcArgv(pid);
  if (startTime === null || ppid === undefined || cwd === undefined || argv === undefined) return undefined;
  if (readProcessStartTime(pid) !== startTime) return undefined;
  return { pid, ppid, startTime, cwd, argv };
}

/**
 * Resolve the live opencode background-service pid by exact argv shape
 * (`<opencode-binary> serve --service`). Returns null when zero or several
 * match (ambiguity fails closed). `binaryBasename` defaults to "opencode".
 */
export function resolveOpenCodeServicePid(binaryBasename = "opencode"): number | null {
  if (process.platform !== "linux") return null;
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const hits: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const argv = readProcArgv(pid);
    if (!argv || argv.length !== 3) continue;
    if (path.basename(String(argv[0] ?? "")) !== binaryBasename) continue;
    if (String(argv[1] ?? "") !== "serve" || String(argv[2] ?? "") !== "--service") continue;
    if (readProcessStartTime(pid) === null) continue;
    hits.push(pid);
  }
  return hits.length === 1 ? (hits[0] as number) : null;
}

/**
 * Seed predicate: service-owned MCP helper pinned under the retired dir.
 * `retiredDirReal` must already be realpath'd by the caller. Never cwd-only:
 * ppid, argv shape, and containment must ALL hold (starttime is captured for
 * later revalidation, not trusted here).
 */
export function isRetirableHelperSeed(
  info: ServiceHelperIdentity,
  servicePid: number,
  retiredDirReal: string
): boolean {
  if (!Number.isSafeInteger(servicePid) || servicePid <= 0) return false;
  if (!retiredDirReal) return false;
  if (info.ppid !== servicePid) return false;
  if (!isCodegraphMcpArgv(info.argv)) return false;
  if (!isStrictlyUnderDir(retiredDirReal, info.cwd)) return false;
  return true;
}

export interface ServiceHelperCollection {
  members: ServiceHelperMember[];
  servicePid: number;
  serviceStartTime: string;
  /** True when collection was unprovable: retire nothing. */
  inconclusive: boolean;
  reason?: string;
}

/**
 * Collect the exact helper set pinned under a retired directory: shape +
 * service-parent matched seeds, plus descendants adopted only through a
 * parent chain that revalidates BOTH the parent baseline AND the child's
 * current (ppid, starttime) relationship at adoption time. The service
 * identity is captured before AND after the scan; any change (or unreadable
 * scan root) makes the whole collection inconclusive — a stale service must
 * never admit replacement members.
 */
export function collectServiceHelpers(servicePid: number, retiredDir: string): ServiceHelperCollection {
  const inconclusive = (reason: string): ServiceHelperCollection => ({
    members: [],
    servicePid,
    serviceStartTime: "",
    inconclusive: true,
    reason
  });
  if (process.platform !== "linux") return inconclusive("non-linux");
  if (!Number.isSafeInteger(servicePid) || servicePid <= 0) return inconclusive("bad-service-pid");
  const serviceBefore = readProcessStartTime(servicePid);
  if (serviceBefore === null) return inconclusive("service-unreadable");
  let dirReal: string;
  try {
    dirReal = fs.realpathSync(retiredDir);
  } catch {
    return inconclusive("dir-unresolvable");
  }
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return inconclusive("proc-unreadable");
  }
  const identities = new Map<number, ServiceHelperIdentity>();
  const byParent = new Map<number, number[]>();
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const info = readServiceHelperIdentity(pid);
    if (!info) continue;
    identities.set(pid, info);
    const list = byParent.get(info.ppid) ?? [];
    list.push(pid);
    byParent.set(info.ppid, list);
  }
  if (readProcessStartTime(servicePid) !== serviceBefore) return inconclusive("service-changed-during-scan");
  const members = new Map<number, string>();
  const pending: number[] = [];
  for (const [pid, info] of identities) {
    if (isRetirableHelperSeed(info, servicePid, dirReal)) {
      members.set(pid, info.startTime);
      pending.push(pid);
    }
  }
  while (pending.length > 0) {
    const parent = pending.shift() as number;
    const parentBaseline = members.get(parent);
    if (parentBaseline === undefined) continue;
    if (readProcessStartTime(parent) !== parentBaseline) continue;
    for (const child of byParent.get(parent) ?? []) {
      if (members.has(child)) continue;
      const scanned = identities.get(child);
      if (!scanned) continue;
      // Revalidate BOTH sides at adoption: parent baseline (above) plus the
      // child's CURRENT relationship (ppid now, starttime now).
      if (readProcPpid(child) !== parent) continue;
      const childNow = readProcessStartTime(child);
      if (childNow === null || childNow !== scanned.startTime) continue;
      members.set(child, scanned.startTime);
      pending.push(child);
    }
  }
  if (readProcessStartTime(servicePid) !== serviceBefore) return inconclusive("service-changed-during-adopt");
  return {
    members: [...members].map(([pid, startTime]) => ({ pid, startTime })),
    servicePid,
    serviceStartTime: serviceBefore,
    inconclusive: false
  };
}

export interface DirUserScan {
  clear: boolean;
  /** Live pids currently holding cwd under the dir. */
  users: number[];
  /**
   * BLOCKING pids: stat-unreadable-but-present, or cwd-unreadable with a
   * delegation-related cmdline (or no readable cmdline at all). A failed
   * gate reports them; they never become affirmative proof of absence.
   */
  suspectUnknown: number[];
  /**
   * REPORTED, non-blocking: cwd-unreadable pids whose readable cmdline
   * identifies a system binary with no relation to the retired dir
   * (e.g. init/systemd/snapfuse). Listed with evidence, never silently
   * skipped: fully-unreadable pids land in suspectUnknown instead.
   */
  systemUnrelated: { pid: number; cmd: string }[];
  /** False only when /proc itself or the dir was unreadable. */
  conclusive: boolean;
}

const RELATED_BINARIES_RE = /(^|\/)(node|nodejs|opencode|codex|claude|codegraph)(\.exe|\.js)?$/i;

/** True when a readable cmdline suggests any relation to the retired dir. */
export function cmdlineSuggestsRelation(argv: readonly string[], dirReal: string): boolean {
  for (const token of argv) {
    const text = String(token ?? "");
    if (!text) continue;
    if (RELATED_BINARIES_RE.test(text)) return true;
    if (dirReal && text.includes(dirReal)) return true;
  }
  return false;
}

/** Process-existence arbiter without privilege: ESRCH = gone, EPERM/ok = present. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ESRCH") return false;
    return true;
  }
}

/**
 * Pre-delete gate over a realpath'd directory. clear is true ONLY when the
 * scan was conclusive, zero live users were found, and zero pids were
 * suspect. Kernel threads (empty cmdline: no userspace mm, cannot hold a
 * cwd) and cmdline-identified system binaries unrelated to the dir are
 * reported, not blocking; EVERYTHING else unreadable blocks.
 */
export function scanDirUsers(dir: string): DirUserScan {
  const fail = (): DirUserScan => ({ clear: false, users: [], suspectUnknown: [], systemUnrelated: [], conclusive: false });
  if (process.platform !== "linux") return fail();
  let dirReal: string;
  try {
    dirReal = fs.realpathSync(dir);
  } catch {
    return fail();
  }
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return fail();
  }
  const users: number[] = [];
  const suspectUnknown: number[] = [];
  const systemUnrelated: { pid: number; cmd: string }[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (readProcessStartTime(pid) === null) {
      if (processExists(pid)) suspectUnknown.push(pid);
      continue;
    }
    const argv = readProcArgv(pid);
    if (argv === undefined) {
      // No cmdline: kernel thread (cannot hold cwd) only if the process is
      // otherwise unobservable; a readable stat with unreadable cmdline on a
      // userspace process is suspect.
      suspectUnknown.push(pid);
      continue;
    }
    if (argv.length === 0) continue; // Kernel thread: no cwd by construction.
    const cwd = readProcCwd(pid);
    if (cwd !== undefined) {
      if (isStrictlyUnderDir(dirReal, cwd)) users.push(pid);
      continue;
    }
    if (cmdlineSuggestsRelation(argv, dirReal)) {
      suspectUnknown.push(pid);
      continue;
    }
    const cmd = argv.slice(0, 4).join(" ").slice(0, 120);
    systemUnrelated.push({ pid, cmd });
  }
  return {
    clear: users.length === 0 && suspectUnknown.length === 0,
    users,
    suspectUnknown,
    systemUnrelated,
    conclusive: true
  };
}

export interface ServiceHelperSignalResult {
  signalled: number[];
  remaining: number[];
  retiredDirClear: boolean;
  dirScan: DirUserScan;
}

/**
 * Identity-checked SIGTERM of EXACTLY the collected members: the service
 * identity revalidates first (a stale/changed service admits nothing), then
 * each member revalidates by double read. No SIGKILL escalation: survivors
 * stay listed in `remaining` and forbid directory deletion; escalation
 * against service-owned processes needs fresh owner approval (a trap-ignoring
 * holder therefore fail-closes instead of being force-killed).
 *
 * Async with real settle sleeps (mirroring cancelOwnedTree): the event loop
 * must turn so SIGCHLD reaping can land, otherwise signalled children linger
 * as same-identity zombies and every liveness check lies. Grace-bounded
 * settle loop (default 2000ms, capped 10000ms), then one final verify.
 *
 * Fail-closed zombie note: a SIGTERM'd member whose parent has not reaped it
 * yet still shows its baseline starttime (state Z) and therefore still
 * counts as remaining. That blocks directory deletion until the owning
 * parent reaps — the safe direction. The opencode background service reaps
 * promptly in practice (observed 2026-10-05: no zombies left behind).
 */
export async function signalServiceHelpers(
  collection: ServiceHelperCollection,
  retiredDir: string,
  graceMs = 2000
): Promise<ServiceHelperSignalResult> {
  const empty = (dirScan: DirUserScan): ServiceHelperSignalResult => ({
    signalled: [],
    remaining: collection.members.map((m) => m.pid),
    retiredDirClear: false,
    dirScan
  });
  const scan = scanDirUsers(retiredDir);
  if (collection.inconclusive) return empty(scan);
  if (process.platform !== "linux") return empty(scan);
  if (!isProcessIdentityAlive(collection.servicePid, collection.serviceStartTime)) return empty(scan);
  const signalled: number[] = [];
  for (const member of collection.members) {
    if (!Number.isSafeInteger(member.pid) || member.pid <= 0) continue;
    if (!member.startTime) continue;
    if (!isProcessIdentityAlive(member.pid, member.startTime)) continue;
    if (readProcessStartTime(collection.servicePid) !== collection.serviceStartTime) {
      break;
    }
    try {
      process.kill(member.pid, "SIGTERM");
      signalled.push(member.pid);
    } catch {
      // Exited between revalidation and signal; verify pass decides.
    }
  }
  const stillOwned = (pid: number): boolean => {
    const baseline = collection.members.find((m) => m.pid === pid)?.startTime;
    if (!baseline) return false;
    return readProcessStartTime(pid) === baseline;
  };
  const deadline = Date.now() + Math.max(0, Math.min(graceMs, 10_000));
  let remaining = collection.members.map((m) => m.pid).filter(stillOwned);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleepMs(50);
    remaining = collection.members.map((m) => m.pid).filter(stillOwned);
  }
  const dirScan = scanDirUsers(retiredDir);
  return {
    signalled,
    remaining,
    retiredDirClear: remaining.length === 0 && dirScan.clear,
    dirScan
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RetireTerminalEvidence {
  /** Run state asserted terminal by the caller (success/failure/timeout/cancel). */
  state: string;
  /** Caller-supplied terminal set; the state must be a member. */
  terminalStates: readonly string[];
}

export interface RetireSessionWorkdirOptions {
  opencodeBin: string;
  /** Project directory being retired (must exist; caller deletes only on clear). */
  workdir: string;
  sessionId: string;
  terminal: RetireTerminalEvidence;
  timeoutMs?: number;
  /**
   * Test/fixture override for the service pid. Production call sites MUST
   * omit it so the live service resolves by argv shape + starttime. When set,
   * the value is still liveness-checked (dead pid aborts).
   */
  servicePid?: number;
}

export interface RetireSessionWorkdirResult {
  ok: boolean;
  reason: string;
  exported: boolean;
  sessionDeleted: boolean;
  sessionsRemaining: string[];
  helpersSignalled: number[];
  helpersRemaining: number[];
  dirClear: boolean;
  /** Blocking unknowns (stat-unreadable-but-present or related-cmdline). */
  suspectUnknownPids: number[];
  /** Count of cmdline-identified system pids reported, not blocking. */
  systemUnrelatedCount: number;
}

interface EngineCall {
  status: number | null;
  stdout: string;
}

function callEngine(bin: string, argv: string[], workdir: string, timeoutMs: number): EngineCall {
  try {
    const result = spawnSync(bin, argv, {
      cwd: workdir,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      env: { ...process.env, NO_COLOR: "1" }
    });
    return { status: result.status, stdout: String(result.stdout ?? "") };
  } catch {
    return { status: null, stdout: "" };
  }
}

function parseSessionIds(stdoutText: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(String(stdoutText ?? ""));
    if (!Array.isArray(parsed)) return null;
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === "object" && entry !== null) {
        const id = String((entry as Record<string, unknown>).id ?? "");
        if (id) ids.push(id);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/**
 * Terminal workdir retirement through the supported engine surface plus
 * identity-bound helper release. Enforces, in order:
 *   0. terminal-state gate (non-terminal states refuse before any spawn);
 *   1. session export (record preservation; failure aborts);
 *   2. session delete (record removal; failure aborts);
 *   3. session-list proof of no concurrent session (any OTHER id aborts);
 *   4. identity-bound service resolution (ambiguous service aborts);
 *   5. helper collect + signal + verify (inconclusive/remaining aborts);
 *   6. directory gate (users or unknowns abort).
 * NEVER deletes the directory: ok=true with dirClear=true authorizes the
 * caller to delete exactly `workdir`; anything else forbids deletion.
 */
export async function retireSessionWorkdir(opts: RetireSessionWorkdirOptions): Promise<RetireSessionWorkdirResult> {
  const fail = (
    reason: string,
    partial?: Partial<RetireSessionWorkdirResult>
  ): RetireSessionWorkdirResult => ({
    ok: false,
    reason,
    exported: false,
    sessionDeleted: false,
    sessionsRemaining: [],
    helpersSignalled: [],
    helpersRemaining: [],
    dirClear: false,
    suspectUnknownPids: [],
    systemUnrelatedCount: 0,
    ...partial
  });
  const bin = String(opts.opencodeBin ?? "").trim();
  const workdir = String(opts.workdir ?? "");
  const sessionId = String(opts.sessionId ?? "").trim();
  const state = String(opts.terminal?.state ?? "");
  const terminalStates = Array.isArray(opts.terminal?.terminalStates) ? opts.terminal.terminalStates : [];
  if (!bin || !workdir || !sessionId) return fail("invalid-input");
  if (!terminalStates.includes(state)) return fail(`non-terminal-state:${state || "(empty)"}`);
  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 20_000, 60_000));

  const exported = callEngine(bin, buildSessionExportArgv(sessionId), workdir, timeoutMs);
  if (exported.status !== 0) return fail("export-failed");
  const deleted = callEngine(bin, buildSessionDeleteArgv(sessionId), workdir, timeoutMs);
  if (deleted.status !== 0) return fail("session-delete-failed", { exported: true });

  const listed = callEngine(bin, buildSessionListArgv(), workdir, timeoutMs);
  if (listed.status !== 0) return fail("session-list-failed", { exported: true, sessionDeleted: true });
  const ids = parseSessionIds(listed.stdout);
  if (ids === null) return fail("session-list-unparseable", { exported: true, sessionDeleted: true });
  const others = ids.filter((id) => id !== sessionId);
  if (others.length > 0) {
    return fail("concurrent-sessions-present", {
      exported: true,
      sessionDeleted: true,
      sessionsRemaining: others
    });
  }

  const servicePid = opts.servicePid ?? resolveOpenCodeServicePid();
  if (servicePid === null || servicePid === undefined) {
    return fail("service-unresolvable", { exported: true, sessionDeleted: true, sessionsRemaining: [] });
  }
  if (readProcessStartTime(servicePid) === null) {
    return fail("service-unresolvable", { exported: true, sessionDeleted: true, sessionsRemaining: [] });
  }
  const collected = collectServiceHelpers(servicePid, workdir);
  if (collected.inconclusive) {
    return fail(`collect-inconclusive:${collected.reason ?? "unknown"}`, {
      exported: true,
      sessionDeleted: true,
      sessionsRemaining: []
    });
  }
  const signalled = await signalServiceHelpers(collected, workdir);
  const dirScan = signalled.dirScan;
  if (!signalled.retiredDirClear) {
    return fail("helpers-or-dir-not-clear", {
      exported: true,
      sessionDeleted: true,
      sessionsRemaining: [],
      helpersSignalled: signalled.signalled,
      helpersRemaining: signalled.remaining,
      dirClear: signalled.retiredDirClear,
      suspectUnknownPids: [...dirScan.users, ...dirScan.suspectUnknown],
      systemUnrelatedCount: dirScan.systemUnrelated.length
    });
  }
  const finalScan = scanDirUsers(workdir);
  return {
    ok: true,
    reason: "retired",
    exported: true,
    sessionDeleted: true,
    sessionsRemaining: [],
    helpersSignalled: signalled.signalled,
    helpersRemaining: [],
    dirClear: true,
    suspectUnknownPids: [],
    systemUnrelatedCount: finalScan.systemUnrelated.length
  };
}
