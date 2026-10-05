#!/usr/bin/env node
// Finding 3 regressions: bounded live steering (delegation_steer), distinct
// from follow-up question/reply and from cancel/relaunch.
//
// S1 unit: queue argv shape; queue result mapping (exit 0 -> queued,
//   nonzero/unknown-thread -> rejected, timeout/null -> unknown, never
//   claimed applied); thread-id parse (JSON + JSONL + plain, null never
//   synthesized); steering hash stability; capability constants carry the
//   inspected evidence (codex queue exists; opencode/claude have no steer
//   verb).
// S2 gate: steerable=true refused for opencode/claude/canary (never
//   silently ignored); steerable codex preview argv drops --ephemeral and
//   keeps --profile/-s boundaries.
// S3 unsupported engines: running opencode/claude runs refuse with
//   steer_unsupported (recorded rejected); same-key replay dispatches
//   nothing more.
// S4 codex ephemeral: running run with no thread refuses with
//   steer_unavailable_no_thread (stored:false, never emulated, never a
//   guessed id) and names the steerable relaunch alternative.
// S5 codex steerable happy path: thread observed in live worker stdout ->
//   queue shim exit 0 -> queued (held-by-engine, never applied); duplicate
//   key + same content replays without redispatch; same key + changed
//   content conflicts; settled run refuses; needs-input refuses with the
//   follow-up pointer; unknown run id is denied (foreign sessions rejected).
// S6 uncertain delivery: hanging queue call -> steer_uncertain recorded as
//   unknown; same-key retry replays unknown without redispatch.
// S7 applied reconciliation: queued + worker output newer than queue time
//   -> applied (worker-observable evidence only); older output stays queued.
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs, fake binaries via CODEXPRO_*_BIN (all
// fake-binary results labeled shim). The queue shim multiplexes exec (live
// thread JSON + sleep) and queue (logged, modal exit) behind one binary.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));

// ---------- S1: unit ----------
{
  assert(JSON.stringify(Engines.buildCodexQueueArgv('thr_1', 'slow down')) ===
    JSON.stringify(['queue', '--thread', 'thr_1', '--message', 'slow down']),
    'queue argv must be one native call with no prompt construction');
  const q = Engines.mapCodexQueueResult(0, 'queued for next turn', '');
  assert(q.outcome === 'queued', `exit 0 must map queued: ${JSON.stringify(q)}`);
  const r1 = Engines.mapCodexQueueResult(1, '', 'boom');
  assert(r1.outcome === 'rejected', 'nonzero exit must map rejected');
  const r2 = Engines.mapCodexQueueResult(0, 'error: unknown thread thr_x', '');
  assert(r2.outcome === 'rejected', 'unknown-thread text on exit 0 must map rejected, never queued');
  const u = Engines.mapCodexQueueResult(null, '', '');
  assert(u.outcome === 'unknown', 'null exit (timeout/spawn failure) must map unknown, never duplicated');
  assert(Engines.parseCodexThreadId('{"thread_id": "thr_abc123"}') === 'thr_abc123', 'JSON thread_id must parse');
  assert(Engines.parseCodexThreadId('{"a":1}\n{"thread":{"id":"thr_jsonl-9"}}') === 'thr_jsonl-9',
    'JSONL nested thread id must parse');
  assert(Engines.parseCodexThreadId('session id: 9f1e2d3c-4b5a-6789-abcd-ef0123456789') === '9f1e2d3c-4b5a-6789-abcd-ef0123456789',
    'plain session id line must parse');
  assert(Engines.parseCodexThreadId('no identifiers here') === null, 'null is never synthesized');
  assert(Tools.steeringMessageHash('a') === Tools.steeringMessageHash('a') &&
    Tools.steeringMessageHash('a') !== Tools.steeringMessageHash('b'),
    'steering hash must be stable and content-sensitive');
  assert(Engines.CODEX_QUEUE_CAPABILITY.ephemeralSteerable === false &&
    /Queue a message for an existing session/.test(Engines.CODEX_QUEUE_CAPABILITY.inspected),
    'codex capability must carry the inspected queue evidence');
  assert(/no halt\/stop\/steer verb|no queue\/steer/.test(Engines.OPENCODE_STEER_CAPABILITY.inspected) &&
    /no queue\/steer\/message-inject verb/.test(Engines.CLAUDE_STEER_CAPABILITY.inspected),
    'opencode/claude capabilities must carry the inspected no-verb evidence');
  console.log('ok: S1 unit (queue argv/result mapping, thread parse, hash, capability evidence)');
}

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
const queueLog = path.join(shimBin, 'queue.log');
await fsp.writeFile(queueLog, '');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
// Multiplex codex shim: exec prints a live thread id then sleeps (a
// running steerable worker); queue logs its argv and behaves modally.
const codexShim = await fake('codex-steer',
  `if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\n` +
  `if [ "$1" = "queue" ]; then echo "$@" >> ${queueLog}\n` +
  `MODE="\${FAKE_QUEUE_MODE:-ok}"\n` +
  `if [ "$MODE" = "ok" ]; then echo "queued for next turn"; exit 0; fi\n` +
  `if [ "$MODE" = "reject" ]; then echo "error: unknown thread" >&2; exit 1; fi\n` +
  `sleep 35; echo "late"; exit 0; fi\n` +
  `if [ "$1" = "exec" ]; then echo '{"thread_id":"thr_smoke001","type":"thread.started"}'; sleep 30; exit 0; fi\nexit 1`);
process.env.CODEXPRO_CODEX_BIN = codexShim;
const ocSleep = await fake('opencode-sleep', 'if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nsleep 30\nexit 0');
process.env.CODEXPRO_OPENCODE_BIN = ocSleep;
const clSleep = await fake('claude-sleep', 'if [ "$1" = "--version" ]; then echo "2.1.289"; exit 0; fi\nsleep 30\nexit 0');
process.env.CODEXPRO_CLAUDE_BIN = clSleep;
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
const queueCalls = async () => (await fsp.readFile(queueLog, 'utf8')).split('\n').filter(Boolean).length;
const waitRunning = async (runId, tries = 100) => {
  for (let i = 0; i < tries; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    if (r.structuredContent.state === 'running') return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`ASSERT: run ${runId} never reached running`);
};
const bestEffortCancel = async (runId) => {
  try { await call('delegation_cancel', { workspace_id: wid, run_id: runId }); } catch { /* cleanup only */ }
};

// ---------- S2: steerable gate ----------
{
  const prev = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'steer-prev-1',
    task: 'Steerable probe. Change nothing.', delegation_group: 'team-steer', steerable: true
  });
  assert(!prev.isError, `steerable codex preview must resolve: ${JSON.stringify(prev.structuredContent)}`);
  const argv = prev.structuredContent.preview.argv_preview;
  assert(!argv.includes('--ephemeral') && argv.includes('--profile') && argv.includes('-s'),
    `steerable argv drops --ephemeral and keeps profile+policy boundaries: ${JSON.stringify(argv)}`);
  for (const bad of [
    { engine: 'opencode', agent: 'implementer', model: 'shim-model' },
    { engine: 'claude', agent: 'implementer' }
  ]) {
    const refused = await call('delegation_preview', {
      workspace_id: wid, ...bad, workdir: 'steer-prev-x', task: 'x', delegation_group: 'team-steer', steerable: true
    });
    assert(refused.isError && refused.structuredContent.error === 'steerable_unsupported_for_engine',
      `steerable on ${bad.engine} must refuse, never silently ignore: ${JSON.stringify(refused.structuredContent)}`);
  }
  const canaryRefused = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'steer-canary-x',
    canary: true, delegation_group: 'team-steer', request_id: 'req-steer-canary', steerable: true
  });
  assert(canaryRefused.isError && canaryRefused.structuredContent.error === 'steerable_refused_for_canary',
    'steerable canary must refuse (read-only slice takes no injected messages)');
  console.log('ok: S2 steerable gate (codex-only, non-ephemeral argv, canary refused)');
}

// ---------- S3: unsupported engines refuse, never emulate ----------
const runningIds = [];
{
  const oc = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'opencode-go/muse-spark-1.3-contributor',
    workdir: 'steer-oc-1', task: 'Sleep probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-oc-1', timeout_ms: 120000
  });
  assert(!oc.isError, `shim opencode launch must work: ${JSON.stringify(oc.structuredContent)}`);
  const ocId = oc.structuredContent.run_id;
  runningIds.push(ocId);
  await waitRunning(ocId);
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: ocId, steering_key: 'k1', message: 'slow down' });
  assert(s1.isError && s1.structuredContent.error === 'steer_unsupported' && s1.structuredContent.stored === true,
    `opencode steer must refuse with steer_unsupported (recorded): ${JSON.stringify(s1.structuredContent)}`);
  const before = await queueCalls();
  const s1dup = await call('delegation_steer', { workspace_id: wid, run_id: ocId, steering_key: 'k1', message: 'slow down' });
  assert(!s1dup.isError && s1dup.structuredContent.duplicate === true && s1dup.structuredContent.status === 'rejected',
    'same-key replay must return the stored rejection without redispatch');
  assert((await queueCalls()) === before, 'no engine call on replay');
  const s1conf = await call('delegation_steer', { workspace_id: wid, run_id: ocId, steering_key: 'k1', message: 'different content' });
  assert(s1conf.isError && s1conf.structuredContent.error === 'steer_key_conflict',
    'same key + changed content must conflict, never dispatch');
  const cl = await call('delegation_launch', {
    workspace_id: wid, engine: 'claude', agent: 'implementer',
    workdir: 'steer-cl-1', task: 'Sleep probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-cl-1', timeout_ms: 120000
  });
  assert(!cl.isError, `shim claude launch must work: ${JSON.stringify(cl.structuredContent)}`);
  const clId = cl.structuredContent.run_id;
  runningIds.push(clId);
  await waitRunning(clId);
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: clId, steering_key: 'k1', message: 'slow down' });
  assert(s2.isError && s2.structuredContent.error === 'steer_unsupported',
    `claude steer must refuse with steer_unsupported (follow-up is not steering): ${JSON.stringify(s2.structuredContent)}`);
  // Release the concurrency bound (max 2 active runs) before later cases.
  await bestEffortCancel(ocId);
  await bestEffortCancel(clId);
  runningIds.length = 0;
  console.log('ok: S3 opencode/claude refuse steer_unsupported (recorded, idempotent, never emulated)');
}

// ---------- S4: ephemeral codex has no thread ----------
let settledEpId = null;
{
  const ep = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-ep-1', task: 'Ephemeral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-ep-1', timeout_ms: 120000
  });
  assert(!ep.isError, `shim codex launch must work: ${JSON.stringify(ep.structuredContent)}`);
  const epId = ep.structuredContent.run_id;
  settledEpId = epId;
  runningIds.push(epId);
  await waitRunning(epId);
  const before = await queueCalls();
  const s = await call('delegation_steer', { workspace_id: wid, run_id: epId, steering_key: 'k1', message: 'slow down' });
  assert(s.isError && s.structuredContent.error === 'steer_unavailable_no_thread' &&
    s.structuredContent.stored === false && s.structuredContent.steerable_launch === false,
    `ephemeral steer must be unavailable (never emulated): ${JSON.stringify(s.structuredContent)}`);
  assert((await queueCalls()) === before, 'no engine call without a recorded thread (never a guessed id)');
  // Settle the ephemeral run now (frees the concurrency bound for S5; S6
  // reuses this settled run for the settled-refusal proof).
  await bestEffortCancel(epId);
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: epId });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  console.log('ok: S4 ephemeral codex refuses steer_unavailable_no_thread (never emulated, alternative named)');
}

// ---------- S5: steerable happy path + races ----------
{
  const st = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-happy-1', task: 'Steerable probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-happy-1', timeout_ms: 120000, steerable: true
  });
  assert(!st.isError && st.structuredContent.steerable === true,
    `steerable launch must ack: ${JSON.stringify(st.structuredContent)}`);
  const stId = st.structuredContent.run_id;
  runningIds.push(stId);
  // The read observes the engine-returned thread id from live worker stdout
  // (the shim prints it immediately, then sleeps as a running worker).
  await waitRunning(stId);
  await new Promise((r) => setTimeout(r, 800));
  await call('delegation_read_result', { workspace_id: wid, run_id: stId });
  await new Promise((r) => setTimeout(r, 300));
  const before = await queueCalls();
  const q1 = await call('delegation_steer', { workspace_id: wid, run_id: stId, steering_key: 'k1', message: 'slow down a little' });
  assert(!q1.isError && q1.structuredContent.status === 'queued' && q1.structuredContent.executed === true,
    `recorded thread must queue via one native call: ${JSON.stringify(q1.structuredContent)}`);
  assert((await queueCalls()) === before + 1, 'exactly one engine call per steering key');
  const logged = (await fsp.readFile(queueLog, 'utf8')).split('\n').filter(Boolean).at(-1);
  assert(logged.includes('--thread') && logged.includes('thr_smoke001') && logged.includes('slow down a little'),
    `queue must address ONLY the recorded thread: ${logged}`);
  const qdup = await call('delegation_steer', { workspace_id: wid, run_id: stId, steering_key: 'k1', message: 'slow down a little' });
  assert(!qdup.isError && qdup.structuredContent.duplicate === true,
    'same key + same content must replay without redispatch');
  assert((await queueCalls()) === before + 1, 'replay dispatches nothing more');
  const qconf = await call('delegation_steer', { workspace_id: wid, run_id: stId, steering_key: 'k1', message: 'CHANGED content' });
  assert(qconf.isError && qconf.structuredContent.error === 'steer_key_conflict',
    'same key + changed content must conflict');
  assert((await queueCalls()) === before + 1, 'conflict dispatches nothing');
  // Queued never implies applied: no worker output after the queue time yet.
  const reread = await call('delegation_read_result', { workspace_id: wid, run_id: stId });
  const entry = (reread.structuredContent.steering ?? []).find((e) => e.steering_key === 'k1');
  assert(entry && entry.status === 'queued' && !('applied_evidence' in entry),
    `queued must not self-promote to applied: ${JSON.stringify(entry)}`);
  // Foreign run id: valid grammar, unknown run -> denied (never routed).
  const foreign = await call('delegation_steer', {
    workspace_id: wid, run_id: 'run_ffffffffffffffff', steering_key: 'k9', message: 'hi'
  });
  assert(foreign.isError, 'unknown/foreign run ids must be denied');
  // needs-input refuses with the follow-up pointer (steering is not reply):
  // complete an instant run, move it to needs-input via a question, steer.
  process.env.CODEXPRO_CODEX_BIN = await fake('codex-instant', 'echo "codex-cli 0.159.0"\nexit 0');
  const ni = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-ni-1', task: 'Instant probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-ni-1', timeout_ms: 60000
  });
  assert(!ni.isError, 'instant codex launch must work');
  const niId = ni.structuredContent.run_id;
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: niId });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const niq = await call('delegation_followup', {
    workspace_id: wid, run_id: niId,
    checkpoint: { id: 'niq1', run_id: niId, seq: 0, payload: {}, questions: [{ id: 'niqq', question: 'Proceed?' }] }
  });
  assert(!niq.isError && niq.structuredContent.state === 'needs-input', 'question must move the settled run to needs-input');
  process.env.CODEXPRO_CODEX_BIN = codexShim;
  const ns = await call('delegation_steer', { workspace_id: wid, run_id: niId, steering_key: 'kni', message: 'answer this' });
  assert(ns.isError && ns.structuredContent.error === 'steer_refused_needs_input',
    `needs-input must refuse steering with the follow-up pointer: ${JSON.stringify(ns.structuredContent)}`);
  console.log('ok: S5 steerable happy path (recorded thread only, queued-not-applied, duplicate/conflict/foreign/needs-input handled)');
}

// ---------- S6: uncertain delivery + settled/needs-input refusal ----------
{
  // Settled run refuses with truthful state: the S4 ephemeral run was
  // cancelled at the end of S4 (already settled).
  const settled = settledEpId;
  const sr = await call('delegation_steer', { workspace_id: wid, run_id: settled, steering_key: 'kset', message: 'too late' });
  assert(sr.isError && sr.structuredContent.error === 'steer_refused_settled',
    `settled runs must refuse with truthful state: ${JSON.stringify(sr.structuredContent)}`);
  // Uncertain delivery: hanging queue call -> unknown, same-key retry replays.
  process.env.FAKE_QUEUE_MODE = 'hang';
  const st2 = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-hang-1', task: 'Hang-queue probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-hang-1', timeout_ms: 120000, steerable: true
  });
  assert(!st2.isError, 'hang-probe launch must work');
  const hangId = st2.structuredContent.run_id;
  runningIds.push(hangId);
  await waitRunning(hangId);
  await new Promise((r) => setTimeout(r, 800));
  await call('delegation_read_result', { workspace_id: wid, run_id: hangId });
  await new Promise((r) => setTimeout(r, 300));
  const before = await queueCalls();
  const u1 = await call('delegation_steer', { workspace_id: wid, run_id: hangId, steering_key: 'ku', message: 'uncertain msg' });
  assert(u1.isError && u1.structuredContent.error === 'steer_uncertain' && u1.structuredContent.stored === true,
    `hanging queue must record unknown: ${JSON.stringify(u1.structuredContent)}`);
  process.env.FAKE_QUEUE_MODE = 'ok';
  const u2 = await call('delegation_steer', { workspace_id: wid, run_id: hangId, steering_key: 'ku', message: 'uncertain msg' });
  assert(!u2.isError && u2.structuredContent.duplicate === true && u2.structuredContent.status === 'unknown',
    `same-key retry must replay the stored unknown without redispatch: ${JSON.stringify(u2.structuredContent)}`);
  assert((await queueCalls()) === before + 1, 'uncertain retry dispatches nothing more');
  delete process.env.FAKE_QUEUE_MODE;
  console.log('ok: S6 uncertain delivery recorded unknown (retry replays, never duplicates); settled refuses');
}

// ---------- S7: applied reconciliation is evidence-only ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-applied-'));
  const RUN = 'run_aaaaaaaaaaaaaaaa';
  const rel = Tools.lastMessageRelPathForAttempt('codex', 1, RUN);
  const past = new Date(Date.now() - 5000).toISOString();
  const mk = (status, updatedAt) => ({
    version: 1, runId: RUN, requestId: 'r', delegationGroup: 'g', engine: 'codex',
    workspaceId: 'w', workspaceCanonical: wsRoot, workdir: wdir, ownerIdHash: 'h', ownerKind: 'local',
    state: 'completed', seq: 0,
    attempts: [{ n: 1, startedAt: past, state: 'completed', outputArtifact: { relPath: rel, bytes: 5, created: false, provenance: 'worker' } }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    nextAction: 'x', createdAt: past, updatedAt: past,
    steering: [{ steeringKey: 'k', messageHash: 'h', messageChars: 1, attemptN: 1, status, createdAt: past, updatedAt }]
  });
  // Worker output newer than the queue time -> applied with evidence.
  await fsp.writeFile(path.join(wdir, rel), 'hello');
  const fresh = mk('queued', past);
  const r1 = Tools.reconcileSteeringApplied(fresh);
  assert(r1.changed === true && fresh.steering[0].status === 'applied' && fresh.steering[0].appliedEvidence,
    'worker output after queue time must promote to applied with evidence');
  // Stale queue time (output older) -> stays queued, never self-promotes.
  const future = new Date(Date.now() + 60000).toISOString();
  const stale = mk('queued', future);
  const r2 = Tools.reconcileSteeringApplied(stale);
  assert(r2.changed === false && stale.steering[0].status === 'queued',
    'queued without newer worker output must stay queued');
  console.log('ok: S7 applied claimed only on worker-observable evidence');
}

for (const id of runningIds) await bestEffortCancel(id);
console.log('delegation-steer-smoke: PASS (no live model calls; fake-binary results labeled shim)');
