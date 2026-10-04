#!/usr/bin/env node
// Delegation storage + spawn-truth smoke.
//
// S1: default layout (legacy OFF) — run/subscription state lives OUTSIDE
//     consumer repos under the user-data delegation dir, namespaced by
//     (owner, canonical workspace); delegation creates NO repo .ai-bridge.
// S2: deliberate migration — pre-seeded legacy .ai-bridge state (runs+subs)
//     is copied to the new authority on first use, counts/bytes verified,
//     the source left intact, a receipt written; the migrated run stays
//     readable through the ordinary authorized path.
// S3: explicit legacy opt-in — the workspace .ai-bridge layout still works.
// S4: spawn-failure truth — proven pre-spawn (spawn threw, no child) stays
//     explicitly retryable; ambiguous post-spawn (child OK, identity-save
//     failed) stays uncertain even when the error-marker save succeeds
//     (same-ID retry never spawns a second worker); initial launch stages
//     pending before spawn and treats pid-less + marker as uncertain.
//
// Deterministic containment: mkdtemp roots, fake codex binary via PATH shim,
// CODEX_HOME Luna fixture, loopback HTTP only. No heavy builds.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function awaitRunFile(file, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const current = readJson(file);
      if (predicate(current)) return current;
    } catch { /* not written yet */ }
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));
const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));

const UID = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown';

// Service user-data root for this smoke (never the real ~/.codexpro).
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
delete process.env.CODEXPRO_HTTP_TOKEN;

function storageCfg(defaultRoot) {
  const realDefault = fs.realpathSync.native(defaultRoot);
  return {
    delegationDir: process.env.CODEXPRO_DELEGATION_DIR,
    legacyBridge: false,
    contextDir: '.ai-bridge',
    ...(process.env.CODEXPRO_HTTP_TOKEN ? { authToken: process.env.CODEXPRO_HTTP_TOKEN } : {}),
    localOwner: `${UID}:${realDefault}`,
    defaultRoot: realDefault
  };
}

const runBridgeFor = (defaultRoot, wsRoot) =>
  Store.resolveDelegationRunBridgeDir(storageCfg(defaultRoot), fs.realpathSync.native(wsRoot));
const authBridgeFor = (defaultRoot) =>
  Store.resolveDelegationAuthorityDir(storageCfg(defaultRoot));

// ---------- fixtures: CODEX_HOME Luna profile + fake codex ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'), [
  'model = "gpt-6-luna"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "read-only"',
  ''
].join('\n'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-shim-'));
await fsp.writeFile(path.join(shimBin, 'fake-codex.mjs'), `
const args = process.argv.slice(2);
if (args[0] !== 'exec') throw new Error('expected codex exec');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0) throw new Error('expected --output-last-message');
await import('node:fs').then((fs) => fs.writeFileSync(args[outputIndex + 1], 'storage real-task last message\\n'));
console.log('STORAGE-REALTASK-DONE');
`);
await fsp.writeFile(path.join(shimBin, 'codex'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-codex.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'codex'), 0o755);
process.env.CODEX_HOME = codexHome;
process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`;

async function makeMcpPair(rootArgs) {
  const config = loadConfig(rootArgs);
  const server = createCodexProServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'storage-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { config, client, call: async (name, args) => client.callTool({ name, arguments: args }) };
}

function goodSecret(fill) {
  return `whsec_${Buffer.alloc(32, fill).toString('base64')}`;
}

async function makeReceiver() {
  const observed = { challenges: 0, deliveries: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* fallthrough */ }
      if (parsed && parsed.type === 'verification' && typeof parsed.challenge === 'string') {
        observed.challenges += 1;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }
      observed.deliveries.push({ body: parsed });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  return { server, url, observed, close: () => server.close() };
}

// ---------- S1: default layout OUTSIDE the repo; no repo .ai-bridge ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-auth1-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-run1-'));
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsA = (await call('open_workspace', { root: authRoot })).structuredContent.workspace_id;
  const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  const receiver = await makeReceiver();
  try {
    const sub = await call('events_subscribe', {
      workspace_id: wsA, callback_url: receiver.url, event_name: 'run-attention',
      filter: { delegation_group: 'hestia-cli-canary' }, webhook_secret: goodSecret(21)
    });
    assert(!sub.isError, `subscribe failed: ${JSON.stringify(sub.structuredContent)}`);
    const realAuth = fs.realpathSync.native(authRoot);
    const realRun = fs.realpathSync.native(runWs);
    const expectedAuthBridge = authBridgeFor(authRoot);
    const expectedRunBridge = runBridgeFor(authRoot, runWs);
    assert(expectedAuthBridge.startsWith(`${delegHome}${path.sep}`), `authority must live under the delegation dir, got ${expectedAuthBridge}`);
    assert(expectedRunBridge.startsWith(`${delegHome}${path.sep}`), `run bridge must live under the delegation dir, got ${expectedRunBridge}`);
    assert(!expectedRunBridge.startsWith(`${realRun}${path.sep}`) && !expectedAuthBridge.startsWith(`${realAuth}${path.sep}`), 'new bridges must not live inside consumer repos');
    assert(fs.existsSync(path.join(expectedAuthBridge, 'delegation-subscriptions.json')), 'subs must persist under the user-data authority');
    const launched = await call('delegation_launch', {
      workspace_id: wsB, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
      workdir: 'storage-real-1', task: 'Report the working directory listing with byte sizes. Change nothing.',
      delegation_group: 'hestia-cli-canary', request_id: 'req-storage-s1', timeout_ms: 60000
    });
    assert(!launched.isError, `launch failed: ${JSON.stringify(launched.structuredContent)}`);
    const runId = launched.structuredContent.run_id;
    const runFile = path.join(expectedRunBridge, 'delegation-runs', `${runId}.json`);
    const terminal = await awaitRunFile(runFile, (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', `run must complete, got ${terminal?.state}`);
    const evt = terminal.pendingEvents.at(-1);
    assert(evt.deliveries.length === 1 && evt.deliveries[0].subId === sub.structuredContent.subscription_id, 'completion must target the authority sub');
    // The strong repo-cleanliness claim: delegation created NO repo bridge dir.
    assert(!fs.existsSync(path.join(realRun, '.ai-bridge')), 'delegation with legacy bridge OFF must create NO repo .ai-bridge dir');
    assert(!fs.existsSync(path.join(realAuth, '.ai-bridge')), 'authority workspace must also gain no repo .ai-bridge dir');
  } finally {
    receiver.close();
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    await client.close();
  }
  console.log('ok: S1 default user-data layout namespaced by (owner, workspace); NO repo .ai-bridge created');
}

// ---------- S2: deliberate migration (copy-only, verified, source intact) ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-auth2-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-run2-'));
  const realAuth = fs.realpathSync.native(authRoot);
  const realRun = fs.realpathSync.native(runWs);
  const owner = Store.ownerIdFor(undefined, `${UID}:${realAuth}`);
  const now = new Date().toISOString();
  const seedRun = (runId, requestId) => ({
    version: 1, runId, requestId, delegationGroup: 'hestia-cli-canary', engine: 'codex', profile: 'CODEX_SCOUT_FAST',
    isCanary: false, task: 'seeded legacy task',
    session: { engine: 'codex', resumable: false, observed: false, evidence: 'seed', reason: 'seed' },
    workspaceId: 'ws_seed', workspaceCanonical: realRun, workdir: path.join(realRun, 'seed-work'),
    ownerIdHash: owner.ownerIdHash, ownerKind: owner.ownerKind,
    state: 'completed', seq: 1,
    attempts: [{ n: 1, startedAt: now, finishedAt: now, state: 'completed', exitCode: 0, summary: 'completed exit 0' }],
    result: { exitCode: 0, signal: null, timedOut: false, summary: 'completed exit 0' },
    pendingEvents: [{ eventId: `evt_seed_${runId.slice(4, 8)}`, seq: 1, state: 'completed', summary: 'completed exit 0', createdAt: now, deliveries: [] }],
    checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1, inputRequests: [],
    nextAction: 'read the terminal result via delegation_read_result', createdAt: now, updatedAt: now
  });
  const legacyRunBridge = path.join(realRun, '.ai-bridge');
  fs.mkdirSync(path.join(legacyRunBridge, 'delegation-runs'), { recursive: true, mode: 0o700 });
  const seeds = [
    ['run_aaaaaaaaaaaaaaaa', 'req-legacy-1'],
    ['run_bbbbbbbbbbbbbbbb', 'req-legacy-2']
  ];
  for (const [runId, requestId] of seeds) {
    fs.writeFileSync(path.join(legacyRunBridge, 'delegation-runs', `${runId}.json`), `${JSON.stringify(seedRun(runId, requestId), null, 2)}\n`, { mode: 0o600 });
  }
  const legacySubsBytes = Buffer.from(`${JSON.stringify({ version: 1, subscriptions: [] })}\n`, 'utf8');
  fs.writeFileSync(path.join(legacyRunBridge, 'delegation-subscriptions.json'), legacySubsBytes, { mode: 0o600 });
  // Legacy run-workspace bridge file (authority-style subs land there when
  // the workspace doubles as its own authority in legacy mode).
  const legacyAuthBridge = path.join(realAuth, '.ai-bridge');
  fs.mkdirSync(path.join(legacyAuthBridge, 'delegation-runs'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyAuthBridge, 'delegation-subscriptions.json'), legacySubsBytes, { mode: 0o600 });
  const beforeRunBytes = seeds.map(([runId]) =>
    fs.readFileSync(path.join(legacyRunBridge, 'delegation-runs', `${runId}.json`)));
  // First delegation use migrates forward.
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  try {
    const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
    const expectedRunBridge = runBridgeFor(authRoot, runWs);
    const expectedAuthBridge = authBridgeFor(authRoot);
    const read = await call('delegation_read_result', { workspace_id: wsB, run_id: 'run_aaaaaaaaaaaaaaaa' });
    assert(!read.isError, `migrated run must stay readable: ${JSON.stringify(read.structuredContent)}`);
    assert(read.structuredContent.state === 'completed', 'migrated run must keep its terminal state');
    // Counts verified: 2 runs + subs under the new authority, bytes equal.
    for (const [index, [runId]] of seeds.entries()) {
      const after = fs.readFileSync(path.join(expectedRunBridge, 'delegation-runs', `${runId}.json`));
      assert(after.equals(beforeRunBytes[index]), `migrated run ${runId} bytes must equal the legacy source`);
    }
    assert(fs.readFileSync(path.join(expectedAuthBridge, 'delegation-subscriptions.json')).equals(legacySubsBytes), 'migrated subs bytes must equal the legacy source');
    const receipt = JSON.parse(fs.readFileSync(path.join(expectedRunBridge, 'delegation-migration.json'), 'utf8'));
    assert(receipt.runFiles === 2 && receipt.from === legacyRunBridge, `migration receipt must record the move, got ${JSON.stringify(receipt)}`);
    // Source left intact: NEVER deleted, NEVER modified.
    for (const [index, [runId]] of seeds.entries()) {
      assert(fs.readFileSync(path.join(legacyRunBridge, 'delegation-runs', `${runId}.json`)).equals(beforeRunBytes[index]), `legacy source ${runId} must be intact`);
    }
    assert(fs.readFileSync(path.join(legacyRunBridge, 'delegation-subscriptions.json')).equals(legacySubsBytes), 'legacy subs source must be intact');
    // Second use performs no second migration (idempotent, no duplication).
    const beforeSecond = fs.readFileSync(path.join(expectedRunBridge, 'delegation-runs', 'run_aaaaaaaaaaaaaaaa.json'));
    const read2 = await call('delegation_read_result', { workspace_id: wsB, run_id: 'run_bbbbbbbbbbbbbbbb' });
    assert(!read2.isError, 'second migrated run must stay readable');
    assert(fs.readFileSync(path.join(expectedRunBridge, 'delegation-runs', 'run_aaaaaaaaaaaaaaaa.json')).equals(beforeSecond), 'second use must not duplicate or rewrite migrated state');
  } finally {
    await client.close();
  }
  console.log('ok: S2 deliberate migration (copy-only, counts/bytes verified, source intact, receipt, idempotent)');
}

// ---------- S3: explicit legacy opt-in keeps the workspace .ai-bridge layout ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-auth3-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-run3-'));
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  try {
    const launched = await call('delegation_launch', {
      workspace_id: wsB, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
      workdir: 'storage-legacy-1', task: 'Report the working directory listing with byte sizes. Change nothing.',
      delegation_group: 'hestia-cli-canary', request_id: 'req-storage-s3', timeout_ms: 60000
    });
    assert(!launched.isError, `legacy launch failed: ${JSON.stringify(launched.structuredContent)}`);
    const realRun = fs.realpathSync.native(runWs);
    const runFile = path.join(realRun, '.ai-bridge', 'delegation-runs', `${launched.structuredContent.run_id}.json`);
    const terminal = await awaitRunFile(runFile, (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', 'legacy run must complete under the workspace bridge');
  } finally {
    await client.close();
    delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
  }
  console.log('ok: S3 explicit legacy opt-in preserves the workspace .ai-bridge layout');
}

// ---------- S4: spawn-failure truth ----------
// S4a: predicate matrix (pure store level).
{
  const now = new Date().toISOString();
  const base = (pending) => ({
    version: 1, runId: 'run_cccccccccccccccc', requestId: 'req-matrix', delegationGroup: 'hestia-cli-canary',
    engine: 'codex', profile: 'CODEX_SCOUT_FAST', isCanary: true,
    session: { engine: 'codex', resumable: false, reason: 'test' },
    workspaceId: 'ws_x', workspaceCanonical: '/tmp/root', workdir: '/tmp/root/edge',
    ownerIdHash: 'x'.repeat(64), ownerKind: 'local', state: 'needs-input', seq: 1,
    attempts: [{ n: 1, startedAt: now, state: 'needs-input', summary: 'x' }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    inputRequests: [], pendingDispatch: pending, nextAction: 'x', createdAt: now, updatedAt: now
  });
  const staged = {
    checkpointId: 'reply1', requestId: 'q1', seq: 2, payload: {}, attemptN: 2,
    continuation: 'new-continuation-attempt', timeoutMs: 60000, prompt: 'p', sessionEvidence: 'e',
    storedAt: now, state: 'pending-dispatch'
  };
  // Pid-less pending, no marker => uncertain (crash window, fail closed).
  assert(Store.isUncertainDispatch(base({ ...staged })) === true, 'pid-less pending without marker must be uncertain');
  // Pid-less + proven pre-spawn marker => explicitly retryable, NOT uncertain.
  const proven = Store.markPendingDispatchFailed(base({ ...staged }), 'spawn ENOENT');
  assert(proven.pendingDispatch.lastDispatchError, 'proven marker must persist');
  assert(Store.isUncertainDispatch(proven) === false, 'pid-less + proven pre-spawn marker must stay retryable');
  // Pid-less + ambiguity marker AND a later-persisted failure marker =>
  // STILL uncertain: the marker proves an error was recorded, never that
  // no child exists (the exact repro shape).
  const ambiguous = Store.markAmbiguousSpawn(base({ ...staged }), 'spawn ok, identity save failed');
  assert(ambiguous.pendingDispatch.spawnAmbiguous === true, 'ambiguity marker must persist');
  assert(Store.isUncertainDispatch(ambiguous) === true, 'pid-less + ambiguity must be uncertain');
  const ambiguousPlusMarker = Store.markPendingDispatchFailed(ambiguous, 'marker save succeeded');
  assert(ambiguousPlusMarker.pendingDispatch.lastDispatchError, 'error-marker persistence must have succeeded in the repro');
  assert(Store.isUncertainDispatch(ambiguousPlusMarker) === true, 'pid-less + ambiguity + persisted marker must STILL be uncertain');
  // With a persisted pid the dispatch is never uncertain (liveness decides).
  const withPid = base({ ...staged });
  withPid.attempts = [{ n: 2, startedAt: now, state: 'queued', pid: 424242, processStartTime: '987', summary: 'pending dispatch for request q1 (checkpoint reply1)' }];
  assert(Store.isUncertainDispatch(withPid) === false, 'pending WITH a pid must not be uncertain');
  // Initial launch: pid-less + marker = uncertain (a non-terminal pid-less
  // launch reservation can never prove pre-spawn).
  const launchPending = { ...staged, checkpointId: 'req-launch-1', requestId: 'req-launch-1', isLaunch: true };
  const launchMarked = Store.markPendingDispatchFailed(base(launchPending), 'observed failure');
  launchMarked.state = 'queued';
  assert(Store.isUncertainDispatch(launchMarked) === true, 'initial-launch pid-less + marker must be uncertain');
  const launchWithPid = base({ ...launchPending, lastDispatchError: 'observed failure' });
  launchWithPid.attempts = [{ n: 1, startedAt: now, state: 'queued', pid: 424243, processStartTime: '988', summary: 'pending dispatch for request req-launch-1 (checkpoint req-launch-1)' }];
  assert(Store.isUncertainDispatch(launchWithPid) === false, 'initial launch WITH a pid must not be uncertain');
  console.log('ok: S4a uncertain-dispatch predicate matrix (proven retryable vs ambiguous/initial-launch uncertain)');
}

// S4b: live transition — successful spawn + failed identity persistence
// throws AmbiguousSpawnError (never a proven pre-spawn error).
{
  assert(typeof Tools.spawnCanaryChildForTest === 'function' || typeof Tools.spawnCanaryChild === 'function', 'spawn seam must be exported for the transition proof');
  const spawnSeam = Tools.spawnCanaryChild ?? Tools.spawnCanaryChildForTest;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-spawn-'));
  const blocker = path.join(tmp, 'not-a-dir');
  await fsp.writeFile(blocker, 'blocks mkdir', 'utf8');
  const badBridge = path.join(blocker, 'bridge');
  const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-spawnwork-'));
  const now = new Date().toISOString();
  const run = {
    version: 1, runId: 'run_dddddddddddddddd', requestId: 'req-spawn-live', delegationGroup: 'hestia-cli-canary',
    engine: 'codex', profile: 'CODEX_SCOUT_FAST', isCanary: false, task: 'live spawn truth',
    session: { engine: 'codex', resumable: false, reason: 'test' },
    workspaceId: 'ws_x', workspaceCanonical: tmp, workdir,
    ownerIdHash: 'y'.repeat(64), ownerKind: 'local', state: 'queued', seq: 0,
    attempts: [{ n: 1, startedAt: now, state: 'queued', summary: 'pending dispatch for request req-spawn-live (checkpoint req-spawn-live)' }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1, inputRequests: [],
    pendingDispatch: {
      checkpointId: 'req-spawn-live', requestId: 'req-spawn-live', seq: 0, payload: {}, attemptN: 1,
      continuation: 'new-continuation-attempt', timeoutMs: 10000, prompt: 'live', sessionEvidence: 'live',
      storedAt: now, state: 'pending-dispatch', isLaunch: true
    },
    nextAction: 'launch staged as pending-dispatch; dispatching initial attempt', createdAt: now, updatedAt: now
  };
  const fakeDeps = { config: { defaultRoot: tmp, contextDir: '.ai-bridge', authToken: undefined }, workspaces: {}, guard: {} };
  let thrown = null;
  try {
    spawnSeam(fakeDeps, badBridge, run, process.execPath, ['--version'], 10000, path.join(workdir, 'last.md'), false);
  } catch (error) {
    thrown = error;
  }
  assert(thrown, 'identity-save failure after a successful spawn must throw');
  assert(Tools.isAmbiguousSpawnError(thrown), `must be AmbiguousSpawnError, got ${thrown?.constructor?.name}: ${thrown?.message}`);
  assert(thrown.childPid !== undefined, 'the ambiguous error must carry the live child pid as evidence a worker exists');
  try { thrown.child?.kill('SIGKILL'); } catch { /* best-effort reaped already */ }
  console.log('ok: S4b live transition (spawn OK + identity-save failed => AmbiguousSpawnError with child pid)');
}

// S4c: MCP retry behavior — uncertain never respawns, proven respawns once,
// initial-launch pid-less + marker stays uncertain.
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-auth4-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-storage-run4-'));
  const realAuth = fs.realpathSync.native(authRoot);
  const realRun = fs.realpathSync.native(runWs);
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  const bridge = runBridgeFor(authRoot, runWs);
  assert(bridge.startsWith(`${delegHome}${path.sep}`), 'S4 must run against the user-data layout');
  const owner = Store.ownerIdFor(undefined, `${UID}:${realAuth}`);
  const now = new Date().toISOString();
  const seedNeedsInput = (runId, requestId, checkpointId) => {
    let run = {
      version: 1, runId, requestId, delegationGroup: 'hestia-cli-canary', engine: 'codex', profile: 'CODEX_SCOUT_FAST',
      isCanary: false, task: 'Seeded real task for spawn-truth retry.',
      session: { engine: 'codex', resumable: false, observed: false, evidence: 'seed', reason: 'seed' },
      workspaceId: wsB, workspaceCanonical: realRun, workdir: path.join(realRun, `s4-${checkpointId}`),
      ownerIdHash: owner.ownerIdHash, ownerKind: owner.ownerKind,
      state: 'completed', seq: 1,
      attempts: [{ n: 1, startedAt: now, finishedAt: now, state: 'completed', exitCode: 0, summary: 'completed exit 0' }],
      result: { exitCode: 0, signal: null, timedOut: false, summary: 'completed exit 0' },
      pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1, inputRequests: [],
      nextAction: 'x', createdAt: now, updatedAt: now
    };
    const registered = Store.registerInputRequest(run, { id: `q-${checkpointId}`, run_id: runId, seq: 1, payload: {} },
      [{ id: `qq-${checkpointId}`, question: 'Need a value?', kind: 'input' }]);
    run = Store.stagePendingDispatch(registered.run, {
      checkpoint: { id: checkpointId, run_id: runId, seq: 2, payload: { answer: 'seed-answer' }, input_request_id: `q-${checkpointId}` },
      requestId: `q-${checkpointId}`, attemptN: 2, continuation: 'new-continuation-attempt',
      timeoutMs: 60000, prompt: 'seeded follow-up prompt', sessionEvidence: 'seed'
    });
    fs.mkdirSync(run.workdir, { recursive: true, mode: 0o700 });
    Store.saveDelegationRun(bridge, run);
    return { runId, checkpoint: { id: checkpointId, run_id: runId, seq: 2, payload: { answer: 'seed-answer' }, input_request_id: `q-${checkpointId}` } };
  };
  try {
    // Uncertain (pid-less, no marker): same-ID retry fails closed, no spawn.
    const u = seedNeedsInput('run_eeeeeeeeeeeeeeee', 'req-s4-uncertain', 'reply-u1');
    const uBefore = readJson(path.join(bridge, 'delegation-runs', `${u.runId}.json`));
    const uRetry = await call('delegation_followup', { workspace_id: wsB, run_id: u.runId, checkpoint: u.checkpoint });
    assert(uRetry.isError && uRetry.structuredContent.error === 'dispatch_uncertain', `pid-less pending must fail closed, got ${JSON.stringify(uRetry.structuredContent)}`);
    const uAfter = readJson(path.join(bridge, 'delegation-runs', `${u.runId}.json`));
    assert(uAfter.attempts.length === uBefore.attempts.length, 'uncertain retry must spawn NO second worker (attempts unchanged)');
    assert(uAfter.attempts.at(-1).pid === undefined, 'uncertain retry must persist no pid');
    // Ambiguous + persisted error marker: STILL uncertain, no spawn (repro).
    const a = seedNeedsInput('run_ffffffffffffffff', 'req-s4-ambiguous', 'reply-a1');
    let aRun = Store.loadDelegationRun(bridge, a.runId);
    aRun = Store.markAmbiguousSpawn(aRun, 'spawn ok, identity save failed');
    aRun = Store.markPendingDispatchFailed(aRun, 'marker save succeeded');
    Store.saveDelegationRun(bridge, aRun);
    assert(Store.isUncertainDispatch(Store.loadDelegationRun(bridge, a.runId)) === true, 'seeded ambiguous+marker state must read uncertain');
    const aRetry = await call('delegation_followup', { workspace_id: wsB, run_id: a.runId, checkpoint: a.checkpoint });
    assert(aRetry.isError && aRetry.structuredContent.error === 'dispatch_uncertain', `ambiguous+marker retry must fail closed, got ${JSON.stringify(aRetry.structuredContent)}`);
    const aAfter = readJson(path.join(bridge, 'delegation-runs', `${a.runId}.json`));
    assert(aAfter.attempts.length === 2, 'ambiguous retry must spawn NO second worker');
    // Proven pre-spawn (marker only): same-ID retry dispatches exactly once.
    const p = seedNeedsInput('run_1111111111111111', 'req-s4-proven', 'reply-p1');
    let pRun = Store.loadDelegationRun(bridge, p.runId);
    pRun = Store.markPendingDispatchFailed(pRun, 'spawn ENOENT (proven pre-spawn)');
    Store.saveDelegationRun(bridge, pRun);
    const pRetry = await call('delegation_followup', { workspace_id: wsB, run_id: p.runId, checkpoint: p.checkpoint });
    assert(!pRetry.isError && pRetry.structuredContent.executed === true && pRetry.structuredContent.attempt_n === 2,
      `proven pre-spawn retry must dispatch attempt 2, got ${JSON.stringify(pRetry.structuredContent)}`);
    const pTerminal = await awaitRunFile(path.join(bridge, 'delegation-runs', `${p.runId}.json`),
      (r) => ['completed', 'failed'].includes(r.state));
    assert(pTerminal, 'proven retry continuation must settle');
    assert(pTerminal.attempts.some((at) => at.n === 2 && at.pid !== undefined), 'proven retry must have dispatched exactly one worker (attempt 2 with pid)');
    assert(pTerminal.attempts.filter((at) => at.n === 2).length === 1, 'proven retry must not duplicate attempt 2');
    // Initial launch: pid-less + marker = uncertain (never a second worker).
    const launchRunId = 'run_2222222222222222';
    let launchRun = {
      version: 1, runId: launchRunId, requestId: 'req-s4-launch', delegationGroup: 'hestia-cli-canary',
      engine: 'codex', profile: 'CODEX_SCOUT_FAST', isCanary: false, task: 'Seeded launch task for uncertainty.',
      session: { engine: 'codex', resumable: false, observed: false, evidence: 'seed', reason: 'seed' },
      workspaceId: wsB, workspaceCanonical: realRun, workdir: path.join(realRun, 's4-launch'),
      ownerIdHash: owner.ownerIdHash, ownerKind: owner.ownerKind,
      state: 'queued', seq: 0, attempts: [], pendingEvents: [], checkpoints: [],
      appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1, inputRequests: [],
      nextAction: 'launch staged as pending-dispatch; dispatching initial attempt', createdAt: now, updatedAt: now
    };
    launchRun = Store.stagePendingLaunch(launchRun, {
      requestId: 'req-s4-launch', attemptN: 1, timeoutMs: 60000,
      prompt: 'Seeded launch task for uncertainty.', sessionEvidence: 'seed'
    });
    launchRun = Store.markPendingDispatchFailed(launchRun, 'observed failure marker persisted');
    launchRun.attempts = [{ n: 1, startedAt: now, state: 'queued', summary: 'pending dispatch for request req-s4-launch (checkpoint req-s4-launch)' }];
    Store.saveDelegationRun(bridge, launchRun);
    const launchRetry = await call('delegation_launch', {
      workspace_id: wsB, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 's4-launch-2',
      task: 'Seeded launch task for uncertainty.', delegation_group: 'hestia-cli-canary',
      request_id: 'req-s4-launch', timeout_ms: 60000
    });
    assert(launchRetry.isError && launchRetry.structuredContent.error === 'launch_uncertain',
      `initial-launch pid-less + marker must fail closed, got ${JSON.stringify(launchRetry.structuredContent)}`);
    const launchAfter = readJson(path.join(bridge, 'delegation-runs', `${launchRunId}.json`));
    assert(launchAfter.attempts.length === 1 && launchAfter.attempts[0].pid === undefined, 'uncertain launch retry must spawn NO worker');
  } finally {
    await client.close();
  }
  console.log('ok: S4c MCP retry behavior (uncertain/ambiguous+marker/initial-launch fail closed; proven dispatches once)');
}

console.log('\ndelegation-storage-smoke: PASS (user-data layout + deliberate migration + legacy opt-in + spawn-failure truth)');
