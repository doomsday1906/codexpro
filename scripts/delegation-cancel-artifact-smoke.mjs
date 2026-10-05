#!/usr/bin/env node
// Focused regressions for the cancel-verification + per-attempt-artifact leaf (2 defects).
// Extends (never replaces) delegation-triengine-smoke.mjs T1-T9,
// delegation-repair-focus-smoke.mjs R1-R5, and
// delegation-identity-standalone-output-smoke.mjs C1-C4.
//
// D1 uncertain cancel stays incomplete: a missing PID or stale root is NEVER
//   proof of cleanup (cleanupFinished false, not true). Descendant
//   PID+starttime identities persist across cancels and are rechecked live
//   on every cancel (never cached success). Exited-root with a surviving
//   descendant reports incomplete + non-empty remaining; pid-less
//   uncertain-dispatch cancel stays uncertain/incomplete, never success.
//   Quiescence is continued-execution evidence only: it supports
//   ownership/exit evidence, never substitutes for it.
// D2 run-and-attempt-specific output artifacts: per-(run, attempt) paths
//   (attempt 1 keeps the legacy name; later attempts are suffixed),
//   exclusively created (O_EXCL: existing files — including existing EMPTY
//   files — are never overwritten), provenance-bound (the recorded relPath
//   binds which attempt produced the artifact; reads surface only the
//   current attempt's artifact + attempt_n). Continuation regressions:
//   (a) a second attempt cannot surface the first attempt's output;
//   (b) a pre-existing empty artifact file is never overwritten (stays
//   empty + reported unavailable; the new attempt writes its own path).
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs, fake binaries via CODEXPRO_*_BIN (all fake-binary
// results labeled shim).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));

// ---------- unit D1/D2: run-bound per-attempt paths + exclusive create ----------
{
  // New artifacts ALWAYS bind the FULL validated run identity plus the
  // attempt — including attempt 1. Two ids sharing a trailing 8-hex
  // suffix bind distinct files (no collision). Legacy shared names are
  // never created anew; the legacy shape survives read-only (no valid run
  // id) for pre-binding run files only.
  const RUN_A = 'run_aaaaaaaaaaaaaaaa';
  const SHORT_A = Tools.shortRunId(RUN_A);
  assert(SHORT_A === 'aaaaaaaaaaaaaaaa', `full run identity binds the run: ${SHORT_A}`);
  assert(Tools.isValidRunIdForArtifact(RUN_A) === true, 'valid run ids validate');
  assert(Tools.isValidRunIdForArtifact('run_SHORT') === false, 'invalid run ids never bind new writes');
  assert(Tools.isValidRunIdForArtifact('') === false, 'missing run identity never binds new writes');
  // The finding's colliding pair shares the trailing 8 hex yet binds
  // distinct artifacts (no cross-attribution).
  const RUN_COLLIDE_1 = 'run_000000001234abcd';
  const RUN_COLLIDE_2 = 'run_ffffffff1234abcd';
  assert(Tools.shortRunId(RUN_COLLIDE_1) !== Tools.shortRunId(RUN_COLLIDE_2),
    `colliding trailing hex must not collide: ${Tools.shortRunId(RUN_COLLIDE_1)} vs ${Tools.shortRunId(RUN_COLLIDE_2)}`);
  assert(Tools.lastMessageRelPathForAttempt('codex', 1, RUN_COLLIDE_1) !== Tools.lastMessageRelPathForAttempt('codex', 1, RUN_COLLIDE_2),
    'the colliding pair binds distinct Codex artifacts');
  assert(Tools.lastMessageRelPathForAttempt('opencode', 1, RUN_A) === `opencode-last-message-${SHORT_A}-attempt-1.json`,
    `attempt 1 binds run+attempt, never the legacy shared name: ${Tools.lastMessageRelPathForAttempt('opencode', 1, RUN_A)}`);
  assert(Tools.lastMessageRelPathForAttempt('opencode', 0, RUN_A) === `opencode-last-message-${SHORT_A}-attempt-1.json`,
    'non-positive attempt numbers clamp to attempt 1 within the run namespace');
  assert(Tools.lastMessageRelPathForAttempt('opencode', 2, RUN_A) === `opencode-last-message-${SHORT_A}-attempt-2.json`,
    `attempt 2 gets its own run-bound file: ${Tools.lastMessageRelPathForAttempt('opencode', 2, RUN_A)}`);
  assert(Tools.lastMessageRelPathForAttempt('codex', 3, RUN_A) === `codex-last-message-${SHORT_A}-attempt-3.md`,
    'codex attempts suffix before the extension inside the run namespace');
  assert(Tools.lastMessageRelPathForAttempt('claude', 2, RUN_A) === `claude-last-message-${SHORT_A}-attempt-2.json`,
    'claude attempts are per-(run, attempt) too');
  const RUN_B = 'run_bbbbbbbbbbbbbbbb';
  assert(Tools.lastMessageRelPathForAttempt('opencode', 1, RUN_A) !== Tools.lastMessageRelPathForAttempt('opencode', 1, RUN_B),
    'attempt suffix alone is insufficient: different runs bind different files even in one shared workdir');
  assert(Tools.lastMessageRelPathForAttempt('opencode', 1) === 'opencode-last-message.json',
    'legacy shape without a run id is preserved read-only (never for new writes)');
  assert(Tools.lastMessageRelPathForAttempt('opencode', 2) === 'opencode-last-message-attempt-2.json',
    'legacy suffixed shape without a run id is preserved read-only');
  assert(JSON.stringify(Tools.attemptArtifactFallbackPaths('opencode', 1, RUN_A)) === JSON.stringify(
    [1, 2, 3].map((i) => `opencode-last-message-${SHORT_A}-attempt-1-x${i}.json`)),
    `fallbacks bind the same (run, attempt): ${JSON.stringify(Tools.attemptArtifactFallbackPaths('opencode', 1, RUN_A))}`);
  const adir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-artifact-excl-'));
  assert(Tools.exclusivelyCreateArtifact(adir, 'a.json', 'hello') === 'a.json',
    'exclusive create succeeds on an absent path');
  assert(fs.readFileSync(path.join(adir, 'a.json'), 'utf8') === 'hello', 'created content must match');
  assert(Tools.exclusivelyCreateArtifact(adir, 'a.json', 'OTHER') === null,
    'an existing file is never overwritten');
  assert(fs.readFileSync(path.join(adir, 'a.json'), 'utf8') === 'hello', 'original content must survive');
  await fsp.writeFile(path.join(adir, 'empty.json'), '');
  assert(Tools.exclusivelyCreateArtifact(adir, 'empty.json', 'FILL') === null,
    'an existing EMPTY file is never filled (empty = unavailable, not a slot)');
  assert(fs.statSync(path.join(adir, 'empty.json')).size === 0, 'empty file must stay empty');
  // A preoccupied LEGACY shared file is irrelevant to a run-bound attempt:
  // the new run writes its own namespace and never claims the legacy file.
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-artifact-preocc-'));
  await fsp.writeFile(path.join(wdir, 'opencode-last-message.json'), '');
  await fsp.writeFile(path.join(wdir, 'codex-last-message.md'), 'LEGACY-JUNK-FROM-ANOTHER-RUN');
  const primaryA = Tools.lastMessageRelPathForAttempt('opencode', 1, RUN_A);
  const rec = Tools.persistAttemptArtifact(wdir, 'opencode', 1, 'retained-output', RUN_A);
  assert(rec.created === true && rec.provenance === 'created' && rec.relPath === primaryA,
    `run-bound primary is created in its own namespace: ${JSON.stringify(rec)}`);
  assert(fs.statSync(path.join(wdir, 'opencode-last-message.json')).size === 0,
    'pre-existing empty legacy file must stay empty (never a slot to fill)');
  assert(fs.readFileSync(path.join(wdir, rec.relPath), 'utf8') === 'retained-output',
    'retained output must land in the attempt-owned run-bound file');
  const desc = Tools.describeAttemptArtifact(wdir, 'opencode', 1, rec);
  assert(desc.status === 'present' && desc.path === rec.relPath && desc.attempt_n === 1,
    `recorded provenance binds the read: ${JSON.stringify(desc)}`);
  const descBareString = Tools.describeAttemptArtifact(wdir, 'opencode', 1, rec.relPath);
  assert(descBareString.status === 'unavailable',
    `a bare path without a creation verdict never reads present: ${JSON.stringify(descBareString)}`);
  const descLegacy = Tools.describeAttemptArtifact(wdir, 'opencode', 1);
  assert(descLegacy.status === 'unavailable',
    `no recorded provenance means unavailable, never a legacy lookup: ${JSON.stringify(descLegacy)}`);
  const descMissing = Tools.describeAttemptArtifact(wdir, 'opencode', 2);
  assert(descMissing.status === 'unavailable' && !('path' in descMissing) && descMissing.attempt_n === 2,
    `an attempt with no artifact reports unavailable with no path: ${JSON.stringify(descMissing)}`);
  // A nonempty preoccupied legacy file is never presented as this run's
  // result — neither by lookup nor by an unproven record.
  const descCross = Tools.describeAttemptArtifact(wdir, 'codex', 1);
  assert(descCross.status === 'unavailable',
    `legacy lookup without provenance stays unavailable: ${JSON.stringify(descCross)}`);
  const descCrossRecord = Tools.describeAttemptArtifact(wdir, 'codex', 1, { relPath: 'codex-last-message.md', created: false });
  assert(descCrossRecord.status === 'unavailable' && /without this run/.test(descCrossRecord.reason ?? ''),
    `pre-existing file without a creation verdict is never claimed: ${JSON.stringify(descCrossRecord)}`);
  // Forged run-bound preoccupation (junk at the exact bound primary) diverts
  // to the attempt's own fallback, never claims the junk.
  const RUN_C = 'run_cccccccccccccccc';
  const forgedPrimary = Tools.lastMessageRelPathForAttempt('opencode', 1, RUN_C);
  await fsp.writeFile(path.join(wdir, forgedPrimary), 'FORGED-JUNK');
  const recForged = Tools.persistAttemptArtifact(wdir, 'opencode', 1, 'new-output', RUN_C);
  assert(recForged.created === true && recForged.provenance === 'created' && recForged.relPath !== forgedPrimary &&
    recForged.relPath.includes(Tools.shortRunId(RUN_C)),
    `forged preoccupation diverts within the run namespace, never claimed: ${JSON.stringify(recForged)}`);
  assert(fs.readFileSync(path.join(wdir, forgedPrimary), 'utf8') === 'FORGED-JUNK',
    'forged file must stay untouched');
  assert(fs.readFileSync(path.join(wdir, recForged.relPath), 'utf8') === 'new-output',
    'new output must land in the attempt-owned fallback');
  // Forged worker-owned preoccupation (junk already present at the
  // pre-launch reservation, with a RECENT mtime the old timestamp-only
  // check would have claimed) is never attributed to the new run. The
  // reservation diverts to the attempt's own clean fallback; the forged
  // primary is never examined, never claimed, never overwritten.
  const RUN_D = 'run_dddddddddddddddd';
  const codexPrimary = Tools.lastMessageRelPathForAttempt('codex', 1, RUN_D);
  await fsp.writeFile(path.join(wdir, codexPrimary), 'STALE-JUNK');
  fs.utimesSync(path.join(wdir, codexPrimary), new Date(), new Date());
  const resD = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN_D);
  assert(resD.absentAtReserve === true && resD.relPath !== codexPrimary,
    `reservation must divert from the preoccupied primary to a clean fallback: ${JSON.stringify(resD)}`);
  await fsp.writeFile(path.join(wdir, resD.relPath), 'worker wrote this after a clean reserve');
  const recDiverted = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN_D, new Date().toISOString(), resD);
  assert(recDiverted.provenance === 'worker' && recDiverted.relPath === resD.relPath,
    `clean reserved fallback binds the worker verdict: ${JSON.stringify(recDiverted)}`);
  assert(fs.readFileSync(path.join(wdir, codexPrimary), 'utf8') === 'STALE-JUNK',
    'forged primary stays untouched (recent mtime included: never claimed, never overwritten)');
  // Every bounded candidate preoccupied: the reservation extends within
  // the same run+attempt namespace (never overwrites a foreign file).
  const RUN_F = 'run_ffffffffffffffff';
  const forgedAll = [Tools.lastMessageRelPathForAttempt('codex', 1, RUN_F),
    ...Tools.attemptArtifactFallbackPaths('codex', 1, RUN_F)];
  for (const rel of forgedAll) {
    await fsp.writeFile(path.join(wdir, rel), 'FORGED');
    fs.utimesSync(path.join(wdir, rel), new Date(), new Date());
  }
  const resF = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN_F);
  assert(resF.absentAtReserve === true && !forgedAll.includes(resF.relPath) && resF.relPath.includes(Tools.shortRunId(RUN_F)),
    `fully forged bounded namespace extends within its own run namespace, never overwrites: ${JSON.stringify(resF)}`);
  // Every extended candidate preoccupied too: the reservation reports
  // preoccupied and finalize records unavailable with a reason.
  for (let i = 4; i <= 9; i += 1) {
    const dot = forgedAll[0].lastIndexOf('.');
    const stem = forgedAll[0].slice(0, dot);
    const ext = forgedAll[0].slice(dot);
    const rel = `${stem}-x${i}${ext}`;
    await fsp.writeFile(path.join(wdir, rel), 'FORGED');
    fs.utimesSync(path.join(wdir, rel), new Date(), new Date());
  }
  const resG = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN_F);
  assert(resG.absentAtReserve === false, `fully preoccupied namespace reserves preoccupied: ${JSON.stringify(resG)}`);
  const recStale = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN_F, new Date().toISOString(), resG);
  assert(recStale.created === false && recStale.provenance === 'unavailable' && /preoccupied/.test(recStale.reason ?? ''),
    `fully preoccupied namespace records unavailable, never bound (recent mtimes included): ${JSON.stringify(recStale)}`);
  const descStale = Tools.describeAttemptArtifact(wdir, 'codex', 1, recStale);
  assert(descStale.status === 'unavailable' && /preoccupied/.test(descStale.reason ?? ''),
    `pre-existing file reads unavailable with a reason: ${JSON.stringify(descStale)}`);
  // A worker write with NO reservation is unavailable too: a timestamp
  // alone is never proof of ownership.
  const recNoRes = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN_D, new Date().toISOString(), null);
  assert(recNoRes.created === false && recNoRes.provenance === 'unavailable' && /reservation/.test(recNoRes.reason ?? ''),
    `missing ownership reservation must fail closed: ${JSON.stringify(recNoRes)}`);
  // A genuine worker write binds the worker verdict ONLY through the
  // reservation: reserve (absent) BEFORE the write, then finalize.
  const RUN_E = 'run_eeeeeeeeeeeeeeee';
  const resE = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN_E);
  assert(resE.absentAtReserve === true, `clean slot must reserve absent: ${JSON.stringify(resE)}`);
  const codexPrimaryE = Tools.lastMessageRelPathForAttempt('codex', 1, RUN_E);
  assert(resE.relPath === codexPrimaryE, 'a clean primary reserves the primary itself');
  await fsp.writeFile(path.join(wdir, codexPrimaryE), 'worker wrote this during the attempt');
  const recWorker = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN_E, new Date().toISOString(), resE);
  assert(recWorker.provenance === 'worker' && recWorker.created === false,
    `worker-written run-bound file binds the worker verdict: ${JSON.stringify(recWorker)}`);
  const descWorker = Tools.describeAttemptArtifact(wdir, 'codex', 1, recWorker);
  assert(descWorker.status === 'present' && descWorker.path === codexPrimaryE,
    `worker verdict reads present: ${JSON.stringify(descWorker)}`);
  // No run identity: fail closed, never a legacy shared write.
  const recNoRun = Tools.persistAttemptArtifact(wdir, 'opencode', 1, 'x');
  assert(recNoRun.created === false && recNoRun.provenance === 'unavailable',
    `missing run identity must fail closed: ${JSON.stringify(recNoRun)}`);
  console.log('ok: D2 unit (run-bound per-(run,attempt) paths, O_EXCL incl. preoccupied nonempty, provenance-bound reads)');
}

// ---------- unit D1: exited root with surviving descendant ----------
{
  const root = spawn('bash', ['-c', 'sleep 60 & echo CHILD:$!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let childLine = '';
  const childPid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shim root never reported its child')), 5000);
    root.stdout.on('data', (chunk) => {
      childLine += chunk.toString();
      const m = childLine.match(/CHILD:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    root.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, 300));
  const baseline = Engines.readProcessStartTime(root.pid);
  assert(typeof baseline === 'string' && baseline, 'root starttime baseline must be readable while alive');
  const discovered = Engines.collectOwnedTree(root.pid, baseline);
  assert(!discovered.staleRoot, 'live root must verify (non-stale enumeration)');
  const known = [...discovered.baselines.entries()].map(([pid, startTime]) => ({ pid, startTime }));
  assert(known.length >= 1, 'enumeration must capture member identities');
  process.kill(root.pid, 'SIGKILL');
  await new Promise((resolve) => root.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 200));
  assert(Engines.readProcessStartTime(childPid) !== null, 'descendant must survive the exited root (reparented)');
  const res = await Engines.cancelOwnedTree(root.pid, baseline, 500, known);
  assert(res.staleRoot === true, 'exited root must read stale');
  assert(res.cleanupFinished === false, 'stale root is NEVER proof of cleanup (must be false, not true)');
  assert(res.remaining.length > 0 && res.remaining.includes(childPid),
    `surviving descendant must be reported remaining, got ${JSON.stringify(res.remaining)}`);
  const resBare = await Engines.cancelOwnedTree(root.pid, baseline, 200);
  assert(resBare.cleanupFinished === false && resBare.remaining.length === 0,
    'stale root without known members stays incomplete with empty remaining (never success)');
  const liveStart = Engines.readProcessStartTime(childPid);
  assert(Engines.aliveTreeMembers([{ pid: childPid, startTime: liveStart }]).includes(childPid),
    'same PID+starttime identity matches');
  assert(Engines.aliveTreeMembers([{ pid: childPid, startTime: '0' }]).length === 0,
    'a mismatched starttime never matches (recycled-PID guard)');
  process.kill(childPid, 'SIGKILL');
  console.log('ok: D1 unit (exited root + surviving descendant -> incomplete + non-empty remaining; stale never success)');
}

// ---------- MCP wiring: fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-ca-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;

const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-ca-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-ca-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-ca-shim-'));
const counterFile = path.join(shimBin, 'counter.txt');
await fsp.writeFile(counterFile, '0');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
// Counter shim: every `run` turn prints a DISTINCT marker (proves which
// attempt produced which output); --version stays a read-only probe.
const ocCounter = await fake('opencode',
  `if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\nCTR=${counterFile}\nn=$(cat "$CTR" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "$CTR"\necho "OUTPUT-MARKER-$n"\nexit 0`);
process.env.CODEXPRO_OPENCODE_BIN = ocCounter;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-ca-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'cancel-artifact-smoke', version: '1' }, { capabilities: {} });
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

const findRunFile = (dir, runId) => {
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const hit = walk(p); if (hit) return hit; }
      else if (e.name === `${runId}.json`) return p;
    }
    return null;
  };
  return walk(dir);
};

const OC_TASK = 'Report readiness. Change nothing.';

// ---------- MCP D1: pid-less uncertain-dispatch cancel stays incomplete ----------
{
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'ca-uncertain', task: OC_TASK, delegation_group: 'team-cancel-artifact',
    request_id: 'req-ca-uncertain', timeout_ms: 60000
  });
  assert(!launched.isError, `shim run must launch: ${JSON.stringify(launched.structuredContent)}`);
  const runId = launched.structuredContent.run_id;
  await waitSettled(runId);
  const runFile = findRunFile(delegHome, runId);
  assert(runFile, 'run file must be locatable under the delegation dir');
  // Forge the crash-before-save shape: pid-less pending launch, no observed
  // failure marker, non-terminal. The orphan may exist; retry must fail
  // closed and cancel must stay unverified.
  const forged = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  forged.state = 'running';
  forged.attempts = [{
    n: 1, startedAt: new Date().toISOString(), state: 'queued',
    continuation: 'new-continuation-attempt',
    summary: 'pending dispatch for request req-ca-uncertain'
  }];
  forged.pendingDispatch = {
    checkpointId: forged.requestId, requestId: forged.requestId, seq: 0, payload: {},
    attemptN: 1, continuation: 'new-continuation-attempt',
    timeoutMs: 60000, prompt: 'x', sessionEvidence: 'x',
    storedAt: new Date().toISOString(), state: 'pending-dispatch', isLaunch: true
  };
  delete forged.result;
  forged.nextAction = 'uncertain (forged for the regression proof)';
  fs.writeFileSync(runFile, `${JSON.stringify(forged, null, 2)}\n`);
  const cancel = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assert(!cancel.isError, `cancel must ack (not error): ${JSON.stringify(cancel.structuredContent)}`);
  assert(cancel.structuredContent.state === 'cancelled', 'cancel still transitions the run to cancelled');
  assert(cancel.structuredContent.cleanup_finished === false,
    `pid-less uncertain cancel must stay incomplete, never success: ${JSON.stringify(cancel.structuredContent)}`);
  assert(cancel.structuredContent.cancel_verification.verification_complete === false,
    'unverified cancel must not verify complete');
  assert(cancel.structuredContent.cancel_verification.pid_tree.ownership_verified === false,
    'ownership must read unverified (missing pid is never proof)');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError && read.structuredContent.last_cancel_verification.cleanupFinished === false,
    `persisted verification must stay incomplete: ${JSON.stringify(read.structuredContent.last_cancel_verification)}`);
  // Repeat cancel: re-verifies live, still incomplete (never cached success).
  const repeat = await call('delegation_cancel', { workspace_id: wid, run_id: runId });
  assert(!repeat.isError && repeat.structuredContent.cleanup_finished === false &&
    repeat.structuredContent.cancel_verification.verification_complete === false,
    `repeat cancel must stay incomplete too: ${JSON.stringify(repeat.structuredContent)}`);
  console.log('ok: D1 MCP (pid-less uncertain-dispatch cancel stays uncertain/incomplete, repeat included)');
}

// ---------- MCP D2a: continuation cannot surface the first attempt's output ----------
{
  const o1 = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'ca-cont', task: OC_TASK, delegation_group: 'team-cancel-artifact',
    request_id: 'req-ca-cont', timeout_ms: 60000
  });
  assert(!o1.isError, `continuation run must launch: ${JSON.stringify(o1.structuredContent)}`);
  const runId = o1.structuredContent.run_id;
  await waitSettled(runId);
  const wd = path.join(wsRoot, 'ca-cont');
  const a1Rel = Tools.lastMessageRelPathForAttempt('opencode', 1, runId);
  assert(!fs.existsSync(path.join(wd, 'opencode-last-message.json')),
    'no legacy shared artifact may be created for a new run');
  assert(fs.existsSync(path.join(wd, a1Rel)), `attempt 1 must persist its run-bound artifact: ${a1Rel}`);
  const a1content = fs.readFileSync(path.join(wd, a1Rel), 'utf8');
  assert(a1content.includes('OUTPUT-MARKER-'), `attempt 1 artifact must carry its marker: ${JSON.stringify(a1content)}`);
  const q = await call('delegation_followup', {
    workspace_id: wid, run_id: runId,
    checkpoint: { id: 'caq1', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'caqq', question: 'Proceed?' }] }
  });
  assert(!q.isError && q.structuredContent.state === 'needs-input', 'question must move to needs-input');
  const a = await call('delegation_followup', {
    workspace_id: wid, run_id: runId,
    checkpoint: { id: 'caa1', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'caq1' }
  });
  assert(!a.isError && a.structuredContent.executed === true && a.structuredContent.attempt_n === 2,
    `answer must dispatch attempt 2: ${JSON.stringify(a.structuredContent)}`);
  await waitSettled(runId);
  const a2Rel = Tools.lastMessageRelPathForAttempt('opencode', 2, runId);
  assert(a2Rel !== a1Rel, 'continuation artifact must bind the new attempt number as well as the run');
  assert(fs.existsSync(path.join(wd, a2Rel)), `attempt 2 must persist its OWN run-bound artifact path: ${a2Rel}`);
  const a2content = fs.readFileSync(path.join(wd, a2Rel), 'utf8');
  assert(a2content.includes('OUTPUT-MARKER-') && a2content !== a1content,
    `attempt 2 artifact must carry only its own output: ${JSON.stringify(a2content)} vs ${JSON.stringify(a1content)}`);
  assert(fs.readFileSync(path.join(wd, a1Rel), 'utf8') === a1content,
    'attempt 1 artifact must be untouched by attempt 2 (never overwritten)');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError, 'read must succeed');
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'present' && lm.path === a2Rel && lm.attempt_n === 2,
    `read must surface ONLY the current attempt artifact with provenance: ${JSON.stringify(lm)}`);
  const tail = read.structuredContent.result.stdoutTail ?? '';
  assert(tail.includes(a2content.trim()) && !tail.includes(a1content.trim()),
    `current result tails must be attempt 2 output, never attempt 1 output: ${JSON.stringify(tail)}`);
  console.log('ok: D2a MCP (second attempt cannot surface first attempt output; provenance attempt_n=2)');
}

// ---------- MCP D2b: pre-existing empty artifact is never overwritten ----------
{
  const preDir = path.join(wsRoot, 'ca-preocc');
  fs.mkdirSync(preDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(preDir, 'opencode-last-message.json'), '');
  const o2 = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'ca-preocc', task: OC_TASK, delegation_group: 'team-cancel-artifact',
    request_id: 'req-ca-preocc', timeout_ms: 60000
  });
  assert(!o2.isError, `preoccupied run must launch: ${JSON.stringify(o2.structuredContent)}`);
  const runId = o2.structuredContent.run_id;
  await waitSettled(runId);
  assert(fs.statSync(path.join(preDir, 'opencode-last-message.json')).size === 0,
    'pre-existing empty artifact must stay empty (never a slot to fill)');
  const ownRel = Tools.lastMessageRelPathForAttempt('opencode', 1, runId);
  assert(ownRel !== 'opencode-last-message.json', 'the new attempt must bind its run, never the legacy shared name');
  assert(fs.existsSync(path.join(preDir, ownRel)), `new attempt must write its own run-bound path: ${ownRel}`);
  const ownContent = fs.readFileSync(path.join(preDir, ownRel), 'utf8');
  assert(ownContent.includes('OUTPUT-MARKER-'), 'owned path must carry the worker output');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError, 'read must succeed');
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'present' && lm.path === ownRel && lm.attempt_n === 1,
    `read must surface the attempt-owned file with provenance: ${JSON.stringify(lm)}`);
  const legacy = Tools.describeLastMessageArtifact(preDir, 'opencode');
  assert(legacy.status === 'unavailable' && !('path' in legacy) && /never proves/.test(legacy.reason ?? ''),
    `the gated legacy lookup never presents a foreign file as present: ${JSON.stringify(legacy)}`);
  console.log('ok: D2b MCP (empty preoccupied file untouched + unavailable; new attempt writes own path)');
}

console.log('delegation-cancel-artifact-smoke: PASS (no live model calls; fake-binary results labeled shim)');
