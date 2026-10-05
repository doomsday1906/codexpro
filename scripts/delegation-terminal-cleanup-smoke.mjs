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

// ---------- B3: legacy shared-service run cancel -> incomplete/unknown, label preserved ----------
{
  const runId = await launchInstant('tc-legacy');
  forgePidLessTerminal(runId, 'interrupted', (forged) => { delete forged.opencodeRoute; });
  const readBefore = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(readBefore.structuredContent.execution_route === 'shared-service',
    `legacy run must read shared-service: ${JSON.stringify(readBefore.structuredContent.execution_route)}`);
  const cancel = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assertIncompleteTerminalCancel(cancel, 'interrupted');
  assert(cancel.structuredContent.execution_route === 'shared-service',
    `legacy cancel must preserve the shared-service label, never convert: ${JSON.stringify(cancel.structuredContent)}`);
  assert((cancel.structuredContent.execution_route_note ?? '').includes('never silently converted'),
    `legacy cancel must carry the never-converted note: ${JSON.stringify(cancel.structuredContent)}`);
  const readAfter = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(readAfter.structuredContent.execution_route === 'shared-service',
    'the shared-service label must survive cancel');
  console.log('ok: B3 MCP (legacy shared-service cancel stays incomplete/unknown; label preserved, never converted)');
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
