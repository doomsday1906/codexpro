#!/usr/bin/env node
// Server-backed opencode steering (delegation_steer on explicit
// steerable-server runs), hermetic, labeled shims, no model calls.
//
// T1 unit: server argv shape; prompt result mapping (exit 0 -> steered,
//   SessionNotFound/deterministic negatives -> rejected, timeout/null/
//   ambiguous -> unknown, never claimed applied); password mint (unique,
//   URL-safe); free-port pick (loopback range, never :8787); capability
//   constants (server route supported with inspected delivery evidence;
//   default route still unsupported; codex app-server turn/steer negative
//   recorded; claude untouched); store server-dir authority + teardown
//   (recorded dir removed; forged dir refused; missing record no-delete).
// T2 launch: steerable opencode launch acks execution_route
//   steerable-server + steerable:true; run file carries opencodeServer
//   {127.0.0.1 url (never :8787), pid, password, run-scoped dir+db};
//   serve invoked with --hostname 127.0.0.1 --port; worker CLI rides
//   --server <url> + explicit --session + OPENCODE_PASSWORD env.
// T3 steer happy: queued via one api call addressing ONLY the recorded
//   session (op session.prompt + sessionID param + delivery-steer JSON);
//   duplicate key replays without redispatch; changed content conflicts;
//   foreign run id denied without an engine call.
// T4 uncertain: failing api maps unknown; same-key retry replays unknown
//   without redispatch.
// T5 rejected: missing-session api maps rejected (stored, never rerouted).
// T6 bound: 16 distinct keys queue; 17th refuses steer_bound_exhausted;
//   oldest identical retry replays without dispatch.
// T7 cancel-complete: live server + worker both reaped, verification
//   complete, server identity dead, route text honest.
// T8 worker-gone: observably dead worker identity refuses
//   steer_worker_gone (nothing dispatched; no prompt on an idle session).
// T9 backend-gone: dead server refuses steer_backend_unavailable (nothing
//   dispatched); cancel then stays fail-closed incomplete.
// T10 default route + no-session: standalone opencode still refuses
//   steer_unsupported; server-backed run without a session id refuses
//   steer_unavailable_no_session.
// T11 followup: settled server-backed run continues on a FRESH per-run
//   server reusing the SAME server DB (attempt 2, new-continuation-attempt,
//   never resumed without verification).
// T12 no auto-promotion: server-accepted records stay queued/unverified
//   across worker output, legacy hypothetical shapes, wrong-session
//   shapes, and unbound records.
// T13 secret redaction: the minted server password appears in NO tool
//   output and NO shim argv log (env-only, never argv, never emitted).
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// agent dir, fake opencode binary via CODEXPRO_OPENCODE_BIN (all
// fake-binary results labeled shim). Disposable REAL-server op-surface
// evidence lives in the leaf manifest, not here.
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
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));

const collectedOutputs = [];
const noteOutput = (value) => {
  try { collectedOutputs.push(JSON.stringify(value)); } catch { /* ignore */ }
};

// ---------- T1: unit ----------
{
  const argv = Engines.buildOpenCodeServerArgv({
    model: 'm', agent: 'a', prompt: 'p', serverUrl: 'http://127.0.0.1:51234', sessionId: 'ses_x'
  });
  assert(JSON.stringify(argv) === JSON.stringify(['run', '--server', 'http://127.0.0.1:51234', '--model', 'm', '--agent', 'a', '--format', 'json', '--session', 'ses_x', 'p']),
    `server argv must ride --server (never --standalone) with session + prompt last: ${JSON.stringify(argv)}`);
  const noSession = Engines.buildOpenCodeServerArgv({ model: 'm', agent: 'a', prompt: 'p', serverUrl: 'http://127.0.0.1:51234' });
  assert(!noSession.includes('--session') && noSession.at(-1) === 'p', 'session flag omitted when no id (worker mints)');
  const s = Engines.mapOpenCodePromptResult(0, '{"data":{"prompted":true}}', '');
  assert(s.outcome === 'steered', `exit 0 clean must map steered (held, never applied): ${JSON.stringify(s)}`);
  const nf = Engines.mapOpenCodePromptResult(1, '{"_tag":"SessionNotFoundError","sessionID":"x","message":"Session not found: x"}', 'HTTP 404 Not Found');
  assert(nf.outcome === 'rejected', 'missing-session tag must map rejected, never rerouted');
  const nf0 = Engines.mapOpenCodePromptResult(0, 'SessionNotFoundError somewhere', '');
  assert(nf0.outcome === 'rejected', 'missing-session tag on exit 0 must still map rejected');
  const badop = Engines.mapOpenCodePromptResult(1, '', 'UnknownError: Operation not found: bogus.op');
  assert(badop.outcome === 'rejected', 'unknown-op shape must map rejected (deterministic, retry cannot help)');
  const u = Engines.mapOpenCodePromptResult(null, '', '');
  assert(u.outcome === 'unknown', 'null exit must map unknown, never duplicated');
  const amb = Engines.mapOpenCodePromptResult(2, '', 'boom');
  assert(amb.outcome === 'unknown', 'ambiguous nonzero output must map unknown, never rejected-or-steered');
  const p1 = Engines.mintOpenCodeServerPassword();
  const p2 = Engines.mintOpenCodeServerPassword();
  assert(typeof p1 === 'string' && p1.length >= 32 && /^[A-Za-z0-9_-]+$/.test(p1) && p1 !== p2,
    'server password must be unique URL-safe entropy (env-only secret)');
  const port = await Engines.pickFreeLoopbackPort();
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535 && port !== 8787,
    `picked port must be a usable loopback port, never :8787 (got ${port})`);
  assert(Engines.OPENCODE_STEERABLE_SERVER_CAPABILITY.supported === true &&
    /session\.prompt/.test(Engines.OPENCODE_STEERABLE_SERVER_CAPABILITY.inspected) &&
    /delivery/.test(Engines.OPENCODE_STEERABLE_SERVER_CAPABILITY.inspected) &&
    /SessionNotFound/.test(Engines.OPENCODE_STEERABLE_SERVER_CAPABILITY.inspected) &&
    /--server/.test(Engines.OPENCODE_STEERABLE_SERVER_CAPABILITY.inspected),
    'server capability must carry the inspected op + delivery + 404 evidence');
  assert(Engines.OPENCODE_STEER_CAPABILITY.supported === false,
    'default-route capability stays unsupported (never silently widened)');
  assert(/TurnSteerParams/.test(Engines.CODEX_QUEUE_CAPABILITY.note ?? '') &&
    /expectedTurnId/.test(Engines.CODEX_QUEUE_CAPABILITY.note ?? ''),
    'codex capability must record the app-server turn/steer negative (expectedTurnId required, exec route exposes none)');
  assert(Engines.CLAUDE_STEER_CAPABILITY.supported === false, 'claude stays INCOMPLETE');
  // Store server-dir authority + teardown.
  const tBridge = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdir-bridge-'));
  const RUN = 'run_dddddddddddddddd';
  const authority = Store.opencodeServerDirForRun(tBridge, RUN);
  assert(authority === path.join(tBridge, 'opencode-servers', RUN), 'server dir is run-scoped under the bridge');
  assert(Store.opencodeServerDbPathForRun(tBridge, RUN) === path.join(authority, 'opencode.db'), 'server db is the fixed filename inside');
  let threw = false;
  try { Store.opencodeServerDirForRun(tBridge, 'bogus'); } catch { threw = true; }
  assert(threw, 'invalid run id must throw (never a shared fallback dir)');
  const past = new Date().toISOString();
  const withServer = { runId: RUN, attempts: [], opencodeServer: { dir: authority, dbPath: path.join(authority, 'opencode.db') } };
  await fsp.mkdir(authority, { recursive: true });
  await fsp.writeFile(path.join(authority, 'opencode.db'), 'fake db\n');
  const torn = Store.teardownOpenCodeServerDir(tBridge, withServer);
  assert(torn.removed.length === 1 && torn.removed[0] === `server:${RUN}` && !fs.existsSync(authority),
    `recorded server dir must tear down: ${JSON.stringify(torn)}`);
  const forgedDir = path.join(tBridge, 'elsewhere');
  await fsp.mkdir(forgedDir, { recursive: true });
  await fsp.writeFile(path.join(forgedDir, 'x'), 'x\n');
  const forged = Store.teardownOpenCodeServerDir(tBridge, { runId: RUN, attempts: [], opencodeServer: { dir: forgedDir, dbPath: path.join(forgedDir, 'opencode.db') } });
  assert(forged.removed.length === 0 && forged.reason && fs.existsSync(path.join(forgedDir, 'x')),
    `forged server dir must fail closed and survive: ${JSON.stringify(forged)}`);
  const missing = Store.teardownOpenCodeServerDir(tBridge, { runId: RUN, attempts: [] });
  assert(missing.removed.length === 0 && missing.reason, 'run without a server record must no-delete with a reason');
  const bad = Store.teardownOpenCodeServerDir(tBridge, null);
  assert(bad.removed.length === 0 && bad.reason, 'missing record must fail closed');
  console.log('ok: T1 unit (server argv/mapping/password/port/capability/store authority + teardown)');
}

// ---------- fixtures ----------
const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvback-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;
const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvback-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvback-shim-'));
const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvback-logs-'));
for (const f of ['serve.log', 'run.log', 'api.log']) await fsp.writeFile(path.join(logDir, f), '');
const shimSrc = `#!/bin/sh
LOGDIR=${logDir}
if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi
if [ "$1" = "serve" ]; then
  echo "serve argv: $@" >> "$LOGDIR/serve.log"
  echo "serve env: DB=\${OPENCODE_V2_DB:-} PWSET=\${OPENCODE_PASSWORD:+yes}" >> "$LOGDIR/serve.log"
  if [ "\${FAKE_SERVE_MODE:-ok}" = "dead" ]; then echo "serve refusing"; exit 1; fi
  exec sleep 600
fi
if [ "$1" = "run" ]; then
  echo "run argv: $@" >> "$LOGDIR/run.log"
  echo "run env: PWSET=\${OPENCODE_PASSWORD:+yes}" >> "$LOGDIR/run.log"
  if [ "\${FAKE_RUN_MODE:-sleep}" = "instant" ]; then echo '{"sessionID":"ses_instant_unused"}'; exit 0; fi
  exec sleep 600
fi
if [ "$1" = "api" ]; then
  echo "api argv: $@" >> "$LOGDIR/api.log"
  MODE="\${FAKE_API_MODE:-ok}"
  if [ "$MODE" = "ok" ]; then echo '{"data":{"prompted":true}}'; exit 0; fi
  if [ "$MODE" = "missing" ]; then echo '{"_tag":"SessionNotFoundError","sessionID":"gone","message":"Session not found: gone"}'; echo "HTTP 404 Not Found" >&2; exit 1; fi
  if [ "$MODE" = "badop" ]; then echo "UnknownError: Operation not found: bogus.op" >&2; exit 1; fi
  if [ "$MODE" = "weird" ]; then echo "weird"; exit 3; fi
  sleep 40; echo "late"; exit 0
fi
echo "unexpected: $@" >&2; exit 2
`;
const shimPath = path.join(shimBin, 'opencode-srvback');
await fsp.writeFile(shimPath, shimSrc);
await fsp.chmod(shimPath, 0o755);
process.env.CODEXPRO_OPENCODE_BIN = shimPath;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvback-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'srvback-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => {
  const out = await client.callTool({ name, arguments: args });
  noteOutput(out.structuredContent ?? out);
  return out;
};
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const wid = opened.structuredContent.workspace_id;
const realRoot = fs.realpathSync.native(wsRoot);
const smokeUid = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown';
const runBridge = Store.resolveDelegationRunBridgeDir({
  delegationDir: delegHome, legacyBridge: false, contextDir: '.ai-bridge',
  localOwner: `${smokeUid}:${realRoot}`, defaultRoot: realRoot
}, realRoot);
const runFileFor = (runId) => path.join(runBridge, 'delegation-runs', `${runId}.json`);
const readRunFile = (runId) => JSON.parse(fs.readFileSync(runFileFor(runId), 'utf8'));
const HOST_MODEL = 'opencode-go/muse-spark-1.3-contributor';
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
const apiCalls = async () => (await fsp.readFile(path.join(logDir, 'api.log'), 'utf8')).split('\n').filter(Boolean).length;
const bestEffortCancel = async (runId) => {
  try { await call('delegation_cancel', { workspace_id: wid, run_id: runId }); } catch { /* cleanup only */ }
};

// ---------- T2: server-backed launch ----------
const SID_A = 'ses_srvback_alpha';
let runA = null;
{
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvback-a', task: 'Server-backed probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvback-a', timeout_ms: 120000,
    session_id: SID_A, steerable: true
  });
  assert(!launched.isError, `steerable opencode launch must work: ${JSON.stringify(launched.structuredContent)}`);
  assert(launched.structuredContent.execution_route === 'steerable-server' && launched.structuredContent.steerable === true,
    `ack must label the server route + opt-in: ${JSON.stringify(launched.structuredContent)}`);
  runA = launched.structuredContent.run_id;
  await waitRunning(runA);
  const rec = readRunFile(runA);
  assert(rec.opencodeRoute === 'steerable-server' && rec.steerable === true, 'run file must record the server route');
  const backend = rec.opencodeServer;
  assert(backend && /^http:\/\/127\.0\.0\.1:(?!8787)\d+$/.test(backend.url), `server url must be loopback, never :8787: ${backend?.url}`);
  assert(Number.isSafeInteger(backend.pid) && backend.pid > 0, 'server pid recorded');
  assert(typeof backend.password === 'string' && backend.password.length >= 32, 'per-run server password recorded');
  assert(backend.dir === Store.opencodeServerDirForRun(runBridge, runA), 'server dir equals the recomputed authority');
  assert(backend.dbPath === Store.opencodeServerDbPathForRun(runBridge, runA), 'server db is the fixed filename inside');
  assert(backend.dbPath.includes(runA), 'server db is per-run isolated (run id in path)');
  const serveLog = await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8');
  assert(/serve argv: serve --hostname 127\.0\.0\.1 --port \d+/.test(serveLog), `serve must bind loopback: ${serveLog}`);
  assert(!serveLog.includes(':8787'), 'serve must never bind the shared :8787');
  assert(new RegExp(`DB=.*${runA}.*PWSET=yes`).test(serveLog), 'serve must carry the per-run DB + password env');
  const runLog = await fsp.readFile(path.join(logDir, 'run.log'), 'utf8');
  assert(runLog.includes(`--server ${backend.url}`) && !runLog.includes('--standalone'),
    `worker CLI must ride --server (never --standalone): ${runLog}`);
  assert(runLog.includes(`--session ${SID_A}`) && runLog.includes('PWSET=yes'), 'worker CLI must carry the explicit session + server password env');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runA });
  assert(read.structuredContent.execution_route === 'steerable-server', 'read must surface the server route');
  assert(read.structuredContent.session?.sessionId === SID_A, 'explicit session id recorded on the binding');
  console.log('ok: T2 server-backed launch (route labeled, per-run backend recorded, CLI rides --server)');
}

// ---------- T3: steer happy path + addressing ----------
{
  const before = await apiCalls();
  const q1 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's1', message: 'steer gently' });
  assert(!q1.isError && q1.structuredContent.status === 'queued' && q1.structuredContent.executed === true && q1.structuredContent.engine === 'opencode',
    `server steer must accept as queued: ${JSON.stringify(q1.structuredContent)}`);
  assert((await apiCalls()) === before + 1, 'exactly one engine call per steering key');
  const logged = (await fsp.readFile(path.join(logDir, 'api.log'), 'utf8')).split('\n').filter(Boolean).at(-1);
  assert(logged.includes('session.prompt') && logged.includes(`sessionID=${SID_A}`),
    `api must address ONLY the recorded session: ${logged}`);
  const dataJson = JSON.parse(logged.slice(logged.indexOf('{'), logged.lastIndexOf('}') + 1));
  assert(dataJson.delivery === 'steer' && dataJson.text === 'steer gently',
    `prompt payload must carry delivery steer + exact text: ${logged}`);
  assert(!logged.includes('OPENCODE_PASSWORD'), 'password must never ride api argv (env-only)');
  const qdup = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's1', message: 'steer gently' });
  assert(!qdup.isError && qdup.structuredContent.duplicate === true, 'same key + same content must replay without redispatch');
  assert((await apiCalls()) === before + 1, 'replay dispatches nothing more');
  const qconf = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's1', message: 'CHANGED' });
  assert(qconf.isError && qconf.structuredContent.error === 'steer_key_conflict', 'same key + changed content must conflict');
  assert((await apiCalls()) === before + 1, 'conflict dispatches nothing');
  const reread = await call('delegation_read_result', { workspace_id: wid, run_id: runA });
  const entry = (reread.structuredContent.steering ?? []).find((e) => e.steering_key === 's1');
  assert(entry && entry.status === 'queued' && !('applied_evidence' in entry),
    `accepted steer must not self-promote to applied: ${JSON.stringify(entry)}`);
  const foreign = await call('delegation_steer', { workspace_id: wid, run_id: 'run_ffffffffffffffff', steering_key: 'k9', message: 'hi' });
  assert(foreign.isError, 'unknown/foreign run ids must be denied');
  assert((await apiCalls()) === before + 1, 'foreign steer dispatches nothing');
  console.log('ok: T3 server steer happy path (recorded session only, delivery-steer payload, duplicate/conflict/foreign handled, never applied)');
}

// ---------- T4: uncertain + T5: rejected ----------
{
  process.env.FAKE_API_MODE = 'weird';
  const before = await apiCalls();
  const u1 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 'su', message: 'uncertain msg' });
  assert(u1.isError && u1.structuredContent.error === 'steer_uncertain' && u1.structuredContent.stored === true,
    `ambiguous api failure must record unknown: ${JSON.stringify(u1.structuredContent)}`);
  process.env.FAKE_API_MODE = 'ok';
  const u2 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 'su', message: 'uncertain msg' });
  assert(!u2.isError && u2.structuredContent.duplicate === true && u2.structuredContent.status === 'unknown',
    'same-key retry must replay the stored unknown without redispatch');
  assert((await apiCalls()) === before + 1, 'uncertain retry dispatches nothing more');
  delete process.env.FAKE_API_MODE;
  process.env.FAKE_API_MODE = 'missing';
  const m1 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 'sm', message: 'gone session' });
  assert(m1.isError && m1.structuredContent.error === 'steer_rejected' && m1.structuredContent.stored === true,
    `missing session must reject (stored, never rerouted): ${JSON.stringify(m1.structuredContent)}`);
  delete process.env.FAKE_API_MODE;
  console.log('ok: T4/T5 uncertain replay + missing-session rejection (never rerouted)');
}

// ---------- T6: idempotency bound ----------
{
  let before = await apiCalls();
  for (let i = 2; i <= 14; i += 1) {
    const r = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: `s${i}`, message: `bound fill ${i}` });
    assert(!r.isError && r.structuredContent.status === 'queued', `fill key s${i} must queue: ${JSON.stringify(r.structuredContent)}`);
  }
  assert((await apiCalls()) === before + 13, 'each new key dispatches exactly one engine call');
  before = await apiCalls();
  const over = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's17', message: 'one too many' });
  assert(over.isError && over.structuredContent.error === 'steer_bound_exhausted' && over.structuredContent.stored === false,
    `17th distinct key must refuse (s1+su+sm+13 fills = 16): ${JSON.stringify(over.structuredContent)}`);
  assert((await apiCalls()) === before, 'bound refusal dispatches no engine call');
  const dup = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's1', message: 'steer gently' });
  assert(!dup.isError && dup.structuredContent.duplicate === true && dup.structuredContent.status === 'queued',
    'oldest identical retry past the limit must replay queued');
  assert((await apiCalls()) === before, 'identical retry past the limit dispatches nothing');
  console.log('ok: T6 idempotency bound (refuse-new past 16, oldest replay never redispatches)');
}

// ---------- T7: cancel reaps both roots, complete ----------
{
  const rec = readRunFile(runA);
  const serverPid = rec.opencodeServer.pid;
  const workerPid = rec.attempts.at(-1).pid;
  assert(Engines.isProcessIdentityAlive(serverPid, rec.opencodeServer.startTime), 'server must be alive going into cancel (setup check)');
  assert(Engines.isProcessIdentityAlive(workerPid, rec.attempts.at(-1).processStartTime), 'worker must be alive going into cancel (setup check)');
  const cancelled = await call('delegation_cancel', { workspace_id: wid, run_id: runA });
  assert(!cancelled.isError && cancelled.structuredContent.cleanup_finished === true &&
    cancelled.structuredContent.cancel_verification.verification_complete === true,
    `dual-root cancel must verify complete: ${JSON.stringify(cancelled.structuredContent)}`);
  assert(cancelled.structuredContent.remaining_pids.length === 0, 'no owned descendants may remain');
  assert(String(cancelled.content?.[0]?.text ?? '').includes('steerable-server'),
    'cancel ack text must name the server route honestly');
  await new Promise((r) => setTimeout(r, 300));
  assert(Engines.readProcessStartTime(serverPid) === null || !Engines.isProcessIdentityAlive(serverPid, rec.opencodeServer.startTime),
    'recorded server identity must be dead after cancel');
  assert(!Engines.isProcessIdentityAlive(workerPid, rec.attempts.at(-1).processStartTime), 'worker identity must be dead after cancel');
  console.log('ok: T7 cancel-complete (worker tree + per-run server both reaped, verification complete)');
}

// ---------- T8/T9: worker-gone + backend-gone (run C) ----------
const SID_C = 'ses_srvback_charlie';
let runC = null;
{
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvback-c', task: 'Race probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvback-c', timeout_ms: 120000,
    session_id: SID_C, steerable: true
  });
  assert(!launched.isError, 'run C must launch');
  runC = launched.structuredContent.run_id;
  await waitRunning(runC);
  // Forge the worker identity dead-but-state-running: keep the live pid,
  // break the starttime baseline (never matches a real process).
  const rec = Store.loadDelegationRun(runBridge, runC);
  const realPid = rec.attempts.at(-1).pid;
  const realStart = rec.attempts.at(-1).processStartTime;
  rec.attempts.at(-1).processStartTime = '0';
  Store.saveDelegationRun(runBridge, rec);
  const before = await apiCalls();
  const wg = await call('delegation_steer', { workspace_id: wid, run_id: runC, steering_key: 'sw', message: 'too late' });
  assert(wg.isError && wg.structuredContent.error === 'steer_worker_gone' && wg.structuredContent.stored === false,
    `dead worker identity must refuse before any prompt: ${JSON.stringify(wg.structuredContent)}`);
  assert((await apiCalls()) === before, 'worker-gone refusal dispatches no engine call');
  // Restore the true identity (no read_result while forged: reconcile
  // would settle the run).
  const restored = Store.loadDelegationRun(runBridge, runC);
  restored.attempts.at(-1).pid = realPid;
  restored.attempts.at(-1).processStartTime = realStart;
  Store.saveDelegationRun(runBridge, restored);
  // Backend-gone: stop ONLY the server (worker still sleeps).
  const rec2 = readRunFile(runC);
  try { process.kill(rec2.opencodeServer.pid, 'SIGKILL'); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 500));
  const before2 = await apiCalls();
  const bg = await call('delegation_steer', { workspace_id: wid, run_id: runC, steering_key: 'sb', message: 'nobody home' });
  assert(bg.isError && bg.structuredContent.error === 'steer_backend_unavailable' && bg.structuredContent.stored === false,
    `dead backend must refuse before any prompt: ${JSON.stringify(bg.structuredContent)}`);
  assert((await apiCalls()) === before2, 'backend-gone refusal dispatches no engine call');
  // Cancel with a dead backend stays fail-closed incomplete (the server
  // root was never enumerated alive by this cancel).
  const cancelled = await call('delegation_cancel', { workspace_id: wid, run_id: runC });
  assert(cancelled.structuredContent.cleanup_finished === false && cancelled.structuredContent.cancel_verification.verification_complete === false,
    `cancel with a pre-dead backend must stay incomplete: ${JSON.stringify(cancelled.structuredContent)}`);
  console.log('ok: T8/T9 worker-gone + backend-gone refusals (nothing dispatched; dead-backend cancel fail-closed)');
}

// ---------- T10: default route unsupported + no-session unavailable ----------
{
  const std = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvback-std', task: 'Standalone probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvback-std', timeout_ms: 120000
  });
  assert(!std.isError, 'standalone launch must work');
  const stdId = std.structuredContent.run_id;
  assert(std.structuredContent.execution_route === 'standalone', 'default route stays standalone');
  await waitRunning(stdId);
  const refused = await call('delegation_steer', { workspace_id: wid, run_id: stdId, steering_key: 'k1', message: 'nope' });
  assert(refused.isError && refused.structuredContent.error === 'steer_unsupported',
    `default opencode runs keep refusing steer_unsupported: ${JSON.stringify(refused.structuredContent)}`);
  await bestEffortCancel(stdId);
  const nos = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvback-nos', task: 'No-session probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvback-nos', timeout_ms: 120000, steerable: true
  });
  assert(!nos.isError, 'server-backed launch without session must work');
  const nosId = nos.structuredContent.run_id;
  await waitRunning(nosId);
  const na = await call('delegation_steer', { workspace_id: wid, run_id: nosId, steering_key: 'k1', message: 'nobody' });
  assert(na.isError && na.structuredContent.error === 'steer_unavailable_no_session' && na.structuredContent.stored === false,
    `server-backed run without a session id must refuse (never synthesized): ${JSON.stringify(na.structuredContent)}`);
  await bestEffortCancel(nosId);
  console.log('ok: T10 default route steer_unsupported preserved; no-session server-backed refuses (never synthesized)');
}

// ---------- T11: followup continues on a fresh server, same DB ----------
const SID_E = 'ses_srvback_echo';
{
  process.env.FAKE_RUN_MODE = 'instant';
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvback-e', task: 'Followup probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvback-e', timeout_ms: 60000,
    session_id: SID_E, steerable: true
  });
  assert(!launched.isError, 'run E must launch');
  const eid = launched.structuredContent.run_id;
  const settled = await waitSettled(eid);
  assert(settled.structuredContent.state === 'completed', `instant shim run must complete: ${settled.structuredContent.state}`);
  const before = readRunFile(eid);
  const firstUrl = before.opencodeServer.url;
  const firstDb = before.opencodeServer.dbPath;
  const serveCountBefore = (await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8')).split('\n').filter((l) => l.startsWith('serve argv:')).length;
  const q = await call('delegation_followup', {
    workspace_id: wid, run_id: eid,
    checkpoint: { id: 'eq1', run_id: eid, seq: 0, payload: {}, questions: [{ id: 'eqq', question: 'Proceed?' }] }
  });
  assert(!q.isError && q.structuredContent.state === 'needs-input', 'question must move the settled run to needs-input');
  const a = await call('delegation_followup', {
    workspace_id: wid, run_id: eid,
    checkpoint: { id: 'ea1', run_id: eid, seq: 1, payload: { go: true }, input_request_id: 'eq1' }
  });
  assert(!a.isError && a.structuredContent.executed === true && a.structuredContent.continuation === 'new-continuation-attempt',
    `answer on a reaped backend must dispatch a labeled new attempt (never resumed without verification): ${JSON.stringify(a.structuredContent)}`);
  const done = await waitSettled(eid);
  assert(done.structuredContent.state === 'completed', 'continuation must complete');
  const after = readRunFile(eid);
  assert(after.attempts.length === 2, 'answer must append exactly one attempt');
  assert(after.opencodeServer.url !== firstUrl, 'continuation must run on a fresh per-run server (new port)');
  assert(after.opencodeServer.dbPath === firstDb, 'fresh server must reuse the SAME server DB (session continuity)');
  assert(after.opencodeServer.dir === before.opencodeServer.dir, 'server dir authority stable across windows');
  const serveCountAfter = (await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8')).split('\n').filter((l) => l.startsWith('serve argv:')).length;
  assert(serveCountAfter === serveCountBefore + 1, 'exactly one fresh server per continuation (never two concurrent)');
  const runLog = await fsp.readFile(path.join(logDir, 'run.log'), 'utf8');
  const invocations = runLog.split('\n').filter((l) => l.startsWith('run argv:')).slice(-2);
  assert(invocations[0].includes(`--session ${SID_E}`) && !invocations[1].includes('--session'),
    `first window rides the explicit session; the unverified continuation mints (never false-resumed): ${JSON.stringify(invocations)}`);
  delete process.env.FAKE_RUN_MODE;
  await bestEffortCancel(eid);
  console.log('ok: T11 followup on fresh server + same DB (new-continuation-attempt, exactly one backend per window)');
}

// ---------- T12: no adapter auto-promotion for server records ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvback-applied-'));
  const RUN = 'run_eeeeeeeeeeeeeeee';
  const SID = 'ses_s100000000000001';
  const MSG = 'steer me gently';
  const HASH = Tools.steeringMessageHash(MSG);
  const past = new Date(Date.now() - 5000).toISOString();
  const mk = (status, steeringExtra) => ({
    version: 1, runId: RUN, requestId: 'r', delegationGroup: 'g', engine: 'opencode',
    workspaceId: 'w', workspaceCanonical: wsRoot, workdir: wdir, ownerIdHash: 'h', ownerKind: 'local',
    state: 'completed', seq: 0, opencodeRoute: 'steerable-server', steerable: true,
    attempts: [{ n: 1, startedAt: past, state: 'completed' }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    nextAction: 'x', createdAt: past, updatedAt: past,
    session: { engine: 'opencode', sessionId: SID, resumable: false, observed: true, reason: 's' },
    opencodeServer: { url: 'http://127.0.0.1:1', pid: 1, password: 'pw', dir: 'd', dbPath: 'd/opencode.db' },
    steering: [{ steeringKey: 'k', messageHash: HASH, messageChars: MSG.length, attemptN: 1, sessionId: SID, status, createdAt: past, updatedAt: past, ...steeringExtra }]
  });
  await fsp.writeFile(path.join(wdir, 'out.md'), `done. note: ${MSG}\n`);
  const n1 = Tools.reconcileSteeringApplied(mk('queued', {}));
  const r1 = mk('queued', {});
  assert(n1.changed === false && r1.steering[0].status === 'queued', 'worker output echoing the message must never promote queued->applied');
  const legacyLine = JSON.stringify({ type: 'codex.steering.received', sessionId: SID, messageHash: HASH });
  await fsp.writeFile(path.join(wdir, 'out.md'), `log\n${legacyLine}\n`);
  const r3 = mk('queued', {});
  const n3 = Tools.reconcileSteeringApplied(r3);
  assert(n3.changed === false && r3.steering[0].status === 'queued', 'legacy hypothetical shapes must never promote server records either');
  const r4 = mk('queued', { sessionId: 'ses_other_session' });
  const n4 = Tools.reconcileSteeringApplied(r4);
  assert(n4.changed === false && r4.steering[0].status === 'queued', 'wrong-session shapes must never promote');
  const r5 = mk('queued', { sessionId: undefined });
  delete r5.steering[0].sessionId;
  const n5 = Tools.reconcileSteeringApplied(r5);
  assert(n5.changed === false && r5.steering[0].status === 'queued', 'unbound records must never promote');
  const r6 = mk('rejected', {});
  const n6 = Tools.reconcileSteeringApplied(r6);
  assert(n6.changed === false && r6.steering[0].status === 'rejected', 'rejected records stay rejected');
  console.log('ok: T12 no adapter auto-promotion for server records (queued stays queued/unverified)');
}

// ---------- T13: secret redaction ----------
{
  const runFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/^run_[0-9a-f]{16}\.json$/.test(entry.name)) runFiles.push(p);
    }
  };
  walk(delegHome);
  assert(runFiles.length > 0, 'run files must exist for the redaction scan');
  const passwords = new Set();
  for (const f of runFiles) {
    try {
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (rec.opencodeServer?.password) passwords.add(rec.opencodeServer.password);
    } catch { /* ignore */ }
  }
  assert(passwords.size > 0, 'minted server passwords must exist to scan against');
  for (const pw of passwords) {
    for (const out of collectedOutputs) {
      assert(!out.includes(pw), 'server password must appear in NO tool output');
    }
    for (const f of ['serve.log', 'run.log', 'api.log']) {
      const text = await fsp.readFile(path.join(logDir, f), 'utf8');
      assert(!text.includes(pw), `server password must appear in NO shim argv log (${f})`);
    }
  }
  for (const out of collectedOutputs) {
    assert(!/OPENCODE_PASSWORD=.{8,}/.test(out), 'no tool output may carry a password assignment');
  }
  console.log(`ok: T13 secret redaction (${passwords.size} password(s) in ${runFiles.length} run file(s), zero leaks in outputs/logs)`);
}

await bestEffortCancel(runA).catch(() => undefined);
console.log('delegation-steer-server-smoke: PASS (no live model calls; fake-binary results labeled shim)');
