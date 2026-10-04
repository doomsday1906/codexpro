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
const a = fs.readFileSync('fixture-a.txt', 'utf8');
const b = fs.readFileSync('fixture-b.txt', 'utf8');
fs.writeFileSync(args[outputIndex + 1], 'canary last message\\n');
console.log('CANARY-REPORT-A:' + a.trim().split('\\n')[0]);
console.log('CANARY-REPORT-B:' + b.trim().split('\\n')[0]);
`);
await fsp.writeFile(path.join(shimBin, 'codex'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-codex.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'codex'), 0o755);
await fsp.writeFile(path.join(shimBin, 'fake-opencode.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== 'run' || !args.includes('--model') || !args.includes('--format')) throw new Error('expected opencode run --model ... --format json');
if (args.includes('--profile') || args.includes('exec') || args.includes('--ephemeral') || args.includes('--output-last-message')) {
  throw new Error('opencode must never receive Codex flags');
}
const modelIndex = args.indexOf('--model');
if (args[modelIndex + 1] !== 'opencode-go/muse-spark-1.3-contributor') throw new Error('opencode fake expects the host model, got ' + args[modelIndex + 1]);
if (process.env.CODEXPRO_FAKE_OPENCODE_MODE === 'sleep') {
  await new Promise((resolve) => setTimeout(resolve, 30000));
  console.log(JSON.stringify({ sessionID: 'ses_sleep0000000001' }));
  process.exit(0);
}
const a = fs.readFileSync('fixture-a.txt', 'utf8');
const b = fs.readFileSync('fixture-b.txt', 'utf8');
console.log(JSON.stringify({ sessionID: 'ses_fake0000000001' }));
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
    await Events.verifySubscriptionChallenge('https://example.com/hook', validated.secretBytes, 'run-attention', {}, stubFetch(200, { challenge: 'wrong' }, capture));
  } catch (error) { challengeCode = Number(error?.code); }
  assert(challengeCode === -32015, `challenge failure must be error -32015, got ${challengeCode}`);
  assert(capture.calls === 1, 'challenge must actually POST');
  // Redirects are never followed.
  let redirectCode = 0;
  try {
    await Events.verifySubscriptionChallenge('https://example.com/hook', validated.secretBytes, 'run-attention', {}, stubFetch(302, '', { calls: 0 }));
  } catch (error) { redirectCode = Number(error?.code); }
  assert(redirectCode === -32015, 'redirect must fail the challenge');
  // Delivery matrix via stubs: 410/413 permanent (no retry), 500 retryable.
  const evt = { event: 'run-attention', eventId: 'evt_test', runId: 'run_aaaaaaaaaaaaaaaa', engine: 'codex', delegationGroup: 'hestia-cli-canary', state: 'completed', seq: 1, version: 1, createdAt: new Date().toISOString() };
  const gone = await Events.deliverEventToSubscription('https://example.com/hook', validated.secretBytes, evt, stubFetch(410, '', { calls: 0 }));
  assert(gone.status === 'permanent', '410 must be permanent (no retry)');
  const tooLarge = await Events.deliverEventToSubscription('https://example.com/hook', validated.secretBytes, evt, stubFetch(413, '', { calls: 0 }));
  assert(tooLarge.status === 'permanent', '413 must be permanent (no retry)');
  const broken = await Events.deliverEventToSubscription('https://example.com/hook', validated.secretBytes, evt, stubFetch(500, '', { calls: 0 }));
  assert(broken.status === 'retryable', '500 must be retryable');
  assert(Events.nextRetryDelayMs(0) === 1000 && Events.nextRetryDelayMs(3) === 8000, 'backoff must be deterministic');
  console.log('ok: D events validation + challenge -32015 + delivery matrix (stubs)');
}
{
  // Loopback wire proof: real HTTP server (127.0.0.1) proves the Standard
  // Webhooks exchange; production subscribe-time validation still refuses
  // private/local callbacks (proven above). SUBSCRIBED vs OBSERVED stays split.
  const secret = Buffer.alloc(32, 9);
  const observed = { challenge: null, deliveryHeaders: null, deliveryBody: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const id = req.headers['webhook-id'];
      const ts = req.headers['webhook-timestamp'];
      const sig = String(req.headers['webhook-signature'] ?? '');
      const expected = `v1,${createHmac('sha256', secret).update(`${id}.${ts}.${body}`, 'utf8').digest('base64')}`;
      if (sig !== expected) {
        res.writeHead(401).end('bad signature');
        return;
      }
      const parsed = JSON.parse(body);
      if (parsed.type === 'events.subscribe-challenge') {
        observed.challenge = parsed.challenge;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ challenge: parsed.challenge }));
        return;
      }
      observed.deliveryHeaders = { id, ts, sig: sig.slice(0, 8) };
      observed.deliveryBody = parsed;
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/hook`;
  const verified = await Events.verifySubscriptionChallenge(url, secret, 'run-attention', { delegationGroup: 'hestia-cli-canary' });
  assert(verified.webhookId.startsWith('wh_') && observed.challenge === verified.challenge, 'loopback challenge must verify with unique webhook-id');
  const evt = { event: 'run-attention', eventId: 'evt_loop', runId: 'run_bbbbbbbbbbbbbbbb', engine: 'codex', delegationGroup: 'hestia-cli-canary', state: 'completed', seq: 1, version: 1, summary: 'completed exit 0', createdAt: new Date().toISOString() };
  const outcome = await Events.deliverEventToSubscription(url, secret, evt);
  assert(outcome.status === 'delivered', 'loopback delivery must succeed');
  assert(observed.deliveryBody?.runId === 'run_bbbbbbbbbbbbbbbb' && observed.deliveryBody?.summary === 'completed exit 0', 'delivery must carry run id + sanitized summary only');
  assert(!JSON.stringify(observed.deliveryBody).includes('whsec_'), 'delivery must never carry credentials');
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
  const ocReply = await call('delegation_followup', { run_id: ocRunId, checkpoint: { id: 'oc-r1', run_id: ocRunId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'oc-q1' } });
  assert(!ocReply.isError && ocReply.structuredContent.continuation === 'resumed' && ocReply.structuredContent.session_id === 'ses_fake0000000001', `opencode reply must truly resume via --session: ${JSON.stringify(ocReply.structuredContent)}`);
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

// ---------- Part G: SDK gap ----------
{
  const types = fs.readFileSync(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'types.d.ts'), 'utf8');
  assert(!types.includes('events/subscribe') && !types.includes('server/discover'), 'SDK must lack native events methods (gap confirmation for the tools-compat approach)');
  console.log('ok: G sdk gap confirmed (no native server/discover or events/*)');
}

console.log('\ndelegation-canary-smoke: PASS (code SUBSCRIBED-loopback OBSERVED; ChatGPT-side subscription pending coordination)');
