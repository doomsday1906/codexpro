import fs from 'node:fs';

const WINDOWS_PROCESS_SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }';

// Windows identity snapshot: ProcessId + ParentProcessId + CreationDate.
// CreationDate is the only cheap per-process birth marker Win32_Process
// exposes. CIM timestamp granularity plus snapshot TOCTOU mean this check
// NARROWS but cannot fully prove identity on Windows: callers must still
// signal only the directly-owned child plus snapshot-verified descendants and
// must never broaden to pattern sweeps. taskkill /T /F alone is not identity
// proof.
const WINDOWS_PROCESS_IDENTITY_SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1} {2:yyyyMMddHHmmssffffff}" -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate }';

export function processTableInvocation(platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SNAPSHOT]
    };
  }
  return { command: 'ps', args: ['-A', '-o', 'pid=,ppid='] };
}

export function processIdentityTableInvocation(platform = process.platform) {
  if (platform !== 'win32') return null;
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_IDENTITY_SNAPSHOT]
  };
}

export function parseProcessTable(output) {
  return String(output ?? '').split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) return [];
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) return [];
    return [{ pid, parentPid }];
  });
}

export function parseProcessIdentityTable(output) {
  return String(output ?? '').split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) return [];
    const pid = Number(fields[0]);
    const parentPid = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) return [];
    const creationDate = fields.length >= 3 ? String(fields[2]) : '';
    return [{ pid, parentPid, creationDate }];
  });
}

export function descendantProcessIds(processes, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return [];
  const childrenByParent = new Map();
  for (const process of processes ?? []) {
    if (!process || !Number.isSafeInteger(process.pid) || !Number.isSafeInteger(process.parentPid)) continue;
    const children = childrenByParent.get(process.parentPid) ?? [];
    children.push(process.pid);
    childrenByParent.set(process.parentPid, children);
  }

  const found = new Set();
  const pending = [rootPid];
  while (pending.length) {
    const parentPid = pending.shift();
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      if (found.has(childPid) || childPid === rootPid) continue;
      found.add(childPid);
      pending.push(childPid);
    }
  }
  return [...found];
}

// Linux process birth marker: field 22 (starttime, clock ticks since boot) of
// /proc/<pid>/stat. Combined with the PID it identifies a specific process
// incarnation, so a recycled PID cannot verify against a stale baseline.
// Returns the starttime token string, or null when unreadable (not Linux,
// process gone, /proc unavailable). Null means "identity unprovable": callers
// must NOT signal that PID as a descendant (fail closed).
export function readLinuxProcessStartTime(pid, platform = process.platform) {
  if (platform !== 'linux') return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let text = '';
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // comm (field 2) is parenthesized and may contain spaces/parens: split after
  // the LAST ')', so fields[0] is state (field 3) and starttime (field 22) is
  // fields[19].
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20) return null;
  const starttime = fields[19];
  if (!/^\d+$/.test(starttime ?? '')) return null;
  return starttime;
}

// Capture the identity baseline for a PID at first observation. The baseline
// is only meaningful when startTime is non-null.
export function captureProcessIdentity(pid, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, startTime: readLinuxProcessStartTime(pid, platform) };
}

// Revalidate that `pid` still refers to the process incarnation described by
// `expected` (a baseline from captureProcessIdentity or an earlier read).
// Returns true only when both sides carry a readable starttime and they match.
// Any unreadable side returns false: unverifiable PIDs are never signalled.
// On non-Linux platforms this always returns false because no cheap birth
// marker exists here; Windows callers must use the CIM identity snapshot
// (parseProcessIdentityTable) with its documented granularity limitation and
// keep signalling narrowed to the directly-owned child plus verified
// descendants.
export function verifyProcessIdentity(pid, expected, platform = process.platform) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!expected || expected.pid !== pid) return false;
  if (platform !== 'linux') return false;
  const baseline = expected.startTime;
  if (baseline == null) return false;
  const current = readLinuxProcessStartTime(pid, platform);
  if (current == null) return false;
  return current === baseline;
}

export function processTreeTerminationInvocation(platform, pid) {
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    command: 'taskkill.exe',
    args: ['/PID', String(pid), '/T', '/F']
  };
}

// Windows root-taskkill identity gate (pure): decides whether taskkill /T /F
// may target the root PID. Callers supply the spawn-time CreationDate baseline
// (null when the spawn snapshot was unavailable or the PID was not yet visible
// in it: identity unprovable), the fresh pre-kill CreationDate observed for the
// root PID (null when the snapshot is unavailable or the PID is absent), and
// whether the directly-owned child has exited.
// Only an exact baseline-vs-current match on a live child proceeds. Every
// other case — exited child (POSIX exit-guard parity: never signal an exited
// child), unprovable spawn baseline, absent/unavailable current value, or
// mismatch (PID reuse) — refuses the root signal; the caller must then reap
// only snapshot-verified descendants or report incomplete cleanup.
// Honest limitation: CIM CreationDate granularity plus snapshot TOCTOU mean a
// PID recycled inside the same timestamp window cannot be fully excluded, so
// this gate NARROWS but cannot prove identity alone. Pure and platform-free so
// it is unit-testable on any host with mocked CIM rows; live taskkill/CIM
// execution itself remains Windows-only.
export function windowsRootTaskkillDecision(spawnCreationDate, currentCreationDate, childExited) {
  if (childExited) return { proceed: false, reason: 'CHILD_EXITED' };
  if (!spawnCreationDate) return { proceed: false, reason: 'SPAWN_IDENTITY_UNPROVABLE' };
  if (!currentCreationDate) return { proceed: false, reason: 'ROOT_IDENTITY_ABSENT' };
  if (currentCreationDate !== spawnCreationDate) return { proceed: false, reason: 'ROOT_IDENTITY_MISMATCH' };
  return { proceed: true, reason: 'IDENTITY_VERIFIED' };
}
