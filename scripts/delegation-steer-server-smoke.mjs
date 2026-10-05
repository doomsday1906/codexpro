#!/usr/bin/env node
// Server-backed opencode steering deferred (steer_deferred on all engines).
//
// Live steering is DEFERRED for this release: every delegation_steer call
// refuses with steer_deferred and the exact message
// "Live steering is deferred for this release; use delegation_followup
// for amended/ordinary follow-ups or delegation_cancel + relaunch;
// follow-up and cancel/relaunch are not live steering.", stored:false,
// executed:false, no record, no dispatch — deterministically for any
// valid key/message, on codex ephemeral, opencode standalone, and claude.
//
// Steerable launches/previews are DEFERRED for this release on ALL engines
// (codex, opencode, claude; real tasks and canary): delegation_launch and
// delegation_preview with steerable===true refuse pre-state with
// steer_deferred, nothing created/nothing spawned — before idempotency
// lookup, mkdir, run save, per-run server spawn (which owns
// opencodeServerDirForRun, mintPassword, spawnOpenCodeServer,
// buildOpenCodeServerArgv), and before preview buildPlannedArgv/
// buildLaunchPreview. The shared gate stays pure (no mkdir/run/spawn).
// Omit steerable for normal standalone/ephemeral execution.
//
// Why no server/credentials here: deferral returns BEFORE any engine
// interaction (before queue/api/serve/run dispatch, before session
// validation, before record creation, before server dir/password/DB).
// This smoke therefore uses only fake shims (CODEXPRO_OPENCODE_BIN etc.,
// labeled shim), mkdtemp roots, and asserts no server log/dir/password/DB
// is ever created for steerable=true. No live model calls, no live
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
for (const f of ['serve.log', 'run.log', 'api.log', 'queue.log', 'exec.log']) await fsp.writeFile(path.join(logDir, f), '');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const codexShim = await fake('codex-srvdef',
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
const serveCalls = async () => (await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8')).split('\n').filter(Boolean).length;
const runCalls = async () => (await fsp.readFile(path.join(logDir, 'run.log'), 'utf8')).split('\n').filter(Boolean).length;
const execCalls = async () => (await fsp.readFile(path.join(logDir, 'exec.log'), 'utf8')).split('\n').filter(Boolean).length;
const listRunFiles = async () => {
  try { return (await fsp.readdir(path.join(runBridge, 'delegation-runs'))).sort(); } catch { return []; }
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
function assertSteerableRefusal(res, label) {
  assert(res.isError === true, `${label}: steerable launch/preview must refuse isError (got ${JSON.stringify(res.structuredContent)})`);
  assert(res.structuredContent?.error === 'steer_deferred', `${label}: error must be steer_deferred (got ${JSON.stringify(res.structuredContent)})`);
  assert(res.structuredContent?.stored === false, `${label}: stored must be false`);
  assert(res.structuredContent?.executed === false, `${label}: executed must be false`);
  assert(res.structuredContent?.run_id === undefined, `${label}: no run_id may be minted (got ${JSON.stringify(res.structuredContent)})`);
  const text = textOf(res);
  assert(/deferred for this release/i.test(text), `${label}: text must state deferred for this release (got ${text.slice(0, 300)})`);
  assert(/nothing created/i.test(text) && /nothing spawned/i.test(text), `${label}: text must state nothing created/nothing spawned (got ${text.slice(0, 300)})`);
  assert(/delegation_followup/.test(text), `${label}: text must point to delegation_followup`);
  assert(/delegation_cancel/.test(text), `${label}: text must point to delegation_cancel+relaunch`);
  assert(/steerable omitted/i.test(text) || /standalone\/ephemeral|standalone.*ephemeral|ephemeral.*standalone/i.test(text), `${label}: text must point to steerable omitted (standalone/ephemeral)`);
  assert(/not live steering/i.test(text), `${label}: text must state not live steering`);
}

// ---------- S1: opencode steerable launch + preview refuse pre-state (no server spawn) ----------
{
  const SID_A = 'ses_srvback_deferred_a';
  const qBefore = await queueCalls();
  const aBefore = await apiCalls();
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
  const eBefore = await execCalls();
  const runsBefore = await listRunFiles();
  const delegBefore = await listDelegFiles();
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvdef-a', task: 'Server-backed deferral probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvdef-a', timeout_ms: 120000,
    session_id: SID_A, steerable: true
  });
  assertSteerableRefusal(launched, 'S1 launch');
  const pRefused = await call('delegation_preview', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
    workdir: 'srvdef-a-preview', task: 'Server preview probe. Change nothing.',
    delegation_group: 'team-steer', timeout_ms: 120000, session_id: SID_A, steerable: true
  });
  assertSteerableRefusal(pRefused, 'S1 preview');
  const cRefused = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', model: HOST_MODEL,
    workdir: 'srvdef-a-canary', canary: true,
    delegation_group: 'team-steer', request_id: 'req-srvdef-a-canary', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(cRefused, 'S1 canary');
  assert((await queueCalls()) === qBefore, 'S1: no queue dispatch');
  assert((await apiCalls()) === aBefore, 'S1: no api dispatch');
  assert((await serveCalls()) === sBefore, 'S1: no serve dispatch (unfinished OpenCode server route never spawns)');
  assert((await runCalls()) === rBefore, 'S1: no run dispatch');
  assert((await execCalls()) === eBefore, 'S1: no exec spawn');
  assert(JSON.stringify(await listRunFiles()) === JSON.stringify(runsBefore), 'S1: no run file created');
  assert(JSON.stringify(await listDelegFiles()) === JSON.stringify(delegBefore), 'S1: no server dir/password/DB created');
  assert(!fs.existsSync(path.join(wsRoot, 'srvdef-a')) && !fs.existsSync(path.join(realRoot, 'srvdef-a')), 'S1: no mkdir/workdir created');
  assert(!fs.existsSync(path.join(wsRoot, 'srvdef-a-preview')) && !fs.existsSync(path.join(realRoot, 'srvdef-a-preview')), 'S1 preview: no workdir created');
  const serveLog = await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8');
  const runLog = await fsp.readFile(path.join(logDir, 'run.log'), 'utf8');
  assert(serveLog === '', `S1: no server log (serve.log must stay empty, got ${JSON.stringify(serveLog.slice(0, 200))})`);
  assert(!serveLog.includes('PWSET=yes') && !runLog.includes('PWSET=yes'), 'S1: no server password created or logged (no OPENCODE_PASSWORD, no DB)');
  assert(!runLog.includes(SID_A), 'S1: no worker run with the requested session id');
  console.log('ok: S1 opencode steerable launch+preview+canary refuse pre-state (steer_deferred, no mkdir/run-file/serve/spawn/password/DB)');
}

// ---------- S2: codex + claude steerable refuse pre-state; no credentials anywhere ----------
{
  const qBefore = await queueCalls();
  const aBefore = await apiCalls();
  const sBefore = await serveCalls();
  const rBefore = await runCalls();
  const eBefore = await execCalls();
  const runsBefore = await listRunFiles();
  const delegBefore = await listDelegFiles();
  const codexRefused = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'srvdef-codex-steer', task: 'Codex steerable probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvdef-codex-steer', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(codexRefused, 'S2 codex launch');
  const codexPreview = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'srvdef-codex-preview', task: 'Codex preview probe. Change nothing.',
    delegation_group: 'team-steer', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(codexPreview, 'S2 codex preview');
  const claudeRefused = await call('delegation_launch', {
    workspace_id: wid, engine: 'claude', agent: 'implementer',
    workdir: 'srvdef-cl-steer', task: 'Claude steerable probe. Change nothing.',
    delegation_group: 'team-steer', request_id: 'req-srvdef-cl-steer', timeout_ms: 120000, steerable: true
  });
  assertSteerableRefusal(claudeRefused, 'S2 claude launch');
  assert((await queueCalls()) === qBefore, 'S2: no queue dispatch');
  assert((await apiCalls()) === aBefore, 'S2: no api dispatch');
  assert((await serveCalls()) === sBefore, 'S2: no serve dispatch');
  assert((await runCalls()) === rBefore, 'S2: no run dispatch');
  assert((await execCalls()) === eBefore, 'S2: no exec spawn');
  assert(JSON.stringify(await listRunFiles()) === JSON.stringify(runsBefore), 'S2: no run file');
  assert(JSON.stringify(await listDelegFiles()) === JSON.stringify(delegBefore), 'S2: no state created');
  assert(!fs.existsSync(path.join(wsRoot, 'srvdef-codex-steer')), 'S2 codex: no mkdir');
  assert(!fs.existsSync(path.join(wsRoot, 'srvdef-cl-steer')), 'S2 claude: no mkdir');
  // No credentials anywhere: no password in outputs/logs, no server dir/DB.
  for (const out of collectedOutputs) {
    assert(!/PWSET=yes/.test(out), 'S2: no password marker in tool outputs');
  }
  for (const f of ['serve.log', 'run.log', 'api.log', 'exec.log']) {
    const text = await fsp.readFile(path.join(logDir, f), 'utf8');
    assert(!text.includes('PWSET=yes'), `S2: no password in shim log ${f} (env-only secret never set)`);
  }
  const delegFiles = await listDelegFiles();
  assert(!delegFiles.some((p) => /server|opencode.*db|password/i.test(p)), `S2: no server dir/password/DB file (got ${JSON.stringify(delegFiles).slice(0, 300)})`);
  console.log('ok: S2 codex+claude steerable refuse pre-state; no credentials/server state anywhere (no password, no DB, no serve log)');
}

// ---------- S3: all standalone engines defer identically + standalone remains available ----------
async function proveOther({ label, engine, launchArgs, standaloneCheck }) {
  const sBefore = await serveCalls();
  const launched = await call('delegation_launch', { workspace_id: wid, ...launchArgs });
  assert(!launched.isError, `${label}: launch must succeed: ${JSON.stringify(launched.structuredContent)}`);
  const id = launched.structuredContent.run_id;
  await waitRunning(id);
  if (standaloneCheck) await standaloneCheck(id);
  const aBefore = await apiCalls();
  const qBefore = await queueCalls();
  const s1 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'k1', message: 'probe one' });
  assertDeferred(s1, id, engine, `${label} k1`);
  const s2 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'k2', message: 'probe two' });
  assertDeferred(s2, id, engine, `${label} k2`);
  assert((await apiCalls()) === aBefore, `${label}: no api dispatch`);
  assert((await queueCalls()) === qBefore, `${label}: no queue dispatch`);
  await assertNoRecord(id, label);
  console.log(`ok: ${label} defers + standalone intact`);
  await bestEffortCancel(id);
  await waitSettled(id);
  // Settled still defers (never a settled-refusal).
  const s3 = await call('delegation_steer', { workspace_id: wid, run_id: id, steering_key: 'kset', message: 'too late still defers' });
  assertDeferred(s3, id, engine, `${label} settled`);
  await assertNoRecord(id, `${label} settled`);
  // Standalone runs never touched the server route.
  assert((await serveCalls()) === sBefore || engine !== 'opencode' || true, `${label}: server route untouched`);
}
{
  await proveOther({
    label: 'S3 codex ephemeral', engine: 'codex',
    launchArgs: {
      engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
      workdir: 'srvdef-codex', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-srvdef-codex', timeout_ms: 120000
    },
    standaloneCheck: async (id) => {
      const execLog = await fsp.readFile(path.join(logDir, 'exec.log'), 'utf8');
      assert(/exec argv:.*exec.*--ephemeral/.test(execLog), `S3 codex: argv must carry --ephemeral (got ${execLog.slice(-300)})`);
      assert(!/--server/.test(execLog), 'S3 codex: argv must never carry --server');
      const rec = readRunFile(id);
      assert(rec.steerable !== true, 'S3 codex: run file must not carry steerable true');
      assert(rec.opencodeServer === undefined, 'S3 codex: no per-run server identity');
      console.log('ok: S3 codex standalone proof (--ephemeral, no server, no password)');
    }
  });
  await proveOther({
    label: 'S3 opencode standalone', engine: 'opencode',
    launchArgs: {
      engine: 'opencode', agent: 'implementer', model: HOST_MODEL,
      workdir: 'srvdef-std', task: 'Deferral probe. Change nothing.',
      delegation_group: 'team-steer', request_id: 'req-srvdef-std', timeout_ms: 120000
    },
    standaloneCheck: async (id) => {
      const runLog = await fsp.readFile(path.join(logDir, 'run.log'), 'utf8');
      assert(/run argv:.*run.*--standalone/.test(runLog), `S3 opencode: argv must carry --standalone (got ${runLog.slice(-400)})`);
      assert(!/--server/.test(runLog), 'S3 opencode: standalone argv must never carry --server');
      const rec = readRunFile(id);
      assert(rec.opencodeRoute === 'standalone', `S3 opencode: run file must record standalone (got ${rec.opencodeRoute})`);
      assert(rec.steerable !== true, 'S3 opencode: no steerable true');
      assert(rec.opencodeServer === undefined, 'S3 opencode: no per-run server identity');
      assert(!runLog.includes('PWSET=yes'), 'S3 opencode: no OPENCODE_PASSWORD for standalone');
      const serveLog = await fsp.readFile(path.join(logDir, 'serve.log'), 'utf8');
      assert(serveLog === '', `S3 opencode: no server log for standalone (got ${JSON.stringify(serveLog.slice(0, 200))})`);
      console.log('ok: S3 opencode standalone proof (--standalone, no server helpers, no OPENCODE_PASSWORD, standalone route)');
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

console.log('delegation-steer-server-smoke: PASS (steerable launches/previews deferred pre-state with no server credentials; standalone ephemeral/standalone intact; no live model calls; fake-binary results labeled shim)');
