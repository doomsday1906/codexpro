#!/usr/bin/env node
// delegation_steer deferred release contract (all engines).
//
// Live steering is DEFERRED for this release on every engine (codex,
// opencode default, opencode steerable-server, claude). Every
// delegation_steer call refuses with steer_deferred, exact message
// "Live steering is deferred for this release; use delegation_followup
// for amended/ordinary follow-ups or delegation_cancel + relaunch;
// follow-up and cancel/relaunch are not live steering.", stored:false,
// executed:false, no steering record, no engine dispatch.
//
// History: the pre-deferral live-steering proof (S1-S11: queue argv,
// thread identity, steerable gate, unsupported/unavailable refusals,
// happy-path queue, uncertain delivery, no auto-promotion, idempotency
// bound, identity retention, capability deltas, storage hygiene) is
// preserved in Git history; this file now verifies deferral, not live
// steering. Do not re-enable live steering here.
//
// Hermetic: mkdtemp roots, fixture CODEX_HOME / agent dirs, fake binaries
// via CODEXPRO_*_BIN (all fake-binary results labeled shim). No live model
// calls, no credentials propagated, no session DB shared. Owned temp
// servers/workdirs are cancelled at the end.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const EXPECTED = "Live steering is deferred for this release; use delegation_followup for amended/ordinary follow-ups or delegation_cancel + relaunch; follow-up and cancel/relaunch are not live steering.";
const HOST_MODEL = 'opencode-go/muse-spark-1.3-contributor';

// ---------- fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;
const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;
const clAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-clagents-'));
await fsp.writeFile(path.join(clAgents, 'implementer.md'),
  '---\nname: implementer\nmodel: claude-sonnet-5-5\neffort: high\n---\n\nReal Claude agent fixture.\n');
process.env.CODEXPRO_CLAUDE_AGENTS_DIR = clAgents;
const clProjects = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-clprojects-'));
await fsp.mkdir(path.join(clProjects, 'slug'));
process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-shim-'));
const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-logs-'));
for (const f of ['queue.log', 'serve.log', 'run.log', 'api.log']) await fsp.writeFile(path.join(logDir, f), '');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const codexShim = await fake('codex-steer',
  `if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\n` +
  `if [ "$1" = "queue" ]; then echo "$@" >> ${logDir}/queue.log\necho "queued for next turn"; exit 0; fi\n` +
  `if [ "$1" = "exec" ]; then sleep 60; exit 0; fi\nexit 1`);
process.env.CODEXPRO_CODEX_BIN = codexShim;
const ocShimSrc = `LOGDIR=${logDir}
if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi
if [ "$1" = "serve" ]; then
  echo "serve argv: $@" >> "$LOGDIR/serve.log"
  exec sleep 600
fi
if [ "$1" = "run" ]; then
  echo "run argv: $@" >> "$LOGDIR/run.log"
  exec sleep 60
fi
if [ "$1" = "api" ]; then
  echo "api argv: $@" >> "$LOGDIR/api.log"
  echo '{"data":{"prompted":true}}'; exit 0
fi
echo "unexpected: $@" >&2; exit 2
`;
const ocShim = path.join(shimBin, 'opencode-steer');
await fsp.writeFile(ocShim, `#!/bin/sh\n${ocShimSrc}\n`);
await fsp.chmod(ocShim, 0o755);
process.env.CODEXPRO_OPENCODE_BIN = ocShim;
const clShim = await fake('claude-steer', 'if [ "$1" = "--version" ]; then echo "2.1.289"; exit 0; fi\nsleep 60\nexit 0');
process.env.CODEXPRO_CLAUDE_BIN = clShim;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'steer-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const wid = opened.structuredContent.workspace_id;
const tools = await client.listTools();
assert(tools.tools.some((t) => t.name === 'delegation_steer'), 'delegation_steer must be registered');
const steerDesc = tools.tools.find((t) => t.name === 'delegation_steer').description ?? '';
assert(/DEFERRED/i.test(steerDesc) && /steer_deferred/.test(steerDesc), `delegation_steer description must name deferral: ${steerDesc.slice(0, 200)}`);

const queueCalls = async () => (await fsp.readFile(path.join(logDir, 'queue.log'), 'utf8')).split('\n').filter(Boolean).length;
const apiCalls = async () => (await fsp.readFile(path.join(logDir, 'api.log'), 'utf8')).split('\n').filter(Boolean).length;
const waitRunning = async (runId, tries = 100) => {
  for (let i = 0; i < tries; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    if (r.structuredContent.state === 'running') return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`ASSERT: run ${runId} never reached running`);
};
const waitSettled = async (runId, tries = 150) => {
  for (let i = 0; i < tries; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`ASSERT: run ${runId} never settled`);
};
const bestEffortCancel = async (runId) => {
  try { await call('delegation_cancel', { workspace_id: wid, run_id: runId }); } catch { /* cleanup only */ }
};
const textOf = (res) => String(res.content?.[0]?.text ?? '');

function assertDeferred(res, runId, engine, label) {
  assert(res.isError === true, `${label}: steer must be isError (got ${JSON.stringify(res.structuredContent)})`);
  assert(res.structuredContent?.error === 'steer_deferred', `${label}: error must be steer_deferred (got ${JSON.stringify(res.structuredContent)})`);
  assert(textOf(res) === EXPECTED, `${label}: text must be exact deferred message (got ${JSON.stringify(textOf(res).slice(0, 300))})`);
  assert(res.structuredContent?.stored === false, `${label}: stored must be false`);
  assert(res.structuredContent?.executed === false, `${label}: executed must be false`);
  assert(res.structuredContent?.run_id === runId, `${label}: run_id must echo`);
  assert(res.structuredContent?.engine === engine, `${label}: engine must echo ${engine}`);
}

async function assertNoRecord(runId, label) {
  const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  const steering = r.structuredContent?.steering ?? [];
  assert(Array.isArray(steering) && steering.length === 0, `${label}: no steering record may exist (got ${JSON.stringify(steering).slice(0, 300)})`);
}

// Launch one run, prove deferral deterministically for several keys/messages,
// prove no record and no engine dispatch, then return the run id (still running).
async function proveDeferredOnRun({ label, launchArgs, engine }) {
  const launched = await call('delegation_launch', { workspace_id: wid, ...launchArgs });
  assert(!launched.isError, `${label}: launch must succeed: ${JSON.stringify(launched.structuredContent)}`);
  const runId = launched.structuredContent.run_id;
  await waitRunning(runId);
  const qBefore = await queueCalls();
  const aBefore = await apiCalls();
  // Three distinct valid keys/messages must all defer identically.
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: runId, steering_key: 'k1', message: 'slow down a little' });
  assertDeferred(s1, runId, engine, `${label} k1`);
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: runId, steering_key: 'k2-dash_2', message: 'different valid message' });
  assertDeferred(s2, runId, engine, `${label} k2`);
  // Same key + changed content still defers (never a key-conflict dispatch).
  const s3 = await call('delegation_steer', { workspace_id: wid, run_id: runId, steering_key: 'k1', message: 'CHANGED content still defers' });
  assertDeferred(s3, runId, engine, `${label} k1-changed`);
  assert((await queueCalls()) === qBefore, `${label}: no codex queue dispatch`);
  assert((await apiCalls()) === aBefore, `${label}: no opencode api dispatch`);
  await assertNoRecord(runId, label);
  console.log(`ok: ${label} defers (3 keys/messages, stored:false executed:false, no record/dispatch)`);
  return runId;
}

const owned = [];

// D1: codex ephemeral (default, no steerable)
{
  const id = await proveDeferredOnRun({
    label: 'D1 codex ephemeral',
    engine: 'codex',
    launchArgs: {
      engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
      workdir: 'steer-d1', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-steer-d1', timeout_ms: 120000
    }
  });
  owned.push(id);
  await bestEffortCancel(id);
  await waitSettled(id);
  // Settled runs still defer (never a settled-refusal).
  const qBefore = await queueCalls();
  const s = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'kset', message: 'too late still defers' });
  assertDeferred(s, id, 'codex', 'D1 settled');
  assert((await queueCalls()) === qBefore, 'D1 settled: no dispatch');
  await assertNoRecord(id, 'D1 settled');
  console.log('ok: D1 settled still defers');
  owned.pop();
}

// D2: codex steerable (opt-in persists, steering still deferred)
{
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-d2', task: 'Steerable deferral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-d2', timeout_ms: 120000, steerable: true
  });
  assert(!launched.isError && launched.structuredContent.steerable === true, `D2 steerable launch must ack: ${JSON.stringify(launched.structuredContent)}`);
  const id = launched.structuredContent.run_id;
  owned.push(id);
  await waitRunning(id);
  const qBefore = await queueCalls();
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'k1', message: 'hello' });
  assertDeferred(s1, id, 'codex', 'D2');
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'k2', message: 'world' });
  assertDeferred(s2, id, 'codex', 'D2 k2');
  assert((await queueCalls()) === qBefore, 'D2: no dispatch even on steerable run');
  await assertNoRecord(id, 'D2');
  console.log('ok: D2 codex steerable defers (opt-in intact, no dispatch)');
  await bestEffortCancel(id);
  await waitSettled(id);
  owned.pop();
}

// D3: opencode default (standalone)
{
  const id = await proveDeferredOnRun({
    label: 'D3 opencode standalone',
    engine: 'opencode',
    launchArgs: {
      engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
      workdir: 'steer-d3', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-steer-d3', timeout_ms: 120000
    }
  });
  owned.push(id);
  await bestEffortCancel(id);
  await waitSettled(id);
  owned.pop();
}

// D4: opencode steerable-server (per-run server still launches; steering still deferred, no api dispatch)
{
  const SID = 'ses_steer_deferred_d4';
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'steer-d4', task: 'Server deferral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-d4', timeout_ms: 120000,
    session_id: SID, steerable: true
  });
  assert(!launched.isError && launched.structuredContent.execution_route === 'steerable-server' && launched.structuredContent.steerable === true,
    `D4 server launch must ack steerable-server: ${JSON.stringify(launched.structuredContent)}`);
  const id = launched.structuredContent.run_id;
  owned.push(id);
  await waitRunning(id);
  const aBefore = await apiCalls();
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 's1', message: 'steer gently' });
  assertDeferred(s1, id, 'opencode', 'D4');
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 's2', message: 'another message' });
  assertDeferred(s2, id, 'opencode', 'D4 s2');
  assert((await apiCalls()) === aBefore, 'D4: no api dispatch on server route');
  await assertNoRecord(id, 'D4');
  console.log('ok: D4 opencode steerable-server defers (launch intact, no api dispatch)');
  await bestEffortCancel(id);
  await waitSettled(id);
  owned.pop();
}

// D5: claude (no steer verb; still deferred, never emulated)
{
  const id = await proveDeferredOnRun({
    label: 'D5 claude',
    engine: 'claude',
    launchArgs: {
      engine: 'claude', agent: 'implementer',
      workdir: 'steer-d5', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-steer-d5', timeout_ms: 120000
    }
  });
  owned.push(id);
  await bestEffortCancel(id);
  await waitSettled(id);
  owned.pop();
}

for (const id of owned) await bestEffortCancel(id);
console.log('delegation-steer-smoke: PASS (deferred on all engines; no live model calls; fake-binary results labeled shim)');
