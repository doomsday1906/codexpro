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

// ---------- S1: unit (strict identity + correlation + --json argv) ----------
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
  // Trusted identity (Finding 3): validated startup type only; arbitrary
  // keys, wrong types, and plaintext never qualify; conflicts are unknown.
  assert(Engines.parseCodexThreadId('{"thread_id":"thr_abc123","type":"thread.started"}') === 'thr_abc123',
    'JSON thread_id with validated startup type must parse');
  assert(Engines.parseCodexThreadId('{"thread":{"id":"thr_jsonl-9"},"type":"session.started"}') === 'thr_jsonl-9',
    'nested thread id with validated startup type must parse');
  assert(Engines.parseCodexThreadId('{"thread_id": "thr_abc123"}') === null,
    'arbitrary JSON without a validated startup type must NOT parse (event-type check)');
  assert(Engines.parseCodexThreadId('{"id":"thr_bare","type":"thread.started"}') === null,
    'bare generic id (no thread/session scope) must NOT parse, even with a valid type');
  assert(Engines.parseCodexThreadId('{"thread_id":"thr_x","type":"message"}') === null,
    'wrong event type (message) must NOT yield identity');
  assert(Engines.parseCodexThreadId('session id: 9f1e2d3c-4b5a-6789-abcd-ef0123456789') === null,
    'plain-text thread/session lines must NOT parse (no unstructured fallback)');
  assert(Engines.parseCodexThreadId('no identifiers here') === null, 'null is never synthesized');
  assert(Engines.parseCodexThreadId('{"thread_id":"thr_a","type":"thread.started"}\n{"thread_id":"thr_b","type":"thread.started"}') === null,
    'conflicting distinct ids must resolve unknown (never first-wins)');
  assert(Engines.isCodexThreadStartupType('thread.started') === true &&
    Engines.isCodexThreadStartupType('message') === false,
    'startup-type predicate must accept thread.started and reject message types');
  // Steerable argv requests the supported structured protocol (Finding 3).
  const steerArgv = Engines.buildCodexSteerableArgv('P', 'prompt', '/tmp/x.md', { executionPolicy: 'read-only' });
  assert(steerArgv.includes('--json') && !steerArgv.includes('--ephemeral') &&
    steerArgv.includes('--profile') && steerArgv.includes('-s'),
    `steerable argv must request --json, drop --ephemeral, keep profile+policy: ${JSON.stringify(steerArgv)}`);
  const realArgv = Engines.buildCodexRealArgv('P', 'prompt', '/tmp/x.md', { executionPolicy: 'read-only' });
  assert(realArgv.includes('--ephemeral') && !realArgv.includes('--json'),
    'ephemeral real-task argv stays without --json (steerable-only protocol)');
  // Message-correlated evidence (Finding 1): validated type + same thread +
  // same hash/key; plaintext/mtime/wrong-thread never correlate.
  const hSlow = Tools.steeringMessageHash('slow down a little');
  const goodLine = JSON.stringify({ type: 'codex.steering.received', threadId: 'thr_smoke001', messageHash: hSlow });
  const corr = Engines.findSteeringCorrelation(goodLine, { threadId: 'thr_smoke001', messageHash: hSlow, steeringKey: 'k1' });
  assert(corr && corr.matchedBy === 'messageHash' && corr.eventType === 'codex.steering.received',
    'genuine correlation shape (validated type + same thread + same hash) must correlate');
  assert(Engines.findSteeringCorrelation('slow down a little', { threadId: 'thr_smoke001', messageHash: hSlow, steeringKey: 'k1' }) === null,
    'tails/plaintext alone must never correlate');
  assert(Engines.findSteeringCorrelation(JSON.stringify({ type: 'message', threadId: 'thr_smoke001', messageHash: hSlow }), { threadId: 'thr_smoke001', messageHash: hSlow, steeringKey: 'k1' }) === null,
    'wrong event type must never correlate');
  assert(Engines.findSteeringCorrelation(goodLine, { threadId: 'thr_other', messageHash: hSlow, steeringKey: 'k1' }) === null,
    'wrong thread must never correlate');
  assert(Engines.findSteeringCorrelation(JSON.stringify({ type: 'codex.steering.received', threadId: 'thr_smoke001', messageHash: '0'.repeat(64) }), { threadId: 'thr_smoke001', messageHash: hSlow, steeringKey: 'k1' }) === null,
    'unrelated hash must never correlate');
  assert(Tools.steeringMessageHash('a') === Tools.steeringMessageHash('a') &&
    Tools.steeringMessageHash('a') !== Tools.steeringMessageHash('b'),
    'steering hash must be stable and content-sensitive');
  assert(Engines.CODEX_QUEUE_CAPABILITY.ephemeralSteerable === false &&
    /Queue a message for an existing session/.test(Engines.CODEX_QUEUE_CAPABILITY.inspected) &&
    /UNPROVEN/.test(Engines.CODEX_QUEUE_CAPABILITY.queueDuringActiveVsAfterEnd ?? ''),
    'codex capability must carry the inspected queue evidence + UNPROVEN during-active/after-end mark');
  assert(/no halt\/stop\/steer verb|no queue\/steer/.test(Engines.OPENCODE_STEER_CAPABILITY.inspected) &&
    /serve/.test(Engines.OPENCODE_STEER_CAPABILITY.inspected) &&
    /INCOMPLETE/.test(Engines.OPENCODE_STEER_CAPABILITY.blocker) &&
    /no queue\/steer\/message-inject verb/.test(Engines.CLAUDE_STEER_CAPABILITY.inspected) &&
    /INCOMPLETE/.test(Engines.CLAUDE_STEER_CAPABILITY.blocker),
    'opencode/claude capabilities must carry the inspected no-verb evidence (incl. serve/acp/api) + INCOMPLETE blockers');
  console.log('ok: S1 unit (queue argv/mapping, strict thread identity, --json argv, message correlation, capability evidence)');
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
  `if [ "$1" = "exec" ]; then echo '{"thread_id":"thr_smoke001","type":"thread.started"}'; sleep 110; exit 0; fi\nexit 1`);
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
  assert(!argv.includes('--ephemeral') && argv.includes('--profile') && argv.includes('-s') && argv.includes('--json'),
    `steerable argv drops --ephemeral, requests --json structured protocol, keeps profile+policy boundaries: ${JSON.stringify(argv)}`);
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
let happyId = null;
{
  const st = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-happy-1', task: 'Steerable probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-happy-1', timeout_ms: 120000, steerable: true
  });
  assert(!st.isError && st.structuredContent.steerable === true,
    `steerable launch must ack: ${JSON.stringify(st.structuredContent)}`);
  const stId = st.structuredContent.run_id;
  happyId = stId;
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

// ---------- S7: applied reconciliation needs genuine message correlation (Finding 1) ----------
// mtime-only promotion is removed: unrelated output, ordinary completion
// text, ignored messages, and later-attempt files NEVER promote. ONE
// positive uses genuine message-correlated evidence: the provenance-bound
// artifact content carries a validated correlation event (type + same
// thread + same messageHash) on the same attempt. The shim emulates the
// actual `exec --json` correlation shape here (labeled shim, not live).
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-applied-'));
  const RUN = 'run_aaaaaaaaaaaaaaaa';
  const THREAD = 'thr_s7000001';
  const MSG = 'steer me gently';
  const HASH = Tools.steeringMessageHash(MSG);
  const rel1 = Tools.lastMessageRelPathForAttempt('codex', 1, RUN);
  const rel2 = Tools.lastMessageRelPathForAttempt('codex', 2, RUN);
  const past = new Date(Date.now() - 5000).toISOString();
  const mk = (status, steeringExtra, attempts) => ({
    version: 1, runId: RUN, requestId: 'r', delegationGroup: 'g', engine: 'codex',
    workspaceId: 'w', workspaceCanonical: wsRoot, workdir: wdir, ownerIdHash: 'h', ownerKind: 'local',
    state: 'completed', seq: 0,
    attempts: attempts ?? [{ n: 1, startedAt: past, state: 'completed', outputArtifact: { relPath: rel1, bytes: 5, created: false, provenance: 'worker' } }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    nextAction: 'x', createdAt: past, updatedAt: past,
    session: { engine: 'codex', resumable: false, observed: false, reason: 's', threadId: THREAD, threadEvidence: 't' },
    steering: [{ steeringKey: 'k', messageHash: HASH, messageChars: MSG.length, attemptN: 1, threadId: THREAD, status, createdAt: past, updatedAt: past, ...steeringExtra }]
  });
  // NEGATIVE 1: unrelated output (no correlation object) never promotes,
  // however recent its mtime.
  await fsp.writeFile(path.join(wdir, rel1), 'hello unrelated worker output\n');
  const neg1 = mk('queued', {});
  const n1 = Tools.reconcileSteeringApplied(neg1);
  assert(n1.changed === false && neg1.steering[0].status === 'queued',
    'unrelated worker output must never promote queued->applied');
  // NEGATIVE 2: ordinary completion text (plaintext echo of the message, no
  // validated event type) never promotes — tails/plaintext alone never suffice.
  await fsp.writeFile(path.join(wdir, rel1), `done. note: ${MSG}\n`);
  const neg2 = mk('queued', {});
  const n2 = Tools.reconcileSteeringApplied(neg2);
  assert(n2.changed === false && neg2.steering[0].status === 'queued',
    'ordinary completion text without a validated correlation event must never promote');
  // NEGATIVE 3: ignored message (valid type but wrong hash) never promotes.
  await fsp.writeFile(path.join(wdir, rel1), JSON.stringify({ type: 'codex.steering.received', threadId: THREAD, messageHash: '0'.repeat(64) }));
  const neg3 = mk('queued', {});
  const n3 = Tools.reconcileSteeringApplied(neg3);
  assert(n3.changed === false && neg3.steering[0].status === 'queued',
    'a correlation event for a different message must never promote');
  // NEGATIVE 4: later-attempt output never promotes an earlier record.
  const corrLine = JSON.stringify({ type: 'codex.steering.received', threadId: THREAD, messageHash: HASH });
  await fsp.writeFile(path.join(wdir, rel2), `${corrLine}\n`);
  const neg4 = mk('queued', {}, [
    { n: 1, startedAt: past, state: 'completed', outputArtifact: { relPath: rel1, bytes: 5, created: false, provenance: 'worker' } },
    { n: 2, startedAt: past, state: 'completed', outputArtifact: { relPath: rel2, bytes: corrLine.length, created: false, provenance: 'worker' } }
  ]);
  // Record is attempt 1 but current attempt is 2 with correlation: no promote.
  await fsp.writeFile(path.join(wdir, rel1), 'unrelated attempt-1 output\n');
  const n4 = Tools.reconcileSteeringApplied(neg4);
  assert(n4.changed === false && neg4.steering[0].status === 'queued',
    'later-attempt correlation must never promote an earlier-attempt record');
  // NEGATIVE 5: wrong thread never promotes, even with the right hash.
  await fsp.writeFile(path.join(wdir, rel1), JSON.stringify({ type: 'codex.steering.received', threadId: 'thr_other0001', messageHash: HASH }));
  const neg5 = mk('queued', {});
  const n5 = Tools.reconcileSteeringApplied(neg5);
  assert(n5.changed === false && neg5.steering[0].status === 'queued',
    'correlation on a different thread must never promote');
  // NEGATIVE 6: legacy record without thread binding never promotes.
  await fsp.writeFile(path.join(wdir, rel1), `${corrLine}\n`);
  const neg6 = mk('queued', { threadId: undefined });
  delete neg6.steering[0].threadId;
  const n6 = Tools.reconcileSteeringApplied(neg6);
  assert(n6.changed === false && neg6.steering[0].status === 'queued',
    'a record without thread binding must never promote (unverifiable)');
  // POSITIVE (ONE): genuine message-correlated evidence on the same
  // run+attempt+thread promotes with exact binding evidence. Shim-emulated
  // `exec --json` correlation shape, labeled (not live proof).
  await fsp.writeFile(path.join(wdir, rel1), `worker log line\n${corrLine}\n`);
  const pos = mk('queued', {});
  const p = Tools.reconcileSteeringApplied(pos);
  assert(p.changed === true && pos.steering[0].status === 'applied' && pos.steering[0].appliedEvidence &&
    pos.steering[0].appliedEvidence.includes(RUN) && pos.steering[0].appliedEvidence.includes(THREAD),
    'genuine message-correlated evidence (same run+attempt+thread, validated type + hash) must promote with binding evidence');
  console.log('ok: S7 applied only on genuine message correlation (5 negatives + 1 shim-emulated positive, mtime removed)');
}

// ---------- S8: idempotency bound — no silent eviction (Finding 2) ----------
// Fill one running steerable run to maxSteeringPerRun (16) with distinct
// keys; a 17th distinct key refuses with steer_bound_exhausted (no engine
// call, nothing evicted). Identical + conflicting retries of the OLDEST key
// past the limit — including after reload/restart (delegation_read_result)
// and for uncertain delivery — replay without a second engine call.
{
  // Reuse the S5 happy run (already holds k1 queued on attempt 1).
  assert(happyId, 'S8 needs the S5 happy run still active');
  await call('delegation_read_result', { workspace_id: wid, run_id: happyId });
  // Fill k2..k16 (15 more distinct keys, same worker, one engine call each).
  let before = await queueCalls();
  for (let i = 2; i <= 16; i += 1) {
    const r = await call('delegation_steer', { workspace_id: wid, run_id: happyId, steering_key: `k${i}`, message: `bound fill ${i}` });
    assert(!r.isError && r.structuredContent.status === 'queued',
      `fill key k${i} must queue: ${JSON.stringify(r.structuredContent)}`);
  }
  assert((await queueCalls()) === before + 15, 'each new key dispatches exactly one engine call');
  // Past the limit: a new distinct key refuses (truthful bound, no dispatch).
  before = await queueCalls();
  const over = await call('delegation_steer', { workspace_id: wid, run_id: happyId, steering_key: 'k17', message: 'one too many' });
  assert(over.isError && over.structuredContent.error === 'steer_bound_exhausted' &&
    over.structuredContent.stored === false && over.structuredContent.executed === false,
    `17th distinct key must refuse with steer_bound_exhausted: ${JSON.stringify(over.structuredContent)}`);
  assert((await queueCalls()) === before, 'bound refusal dispatches no engine call');
  // Oldest key identical retry past the limit: replays queued, no dispatch.
  before = await queueCalls();
  const dup = await call('delegation_steer', { workspace_id: wid, run_id: happyId, steering_key: 'k1', message: 'slow down a little' });
  assert(!dup.isError && dup.structuredContent.duplicate === true && dup.structuredContent.status === 'queued',
    `oldest identical retry past the limit must replay queued: ${JSON.stringify(dup.structuredContent)}`);
  assert((await queueCalls()) === before, 'identical retry past the limit dispatches nothing');
  // Oldest key conflicting retry past the limit: conflicts, no dispatch.
  const conf = await call('delegation_steer', { workspace_id: wid, run_id: happyId, steering_key: 'k1', message: 'CHANGED content past limit' });
  assert(conf.isError && conf.structuredContent.error === 'steer_key_conflict',
    'oldest conflicting retry past the limit must conflict, never dispatch');
  assert((await queueCalls()) === before, 'conflicting retry past the limit dispatches nothing');
  // Reload/restart: read (loads from disk), then both retries still replay
  // without dispatch (durable dedup, not memory-only).
  await call('delegation_read_result', { workspace_id: wid, run_id: happyId });
  before = await queueCalls();
  const dup2 = await call('delegation_steer', { workspace_id: wid, run_id: happyId, steering_key: 'k1', message: 'slow down a little' });
  assert(!dup2.isError && dup2.structuredContent.duplicate === true,
    'identical retry after reload must still replay without dispatch');
  const conf2 = await call('delegation_steer', { workspace_id: wid, run_id: happyId, steering_key: 'k1', message: 'CHANGED content past limit' });
  assert(conf2.isError && conf2.structuredContent.error === 'steer_key_conflict',
    'conflicting retry after reload must still conflict without dispatch');
  assert((await queueCalls()) === before, 'post-reload retries dispatch nothing');
  // Uncertain delivery past the reload: the S6 hang run holds ku unknown;
  // identical + conflicting retries replay without redispatch (S6 proved the
  // identical path; prove the conflicting path + post-reload here).
  const hangId = runningIds.find((id) => id !== happyId && id !== settledEpId);
  if (hangId) {
    before = await queueCalls();
    const uconf = await call('delegation_steer', { workspace_id: wid, run_id: hangId, steering_key: 'ku', message: 'different uncertain content' });
    assert(uconf.isError && uconf.structuredContent.error === 'steer_key_conflict',
      `uncertain conflicting retry must conflict without dispatch: ${JSON.stringify(uconf.structuredContent)}`);
    await call('delegation_read_result', { workspace_id: wid, run_id: hangId });
    const udup = await call('delegation_steer', { workspace_id: wid, run_id: hangId, steering_key: 'ku', message: 'uncertain msg' });
    assert(!udup.isError && udup.structuredContent.duplicate === true && udup.structuredContent.status === 'unknown',
      'uncertain identical retry after reload must replay unknown without dispatch');
    assert((await queueCalls()) === before, 'uncertain retries dispatch nothing more');
  }
  console.log('ok: S8 idempotency bound (refuse-new past 16, oldest identical/conflicting retries incl. reload + uncertain never redispatch)');
}

// ---------- S9: trusted identity retained, conflicts never overwrite (Finding 3) ----------
{
  // Ordinary launch->identity->steer already proved in S5 with NO manual
  // session injection (shim exec prints the --json startup event, the read
  // records it, the steer addresses ONLY it). Here: retention + conflict.
  const first = await call('delegation_read_result', { workspace_id: wid, run_id: happyId });
  const firstThread = first.structuredContent.session?.threadId ?? first.structuredContent.session?.thread_id ?? null;
  // Session thread may surface under threadId; accept either spelling here.
  const sess = first.structuredContent.session ?? {};
  const tid = sess.threadId ?? sess.thread_id ?? null;
  assert(typeof tid === 'string' && tid === 'thr_smoke001',
    `recorded thread must be the engine-observed id (retained across reads): ${JSON.stringify(sess)}`);
  const second = await call('delegation_read_result', { workspace_id: wid, run_id: happyId });
  const sess2 = second.structuredContent.session ?? {};
  assert((sess2.threadId ?? sess2.thread_id) === tid,
    'thread identity must be retained across reconnects/reads (never re-synthesized)');
  console.log('ok: S9 trusted identity retained across reads (ordinary launch->identity->steer, no injection; conflicts never overwrite by construction)');
}

// ---------- S10: capability deltas with UNPROVEN marks (Finding 4) ----------
{
  assert(/UNPROVEN/.test(Engines.CODEX_QUEUE_CAPABILITY.queueDuringActiveVsAfterEnd ?? ''),
    'codex queue-during-active vs after-end must stay UNPROVEN (help is silent; live proof not performed)');
  for (const cap of [Engines.OPENCODE_STEER_CAPABILITY, Engines.CLAUDE_STEER_CAPABILITY]) {
    assert(cap.supported === false && /INCOMPLETE/.test(cap.blocker),
      `${cap.engine} steering must stay INCOMPLETE with a precise blocker`);
    assert(!/follow-up.*steer|steer.*follow-up/i.test(cap.blocker) || /never relabeled|separate/.test(cap.blocker),
      `${cap.engine} blocker must never relabel follow-up as steering`);
  }
  console.log('ok: S10 capability deltas (codex queue semantics UNPROVEN; opencode/claude INCOMPLETE, follow-up never relabeled)');
}

// ---------- S11: storage hygiene — central records, bounded artifacts (Finding 5) ----------
{
  const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
  const tdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-hygiene-'));
  const RUN = 'run_cccccccccccccccc';
  const short = RUN.slice(4);
  // Owned run-bound artifacts + task code + foreign artifacts + fixtures.
  await fsp.writeFile(path.join(tdir, `codex-last-message-${short}-attempt-1.md`), 'owned output\n');
  await fsp.writeFile(path.join(tdir, `codex-last-message-${short}-attempt-1-x1.md`), 'owned fallback\n');
  await fsp.writeFile(path.join(tdir, 'task-code.txt'), 'task code, must survive\n');
  await fsp.writeFile(path.join(tdir, 'fixture-a.txt'), 'fixture, must survive\n');
  await fsp.writeFile(path.join(tdir, 'codex-last-message-deadbeefdeadbeef-attempt-1.md'), 'other run, must survive\n');
  const victim = { runId: RUN, workdir: tdir };
  const torn = Store.teardownRunArtifacts(victim);
  assert(torn.removed.length === 2 && torn.removed.every((f) => f.includes(short)),
    `teardown must remove exactly the owned run-bound files: ${JSON.stringify(torn)}`);
  assert(fs.existsSync(path.join(tdir, 'task-code.txt')), 'task code must survive teardown');
  assert(fs.existsSync(path.join(tdir, 'fixture-a.txt')), 'fixtures must survive teardown');
  assert(fs.existsSync(path.join(tdir, 'codex-last-message-deadbeefdeadbeef-attempt-1.md')), 'other runs must survive teardown');
  assert(!fs.existsSync(path.join(tdir, `codex-last-message-${short}-attempt-1.md`)), 'owned primary must be torn down');
  console.log('ok: S11 storage hygiene (central records; teardown removes only exact run-bound artifacts, preserves task code/fixtures/other runs)');
}

for (const id of runningIds) await bestEffortCancel(id);
console.log('delegation-steer-smoke: PASS (no live model calls; fake-binary results labeled shim)');
