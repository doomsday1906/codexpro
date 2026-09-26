const WINDOWS_PROCESS_SNAPSHOT = 'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }';

export function processTableInvocation(platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SNAPSHOT]
    };
  }
  return { command: 'ps', args: ['-A', '-o', 'pid=,ppid='] };
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

export function processTreeTerminationInvocation(platform, pid) {
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return {
    command: 'taskkill.exe',
    args: ['/PID', String(pid), '/T', '/F']
  };
}
