#!/usr/bin/env node
// Delegation follow-up + edge-matrix smoke (Leaf 2: hestia-cli-canary).
// Deterministic containment: mkdtemp roots, fake codex/opencode binaries via
// PATH shims, CODEX_HOME fixture, loopback HTTP only for the delivery-identity
// proof. No memory probes, no heavy builds, no live model calls: the real
// `opencode` binary is only ever invoked with --help/--version.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pathToFileUrl(p) { return `file://${p}`; }

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Events = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEvents.js')));

async function awaitRunFile(runFile, predicate, tries = 300, intervalMs = 100) {
  for (let i = 0; i < tries; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const current = readJson(runFile);
      if (predicate(current)) return current;
    } catch { /* not written yet */ }
  }
  return null;
}

// ---------- fixtures: CODEX_HOME + fake binaries ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-followup-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'), [
  'model = "gpt-6-luna"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "read-only"',
  ''
].join('\n'));

const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-followup-shim-'));
await fsp.writeFile(path.join(shimBin, 'fake-codex.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.CODEXPRO_FAKE_CODEX_MODE === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  process.exit(0);
}
const a = fs.readFileSync('fixture-a.txt', 'utf8');
const b = fs.readFileSync('fixture-b.txt', 'utf8');
if (args[0] === 'resume') {
  console.log('CANARY-RESUME-OK:' + a.trim().split('\\n')[0]);
  process.exit(0);
}
console.log('CANARY-REPORT-A:' + a.trim().split('\\n')[0]);
console.log('CANARY-REPORT-B:' + b.trim().split('\\n')[0]);
`);
await fsp.writeFile(path.join(shimBin, 'codex'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-codex.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'codex'), 0o755);
await fsp.writeFile(path.join(shimBin, 'fake-opencode.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'session') {
  const known = String(process.env.CODEXPRO_FAKE_OPENCODE_KNOWN ?? 'ses_fake0000000001,ses_edge0000000001,ses_sleep0000000001,ses_sleep0000000002').split(',').map((s) => s.trim()).filter(Boolean);
  if (args[1] === 'list') {
    console.log(JSON.stringify(known.map((id) => ({ id, title: 'fake-session' }))));
    process.exit(0);
  }
  if (args[1] === 'export') {
    const sid = args[2] ?? '';
    if (known.includes(sid)) {
      console.log(JSON.stringify({ id: sid, title: 'fake-session' }));
      process.exit(0);
    }
    console.error('unknown session ' + sid);
    process.exit(1);
  }
  throw new Error('unexpected opencode session subcommand');
}
if (args[0] !== 'run') throw new Error('expected opencode run');
if (process.env.CODEXPRO_FAKE_OPENCODE_MODE === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  console.log(JSON.stringify({ sessionID: 'ses_sleep0000000002' }));
  process.exit(0);
}
const prompt = args.at(-1) ?? '';
console.log('WORKER-PROMPT::' + String(prompt).slice(0, 500));
const a = fs.readFileSync('fixture-a.txt', 'utf8');
console.log(JSON.stringify({ sessionID: 'ses_edge0000000001' }));
console.log('CANARY-REPORT-A:' + a.trim().split('\\n')[0]);
`);
await fsp.writeFile(path.join(shimBin, 'opencode'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-opencode.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'opencode'), 0o755);

// ---------- Part 1: installed opencode route qualification (help/version only) ----------
{
  const help = spawnSync('opencode', ['run', '--help'], { encoding: 'utf8' });
  assert(help.status === 0, 'opencode run --help must succeed');
  for (const flag of ['--session', '--continue', '--model', '--agent', '--format']) {
    assert(help.stdout.includes(flag), `installed opencode run must support ${flag}`);
  }
  assert(!help.stdout.includes('--profile') && !help.stdout.includes('--ephemeral'), 'opencode run must not mirror Codex flags');
  const version = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  assert(version.status === 0 && (version.stdout + version.stderr).includes('2.0.22'), `installed opencode must be v2.0.22, got ${(version.stdout + version.stderr).trim()}`);
  const host = Engines.describeOpenCodeDiscovery();
  assert(host.hostModel === 'opencode-go/muse-spark-1.3-contributor', `host top-level model must resolve, got ${host.hostModel}`);
  assert(host.hasProvidersBlock === true, 'host config providers block must be observed as evidence');
  assert(host.configPath.endsWith('opencode.jsonc'), 'discovery must report its config path');
  const sessionHelp = spawnSync('opencode', ['session', '--help'], { encoding: 'utf8' });
  assert(sessionHelp.status === 0 && sessionHelp.stdout.includes('list') && !sessionHelp.stdout.includes('resume'), 'opencode session has list/delete/export/import and no native resume subcommand');
  console.log('ok: 1 installed opencode v2.0.22 route qualified (help/version only, no model call)');
}

// ---------- Part 2: MCP server + edge matrix ----------
const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-followup-mcp-'));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'followup-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const workspaceId = opened.structuredContent.workspace_id;
const realRoot = fs.realpathSync.native(wsRoot);
const runFileFor = (runId) => path.join(realRoot, '.ai-bridge', 'delegation-runs', `${runId}.json`);
process.env.CODEX_HOME = codexHome;
process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`;
const hostModel = Engines.describeOpenCodeDiscovery().hostModel;

// 2a: fast completion without any subscription is still replayable via read.
{
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-fast', canary: true, request_id: 'req-edge-fast', timeout_ms: 60000 });
  assert(!launched.isError, `fast launch failed: ${JSON.stringify(launched.structuredContent)}`);
  const terminal = await awaitRunFile(runFileFor(launched.structuredContent.run_id), (r) => ['completed', 'failed'].includes(r.state));
  assert(terminal?.state === 'completed', 'fast canary must complete');
  const read = await call('delegation_read_result', { run_id: launched.structuredContent.run_id });
  assert(!read.isError && read.structuredContent.state === 'completed', 'fast completion must be replayable via read with no subscription');
  assert((read.structuredContent.pending_events ?? []).length >= 1, 'terminal wake-up event must persist even with zero subscribers');
  console.log('ok: 2a fast completion replayable via durable read (subscribe-before-launch optional)');
}

// 2b: duplicate-safe delivery identity (same eventId => same webhook id, loopback).
{
  const secret = Buffer.alloc(32, 4);
  const seenIds = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenIds.push(String(req.headers['webhook-id'] ?? ''));
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const evt = { event: 'run-attention', eventId: 'evt_dup', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'hestia-cli-canary', state: 'completed', seq: 1, version: 1, createdAt: new Date().toISOString() };
  const loopExtra = { lookupHost: async () => [{ address: '127.0.0.1', family: 4 }], allowPrivate: true };
  const first = await Events.deliverEventToSubscription(url, secret, evt, fetch, 10_000, loopExtra);
  const second = await Events.deliverEventToSubscription(url, secret, evt, fetch, 10_000, loopExtra);
  srv.close();
  assert(first.status === 'delivered' && second.status === 'delivered', 'both deliveries must succeed');
  assert(seenIds.length === 2 && seenIds[0] === seenIds[1], 'duplicate delivery must carry the identical deterministic webhook id (receiver dedups)');
  console.log('ok: 2b duplicate event delivery is identity-safe (deterministic webhook id)');
}

// 2c: server restart between completion and delivery reconciles honestly.
{
  const bridge = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-followup-restart-'));
  const now = new Date().toISOString();
  const owner = Store.ownerIdFor(undefined, '1000:/tmp/root');
  const base = {
    version: 1, runId: 'run_cccccccccccccccc', requestId: 'req-restart', delegationGroup: Store.DELEGATION_GROUP,
    engine: 'opencode', model: 'opencode-go/muse-spark-1.3-contributor',
    session: { engine: 'opencode', sessionId: 'ses_edge0000000001', resumable: true, reason: 'test' },
    workspaceId: 'ws_x', workspaceCanonical: '/tmp/root', workdir: '/tmp/root/edge',
    ownerIdHash: owner.ownerIdHash, ownerKind: owner.ownerKind,
    state: 'completed', seq: 2,
    attempts: [{ n: 1, startedAt: now, finishedAt: now, state: 'completed', exitCode: 0, sessionId: 'ses_edge0000000001', summary: 'completed exit 0' }],
    pendingEvents: [{ eventId: 'evt_x', seq: 2, state: 'completed', summary: 'completed exit 0', createdAt: now, deliveries: [{ subId: 'sub_x', status: 'failed', attempts: 1, lastError: 'callback answered 500' }] }],
    checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1, inputRequests: [],
    nextAction: 'poll', createdAt: now, updatedAt: now
  };
  Store.saveDelegationRun(bridge, base);
  // Fresh load with no live handles simulates the restarted server.
  const reloaded = Store.loadDelegationRun(bridge, 'run_cccccccccccccccc');
  const reconciled = Store.reconcileRunState(reloaded, () => { throw new Error('liveness must not be consulted for terminal runs'); });
  assert(reconciled.classification === 'completed-awaiting-delivery', 'completed run with failed delivery must classify awaiting-delivery after restart');
  assert(reconciled.run.session?.sessionId === 'ses_edge0000000001', 'session binding must survive restart');
  const dead = { ...base, runId: 'run_dddddddddddddddd', state: 'running', seq: 0, pendingEvents: [], attempts: [{ n: 1, startedAt: now, state: 'running', pid: 999999997, processStartTime: '999', summary: 'x' }] };
  Store.saveDelegationRun(bridge, dead);
  const deadReloaded = Store.loadDelegationRun(bridge, 'run_dddddddddddddddd');
  const deadReconciled = Store.reconcileRunState(deadReloaded, () => false);
  assert(deadReconciled.classification === 'interrupted' && deadReconciled.run.state === 'interrupted', 'dead running run must be interrupted after restart, never auto-restarted');
  console.log('ok: 2c restart reconciles completed-awaiting-delivery vs interrupted honestly');
}

// 2d: expired subscription stops delivery without any POST; 2e: revoked likewise.
{
  // Delivery state machine under test: opt in explicitly (default is DISABLED).
  // Expired/revoked guards fire before any POST, so no network is touched.
  process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED = '1';
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-sub', canary: true, request_id: 'req-edge-sub', timeout_ms: 60000 });
  assert(!launched.isError, 'sub-matrix launch failed');
  const runId = launched.structuredContent.run_id;
  const terminal = await awaitRunFile(runFileFor(runId), (r) => r.state === 'completed');
  assert(terminal?.state === 'completed', 'sub-matrix run must complete');
  const bridgeDir = path.join(realRoot, '.ai-bridge');
  const goodSecret = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
  const expiredSub = {
    version: 1, subId: 'sub_expired0001', eventName: 'run-attention',
    callbackUrl: 'https://example.com/hook', filter: { delegationGroup: 'hestia-cli-canary' },
    ownerIdHash: terminal.ownerIdHash, ownerKind: terminal.ownerKind,
    createdAt: new Date().toISOString(), secret: goodSecret,
    expiresAt: new Date(Date.now() - 1000).toISOString()
  };
  const revokedSub = { ...expiredSub, subId: 'sub_revoked0001', expiresAt: undefined };
  delete revokedSub.expiresAt;
  const { saveSubscriptions, loadSubscriptions } = Events;
  void loadSubscriptions;
  const { subscriptionsPath } = Store;
  fs.writeFileSync(subscriptionsPath(bridgeDir), JSON.stringify({ version: 1, subscriptions: [expiredSub, revokedSub] }));
  // Attach one pending delivery per sub to the terminal event, then revoke one.
  const run = Store.loadDelegationRun(bridgeDir, runId);
  const evt = run.pendingEvents.at(-1);
  evt.deliveries = [
    { subId: 'sub_expired0001', status: 'pending', attempts: 0 },
    { subId: 'sub_revoked0001', status: 'pending', attempts: 0 }
  ];
  Store.saveDelegationRun(bridgeDir, run);
  fs.writeFileSync(subscriptionsPath(bridgeDir), JSON.stringify({ version: 1, subscriptions: [expiredSub] }));
  const read = await call('delegation_read_result', { run_id: runId });
  assert(!read.isError, 'read must succeed');
  const failed = read.structuredContent.failed_deliveries ?? [];
  const expired = failed.find((d) => d.sub_id === 'sub_expired0001');
  const revoked = failed.find((d) => d.sub_id === 'sub_revoked0001');
  assert(expired?.status === 'permanent' && String(expired.error).includes('expired'), `expired sub must stop delivery as permanent, got ${JSON.stringify(expired)}`);
  assert(revoked?.status === 'permanent' && String(revoked.error).includes('removed'), `revoked sub must stop delivery as permanent, got ${JSON.stringify(revoked)}`);
  // Pump again: permanent deliveries are never retried (duplicate-safe).
  const again = await call('delegation_read_result', { run_id: runId });
  assert(!again.isError, 'second read must succeed');
  const reloaded = readJson(runFileFor(runId));
  const statuses = reloaded.pendingEvents.flatMap((e) => e.deliveries.map((d) => `${d.subId}:${d.status}:${d.attempts}`));
  assert(statuses.filter((s) => s.startsWith('sub_expired0001')).every((s) => s.endsWith(':1') || s.includes('permanent')), 'expired delivery must not be retried');
  fs.writeFileSync(subscriptionsPath(bridgeDir), JSON.stringify({ version: 1, subscriptions: [] }));
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  console.log('ok: 2d/2e expired + revoked subscriptions stop delivery (permanent, exposed, never retried)');
}

// 2f+g: closed-request rejection then attempt-budget exhaustion (all hermetic, fast shims).
{
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-budget', canary: true, request_id: 'req-edge-budget', timeout_ms: 60000 });
  assert(!launched.isError, 'budget launch failed');
  const runId = launched.structuredContent.run_id;
  assert((await awaitRunFile(runFileFor(runId), (r) => r.state === 'completed'))?.state === 'completed', 'budget run must complete');
  const q1 = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'bq-1', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'one?' }] } });
  assert(!q1.isError, 'bq-1 must reach needs-input');
  const r1 = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'br-1', run_id: runId, seq: 1, payload: { a: 1 }, input_request_id: 'bq-1' } });
  assert(!r1.isError && r1.structuredContent.executed === true, 'br-1 must launch attempt 2');
  assert((await awaitRunFile(runFileFor(runId), (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'attempt 2 must complete');
  const q2 = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'bq-2', run_id: runId, seq: 2, payload: {}, questions: [{ id: 'q2', question: 'two?' }] } });
  assert(!q2.isError, 'bq-2 must reach needs-input');
  // Answering the ALREADY-answered bq-1 with a fresh checkpoint id: closed, not applied.
  const closed = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'br-x', run_id: runId, seq: 3, payload: {}, input_request_id: 'bq-1' } });
  assert(closed.isError && closed.structuredContent.error === 'input_request_closed', `answered request must refuse a conflicting re-answer, got ${JSON.stringify(closed.structuredContent)}`);
  const r2 = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'br-2', run_id: runId, seq: 3, payload: { a: 2 }, input_request_id: 'bq-2' } });
  assert(!r2.isError && r2.structuredContent.executed === true && r2.structuredContent.attempt_n === 3, 'br-2 must launch attempt 3 (last budget)');
  assert((await awaitRunFile(runFileFor(runId), (r) => r.state === 'completed' && r.attempts.length === 3))?.attempts.length === 3, 'attempt 3 must complete');
  const q3 = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'bq-3', run_id: runId, seq: 4, payload: {}, questions: [{ id: 'q3', question: 'three?' }] } });
  assert(!q3.isError, 'bq-3 must reach needs-input');
  // Budget exhaustion consumes nothing: the reply is refused (typed error),
  // the request stays open, attempts/seq are unchanged, and the identical
  // retry repeats the refusal instead of hitting duplicate_conflicting.
  const seqBeforeExhausted = readJson(runFileFor(runId)).seq;
  const exhausted = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'br-3', run_id: runId, seq: 5, payload: { a: 3 }, input_request_id: 'bq-3' } });
  assert(exhausted.isError && exhausted.structuredContent.error === 'attempts_exhausted', `budget refusal expected, got ${JSON.stringify(exhausted.structuredContent)}`);
  assert(exhausted.structuredContent.stored === false && exhausted.structuredContent.executed === false, 'budget refusal must not consume the reply');
  const afterExhausted = readJson(runFileFor(runId));
  assert(afterExhausted.attempts.length === 3 && afterExhausted.seq === seqBeforeExhausted, 'exhausted reply must append no attempt and leave seq unchanged');
  assert(afterExhausted.inputRequests.find((r) => r.id === 'bq-3')?.status === 'open', 'exhausted request must stay open');
  const exhaustedAgain = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'br-3', run_id: runId, seq: 5, payload: { a: 3 }, input_request_id: 'bq-3' } });
  assert(exhaustedAgain.isError && exhaustedAgain.structuredContent.error === 'attempts_exhausted', 'retry must repeat the refusal, never duplicate_conflicting');
  console.log('ok: 2f/2g closed-request rejection + attempt-budget refusal (not consumed, open, retryable)');
}

// 2h: cancellation is idempotent with a truthful tree ack (codex sleep + opencode sleep).
{
  process.env.CODEXPRO_FAKE_CODEX_MODE = 'sleep';
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-cancel', canary: true, request_id: 'req-edge-cancel', timeout_ms: 60000 });
  assert(!launched.isError, 'cancel-matrix launch failed');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const cancelled = await call('delegation_cancel', { run_id: launched.structuredContent.run_id });
  assert(!cancelled.isError && cancelled.structuredContent.cleanup_finished === true, `cancel must truthfully reap the tree: ${JSON.stringify(cancelled.structuredContent)}`);
  assert(Array.isArray(cancelled.structuredContent.remaining_pids) && cancelled.structuredContent.remaining_pids.length === 0, 'no owned descendants may remain');
  const again = await call('delegation_cancel', { run_id: launched.structuredContent.run_id });
  assert(!again.isError && again.structuredContent.already_terminal === true, 'cancel must be idempotent');
  delete process.env.CODEXPRO_FAKE_CODEX_MODE;
  process.env.CODEXPRO_FAKE_OPENCODE_MODE = 'sleep';
  const ocLaunched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, workdir: 'edge-cancel-oc', canary: true, request_id: 'req-edge-cancel-oc', timeout_ms: 60000 });
  assert(!ocLaunched.isError, 'opencode cancel-matrix launch failed');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const ocCancelled = await call('delegation_cancel', { run_id: ocLaunched.structuredContent.run_id });
  assert(!ocCancelled.isError && ocCancelled.structuredContent.cleanup_finished === true, 'opencode cancel uses the same exact-tree ack');
  delete process.env.CODEXPRO_FAKE_OPENCODE_MODE;
  console.log('ok: 2h cancellation idempotent with truthful exact-tree ack (both engines)');
}

// 2i: timeout is truthful (min clamp 10s) + stale-PID fail-closed.
{
  assert(Engines.clampCanaryTimeout(1) === 10000, 'timeout clamps up to the 10s minimum');
  assert(Engines.clampCanaryTimeout(999999999) === 300000, 'timeout clamps down to the 5-minute maximum');
  assert(Engines.isProcessIdentityAlive(process.pid, '0') === false, 'wrong starttime must fail closed, never PID-alone trust');
  const mine = Engines.readProcessStartTime(process.pid);
  assert(typeof mine === 'string' && Engines.isProcessIdentityAlive(process.pid, mine) === true, 'correct PID+starttime double-read must verify alive');
  const stale = Engines.collectOwnedTree(999999999, '1');
  assert(stale.staleRoot === true && stale.members.length === 0, 'unprovable root must be stale with no members');
  process.env.CODEXPRO_FAKE_CODEX_MODE = 'sleep';
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-timeout', canary: true, request_id: 'req-edge-timeout', timeout_ms: 1 });
  assert(!launched.isError && launched.structuredContent.timeout_ms === 10000, 'requested 1ms must clamp to 10000ms in the ack');
  delete process.env.CODEXPRO_FAKE_CODEX_MODE;
  const terminal = await awaitRunFile(runFileFor(launched.structuredContent.run_id), (r) => r.state === 'timed_out', 400, 100);
  assert(terminal?.state === 'timed_out' && terminal.result?.timedOut === true, 'sleep worker past the clamped timeout must be timed_out, never silent');
  console.log('ok: 2i timeout truthful (clamped) + PID+starttime fail-closed, never PID alone');
}

// 2j: workspace isolation (escape, blocked glob, symlink refusal).
{
  const escape = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: '../escape', canary: true, request_id: 'req-edge-esc' });
  assert(escape.isError && escape.structuredContent.error === 'workdir_rejected', 'workspace escape must be rejected');
  const blocked = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: '.env/canary', canary: true, request_id: 'req-edge-blocked' });
  assert(blocked.isError && blocked.structuredContent.error === 'workdir_rejected', 'blocked glob workdir must be rejected');
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-followup-outside-'));
  const linkPath = path.join(realRoot, 'edge-link');
  await fsp.symlink(outside, linkPath);
  const symlink = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-link', canary: true, request_id: 'req-edge-link' });
  assert(symlink.isError && symlink.structuredContent.error === 'workdir_rejected', 'write through a symlink must be refused');
  await fsp.rm(linkPath, { force: true });
  console.log('ok: 2j workspace isolation (escape, blocked glob, symlink refusal)');
}

// 2k: one active turn per opencode session.
{
  process.env.CODEXPRO_FAKE_OPENCODE_MODE = 'sleep';
  const first = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, session_id: 'ses_busy1', workdir: 'edge-ses-1', canary: true, request_id: 'req-edge-ses-1', timeout_ms: 60000 });
  assert(!first.isError, `first session launch failed: ${JSON.stringify(first.structuredContent)}`);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const clash = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, session_id: 'ses_busy1', workdir: 'edge-ses-2', canary: true, request_id: 'req-edge-ses-2', timeout_ms: 60000 });
  assert(clash.isError && clash.structuredContent.error === 'session_busy', 'second active turn on one session must be refused');
  const badId = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, session_id: '../x', workdir: 'edge-ses-3', canary: true, request_id: 'req-edge-ses-3' });
  assert(badId.isError && badId.structuredContent.error === 'invalid_session_id', 'malformed session id must be refused');
  const cancelled = await call('delegation_cancel', { run_id: first.structuredContent.run_id });
  assert(!cancelled.isError, 'session holder cancel must succeed');
  const after = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, session_id: 'ses_busy1', workdir: 'edge-ses-4', canary: true, request_id: 'req-edge-ses-4', timeout_ms: 60000 });
  assert(!after.isError, 'settled session must accept a new turn');
  await call('delegation_cancel', { run_id: after.structuredContent.run_id });
  delete process.env.CODEXPRO_FAKE_OPENCODE_MODE;
  console.log('ok: 2k one active turn per session (busy refused, settled re-usable)');
}

// 2m: session-busy follow-up refusal consumes nothing; an unverified explicit
// session is creation-labeled (new-continuation-attempt), never resumed.
{
  const fast = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, session_id: 'ses_busy2', workdir: 'edge-ses-b', canary: true, request_id: 'req-edge-ses-b', timeout_ms: 60000 });
  assert(!fast.isError, `busy-matrix fast launch failed: ${JSON.stringify(fast.structuredContent)}`);
  const bRunId = fast.structuredContent.run_id;
  assert((await awaitRunFile(runFileFor(bRunId), (r) => r.state === 'completed'))?.state === 'completed', 'busy-matrix run must complete');
  process.env.CODEXPRO_FAKE_OPENCODE_MODE = 'sleep';
  const holder = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, session_id: 'ses_busy2', workdir: 'edge-ses-a', canary: true, request_id: 'req-edge-ses-a', timeout_ms: 60000 });
  assert(!holder.isError, 'holder must launch after B settled');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  delete process.env.CODEXPRO_FAKE_OPENCODE_MODE;
  const bq = await call('delegation_followup', { run_id: bRunId, checkpoint: { id: 'busy-q1', run_id: bRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'confirm while busy?' }] } });
  assert(!bq.isError && bq.structuredContent.state === 'needs-input', 'busy-matrix question must reach needs-input');
  const seqBusyBefore = readJson(runFileFor(bRunId)).seq;
  const busyReply = await call('delegation_followup', { run_id: bRunId, checkpoint: { id: 'busy-r1', run_id: bRunId, seq: 1, payload: { answer: 'retry after settle' }, input_request_id: 'busy-q1' } });
  assert(busyReply.isError && busyReply.structuredContent.error === 'session_busy', `busy refusal expected, got ${JSON.stringify(busyReply.structuredContent)}`);
  assert(busyReply.structuredContent.stored === false && busyReply.structuredContent.executed === false, 'busy refusal must not consume the reply');
  const busyAfter = readJson(runFileFor(bRunId));
  assert(busyAfter.attempts.length === 1 && busyAfter.seq === seqBusyBefore, 'busy refusal must append no attempt and leave seq unchanged');
  assert(busyAfter.inputRequests.find((r) => r.id === 'busy-q1')?.status === 'open', 'busy request must stay open');
  await call('delegation_cancel', { run_id: holder.structuredContent.run_id });
  // ses_busy2 is absent from the engine session list: first use creates, so
  // the retry is a labeled new attempt with creation evidence, never resumed.
  const retryBusy = await call('delegation_followup', { run_id: bRunId, checkpoint: { id: 'busy-r1', run_id: bRunId, seq: 1, payload: { answer: 'retry after settle' }, input_request_id: 'busy-q1' } });
  assert(!retryBusy.isError && retryBusy.structuredContent.executed === true && retryBusy.structuredContent.continuation === 'new-continuation-attempt', `unverified session must retry as a labeled new attempt: ${JSON.stringify(retryBusy.structuredContent)}`);
  assert(String(retryBusy.structuredContent.session_evidence).includes('creates'), 'new attempt must cite first-use creation evidence');
  assert((await awaitRunFile(runFileFor(bRunId), (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'creation-labeled continuation must complete');
  console.log('ok: 2m session-busy refusal consumes nothing; unverified session is creation-labeled, never resumed');
}

// 2l: approval-kind questions are data only; question-while-running refused;
// pure checkpoint validators; ack stays idempotent.
{
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-approval', canary: true, request_id: 'req-edge-approval', timeout_ms: 60000 });
  assert(!launched.isError, 'approval-matrix launch failed');
  const runId = launched.structuredContent.run_id;
  assert((await awaitRunFile(runFileFor(runId), (r) => r.state === 'completed'))?.state === 'completed', 'approval-matrix run must complete');
  const q = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'aq-1', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'qa', question: 'may I approve write access?', kind: 'approval' }] } });
  assert(!q.isError && q.structuredContent.state === 'needs-input', 'approval-kind question must register as needs-input');
  const r = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'ar-1', run_id: runId, seq: 1, payload: { approve: true }, input_request_id: 'aq-1' } });
  assert(!r.isError && r.structuredContent.executed === true, 'approval-kind answer must still route to a normal continuation');
  const done = await awaitRunFile(runFileFor(runId), (x) => x.state === 'completed' && x.attempts.length === 2);
  assert(done?.state === 'completed', 'approval continuation must complete under the unchanged gate');
  const read = await call('delegation_read_result', { run_id: runId });
  assert(!read.isError && read.structuredContent.input_requests.find((x) => x.request_id === 'aq-1')?.questions[0]?.kind === 'approval', 'approval kind must persist visibly');
  // Question while an attempt is live: refused, nothing stored.
  process.env.CODEXPRO_FAKE_CODEX_MODE = 'sleep';
  const sleep = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'edge-liveq', canary: true, request_id: 'req-edge-liveq', timeout_ms: 60000 });
  assert(!sleep.isError, 'live-question launch failed');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const liveQ = await call('delegation_followup', { run_id: sleep.structuredContent.run_id, checkpoint: { id: 'lq-1', run_id: sleep.structuredContent.run_id, seq: 0, payload: {}, questions: [{ id: 'q', question: 'too early?' }] } });
  assert(liveQ.isError && liveQ.structuredContent.error === 'question_while_running_refused', 'questions during a live attempt must wait for the run-attention event');
  assert((readJson(runFileFor(sleep.structuredContent.run_id)).checkpoints ?? []).length === 0, 'refused question must store nothing');
  await call('delegation_cancel', { run_id: sleep.structuredContent.run_id });
  delete process.env.CODEXPRO_FAKE_CODEX_MODE;
  // Pure validators: oversized payload + bad id, no MCP needed.
  const fakeRun = { runId: 'run_eeeeeeeeeeeeeeee', checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1, inputRequests: [] };
  const big = Store.validateCheckpointForRun(fakeRun, { id: 'big', run_id: 'run_eeeeeeeeeeeeeeee', seq: 0, payload: { blob: 'x'.repeat(9000) } });
  assert(!big.ok && big.code === 'checkpoint_payload_too_large', 'oversized payload must be rejected');
  const badId = Store.validateCheckpointForRun(fakeRun, { id: 'has space', run_id: 'run_eeeeeeeeeeeeeeee', seq: 0, payload: {}, questions: [{ id: 'q', question: 'x' }] });
  assert(!badId.ok && badId.code === 'invalid_checkpoint_id', 'malformed checkpoint id must be rejected');
  // Ack is idempotent and separate from read.
  const pending = (read.structuredContent.pending_events ?? []).map((e) => e.event_id);
  const ack1 = await call('delegation_read_result', { run_id: runId, ack_event_ids: pending });
  assert(!ack1.isError, 'explicit ack must be accepted');
  const ack2 = await call('delegation_read_result', { run_id: runId, ack_event_ids: pending });
  assert(!ack2.isError && !ack2.structuredContent.acked_event_ids, 're-ack must record nothing new');
  console.log('ok: 2l approval-kind never widens the gate; live-race refused cleanly; validators + idempotent ack');
}

await client.close();

console.log('\ndelegation-followup-smoke: PASS (edge matrix hermetic; model calls: none; loopback: delivery-identity only)');
