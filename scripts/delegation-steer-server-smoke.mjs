#!/usr/bin/env node
// Server-backed opencode steering deferred (steer_deferred on all engines).
//
// Live steering is DEFERRED for this release: every delegation_steer call
// refuses with steer_deferred and the exact message
// "Live steering is deferred for this release; use delegation_followup
// for amended/ordinary follow-ups or delegation_cancel + relaunch;
// follow-up and cancel/relaunch are not live steering.", stored:false,
// executed:false, no record, no dispatch — deterministically for any
// valid key/message, on codex, opencode default, opencode
// steerable-server, and claude.
//
// Why no server/credentials here: deferral returns BEFORE any engine
// interaction (before queue/api dispatch, before session validation, before
// record creation). This smoke therefore uses only fake shims
// (CODEXPRO_OPENCODE_BIN etc., labeled shim), a per-run isolated fake
// server dir+db path, and mkdtemp roots. No live model calls, no live
// credentials propagated, no session DB shared, no shared :8787. The
// pre-deferral live-steering proof (T1-T13: server argv/mapping, launch,
// happy-path api, uncertain/rejected, bound, cancel-complete, worker/backend
// gone, default/no-session, followup continuation, no auto-promotion,
// secret redaction) is preserved in Git history; this file now verifies
// deferral, not live steering. Do not re-enable live steering.
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

// ---------- fixtures (fake shims only, no live credentials) ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;
const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;
const clAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-clagents-'));
await fsp.writeFile(path.join(clAgents, 'implementer.md'),
  '---\nname: implementer\nmodel: claude-sonnet-5-5\neffort: high\n---\n\nReal Claude agent fixture.\n');
process.env.CODEXPRO_CLAUDE_AGENTS_DIR = clAgents;
const clProjects = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-clprojects-'));
await fsp.mkdir(path.join(clProjects, 'slug'));
process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-shim-'));
const logDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-logs-'));
for (const f of ['serve.log', 'run.log', 'api.log', 'queue.log']) await fsp.writeFile(path.join(logDir, f), '');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const codexShim = await fake('codex-srvdef',
  `if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\n` +
  `if [ "$1" = "queue" ]; then echo "$@" >> ${logDir}/queue.log\necho "queued for next turn"; exit 0; fi\n` +
  `if [ "$1" = "exec" ]; then sleep 60; exit 0; fi\nexit 1`);
process.env.CODEXPRO_CODEX_BIN = codexShim;
const ocShimSrc = `LOGDIR=${logDir}
if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi
if [ "$1" = "serve" ]; then
  echo "serve argv: $@" >> "$LOGDIR/serve.log"
  echo "serve env: DB=\${OPENCODE_V2_DB:-} PWSET=\${OPENCODE_PASSWORD:+yes}" >> "$LOGDIR/serve.log"
  exec sleep 600
fi
if [ "$1" = "run" ]; then
  echo "run argv: $@" >> "$LOGDIR/run.log"
  echo "run env: PWSET=\${OPENCODE_PASSWORD:+yes}" >> "$LOGDIR/run.log"
  exec sleep 60
fi
if [ "$1" = "api" ]; then
  echo "api argv: $@" >> "$LOGDIR/api.log"
  echo '{"data":{"prompted":true}}'; exit 0
fi
echo "unexpected: $@" >&2; exit 2
`;
const ocShim = path.join(shimBin, 'opencode-srvdef');
await fsp.writeFile(ocShim, `#!/bin/sh\n${ocShimSrc}\n`);
await fsp.chmod(ocShim, 0o755);
process.env.CODEXPRO_OPENCODE_BIN = ocShim;
const clShim = await fake('claude-srvdef', 'if [ "$1" = "--version" ]; then echo "2.1.289"; exit 0; fi\nsleep 60\nexit 0');
process.env.CODEXPRO_CLAUDE_BIN = clShim;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-srvdef-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'srvback-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);

const collectedOutputs = [];
const call = async (name, args) => {
  const out = await client.callTool({ name, arguments: args });
  try { collectedOutputs.push(JSON.stringify(out.structuredContent ?? out)); } catch { /* ignore */ }
  try { collectedOutputs.push(String(out.content?.[0]?.text ?? '')); } catch { /* ignore */ }
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
  assert(res.structuredContent?.error === 'steer_deferred', `${label}: error must be steer_deferred`);
  assert(textOf(res) === EXPECTED, `${label}: text must be exact deferred message`);
  assert(res.structuredContent?.stored === false, `${label}: stored must be false`);
  assert(res.structuredContent?.executed === false, `${label}: executed must be false`);
  assert(res.structuredContent?.run_id === runId, `${label}: run_id must echo`);
  assert(res.structuredContent?.engine === engine, `${label}: engine must echo ${engine}`);
}
async function assertNoRecord(runId, label) {
  const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  const steering = r.structuredContent?.steering ?? [];
  assert(Array.isArray(steering) && steering.length === 0, `${label}: no steering record may exist`);
}

// ---------- S1: steerable-server launch still works; steering defers with no api dispatch ----------
const SID_A = 'ses_srvback_deferred_a';
let runA = null;
{
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvdef-a', task: 'Server-backed deferral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvdef-a', timeout_ms: 120000,
    session_id: SID_A, steerable: true
  });
  assert(!launched.isError, `steerable-server launch must work: ${JSON.stringify(launched.structuredContent)}`);
  assert(launched.structuredContent.execution_route === 'steerable-server' && launched.structuredContent.steerable === true,
    `ack must label steerable-server: ${JSON.stringify(launched.structuredContent)}`);
  runA = launched.structuredContent.run_id;
  await waitRunning(runA);
  const rec = readRunFile(runA);
  assert(rec.opencodeRoute === 'steerable-server' && rec.steerable === true, 'run file must record server route');
  assert(rec.opencodeServer && /^http:\/\/127\.0\.0\.1:(?!8787)\d+$/.test(rec.opencodeServer.url), `server url loopback never :8787: ${rec.opencodeServer?.url}`);
  assert(typeof rec.opencodeServer.password === 'string' && rec.opencodeServer.password.length >= 32, 'per-run password recorded');
  const serveLog = await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8');
  assert(/serve argv: serve --hostname 127\.0\.0\.1 --port \d+/.test(serveLog), `serve must bind loopback: ${serveLog.slice(0, 300)}`);
  assert(!serveLog.includes(':8787'), 'serve must never bind shared :8787');
  const aBefore = await apiCalls();
  const qBefore = await queueCalls();
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's1', message: 'steer gently' });
  assertDeferred(s1, runA, 'opencode', 'S1 s1');
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's2', message: 'another valid message' });
  assertDeferred(s2, runA, 'opencode', 'S1 s2');
  const s3 = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 's1', message: 'CHANGED still defers' });
  assertDeferred(s3, runA, 'opencode', 'S1 s1-changed');
  assert((await apiCalls()) === aBefore, 'S1: no api dispatch on server route');
  assert((await queueCalls()) === qBefore, 'S1: no queue dispatch');
  await assertNoRecord(runA, 'S1');
  console.log('ok: S1 steerable-server launch intact, steering defers (no api dispatch, no record)');
}

// ---------- S2: secret non-leak via deferred path ----------
{
  const rec = readRunFile(runA);
  const pw = rec.opencodeServer.password;
  assert(typeof pw === 'string' && pw.length >= 32, 'password must exist to scan against');
  for (const out of collectedOutputs) {
    assert(!out.includes(pw), 'server password must appear in NO tool output (deferred steer leaks nothing)');
  }
  for (const f of ['serve.log', 'run.log', 'api.log']) {
    const text = await fsp.readFile(path.join(logDir, f), 'utf8');
    assert(!text.includes(pw), `server password must appear in NO shim argv log (${f}; env-only, never argv)`);
  }
  console.log('ok: S2 secret non-leak (password in run file only, zero leaks in outputs/logs)');
}

// ---------- S3: all other engines defer identically (no live steering anywhere) ----------
async function proveOther({ label, engine, launchArgs }) {
  const launched = await call('delegation_launch', { workspace_id: wid, ...launchArgs });
  assert(!launched.isError, `${label}: launch must succeed: ${JSON.stringify(launched.structuredContent)}`);
  const id = launched.structuredContent.run_id;
  await waitRunning(id);
  const aBefore = await apiCalls();
  const qBefore = await queueCalls();
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'k1', message: 'probe one' });
  assertDeferred(s1, id, engine, `${label} k1`);
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'k2', message: 'probe two' });
  assertDeferred(s2, id, engine, `${label} k2`);
  assert((await apiCalls()) === aBefore, `${label}: no api dispatch`);
  assert((await queueCalls()) === qBefore, `${label}: no queue dispatch`);
  await assertNoRecord(id, label);
  console.log(`ok: ${label} defers`);
  await bestEffortCancel(id);
  await waitSettled(id);
  // Settled still defers (never a settled-refusal).
  const s3 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'kset', message: 'too late still defers' });
  assertDeferred(s3, id, engine, `${label} settled`);
  await assertNoRecord(id, `${label} settled`);
}
{
  // Cancel runA first to respect max 2 active runs (runA + one other at a time).
  await bestEffortCancel(runA);
  await waitSettled(runA);
  const settledDefer = await call('delegation_steer', { workspace_id: wid, run_id: runA, steering_key: 'kset', message: 'too late still defers' });
  assertDeferred(settledDefer, runA, 'opencode', 'S1 settled');
  await assertNoRecord(runA, 'S1 settled');
  console.log('ok: S1 settled still defers');

  await proveOther({
    label: 'S3 codex ephemeral', engine: 'codex',
    launchArgs: {
      engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
      workdir: 'srvdef-codex', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-srvdef-codex', timeout_ms: 120000
    }
  });
  await proveOther({
    label: 'S3 opencode standalone', engine: 'opencode',
    launchArgs: {
      engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
      workdir: 'srvdef-std', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-srvdef-std', timeout_ms: 120000
    }
  });
  await proveOther({
    label: 'S3 claude', engine: 'claude',
    launchArgs: {
      engine: 'claude', agent: 'implementer',
      workdir: 'srvdef-cl', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-srvdef-cl', timeout_ms: 120000
    }
  });
}

await bestEffortCancel(runA).catch(() => undefined);
console.log('delegation-steer-server-smoke: PASS (deferred on all engines without server credentials; no live model calls; fake-binary results labeled shim)');
