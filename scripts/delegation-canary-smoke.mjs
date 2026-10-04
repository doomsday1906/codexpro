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
  const runFile = path.join(realRoot, '.ai-bridge', 'delegation-runs', `${runId}.json`);
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
  const ocRunFile = path.join(realRoot, '.ai-bridge', 'delegation-runs', `${ocRunId}.json`);
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
  const runFileH2 = (runId) => path.join(realRootH2, '.ai-bridge', 'delegation-runs', `${runId}.json`);
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
  const ncBridge = path.join(realRootH2, '.ai-bridge');
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
  const runFileJ = (id) => path.join(realJ, '.ai-bridge', 'delegation-runs', `${id}.json`);
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

console.log('\ndelegation-canary-smoke: PASS (code SUBSCRIBED-loopback OBSERVED; ChatGPT-side subscription pending coordination)');
