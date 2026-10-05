#!/usr/bin/env node
// Focused regressions for the identity/standalone/output leaf (4 cases).
// Extends (never replaces) delegation-triengine-smoke.mjs T1-T9 and
// delegation-repair-focus-smoke.mjs R1-R5.
//
// C1 request identity binds the canonical workdir: the same request id with
//   a different canonical directory conflicts (duplicate_conflicting, no
//   second worker, nothing consumed); the identical restatement replays.
//   Exact replay (id lookup + conflict check) resolves BEFORE the
//   active-session busy check, so an identical retry with the same id and
//   session replays instead of rejecting itself as session_busy.
// C2 OpenCode standalone route: new launches and continuations run
//   `opencode run --standalone` (private server per turn); pre-existing
//   shared-service runs stay labeled, never silently converted. Cancel
//   verification is windowed (grace + verification window against
//   cancel-complete) plus an owned-tree liveness recheck; cleanup stays
//   incomplete/uncertain until verified and a repeated cancel re-verifies
//   live (never converts a cached incomplete into success). Cancellation is
//   proven through the OpenCode execution route (not just Codex workers):
//   cancel stops owned work and subsequent writes while unrelated work runs.
// C3 output artifact + coverage: the promised bounded OpenCode output
//   artifact is persisted (never a pointer to a nonexistent last-message
//   file: path is reported only when the file exists, else unavailable +
//   reason); the 500-file / 256-KiB change-evidence coverage limits propagate
//   into results (fingerprintsTruncated, truncated flags, counts/reasons).
// C4 repeated-cancel recheck: an already-cancelled run re-verifies live on
//   every cancel call (rechecked marker, current truth, persisted
//   last_cancel_verification).
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs, fake binaries via CODEXPRO_*_BIN (all fake-binary
// results labeled shim). The real installed opencode binary is probed
// read-only (--version, `run --help` shows --standalone, session help shows
// no halt/stop) to ground the standalone-route claim.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));

// ---------- unit: C1 workdir identity ----------
{
  const base = {
    engine: 'codex', delegationGroup: 'g', isCanary: false, task: 't',
    profile: 'CODEX_IMPLEMENTER', executionPolicy: 'workspace-write',
    workdir: '/tmp/canon-wd-a'
  };
  assert(Store.isLaunchRequestConflict(base, { ...base }) === false, 'identical request (same workdir) must replay');
  assert(Store.isLaunchRequestConflict(base, { ...base, workdir: '/tmp/canon-wd-b' }) === true,
    'same request id with a different canonical directory must conflict');
  assert(Store.isLaunchRequestConflict(base, { ...base, workdir: undefined }) === false,
    'candidate without a workdir keeps the legacy wildcard (never conflicts)');
  assert(Store.canonicalizeWorkdirForCompare('/tmp/x/./y') === Store.canonicalizeWorkdirForCompare('/tmp/x/y'),
    'spelling variants of one directory must canonicalize identically');
  assert(Store.canonicalizeWorkdirForCompare('/tmp/x/y') !== Store.canonicalizeWorkdirForCompare('/tmp/x/z'),
    'different directories must not canonicalize identically');
  const oc = {
    engine: 'opencode', delegationGroup: 'g', isCanary: false, task: 't',
    model: 'm1', agent: 'implementer', requestedSessionId: '', workdir: '/tmp/oc-wd'
  };
  assert(Store.isLaunchRequestConflict(oc, { ...oc, workdir: '/tmp/oc-wd' }) === false, 'opencode identical restatement replays');
  assert(Store.isLaunchRequestConflict(oc, { ...oc, workdir: '/tmp/oc-other' }) === true, 'opencode changed workdir conflicts');
  console.log('ok: C1 unit (canonical workdir is request identity; timeout stays non-identity by construction)');
}

// ---------- unit: C2 standalone argv + route labels ----------
{
  const real = Engines.buildOpenCodeRealArgv({ model: 'm', agent: 'implementer', prompt: 'hi' });
  assert(real[0] === 'run' && real[1] === '--standalone', `real argv must lead with run --standalone: ${JSON.stringify(real)}`);
  const realSess = Engines.buildOpenCodeRealArgv({ model: 'm', agent: 'implementer', prompt: 'hi', sessionId: 'ses_x' });
  assert(realSess.includes('--standalone') && realSess.includes('--session') && realSess.includes('ses_x'),
    `real argv with session must carry --standalone --session: ${JSON.stringify(realSess)}`);
  assert(!realSess.includes('--profile') && !realSess.includes('exec'), 'opencode argv must never carry Codex flags');
  const canary = Engines.buildOpenCodeCanaryArgv('m', 'hi');
  assert(canary.includes('--standalone'), `canary argv must carry --standalone: ${JSON.stringify(canary)}`);
  const resume = Engines.buildOpenCodeResumeArgv('ses_x', 'm', 'hi');
  assert(resume.slice(0, 2).join(' ') === 'run --standalone' && resume.includes('--session'),
    `resume argv must ride --standalone --session: ${JSON.stringify(resume)}`);
  assert(Engines.OPENCODE_QUALIFIED_RUN_FLAGS.includes('--standalone'), '--standalone must stay a qualified run flag');
  assert(Tools.opencodeExecutionRoute({ engine: 'opencode' }).route === 'shared-service' &&
    Tools.opencodeExecutionRoute({ engine: 'opencode' }).legacy === true,
    'run files predating the route field must label shared-service (legacy, never silently converted)');
  assert(Tools.opencodeExecutionRoute({ engine: 'opencode', opencodeRoute: 'standalone' }).route === 'standalone',
    'new runs must label standalone');
  assert(Tools.opencodeExecutionRoute({ engine: 'codex' }).route === 'n/a', 'non-opencode runs carry no route label');
  // Real-binary grounding (read-only probes, no model call).
  const runHelp = await (async () => {
    const { spawnSync } = await import('node:child_process');
    return spawnSync('opencode', ['run', '--help'], { encoding: 'utf8', timeout: 15000 });
  })();
  assert(runHelp.status === 0 && /--standalone/.test(String(runHelp.stdout)),
    `installed opencode run --help must document --standalone (the supported private-execution route): ${String(runHelp.stdout).slice(0, 160)}`);
  console.log('ok: C2 unit (standalone argv on launch + continuation, honest legacy labels, real-binary route grounding)');
}

// ---------- unit: C2 quiescence-merge fail-closed ----------
{
  const clean = { continued: [], truncated: false, checked: true };
  const dirty = { continued: ['~ f.txt (modified after cancel)'], truncated: false, checked: true };
  const blind = { continued: [], truncated: false, checked: false, reason: 'workdir unreadable; quiescence unverifiable' };
  assert(Tools.mergeQuiescenceLegs(clean, clean).checked === true &&
    Tools.mergeQuiescenceLegs(clean, clean).continued.length === 0, 'two quiet legs must quiesce');
  assert(Tools.mergeQuiescenceLegs(clean, dirty).continued.length === 1, 'either dirty leg must deny quiescence');
  assert(Tools.mergeQuiescenceLegs(clean, blind).checked === false, 'an unverifiable leg must fail closed');
  assert(Tools.recheckOwnedTreeGone(999999999, '0').length === 0, 'unprovable pid must never be adopted as owned');
  console.log('ok: C2 unit (windowed quiescence merge fail-closed, owned-tree recheck never broadens)');
}

// ---------- unit: C3 coverage + honest last-message ----------
{
  const big = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-idcov-'));
  for (let i = 0; i < 505; i += 1) {
    await fsp.writeFile(path.join(big, `f${String(i).padStart(4, '0')}.txt`), `v${i}`);
  }
  await fsp.writeFile(path.join(big, 'big.bin'), Buffer.alloc(300 * 1024, 7));
  const base = Engines.captureWorkdirBaseline(big);
  assert(base.fingerprintsTruncated === true, 'baseline over 500 files must set fingerprintsTruncated');
  assert((base.fingerprints ?? []).length === Engines.WORKDIR_FINGERPRINT_LIMIT,
    `baseline fingerprints must be bounded at 500: ${(base.fingerprints ?? []).length}`);
  const ev = Engines.collectWorkdirEvidence(big, base);
  assert(ev.fingerprintsTruncated === true, `evidence must propagate fingerprintsTruncated: ${JSON.stringify(ev.coverageReason)}`);
  assert(ev.fingerprintCounts && ev.fingerprintCounts.baseline === 500 && ev.fingerprintCounts.current === 500,
    `evidence must carry fingerprint counts: ${JSON.stringify(ev.fingerprintCounts)}`);
  assert((ev.nameOnlyCount ?? 0) >= 1, `256-KiB file must be counted name-only: ${JSON.stringify(ev.nameOnlyCount)}`);
  assert(ev.coverageReason && /500-file/.test(ev.coverageReason) && /256-KiB/.test(ev.coverageReason),
    `coverage reason must name both bounds: ${JSON.stringify(ev.coverageReason)}`);
  const te = Tools.buildTestEvidence({
    terminal: true, state: 'completed', exitCode: 0, timedOut: false,
    stdoutTail: 'x', stderrTail: '', stdoutTruncated: false, stderrTruncated: false,
    diffKind: ev.kind, diffTruncated: ev.truncated, fingerprintsTruncated: ev.fingerprintsTruncated,
    coverageReason: ev.coverageReason,
    lastMessage: { status: 'present', truncated: false, bytes: 10, path: 'opencode-last-message.json' }
  });
  assert(te.diff.truncated === true && /500-file/.test(te.diff.reason ?? ''),
    `test evidence diff must propagate coverage truncation + reason: ${JSON.stringify(te.diff)}`);
  const ghost = Tools.describeLastMessageArtifact(path.join(big, 'no-such-workdir'), 'opencode');
  assert(ghost.status === 'unavailable' && !('path' in ghost) && ghost.reason,
    `absent last-message must be unavailable with a reason and NO path: ${JSON.stringify(ghost)}`);
  console.log('ok: C3 unit (500-file/256-KiB coverage propagates; absent last-message reports no path)');
}

// ---------- MCP wiring: fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-id-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;

const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-id-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-id-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-id-shim-'));
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const codexInstant = await fake('codex-instant', 'if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\nexit 0');
const ocHeartbeat = await fake('opencode-heartbeat',
  'if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\nwhile true; do date +%s%N >> heartbeat.txt; sleep 0.2; done');
const ocInstantOut = await fake('opencode-instant-out',
  'if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\necho \'{"session":"ses_out","message":"bounded worker output"}\'\nexit 0');
process.env.CODEXPRO_CODEX_BIN = codexInstant;
process.env.CODEXPRO_OPENCODE_BIN = ocHeartbeat;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-id-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'identity-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const wid = opened.structuredContent.workspace_id;

const waitSettled = async (runId, tries = 120) => {
  for (let i = 0; i < tries; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    assert(!r.isError, `read must succeed while polling: ${JSON.stringify(r.structuredContent)}`);
    const state = r.structuredContent.state;
    if (state !== 'running' && state !== 'queued') return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`ASSERT: run ${runId} never settled`);
};

// ---------- MCP C1: changed workdir conflicts; identical restatement replays ----------
{
  const k1 = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'id-wd-a',
    canary: true, delegation_group: 'hestia-cli-canary', request_id: 'req-id-wd-1', timeout_ms: 60000
  });
  assert(!k1.isError, `canary K1 must launch: ${JSON.stringify(k1.structuredContent)}`);
  const k1Id = k1.structuredContent.run_id;
  await waitSettled(k1Id);
  const changedWd = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'id-wd-b',
    canary: true, delegation_group: 'hestia-cli-canary', request_id: 'req-id-wd-1', timeout_ms: 60000
  });
  assert(changedWd.isError && changedWd.structuredContent.error === 'duplicate_conflicting' &&
    changedWd.structuredContent.run_id === k1Id,
    `same request id with a different workdir must conflict (no second worker): ${JSON.stringify(changedWd.structuredContent)}`);
  assert(!fs.existsSync(path.join(wsRoot, 'id-wd-b')), 'conflicting re-use must consume nothing (no workdir created)');
  const replay = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'id-wd-a',
    canary: true, delegation_group: 'hestia-cli-canary', request_id: 'req-id-wd-1', timeout_ms: 60000
  });
  assert(!replay.isError && replay.structuredContent.idempotent_replay === true && replay.structuredContent.run_id === k1Id,
    `identical restatement must replay the old run: ${JSON.stringify(replay.structuredContent)}`);
  console.log('ok: C1 MCP (changed workdir conflicts; identical restatement replays)');
}

// ---------- MCP C2: identical active-session retry replays; new request stays busy ----------
const OC_TASK = 'List files. Change nothing.';
let ocSessRunId = null;
{
  const o1 = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'oc-sess-a', task: OC_TASK, delegation_group: 'team-identity',
    session_id: 'ses_case2', request_id: 'req-oc-sess-1', timeout_ms: 60000
  });
  assert(!o1.isError, `opencode session run must launch: ${JSON.stringify(o1.structuredContent)}`);
  ocSessRunId = o1.structuredContent.run_id;
  assert(o1.structuredContent.execution_route === 'standalone', 'new opencode launch must ack the standalone route');
  await new Promise((r) => setTimeout(r, 1200));
  const hb = path.join(wsRoot, 'oc-sess-a', 'heartbeat.txt');
  assert(fs.existsSync(hb), 'opencode worker must be executing before the retry');
  // Identical retry (same id + session + workdir + task): replay, NOT session_busy.
  const retry = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'oc-sess-a', task: OC_TASK, delegation_group: 'team-identity',
    session_id: 'ses_case2', request_id: 'req-oc-sess-1', timeout_ms: 60000
  });
  assert(!retry.isError && retry.structuredContent.idempotent_replay === true &&
    retry.structuredContent.run_id === ocSessRunId,
    `identical active-session retry must replay (never session_busy): ${JSON.stringify(retry.structuredContent)}`);
  // Genuinely new request on the same busy session: still session_busy.
  const busy = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'oc-sess-b', task: OC_TASK, delegation_group: 'team-identity',
    session_id: 'ses_case2', request_id: 'req-oc-sess-2', timeout_ms: 60000
  });
  assert(busy.isError && busy.structuredContent.error === 'session_busy' &&
    busy.structuredContent.holder_run_id === ocSessRunId,
    `new request on the busy session must stay session_busy: ${JSON.stringify(busy.structuredContent)}`);
  const cancelO1 = await call('delegation_cancel', { workspace_id: wid, run_id: ocSessRunId });
  assert(!cancelO1.isError && cancelO1.structuredContent.state === 'cancelled', 'session run must cancel to free the session');
  ocSessRunId = null;
  console.log('ok: C2 MCP (identical active-session retry replays; new request on busy session refuses)');
}

// ---------- MCP C2/C4: opencode cancel via the execution route + repeat recheck ----------
let runAId = null;
let runBId = null;
const bestEffortCancel = async (runId) => {
  if (!runId) return;
  try {
    const state = (await call('delegation_read_result', { workspace_id: wid, run_id: runId })).structuredContent.state;
    if (state === 'running' || state === 'queued' || state === 'needs-input') {
      await call('delegation_cancel', { workspace_id: wid, run_id: runId });
    }
  } catch { /* cleanup only */ }
};
try {
  const runA = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'oc-cancel-a', task: OC_TASK, delegation_group: 'team-identity',
    session_id: 'ses_a', request_id: 'req-oc-a', timeout_ms: 60000
  });
  assert(!runA.isError, `opencode run A must launch: ${JSON.stringify(runA.structuredContent)}`);
  runAId = runA.structuredContent.run_id;
  const runB = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'oc-cancel-b', task: OC_TASK, delegation_group: 'team-identity',
    session_id: 'ses_b', request_id: 'req-oc-b', timeout_ms: 60000
  });
  assert(!runB.isError, 'opencode run B must launch (unrelated work)');
  runBId = runB.structuredContent.run_id;
  await new Promise((r) => setTimeout(r, 1500));
  const hbA = path.join(wsRoot, 'oc-cancel-a', 'heartbeat.txt');
  assert(fs.existsSync(hbA), 'opencode worker A must have written heartbeats before cancel');
  const cancelA = await call('delegation_cancel', { workspace_id: wid, run_id: runA.structuredContent.run_id });
  assert(!cancelA.isError, `cancel A must succeed: ${JSON.stringify(cancelA.structuredContent)}`);
  const cv = cancelA.structuredContent.cancel_verification;
  assert(cancelA.structuredContent.cleanup_finished === true, 'opencode owned tree must be reaped');
  assert(cv && cv.pid_tree && cv.pid_tree.owned_tree_gone === true && cv.pid_tree.liveness_rechecked === true,
    `cancel must recheck owned-tree exit: ${JSON.stringify(cv)}`);
  assert(cv.quiescence && cv.quiescence.checked === true && cv.quiescence.continued_writes.length === 0,
    `cancel must verify windowed quiescence: ${JSON.stringify(cv)}`);
  assert(cv.verification_complete === true, 'cancel verification must be complete');
  assert(cv.session_halt && cv.session_halt.claimed === false && cv.session_halt.blocker,
    'session-side halt must stay unclaimed with the blocker');
  assert(/Execution route: standalone/.test(cancelA.content[0].text),
    `cancel ack must name the standalone execution route: ${cancelA.content[0].text.slice(0, 200)}`);
  const m1 = fs.statSync(hbA).mtimeMs;
  const s1 = fs.statSync(hbA).size;
  assert(s1 > 0, 'heartbeat file must be nonempty');
  await new Promise((r) => setTimeout(r, 2500));
  assert(fs.statSync(hbA).mtimeMs === m1 && fs.statSync(hbA).size === s1, 'opencode: no further writes after cancel');
  const readB = await call('delegation_read_result', { workspace_id: wid, run_id: runB.structuredContent.run_id });
  assert(!readB.isError && readB.structuredContent.state === 'running', 'unrelated opencode run B must stay running after A is cancelled');
  const hbB = path.join(wsRoot, 'oc-cancel-b', 'heartbeat.txt');
  const bs1 = fs.statSync(hbB).size;
  await new Promise((r) => setTimeout(r, 600));
  assert(fs.statSync(hbB).size > bs1, 'unrelated opencode run B must keep executing');
  const readA = await call('delegation_read_result', { workspace_id: wid, run_id: runA.structuredContent.run_id });
  assert(readA.structuredContent.execution_route === 'standalone', 'read must carry the standalone execution route');
  assert(readA.structuredContent.last_cancel_verification &&
    readA.structuredContent.last_cancel_verification.verificationComplete === true,
    `read must persist the cancel verification: ${JSON.stringify(readA.structuredContent.last_cancel_verification)}`);
  // Repeat cancel: re-verifies live (rechecked), never converts from cache.
  const repeatA = await call('delegation_cancel', { workspace_id: wid, run_id: runA.structuredContent.run_id });
  assert(!repeatA.isError && repeatA.structuredContent.already_terminal === true,
    `repeat cancel must stay idempotent: ${JSON.stringify(repeatA.structuredContent)}`);
  assert(repeatA.structuredContent.cancel_verification &&
    repeatA.structuredContent.cancel_verification.rechecked === true,
    `repeat cancel must re-verify live (rechecked marker): ${JSON.stringify(repeatA.structuredContent.cancel_verification)}`);
  assert(repeatA.structuredContent.cleanup_finished === true &&
    repeatA.structuredContent.cancel_verification.verification_complete === true,
    'repeat cancel must report current (verified) truth, not a cached conversion');
  assert(!fs.existsSync(path.join(ROOT, 'heartbeat.txt')), 'containment tripwire: no shim heartbeat may escape the run workdir');
  console.log('ok: C2/C4 MCP (opencode-route cancel stops owned work + writes, unrelated work runs, repeat re-verifies)');
} finally {
  await bestEffortCancel(runAId);
  await bestEffortCancel(runBId);
}

// ---------- MCP C3: bounded output artifact persisted; route acked ----------
{
  process.env.CODEXPRO_OPENCODE_BIN = ocInstantOut;
  const o2 = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'oc-out-1', task: 'Report readiness. Change nothing.', delegation_group: 'team-identity',
    request_id: 'req-oc-out-1', timeout_ms: 60000
  });
  assert(!o2.isError, `opencode output run must launch: ${JSON.stringify(o2.structuredContent)}`);
  const o2Id = o2.structuredContent.run_id;
  await waitSettled(o2Id);
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: o2Id });
  assert(!read.isError, 'output run must be readable');
  const te = read.structuredContent.test_evidence;
  assert(te && te.stdout_tail_present === true, `bounded stdout tail must be present: ${JSON.stringify(te)}`);
  const expectedOutRel = Tools.lastMessageRelPathForAttempt('opencode', 1, o2Id);
  assert(te.last_message && te.last_message.status === 'present' && te.last_message.path === expectedOutRel && te.last_message.attempt_n === 1,
    `last-message must be present with its run-bound path + provenance: ${JSON.stringify(te.last_message)}`);
  const artifactAbs = path.join(wsRoot, 'oc-out-1', expectedOutRel);
  assert(fs.existsSync(artifactAbs), 'promised bounded output artifact must exist on disk');
  assert(fs.readFileSync(artifactAbs, 'utf8').includes('bounded worker output'),
    'persisted artifact must carry the bounded worker output');
  assert(!fs.existsSync(path.join(wsRoot, 'oc-out-1', 'opencode-last-message.json')),
    'no legacy shared artifact may be created for a new run');
  assert(read.structuredContent.execution_route === 'standalone', 'output run must ack the standalone route');
  const wd = read.structuredContent.workdir_evidence;
  assert(wd && (wd.changed ?? []).some((c) => c.includes('opencode-last-message-')),
    `persisted artifact must be attributed in change evidence: ${JSON.stringify(wd && wd.changed)}`);
  console.log('ok: C3 MCP (bounded OpenCode output artifact persisted, attributed, route acked)');
}

console.log('delegation-identity-standalone-output-smoke: PASS (no live model calls; fake-binary results labeled shim)');
