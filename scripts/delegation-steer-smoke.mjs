#!/usr/bin/env node
// delegation_steer + steerable launch/preview deferred release contract (all engines).
//
// Live steering is DEFERRED for this release on every engine (codex,
// opencode standalone, claude). Every delegation_steer call refuses with
// steer_deferred, exact message
// "Live steering is deferred for this release; use delegation_followup
// for amended/ordinary follow-ups or delegation_cancel + relaunch;
// follow-up and cancel/relaunch are not live steering.", stored:false,
// executed:false, no steering record, no engine dispatch.
//
// Steerable launches/previews are DEFERRED for this release on ALL engines
// (codex, opencode, claude; real tasks and canary): delegation_launch and
// delegation_preview with steerable===true refuse pre-state with
// steer_deferred, nothing created/nothing spawned — before idempotency
// lookup, mkdir, run save, per-run server spawn, and preview argv. The
// shared gate stays pure (no mkdir/run/spawn). Omit steerable for normal
// standalone/ephemeral execution (codex --ephemeral, opencode --standalone,
// no server helpers, no OPENCODE_PASSWORD); use delegation_followup or
// delegation_cancel + relaunch with steerable omitted — follow-up and
// cancel/relaunch are not live steering.
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
for (const f of ['queue.log', 'serve.log', 'run.log', 'api.log', 'exec.log']) await fsp.writeFile(path.join(logDir, f), '');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const codexShim = await fake('codex-steer',
  `if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\n` +
  `if [ "$1" = "queue" ]; then echo "$@" >> ${logDir}/queue.log\necho "queued for next turn"; exit 0; fi\n` +
  `if [ "$1" = "exec" ]; then echo "exec argv: $@" >> ${logDir}/exec.log\nsleep 60; exit 0; fi\nexit 1`);
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
const ocShim = path.join(shimBin, 'opencode-steer');
await fsp.writeFile(ocShim, `#!/bin/sh\n${ocShimSrc}\n`);
await fsp.chmod(ocShim, 0o755);
process.env.CODEXPRO_OPENCODE_BIN = ocShim;
const clShim = await fake('claude-steer', 'if [ "$1" = "--version" ]; then echo "2.1.289"; exit 0; fi\nsleep 60\nexit 0');
process.env.CODEXPRO_CLAUDE_BIN = clShim;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-steer-deleghome-'));
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
const client = new Client({ name: 'steer-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
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
const tools = await client.listTools();
assert(tools.tools.some((t) => t.name === 'delegation_steer'), 'delegation_steer must be registered');
const steerDesc = tools.tools.find((t) => t.name === 'delegation_steer').description ?? '';
assert(/DEFERRED/i.test(steerDesc) && /steer_deferred/.test(steerDesc), `delegation_steer description must name deferral: ${steerDesc.slice(0, 200)}`);
// Launch/preview steerable fields must state deferred/refused, not available.
{
  const launchTool = tools.tools.find((t) => t.name === 'delegation_launch');
  const previewTool = tools.tools.find((t) => t.name === 'delegation_preview');
  const launchSteer = launchTool?.inputSchema?.properties?.steerable?.description ?? JSON.stringify(launchTool ?? {});
  const previewSteer = previewTool?.inputSchema?.properties?.steerable?.description ?? JSON.stringify(previewTool ?? {});
  for (const [label, desc] of [['launch steerable', launchSteer], ['preview steerable', previewSteer]]) {
    assert(/DEFERRED/i.test(desc), `${label} description must state DEFERRED (got ${String(desc).slice(0, 220)})`);
    assert(/refus/i.test(desc), `${label} description must state refused (got ${String(desc).slice(0, 220)})`);
    assert(/steer_deferred/.test(desc), `${label} description must name steer_deferred (got ${String(desc).slice(0, 220)})`);
    assert(!/without --ephemeral so the session persists/i.test(desc), `${label} description must not present steerable as available (got ${String(desc).slice(0, 220)})`);
  }
  console.log('ok: tool descriptions mark steerable launches/previews deferred/refused (steer_deferred)');
}

const queueCalls = async () => (await fsp.readFile(path.join(logDir, 'queue.log'), 'utf8')).split('\n').filter(Boolean).length;
const apiCalls = async () => (await fsp.readFile(path.join(logDir, 'api.log'), 'utf8')).split('\n').filter(Boolean).length;
const serveCalls = async () => (await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8')).split('\n').filter(Boolean).length;
const runCalls = async () => (await fsp.readFile(path.join(logDir, 'run.log'), 'utf8')).split('\n').filter(Boolean).length;
const execCalls = async () => (await fsp.readFile(path.join(logDir, 'exec.log'), 'utf8')).split('\n').filter(Boolean).length;
const listRunFiles = async () => {
  try {
    return (await fsp.readdir(path.join(runBridge, 'delegation-runs'))).sort();
  } catch {
    return [];
  }
};
const listDelegFiles = async () => {
  const out = [];
  const stack = [delegHome];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      out.push(path.relative(delegHome, full));
    }
  }
  return out.sort();
};
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

function assertSteerableRefusal(res, label) {
  assert(res.isError === true, `${label}: steerable launch/preview must refuse isError (got ${JSON.stringify(res.structuredContent)})`);
  assert(res.structuredContent?.error === 'steer_deferred', `${label}: error must be steer_deferred (got ${JSON.stringify(res.structuredContent)})`);
  assert(res.structuredContent?.stored === false, `${label}: stored must be false`);
  assert(res.structuredContent?.executed === false, `${label}: executed must be false`);
  assert(res.structuredContent?.run_id === undefined, `${label}: no run_id may be minted (got ${JSON.stringify(res.structuredContent)})`);
  const text = textOf(res);
  assert(/deferred for this release/i.test(text), `${label}: text must state deferred for this release (got ${text.slice(0, 300)})`);
  assert(/nothing created/i.test(text) && /nothing spawned/i.test(text), `${label}: text must state nothing created/nothing spawned (got ${text.slice(0, 300)})`);
  assert(/delegation_followup/.test(text), `${label}: text must point to delegation_followup (got ${text.slice(0, 300)})`);
  assert(/delegation_cancel/.test(text), `${label}: text must point to delegation_cancel+relaunch (got ${text.slice(0, 300)})`);
  assert(/steerable omitted/i.test(text) || /standalone\/ephemeral|standalone.*ephemeral|ephemeral.*standalone/i.test(text), `${label}: text must point to steerable omitted (standalone/ephemeral) (got ${text.slice(0, 300)})`);
  assert(/not live steering/i.test(text), `${label}: text must state not live steering (got ${text.slice(0, 300)})`);
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

// D1: codex ephemeral (default, no steerable) — normal standalone remains available.
{
  const qBefore = await queueCalls();
  void qBefore;
  const eBefore = await execCalls();
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
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
  // Standalone proof: codex --ephemeral, no server helpers, no password, ephemeral route.
  const execLog = await fsp.readFile(path.join(logDir, 'exec.log'), 'utf8');
  assert(/exec argv:.*exec.*--ephemeral/.test(execLog), `D1: codex argv must carry --ephemeral (got ${execLog.slice(0, 300)})`);
  assert(!/--server/.test(execLog), `D1: codex argv must never carry --server (got ${execLog.slice(0, 300)})`);
  assert((await execCalls()) === eBefore + 1, 'D1: exactly one codex exec spawn');
  assert((await serveCalls()) === sBefore, 'D1: no opencode serve dispatch for codex ephemeral');
  assert((await runCalls()) === rBefore, 'D1: no opencode run dispatch for codex ephemeral');
  const rec = readRunFile(id);
  assert(rec.steerable !== true, `D1: run file must not carry steerable true (got ${JSON.stringify(rec.steerable)})`);
  assert(rec.opencodeServer === undefined, 'D1: codex run must carry no per-run server identity');
  assert(rec.profile === 'CODEX_SCOUT_FAST', 'D1: run file must record the selected profile');
  console.log('ok: D1 standalone proof (codex --ephemeral, no server helpers, no OPENCODE_PASSWORD, no serve/run dispatch)');
  await bestEffortCancel(id);
  await waitSettled(id);
  // Settled runs still defer (never a settled-refusal).
  const qBefore2 = await queueCalls();
  const s = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'kset', message: 'too late still defers' });
  assertDeferred(s, id, 'codex', 'D1 settled');
  assert((await queueCalls()) === qBefore2, 'D1 settled: no dispatch');
  await assertNoRecord(id, 'D1 settled');
  console.log('ok: D1 settled still defers');
  owned.pop();
}

// D2: codex steerable launch + preview refuse pre-state (nothing created/spawned).
{
  const qBefore = await queueCalls();
  const aBefore = await apiCalls();
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
  const eBefore = await execCalls();
  const runsBefore = await listRunFiles();
  const delegBefore = await listDelegFiles();
  const workdirPath = path.join(wsRoot, 'steer-d2');
  const workdirReal = path.join(realRoot, 'steer-d2');
  const refused = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-d2', task: 'Steerable deferral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-d2', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(refused, 'D2 launch');
  const pRefused = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'steer-d2-preview', task: 'Steerable preview probe. Change nothing.',
    delegation_group: 'team-steer', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(pRefused, 'D2 preview');
  // Canary + steerable also refuses with the same pre-state error.
  const cRefused = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
    workdir: 'steer-d2-canary', canary: true,
    delegation_group: 'team-steer', request_id: 'req-steer-d2-canary', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(cRefused, 'D2 canary');
  assert((await queueCalls()) === qBefore, 'D2: no codex queue dispatch');
  assert((await apiCalls()) === aBefore, 'D2: no opencode api dispatch');
  assert((await serveCalls()) === sBefore, 'D2: no serve dispatch (no mkdir/server dir/password/DB)');
  assert((await runCalls()) === rBefore, 'D2: no run dispatch');
  assert((await execCalls()) === eBefore, 'D2: no exec spawn');
  assert(JSON.stringify(await listRunFiles()) === JSON.stringify(runsBefore), 'D2: no run file created');
  assert(JSON.stringify(await listDelegFiles()) === JSON.stringify(delegBefore), 'D2: no server dir/password/DB created');
  assert(!fs.existsSync(workdirPath) && !fs.existsSync(workdirReal), 'D2: no mkdir/workdir created');
  assert(!fs.existsSync(path.join(wsRoot, 'steer-d2-preview')) && !fs.existsSync(path.join(realRoot, 'steer-d2-preview')), 'D2 preview: no workdir created');
  const serveLog = await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8');
  assert(!/PWSET=yes/.test(serveLog), 'D2: no server password in serve log');
  console.log('ok: D2 codex steerable launch+preview+canary refuse pre-state (steer_deferred, no mkdir/run-file/spawn/server)');
}

// D3: opencode default (standalone) — normal standalone remains available.
{
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
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
  // Standalone proof: opencode --standalone, no server helpers, no password, standalone route.
  const runLog = await fsp.readFile(path.join(logDir, 'run.log'), 'utf8');
  assert(/run argv:.*run.*--standalone/.test(runLog), `D3: opencode argv must carry --standalone (got ${runLog.slice(-400)})`);
  assert(!/--server/.test(runLog), `D3: standalone argv must never carry --server (got ${runLog.slice(-400)})`);
  assert((await serveCalls()) === sBefore, 'D3: no serve dispatch for standalone');
  assert((await runCalls()) === rBefore + 2, 'D3: exactly one standalone run spawn (argv + env lines)');
  const rec = readRunFile(id);
  assert(rec.opencodeRoute === 'standalone', `D3: run file must record standalone route (got ${rec.opencodeRoute})`);
  assert(rec.steerable !== true, 'D3: run file must not carry steerable true');
  assert(rec.opencodeServer === undefined, 'D3: standalone run must carry no per-run server identity');
  assert(!runLog.includes('PWSET=yes'), 'D3: no OPENCODE_PASSWORD for standalone (env-only server secret never set)');
  console.log('ok: D3 standalone proof (opencode --standalone, no server helpers, no OPENCODE_PASSWORD, opencodeRoute standalone)');
  await bestEffortCancel(id);
  await waitSettled(id);
  owned.pop();
}

// D4: opencode steerable-server launch + preview refuse pre-state (no server spawn).
{
  const SID = 'ses_steer_deferred_d4';
  const qBefore = await queueCalls();
  const aBefore = await apiCalls();
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
  const eBefore = await execCalls();
  const runsBefore = await listRunFiles();
  const delegBefore = await listDelegFiles();
  const refused = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'steer-d4', task: 'Server deferral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-d4', timeout_ms: 120000,
    session_id: SID, steerable: true
  });
  assertSteerableRefusal(refused, 'D4 launch');
  const pRefused = await call('delegation_preview', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'steer-d4-preview', task: 'Server preview probe. Change nothing.',
    delegation_group: 'team-steer', timeout_ms: 120000, session_id: SID, steerable: true
  });
  assertSteerableRefusal(pRefused, 'D4 preview');
  const cRefused = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', model: HOST_MODEL,
    workdir: 'steer-d4-canary', canary: true,
    delegation_group: 'team-steer', request_id: 'req-steer-d4-canary', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(cRefused, 'D4 canary');
  assert((await apiCalls()) === aBefore, 'D4: no api dispatch');
  assert((await queueCalls()) === qBefore, 'D4: no queue dispatch');
  assert((await serveCalls()) === sBefore, 'D4: no serve dispatch (unfinished OpenCode server route never spawns)');
  assert((await runCalls()) === rBefore, 'D4: no run dispatch');
  assert((await execCalls()) === eBefore, 'D4: no exec spawn');
  assert(JSON.stringify(await listRunFiles()) === JSON.stringify(runsBefore), 'D4: no run file created');
  assert(JSON.stringify(await listDelegFiles()) === JSON.stringify(delegBefore), 'D4: no server dir/password/DB created');
  assert(!fs.existsSync(path.join(wsRoot, 'steer-d4')) && !fs.existsSync(path.join(realRoot, 'steer-d4')), 'D4: no mkdir/workdir created');
  assert(!fs.existsSync(path.join(wsRoot, 'steer-d4-preview')) && !fs.existsSync(path.join(realRoot, 'steer-d4-preview')), 'D4 preview: no workdir created');
  const serveLog = await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8');
  const runLog = await fsp.readFile(path.join(logDir, 'run.log'), 'utf8');
  assert(!serveLog.includes('serve argv:'), 'D4: no server log (no serve spawn)');
  assert(!runLog.includes(SID) || (await runCalls()) === rBefore, 'D4: no worker run with the requested session id');
  assert(!serveLog.includes('PWSET=yes') && !runLog.includes('PWSET=yes'), 'D4: no server password created or logged');
  console.log('ok: D4 opencode steerable launch+preview+canary refuse pre-state (steer_deferred, no mkdir/run-file/serve/spawn/password)');
}

// D5: claude (no steer verb; still deferred, never emulated) + claude steerable refuses.
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
  // Claude steerable=true also refuses pre-state (strict ===true, hard-false preserved).
  const qBefore = await queueCalls();
  const aBefore = await apiCalls();
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
  const eBefore = await execCalls();
  const runsBefore = await listRunFiles();
  const delegBefore = await listDelegFiles();
  const refused = await call('delegation_launch', {
    workspace_id: wid, engine: 'claude', agent: 'implementer',
    workdir: 'steer-d5-steerable', task: 'Claude steerable probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-steer-d5-steerable', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(refused, 'D5 claude steerable launch');
  const pRefused = await call('delegation_preview', {
    workspace_id: wid, engine: 'claude', agent: 'implementer',
    workdir: 'steer-d5-preview', task: 'Claude preview probe. Change nothing.',
    delegation_group: 'team-steer', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(pRefused, 'D5 claude steerable preview');
  assert((await queueCalls()) === qBefore, 'D5 steerable: no queue dispatch');
  assert((await apiCalls()) === aBefore, 'D5 steerable: no api dispatch');
  assert((await serveCalls()) === sBefore, 'D5 steerable: no serve dispatch');
  assert((await runCalls()) === rBefore, 'D5 steerable: no run dispatch');
  assert((await execCalls()) === eBefore, 'D5 steerable: no exec spawn');
  assert(JSON.stringify(await listRunFiles()) === JSON.stringify(runsBefore), 'D5 steerable: no run file');
  assert(JSON.stringify(await listDelegFiles()) === JSON.stringify(delegBefore), 'D5 steerable: no state created');
  assert(!fs.existsSync(path.join(wsRoot, 'steer-d5-steerable')), 'D5 steerable: no mkdir');
  console.log('ok: D5 claude steerable launch+preview refuse pre-state (hard-false preserved, steer_deferred)');
}

for (const id of owned) await bestEffortCancel(id);
console.log('delegation-steer-smoke: PASS (steerable launches/previews deferred pre-state; standalone ephemeral/standalone intact; no live model calls; fake-binary results labeled shim)');
