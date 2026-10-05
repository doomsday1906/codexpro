#!/usr/bin/env node
// Defect B adapter regressions: terminal cleanup honesty through the
// delegation_cancel / delegation_read_result handlers (helper-only tree
// unit tests are insufficient for these paths).
//
// B1 interrupted run cancel -> incomplete/unknown without evidence (pid-less,
//   no enumerated identities): cleanup_finished false, verification_complete
//   false, ownership_verified false — never success. Repeat rechecks live.
// B2 timed_out run cancel -> incomplete/unknown without evidence (same bar).
// B3 legacy shared-service run cancel -> incomplete/unknown unless owned-tree
//   evidence proves exit; the shared-service label is preserved (never
//   silently converted to standalone).
// B4 anti-cache: a seeded "cached success" verification is overturned by a
//   live recheck (repeated cancel never converts cached incomplete — or a
//   forged cached success — into success).
// B5 positive control: a live owned tree still cancels to verified success,
//   and the repeat stays success only via grounded re-enumeration.
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs, fake binaries via CODEXPRO_*_BIN (all fake-binary
// results labeled shim).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

// ---------- fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tc-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;

const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tc-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tc-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tc-shim-'));
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const ocInstant = await fake('opencode-instant',
  'if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\necho \'{"session":"ses_tc","message":"instant worker output"}\'\nexit 0');
const ocHeartbeat = await fake('opencode-heartbeat',
  'if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\nwhile true; do date +%s%N >> heartbeat.txt; sleep 0.2; done');
process.env.CODEXPRO_OPENCODE_BIN = ocInstant;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tc-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'terminal-cleanup-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const wid = opened.structuredContent.workspace_id;

const waitSettled = async (runId, tries = 120) => {
  for (let i = 0; i < tries; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    assert(!r.isError, `read must succeed while polling: ${JSON.stringify(r.structuredContent)}`);
    const state = r.structuredContent.state;
    if (state !== 'running' && state !== 'queued') return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`ASSERT: run ${runId} never settled`);
};

const findRunFile = (dir, runId) => {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const hit = walk(p); if (hit) return hit; }
      else if (e.name === `${runId}.json`) return p;
    }
    return null;
  };
  return walk(dir);
};

const OC_TASK = 'Report readiness. Change nothing.';
let launchN = 0;
const launchInstant = async (workdir) => {
  launchN += 1;
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir, task: OC_TASK, delegation_group: 'team-terminal-cleanup',
    request_id: `req-tc-${launchN}`, timeout_ms: 60000
  });
  assert(!launched.isError, `instant run must launch: ${JSON.stringify(launched.structuredContent)}`);
  const runId = launched.structuredContent.run_id;
  await waitSettled(runId);
  return runId;
};

// Forge a pid-less terminal run with no enumerated descendant identities:
// the crash-before-save shape where no live enumeration ever grounded exit.
const forgePidLessTerminal = (runId, state, extra) => {
  const runFile = findRunFile(delegHome, runId);
  assert(runFile, 'run file must be locatable under the delegation dir');
  const forged = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  const now = new Date().toISOString();
  forged.state = state;
  forged.attempts = [{
    n: 1, startedAt: now, finishedAt: now, state,
    summary: `forged ${state} without pid identity for the regression proof`
  }];
  delete forged.result;
  delete forged.pendingDispatch;
  delete forged.lastCancelVerification;
  forged.nextAction = `forged ${state} (for the regression proof)`;
  if (extra) extra(forged);
  fs.writeFileSync(runFile, `${JSON.stringify(forged, null, 2)}\n`);
};

const assertIncompleteTerminalCancel = (cancel, state) => {
  assert(!cancel.isError, `cancel must ack (not error): ${JSON.stringify(cancel.structuredContent)}`);
  const sc = cancel.structuredContent;
  assert(sc.state === state, `run must stay ${state}: ${sc.state}`);
  assert(sc.already_terminal === true, 'cancel must stay idempotent');
  assert(sc.cleanup_finished === false,
    `${state} cancel without ownership evidence must stay incomplete, never success: ${JSON.stringify(sc)}`);
  assert(sc.cancel_verification && sc.cancel_verification.rechecked === true,
    'terminal cancel must re-verify live (rechecked marker)');
  assert(sc.cancel_verification.verification_complete === false,
    'unverified cancel must not verify complete');
  assert(sc.cancel_verification.pid_tree && sc.cancel_verification.pid_tree.ownership_verified === false,
    'ownership must read unverified (missing pid / stale root is never proof)');
};

// ---------- B1: interrupted run cancel -> incomplete/unknown ----------
{
  const runId = await launchInstant('tc-interrupted');
  forgePidLessTerminal(runId, 'interrupted');
  const cancel = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assertIncompleteTerminalCancel(cancel, 'interrupted');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError && read.structuredContent.last_cancel_verification.cleanupFinished === false,
    `persisted verification must stay incomplete: ${JSON.stringify(read.structuredContent.last_cancel_verification)}`);
  const repeat = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assertIncompleteTerminalCancel(repeat, 'interrupted');
  console.log('ok: B1 MCP (interrupted cancel without evidence stays incomplete/unknown; repeat rechecks live)');
}

// ---------- B2: timed_out run cancel -> incomplete/unknown ----------
{
  const runId = await launchInstant('tc-timedout');
  forgePidLessTerminal(runId, 'timed_out');
  const cancel = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assertIncompleteTerminalCancel(cancel, 'timed_out');
  const repeat = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assertIncompleteTerminalCancel(repeat, 'timed_out');
  console.log('ok: B2 MCP (timed_out cancel without evidence stays incomplete/unknown; repeat rechecks live)');
}

// ---------- B3: legacy shared-service runs stay incomplete/unknown (backend cessation unproven) ----------
// Replaces the weak pid-less first-cancel-only B3. The legacy CLI below has
// VALID ownership (a real persisted PID+starttime identity, live at cancel
// time for B3a; a real exited-0 identity with a grounded enumeration for
// B3b), exits cleanly, and the workdir is quiet — yet overall verification
// must stay incomplete/unknown on the FIRST call AND on repeats, because
// the shared backend may continue independently of the owned CLI tree
// (a harness-owned backend marker/sleeper the CLI tree never contains).
// Local process cleanup stays separately reportable (cleanup_finished may
// be true); verification_complete must be false with the backend blocker.
// The shared backend is NEVER terminated to satisfy verification. B3c is
// the matched standalone control (same otherwise-evidence verifies true).
{
  // Quiet sleep shim: stays alive, writes nothing to the workdir (proves
  // quiescence quiet comes from the worker stopping, not from noise).
  const ocQuietSleep = await fake('opencode-quiet-sleep',
    'if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\nsleep 30\nexit 0');
  const { spawn: spawnChild } = await import('node:child_process');
  const backendAlive = (pid) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  // B3a: initial cancel of a LIVE legacy run with valid ownership.
  process.env.CODEXPRO_OPENCODE_BIN = ocQuietSleep;
  const launchedA = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'tc-legacy-live', task: OC_TASK, delegation_group: 'team-terminal-cleanup',
    request_id: 'req-tc-legacy-live', timeout_ms: 60000
  });
  assert(!launchedA.isError, `legacy-live run must launch: ${JSON.stringify(launchedA.structuredContent)}`);
  const runA = launchedA.structuredContent.run_id;
  assert(launchedA.structuredContent.execution_route === 'standalone', 'new launch acks standalone before forging legacy');
  // Forge ONLY the route to legacy (pre-standalone shared-service): pid +
  // starttime ownership stays valid and the worker stays alive.
  const runFileA = findRunFile(delegHome, runA);
  assert(runFileA, 'run A file must be locatable');
  const forgedA = JSON.parse(fs.readFileSync(runFileA, 'utf8'));
  assert(forgedA.attempts.at(-1)?.pid !== undefined && forgedA.attempts.at(-1)?.processStartTime !== undefined,
    'run A must hold VALID ownership (persisted pid+starttime) before forging legacy');
  delete forgedA.opencodeRoute;
  fs.writeFileSync(runFileA, `${JSON.stringify(forgedA, null, 2)}\n`);
  const readLegacyA = await call('delegation_read_result', { workspace_id: wid, run_id: runA });
  assert(readLegacyA.structuredContent.execution_route === 'shared-service',
    `forged run must read shared-service: ${JSON.stringify(readLegacyA.structuredContent.execution_route)}`);
  // Separate harness-owned backend the CLI tree never contains (never killed).
  const backendA = spawnChild('sleep', ['60'], { stdio: 'ignore' });
  assert(backendAlive(backendA.pid), 'harness backend must be alive before cancel');
  const cancelA = await call('delegation_cancel', { workspace_id: wid, run_id: runA });
  assert(!cancelA.isError, `legacy-live cancel must ack: ${JSON.stringify(cancelA.structuredContent)}`);
  assert(cancelA.structuredContent.state === 'cancelled', 'run A must be cancelled');
  assert(cancelA.structuredContent.cleanup_finished === true,
    `owned CLI tree must reap (local cleanup reportable): ${JSON.stringify(cancelA.structuredContent)}`);
  assert(cancelA.structuredContent.cancel_verification.verification_complete === false,
    `legacy overall verification must stay incomplete despite clean reap + quiet workdir: ${JSON.stringify(cancelA.structuredContent.cancel_verification)}`);
  assert(cancelA.structuredContent.cancel_verification.backend_cessation &&
    cancelA.structuredContent.cancel_verification.backend_cessation.proven === false &&
    /shared-service/.test(cancelA.structuredContent.cancel_verification.backend_cessation.blocker ?? ''),
    `legacy cancel must carry the backend-cessation blocker: ${JSON.stringify(cancelA.structuredContent.cancel_verification)}`);
  assert(backendAlive(backendA.pid), 'the shared harness backend must NEVER be terminated to satisfy verification');
  const readA = await call('delegation_read_result', { workspace_id: wid, run_id: runA });
  assert(!readA.isError && readA.structuredContent.last_cancel_verification.verificationComplete === false,
    `persisted/read-back verification must stay incomplete: ${JSON.stringify(readA.structuredContent.last_cancel_verification)}`);
  assert(/shared-service|backend cessation/.test(readA.structuredContent.last_cancel_verification.reason ?? ''),
    `persisted reason must name the legacy backend blocker: ${JSON.stringify(readA.structuredContent.last_cancel_verification)}`);
  const repeatA = await call('delegation_cancel', { workspace_id: wid, run_id: runA });
  assert(!repeatA.isError && repeatA.structuredContent.already_terminal === true &&
    repeatA.structuredContent.cancel_verification.rechecked === true &&
    repeatA.structuredContent.cancel_verification.verification_complete === false,
    `legacy repeat cancel must re-verify live and stay incomplete: ${JSON.stringify(repeatA.structuredContent)}`);
  assert(repeatA.structuredContent.cancel_verification.backend_cessation &&
    repeatA.structuredContent.cancel_verification.backend_cessation.proven === false,
    'legacy repeat must keep the backend-cessation blocker');
  assert(backendAlive(backendA.pid), 'harness backend still alive after repeat (never terminated)');
  try { process.kill(backendA.pid, 'SIGKILL'); } catch { /* test cleanup */ }
  console.log('ok: B3a MCP (legacy live run with VALID ownership: clean reap yet verification incomplete on first + repeat; backend never terminated)');

  // B3b: terminal legacy run that exited successfully with valid ownership
  // and a grounded enumeration, quiet workdir, backend marker unproven.
  process.env.CODEXPRO_OPENCODE_BIN = ocInstant;
  const runB = await launchInstant('tc-legacy-grounded');
  const runFileB = findRunFile(delegHome, runB);
  const forgedB = JSON.parse(fs.readFileSync(runFileB, 'utf8'));
  const pastPid = forgedB.attempts.at(-1)?.pid;
  const pastStart = forgedB.attempts.at(-1)?.processStartTime;
  assert(pastPid !== undefined && pastStart !== undefined, 'run B must hold VALID ownership (exited-0 identity)');
  delete forgedB.opencodeRoute;
  // Grounded enumeration from a prior live sighting of the same identity
  // (now exited): local cleanup is provable, backend cessation is not.
  forgedB.lastCancelVerification = {
    at: new Date().toISOString(),
    cleanupFinished: false,
    verificationComplete: false,
    remainingPids: [],
    quiesced: false,
    quiescenceChecked: false,
    ownedTreeMembers: [{ pid: pastPid, startTime: pastStart }]
  };
  fs.writeFileSync(runFileB, `${JSON.stringify(forgedB, null, 2)}\n`);
  // Harness-owned backend marker IN the workdir but written BEFORE the
  // cancel baseline (old mtime: quiescence stays quiet; the marker proves a
  // backend the CLI tree never contained could still write).
  const markerB = path.join(wsRoot, 'tc-legacy-grounded', 'backend-marker.txt');
  fs.writeFileSync(markerB, 'harness backend turn could still be executing');
  const oldTs = new Date(Date.now() - 30_000);
  fs.utimesSync(markerB, oldTs, oldTs);
  const readLegacyB = await call('delegation_read_result', { workspace_id: wid, run_id: runB });
  assert(readLegacyB.structuredContent.execution_route === 'shared-service',
    'run B must read shared-service (label preserved, never converted)');
  const cancelB = await call('delegation_cancel', { workspace_id: wid, run_id: runB });
  assert(!cancelB.isError, `legacy terminal cancel must ack: ${JSON.stringify(cancelB.structuredContent)}`);
  assert(cancelB.structuredContent.cleanup_finished === true,
    `grounded legacy terminal keeps local cleanup reportable: ${JSON.stringify(cancelB.structuredContent)}`);
  assert(cancelB.structuredContent.cancel_verification.verification_complete === false,
    `legacy terminal verification must stay incomplete despite grounded cleanup + quiet workdir: ${JSON.stringify(cancelB.structuredContent.cancel_verification)}`);
  assert(cancelB.structuredContent.cancel_verification.backend_cessation?.proven === false,
    'legacy terminal must carry the backend-cessation blocker');
  assert(cancelB.structuredContent.execution_route === 'shared-service' &&
    (cancelB.structuredContent.execution_route_note ?? '').includes('never silently converted'),
    `legacy terminal cancel must preserve the label + note: ${JSON.stringify(cancelB.structuredContent)}`);
  const readB = await call('delegation_read_result', { workspace_id: wid, run_id: runB });
  assert(!readB.isError && readB.structuredContent.last_cancel_verification.verificationComplete === false &&
    readB.structuredContent.last_cancel_verification.cleanupFinished === true,
    `persisted legacy terminal keeps cleanup reportable but verification incomplete: ${JSON.stringify(readB.structuredContent.last_cancel_verification)}`);
  const repeatB = await call('delegation_cancel', { workspace_id: wid, run_id: runB });
  assert(!repeatB.isError && repeatB.structuredContent.cancel_verification.verification_complete === false,
    `legacy terminal repeat must stay incomplete: ${JSON.stringify(repeatB.structuredContent)}`);
  console.log('ok: B3b MCP (legacy terminal, grounded + quiet + exit-0: cleanup reportable, verification incomplete on first + repeat; label preserved)');

  // B3c: matched standalone control — identical otherwise-evidence verifies true.
  const runC = await launchInstant('tc-standalone-grounded');
  const runFileC = findRunFile(delegHome, runC);
  const forgedC = JSON.parse(fs.readFileSync(runFileC, 'utf8'));
  const cPid = forgedC.attempts.at(-1)?.pid;
  const cStart = forgedC.attempts.at(-1)?.processStartTime;
  assert(cPid !== undefined && cStart !== undefined, 'control run must hold ownership');
  forgedC.lastCancelVerification = {
    at: new Date().toISOString(),
    cleanupFinished: false,
    verificationComplete: false,
    remainingPids: [],
    quiesced: false,
    quiescenceChecked: false,
    ownedTreeMembers: [{ pid: cPid, startTime: cStart }]
  };
  fs.writeFileSync(runFileC, `${JSON.stringify(forgedC, null, 2)}\n`);
  const cancelC = await call('delegation_cancel', { workspace_id: wid, run_id: runC });
  assert(!cancelC.isError && cancelC.structuredContent.cleanup_finished === true &&
    cancelC.structuredContent.cancel_verification.verification_complete === true,
    `matched standalone control must verify complete (proves the gate flips only legacy): ${JSON.stringify(cancelC.structuredContent)}`);
  assert(!('backend_cessation' in (cancelC.structuredContent.cancel_verification ?? {})),
    'standalone verification carries no backend blocker');
  console.log('ok: B3c MCP (matched standalone control verifies complete; the gate flips only legacy)');
  process.env.CODEXPRO_OPENCODE_BIN = ocInstant;
}

// ---------- B4: a seeded cached success never survives a live recheck ----------
{
  const runId = await launchInstant('tc-cache');
  forgePidLessTerminal(runId, 'interrupted', (forged) => {
    forged.lastCancelVerification = {
      at: new Date().toISOString(),
      cleanupFinished: true,
      verificationComplete: true,
      remainingPids: [],
      quiesced: true,
      quiescenceChecked: true,
      ownedTreeMembers: []
    };
  });
  const cancel = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assertIncompleteTerminalCancel(cancel, 'interrupted');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError && read.structuredContent.last_cancel_verification.cleanupFinished === false,
    `live recheck must overturn the seeded cached success: ${JSON.stringify(read.structuredContent.last_cancel_verification)}`);
  console.log('ok: B4 MCP (seeded cached success overturned by live recheck; no cached success)');
}

// ---------- B5 positive control: a live owned tree still verifies success ----------
{
  process.env.CODEXPRO_OPENCODE_BIN = ocHeartbeat;
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'tc-live', task: OC_TASK, delegation_group: 'team-terminal-cleanup',
    request_id: 'req-tc-live', timeout_ms: 60000
  });
  assert(!launched.isError, `live run must launch: ${JSON.stringify(launched.structuredContent)}`);
  const runId = launched.structuredContent.run_id;
  const hb = path.join(wsRoot, 'tc-live', 'heartbeat.txt');
  let alive = false;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(hb)) { alive = true; break; }
  }
  assert(alive, 'heartbeat worker must be executing before cancel');
  const cancel = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assert(!cancel.isError, `live cancel must ack: ${JSON.stringify(cancel.structuredContent)}`);
  assert(cancel.structuredContent.state === 'cancelled' && cancel.structuredContent.cleanup_finished === true,
    `live owned tree must reap to verified success: ${JSON.stringify(cancel.structuredContent)}`);
  assert(cancel.structuredContent.cancel_verification.verification_complete === true,
    'live cancel verification must be complete');
  const repeat = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assert(!repeat.isError && repeat.structuredContent.already_terminal === true &&
    repeat.structuredContent.cancel_verification.rechecked === true &&
    repeat.structuredContent.cleanup_finished === true &&
    repeat.structuredContent.cancel_verification.verification_complete === true,
    `repeat stays success only via grounded live re-enumeration: ${JSON.stringify(repeat.structuredContent)}`);
  process.env.CODEXPRO_OPENCODE_BIN = ocInstant;
  console.log('ok: B5 MCP (live owned tree verifies success; repeat stays success only when proven)');
}

console.log('delegation-terminal-cleanup-smoke: PASS (no live model calls; fake-binary results labeled shim)');
