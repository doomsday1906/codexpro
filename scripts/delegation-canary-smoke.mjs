#!/usr/bin/env node
// Delegation + MCP Events canary smoke (Leaf 1: hestia-cli-canary, Luna-only).
// Deterministic containment: mkdtemp roots, fake codex binary via PATH shim,
// CODEX_HOME fixture, loopback HTTP only for the webhook wire proof.
// No memory-exhaustion probes, no heavy builds.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
    encoding: 'utf8'
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function quoteArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Events = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEvents.js')));
function pathToFileUrl(p) { return `file://${p}`; }

// Delegation state lives OUTSIDE repos under this smoke-scoped user-data
// root (legacy bridge OFF): run/authority bridges resolve per (owner,
// workspace) via the Store helpers below, never as repo .ai-bridge dirs.
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
const smokeUid = typeof process.getuid === 'function' ? String(process.getuid()) : 'unknown';
const delegCfgFor = (defaultRoot) => {
  const realDefault = fs.realpathSync.native(defaultRoot);
  return {
    delegationDir: delegHome, legacyBridge: false, contextDir: '.ai-bridge',
    ...(process.env.CODEXPRO_HTTP_TOKEN ? { authToken: process.env.CODEXPRO_HTTP_TOKEN } : {}),
    localOwner: `${smokeUid}:${realDefault}`, defaultRoot: realDefault
  };
};
const runBridgeFor = (defaultRoot, wsRoot = defaultRoot) =>
  Store.resolveDelegationRunBridgeDir(delegCfgFor(defaultRoot), fs.realpathSync.native(wsRoot));

// ---------- fixtures: CODEX_HOME + fake codex ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'), [
  'model = "gpt-6-luna"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "read-only"',
  ''
].join('\n'));
await fsp.writeFile(path.join(codexHome, 'WRONGMODEL.config.toml'), [
  'model = "gpt-zzz"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "read-only"',
  ''
].join('\n'));
await fsp.writeFile(path.join(codexHome, 'WRONGSANDBOX.config.toml'), [
  'model = "gpt-6-luna"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "workspace-write"',
  ''
].join('\n'));

const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-shim-'));
await fsp.writeFile(path.join(shimBin, 'fake-codex.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'exec' || !args.includes('--ephemeral')) throw new Error('expected codex exec --ephemeral');
const profileIndex = args.indexOf('--profile');
if (profileIndex < 0) throw new Error('expected --profile');
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0) throw new Error('expected --output-last-message');
if (process.env.CODEXPRO_FAKE_CODEX_MODE === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  console.log('fake codex sleep done');
  process.exit(0);
}
const prompt = args.at(-1) ?? '';
console.log('WORKER-PROMPT::' + String(prompt).slice(0, 500));
let a = null;
let b = null;
try { a = fs.readFileSync('fixture-a.txt', 'utf8'); } catch { /* real-task workdirs stage no fixtures */ }
try { b = fs.readFileSync('fixture-b.txt', 'utf8'); } catch { /* real-task workdirs stage no fixtures */ }
if (a === null || b === null) {
  fs.writeFileSync(args[outputIndex + 1], 'realtask last message\\n');
  console.log('REALTASK-NO-FIXTURES');
  process.exit(0);
}
fs.writeFileSync(args[outputIndex + 1], 'canary last message\\n');
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
if (args[0] !== 'run' || !args.includes('--model') || !args.includes('--format')) throw new Error('expected opencode run --model ... --format json');
if (args.includes('--profile') || args.includes('exec') || args.includes('--ephemeral') || args.includes('--output-last-message')) {
  throw new Error('opencode must never receive Codex flags');
}
const modelIndex = args.indexOf('--model');
if (args[modelIndex + 1] !== 'opencode-go/muse-spark-1.3-contributor') throw new Error('opencode fake expects the host model, got ' + args[modelIndex + 1]);
const prompt = args.at(-1) ?? '';
console.log('WORKER-PROMPT::' + String(prompt).slice(0, 500));
if (process.env.CODEXPRO_FAKE_OPENCODE_MODE === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  console.log(JSON.stringify({ sessionID: 'ses_sleep0000000001' }));
  process.exit(0);
}
const sid = process.env.CODEXPRO_FAKE_OPENCODE_SESSION ?? 'ses_fake0000000001';
console.log(JSON.stringify({ sessionID: sid }));
let a = null;
try { a = fs.readFileSync('fixture-a.txt', 'utf8'); } catch { /* real-task workdirs stage no fixtures */ }
if (a === null) {
  console.log('REALTASK-NO-FIXTURES');
  process.exit(0);
}
const b = fs.readFileSync('fixture-b.txt', 'utf8');
console.log('CANARY-REPORT-A:' + a.trim().split('\\n')[0]);
console.log('CANARY-REPORT-B:' + b.trim().split('\\n')[0]);
`);
await fsp.writeFile(path.join(shimBin, 'opencode'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-opencode.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'opencode'), 0o755);
const shimEnv = {
  CODEX_HOME: codexHome,
  PATH: `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`
};

// ---------- Part A: Luna gate ----------
{
  const gate = Engines.verifyLunaProfile(codexHome, 'CODEX_SCOUT_FAST');
  assert(gate.allowed, `luna gate should allow scout profile: ${gate.reason}`);
  assert(gate.configured.model === 'gpt-6-luna', 'gate must report configured model');
  assert(gate.configured.reasoningEffort === 'low', 'gate must report configured effort');
  assert(gate.configured.sandboxMode === 'read-only', 'gate must report configured sandbox');
  const wrongModel = Engines.verifyLunaProfile(codexHome, 'WRONGMODEL');
  assert(!wrongModel.allowed && wrongModel.reason.includes('gpt-6-luna'), 'wrong model must be refused');
  const wrongSandbox = Engines.verifyLunaProfile(codexHome, 'WRONGSANDBOX');
  assert(!wrongSandbox.allowed && wrongSandbox.reason.includes('read-only'), 'wrong sandbox must be refused');
  const missing = Engines.verifyLunaProfile(codexHome, 'NOPE');
  assert(!missing.allowed, 'missing profile must be refused');
  const empty = Engines.verifyLunaProfile(codexHome, '');
  assert(!empty.allowed, 'empty profile must be refused');
  console.log('ok: A luna profile gate (allow + 4 refusals)');
}

// ---------- Part B: OpenCode discovery + real adapter ----------
{
  const probeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-opencode-'));
  const probeJsonc = path.join(probeDir, 'opencode.jsonc');
  await fsp.writeFile(probeJsonc, [
    '{',
    '  // comment',
    '  "providers": { "opencode": { "models": { "decoy": { "limit": { "context": 1 } } } } },',
    '  "model": "opencode-go/muse-spark-1.3-contributor",',
    '}',
    ''
  ].join('\n'));
  const discovery = Engines.describeOpenCodeDiscovery(probeJsonc);
  assert(discovery.hostModel === 'opencode-go/muse-spark-1.3-contributor', `host model discovery wrong: ${discovery.hostModel}`);
  assert(discovery.hasProvidersBlock === true, 'must report the top-level providers block as evidence');
  assert(discovery.hasRepoProfileAbstraction === false, 'must report no repo OpenCode profile abstraction');
  // Nested-only model tables must NOT leak into top-level discovery.
  const nestedOnly = path.join(probeDir, 'nested.jsonc');
  await fsp.writeFile(nestedOnly, '{"providers": {"x": {"model": "nope/nested"}}}');
  assert(Engines.describeOpenCodeDiscovery(nestedOnly).hostModel === null, 'nested provider model tables must not count as the top-level model');
  assert(Engines.describeOpenCodeDiscovery(path.join(probeDir, 'missing.jsonc')).hostModel === null, 'missing config must yield null, never a guess');
  // Model gate: explicit equality only, never substitution.
  assert(Engines.verifyOpenCodeModel('opencode-go/muse-spark-1.3-contributor', discovery.hostModel).allowed, 'exact host model must be allowed');
  assert(!Engines.verifyOpenCodeModel('other/model', discovery.hostModel).allowed, 'different model must be refused (no substitution)');
  assert(!Engines.verifyOpenCodeModel('', discovery.hostModel).allowed, 'missing model must be refused');
  assert(!Engines.verifyOpenCodeModel('opencode-go/muse-spark-1.3-contributor', null).allowed, 'unknown host model must refuse rather than substitute');
  // Argv shapes: only qualified opencode flags, never Codex flags, and the
  // two resume routes stay independent.
  const canaryArgv = Engines.buildOpenCodeCanaryArgv('opencode-go/muse-spark-1.3-contributor', 'hello');
  assert(canaryArgv[0] === 'run' && canaryArgv.includes('--model') && canaryArgv.includes('--format') && canaryArgv.includes('json'), `opencode canary argv wrong: ${canaryArgv.join(' ')}`);
  assert(!canaryArgv.includes('--profile') && !canaryArgv.includes('exec') && !canaryArgv.includes('--ephemeral') && !canaryArgv.includes('--output-last-message'), 'opencode argv must never carry Codex flags');
  const resumeArgv = Engines.buildOpenCodeResumeArgv('ses_abc', 'opencode-go/muse-spark-1.3-contributor', 'hello');
  assert(resumeArgv[0] === 'run' && resumeArgv.includes('--session') && resumeArgv.includes('ses_abc'), `opencode resume argv wrong: ${resumeArgv.join(' ')}`);
  const codexResume = Engines.buildCodexResumeArgv('sess-123', 'hello', '/tmp/last.md');
  assert(codexResume[0] === 'exec' && codexResume[1] === 'resume' && !codexResume.includes('--profile'), 'codex resume inherits its session profile; --profile must be absent');
  assert(Engines.OPENCODE_QUALIFIED_RUN_FLAGS.includes('--session/-s') && Engines.OPENCODE_QUALIFIED_RUN_FLAGS.includes('--model/-m'), 'qualified run flags must be declared');
  assert(typeof Engines.parseOpenCodeSessionId('{"sessionID":"ses_parse1"}') === 'string', 'object-shape session id must parse');
  assert(Engines.parseOpenCodeSessionId('noise\n{"sessionId":"ses_parse2"}\nmore') === 'ses_parse2', 'JSONL-shape session id must parse');
  assert(Engines.parseOpenCodeSessionId('no json here') === null, 'absent session id must be null, never a guess');
  console.log('ok: B opencode discovery (depth-1) + model gate + qualified argv per engine');
}

// ---------- Part C: store unit ----------
{
  const bridge = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-store-'));
  const owner = Store.ownerIdFor(undefined, '1000:/tmp/root');
  const now = new Date().toISOString();
  const run = {
    version: 1, runId: 'run_aaaaaaaaaaaaaaaa', requestId: 'req-1', delegationGroup: Store.DELEGATION_GROUP,
    engine: 'codex', profile: 'CODEX_SCOUT_FAST', workspaceId: 'ws_x', workspaceCanonical: '/tmp/root',
    workdir: '/tmp/root/canary', ownerIdHash: owner.ownerIdHash, ownerKind: owner.ownerKind,
    state: 'running', seq: 0,
    attempts: [{ n: 1, startedAt: now, state: 'running', pid: 999999999, processStartTime: '12345', summary: 'x' }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    nextAction: 'poll', createdAt: now, updatedAt: now
  };
  Store.saveDelegationRun(bridge, run);
  const loaded = Store.loadDelegationRun(bridge, 'run_aaaaaaaaaaaaaaaa');
  assert(loaded?.requestId === 'req-1', 'run must persist outside tmp and reload');
  assert(Store.findRunByRequestId(bridge, 'req-1')?.runId === 'run_aaaaaaaaaaaaaaaa', 'idempotent request id must find the run');
  // Dead pid => interrupted, never auto-restart.
  const reconciled = Store.reconcileRunState(loaded, () => false);
  assert(reconciled.classification === 'interrupted' && reconciled.run.state === 'interrupted', 'dead running run must classify interrupted');
  assert(reconciled.run.nextAction.includes('NEW request id'), 'interrupted must expose next action, never silent restart');
  assert(reconciled.run.pendingEvents.length === 1 && reconciled.run.pendingEvents[0].eventId.startsWith('evt_'), 'stable event id must be enqueued');
  // Completed + undelivered => completed-awaiting-delivery.
  const done = { ...reconciled.run, state: 'completed', pendingEvents: [{ eventId: 'evt_1', seq: 2, state: 'completed', createdAt: now, deliveries: [{ subId: 'sub_x', status: 'failed', attempts: 1 }] }] };
  const redelivery = Store.reconcileRunState(done, () => false);
  assert(redelivery.classification === 'completed-awaiting-delivery', 'terminal with failed delivery must classify awaiting-delivery');
  // Owner: same credentials pass, different token fails.
  assert(Store.verifyRunOwner(undefined, '1000:/tmp/root', loaded), 'same local owner must verify');
  assert(!Store.verifyRunOwner('x'.repeat(32), '1000:/tmp/root', loaded), 'different credentials must not verify (knowing ids grants nothing)');
  // Stable event ids + deterministic sub ids.
  assert(Store.stableEventId('run_aaaaaaaaaaaaaaaa', 3) === Store.stableEventId('run_aaaaaaaaaaaaaaaa', 3), 'event ids must be stable');
  console.log('ok: C durable store + reconcile + owner + idempotency');
}

// ---------- Part D: events unit + loopback wire proof ----------
function stubFetch(status, body, capture) {
  return async () => {
    capture.calls += 1;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}
// Deterministic DNS: public stub for https unit targets (no live resolver
// dependence), loopback stub for the 127.0.0.1 wire proof (with the explicit
// hermetic allowPrivate escape; production refuses such targets fail-closed).
const publicLookup = async () => [{ address: '93.184.216.1', family: 4 }];
const loopbackLookup = async () => [{ address: '127.0.0.1', family: 4 }];
{
  // Deterministic sub id: same inputs => same id (idempotent).
  const id1 = Events.deterministicSubscriptionId('owner1', 'https://example.com/hook', 'run-attention', { delegationGroup: 'hestia-cli-canary' });
  const id2 = Events.deterministicSubscriptionId('owner1', 'https://example.com/hook', 'run-attention', { delegationGroup: 'hestia-cli-canary' });
  assert(id1 === id2 && id1.startsWith('sub_'), 'subscription id must be deterministic');
  const id3 = Events.deterministicSubscriptionId('owner2', 'https://example.com/hook', 'run-attention', { delegationGroup: 'hestia-cli-canary' });
  assert(id3 !== id1, 'different principal must yield a different id');
  // Validation rejects.
  const goodSecret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
  const rejects = [
    [{ callbackUrl: 'http://example.com/hook', eventName: 'run-attention', webhookSecret: goodSecret }, 'https'],
    [{ callbackUrl: 'https://127.0.0.1/hook', eventName: 'run-attention', webhookSecret: goodSecret }, 'private'],
    [{ callbackUrl: 'https://localhost/hook', eventName: 'run-attention', webhookSecret: goodSecret }, 'local'],
    [{ callbackUrl: 'https://example.com/hook', eventName: 'nope', webhookSecret: goodSecret }, 'narrow'],
    [{ callbackUrl: 'https://example.com/hook', eventName: 'run-attention', webhookSecret: 'raw-secret' }, 'whsec_'],
    [{ callbackUrl: 'https://example.com/hook', eventName: 'run-attention', webhookSecret: `whsec_${Buffer.alloc(8).toString('base64')}` }, '24-64']
  ];
  for (const [input, why] of rejects) {
    let threw = false;
    try { Events.validateSubscriptionInput(input); } catch { threw = true; }
    assert(threw, `subscription validation must reject (${why})`);
  }
  const validated = Events.validateSubscriptionInput({ callbackUrl: 'https://example.com/hook', eventName: 'run-attention', filter: { delegationGroup: 'hestia-cli-canary' }, webhookSecret: goodSecret });
  assert(validated.secretBytes.length === 32, 'secret entropy must decode to 32 bytes');
  // Challenge failure => error -32015 (wrong echo).
  const capture = { calls: 0 };
  let challengeCode = 0;
  try {
    await Events.verifySubscriptionChallenge('https://example.com/hook', validated.secretBytes, 'run-attention', {}, stubFetch(200, { challenge: 'wrong' }, capture), 10_000, { lookupHost: publicLookup });
  } catch (error) { challengeCode = Number(error?.code); }
  assert(challengeCode === -32015, `challenge failure must be error -32015, got ${challengeCode}`);
  assert(capture.calls === 1, 'challenge must actually POST');
  // Redirects are never followed.
  let redirectCode = 0;
  try {
    await Events.verifySubscriptionChallenge('https://example.com/hook', validated.secretBytes, 'run-attention', {}, stubFetch(302, '', { calls: 0 }), 10_000, { lookupHost: publicLookup });
  } catch (error) { redirectCode = Number(error?.code); }
  assert(redirectCode === -32015, 'redirect must fail the challenge');
  // Delivery matrix via stubs: 410/413 permanent (no retry), 500 retryable.
  const evt = { event: 'run-attention', eventId: 'evt_test', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'hestia-cli-canary', state: 'completed', seq: 1, version: 1, createdAt: new Date().toISOString() };
  const gone = await Events.deliverEventToSubscription('https://example.com/hook', validated.secretBytes, evt, stubFetch(410, '', { calls: 0 }), 10_000, { lookupHost: publicLookup });
  assert(gone.status === 'permanent', '410 must be permanent (no retry)');
  const tooLarge = await Events.deliverEventToSubscription('https://example.com/hook', validated.secretBytes, evt, stubFetch(413, '', { calls: 0 }), 10_000, { lookupHost: publicLookup });
  assert(tooLarge.status === 'permanent', '413 must be permanent (no retry)');
  const broken = await Events.deliverEventToSubscription('https://example.com/hook', validated.secretBytes, evt, stubFetch(500, '', { calls: 0 }), 10_000, { lookupHost: publicLookup });
  assert(broken.status === 'retryable', '500 must be retryable');
  assert(Events.nextRetryDelayMs(0) === 1000 && Events.nextRetryDelayMs(3) === 8000, 'backoff must be deterministic');
  console.log('ok: D events validation + challenge -32015 + delivery matrix (stubs)');
}
{
  // Loopback wire proof: real HTTP server (127.0.0.1) proves the Standard
  // Webhooks exchange; production subscribe-time validation still refuses
  // private/local callbacks (proven above). SUBSCRIBED vs OBSERVED stays split.
  const secret = Buffer.alloc(32, 9);
  const observed = { challenge: null, challengeSubId: null, deliveryHeaders: null, deliveryBody: null, deliverySubId: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const id = req.headers['webhook-id'];
      const ts = req.headers['webhook-timestamp'];
      const sig = String(req.headers['webhook-signature'] ?? '');
      const subId = String(req.headers['x-mcp-subscription-id'] ?? '');
      const expected = `v1,${createHmac('sha256', secret).update(`${id}.${ts}.${body}`, 'utf8').digest('base64')}`;
      if (sig !== expected) {
        res.writeHead(401).end('bad signature');
        return;
      }
      const parsed = JSON.parse(body);
      if (parsed.type === 'verification') {
        observed.challenge = parsed.challenge;
        observed.challengeSubId = subId;
        // Official: challenge request carries msg_verification_* webhook-id.
        observed.challengeWebhookId = String(id ?? '');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }
      observed.deliveryHeaders = { id, ts, sig: sig.slice(0, 8) };
      observed.deliverySubId = subId;
      observed.deliveryBody = parsed;
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/hook`;
  const verified = await Events.verifySubscriptionChallenge(url, secret, 'run-attention', { delegationGroup: 'hestia-cli-canary' }, fetch, 10_000, { lookupHost: loopbackLookup, allowPrivate: true, subId: 'sub_loopback1' });
  assert(verified.webhookId.startsWith('msg_verification_') && observed.challenge === verified.challenge, 'loopback challenge must verify with official msg_verification_* webhook-id');
  assert(String(observed.challengeWebhookId ?? '').startsWith('msg_verification_'), 'challenge webhook-id header must be msg_verification_*');
  const evt = { event: 'run-attention', eventId: 'evt_loop', runId: 'run_bbbbbbbbbbbbbbbb', engine: 'codex', delegationGroup: 'hestia-cli-canary', state: 'completed', seq: 1, version: 1, summary: 'completed exit 0', createdAt: new Date().toISOString() };
  const outcome = await Events.deliverEventToSubscription(url, secret, evt, fetch, 10_000, { lookupHost: loopbackLookup, allowPrivate: true, subId: 'sub_loopback1' });
  assert(outcome.status === 'delivered', 'loopback delivery must succeed');
  assert(observed.deliveryBody?.name === 'run-attention' && observed.deliveryBody?.eventId === 'evt_loop', 'official event body must carry eventId + name');
  assert(observed.deliveryBody?.data?.runId === 'run_bbbbbbbbbbbbbbbb' && observed.deliveryBody?.data?.summary === 'completed exit 0', 'official data must carry run id + sanitized summary only');
  assert(observed.deliveryBody?.timestamp && observed.deliveryBody?.cursor === null, 'official event must carry timestamp + cursor null');
  assert(String(observed.deliveryHeaders?.id ?? '') === 'evt_loop', 'delivery webhook-id header must equal eventId (preserved)');
  assert(observed.challengeSubId === 'sub_loopback1' && observed.deliverySubId === 'sub_loopback1', 'challenge + delivery envelopes must bind X-MCP-Subscription-Id');
  assert(!JSON.stringify(observed.deliveryBody).includes('whsec_'), 'delivery must never carry credentials');
  assert(!('type' in (observed.deliveryBody ?? {})), 'official event body must not carry top-level type');
  server.close();
  console.log('ok: D loopback wire proof OBSERVED (challenge + signed delivery)');
}

// ---------- Part E: CLI execute-handoff extension ----------
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-cli-'));
  await fsp.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fsp.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Test plan\n\nAppend the marker.\n');
  await fsp.writeFile(path.join(root, 'app.txt'), 'start\n');
  await fsp.writeFile(path.join(root, 'fake-agent.mjs'), `
import fs from 'node:fs';
const taskIndex = process.argv.indexOf('--task-file');
fs.appendFileSync('app.txt', 'implemented\\n');
console.log('fake agent completed ' + process.argv[taskIndex + 1]);
`);
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['add', 'app.txt'], { cwd: root });
  const env = { CODEXPRO_HANDOFF_REQUEST_ID: 'req-cli-1' };
  const first = runCli(['execute-handoff', '--root', root, '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} fake-agent.mjs --task-file {{plan_file}}`, '--yes'], { env });
  assert(first.status === 0, `cli execute-handoff failed\n${first.stdout}\n${first.stderr}`);
  const state1 = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  assert(state1.state === 'completed', 'cli run must complete');
  assert(/^run_[0-9a-f]{16}$/.test(state1.run_id), 'run identity must persist');
  assert(state1.request_id === 'req-cli-1', 'request id must persist');
  assert(state1.workspace_canonical === fs.realpathSync.native(root), 'workspace canonical path must persist');
  assert(Number.isSafeInteger(state1.executor_pid) && typeof state1.executor_starttime === 'string', 'PID+starttime identity must persist (never PID alone)');
  assert(Array.isArray(state1.attempts) && state1.attempts.length >= 1, 'attempt history must persist');
  assert(Array.isArray(state1.pending_notifications), 'pending notifications must persist');
  assert(typeof state1.next_action === 'string' && state1.next_action.length > 0, 'next action must be exposed');
  // Same request id again: no second worker semantics — same run id, history grows.
  const second = runCli(['execute-handoff', '--root', root, '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} fake-agent.mjs --task-file {{plan_file}}`, '--yes'], { env });
  assert(second.status === 0, `cli re-run failed\n${second.stdout}\n${second.stderr}`);
  const state2 = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  assert(state2.run_id === state1.run_id, 'same request id must not spawn a second run identity');
  assert(state2.attempts.length === state1.attempts.length + 1, 'attempt history must append');
  // Dead running state reconciles to interrupted honestly.
  const deadRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-cli-dead-'));
  await fsp.mkdir(path.join(deadRoot, '.ai-bridge'), { recursive: true });
  await fsp.writeFile(path.join(deadRoot, '.ai-bridge', 'current-plan.md'), '# Plan\n\nDo nothing.\n');
  await fsp.writeFile(path.join(deadRoot, 'noop.mjs'), `console.log('noop');\n`);
  spawnSync('git', ['init'], { cwd: deadRoot });
  await fsp.writeFile(path.join(deadRoot, '.ai-bridge', 'handoff-run-state.json'), JSON.stringify({
    version: 1, state: 'running', iteration: 1, run_id: 'run_deadbeefdeadbeef', request_id: 'req-old',
    workspace_canonical: deadRoot, executor_pid: 999999998, executor_starttime: '424242', attempts: [], pending_notifications: []
  }));
  const revived = runCli(['execute-handoff', '--root', deadRoot, '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} noop.mjs --task-file {{plan_file}}`, '--yes'],
    { env: { CODEXPRO_HANDOFF_REQUEST_ID: 'req-new' } });
  assert(revived.status === 0, `revived run failed\n${revived.stdout}\n${revived.stderr}`);
  const state3 = readJson(path.join(deadRoot, '.ai-bridge', 'handoff-run-state.json'));
  assert(state3.attempts.some((a) => a.state === 'interrupted'), 'dead attempt must reconcile to interrupted, never auto-restart as success');
  assert(state3.run_id !== 'run_deadbeefdeadbeef', 'new request must mint a new run identity');
  console.log('ok: E cli run state extension + idempotency + interrupted reconcile');
}

// ---------- Part F: MCP in-memory tool flow ----------
{
  const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-mcp-'));
  const config = loadConfig(['--root', wsRoot]);
  const server = createCodexProServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'delegation-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  for (const expected of ['delegation_launch', 'delegation_list', 'delegation_read_result', 'delegation_followup', 'delegation_cancel', 'events_list', 'events_subscribe', 'events_unsubscribe']) {
    assert(names.includes(expected), `tool surface must include ${expected}`);
  }
  const opened = await call('open_workspace', { root: wsRoot });
  assert(!opened.isError, 'open_workspace must succeed');
  const workspaceId = opened.structuredContent.workspace_id;
  const eventsList = await call('events_list', {});
  assert(!eventsList.isError && eventsList.structuredContent.events?.[0]?.name === 'run-attention', 'events_list must define the narrow run-attention event');
  const serverConfig = await call('server_config', {});
  assert(serverConfig.structuredContent.capabilities?.events?.eventNames?.[0] === 'run-attention', 'server/discover equivalent (capabilities.events) must be advertised');
  // Refusals before any spawn.
  const noCanary = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'canary-x', canary: false });
  assert(noCanary.isError, 'non-canary launch must be refused');
  const noProfile = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', workdir: 'canary-x', canary: true });
  assert(noProfile.isError, 'missing profile must be refused');
  const opencodeNoModel = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', workdir: 'canary-x', canary: true });
  assert(opencodeNoModel.isError && opencodeNoModel.structuredContent.error === 'model_required', 'opencode without an explicit model must be refused');
  const opencodeWrong = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: 'other/model', workdir: 'canary-x', canary: true });
  assert(opencodeWrong.isError && ['opencode_model_mismatch', 'opencode_host_model_unknown'].includes(opencodeWrong.structuredContent.error), 'opencode with a non-host model must be refused, never substituted');
  const wrongProfile = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'WRONGMODEL', workdir: 'canary-x', canary: true });
  assert(wrongProfile.isError, 'luna gate mismatch must refuse launch');
  // Real canary launch through the fake codex on PATH.
  const realRoot = fs.realpathSync.native(wsRoot);
  process.env.CODEX_HOME = codexHome;
  process.env.PATH = `${shimBin}${path.delimiter}${process.env.PATH ?? ''}`;
  const launched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'canary-run-1', canary: true, request_id: 'req-mcp-1', timeout_ms: 60000 });
  assert(!launched.isError, `canary launch failed: ${JSON.stringify(launched.structuredContent)}`);
  const runId = launched.structuredContent.run_id;
  assert(/^run_[0-9a-f]{16}$/.test(runId), 'launch must return a run id');
  assert(launched.structuredContent.sandbox_configured === 'read-only', 'launch must report the verified sandbox');
  // Idempotent repeat: same request id, no second worker.
  const replay = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'canary-run-1', canary: true, request_id: 'req-mcp-1', timeout_ms: 60000 });
  assert(!replay.isError && replay.structuredContent.run_id === runId && replay.structuredContent.idempotent_replay === true, 'repeat request id must replay, never spawn');
  // Await terminal state via the run file (fake codex exits fast).
  const runFile = path.join(runBridgeFor(wsRoot), 'delegation-runs', `${runId}.json`);
  let terminal = null;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const current = readJson(runFile);
      if (['completed', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(current.state)) {
        terminal = current;
        break;
      }
    } catch { /* not written yet */ }
  }
  assert(terminal, 'canary run must reach a terminal state');
  assert(terminal.state === 'completed', `canary must complete, got ${terminal.state}: ${JSON.stringify(terminal.result)}`);
  assert(terminal.result?.fixturesUnchanged === true, 'canary fixtures must be unchanged');
  assert(terminal.attempts.length === 1, 'idempotent replay must not append attempts');
  const read = await call('delegation_read_result', { run_id: runId });
  assert(!read.isError && read.structuredContent.state === 'completed', 'read_result must return the terminal run');
  assert(read.structuredContent.result?.stdoutTail?.includes('CANARY-REPORT-A'), 'read_result must carry the canary report excerpt');
  // Ack is separate from read.
  assert((read.structuredContent.pending_events ?? []).every((e) => e.acked !== true), 'reading must never imply ack');
  const acked = await call('delegation_read_result', { run_id: runId, ack_event_ids: (read.structuredContent.pending_events ?? []).map((e) => e.event_id) });
  assert(!acked.isError, 'explicit ack must be accepted');
  // Follow-up Q&A: wrong-run / bare / question / duplicate / stale /
  // unknown-ref / reply (labeled new attempt for ephemeral codex) /
  // duplicate-reply / conflicting.
  const wrongRun = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-1', run_id: 'run_ffffffffffffffff', seq: 0, payload: {} } });
  assert(wrongRun.isError && wrongRun.structuredContent.error === 'wrong_run_checkpoint', 'wrong-run checkpoint must be rejected');
  const bare = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-1', run_id: runId, seq: 0, payload: { note: 'hello' } } });
  assert(bare.isError && bare.structuredContent.error === 'checkpoint_needs_questions_or_request_ref', 'bare checkpoint without questions or request ref must be rejected');
  const question = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-1', run_id: runId, seq: 0, payload: { note: 'hello' }, questions: [{ id: 'q1', question: 'confirm fixture A first line?' }] } });
  assert(!question.isError && question.structuredContent.state === 'needs-input' && question.structuredContent.executed === false, 'question must move the run to needs-input without executing');
  assert(question.structuredContent.input_request_id === 'cp-1', 'request id must be the question checkpoint id');
  const dupQuestion = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-1', run_id: runId, seq: 0, payload: { note: 'hello' }, questions: [{ id: 'q1', question: 'confirm fixture A first line?' }] } });
  assert(!dupQuestion.isError && dupQuestion.structuredContent.duplicate === true, 'identical duplicate question must be at-most-once');
  const stale = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-2', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'q2', question: 'other?' }] } });
  assert(stale.isError && stale.structuredContent.error === 'stale_checkpoint', 'non-monotonic checkpoint seq must be rejected as stale');
  const unknownRef = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-r0', run_id: runId, seq: 1, payload: {}, input_request_id: 'inq_nope' } });
  assert(unknownRef.isError && unknownRef.structuredContent.error === 'unknown_input_request', 'unknown request ref must be rejected');
  const reply = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-r1', run_id: runId, seq: 1, payload: { answer: 'confirmed' }, input_request_id: 'cp-1' } });
  assert(!reply.isError && reply.structuredContent.executed === true && reply.structuredContent.continuation === 'new-continuation-attempt', `ephemeral codex reply must launch a labeled new attempt: ${JSON.stringify(reply.structuredContent)}`);
  assert(reply.structuredContent.attempt_n === 2, 'continuation must be attempt 2');
  assert(typeof reply.structuredContent.session_evidence === 'string' && reply.structuredContent.session_evidence.includes('ephemeral'), 'codex continuation must report ephemeral session evidence, never resumed');
  let continued = null;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const current = readJson(runFile);
      if (current.state === 'completed' && current.attempts.length === 2) {
        continued = current;
        break;
      }
    } catch { /* not yet */ }
  }
  assert(continued, 'follow-up continuation must complete');
  assert(continued.appliedCheckpointIds.includes('cp-r1') && continued.lastAppliedCheckpointSeq === 1, 'reply must be applied exactly once with seq advance');
  assert(continued.inputRequests.find((r) => r.id === 'cp-1')?.status === 'answered', 'request must be answered');
  assert(continued.result?.stdoutTail?.includes('WORKER-PROMPT::') && continued.result?.stdoutTail?.includes('confirmed'), 'continuation worker prompt must forward the actual answer payload');
  const dupReply = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-r1', run_id: runId, seq: 1, payload: { answer: 'confirmed' }, input_request_id: 'cp-1' } });
  assert(!dupReply.isError && dupReply.structuredContent.duplicate === true && dupReply.structuredContent.executed === false, 'duplicate reply must not relaunch');
  assert(readJson(runFile).attempts.length === 2, 'duplicate reply must not append attempts');
  const conflicting = await call('delegation_followup', { run_id: runId, checkpoint: { id: 'cp-r1', run_id: runId, seq: 1, payload: { answer: 'CHANGED' }, input_request_id: 'cp-1' } });
  assert(conflicting.isError && conflicting.structuredContent.error === 'duplicate_conflicting', 'conflicting re-use of a checkpoint id must be rejected');
  // OpenCode canary end-to-end through the fake opencode on PATH.
  const hostModel = Engines.describeOpenCodeDiscovery().hostModel;
  assert(hostModel === 'opencode-go/muse-spark-1.3-contributor', `host model must resolve for the opencode launch, got ${hostModel}`);
  const ocLaunched = await call('delegation_launch', { workspace_id: workspaceId, engine: 'opencode', model: hostModel, workdir: 'canary-oc-1', canary: true, request_id: 'req-mcp-oc-1', timeout_ms: 60000 });
  assert(!ocLaunched.isError, `opencode canary launch failed: ${JSON.stringify(ocLaunched.structuredContent)}`);
  const ocRunId = ocLaunched.structuredContent.run_id;
  const ocRunFile = path.join(runBridgeFor(wsRoot), 'delegation-runs', `${ocRunId}.json`);
  let ocTerminal = null;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const current = readJson(ocRunFile);
      if (['completed', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(current.state)) {
        ocTerminal = current;
        break;
      }
    } catch { /* not written yet */ }
  }
  assert(ocTerminal, 'opencode canary run must reach a terminal state');
  assert(ocTerminal.state === 'completed', `opencode canary must complete, got ${ocTerminal.state}: ${JSON.stringify(ocTerminal.result)}`);
  assert(ocTerminal.result?.fixturesUnchanged === true, 'opencode canary fixtures must be unchanged');
  assert(ocTerminal.session?.sessionId === 'ses_fake0000000001' && ocTerminal.session?.resumable === true, `opencode session id must be observed best-effort: ${JSON.stringify(ocTerminal.session)}`);
  const ocRead = await call('delegation_read_result', { run_id: ocRunId });
  assert(!ocRead.isError && ocRead.structuredContent.session?.sessionId === 'ses_fake0000000001', 'read_result must expose the session binding');
  assert(ocRead.structuredContent.resume_capability?.route?.includes('--session'), 'read_result must expose the opencode resume route');
  const ocQuestion = await call('delegation_followup', { run_id: ocRunId, checkpoint: { id: 'oc-q1', run_id: ocRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'confirm?' }] } });
  assert(!ocQuestion.isError && ocQuestion.structuredContent.state === 'needs-input', 'opencode question must reach needs-input');
  const ocReply = await call('delegation_followup', { run_id: ocRunId, checkpoint: { id: 'oc-r1', run_id: ocRunId, seq: 1, payload: { answer: 'yes-affirmed-oc' }, input_request_id: 'oc-q1' } });
  assert(!ocReply.isError && ocReply.structuredContent.continuation === 'resumed' && ocReply.structuredContent.session_id === 'ses_fake0000000001', `opencode reply must truly resume via --session: ${JSON.stringify(ocReply.structuredContent)}`);
  assert(typeof ocReply.structuredContent.session_evidence === 'string' && ocReply.structuredContent.session_evidence.includes('session list'), 'resumed must cite verified session-list evidence');
  let ocContinued = null;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      const current = readJson(ocRunFile);
      if (current.state === 'completed' && current.attempts.length === 2) {
        ocContinued = current;
        break;
      }
    } catch { /* not yet */ }
  }
  assert(ocContinued, 'opencode resumed continuation must complete');
  assert(ocContinued.result?.stdoutTail?.includes('WORKER-PROMPT::') && ocContinued.result?.stdoutTail?.includes('yes-affirmed-oc'), 'resumed continuation worker prompt must forward the actual answer payload');
  // Cancel path with a sleeping worker.
  process.env.CODEXPRO_FAKE_CODEX_MODE = 'sleep';
  const launchedSleep = await call('delegation_launch', { workspace_id: workspaceId, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'canary-run-2', canary: true, request_id: 'req-mcp-2', timeout_ms: 60000 });
  assert(!launchedSleep.isError, 'sleep launch failed');
  const sleepRunId = launchedSleep.structuredContent.run_id;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const cancelled = await call('delegation_cancel', { run_id: sleepRunId });
  assert(!cancelled.isError && cancelled.structuredContent.state === 'cancelled', 'cancel must acknowledge');
  assert(cancelled.structuredContent.cleanup_finished === true, 'sleep worker tree must be reaped (ack must be truthful)');
  const cancelledAgain = await call('delegation_cancel', { run_id: sleepRunId });
  assert(!cancelledAgain.isError && cancelledAgain.structuredContent.already_terminal === true, 'cancel must be idempotent');
  delete process.env.CODEXPRO_FAKE_CODEX_MODE;
  // Subscribe validation rides the same tool surface (public URL refused here deterministically).
  const badSub = await call('events_subscribe', { workspace_id: workspaceId, callback_url: 'http://example.com/hook', event_name: 'run-attention', webhook_secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` });
  assert(badSub.isError, 'non-https callback must be refused');
  const unsub = await call('events_unsubscribe', { workspace_id: workspaceId, subscription_id: 'sub_doesnotexist' });
  assert(!unsub.isError && unsub.structuredContent.removed === false, 'unsubscribe of unknown id must be idempotent');
  // Owner scoping: a differently-credentialed server sees nothing.
  process.env.CODEXPRO_HTTP_TOKEN = 't'.repeat(32);
  const config2 = loadConfig(['--root', wsRoot]);
  const server2 = createCodexProServer(config2);
  const [ct2, st2] = InMemoryTransport.createLinkedPair();
  const client2 = new Client({ name: 'delegation-smoke-2', version: '1' }, { capabilities: {} });
  await Promise.all([server2.connect(st2), client2.connect(ct2)]);
  const foreignList = await client2.callTool({ name: 'delegation_list', arguments: {} });
  assert(!foreignList.isError && (foreignList.structuredContent.runs ?? []).length === 0, 'other owner must see no runs');
  const foreignRead = await client2.callTool({ name: 'delegation_read_result', arguments: { run_id: runId } });
  assert(foreignRead.isError, 'knowing the run id must grant no access to another owner');
  delete process.env.CODEXPRO_HTTP_TOKEN;
  await client.close();
  await client2.close();
  console.log('ok: F mcp tool flow (refusals, launch, replay, read, ack, followup, cancel, owner scoping)');
}

// ---------- Part H: e2e leaf unit contract (group/task/timeout/prompt/envelope/DNS/subs) ----------
{
  // H1: bounded group + task validators, real-task timeout regime.
  assert(Store.isDelegationGroupId('hestia-cli-canary'), 'default group must validate');
  assert(Store.isDelegationGroupId('team-a.1_x'), 'dotted group must validate');
  assert(!Store.isDelegationGroupId(''), 'empty group must be rejected');
  assert(!Store.isDelegationGroupId('../escape'), 'path group must be rejected');
  assert(!Store.isDelegationGroupId('has space'), 'whitespace group must be rejected');
  assert(!Store.isDelegationGroupId('x'.repeat(65)), 'overlong group must be rejected');
  assert(Store.sanitizeTaskText('  hello world  ') === 'hello world', 'task trims');
  assert(Store.sanitizeTaskText('   ') === '', 'blank task is empty');
  assert(Engines.clampRealTaskTimeout(1) === 10000, 'real timeout clamps up to the 10s minimum');
  assert(Engines.clampRealTaskTimeout(999999999) === 1800000, 'real timeout clamps down to the 30-minute maximum');
  assert(Engines.clampRealTaskTimeout(undefined) === 300000, 'real timeout defaults to 5 minutes');
  assert(Engines.clampCanaryTimeout(999999999) === 300000, 'canary timeout still clamps to 5 minutes');
  assert(Engines.buildCodexCanaryArgv('p', 'prompt', '/tmp/l.md').includes('--skip-git-repo-check'), 'codex argv must skip the git-repo check for disposable workdirs (Luna gate unchanged)');
  // Follow-up prompt forwards the actual payload (both engines take it as argv prompt).
  const fp = Engines.buildFollowupPrompt({ baseTask: 'do the thing', isCanary: false, requestId: 'rq1', questions: [{ id: 'q1', question: 'which?' }], answerPayload: { answer: 'Bravo-7' }, attemptN: 2 });
  assert(fp.includes('Bravo-7') && fp.includes('do the thing') && fp.includes('rq1') && fp.includes('attempt 2'), 'follow-up prompt must forward payload + base task + request');
  const fpCanary = Engines.buildFollowupPrompt({ isCanary: true, requestId: 'rq2', questions: [], answerPayload: { a: 1 }, attemptN: 3 });
  assert(fpCanary.includes('Canary read-only check') && fpCanary.includes('attempt 3'), 'canary follow-up prompt must keep the canary base');
  // Envelope contract: canonical JSON, 256 KiB cap, blocked ranges.
  assert(Events.canonicalJson({ b: 1, a: { d: 4, c: 3 } }) === '{"a":{"c":3,"d":4},"b":1}', 'canonical JSON must sort keys recursively');
  assert(Events.MAX_ENVELOPE_BYTES === 262144, 'envelope cap must be 256 KiB');
  assert(Events.SUBSCRIPTION_ID_HEADER === 'X-MCP-Subscription-Id', 'subscription header name');
  for (const blocked of ['10.1.2.3', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:10.0.0.1']) {
    assert(Events.isBlockedIpAddress(blocked), `blocked address must be refused: ${blocked}`);
  }
  for (const open of ['93.184.216.1', '8.8.8.8', '1.1.1.1']) {
    assert(!Events.isBlockedIpAddress(open), `public address must pass: ${open}`);
  }
  assert(Events.isEventsDeliveryEnabled() === false, 'delivery must default to DISABLED');
  // DNS guard unit: private resolution refuses without any POST.
  let posts = 0;
  const countingFetch = async () => { posts += 1; return new Response('{}', { status: 200 }); };
  let dnsCode = 0;
  try {
    await Events.verifySubscriptionChallenge('https://example.com/hook', Buffer.alloc(32, 7), 'run-attention', {}, countingFetch, 10_000, { lookupHost: async () => [{ address: '10.9.9.9', family: 4 }] });
  } catch (error) { dnsCode = Number(error?.code); }
  assert(dnsCode === -32015 && posts === 0, 'private DNS resolution must refuse the challenge with -32015 and no POST');
  const evtH = { event: 'run-attention', eventId: 'evt_hdr', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'hestia-cli-canary', state: 'completed', seq: 1, version: 1, createdAt: new Date().toISOString() };
  const blockedDelivery = await Events.deliverEventToSubscription('https://example.com/hook', Buffer.alloc(32, 7), evtH, countingFetch, 10_000, { lookupHost: async () => [{ address: '10.9.9.9', family: 4 }] });
  assert(blockedDelivery.status === 'permanent' && posts === 0, 'private DNS resolution must end delivery permanent with no POST');
  // Subscription-id header binding (unit, echo fetch).
  let seenSubId = null;
  const echoFetch = async (url, init) => {
    seenSubId = init.headers['X-MCP-Subscription-Id'] ?? null;
    const parsed = JSON.parse(init.body);
    return new Response(JSON.stringify({ challenge: parsed.challenge }), { status: 200 });
  };
  const secretH = Buffer.alloc(32, 11);
  const verifiedH = await Events.verifySubscriptionChallenge('https://example.com/hook', secretH, 'run-attention', {}, echoFetch, 10_000, { lookupHost: publicLookup, subId: 'sub_hdr1' });
  assert(verifiedH.webhookId.startsWith('msg_verification_') && seenSubId === 'sub_hdr1', 'official challenge envelope must bind X-MCP-Subscription-Id with msg_verification_* webhook-id');
  let seenDeliverySubId = null;
  const deliveryFetch = async (url, init) => {
    seenDeliverySubId = init.headers['X-MCP-Subscription-Id'] ?? null;
    return new Response('ok', { status: 200 });
  };
  const deliveredH = await Events.deliverEventToSubscription('https://example.com/hook', secretH, evtH, deliveryFetch, 10_000, { lookupHost: publicLookup, subId: 'sub_hdr1' });
  assert(deliveredH.status === 'delivered' && seenDeliverySubId === 'sub_hdr1', 'delivery envelope must bind X-MCP-Subscription-Id');
  // Subscriptions persist 0600 and reload.
  const bridge0600 = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-subs0600-'));
  Events.saveSubscriptions(bridge0600, [{ version: 1, subId: 'sub_probe', eventName: 'run-attention', callbackUrl: 'https://example.com/hook', filter: {}, ownerIdHash: 'x'.repeat(64), ownerKind: 'local', createdAt: new Date().toISOString(), secret: `whsec_${Buffer.alloc(32, 2).toString('base64')}` }]);
  const subsMode = fs.statSync(Store.subscriptionsPath(bridge0600)).mode & 0o777;
  assert(subsMode === 0o600, `subscriptions file must persist 0600, got 0o${subsMode.toString(8)}`);
  assert(Events.loadSubscriptions(bridge0600).length === 1, 'stored subscription must reload');
  console.log('ok: H e2e leaf unit contract (group/task/timeout/prompt/envelope/DNS/subs-0600)');
}

// ---------- Part H2: MCP real-task + non-consume + delivery-flag flow ----------
{
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
  const { loadConfig: loadConfigH2 } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer: createServerH2 } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client: ClientH2 } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport: InMemoryTransportH2 } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const wsRootH2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-e2e-'));
  const serverH2 = createServerH2(loadConfigH2(['--root', wsRootH2]));
  const [ctH2, stH2] = InMemoryTransportH2.createLinkedPair();
  const clientH2 = new ClientH2({ name: 'e2e-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([serverH2.connect(stH2), clientH2.connect(ctH2)]);
  const callH2 = async (name, args) => clientH2.callTool({ name, arguments: args });
  const openedH2 = await callH2('open_workspace', { root: wsRootH2 });
  assert(!openedH2.isError, 'open_workspace must succeed');
  const workspaceIdH2 = openedH2.structuredContent.workspace_id;
  const realRootH2 = fs.realpathSync.native(wsRootH2);
  const runFileH2 = (runId) => path.join(runBridgeFor(wsRootH2), 'delegation-runs', `${runId}.json`);
  async function awaitTerminalH2(runId, predicate) {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const current = readJson(runFileH2(runId));
        if (predicate(current)) return current;
      } catch { /* not written yet */ }
    }
    return null;
  }
  // Launch validation: group bounded, task bounded + non-empty.
  const badGroup = await callH2('delegation_launch', { workspace_id: workspaceIdH2, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'e2e-x', canary: true, delegation_group: '../escape', request_id: 'req-e2e-badgroup' });
  assert(badGroup.isError && badGroup.structuredContent.error === 'invalid_delegation_group', 'path group must be rejected');
  const bigTask = await callH2('delegation_launch', { workspace_id: workspaceIdH2, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'e2e-x', task: 'x'.repeat(8001), delegation_group: 'e2e-real-1', request_id: 'req-e2e-bigtask' });
  assert(bigTask.isError && bigTask.structuredContent.error === 'task_too_large', 'oversized task must be rejected');
  const emptyTask = await callH2('delegation_launch', { workspace_id: workspaceIdH2, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'e2e-x', task: '   ', delegation_group: 'e2e-real-1', request_id: 'req-e2e-emptytask' });
  assert(emptyTask.isError && emptyTask.structuredContent.error === 'task_empty', 'blank task must be rejected');
  console.log('ok: H2a launch validation (group/task bounded, non-empty)');
  // Real-task launch: custom group, no fixtures staged, worker observes it.
  const realLaunched = await callH2('delegation_launch', { workspace_id: workspaceIdH2, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'e2e-real-1', task: 'List the files in the working directory with byte sizes. Change nothing.', delegation_group: 'e2e-real-1', request_id: 'req-e2e-real-1', timeout_ms: 60000 });
  assert(!realLaunched.isError, `real-task launch failed: ${JSON.stringify(realLaunched.structuredContent)}`);
  assert(realLaunched.structuredContent.delegation_group === 'e2e-real-1' && realLaunched.structuredContent.is_canary === false, 'ack must carry the real group + is_canary=false');
  const realRunId = realLaunched.structuredContent.run_id;
  const realTerminal = await awaitTerminalH2(realRunId, (r) => ['completed', 'failed'].includes(r.state));
  assert(realTerminal?.state === 'completed', `real task must complete, got ${JSON.stringify(realTerminal?.result)}`);
  assert(realTerminal.isCanary === false && realTerminal.task?.includes('byte sizes'), 'run file must store the real task');
  assert(realTerminal.delegationGroup === 'e2e-real-1', 'run file must store the custom group');
  assert(realTerminal.result?.fixturesUnchanged === undefined, 'real tasks carry no fixture verdict');
  const realFiles = fs.readdirSync(path.join(realRootH2, 'e2e-real-1')).sort();
  assert(!realFiles.includes('fixture-a.txt') && realFiles.includes('codex-last-message.md'), `real workdir stages no fixtures: ${realFiles.join(',')}`);
  assert(realTerminal.result?.stdoutTail?.includes('REALTASK-NO-FIXTURES'), 'worker must observe the fixture-free workdir');
  const shaOf = (s) => createHash('sha256').update(s ?? '', 'utf8').digest('hex');
  const firstSha = shaOf(realTerminal.result?.stdoutTail);
  console.log('ok: H2b real-task launch (custom group, no fixtures, worker-observed)');
  // Follow-up payload changes the result (diff SHAs).
  const qReal = await callH2('delegation_followup', { run_id: realRunId, checkpoint: { id: 'e2e-q1', run_id: realRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'what did the first attempt report?' }] } });
  assert(!qReal.isError && qReal.structuredContent.state === 'needs-input', 'question must reach needs-input');
  const rReal = await callH2('delegation_followup', { run_id: realRunId, checkpoint: { id: 'e2e-r1', run_id: realRunId, seq: 1, payload: { answer: 'Zulu-42-e2e report the prompt length doubled' }, input_request_id: 'e2e-q1' } });
  assert(!rReal.isError && rReal.structuredContent.executed === true && rReal.structuredContent.continuation === 'new-continuation-attempt', `real-task reply must launch a new attempt: ${JSON.stringify(rReal.structuredContent)}`);
  const realContinued = await awaitTerminalH2(realRunId, (r) => r.state === 'completed' && r.attempts.length === 2);
  assert(realContinued, 'real-task continuation must complete');
  assert(realContinued.result?.stdoutTail?.includes('Zulu-42-e2e'), 'follow-up answer must reach the worker prompt');
  assert(shaOf(realContinued.result?.stdoutTail) !== firstSha, 'follow-up must change the result (diff SHAs)');
  console.log('ok: H2c follow-up payload forwarded, result changes (diff SHAs)');
  // Gate refusal consumes nothing, then the identical reply retries clean.
  const ncLaunched = await callH2('delegation_launch', { workspace_id: workspaceIdH2, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'e2e-nc', canary: true, request_id: 'req-e2e-nc', timeout_ms: 60000 });
  assert(!ncLaunched.isError, 'non-consume run must launch');
  const ncRunId = ncLaunched.structuredContent.run_id;
  assert((await awaitTerminalH2(ncRunId, (r) => r.state === 'completed'))?.state === 'completed', 'non-consume run must complete');
  const ncQ = await callH2('delegation_followup', { run_id: ncRunId, checkpoint: { id: 'nc-q1', run_id: ncRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'confirm?' }] } });
  assert(!ncQ.isError, 'non-consume question must reach needs-input');
  const seqBefore = readJson(runFileH2(ncRunId)).seq;
  const badHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-badhome-'));
  await fsp.writeFile(path.join(badHome, 'CODEX_SCOUT_FAST.config.toml'), 'model = "gpt-zzz"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
  const savedHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = badHome;
  const refused = await callH2('delegation_followup', { run_id: ncRunId, checkpoint: { id: 'nc-r1', run_id: ncRunId, seq: 1, payload: { answer: 'retry me' }, input_request_id: 'nc-q1' } });
  process.env.CODEX_HOME = savedHome;
  assert(refused.isError && refused.structuredContent.error === 'luna_gate_refused', `gate refusal expected, got ${JSON.stringify(refused.structuredContent)}`);
  assert(refused.structuredContent.stored === false && refused.structuredContent.executed === false, 'refusal must not consume the reply');
  const afterRefusal = readJson(runFileH2(ncRunId));
  assert(afterRefusal.attempts.length === 1 && afterRefusal.seq === seqBefore, 'no attempt appended, seq unchanged');
  assert(afterRefusal.inputRequests.find((x) => x.id === 'nc-q1')?.status === 'open', 'request must stay open');
  const retried = await callH2('delegation_followup', { run_id: ncRunId, checkpoint: { id: 'nc-r1', run_id: ncRunId, seq: 1, payload: { answer: 'retry me' }, input_request_id: 'nc-q1' } });
  assert(!retried.isError && retried.structuredContent.executed === true, `identical reply must succeed after the gate clears: ${JSON.stringify(retried.structuredContent)}`);
  assert((await awaitTerminalH2(ncRunId, (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'retried continuation must complete');
  console.log('ok: H2d gate refusal consumes nothing (no answered mark, no attempt, seq unchanged), retry succeeds');
  // Split flags (defect 3): app-event POSTs gated, verification + storage allowed.
  // While app delivery is OFF, pending stays pending (zero POSTs), but a
  // loopback subscribe verifies + stores (no delivery_disabled refusal).
  const ncBridge = runBridgeFor(wsRootH2);
  const ncRun = readJson(runFileH2(ncRunId));
  const goodSecretH2 = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
  fs.writeFileSync(Store.subscriptionsPath(ncBridge), JSON.stringify({ version: 1, subscriptions: [{ version: 1, subId: 'sub_e2e1', eventName: 'run-attention', callbackUrl: 'https://example.com/hook', filter: { delegationGroup: 'hestia-cli-canary' }, ownerIdHash: ncRun.ownerIdHash, ownerKind: ncRun.ownerKind, createdAt: new Date().toISOString(), secret: goodSecretH2 }] }));
  ncRun.pendingEvents.at(-1).deliveries.push({ subId: 'sub_e2e1', status: 'pending', attempts: 0 });
  Store.saveDelegationRun(ncBridge, ncRun);
  let livePosts = 0;
  const realFetchH2 = globalThis.fetch;
  globalThis.fetch = (async (...a) => { livePosts += 1; return realFetchH2(...a); });
  try {
    const readDisabled = await callH2('delegation_read_result', { run_id: ncRunId });
    assert(!readDisabled.isError, 'read must succeed while delivery is disabled');
    const lastDisabled = readJson(runFileH2(ncRunId)).pendingEvents.at(-1);
    const held = lastDisabled.deliveries.find((d) => d.subId === 'sub_e2e1');
    assert(held?.status === 'pending' && held?.attempts === 0, 'disabled app delivery must hold the delivery pending with zero attempts');
    // Verification + storage while app delivery OFF: loopback subscribe must
    // verify + store (split flags), not refuse with delivery_disabled.
    process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
    const loopSrv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        try {
          const p = JSON.parse(b);
          if (p.type === 'verification' && typeof p.challenge === 'string') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: p.challenge }));
            return;
          }
        } catch { /* fallthrough */ }
        res.writeHead(200).end('ok');
      });
    });
    await new Promise((resolve) => loopSrv.listen(0, '127.0.0.1', resolve));
    const loopHook = `http://127.0.0.1:${loopSrv.address().port}/hook`;
    const subWhileDisabled = await callH2('events_subscribe', { workspace_id: workspaceIdH2, callback_url: loopHook, event_name: 'run-attention', webhook_secret: goodSecretH2 });
    loopSrv.close();
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    assert(!subWhileDisabled.isError, `subscribe while app delivery OFF must verify + store (split flags), got ${JSON.stringify(subWhileDisabled.structuredContent)}`);
    assert(typeof subWhileDisabled.structuredContent.subscription_id === 'string', 'stored subscription must return an id');
    assert(subWhileDisabled.structuredContent.refreshBefore, 'stored subscription must grant refreshBefore');
  } finally {
    globalThis.fetch = realFetchH2;
  }
  console.log('ok: H2e split flags (app delivery gated pending; verification + storage allowed while OFF)');
  // Explicit opt-in: the pending delivery completes through a loopback
  // callback with the subscription header bound (server path proof).
  process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED = '1';
  process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
  const seenH2 = { subId: null };
  const srvH2 = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seenH2.subId = String(req.headers['x-mcp-subscription-id'] ?? '');
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => srvH2.listen(0, '127.0.0.1', resolve));
  const hookH2 = `http://127.0.0.1:${srvH2.address().port}/hook`;
  const subsH2 = JSON.parse(fs.readFileSync(Store.subscriptionsPath(ncBridge), 'utf8'));
  subsH2.subscriptions[0].callbackUrl = hookH2;
  fs.writeFileSync(Store.subscriptionsPath(ncBridge), JSON.stringify(subsH2));
  const readEnabled = await callH2('delegation_read_result', { run_id: ncRunId });
  assert(!readEnabled.isError, 'read must succeed with delivery enabled');
  const lastEnabled = readJson(runFileH2(ncRunId)).pendingEvents.at(-1);
  const sent = lastEnabled.deliveries.find((d) => d.subId === 'sub_e2e1');
  assert(sent?.status === 'delivered' && sent?.attempts === 1, `opt-in delivery must complete server-side, got ${JSON.stringify(sent)}`);
  assert(seenH2.subId === 'sub_e2e1', 'server-path delivery must bind X-MCP-Subscription-Id');
  srvH2.close();
  delete process.env.CODEXPRO_EVENTS_DELIVERY_ENABLED;
  delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
  fs.writeFileSync(Store.subscriptionsPath(ncBridge), JSON.stringify({ version: 1, subscriptions: [] }));
  await clientH2.close();
  console.log('ok: H2f explicit opt-in delivers server-side with the subscription header (loopback)');
}

// ---------- Part G: SDK gap ----------
{
  const types = fs.readFileSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'types.d.ts'), 'utf8');
  assert(!types.includes('events/subscribe') && !types.includes('server/discover'), 'SDK must lack native events methods (gap confirmation for the tools-compat approach)');
  console.log('ok: G sdk gap confirmed (no native server/discover or events/*)');
}

// ---------- Part I: five defects (hermetic, no live models) ----------
{
  // I1: real protocol handlers + official envelopes (not tool wrappers/server_config).
  const discover = Events.handleServerDiscover();
  assert(discover.resultType === 'complete' && Array.isArray(discover.supportedVersions) && discover.supportedVersions.includes('2026-07-28'), 'server/discover must return official resultType + 2026-07-28');
  assert(discover.capabilities && discover.capabilities.tools && discover.capabilities.events, 'server/discover must advertise tools + events capabilities');
  const listed = Events.handleEventsList();
  assert(Array.isArray(listed.events) && listed.events[0]?.name === 'run-attention', 'events/list must return run-attention');
  assert(Array.isArray(listed.events[0]?.delivery) && listed.events[0].delivery.includes('webhook'), 'event delivery must be ["webhook"]');
  assert(listed.events[0]?.inputSchema?.type === 'object' && listed.events[0]?.payloadSchema?.type === 'object', 'event must carry inputSchema + payloadSchema');
  assert(Events.eventsCapability().methods.discover === 'server/discover' && Events.eventsCapability().methods.subscribe === 'events/subscribe', 'capability must advertise real methods, not server_config wrapper');
  // Official bodies.
  const vBody = JSON.parse(Events.buildVerificationBody('abc123'));
  assert(vBody.type === 'verification' && vBody.challenge === 'abc123' && Object.keys(vBody).length === 2, 'challenge body must be exactly {type:verification, challenge}');
  const sampleEvt = { event: 'run-attention', eventId: 'evt_official1', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'g1', state: 'completed', seq: 1, version: 1, summary: 'completed exit 0', createdAt: '2026-10-01T12:05:00Z' };
  const eBody = JSON.parse(Events.buildEventBody(sampleEvt));
  assert(eBody.eventId === 'evt_official1' && eBody.name === 'run-attention' && eBody.timestamp === '2026-10-01T12:05:00Z', 'event body must carry eventId/name/timestamp');
  assert(eBody.data?.runId === 'run_aaaaaaaaaaaaaaaa' && eBody.data?.summary === 'completed exit 0', 'event data must carry run fields');
  assert(eBody.cursor === null && !('type' in eBody), 'event must carry cursor null and no top-level type');
  assert(Events.deliveryWebhookId(sampleEvt) === 'evt_official1', 'delivery webhook-id must equal eventId (preserved)');
  assert(Events.newVerificationWebhookId().startsWith('msg_verification_'), 'challenge webhook-id must be msg_verification_*');
  // Official headers via postImpl stub (no fetch, no network).
  Events.clearVerificationCache();
  let vSeen = null;
  const vPost = async (target, body, headers) => {
    vSeen = { target, body: JSON.parse(body), headers };
    return { status: 200, bodyText: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  };
  const vSecret = Buffer.alloc(32, 21);
  const vRes = await Events.verifySubscriptionChallenge('https://example.com/hook', vSecret, 'run-attention', {}, fetch, 10_000, { lookupHost: publicLookup, subId: 'sub_i1', postImpl: vPost });
  assert(vRes.webhookId.startsWith('msg_verification_'), 'verified webhookId must be msg_verification_*');
  assert(vSeen.body.type === 'verification' && typeof vSeen.body.challenge === 'string', 'POST body must be official verification');
  assert(vSeen.headers['webhook-id'] === vRes.webhookId && vSeen.headers['webhook-timestamp'] && String(vSeen.headers['webhook-signature']).startsWith('v1,'), 'must carry Standard Webhooks headers');
  assert(vSeen.headers['X-MCP-Subscription-Id'] === 'sub_i1', 'must bind X-MCP-Subscription-Id');
  let dSeen = null;
  const dPost = async (target, body, headers) => {
    dSeen = { target, body: JSON.parse(body), headers };
    return { status: 200, bodyText: 'ok' };
  };
  const dRes = await Events.deliverEventToSubscription('https://example.com/hook', vSecret, sampleEvt, fetch, 10_000, { lookupHost: publicLookup, subId: 'sub_i1', postImpl: dPost });
  assert(dRes.status === 'delivered', 'official delivery must succeed');
  assert(dSeen.body.eventId === 'evt_official1' && dSeen.body.name === 'run-attention' && dSeen.headers['webhook-id'] === 'evt_official1', 'delivery webhook-id header must equal eventId');
  // Real subscribe/unsubscribe handlers (official params, deterministic, idempotent, TTL).
  Events.clearVerificationCache();
  const bridgeI1 = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-defect-i1-'));
  const ownerI1 = 'a'.repeat(64);
  const secI1 = `whsec_${Buffer.alloc(32, 31).toString('base64')}`;
  const subParams = { name: 'run-attention', arguments: { delegationGroup: 'g1' }, delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: secI1 } };
  // Stub postImpl for verification (no network): echo challenge.
  const subPost = async (target, body, headers) => ({ status: 200, bodyText: JSON.stringify({ challenge: JSON.parse(body).challenge }) });
  const sub1 = await Events.handleEventsSubscribe(subParams, { bridgeDir: bridgeI1, ownerIdHash: ownerI1, ownerKind: 'local', lookupHost: publicLookup, postImpl: subPost });
  assert(sub1.id.startsWith('sub_') && sub1.refreshBefore && sub1.cursor === null && sub1.truncated === false, 'subscribe must return id/refreshBefore/cursor null/truncated false');
  assert(sub1.idempotent === false, 'first subscribe is not idempotent');
  const sub2 = await Events.handleEventsSubscribe(subParams, { bridgeDir: bridgeI1, ownerIdHash: ownerI1, ownerKind: 'local', lookupHost: publicLookup, postImpl: async () => { throw new Error('must be cached, no POST'); } });
  assert(sub2.id === sub1.id && sub2.idempotent === true && sub2.cachedVerification === true, 'repeat subscribe must be idempotent via verification cache (no POST)');
  const unsub = Events.handleEventsUnsubscribe({ name: 'run-attention', arguments: { delegationGroup: 'g1' }, delivery: { mode: 'webhook', url: 'https://example.com/hook' } }, { bridgeDir: bridgeI1, ownerIdHash: ownerI1 });
  assert(unsub.removed === true, 'unsubscribe must remove');
  const unsubAgain = Events.handleEventsUnsubscribe({ name: 'run-attention', arguments: { delegationGroup: 'g1' }, delivery: { mode: 'webhook', url: 'https://example.com/hook' } }, { bridgeDir: bridgeI1, ownerIdHash: ownerI1 });
  assert(unsubAgain.removed === false, 'unsubscribe must be idempotent');
  console.log('ok: I1 real server/discover + events/* handlers with official envelopes (verification/event/headers, webhook-id fixes)');
}

{
  // I2: validated-IP dial with Host + SNI preserved, no second resolve, no redirect.
  let lookups = 0;
  const countingLookup = async (host) => {
    lookups += 1;
    assert(host === 'example.com', 'lookup must resolve the original hostname once');
    return [{ address: '93.184.216.1', family: 4 }];
  };
  let seenTarget = null;
  const capturePost = async (target, body, headers) => {
    seenTarget = { target, headers };
    return { status: 200, bodyText: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  };
  await Events.verifySubscriptionChallenge('https://example.com/hook', Buffer.alloc(32, 22), 'run-attention', {}, fetch, 10_000, { lookupHost: countingLookup, subId: 'sub_i2', postImpl: capturePost });
  assert(lookups === 1, 'must resolve exactly once (no second unvalidated resolve)');
  assert(seenTarget.target.ip === '93.184.216.1', 'must dial the validated IP literal');
  assert(seenTarget.target.hostHeader === 'example.com' || seenTarget.target.hostHeader === 'example.com:443', 'must preserve Host header');
  assert(seenTarget.target.servername === 'example.com', 'must preserve TLS servername/SNI');
  assert(seenTarget.headers.Host === seenTarget.target.hostHeader, 'Host header must be forwarded');
  // v4-mapped + reserved blocked (fail-closed, no POST).
  for (const blocked of ['::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:127.0.0.1']) {
    assert(Events.isBlockedIpAddress(blocked), `v4-mapped must be blocked: ${blocked}`);
  }
  let blockedPosts = 0;
  const neverPost = async () => { blockedPosts += 1; return { status: 200, bodyText: '{}' }; };
  let blockedCode = 0;
  try {
    await Events.verifySubscriptionChallenge('https://example.com/hook', Buffer.alloc(32, 23), 'run-attention', {}, fetch, 10_000, { lookupHost: async () => [{ address: '::ffff:10.0.0.1', family: 6 }], postImpl: neverPost });
  } catch (e) { blockedCode = Number(e?.code); }
  assert(blockedCode === -32015 && blockedPosts === 0, 'v4-mapped private must refuse with -32015 and no POST');
  // Redirect never followed (validated path returns 302 => permanent / -32015).
  const redirectPost = async () => ({ status: 302, bodyText: '' });
  const redeliver = await Events.deliverEventToSubscription('https://example.com/hook', Buffer.alloc(32, 24), { event: 'run-attention', eventId: 'evt_redir', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'g', state: 'completed', seq: 1, version: 1, createdAt: new Date().toISOString() }, fetch, 10_000, { lookupHost: publicLookup, postImpl: redirectPost });
  assert(redeliver.status === 'permanent', 'redirect must be permanent (never followed)');
  console.log('ok: I2 validated-IP dial (single resolve, IP literal, Host+SNI preserved, v4-mapped blocked, no redirect)');
}

{
  // I3: split flags (verification/storage allowed while app delivery OFF).
  assert(Events.isAppEventDeliveryEnabled() === false, 'app delivery must default OFF');
  assert(Events.isSubscriptionStorageAllowed() === true, 'verification/storage must always be allowed');
  Events.clearVerificationCache();
  const bridgeI3 = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-defect-i3-'));
  const ownerI3 = 'b'.repeat(64);
  const secI3 = `whsec_${Buffer.alloc(32, 33).toString('base64')}`;
  const okPost = async (target, body) => ({ status: 200, bodyText: JSON.stringify({ challenge: JSON.parse(body).challenge }) });
  const stored = await Events.handleEventsSubscribe(
    { name: 'run-attention', arguments: {}, delivery: { mode: 'webhook', url: 'https://example.com/hook', secret: secI3 } },
    { bridgeDir: bridgeI3, ownerIdHash: ownerI3, lookupHost: publicLookup, postImpl: okPost }
  );
  assert(stored.id.startsWith('sub_'), 'subscribe must store while app delivery OFF (split flags)');
  assert(Events.loadSubscriptions(bridgeI3).length === 1, 'stored subscription must persist while OFF');
  console.log('ok: I3 split flags (verification + storage allowed while app POSTs gated)');
}

{
  // I4: reserved prompt space (answer never dropped, multibyte-safe).
  const bigBase = 'x'.repeat(8000) + '😀'.repeat(100);
  const bigPayload = { answer: 'Zulu-42-' + 'y'.repeat(7000), marker: 'LIVE-FOLLOWUP-7f3a' };
  const prompt = Engines.buildFollowupPrompt({ baseTask: bigBase, isCanary: false, requestId: 'rq-reserve', questions: [{ id: 'q1', question: 'confirm?' }], answerPayload: bigPayload, attemptN: 2 });
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  assert(promptBytes <= Engines.MAX_FOLLOWUP_PROMPT_BYTES, `prompt must fit cap, got ${promptBytes}`);
  assert(prompt.includes('Zulu-42-') && prompt.includes('LIVE-FOLLOWUP-7f3a'), 'reserved answer bytes must survive whole-prompt budgeting');
  assert(!prompt.includes('�'), 'multibyte truncation must be safe (no replacement char)');
  // Round-trip stability: re-encode must not change byte length (no split surrogate).
  assert(Buffer.byteLength(Buffer.from(prompt, 'utf8').toString('utf8'), 'utf8') === promptBytes, 'prompt must be valid UTF-8');
  // Pathological questions (8x2000) must still preserve the answer.
  const manyQs = Array.from({ length: 8 }, (_, i) => ({ id: `q${i}`, question: 'Q'.repeat(2000) }));
  const prompt2 = Engines.buildFollowupPrompt({ baseTask: 'tiny', isCanary: false, requestId: 'rq2', questions: manyQs, answerPayload: { answer: 'Bravo-7-must-survive' }, attemptN: 3 });
  assert(Buffer.byteLength(prompt2, 'utf8') <= Engines.MAX_FOLLOWUP_PROMPT_BYTES && prompt2.includes('Bravo-7-must-survive'), 'answer must survive pathological questions');
  console.log('ok: I4 reserved answer bytes (whole-prompt truncation never drops answer, multibyte-safe)');
}

{
  // I5: crash-safe reply (pending-dispatch before spawn, retry same ID, no consumed without attempt).
  const now = new Date().toISOString();
  const baseRun = {
    version: 1, runId: 'run_ffffffffffffffff', requestId: 'req-i5', delegationGroup: 'hestia-cli-canary',
    engine: 'codex', workspaceId: 'ws_x', workspaceCanonical: '/tmp/x', workdir: '/tmp/x',
    ownerIdHash: 'h', ownerKind: 'local', state: 'needs-input', seq: 1,
    attempts: [{ n: 1, startedAt: now, finishedAt: now, state: 'completed', exitCode: 0, summary: 'completed exit 0' }],
    pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    inputRequests: [{ id: 'q-i5', runId: 'run_ffffffffffffffff', seq: 0, version: 1, questions: [{ id: 'q1', question: 'confirm?', kind: 'input' }], status: 'open', storedAt: now }],
    nextAction: 'x', createdAt: now, updatedAt: now
  };
  const checkpoint = { id: 'r-i5', run_id: 'run_ffffffffffffffff', seq: 1, payload: { answer: 'yes' }, input_request_id: 'q-i5' };
  // Stage pending: not consumed.
  const staged = Store.stagePendingDispatch(baseRun, { checkpoint, requestId: 'q-i5', attemptN: 2, continuation: 'new-continuation-attempt', timeoutMs: 60000, prompt: 'prompt', sessionEvidence: 'ev' });
  assert(staged.pendingDispatch?.checkpointId === 'r-i5' && staged.pendingDispatch?.state === 'pending-dispatch', 'answer must stage as pending-dispatch');
  assert(!staged.appliedCheckpointIds.includes('r-i5'), 'pending must not record an applied mark');
  assert(staged.inputRequests.find((r) => r.id === 'q-i5')?.status === 'open', 'request must stay open while pending');
  assert(staged.attempts.some((a) => a.n === 2 && a.state === 'queued'), 'pending attempt must be queued (recoverable)');
  // Retry same ID reuses same attempt number (no extra budget, no duplicate_conflicting).
  const restaged = Store.stagePendingDispatch(staged, { checkpoint, requestId: 'q-i5', attemptN: 2, continuation: 'new-continuation-attempt', timeoutMs: 60000, prompt: 'prompt', sessionEvidence: 'ev' });
  assert(restaged.attempts.length === staged.attempts.length, 'retry same ID must reuse the pending attempt number');
  assert(Store.pendingDispatchFor(restaged, 'r-i5')?.attemptN === 2, 'pending must remain retryable with same reply ID');
  // Validate still allows the retry (not duplicate_conflicting, since nothing applied).
  const verdict = Store.validateCheckpointForRun({ ...baseRun, pendingDispatch: staged.pendingDispatch, attempts: staged.attempts }, checkpoint);
  assert(verdict.ok === true && !verdict.duplicate, 'pending retry must validate ok (not duplicate)');
  // Confirm consumes: apply marks answered + applied.
  const applied = Store.applyCheckpointReply(staged, checkpoint, staged.inputRequests.find((r) => r.id === 'q-i5'));
  assert(applied.run.appliedCheckpointIds.includes('r-i5'), 'confirm must record the applied mark');
  assert(applied.run.inputRequests.find((r) => r.id === 'q-i5')?.status === 'answered', 'confirm must mark answered');
  // Clear drops pending without consuming (failure path).
  const cleared = Store.clearPendingDispatch(staged);
  assert(!cleared.pendingDispatch && !cleared.appliedCheckpointIds.includes('r-i5'), 'clear must leave no consumed trace');
  assert(cleared.inputRequests.find((r) => r.id === 'q-i5')?.status === 'open', 'clear must leave request open');
  console.log('ok: I5 crash-safe pending-dispatch (staged before spawn, retry same ID, no consumed without attempt)');
}

// ---------- Part J: MCP pending-dispatch (spawn failure leaves retryable pending) ----------
{
  const { loadConfig: loadConfigJ } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer: createServerJ } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client: ClientJ } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport: InMemoryTransportJ } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const wsRootJ = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-pend-'));
  const serverJ = createServerJ(loadConfigJ(['--root', wsRootJ]));
  const [ctJ, stJ] = InMemoryTransportJ.createLinkedPair();
  const clientJ = new ClientJ({ name: 'pend-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([serverJ.connect(stJ), clientJ.connect(ctJ)]);
  const callJ = async (name, args) => clientJ.callTool({ name, arguments: args });
  const openedJ = await callJ('open_workspace', { root: wsRootJ });
  assert(!openedJ.isError, 'open_workspace must succeed');
  const widJ = openedJ.structuredContent.workspace_id;
  const realJ = fs.realpathSync.native(wsRootJ);
  const runFileJ = (id) => path.join(runBridgeFor(wsRootJ), 'delegation-runs', `${id}.json`);
  async function awaitStateJ(id, pred) {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const cur = readJson(runFileJ(id));
        if (pred(cur)) return cur;
      } catch { /* not yet */ }
    }
    return null;
  }
  const launchedJ = await callJ('delegation_launch', { workspace_id: widJ, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'pend-run', canary: true, request_id: 'req-j-pend', timeout_ms: 60000 });
  assert(!launchedJ.isError, `pend launch failed: ${JSON.stringify(launchedJ.structuredContent)}`);
  const pendRunId = launchedJ.structuredContent.run_id;
  assert((await awaitStateJ(pendRunId, (r) => r.state === 'completed'))?.state === 'completed', 'pend run must complete');
  const qJ = await callJ('delegation_followup', { run_id: pendRunId, checkpoint: { id: 'q-j1', run_id: pendRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'pend confirm?' }] } });
  assert(!qJ.isError, 'pend question must reach needs-input');
  const seqBeforeJ = readJson(runFileJ(pendRunId)).seq;
  // Break the next spawn: delete a canary fixture so fixture hashing throws
  // synchronously before spawn (hermetic spawn-failure injection).
  const fixtureAPath = path.join(realJ, 'pend-run', 'fixture-a.txt');
  const savedA = fs.readFileSync(fixtureAPath, 'utf8');
  await fsp.rm(fixtureAPath, { force: true });
  const rFail = await callJ('delegation_followup', { run_id: pendRunId, checkpoint: { id: 'r-j1', run_id: pendRunId, seq: 1, payload: { answer: 'pend-retry-me' }, input_request_id: 'q-j1' } });
  assert(rFail.isError && rFail.structuredContent.error === 'dispatch_pending', `spawn failure must leave pending dispatch, got ${JSON.stringify(rFail.structuredContent)}`);
  assert(rFail.structuredContent.stored === false && rFail.structuredContent.executed === false && rFail.structuredContent.pending_dispatch === true, 'pending failure must not consume');
  const afterFail = readJson(runFileJ(pendRunId));
  assert(afterFail.pendingDispatch?.checkpointId === 'r-j1', 'run file must hold pending-dispatch');
  assert(!afterFail.appliedCheckpointIds.includes('r-j1'), 'no consumed mark without attempt');
  assert(afterFail.inputRequests.find((x) => x.id === 'q-j1')?.status === 'open', 'request must stay open while pending');
  assert(afterFail.attempts.some((a) => a.n === 2 && a.state === 'queued'), 'recoverable queued pending attempt must persist');
  assert(afterFail.seq === seqBeforeJ, 'seq must be unchanged while pending');
  // Restore fixtures and retry the IDENTICAL reply ID: same attempt number, success.
  await fsp.writeFile(fixtureAPath, savedA);
  const rRetry = await callJ('delegation_followup', { run_id: pendRunId, checkpoint: { id: 'r-j1', run_id: pendRunId, seq: 1, payload: { answer: 'pend-retry-me' }, input_request_id: 'q-j1' } });
  assert(!rRetry.isError && rRetry.structuredContent.executed === true && rRetry.structuredContent.attempt_n === 2, `identical retry must dispatch attempt 2, got ${JSON.stringify(rRetry.structuredContent)}`);
  assert((await awaitStateJ(pendRunId, (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'retried continuation must complete');
  const afterOk = readJson(runFileJ(pendRunId));
  assert(!afterOk.pendingDispatch && afterOk.appliedCheckpointIds.includes('r-j1'), 'success must clear pending and record applied');
  assert(afterOk.inputRequests.find((x) => x.id === 'q-j1')?.status === 'answered', 'request must be answered after dispatch');
  await clientJ.close();
  console.log('ok: J MCP pending-dispatch (spawn failure leaves retryable pending, same ID retries to success)');
}

// ---------- Part K: endpoint-level wire proof (POST /mcp reaches the real handlers) ----------
{
  const { loadConfig: loadConfigK } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProHttpApp: createAppK } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'http.js')));
  const wsRootK = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-endpoint-'));
  // Trusted loopback-only endpoint proof: explicit opt-in for tokenless HTTP.
  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = '1';
  const configK = loadConfigK(['--root', wsRootK]);
  delete process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN;
  const appK = createAppK(configK);
  const listenerK = await new Promise((resolve, reject) => {
    const server = appK.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  const baseK = `http://127.0.0.1:${listenerK.address().port}`;
  const postK = async (body, headers = {}) => {
    const response = await fetch(`${baseK}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body)
    });
    return { response, json: await response.json().catch(() => null), text: null };
  };
  try {
    // K1: server/discover through the endpoint (not a direct handler call).
    // The SDK transport has no such method (would be -32601); the real
    // handler returns the official resultType + version.
    const discover = await postK({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
    assert(discover.response.status === 200, `endpoint server/discover http status ${discover.response.status}`);
    assert(discover.json?.result?.resultType === 'complete', `endpoint server/discover must reach the real handler, got ${JSON.stringify(discover.json)}`);
    assert(Array.isArray(discover.json.result.supportedVersions) && discover.json.result.supportedVersions.includes('2026-07-28'), 'endpoint discover must advertise 2026-07-28');
    // K2: events/list through the endpoint.
    const listed = await postK({ jsonrpc: '2.0', id: 2, method: 'events/list', params: {} });
    assert(listed.response.status === 200 && listed.json?.result?.events?.[0]?.name === 'run-attention', `endpoint events/list must reach the real handler, got ${JSON.stringify(listed.json)}`);
    // K3: batch of protocol methods through the endpoint.
    const batch = await postK([
      { jsonrpc: '2.0', id: 11, method: 'server/discover', params: {} },
      { jsonrpc: '2.0', id: 12, method: 'events/list', params: {} }
    ]);
    assert(batch.response.status === 200 && Array.isArray(batch.json) && batch.json.length === 2, `endpoint batch must dispatch both, got ${JSON.stringify(batch.json)}`);
    assert(batch.json.some((r) => r.id === 11 && r.result?.resultType === 'complete'), 'batch discover must succeed');
    assert(batch.json.some((r) => r.id === 12 && r.result?.events?.[0]?.name === 'run-attention'), 'batch list must succeed');
    // K4: auth-check at the endpoint (bearer gate owns protocol methods too).
    const authedK = createAppK({ ...configK, authToken: 'k'.repeat(32) });
    const authedListener = await new Promise((resolve, reject) => {
      const server = authedK.listen(0, '127.0.0.1', () => resolve(server));
      server.once('error', reject);
    });
    try {
      const authedBase = `http://127.0.0.1:${authedListener.address().port}`;
      const noAuth = await fetch(`${authedBase}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })
      });
      assert(noAuth.status === 401, `protocol method without bearer must be 401, got ${noAuth.status}`);
      const withAuth = await fetch(`${authedBase}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${'k'.repeat(32)}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} })
      });
      assert(withAuth.status === 200 && (await withAuth.json()).result?.resultType === 'complete', 'protocol method with bearer must reach the handler');
    } finally {
      await new Promise((resolve) => authedListener.close(resolve));
    }
    // K5: subscribe + unsubscribe through the endpoint (loopback challenge).
    process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE = '1';
    const goodSecretK = `whsec_${Buffer.alloc(32, 41).toString('base64')}`;
    const loopK = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => {
        try {
          const p = JSON.parse(b);
          if (p.type === 'verification' && typeof p.challenge === 'string') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: p.challenge }));
            return;
          }
        } catch { /* fallthrough */ }
        res.writeHead(200).end('ok');
      });
    });
    await new Promise((resolve) => loopK.listen(0, '127.0.0.1', resolve));
    const hookK = `http://127.0.0.1:${loopK.address().port}/hook`;
    const subArgs = { delegationGroup: 'hestia-cli-canary' };
    const sub = await postK({ jsonrpc: '2.0', id: 3, method: 'events/subscribe', params: { name: 'run-attention', arguments: subArgs, delivery: { mode: 'webhook', url: hookK, secret: goodSecretK } } });
    assert(sub.response.status === 200 && typeof sub.json?.result?.id === 'string' && sub.json.result.id.startsWith('sub_'), `endpoint subscribe must verify + store, got ${JSON.stringify(sub.json)}`);
    const unsub = await postK({ jsonrpc: '2.0', id: 4, method: 'events/unsubscribe', params: { name: 'run-attention', arguments: subArgs, delivery: { mode: 'webhook', url: hookK } } });
    assert(unsub.response.status === 200 && unsub.json?.result?.removed === true, `endpoint unsubscribe must remove, got ${JSON.stringify(unsub.json)}`);
    // K6: challenge failure through the endpoint maps to JSON-RPC -32015.
    const wrongK = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => { b += c; });
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: 'wrong' })));
    });
    await new Promise((resolve) => wrongK.listen(0, '127.0.0.1', resolve));
    const wrongHook = `http://127.0.0.1:${wrongK.address().port}/hook`;
    const badSub = await postK({ jsonrpc: '2.0', id: 5, method: 'events/subscribe', params: { name: 'run-attention', arguments: {}, delivery: { mode: 'webhook', url: wrongHook, secret: goodSecretK } } });
    assert(badSub.response.status === 200 && badSub.json?.error?.code === -32015, `challenge failure must be JSON-RPC -32015, got ${JSON.stringify(badSub.json)}`);
    wrongK.close();
    loopK.close();
    delete process.env.CODEXPRO_EVENTS_ALLOW_PRIVATE;
    // K7: transport header negotiation (SDK gate compat, hermetic).
    // Init requesting the newer 2026-07-28 draft downgrades cleanly, and an
    // ordinary tools/call carrying that draft as the transport header succeeds
    // via repo-side normalization; older + invalid headers behave as before.
    {
      const { negotiateTransportProtocolVersion: negotiateKt } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'http.js')));
      assert(negotiateKt('2026-07-28') === '2025-11-25', 'newer draft 2026-07-28 must negotiate to latest supported 2025-11-25');
      for (const older of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']) {
        assert(negotiateKt(older) === older, `supported ${older} must pass through unchanged`);
      }
      assert(negotiateKt('bogus-99') === 'bogus-99', 'truly invalid versions must pass through so SDK validation still rejects');
      assert(negotiateKt(undefined) === undefined, 'absent header must stay absent');
      const parseSseK = (text) => {
        try { return JSON.parse(text); } catch { /* SSE envelope below */ }
        const line = String(text).split(/\r?\n/).find((l) => l.startsWith('data:'));
        return line ? JSON.parse(line.slice(5).trim()) : null;
      };
      const postRawK = async (body, headers = {}) => {
        const response = await fetch(`${baseK}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
          body: JSON.stringify(body)
        });
        const text = await response.text();
        return { response, json: parseSseK(text) };
      };
      // K7a: initialize requesting 2026-07-28 downgrades to 2025-11-25.
      const initKt = await postRawK({ jsonrpc: '2.0', id: 101, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'k7', version: '1' } } });
      assert(initKt.response.status === 200, `k7 initialize http status ${initKt.response.status}`);
      assert(initKt.json?.result?.protocolVersion === '2025-11-25', `k7 initialize must negotiate downgrade, got ${JSON.stringify(initKt.json)}`);
      // K7b: ordinary tools/call carrying the newer draft as the transport header succeeds.
      const callKt = await postRawK({ jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'runtime_status', arguments: {} } }, { 'mcp-protocol-version': '2026-07-28' });
      assert(callKt.response.status === 200, `k7 tools/call with 2026-07-28 header http status ${callKt.response.status}`);
      assert(callKt.json?.result && !callKt.json?.error, `k7 tools/call must succeed, got ${JSON.stringify(callKt.json)?.slice(0, 200)}`);
      // K7c: older header passes through unchanged (still succeeds).
      const oldKt = await postRawK({ jsonrpc: '2.0', id: 103, method: 'tools/call', params: { name: 'runtime_status', arguments: {} } }, { 'mcp-protocol-version': '2025-03-26' });
      assert(oldKt.response.status === 200 && oldKt.json?.result, 'k7 tools/call with 2025-03-26 must still succeed');
      // K7d: truly invalid header still rejected by SDK validation.
      const badKt = await postRawK({ jsonrpc: '2.0', id: 104, method: 'tools/call', params: { name: 'runtime_status', arguments: {} } }, { 'mcp-protocol-version': 'bogus-99' });
      assert(badKt.response.status === 400, `k7 invalid header must still 400, got ${badKt.response.status}`);
      // K7e: real protocol methods stay reachable with the compat header present.
      const disKt = await postRawK({ jsonrpc: '2.0', id: 105, method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
      assert(disKt.response.status === 200 && disKt.json?.result?.resultType === 'complete', 'k7 server/discover must reach the real handler');
      const listKt = await postRawK({ jsonrpc: '2.0', id: 106, method: 'events/list', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
      assert(listKt.response.status === 200 && listKt.json?.result?.events?.[0]?.name === 'run-attention', 'k7 events/list must reach the real handler');
      console.log('ok: K7 transport negotiation (init 2026-07-28 -> 2025-11-25; tools/call runtime_status with draft/older headers; invalid still 400; discover/list with compat header)');
    }
    // K8: LEGACY-COMPAT wire proof (SDK shapes only — NOT modern
    // compliance) + K8m modern advertised-contract shapes (exact, offline).
    // K8a/K8b validate the 2026-07-28-downgraded handshake and the
    // CallToolResult body against the installed legacy SDK schemas only:
    // they prove legacy negotiation keeps working, never modern Events
    // compliance. K8m separately validates the ACTUAL advertised 2026-07-28
    // draft contract (server/discover resultType/supportedVersions/
    // capabilities.events/ttlMs/cacheScope; events/list name/delivery/inputSchema/
    // payloadSchema; challenge/event envelopes + headers) as exact shapes.
    {
      const SdkTypes = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'types.js')));
      const parseSseK8 = (text) => {
        try { return JSON.parse(text); } catch { /* SSE envelope below */ }
        const line = String(text).split(/\r?\n/).find((l) => l.startsWith('data:'));
        return line ? JSON.parse(line.slice(5).trim()) : null;
      };
      const postRawK8 = async (body, headers = {}) => {
        const response = await fetch(`${baseK}/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
          body: JSON.stringify(body)
        });
        const text = await response.text();
        return { response, json: parseSseK8(text) };
      };
      // K8a: initialize requesting 2026-07-28 negotiates to 2025-11-25 with
      // the correct version field, validated against the legacy SDK
      // InitializeResult shape (protocolVersion string + capabilities +
      // serverInfo). LEGACY-COMPAT ONLY: this proves the downgraded
      // handshake still validates, not modern Events compliance.
      const initK8 = await postRawK8({ jsonrpc: '2.0', id: 201, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'k8', version: '1' } } });
      assert(initK8.response.status === 200, `k8 initialize http status ${initK8.response.status}`);
      assert(initK8.json?.result?.protocolVersion === '2025-11-25', `k8 initialize must downgrade to 2025-11-25, got ${JSON.stringify(initK8.json)}`);
      const initParsed = SdkTypes.InitializeResultSchema.safeParse(initK8.json?.result);
      assert(initParsed.success, `k8 initialize result must validate against SDK InitializeResultSchema: ${initParsed.success ? '' : JSON.stringify(initParsed.error?.issues)?.slice(0, 300)}`);
      // K8b: ordinary tools/call (runtime_status) with the 2026-07-28 header
      // returns 200 with a legacy-compatible body (content[] text +
      // structuredContent) validated against the legacy SDK CallToolResult
      // shape. LEGACY-COMPAT ONLY: modern compliance is NOT claimed from
      // this SDK test (see K8m for the advertised-contract shapes).
      const callK8 = await postRawK8({ jsonrpc: '2.0', id: 202, method: 'tools/call', params: { name: 'runtime_status', arguments: {} } }, { 'mcp-protocol-version': '2026-07-28' });
      assert(callK8.response.status === 200, `k8 tools/call http status ${callK8.response.status}`);
      assert(callK8.json?.result && !callK8.json?.error, `k8 tools/call must succeed, got ${JSON.stringify(callK8.json)?.slice(0, 200)}`);
      const callBody = callK8.json.result;
      assert(Array.isArray(callBody.content) && callBody.content.length >= 1 && callBody.content[0]?.type === 'text' && typeof callBody.content[0]?.text === 'string', 'k8 tools/call body must carry content[] with a text block (legacy-compatible)');
      assert(callBody.structuredContent && typeof callBody.structuredContent === 'object', 'k8 tools/call body must carry structuredContent (legacy-compatible)');
      const callParsed = SdkTypes.CallToolResultSchema.safeParse(callBody);
      const compatParsed = SdkTypes.CompatibilityCallToolResultSchema.safeParse(callBody);
      assert(callParsed.success || compatParsed.success, `k8 tools/call body must validate against SDK CallToolResult shape: ${JSON.stringify((callParsed.error ?? compatParsed.error)?.issues)?.slice(0, 300)}`);
      // K8m: ACTUAL advertised 2026-07-28 contract, exact shapes.
      // Provenance: the installed SDK ships NO draft MCP Events natives
      // (server/discover and events/* have no SDK methods — the Part G gap
      // proof), so K8m transcribes the authoritative draft DiscoverResult
      // schema field-by-field below (independent literal transcription with
      // spec URLs, deep-compared — never the server's own builder output,
      // never a legacy SDK schema) plus presence/type/semantic asserts from
      // that schema. This is exact-shape conformance to the authoritative
      // draft contract, not SDK-validated modern compliance, and it is
      // reported separately from the K8 legacy proof.
      const deepEqualK8m = (actual, expected, label) => {
        const norm = (value) => {
          if (Array.isArray(value)) return `[${value.map(norm).join(',')}]`;
          if (value !== null && typeof value === 'object') {
            return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${norm(value[k])}`).join(',')}}`;
          }
          return JSON.stringify(value) ?? 'null';
        };
        assert(norm(actual) === norm(expected), `${label} must equal the documented contract shape, got ${JSON.stringify(actual)?.slice(0, 400)}`);
      };
      // Documented draft contract shapes (transcribed from the authoritative
      // draft schema, not imported, not the server's own builder output).
      // Provenance:
      // - DiscoverResult required fields + ttlMs/cacheScope semantics:
      //   https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/draft/schema.json
      //   ($defs/DiscoverResult; fetched 2026-10-04; required
      //   [cacheScope, capabilities, resultType, supportedVersions, ttlMs];
      //   ttlMs integer >= 0 discovery cache hint, Cache-Control max-age
      //   analog; cacheScope enum "private"|"public", "private" =
      //   per-authorization-context).
      // - 2026-07-28 discover example
      //   (resultType/supportedVersions/capabilities):
      //   https://developers.openai.com/plugins/build/mcp-events
      // - Subscribe ttlMs suggestion -> refreshBefore grant + principal-bound
      //   subscription identity (subscribe-level TTL, NOT discover fields):
      //   https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
      //   (draft 2026-02-19).
      const DOCUMENTED_DISCOVER = {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {}, events: {} },
        ttlMs: 86400000,
        cacheScope: 'private'
      };
      const DOCUMENTED_EVENT = {
        name: 'run-attention',
        delivery: ['webhook'],
        inputSchema: {
          type: 'object',
          properties: {
            delegationGroup: { type: 'string', description: 'Delegation group id scoping delivery (e.g. hestia-cli-canary).' },
            runId: { type: 'string', description: 'Exact delegation run id (run_ + 16 hex).' }
          },
          additionalProperties: false
        },
        payloadSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            engine: { type: 'string' },
            delegationGroup: { type: 'string' },
            state: { type: 'string' },
            seq: { type: 'number' },
            version: { type: 'number' },
            summary: { type: 'string' },
            inputRequestId: { type: 'string' }
          },
          required: ['runId', 'engine', 'delegationGroup', 'state', 'seq', 'version'],
          additionalProperties: false
        }
      };
      // K8c: server/discover returns resultType complete + supportedVersions +
      // capabilities.tools+events + spec-required ttlMs/cacheScope matching
      // the documented shape exactly.
      const disK8 = await postRawK8({ jsonrpc: '2.0', id: 203, method: 'server/discover', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
      assert(disK8.response.status === 200 && disK8.json?.result?.resultType === 'complete', `k8 discover must be complete, got ${JSON.stringify(disK8.json)}`);
      deepEqualK8m(disK8.json.result, DOCUMENTED_DISCOVER, 'k8m discover');
      // K8m spec-anchored assertions (presence + types + semantics from the
      // authoritative draft schema — never the server's own builder output):
      // ttlMs integer >= 0 (discovery cache hint; value reuses the server's
      // 24h default subscription lifetime millis granted when subscribe omits
      // ttlMs); cacheScope "private" (spec enum private/public; private =
      // per-authorization-context, so per-owner discovery is cached
      // separately); plus existing resultType/supportedVersions/capabilities.
      {
        const disResult = disK8.json.result;
        assert('ttlMs' in disResult, 'k8m discover must carry required ttlMs (draft DiscoverResult)');
        assert(typeof disResult.ttlMs === 'number' && Number.isInteger(disResult.ttlMs) && disResult.ttlMs >= 0, `k8m ttlMs must be an integer >= 0 per draft schema, got ${JSON.stringify(disResult.ttlMs)}`);
        assert(disResult.ttlMs === Events.DEFAULT_SUBSCRIPTION_TTL_MS, `k8m ttlMs must equal the default subscription lifetime millis (24h), got ${disResult.ttlMs}`);
        assert('cacheScope' in disResult, 'k8m discover must carry required cacheScope (draft DiscoverResult)');
        assert(typeof disResult.cacheScope === 'string', `k8m cacheScope must be a string per draft schema, got ${JSON.stringify(disResult.cacheScope)}`);
        assert(disResult.cacheScope === 'private', `k8m cacheScope must be "private" (per-owner/authorization-context caching; "principal" is not a valid draft enum value), got ${JSON.stringify(disResult.cacheScope)}`);
        assert(disResult.resultType === 'complete', `k8m resultType must be complete, got ${JSON.stringify(disResult.resultType)}`);
        assert(Array.isArray(disResult.supportedVersions) && disResult.supportedVersions.includes('2026-07-28'), `k8m supportedVersions must include 2026-07-28, got ${JSON.stringify(disResult.supportedVersions)}`);
        assert(disResult.capabilities && disResult.capabilities.tools && disResult.capabilities.events, `k8m capabilities must carry tools + events, got ${JSON.stringify(disResult.capabilities)}`);
      }
      // K8d: events/list returns run-attention with delivery/inputSchema/
      // payloadSchema matching the documented shape exactly (description is
      // prose and excluded from the deep comparison, asserted separately).
      const listK8 = await postRawK8({ jsonrpc: '2.0', id: 204, method: 'events/list', params: {} }, { 'mcp-protocol-version': '2026-07-28' });
      assert(listK8.response.status === 200, `k8 events/list http status ${listK8.response.status}`);
      const evtK8 = listK8.json?.result?.events?.[0];
      assert(listK8.json?.result?.events?.length === 1, `k8m events/list must advertise exactly one event, got ${JSON.stringify(listK8.json)}`);
      assert(typeof evtK8?.description === 'string' && evtK8.description.length > 0, 'k8m event must carry a prose description');
      deepEqualK8m(
        { name: evtK8?.name, delivery: evtK8?.delivery, inputSchema: evtK8?.inputSchema, payloadSchema: evtK8?.payloadSchema },
        DOCUMENTED_EVENT,
        'k8m events/list run-attention'
      );
      // K8e: challenge/event envelopes + headers validated (documented
      // shapes, hermetic stubs, no network).
      const vBodyK8 = JSON.parse(Events.buildVerificationBody('k8challenge'));
      assert(vBodyK8.type === 'verification' && vBodyK8.challenge === 'k8challenge' && Object.keys(vBodyK8).length === 2, 'k8 challenge envelope must be exactly {type, challenge} (official)');
      const sampleK8 = { event: 'run-attention', eventId: 'evt_k8', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'g1', state: 'completed', seq: 1, version: 1, summary: 'completed exit 0', createdAt: '2026-10-01T12:05:00Z' };
      const eBodyK8 = JSON.parse(Events.buildEventBody(sampleK8));
      assert(eBodyK8.eventId === 'evt_k8' && eBodyK8.name === 'run-attention' && eBodyK8.timestamp === '2026-10-01T12:05:00Z' && eBodyK8.cursor === null, 'k8 event envelope must carry eventId/name/timestamp/cursor null (official)');
      assert(eBodyK8.data?.runId === 'run_aaaaaaaaaaaaaaaa', 'k8 event data must carry run fields (official)');
      assert(Events.deliveryWebhookId(sampleK8) === 'evt_k8', 'k8 delivery webhook-id must equal eventId (official)');
      assert(Events.newVerificationWebhookId().startsWith('msg_verification_'), 'k8 challenge webhook-id must be msg_verification_* (official)');
      let seenK8 = null;
      const stubK8 = async (target, body, headers) => {
        seenK8 = { headers };
        return { status: 200, bodyText: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
      };
      const secK8 = Buffer.alloc(32, 77);
      await Events.verifySubscriptionChallenge('https://example.com/hook', secK8, 'run-attention', {}, fetch, 10_000, { lookupHost: publicLookup, subId: 'sub_k8', postImpl: stubK8 });
      assert(seenK8.headers['webhook-id']?.startsWith('msg_verification_') && String(seenK8.headers['webhook-signature']).startsWith('v1,') && seenK8.headers['X-MCP-Subscription-Id'] === 'sub_k8', 'k8 challenge headers must carry webhook-id/timestamp/signature + X-MCP-Subscription-Id (official)');
      deepEqualK8m(Object.keys(seenK8.headers).filter((h) => h === 'webhook-id' || h === 'webhook-timestamp' || h === 'webhook-signature' || h.toLowerCase().startsWith('x-mcp-')).sort(),
        ['webhook-id', 'webhook-signature', 'webhook-timestamp', 'X-MCP-Subscription-Id'].sort(),
        'k8m challenge signed header set (transport framing such as Host/content-type excluded)');
      console.log('ok: K8 LEGACY-COMPAT wire proof (init downgrade validates against SDK InitializeResultSchema; tools/call body validates against SDK CallToolResult shape — legacy negotiation only, NO modern compliance claimed)');
      console.log('ok: K8m advertised 2026-07-28 contract shapes (discover resultType/supportedVersions/capabilities.events/ttlMs/cacheScope; list run-attention delivery/inputSchema/payloadSchema; challenge/event envelopes + exact header set — exact-shape conformance to the authoritative draft DiscoverResult schema + documented contract)');
    }
    console.log('ok: K endpoint wire proof (POST /mcp server/discover + events/* reach the real handlers, auth-checked, batch, -32015 mapping)');
  } finally {
    await new Promise((resolve) => listenerK.close(resolve));
    await fsp.rm(wsRootK, { recursive: true, force: true });
  }
}

// ---------- Part L: dispatch-recovery regressions (crash/async/conflict, hermetic) ----------
{
  const { loadConfig: loadConfigL } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer: createServerL } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client: ClientL } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport: InMemoryTransportL } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const wsRootL = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-recovery-'));
  const configL = loadConfigL(['--root', wsRootL]);
  const serverL = createServerL(configL);
  const [ctL, stL] = InMemoryTransportL.createLinkedPair();
  const clientL = new ClientL({ name: 'recovery-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([serverL.connect(stL), clientL.connect(ctL)]);
  const callL = async (name, args) => clientL.callTool({ name, arguments: args });
  const openedL = await callL('open_workspace', { root: wsRootL });
  assert(!openedL.isError, 'open_workspace must succeed');
  const widL = openedL.structuredContent.workspace_id;
  const realL = fs.realpathSync.native(wsRootL);
  const runFileL = (id) => path.join(runBridgeFor(wsRootL), 'delegation-runs', `${id}.json`);
  async function awaitStateL(id, pred) {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const cur = readJson(runFileL(id));
        if (pred(cur)) return cur;
      } catch { /* not yet */ }
    }
    return null;
  }
  const BAD_BIN = '/nonexistent/codexpro-async-fail-bin';
  // L1 crash-boundary: staged pending survives reload (file) and retries the same attemptN.
  const crashLaunched = await callL('delegation_launch', { workspace_id: widL, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'rec-crash', canary: true, request_id: 'req-l-crash', timeout_ms: 60000 });
  assert(!crashLaunched.isError, `crash launch failed: ${JSON.stringify(crashLaunched.structuredContent)}`);
  const crashRunId = crashLaunched.structuredContent.run_id;
  assert((await awaitStateL(crashRunId, (r) => r.state === 'completed'))?.state === 'completed', 'crash run must complete');
  const crashQ = await callL('delegation_followup', { run_id: crashRunId, checkpoint: { id: 'lq-1', run_id: crashRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'crash confirm?' }] } });
  assert(!crashQ.isError, 'crash question must reach needs-input');
  const seqCrashBefore = readJson(runFileL(crashRunId)).seq;
  process.env.CODEXPRO_CODEX_BIN = BAD_BIN;
  const crashFail = await callL('delegation_followup', { run_id: crashRunId, checkpoint: { id: 'lr-1', run_id: crashRunId, seq: 1, payload: { answer: 'crash-retry-me' }, input_request_id: 'lq-1' } });
  assert(crashFail.isError && crashFail.structuredContent.error === 'dispatch_pending', `async spawn failure must stage pending, got ${JSON.stringify(crashFail.structuredContent)}`);
  assert(crashFail.structuredContent.attempt_n === 2, 'staged pending must reserve attempt 2');
  // The pending record is durable in the run file (crash boundary): reload reads it back.
  const crashPersisted = readJson(runFileL(crashRunId));
  assert(crashPersisted.pendingDispatch?.checkpointId === 'lr-1' && crashPersisted.pendingDispatch?.attemptN === 2, 'persisted pending must survive reload with the same attemptN');
  assert(!crashPersisted.appliedCheckpointIds.includes('lr-1'), 'reload must show no applied mark without a dispatched attempt');
  assert(crashPersisted.inputRequests.find((x) => x.id === 'lq-1')?.status === 'open', 'reload must show the request still open');
  assert(crashPersisted.seq === seqCrashBefore, 'reload must show seq unchanged while pending');
  delete process.env.CODEXPRO_CODEX_BIN;
  // Fresh server (restart) retries the IDENTICAL reply id: same attempt number, success.
  const serverL2 = createServerL(loadConfigL(['--root', wsRootL]));
  const [ctL2, stL2] = InMemoryTransportL.createLinkedPair();
  const clientL2 = new ClientL({ name: 'recovery-smoke-restart', version: '1' }, { capabilities: {} });
  await Promise.all([serverL2.connect(stL2), clientL2.connect(ctL2)]);
  const callL2 = async (name, args) => clientL2.callTool({ name, arguments: args });
  const openedL2 = await callL2('open_workspace', { root: wsRootL });
  assert(!openedL2.isError, 'restarted open_workspace must succeed');
  const crashRetry = await callL2('delegation_followup', { run_id: crashRunId, checkpoint: { id: 'lr-1', run_id: crashRunId, seq: 1, payload: { answer: 'crash-retry-me' }, input_request_id: 'lq-1' } });
  assert(!crashRetry.isError && crashRetry.structuredContent.executed === true && crashRetry.structuredContent.attempt_n === 2, `reload retry must dispatch the same attempt 2, got ${JSON.stringify(crashRetry.structuredContent)}`);
  assert((await awaitStateL(crashRunId, (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'reloaded continuation must complete');
  const crashAfter = readJson(runFileL(crashRunId));
  assert(!crashAfter.pendingDispatch && crashAfter.appliedCheckpointIds.includes('lr-1'), 'success must clear pending and record applied');
  await clientL2.close();
  console.log('ok: L1 crash-boundary (persisted pending survives reload + retries the same attemptN)');
  // L2 async spawn-error: spawn rejects AFTER staging -> pending retryable (same client).
  const asyncLaunched = await callL('delegation_launch', { workspace_id: widL, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'rec-async', canary: true, request_id: 'req-l-async', timeout_ms: 60000 });
  assert(!asyncLaunched.isError, 'async launch failed');
  const asyncRunId = asyncLaunched.structuredContent.run_id;
  assert((await awaitStateL(asyncRunId, (r) => r.state === 'completed'))?.state === 'completed', 'async run must complete');
  const asyncQ = await callL('delegation_followup', { run_id: asyncRunId, checkpoint: { id: 'aq-1', run_id: asyncRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'async confirm?' }] } });
  assert(!asyncQ.isError, 'async question must reach needs-input');
  process.env.CODEXPRO_CODEX_BIN = BAD_BIN;
  const asyncFail = await callL('delegation_followup', { run_id: asyncRunId, checkpoint: { id: 'ar-1', run_id: asyncRunId, seq: 1, payload: { answer: 'async-retry-me' }, input_request_id: 'aq-1' } });
  assert(asyncFail.isError && asyncFail.structuredContent.error === 'dispatch_pending' && asyncFail.structuredContent.pending_dispatch === true, `async spawn error must leave retryable pending, got ${JSON.stringify(asyncFail.structuredContent)}`);
  assert(asyncFail.structuredContent.stored === false && asyncFail.structuredContent.executed === false, 'async failure must not consume the reply');
  const asyncPersisted = readJson(runFileL(asyncRunId));
  assert(asyncPersisted.pendingDispatch?.checkpointId === 'ar-1', 'async failure must persist the pending dispatch');
  assert(asyncPersisted.inputRequests.find((x) => x.id === 'aq-1')?.status === 'open', 'async failure must leave the request open');
  delete process.env.CODEXPRO_CODEX_BIN;
  const asyncRetry = await callL('delegation_followup', { run_id: asyncRunId, checkpoint: { id: 'ar-1', run_id: asyncRunId, seq: 1, payload: { answer: 'async-retry-me' }, input_request_id: 'aq-1' } });
  assert(!asyncRetry.isError && asyncRetry.structuredContent.executed === true && asyncRetry.structuredContent.attempt_n === 2, `async retry must dispatch attempt 2, got ${JSON.stringify(asyncRetry.structuredContent)}`);
  assert((await awaitStateL(asyncRunId, (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'async retried continuation must complete');
  console.log('ok: L2 async spawn-error (spawn rejects after staging -> pending retryable, same ID succeeds)');
  // L3 conflicting-retry: same pending ID same payload reuses, different payload rejected.
  const confLaunched = await callL('delegation_launch', { workspace_id: widL, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'rec-conf', canary: true, request_id: 'req-l-conf', timeout_ms: 60000 });
  assert(!confLaunched.isError, 'conflict launch failed');
  const confRunId = confLaunched.structuredContent.run_id;
  assert((await awaitStateL(confRunId, (r) => r.state === 'completed'))?.state === 'completed', 'conflict run must complete');
  const confQ = await callL('delegation_followup', { run_id: confRunId, checkpoint: { id: 'cq-1', run_id: confRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'conflict confirm?' }] } });
  assert(!confQ.isError, 'conflict question must reach needs-input');
  process.env.CODEXPRO_CODEX_BIN = BAD_BIN;
  const confStage = await callL('delegation_followup', { run_id: confRunId, checkpoint: { id: 'cr-1', run_id: confRunId, seq: 1, payload: { answer: 'original' }, input_request_id: 'cq-1' } });
  assert(confStage.isError && confStage.structuredContent.error === 'dispatch_pending', 'conflict setup must stage pending');
  const attemptsBeforeConflict = readJson(runFileL(confRunId)).attempts.length;
  const conflicting = await callL('delegation_followup', { run_id: confRunId, checkpoint: { id: 'cr-1', run_id: confRunId, seq: 1, payload: { answer: 'CHANGED' }, input_request_id: 'cq-1' } });
  assert(conflicting.isError && conflicting.structuredContent.error === 'duplicate_conflicting', `different payload for the same pending ID must be rejected, got ${JSON.stringify(conflicting.structuredContent)}`);
  const afterConflict = readJson(runFileL(confRunId));
  assert(afterConflict.attempts.length === attemptsBeforeConflict, 'conflicting retry must spawn no new worker');
  assert(afterConflict.pendingDispatch?.checkpointId === 'cr-1' && JSON.stringify(afterConflict.pendingDispatch.payload).includes('original'), 'conflicting retry must not consume or replace the pending reply');
  assert(afterConflict.inputRequests.find((x) => x.id === 'cq-1')?.status === 'open', 'conflicting retry must leave the request open');
  delete process.env.CODEXPRO_CODEX_BIN;
  const confRetry = await callL('delegation_followup', { run_id: confRunId, checkpoint: { id: 'cr-1', run_id: confRunId, seq: 1, payload: { answer: 'original' }, input_request_id: 'cq-1' } });
  assert(!confRetry.isError && confRetry.structuredContent.executed === true && confRetry.structuredContent.attempt_n === 2, `same-payload retry must reuse attempt 2, got ${JSON.stringify(confRetry.structuredContent)}`);
  assert((await awaitStateL(confRunId, (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'conflict retried continuation must complete');
  // Launch-level: same request id with different task/group content is rejected, never replayed.
  const listBefore = await callL('delegation_list', {});
  const runsBefore = (listBefore.structuredContent.runs ?? []).length;
  const launchA = await callL('delegation_launch', { workspace_id: widL, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'rec-conflaunch', task: 'Alpha task content one.', delegation_group: 'e2e-real-1', request_id: 'req-l-conflaunch', timeout_ms: 60000 });
  assert(!launchA.isError, `conflict-launch A failed: ${JSON.stringify(launchA.structuredContent)}`);
  const launchConflict = await callL('delegation_launch', { workspace_id: widL, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'rec-conflaunch', task: 'Beta task content two.', delegation_group: 'e2e-real-1', request_id: 'req-l-conflaunch', timeout_ms: 60000 });
  assert(launchConflict.isError && launchConflict.structuredContent.error === 'duplicate_conflicting', `same request id with different task must be rejected, got ${JSON.stringify(launchConflict.structuredContent)}`);
  const listAfter = await callL('delegation_list', {});
  assert((listAfter.structuredContent.runs ?? []).length === runsBefore + 1, 'conflicting launch must spawn no new worker');
  // Identical launch content still replays (idempotent, no second worker).
  const launchReplay = await callL('delegation_launch', { workspace_id: widL, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'rec-conflaunch', task: 'Alpha task content one.', delegation_group: 'e2e-real-1', request_id: 'req-l-conflaunch', timeout_ms: 60000 });
  assert(!launchReplay.isError && launchReplay.structuredContent.idempotent_replay === true && launchReplay.structuredContent.run_id === launchA.structuredContent.run_id, 'identical launch content must still replay');
  await callL('delegation_cancel', { run_id: launchA.structuredContent.run_id });
  await clientL.close();
  console.log('ok: L3 conflicting-retry (same pending ID same payload reuses, different payload rejected; launch task/group conflicts rejected)');
}

// ---------- Part M: crash-window fail-closed regressions (initial + followup pid-less, hermetic) ----------
// Real window: spawnCanaryChild spawn (~538) + pid save (~560-567). An
// initial launch now stages pending BEFORE spawn (reserve attemptN); a crash
// between spawn success and pid save leaves a pid-less pending with NO
// observed failure marker. Retry of the same id must NOT launch another
// worker when prior dispatch is uncertain: explicit uncertain/failed-closed
// (inspect + cancel/replay, never auto-spawn). The stagedAlivePid liveness
// gate alone is insufficient for pid-less pending. Observed async
// spawn-errors stay explicitly retryable via lastDispatchError (same id,
// same attemptN). Deterministic fault injection: crafted pid-less pending
// files simulate the kill between spawn and save (no orphan processes, no
// live network); BAD_BIN simulates async spawn failure.
{
  const { loadConfig: loadConfigM } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer: createServerM } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client: ClientM } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport: InMemoryTransportM } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const wsRootM = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-delegation-crashwindow-'));
  const configM = loadConfigM(['--root', wsRootM]);
  const serverM = createServerM(configM);
  const [ctM, stM] = InMemoryTransportM.createLinkedPair();
  const clientM = new ClientM({ name: 'crashwindow-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([serverM.connect(stM), clientM.connect(ctM)]);
  const callM = async (name, args) => clientM.callTool({ name, arguments: args });
  const openedM = await callM('open_workspace', { root: wsRootM });
  assert(!openedM.isError, 'crashwindow open_workspace must succeed');
  const widM = openedM.structuredContent.workspace_id;
  const realM = fs.realpathSync.native(wsRootM);
  const bridgeM = runBridgeFor(wsRootM);
  const runFileM = (id) => path.join(bridgeM, 'delegation-runs', `${id}.json`);
  async function awaitStateM(id, pred) {
    for (let i = 0; i < 200; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const cur = readJson(runFileM(id));
        if (pred(cur)) return cur;
      } catch { /* not yet */ }
    }
    return null;
  }
  // Seed owner via one real launch (fake codex on PATH from top fixtures).
  const seedM = await callM('delegation_launch', { workspace_id: widM, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'crash-seed', canary: true, request_id: 'req-m-seed', timeout_ms: 60000 });
  assert(!seedM.isError, `crashwindow seed launch failed: ${JSON.stringify(seedM.structuredContent)}`);
  assert((await awaitStateM(seedM.structuredContent.run_id, (r) => r.state === 'completed'))?.state === 'completed', 'seed must complete');
  const seedRun = readJson(runFileM(seedM.structuredContent.run_id));
  // M1: initial-launch crash-before-save (fault-injected pid-less pending
  // launch, no observed failure) -> retry same request_id returns
  // launch_uncertain and spawns no second worker.
  const crashLaunchId = 'run_aaaaaaaaaaaaaaaa';
  const nowM = new Date().toISOString();
  let crashLaunch = {
    version: 1, runId: crashLaunchId, requestId: 'req-m-crash-launch', delegationGroup: 'hestia-cli-canary',
    engine: 'codex', profile: 'CODEX_SCOUT_FAST', isCanary: true,
    session: { engine: 'codex', resumable: false, reason: 'seed' },
    attemptTimeoutMs: 60000, workspaceId: seedRun.workspaceId, workspaceCanonical: seedRun.workspaceCanonical,
    workdir: path.join(realM, 'crash-launch-m1'), ownerIdHash: seedRun.ownerIdHash, ownerKind: seedRun.ownerKind,
    state: 'queued', seq: 0, attempts: [], pendingEvents: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    inputRequests: [], nextAction: 'x', createdAt: nowM, updatedAt: nowM
  };
  fs.mkdirSync(crashLaunch.workdir, { recursive: true });
  crashLaunch = Store.stagePendingLaunch(crashLaunch, { requestId: 'req-m-crash-launch', attemptN: 1, timeoutMs: 60000, prompt: 'crash task', sessionEvidence: 'ev' });
  assert(Store.isUncertainDispatch(crashLaunch) === true, 'fault-injected crash launch must be uncertain (pid-less, no marker)');
  assert(Store.reconcileRunState(crashLaunch, () => false).classification === 'uncertain', 'reconcile must classify crash launch uncertain, never interrupted');
  Store.saveDelegationRun(bridgeM, crashLaunch);
  const runsBeforeM1 = (await callM('delegation_list', {})).structuredContent.runs.length;
  const retryM1 = await callM('delegation_launch', { workspace_id: widM, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'crash-launch-m1', canary: true, request_id: 'req-m-crash-launch', timeout_ms: 60000 });
  assert(retryM1.isError && retryM1.structuredContent.error === 'launch_uncertain' && retryM1.structuredContent.uncertain_dispatch === true, `crash-before-save retry must fail closed launch_uncertain, got ${JSON.stringify(retryM1.structuredContent)}`);
  assert(retryM1.structuredContent.stored === false && retryM1.structuredContent.executed === false, 'uncertain retry must consume nothing');
  const runsAfterM1 = (await callM('delegation_list', {})).structuredContent.runs.length;
  assert(runsAfterM1 === runsBeforeM1, 'uncertain launch retry must spawn no second worker');
  assert(readJson(runFileM(crashLaunchId)).attempts.length === 1, 'uncertain launch must not append attempts');
  console.log('ok: M1 initial-launch crash-before-save (fault-injected pid-less pending -> retry same ID launch_uncertain, no second worker)');
  // M2: followup pid-less pending (fault-injected, no marker) -> retry same
  // checkpoint returns dispatch_uncertain and spawns no second worker. The
  // stagedAlivePid gate alone is insufficient: with no pid there is nothing
  // to probe, so liveness cannot prove safety.
  const fLaunched = await callM('delegation_launch', { workspace_id: widM, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'crash-followup', canary: true, request_id: 'req-m-followup', timeout_ms: 60000 });
  assert(!fLaunched.isError, 'followup seed launch failed');
  const fRunId = fLaunched.structuredContent.run_id;
  assert((await awaitStateM(fRunId, (r) => r.state === 'completed'))?.state === 'completed', 'followup seed must complete');
  const fQ = await callM('delegation_followup', { run_id: fRunId, checkpoint: { id: 'mq-1', run_id: fRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'm confirm?' }] } });
  assert(!fQ.isError, 'followup question must reach needs-input');
  let fCur = readJson(runFileM(fRunId));
  const fCp = { id: 'mr-uncertain', run_id: fRunId, seq: 1, payload: { answer: 'x' }, input_request_id: 'mq-1' };
  fCur = Store.stagePendingDispatch(fCur, { checkpoint: fCp, requestId: 'mq-1', attemptN: 2, continuation: 'new-continuation-attempt', timeoutMs: 60000, prompt: 'p', sessionEvidence: 'e' });
  assert(Store.isUncertainDispatch(fCur) === true, 'fault-injected followup pending must be uncertain');
  Store.saveDelegationRun(bridgeM, fCur);
  const attemptsBeforeM2 = readJson(runFileM(fRunId)).attempts.length;
  const retryM2 = await callM('delegation_followup', { run_id: fRunId, checkpoint: { id: 'mr-uncertain', run_id: fRunId, seq: 1, payload: { answer: 'x' }, input_request_id: 'mq-1' } });
  assert(retryM2.isError && retryM2.structuredContent.error === 'dispatch_uncertain' && retryM2.structuredContent.uncertain_dispatch === true, `pid-less pending retry must fail closed dispatch_uncertain, got ${JSON.stringify(retryM2.structuredContent)}`);
  assert(readJson(runFileM(fRunId)).attempts.length === attemptsBeforeM2, 'uncertain followup retry must spawn no second worker');
  console.log('ok: M2 followup pid-less pending (fault-injected -> retry same ID dispatch_uncertain, stagedAlivePid gate insufficient alone, no second worker)');
  // M3: async spawn-error stays explicitly retryable via lastDispatchError
  // (same id, same attemptN). BAD_BIN fault injection, hermetic, no network.
  const aLaunched = await callM('delegation_launch', { workspace_id: widM, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'crash-async', canary: true, request_id: 'req-m-async', timeout_ms: 60000 });
  assert(!aLaunched.isError, 'async seed launch failed');
  const aRunId = aLaunched.structuredContent.run_id;
  assert((await awaitStateM(aRunId, (r) => r.state === 'completed'))?.state === 'completed', 'async seed must complete');
  const aQ = await callM('delegation_followup', { run_id: aRunId, checkpoint: { id: 'aq-1', run_id: aRunId, seq: 0, payload: {}, questions: [{ id: 'q1', question: 'async confirm?' }] } });
  assert(!aQ.isError, 'async question must reach needs-input');
  process.env.CODEXPRO_CODEX_BIN = '/nonexistent/codexpro-async-fail-bin';
  const aFail = await callM('delegation_followup', { run_id: aRunId, checkpoint: { id: 'ar-1', run_id: aRunId, seq: 1, payload: { answer: 'async-retry-me' }, input_request_id: 'aq-1' } });
  assert(aFail.isError && aFail.structuredContent.error === 'dispatch_pending' && aFail.structuredContent.pending_dispatch === true, `async spawn error must leave retryable pending, got ${JSON.stringify(aFail.structuredContent)}`);
  const aPersisted = readJson(runFileM(aRunId));
  assert(typeof aPersisted.pendingDispatch?.lastDispatchError === 'string' && aPersisted.pendingDispatch.lastDispatchError.length > 0, 'observed async failure must mark lastDispatchError (explicitly retryable)');
  assert(Store.isUncertainDispatch(aPersisted) === false, 'marked async failure must NOT be uncertain');
  assert(aPersisted.inputRequests.find((x) => x.id === 'aq-1')?.status === 'open', 'async failure must leave request open');
  delete process.env.CODEXPRO_CODEX_BIN;
  const aRetry = await callM('delegation_followup', { run_id: aRunId, checkpoint: { id: 'ar-1', run_id: aRunId, seq: 1, payload: { answer: 'async-retry-me' }, input_request_id: 'aq-1' } });
  assert(!aRetry.isError && aRetry.structuredContent.executed === true && aRetry.structuredContent.attempt_n === 2, `async retry same ID must dispatch attempt 2, got ${JSON.stringify(aRetry.structuredContent)}`);
  assert((await awaitStateM(aRunId, (r) => r.state === 'completed' && r.attempts.length === 2))?.attempts.length === 2, 'async retried continuation must complete');
  await clientM.close();
  console.log('ok: M3 async spawn-error (observed failure marks retryable pending with lastDispatchError, same ID retries to success)');
}

// ---------- Part N: reviewed assignment computed RHS specimens (hermetic, no lane files) ----------
// Extends the reviewed assignment binding to computed/conditional RHS
// (ternary IfExp, BinOp Add concat, .format/f-string with refs,
// parser-owned only) with class-context scope (dotted function chain plus
// class chain, "" for module). Retains credential detection + .env, uses
// hash-only triples (no literal substitution). Fixtures below mirror PR
// shapes (ternary line-555 style, concat line-556 style) as inline regression
// specimens (NOT lane files: no worktree/primary paths, no Git lane state).
{
  const Prov = await import(pathToFileUrl(path.join(ROOT, 'scripts', 'python-provenance.mjs')));
  const { hasSecretValue } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'redact.js')));
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const scopeHash = (scope) => sha(`${Prov.PYTHON_ASSIGN_SCOPE_PREFIX}${scope}`);
  const expectNoLiterals = (value, literals, label) => {
    const serialized = JSON.stringify(value) ?? '';
    for (const literal of literals) assert(!serialized.includes(literal), `${label} leaked ${literal}`);
  };
  // PR-shape specimens (inline, NOT lane files).
  const ternaryPR555 = "def handle_request(cond, fallback):\n    send(token=fallback)\n    api_token = 'primary_555' if cond else fallback";
  const concatPR556 = "def build_prefix(prefix):\n    send(token=prefix)\n    api_token = prefix + '_suffix_556'";
  const formatPR = "def build_greeting(name):\n    send(token=name)\n    api_token = 'hello {}'.format(name)";
  const fstringPR = "def build_f(n):\n    send(token=n)\n    api_token = f'fstring_{n}'";
  const classPR = "class Config:\n    def get_token(self, cond):\n        api_token = 'cls_marker' if cond else 'fallback_cls'";
  const nestedPR = "def outer():\n    def inner():\n        api_token = 'nested_marker'";
  const modulePR = "api_token = 'module_marker'";
  const hostileCred = "def f():\n    token = 'sk-XXXXXXXXXXXXXXXXXXXX'";
  for (const [label, src] of [['ternaryPR555', ternaryPR555], ['concatPR556', concatPR556], ['formatPR', formatPR], ['fstringPR', fstringPR], ['classPR', classPR], ['nestedPR', nestedPR], ['modulePR', modulePR]]) {
    let astOk = true;
    try {
      const { spawnSync: ss } = await import('node:child_process');
      const r = ss('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: src, encoding: 'utf8' });
      astOk = r.status === 0;
    } catch { astOk = false; }
    assert(astOk, `${label} specimen must be accepted by ast.parse`);
  }
  // Without approval every computed RHS is refused (secret-looking).
  for (const [label, src] of [['ternaryPR555', ternaryPR555], ['concatPR556', concatPR556], ['formatPR', formatPR], ['fstringPR', fstringPR]]) {
    assert(hasSecretValue(src, { context: 'source', language: 'python' }) === true, `${label} must be refused without approval`);
  }
  // With the exact triple approved, each computed RHS is exempted (hash-only).
  const cases = [
    { label: 'ternaryPR555', src: ternaryPR555, keyword: 'api_token', scope: 'handle_request', rhs: "'primary_555' if cond else fallback" },
    { label: 'concatPR556', src: concatPR556, keyword: 'api_token', scope: 'build_prefix', rhs: "prefix + '_suffix_556'" },
    { label: 'formatPR', src: formatPR, keyword: 'api_token', scope: 'build_greeting', rhs: "'hello {}'.format(name)" },
    { label: 'fstringPR', src: fstringPR, keyword: 'api_token', scope: 'build_f', rhs: "f'fstring_{n}'" },
    { label: 'classPR', src: classPR, keyword: 'api_token', scope: 'Config.get_token', rhs: "'cls_marker' if cond else 'fallback_cls'" },
    { label: 'nestedPR', src: nestedPR, keyword: 'api_token', scope: 'outer.inner', rhs: "'nested_marker'" },
    { label: 'modulePR', src: modulePR, keyword: 'api_token', scope: '', rhs: "'module_marker'" }
  ];
  for (const c of cases) {
    const entries = Prov.collectPythonAssignApprovals(c.src, [c.keyword]);
    assert(entries.length === 1, `${c.label} must enroll exactly one triple, got ${entries.length}`);
    const expected = { keyword_sha256: sha(c.keyword), callee_sha256: scopeHash(c.scope), value_sha256: sha(c.rhs) };
    assert(JSON.stringify(entries[0]) === JSON.stringify(expected), `${c.label} triple mismatch: got ${JSON.stringify(entries[0])} expected ${JSON.stringify(expected)}`);
    expectNoLiterals(entries, [c.rhs, c.keyword], `${c.label} hash-only registry`);
    assert(hasSecretValue(c.src, { context: 'source', language: 'python', approvedCallKeywordValues: entries }) === false, `${c.label} must be nonsecret with its exact triple approved`);
    // Changed RHS (different bytes) stays refused with the same approval.
    const drifted = c.src.replace(c.rhs, "'changed_unapproved'");
    assert(hasSecretValue(drifted, { context: 'source', language: 'python', approvedCallKeywordValues: entries }) === true, `${c.label} changed RHS must stay refused`);
  }
  // Credential detection retained: a real credential inside a computed RHS
  // is still secret even with its triple approved (direct shapes never reach
  // the assignment exemption). .env retained: non-Python routes never use it.
  const credEntries = Prov.collectPythonAssignApprovals(hostileCred, ['token']);
  assert(hasSecretValue(hostileCred, { context: 'source', language: 'python', approvedCallKeywordValues: credEntries }) === true, 'real credential in computed RHS must stay secret even with approval');
  assert(hasSecretValue('TOKEN=abc', { context: 'source' }) === true, '.env/non-Python routes must stay blocked regardless of Python approvals');
  // Non-add operators and generic calls stay fail-closed (no blanket exemption).
  assert(Prov.collectPythonAssignApprovals("def f():\n    token = 'a' - 'b'", ['token']).length === 0, 'BinOp minus must stay fail-closed');
  assert(Prov.collectPythonAssignApprovals("def f():\n    token = func('a')", ['token']).length === 0, 'generic calls must stay fail-closed');
  console.log('ok: N reviewed assignment computed RHS (ternary IfExp PR555 + concat PR556 + format/f-string with refs, class/nested/module scope, credential+.env retained, hash-only, no literal substitution)');
}

console.log('\ndelegation-canary-smoke: PASS (code SUBSCRIBED-loopback OBSERVED; ChatGPT-side subscription pending coordination)');
