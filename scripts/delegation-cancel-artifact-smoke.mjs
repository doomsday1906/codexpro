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

// ---------- unit D1/D2: per-attempt paths + exclusive create ----------
{
  assert(Tools.lastMessageRelPathForAttempt('opencode', 1) === 'opencode-last-message.json',
    'attempt 1 keeps the legacy artifact name');
  assert(Tools.lastMessageRelPathForAttempt('opencode', 0) === 'opencode-last-message.json',
    'non-positive attempt numbers fall back to the legacy name');
  assert(Tools.lastMessageRelPathForAttempt('opencode', 2) === 'opencode-last-message-attempt-2.json',
    `attempt 2 gets its own file: ${Tools.lastMessageRelPathForAttempt('opencode', 2)}`);
  assert(Tools.lastMessageRelPathForAttempt('codex', 3) === 'codex-last-message-attempt-3.md',
    'codex attempts suffix before the extension');
  assert(Tools.lastMessageRelPathForAttempt('claude', 2) === 'claude-last-message-attempt-2.json',
    'claude attempts are per-attempt too');
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
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-artifact-preocc-'));
  await fsp.writeFile(path.join(wdir, 'opencode-last-message.json'), '');
  const rec = Tools.persistAttemptArtifact(wdir, 'opencode', 1, 'retained-output');
  assert(rec.created === true && rec.relPath === 'opencode-last-message-attempt-1.json',
    `preoccupied-empty primary must divert to the attempt's own path: ${JSON.stringify(rec)}`);
  assert(fs.statSync(path.join(wdir, 'opencode-last-message.json')).size === 0,
    'pre-existing empty file must stay empty');
  assert(fs.readFileSync(path.join(wdir, rec.relPath), 'utf8') === 'retained-output',
    'retained output must land in the attempt-owned fallback');
  const desc = Tools.describeAttemptArtifact(wdir, 'opencode', 1, rec.relPath);
  assert(desc.status === 'present' && desc.path === rec.relPath && desc.attempt_n === 1,
    `recorded provenance binds the read: ${JSON.stringify(desc)}`);
  const descLegacy = Tools.describeAttemptArtifact(wdir, 'opencode', 1);
  assert(descLegacy.status === 'unavailable',
    `the preoccupied legacy file reads unavailable, never a pass: ${JSON.stringify(descLegacy)}`);
  const descMissing = Tools.describeAttemptArtifact(wdir, 'opencode', 2);
  assert(descMissing.status === 'unavailable' && !('path' in descMissing) && descMissing.attempt_n === 2,
    `an attempt with no artifact reports unavailable with no path: ${JSON.stringify(descMissing)}`);
  console.log('ok: D2 unit (per-attempt paths, O_EXCL incl. empty preoccupation, provenance-bound reads)');
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
  const a1Rel = 'opencode-last-message.json';
  assert(fs.existsSync(path.join(wd, a1Rel)), 'attempt 1 must persist its legacy-named artifact');
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
  const a2Rel = 'opencode-last-message-attempt-2.json';
  assert(fs.existsSync(path.join(wd, a2Rel)), 'attempt 2 must persist its OWN artifact path');
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
  const ownRel = 'opencode-last-message-attempt-1.json';
  assert(fs.existsSync(path.join(preDir, ownRel)), 'new attempt must write its own path');
  const ownContent = fs.readFileSync(path.join(preDir, ownRel), 'utf8');
  assert(ownContent.includes('OUTPUT-MARKER-'), 'owned path must carry the worker output');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError, 'read must succeed');
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'present' && lm.path === ownRel && lm.attempt_n === 1,
    `read must surface the attempt-owned file with provenance: ${JSON.stringify(lm)}`);
  const legacy = Tools.describeLastMessageArtifact(preDir, 'opencode');
  assert(legacy.status === 'unavailable',
    `the preoccupied empty file reports unavailable: ${JSON.stringify(legacy)}`);
  console.log('ok: D2b MCP (empty preoccupied file untouched + unavailable; new attempt writes own path)');
}

console.log('delegation-cancel-artifact-smoke: PASS (no live model calls; fake-binary results labeled shim)');
