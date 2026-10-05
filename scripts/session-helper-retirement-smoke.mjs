#!/usr/bin/env node
// session-helper retirement acceptance (root repair A).
// Proves the ORDINARY INTEGRATED lifecycle, not just the helper function:
// terminal-gated retirement through the supported session API
// (export/delete/list) plus identity-bound helper release, with engine-native
// concurrent-session proof. No live model calls, no real sessions touched:
// a fake `opencode` shim (state-backed export/delete/list) and fake service
// trees (real argv shapes, synthetic pids only) under os.tmpdir fixtures.
//
// T1 terminal success -> full retirement (helpers gone, gate clear).
// T2 non-terminal state -> refused BEFORE any engine spawn.
// T3 terminal variants (failed/timed_out/cancelled) -> each accepted.
// T4/T9 concurrent session in same dir -> refused, helper+dir untouched.
// T5 session-delete failure -> refused before collect, helpers alive.
// T6 unkillable holder -> fail-closed, no deletion authorized.
// T7 stale service/member identities -> collect inconclusive / signal empty.
// T8 repeated full cycles -> identical results, no cross-talk.
// T10 live-service integration (no override): resolves the real daemon,
//     retires nothing (synthetic empty dir), daemon child set unchanged.
// S1/S2 pure argv/predicate unit checks. S5 resolver checks.
//
// Cleanup is airtight: every synthetic pid is baseline-tracked and reaped in
// `finally` (TERM, then SIGKILL escalation over survivors); leftovers fail
// the run. Temp bases are removed in finally. Bounded: <=5 synthetic
// processes per case, sequential cases, sleeps <= 55s but always reaped.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
const toUrl = (p) => `file://${p}`;
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

const mod = await import(toUrl(path.join(ROOT, 'dist', 'sessionHelpers.js')));
for (const fn of ['buildSessionExportArgv', 'buildSessionDeleteArgv', 'buildSessionListArgv',
  'isCodegraphMcpArgv', 'isStrictlyUnderDir', 'isRetirableHelperSeed',
  'resolveOpenCodeServicePid', 'collectServiceHelpers', 'signalServiceHelpers',
  'scanDirUsers', 'retireSessionWorkdir']) {
  assert(typeof mod[fn] === 'function', `export ${fn}`);
}

// ---------- proc helpers ----------
function readStart(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch { return null; }
}
function readPpid(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : null;
  } catch { return null; }
}
function readCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}
function readArgv(pid) {
  try {
    const parts = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts.length > 0 ? parts : null;
  } catch { return null; }
}
const aliveAs = (pid, baseline) => baseline !== null && readStart(pid) === baseline;

// ---------- airtight cleanup ----------
const owned = new Map(); // pid -> baseline starttime
const bases = [];
const trackPid = (pid) => { const s = readStart(pid); if (s !== null) owned.set(pid, s); };
const savedEnv = { SHR_STATE: process.env.SHR_STATE, SHR_LOG: process.env.SHR_LOG, SHR_FAIL_DELETE: process.env.SHR_FAIL_DELETE };
async function cleanupAll() {
  for (const [pid, baseline] of [...owned]) {
    if (aliveAs(pid, baseline)) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  await sleepMs(700);
  for (const [pid, baseline] of [...owned]) {
    if (aliveAs(pid, baseline)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  await sleepMs(400);
  const leftovers = [...owned].filter(([pid, baseline]) => aliveAs(pid, baseline));
  for (const dir of bases.splice(0)) {
    try { await fsp.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  owned.clear();
  for (const key of ['SHR_STATE', 'SHR_LOG', 'SHR_FAIL_DELETE']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  assert(leftovers.length === 0, `cleanup leaked pids: ${leftovers.map(([p]) => p).join(',')}`);
}

// ---------- fixtures ----------
const nodeBin = process.execPath;
const TERMINALS = ['completed', 'failed', 'timed_out', 'cancelled'];
const termOpt = (state) => ({ state, terminalStates: TERMINALS });

async function writeShims(base, { failDelete = false, trapTerm = false } = {}) {
  const binDir = path.join(base, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const stateFile = path.join(base, 'sessions.txt');
  const logFile = path.join(base, 'calls.log');
  await fsp.writeFile(stateFile, '');
  await fsp.writeFile(logFile, '');
  const shim = path.join(binDir, 'opencode');
  await fsp.writeFile(shim,
    '#!/bin/sh\n' +
    'echo "opencode $*" >> "$' + 'SHR_LOG"\n' +
    'if [ "$1" = "session" ] && [ "$2" = "export" ]; then echo "{\\"id\\":\\"$3\\"}"; exit 0; fi\n' +
    'if [ "$1" = "session" ] && [ "$2" = "delete" ]; then\n' +
    '  if [ "$SHR_FAIL_DELETE" = "1" ]; then echo "denied" >&2; exit 1; fi\n' +
    '  grep -v -x "$3" "$SHR_STATE" > "$SHR_STATE.tmp" || true\n' +
    '  mv "$SHR_STATE.tmp" "$SHR_STATE"; echo "Session $3 deleted"; exit 0\n' +
    'fi\n' +
    'if [ "$1" = "session" ] && [ "$2" = "list" ]; then\n' +
    '  out="["; first=1\n' +
    '  while IFS= read -r id || [ -n "$id" ]; do\n' +
    '    case "$id" in ""|\\#*) continue;; esac\n' +
    '    if [ $first -eq 0 ]; then out="$out,"; fi; first=0\n' +
    '    out="$out{\\"id\\":\\"$id\\"}"\n' +
    '  done < "$SHR_STATE"\n' +
    '  echo "$out]"; exit 0\n' +
    'fi\n' +
    'exit 2\n');
  await fsp.chmod(shim, 0o755);
  const wrapperShim = path.join(binDir, 'codegraph');
  const engineShim = path.join(binDir, 'eng', 'codegraph.js');
  await fsp.mkdir(path.dirname(engineShim), { recursive: true });
  const seedBody = trapTerm
    ? `process.on('SIGTERM',()=>{});\nsetInterval(()=>{},60000);\n`
    : `const {spawn}=require('node:child_process');\nspawn('sleep',['50'],{stdio:'ignore'}).unref();\nsetInterval(()=>{},60000);\n`;
  await fsp.writeFile(wrapperShim, seedBody);
  await fsp.writeFile(engineShim, `setInterval(()=>{},60000);\n`);
  // Fake service as a node script (NOT sleep): libuv reaps exited children
  // via SIGCHLD exactly like the real opencode service, so signalled seeds
  // do not linger as zombies. A `sleep`-as-service fixture would leave
  // same-identity zombies and fail-closed the gate by design.
  const svcScript = path.join(base, 'fake-service.cjs');
  await fsp.writeFile(svcScript,
    `const {spawn}=require('node:child_process');\n` +
    `const [, , nodeBin, wrapper, engine, retired] = process.argv;\n` +
    `spawn(nodeBin, [wrapper, 'serve', '--mcp'], { cwd: retired, stdio: 'ignore' });\n` +
    `spawn(nodeBin, [engine, 'serve', '--mcp'], { cwd: retired, stdio: 'ignore' });\n` +
    `setInterval(()=>{},60000);\n`);
  return { shim, wrapperShim, engineShim, svcScript, stateFile, logFile };
}

async function makeCycle({ sessions, failDelete = false, trapTerm = false } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-shr-'));
  bases.push(base);
  const retired = path.join(base, 'retired');
  await fsp.mkdir(retired, { recursive: true });
  const fix = await writeShims(base, { failDelete, trapTerm });
  await fsp.writeFile(fix.stateFile, sessions.map((s) => `${s}\n`).join(''));
  const env = { ...process.env, SHR_STATE: fix.stateFile, SHR_LOG: fix.logFile, SHR_FAIL_DELETE: failDelete ? '1' : '' };
  // The retirement routine inherits process.env for engine spawns (mirroring
  // production, where the real binary reads its own state): publish this
  // cycle's shim state through process.env (restored in cleanupAll).
  process.env.SHR_STATE = fix.stateFile;
  process.env.SHR_LOG = fix.logFile;
  if (failDelete) process.env.SHR_FAIL_DELETE = '1';
  else delete process.env.SHR_FAIL_DELETE;
  const svc = spawn(nodeBin, [fix.svcScript, nodeBin, fix.wrapperShim, fix.engineShim, retired],
    { cwd: base, stdio: 'ignore', env });
  await sleepMs(1600);
  assert(svc.exitCode === null, 'fake service alive');
  trackPid(svc.pid);
  // Discover seeds: children of the fake service.
  const seeds = [];
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (readPpid(pid) === svc.pid) seeds.push(pid);
  }
  assert(seeds.length === 2, `two seeds parented to fake service, got ${seeds.length}`);
  for (const pid of seeds) trackPid(pid);
  const log = () => fs.readFileSync(fix.logFile, 'utf8');
  return { base, retired, svcPid: svc.pid, seeds, shim: fix.shim, stateFile: fix.stateFile, log, env };
}

const listState = (stateFile) => fs.readFileSync(stateFile, 'utf8').split('\n').filter(Boolean);

try {
  // ---------- S1/S2 pure ----------
  assert(JSON.stringify(mod.buildSessionExportArgv('s')) === '["session","export","s"]', 'export argv');
  assert(JSON.stringify(mod.buildSessionDeleteArgv('s')) === '["session","delete","s"]', 'delete argv');
  assert(JSON.stringify(mod.buildSessionListArgv()) === '["session","list","--format","json","--max-count","100"]', 'list argv');
  assert(mod.isCodegraphMcpArgv(['/u/bin/node', '/t/bin/codegraph', 'serve', '--mcp']), 'wrapper');
  assert(mod.isCodegraphMcpArgv(['/u/bin/node', '/t/eng/codegraph.js', 'serve', '--mcp']), 'engine');
  assert(!mod.isCodegraphMcpArgv(['/u/bin/node', '/t/eng-codegraph.js', 'serve', '--mcp']), 'reject lookalike program');
  assert(!mod.isCodegraphMcpArgv(['/u/bin/node', '/t/bin/codegraph', 'serve']), 'reject missing mcp');
  assert(!mod.isCodegraphMcpArgv(['/u/bin/python', '/t/bin/codegraph', 'serve', '--mcp']), 'reject non-node');
  assert(mod.isStrictlyUnderDir('/d', '/d/a') && !mod.isStrictlyUnderDir('/d', '/d-evil'), 'containment');
  console.log('S1/S2 ok');

  // ---------- T1 terminal success ----------
  {
    const c = await makeCycle({ sessions: ['ses_A'] });
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: 'ses_A', terminal: termOpt('completed'), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(r.ok && r.reason === 'retired', `T1 retired: ${JSON.stringify(r)}`);
    assert(r.exported && r.sessionDeleted && r.dirClear, 'T1 flags');
    assert(r.helpersSignalled.length === 3, `T1 triple (2 seeds + 1 descendant), got ${r.helpersSignalled.length}`);
    assert(listState(c.stateFile).length === 0, 'T1 record deleted');
    assert(c.log().includes('session export ses_A') && c.log().includes('session delete ses_A') && c.log().includes('session list'), 'T1 engine sequence');
    assert(fs.existsSync(c.retired), 'T1 routine never deletes the dir itself');
    assert(readStart(c.svcPid) !== null, 'T1 service survives');
    console.log('T1 ok: terminal success retires exact triple');
  }

  // ---------- T2 non-terminal refused pre-spawn ----------
  {
    const c = await makeCycle({ sessions: ['ses_B'] });
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: 'ses_B', terminal: termOpt('running'), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(!r.ok && r.reason.startsWith('non-terminal-state'), `T2 refused: ${r.reason}`);
    assert(c.log() === '', 'T2 zero engine spawns');
    assert(listState(c.stateFile).join() === 'ses_B', 'T2 record untouched');
    console.log('T2 ok: non-terminal refused before any spawn');
  }

  // ---------- T3 terminal variants ----------
  for (const state of ['failed', 'timed_out', 'cancelled']) {
    const c = await makeCycle({ sessions: [`ses_${state}`] });
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: `ses_${state}`, terminal: termOpt(state), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(r.ok && r.dirClear, `T3 ${state} retired`);
    console.log(`T3 ok: terminal variant ${state}`);
  }

  // ---------- T4/T9 concurrent session ----------
  {
    const c = await makeCycle({ sessions: ['ses_A', 'ses_B'] });
    const before = c.seeds.map((p) => [p, readStart(p)]);
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: 'ses_A', terminal: termOpt('completed'), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(!r.ok && r.reason === 'concurrent-sessions-present', `T4 refused: ${r.reason}`);
    assert(r.sessionsRemaining.join() === 'ses_B', 'T4 names the concurrent session');
    assert(listState(c.stateFile).join() === 'ses_B', 'T4 retiring record deleted, other preserved');
    for (const [p, s] of before) assert(aliveAs(p, s), `T4 helper ${p} untouched`);
    console.log('T4/T9 ok: concurrent session blocks, helpers+dir untouched');
  }

  // ---------- T5 delete failure ----------
  {
    const c = await makeCycle({ sessions: ['ses_D'], failDelete: true });
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: 'ses_D', terminal: termOpt('failed'), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(!r.ok && r.reason === 'session-delete-failed', `T5 refused: ${r.reason}`);
    assert(r.exported && !r.sessionDeleted, 'T5 exported but not deleted');
    assert(r.helpersSignalled.length === 0, 'T5 no signals before collect');
    console.log('T5 ok: delete failure aborts pre-collect');
  }

  // ---------- T6 unkillable holder: fail-closed ----------
  {
    const c = await makeCycle({ sessions: ['ses_U'], trapTerm: true });
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: 'ses_U', terminal: termOpt('cancelled'), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(!r.ok && r.reason === 'helpers-or-dir-not-clear', `T6 fail-closed: ${r.reason}`);
    assert(!r.dirClear && r.helpersRemaining.length >= 1, 'T6 names survivors, denies deletion');
    console.log('T6 ok: unkillable holder blocks deletion');
  }

  // ---------- T7 stale identities ----------
  {
    const c = await makeCycle({ sessions: ['ses_S'] });
    const dead = mod.collectServiceHelpers(424242424, c.retired);
    assert(dead.inconclusive, 'T7a dead service pid inconclusive');
    const live = mod.collectServiceHelpers(c.svcPid, c.retired);
    assert(!live.inconclusive && live.members.length === 3, `T7b live collect finds triple, got ${live.members.length}`);
    try { process.kill(c.svcPid, 'SIGKILL'); } catch { /* gone */ }
    await sleepMs(500);
    assert(readStart(c.svcPid) === null, 'T7b service dead');
    const refused = await mod.signalServiceHelpers(live, c.retired);
    assert(refused.signalled.length === 0, 'T7b stale service admits no signals');
    const staleMember = await mod.signalServiceHelpers({ ...live, members: live.members.map((m) => ({ pid: m.pid, startTime: '0' })) }, c.retired);
    assert(staleMember.signalled.length === 0, 'T7c stale member baselines skipped');
    console.log('T7 ok: stale service/member identities admit nothing');
  }

  // ---------- T8 repeated full cycles ----------
  for (let i = 1; i <= 2; i += 1) {
    const c = await makeCycle({ sessions: [`ses_R${i}`] });
    const r = await mod.retireSessionWorkdir({ opencodeBin: c.shim, workdir: c.retired, sessionId: `ses_R${i}`, terminal: termOpt('completed'), servicePid: c.svcPid, timeoutMs: 5000 });
    assert(r.ok && r.dirClear && r.helpersSignalled.length === 3, `T8 cycle ${i} identical`);
    console.log(`T8 ok: repeat cycle ${i}`);
  }

  // ---------- S5 resolver ----------
  assert(mod.resolveOpenCodeServicePid('definitely-not-a-binary-xyz') === null, 'unknown binary -> null');
  const liveSvc = mod.resolveOpenCodeServicePid();
  if (liveSvc !== null) {
    const cmd = readArgv(liveSvc);
    assert(cmd !== null && cmd.length === 3 && cmd[1] === 'serve' && cmd[2] === '--service', 'resolver pid verifies live');
    console.log(`S5 ok: resolver found live-verified service pid ${liveSvc}`);
  } else {
    console.log('S5 ok: resolver null (no unambiguous service; fail-closed)');
  }

  // ---------- T10 live-service integration (no override, zero impact) ----------
  {
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-shr-live-'));
    bases.push(base);
    const retired = path.join(base, 'retired');
    await fsp.mkdir(retired, { recursive: true });
    const fix = await writeShims(base, {});
    await fsp.writeFile(fix.stateFile, 'ses_L\n');
    const countHelpers = () => {
      let n = 0;
      if (liveSvc === null) return -1;
      for (const entry of fs.readdirSync('/proc')) {
        const pid = Number(entry);
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        if (readPpid(pid) !== liveSvc) continue;
        const argv = readArgv(pid);
        if (argv !== null && mod.isCodegraphMcpArgv(argv)) n += 1;
      }
      return n;
    };
    const beforeCount = countHelpers();
    const r = await mod.retireSessionWorkdir({ opencodeBin: fix.shim, workdir: retired, sessionId: 'ses_L', terminal: termOpt('completed'), timeoutMs: 5000 });
    if (liveSvc === null) {
      assert(!r.ok && r.reason === 'service-unresolvable', 'T10 no live service -> clean abort');
    } else {
      assert(r.ok && r.dirClear && r.helpersSignalled.length === 0, `T10 empty dir retires as no-op: ${JSON.stringify(r)}`);
      assert(readStart(liveSvc) !== null, 'T10 real service alive');
      assert(countHelpers() === beforeCount, 'T10 shared helper set unchanged');
    }
    console.log('T10 ok: live-service integration with zero impact');
  }
} finally {
  await cleanupAll();
}
console.log('SMOKE PASS: session-helper-retirement');
