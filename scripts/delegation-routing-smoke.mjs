#!/usr/bin/env node
// Delegation subscription-routing smoke: ONE canonical subscription authority
// (server defaultRoot bridge) across permitted workspaces.
//
// Proves the routing-split fix: official subscribe stores under the default
// authority, and completion in ANY permitted workspace reads that SAME
// authority (run state stays per-workspace). Covers owner isolation, group
// mismatch, restart persistence, truthful no-target reporting, explicit
// replay without wider-scope backfill, no secret copying, and a real-protocol
// POST /mcp subscribe + cross-workspace run proof.
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

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Events = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEvents.js')));
const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));

function goodSecret(fill) {
  return `whsec_${Buffer.alloc(32, fill).toString('base64')}`;
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

// ---------- fixtures: CODEX_HOME Luna profile + fake codex (real-task only) ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'), [
  'model = "gpt-6-luna"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "read-only"',
  ''
].join('\n'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-shim-'));
await fsp.writeFile(path.join(shimBin, 'fake-codex.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'exec') throw new Error('expected codex exec');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0) throw new Error('expected --output-last-message');
fs.writeFileSync(args[outputIndex + 1], 'routing real-task last message\\n');
console.log('ROUTING-REALTASK-DONE');
`);
await fsp.writeFile(path.join(shimBin, 'codex'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-codex.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'codex'), 0o755);
process.env.CODEX_HOME = codexHome;
process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`;

// Loopback webhook receiver: echoes verification challenges, records
// run-attention deliveries with their subscription binding header.
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
      observed.deliveries.push({
        subId: String(req.headers['x-mcp-subscription-id'] ?? ''),
        webhookId: String(req.headers['webhook-id'] ?? ''),
        body: parsed
      });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  return { server, url, observed, close: () => server.close() };
}

async function makeMcpPair(rootArgs) {
  const config = loadConfig(rootArgs);
  const server = createCodexProServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'routing-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { config, client, call: async (name, args) => client.callTool({ name, arguments: args }) };
}

async function launchRealTask(call, workspaceId, workdir, group, requestId) {
  const launched = await call('delegation_launch', {
    workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
    workdir, task: 'Report the working directory listing with byte sizes. Change nothing.',
    delegation_group: group, request_id: requestId, timeout_ms: 60000
  });
  assert(!launched.isError, `real-task launch failed: ${JSON.stringify(launched.structuredContent)}`);
  assert(launched.structuredContent.is_canary === false, 'must be a real task (is_canary=false)');
  return launched.structuredContent.run_id;
}

function scanForSecrets(dir) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const text = fs.readFileSync(full, 'utf8');
          if (text.includes('whsec_')) hits.push(full);
        } catch { /* binary/unreadable */ }
      }
    }
  };
  walk(dir);
  return hits;
}

// ---------- R0: owner-identity unit (constant-time hash + kind) ----------
{
  const own = { ownerIdHash: 'a'.repeat(64), ownerKind: 'token' };
  assert(Events.subscriptionOwnerMatchesRecord('a'.repeat(64), 'token', own) === true, 'identical owner must match');
  assert(Events.subscriptionOwnerMatchesRecord('b'.repeat(64), 'token', own) === false, 'different hash must not match');
  assert(Events.subscriptionOwnerMatchesRecord('a'.repeat(64), 'local', own) === false, 'different kind must not match');
  assert(Events.subscriptionOwnerMatchesRecord('short', 'token', own) === false, 'different hash length must not match');
  assert(typeof Store.authorityBridgeDirFor === 'function', 'authorityBridgeDirFor must exist');
  const probe = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-authprobe-'));
  assert(Store.authorityBridgeDirFor(probe, '.ai-bridge') === path.join(fs.realpathSync.native(probe), '.ai-bridge'), 'authority dir must derive from defaultRoot + contextDir');
  console.log('ok: R0 owner-identity unit + authority derivation');
}

// ---------- R1: cross-workspace routing (subscribe via A, run in B) ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-auth1-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-run1-'));
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsA = (await call('open_workspace', { root: authRoot })).structuredContent.workspace_id;
  const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  assert(wsA !== wsB, 'authority and run workspaces must differ');
  const receiver = await makeReceiver();
  try {
    const sub = await call('events_subscribe', {
      workspace_id: wsA, callback_url: receiver.url, event_name: 'run-attention',
      filter: { delegation_group: 'hestia-cli-canary' }, webhook_secret: goodSecret(11)
    });
    assert(!sub.isError, `subscribe via authority workspace failed: ${JSON.stringify(sub.structuredContent)}`);
    const subId = sub.structuredContent.subscription_id;
    assert(/^sub_/.test(subId), 'must return a subscription id');
    // Authority storage: subs file ONLY under the defaultRoot bridge.
    const realAuth = fs.realpathSync.native(authRoot);
    const realRun = fs.realpathSync.native(runWs);
    assert(fs.existsSync(path.join(realAuth, '.ai-bridge', 'delegation-subscriptions.json')), 'subs must persist under the authority dir');
    assert(!fs.existsSync(path.join(realRun, '.ai-bridge', 'delegation-subscriptions.json')), 'subs must NOT be copied into the run workspace');
    // Real task + group hestia-cli-canary in the OTHER workspace.
    const runId = await launchRealTask(call, wsB, 'routing-real-1', 'hestia-cli-canary', 'req-routing-r1');
    const runFile = path.join(realRun, '.ai-bridge', 'delegation-runs', `${runId}.json`);
    const terminal = await awaitRunFile(runFile, (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', `run must complete, got ${terminal?.state}`);
    const evt = terminal.pendingEvents.at(-1);
    assert(evt.deliveries.length === 1 && evt.deliveries[0].subId === subId, `completion must target the authority sub, got ${JSON.stringify(evt.deliveries)}`);
    assert(evt.deliveries[0].status === 'pending' && evt.deliveries[0].attempts === 0, 'delivery stays pending while app delivery is OFF (zero POSTs)');
    // No secrets in the run workspace (subId reference only).
    assert(scanForSecrets(path.join(realRun, '.ai-bridge')).length === 0, 'run bridge must never carry whsec_ secrets');
    const subsMode = fs.statSync(path.join(realAuth, '.ai-bridge', 'delegation-subscriptions.json')).mode & 0o777;
    assert(subsMode === 0o600, `authority subs file must be 0600, got 0o${subsMode.toString(8)}`);
  } finally {
    receiver.close();
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    await client.close();
  }
  console.log('ok: R1 cross-workspace routing (subscribe A, run B, target attached, authority-only storage, no secret copy)');
}

// ---------- R2: owner isolation (foreign sub gets nothing) ----------
{
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-auth2-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-run2-'));
  delete process.env.CODEXPRO_HTTP_TOKEN;
  const pair1 = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsB = (await pair1.call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  const receiver = await makeReceiver();
  try {
    const own = await pair1.call('events_subscribe', {
      callback_url: receiver.url, event_name: 'run-attention',
      filter: { delegation_group: 'hestia-cli-canary' }, webhook_secret: goodSecret(12)
    });
    assert(!own.isError, 'own subscribe must succeed');
    const ownId = own.structuredContent.subscription_id;
    // Foreign owner subscribes the same group + callback into the SAME authority.
    process.env.CODEXPRO_HTTP_TOKEN = 'f'.repeat(32);
    const pair2 = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
    const foreign = await pair2.call('events_subscribe', {
      callback_url: receiver.url, event_name: 'run-attention',
      filter: { delegation_group: 'hestia-cli-canary' }, webhook_secret: goodSecret(13)
    });
    assert(!foreign.isError, 'foreign subscribe must succeed independently');
    const foreignId = foreign.structuredContent.subscription_id;
    assert(foreignId !== ownId, 'different principals must yield different sub ids');
    delete process.env.CODEXPRO_HTTP_TOKEN;
    // Own run completes: only the own sub is targeted.
    const runId = await launchRealTask(pair1.call, wsB, 'routing-iso-1', 'hestia-cli-canary', 'req-routing-r2');
    const realRun = fs.realpathSync.native(runWs);
    const terminal = await awaitRunFile(path.join(realRun, '.ai-bridge', 'delegation-runs', `${runId}.json`), (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', 'iso run must complete');
    const ids = terminal.pendingEvents.at(-1).deliveries.map((d) => d.subId);
    assert(ids.length === 1 && ids[0] === ownId, `foreign sub must get nothing, got ${JSON.stringify(ids)}`);
    // Foreign owner cannot read the run either.
    const foreignRead = await pair2.call('delegation_read_result', { run_id: runId });
    assert(foreignRead.isError, 'knowing the run id must grant no access to another owner');
    await pair2.client.close();
  } finally {
    receiver.close();
    delete process.env.CODEXPRO_HTTP_TOKEN;
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    await pair1.client.close();
  }
  console.log('ok: R2 owner isolation (foreign sub untargeted, foreign read denied)');
}

// ---------- R3: group mismatch => truthful no-target (never silent 0) ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-auth3-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-run3-'));
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  const receiver = await makeReceiver();
  try {
    const sub = await call('events_subscribe', {
      callback_url: receiver.url, event_name: 'run-attention',
      filter: { delegation_group: 'some-other-group' }, webhook_secret: goodSecret(14)
    });
    assert(!sub.isError, 'mismatched subscribe must store');
    const runId = await launchRealTask(call, wsB, 'routing-mm-1', 'hestia-cli-canary', 'req-routing-r3');
    const realRun = fs.realpathSync.native(runWs);
    const terminal = await awaitRunFile(path.join(realRun, '.ai-bridge', 'delegation-runs', `${runId}.json`), (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', 'mismatch run must complete');
    assert(terminal.pendingEvents.at(-1).deliveries.length === 0, 'mismatched group must yield zero targets');
    const read = await call('delegation_read_result', { run_id: runId });
    assert(!read.isError, 'read must succeed');
    const structured = read.structuredContent;
    assert(structured.undelivered_count >= 1, `no-target must report undelivered_count>0, got ${structured.undelivered_count}`);
    assert(structured.no_target_events >= 1, `explicit no-target state required, got ${structured.no_target_events}`);
    assert((structured.pending_events ?? []).some((e) => e.no_targets === true), 'per-event no_targets marker required');
    assert(typeof structured.replay_hint === 'string' && structured.replay_hint.includes('delegation_replay_events'), 'replay hint required');
    assert(structured.classification === 'completed-awaiting-delivery', `no-target completed must classify awaiting-delivery, got ${structured.classification}`);
  } finally {
    receiver.close();
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    await client.close();
  }
  console.log('ok: R3 group mismatch is truthful no-target (undelivered_count>0, explicit state, replay hint)');
}

// ---------- R4: restart persistence (reload authority + run file) ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-auth4-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-run4-'));
  const pair1 = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsB = (await pair1.call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  const receiver = await makeReceiver();
  try {
    const sub = await pair1.call('events_subscribe', {
      callback_url: receiver.url, event_name: 'run-attention',
      filter: { delegation_group: 'hestia-cli-canary' }, webhook_secret: goodSecret(15)
    });
    assert(!sub.isError, 'restart-test subscribe must succeed');
    const subId = sub.structuredContent.subscription_id;
    const runId = await launchRealTask(pair1.call, wsB, 'routing-restart-1', 'hestia-cli-canary', 'req-routing-r4');
    const realRun = fs.realpathSync.native(runWs);
    const runFile = path.join(realRun, '.ai-bridge', 'delegation-runs', `${runId}.json`);
    const terminal = await awaitRunFile(runFile, (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', 'restart run must complete');
    assert(terminal.pendingEvents.at(-1).deliveries[0]?.status === 'pending', 'delivery must hold pending while OFF');
    await pair1.client.close();
    // Fresh server = restart: same roots, same credentials, no live handles.
    const pair2 = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
    try {
      const reopened = await pair2.call('open_workspace', { root: runWs });
      assert(!reopened.isError, 'post-restart open_workspace must succeed');
      const read = await pair2.call('delegation_read_result', { run_id: runId });
      assert(!read.isError, 'post-restart read must succeed');
      assert(read.structuredContent.classification === 'completed-awaiting-delivery', 'post-restart must classify awaiting-delivery');
      assert(read.structuredContent.undelivered_count >= 1, 'post-restart must still report pending');
      // Explicit opt-in delivers after restart through the reloaded authority:
      // pump-on-read performs the POST, then the file shows delivered.
      process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED = '1';
      const read2 = await pair2.call('delegation_read_result', { run_id: runId });
      assert(!read2.isError, 'opt-in post-restart read must succeed');
      const final = await awaitRunFile(runFile, (r) =>
        (r.pendingEvents.at(-1)?.deliveries ?? []).some((d) => d.subId === subId && d.status === 'delivered'), 20000);
      assert(final, 'reloaded authority must still deliver after restart');
      const delivery = final.pendingEvents.at(-1).deliveries.find((d) => d.subId === subId);
      assert(delivery?.attempts === 1, `delivery must take one attempt, got ${JSON.stringify(delivery)}`);
      assert(receiver.observed.deliveries.length >= 1, 'loopback receiver must observe the post-restart delivery');
      const seen = receiver.observed.deliveries[0];
      assert(seen.subId === subId && seen.body?.data?.runId === runId, 'observed delivery must bind sub id + run id');
      assert(seen.body?.data?.delegationGroup === 'hestia-cli-canary', 'observed delivery must carry the group');
    } finally {
      delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
      await pair2.client.close();
    }
  } finally {
    receiver.close();
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
  }
  console.log('ok: R4 restart persistence (reload authority + run file, still pending then deliverable)');
}

// ---------- R5: explicit replay, never wider-scope backfill ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-auth5-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-run5-'));
  const { client, call } = await makeMcpPair(['--root', authRoot, '--allow-root', runWs]);
  const wsB = (await call('open_workspace', { root: runWs })).structuredContent.workspace_id;
  const matching = await makeReceiver();
  const wider = await makeReceiver();
  try {
    // Complete with NO subscriptions: explicit no-target state.
    const runId = await launchRealTask(call, wsB, 'routing-replay-1', 'hestia-cli-canary', 'req-routing-r5');
    const realRun = fs.realpathSync.native(runWs);
    const runFile = path.join(realRun, '.ai-bridge', 'delegation-runs', `${runId}.json`);
    const terminal = await awaitRunFile(runFile, (r) => ['completed', 'failed'].includes(r.state));
    assert(terminal?.state === 'completed', 'replay run must complete');
    const eventId = terminal.pendingEvents.at(-1).eventId;
    assert(terminal.pendingEvents.at(-1).deliveries.length === 0, 'must start with no targets');
    // Late subscriptions: one in-scope match, one wider scope (other group).
    const matchSub = await call('events_subscribe', {
      callback_url: matching.url, event_name: 'run-attention',
      filter: { delegation_group: 'hestia-cli-canary' }, webhook_secret: goodSecret(16)
    });
    const widerSub = await call('events_subscribe', {
      callback_url: wider.url, event_name: 'run-attention',
      filter: { delegation_group: 'unrelated-group' }, webhook_secret: goodSecret(17)
    });
    assert(!matchSub.isError && !widerSub.isError, 'late subscribes must store');
    const matchId = matchSub.structuredContent.subscription_id;
    process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED = '1';
    const replayed = await call('delegation_replay_events', { run_id: runId });
    assert(!replayed.isError, `replay must succeed: ${JSON.stringify(replayed.structuredContent)}`);
    assert((replayed.structuredContent.replayed_event_ids ?? []).includes(eventId), 'replay must attach the no-target event');
    assert((replayed.structuredContent.attached_sub_ids ?? []).includes(matchId), 'replay must attach the in-scope sub');
    assert(!(replayed.structuredContent.attached_sub_ids ?? []).includes(widerSub.structuredContent.subscription_id), 'replay must never attach wider-scope subs');
    assert((replayed.structuredContent.still_no_target_event_ids ?? []).length === 0, 'in-scope match leaves nothing targetless');
    const final = await awaitRunFile(runFile, (r) =>
      (r.pendingEvents.at(-1)?.deliveries ?? []).some((d) => d.status === 'delivered'), 20000);
    assert(final, 'replayed delivery must complete');
    assert(matching.observed.deliveries.length === 1, 'matching receiver must get exactly one delivery');
    assert(wider.observed.deliveries.length === 0, 'wider-scope receiver must get NOTHING (no backfill)');
    assert(matching.observed.deliveries[0].body?.eventId === eventId, 'delivery must preserve the historical eventId');
    // Replay is idempotent: second call is a no-op (history preserved).
    const again = await call('delegation_replay_events', { run_id: runId });
    assert(!again.isError && (again.structuredContent.replayed_event_ids ?? []).length === 0, 'second replay must be a no-op');
    assert(scanForSecrets(path.join(realRun, '.ai-bridge')).length === 0, 'run bridge must never carry secrets');
  } finally {
    matching.close();
    wider.close();
    delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    await client.close();
  }
  console.log('ok: R5 explicit replay (in-scope attached+delivered, wider scope gets nothing, idempotent)');
}

// ---------- R6: real-protocol proof (POST /mcp subscribe + cross-workspace run) ----------
{
  delete process.env.CODEXPRO_HTTP_TOKEN;
  process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED = '1';
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  // Trusted loopback-only endpoint proof: explicit opt-in for tokenless HTTP.
  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = '1';
  const authRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-auth6-'));
  const runWs = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-routing-run6-'));
  const config = loadConfig(['--root', authRoot, '--allow-root', runWs]);
  delete process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN;
  const { createCodexProHttpApp } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'http.js')));
  const app = createCodexProHttpApp(config);
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  const receiver = await makeReceiver();
  const parseSse = (text) => {
    try { return JSON.parse(text); } catch { /* SSE envelope */ }
    const line = String(text).split(/\r?\n/).find((l) => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  };
  const postMcp = async (body) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body)
    });
    return { status: response.status, json: parseSse(await response.text()) };
  };
  const postTool = async (name, args, id) => postMcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  try {
    // Real protocol subscribe on the default authority (not a compat tool).
    const sub = await postMcp({
      jsonrpc: '2.0', id: 1, method: 'events/subscribe',
      params: {
        name: 'run-attention', arguments: { delegationGroup: 'hestia-cli-canary' },
        delivery: { mode: 'webhook', url: receiver.url, secret: goodSecret(18) }
      }
    });
    assert(sub.status === 200 && typeof sub.json?.result?.id === 'string', `protocol subscribe failed: ${JSON.stringify(sub.json)}`);
    const subId = sub.json.result.id;
    const realAuth = fs.realpathSync.native(authRoot);
    const realRun = fs.realpathSync.native(runWs);
    assert(fs.existsSync(path.join(realAuth, '.ai-bridge', 'delegation-subscriptions.json')), 'protocol subscribe must store under the default authority');
    // Real task + group hestia-cli-canary in the different allowed workspace.
    const opened = await postTool('open_workspace', { root: runWs }, 2);
    assert(opened.json?.result && !opened.json?.error, `open_workspace failed: ${JSON.stringify(opened.json)}`);
    const workspaceId = opened.json.result.structuredContent.workspace_id;
    const launched = await postTool('delegation_launch', {
      workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
      workdir: 'routing-proto-1', task: 'Report the working directory listing with byte sizes. Change nothing.',
      delegation_group: 'hestia-cli-canary', request_id: 'req-routing-r6', timeout_ms: 60000
    }, 3);
    assert(!launched.json?.error, `protocol-path launch failed: ${JSON.stringify(launched.json)}`);
    const runId = launched.json.result.structuredContent.run_id;
    assert(/^run_[0-9a-f]{16}$/.test(runId), 'launch must return a run id');
    const runFile = path.join(realRun, '.ai-bridge', 'delegation-runs', `${runId}.json`);
    const terminal = await awaitRunFile(runFile, (r) =>
      ['completed', 'failed'].includes(r.state) &&
      (r.pendingEvents.at(-1)?.deliveries ?? []).some((d) => d.subId === subId && (d.status === 'delivered' || d.status === 'failed')), 30000);
    assert(terminal, 'run must reach terminal state with a delivery attempt to the protocol sub');
    const delivery = terminal.pendingEvents.at(-1).deliveries.find((d) => d.subId === subId);
    assert(delivery?.status === 'delivered' && delivery?.attempts === 1, `delivery must be attempted+delivered, got ${JSON.stringify(delivery)}`);
    assert(receiver.observed.deliveries.length >= 1, 'receiver must OBSERVE the cross-workspace delivery');
    const seen = receiver.observed.deliveries.find((d) => d.body?.data?.runId === runId);
    assert(seen && seen.subId === subId, 'observed delivery must bind the protocol sub id + run id');
    assert(seen.body?.data?.delegationGroup === 'hestia-cli-canary', 'observed delivery must carry the group');
    assert(!fs.existsSync(path.join(realRun, '.ai-bridge', 'delegation-subscriptions.json')), 'run workspace must hold no subscription copy');
    assert(scanForSecrets(path.join(realRun, '.ai-bridge')).length === 0, 'run bridge must never carry secrets');
  } finally {
    receiver.close();
    await new Promise((resolve) => listener.close(resolve));
    delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
  }
  console.log('ok: R6 real-protocol proof (POST /mcp subscribe on authority + /tmp run delivers to matching sub)');
}

console.log('\ndelegation-routing-smoke: PASS (one authority; owner+filter selection; truthful no-target; explicit replay; real-protocol cross-workspace delivery)');
