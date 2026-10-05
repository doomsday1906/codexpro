#!/usr/bin/env node
// Defect A adapter regressions: run_id + attempt artifact binding through
// the delegation_launch / delegation_read_result / delegation_followup
// handlers (helper-only unit tests are insufficient for these paths).
//
// A1 shared-workdir isolation: two runs in ONE caller-chosen workdir plus
//   one continuation each stay fully isolated (four distinct run-bound
//   artifacts; each read surfaces only its own current attempt; no
//   cross-attribution; no legacy shared file ever created).
// A2 preoccupied EMPTY legacy file: unavailable, never filled/claimed (the
//   legacy file stays empty; the new run writes its own run-bound file and
//   reads present from it; a provenance-free lookup reads unavailable).
// A3 preoccupied NONEMPTY legacy file: unavailable + reason, never claimed
//   as new-run output (the junk stays intact; the new run writes + reads
//   its own run-bound file, never the legacy path).
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs, fake binaries via CODEXPRO_*_BIN (all fake-binary
// results labeled shim).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));

// ---------- MCP wiring: fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-iso-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;

const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-iso-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-iso-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-iso-shim-'));
const counterFile = path.join(shimBin, 'counter.txt');
await fsp.writeFile(counterFile, '0');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
// Counter shim: every turn prints a DISTINCT marker (proves which
// run/attempt produced which artifact); --version stays a read-only probe.
const ocCounter = await fake('opencode',
  `if [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nif [ "$1" != "run" ]; then exit 1; fi\nCTR=${counterFile}\nn=$(cat "$CTR" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "$CTR"\necho "OUTPUT-MARKER-$n"\nexit 0`);
process.env.CODEXPRO_OPENCODE_BIN = ocCounter;
// Codex counter shim: every turn writes a DISTINCT marker to the exact
// --output-last-message file (proves which run/attempt produced which
// artifact). Handles exec AND exec resume (both carry
// --output-last-message); --version stays a read-only probe. All
// fake-binary results are labeled shim via CODEXPRO_CODEX_BIN.
const codexCounterFile = path.join(shimBin, 'codex-counter.txt');
await fsp.writeFile(codexCounterFile, '0');
const codexCounter = await fake('codex-counter',
  `if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\nif [ "$1" != "exec" ]; then exit 1; fi\nOUT="";PREV="";for A in "$@"; do if [ "$PREV" = "--output-last-message" ]; then OUT="$A"; fi;PREV="$A"; done\nif [ -z "$OUT" ]; then echo "missing --output-last-message" >&2; exit 1; fi\nCTR=${codexCounterFile}\nn=$(cat "$CTR" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "$CTR"\necho "CODEX-MARKER-$n" > "$OUT"\nexit 0`);
process.env.CODEXPRO_CODEX_BIN = codexCounter;
// Codex no-output shim: exits successfully WITHOUT producing any output
// file (the unavailable path, never present).
const codexSilent = await fake('codex-silent',
  'if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\nif [ "$1" != "exec" ]; then exit 1; fi\nexit 0');
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-iso-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'artifact-isolation-smoke', version: '1' }, { capabilities: {} });
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

const OC_TASK = 'Report readiness. Change nothing.';
const bound = (runId, n) => Tools.lastMessageRelPathForAttempt('opencode', 1 + (n - 1), runId);

// ---------- A1: two runs sharing one workdir + continuations stay isolated ----------
{
  const wd = path.join(wsRoot, 'shared-wd');
  const r1 = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'shared-wd', task: OC_TASK, delegation_group: 'team-artifact-isolation',
    request_id: 'req-iso-r1', timeout_ms: 60000
  });
  assert(!r1.isError, `run 1 must launch: ${JSON.stringify(r1.structuredContent)}`);
  const run1 = r1.structuredContent.run_id;
  await waitSettled(run1);
  const r2 = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'shared-wd', task: OC_TASK, delegation_group: 'team-artifact-isolation',
    request_id: 'req-iso-r2', timeout_ms: 60000
  });
  assert(!r2.isError, `run 2 must launch into the SAME workdir: ${JSON.stringify(r2.structuredContent)}`);
  const run2 = r2.structuredContent.run_id;
  assert(run2 !== run1, 'the two runs must have distinct ids');
  await waitSettled(run2);
  const rel1a = bound(run1, 1);
  const rel2a = bound(run2, 1);
  assert(rel1a !== rel2a, `attempt suffix alone is insufficient: ${rel1a} vs ${rel2a}`);
  assert(!fs.existsSync(path.join(wd, 'opencode-last-message.json')),
    'no legacy shared artifact may be created for new runs');
  assert(fs.existsSync(path.join(wd, rel1a)) && fs.existsSync(path.join(wd, rel2a)),
    `both run-bound attempt-1 artifacts must exist: ${rel1a}, ${rel2a}`);
  const c1a = fs.readFileSync(path.join(wd, rel1a), 'utf8');
  const c2a = fs.readFileSync(path.join(wd, rel2a), 'utf8');
  assert(c1a.includes('OUTPUT-MARKER-') && c2a.includes('OUTPUT-MARKER-') && c1a !== c2a,
    `each artifact must carry only its own output: ${JSON.stringify(c1a)} vs ${JSON.stringify(c2a)}`);
  const read1 = await call('delegation_read_result', { workspace_id: wid, run_id: run1 });
  const read2 = await call('delegation_read_result', { workspace_id: wid, run_id: run2 });
  assert(read1.structuredContent.test_evidence.last_message.path === rel1a &&
    read1.structuredContent.test_evidence.last_message.status === 'present',
    `run 1 must surface only its own artifact: ${JSON.stringify(read1.structuredContent.test_evidence.last_message)}`);
  assert(read2.structuredContent.test_evidence.last_message.path === rel2a &&
    read2.structuredContent.test_evidence.last_message.status === 'present',
    `run 2 must surface only its own artifact: ${JSON.stringify(read2.structuredContent.test_evidence.last_message)}`);
  // One continuation each: four artifacts, still no cross-attribution.
  for (const [runId, tag] of [[run1, 'iso1'], [run2, 'iso2']]) {
    const q = await call('delegation_followup', {
      workspace_id: wid, run_id: runId,
      checkpoint: { id: `${tag}q1`, run_id: runId, seq: 0, payload: {}, questions: [{ id: `${tag}qq`, question: 'Proceed?' }] }
    });
    assert(!q.isError && q.structuredContent.state === 'needs-input', `question must move ${runId} to needs-input`);
    const a = await call('delegation_followup', {
      workspace_id: wid, run_id: runId,
      checkpoint: { id: `${tag}a1`, run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: `${tag}q1` }
    });
    assert(!a.isError && a.structuredContent.executed === true && a.structuredContent.attempt_n === 2,
      `answer must dispatch attempt 2 for ${runId}: ${JSON.stringify(a.structuredContent)}`);
    await waitSettled(runId);
  }
  const rel1b = bound(run1, 2);
  const rel2b = bound(run2, 2);
  for (const rel of [rel1a, rel1b, rel2a, rel2b]) assert(fs.existsSync(path.join(wd, rel)), `all four run-bound artifacts must exist: ${rel}`);
  assert(new Set([rel1a, rel1b, rel2a, rel2b]).size === 4, 'all four artifact paths must be distinct');
  const contents = [rel1a, rel1b, rel2a, rel2b].map((rel) => fs.readFileSync(path.join(wd, rel), 'utf8'));
  assert(new Set(contents).size === 4 && contents.every((c) => c.includes('OUTPUT-MARKER-')),
    'each of the four artifacts must carry only its own distinct output');
  assert(fs.readFileSync(path.join(wd, rel1a), 'utf8') === c1a && fs.readFileSync(path.join(wd, rel2a), 'utf8') === c2a,
    'attempt-1 artifacts must be untouched by the continuations (never overwritten)');
  const reread1 = await call('delegation_read_result', { workspace_id: wid, run_id: run1 });
  const reread2 = await call('delegation_read_result', { workspace_id: wid, run_id: run2 });
  assert(reread1.structuredContent.test_evidence.last_message.path === rel1b &&
    reread1.structuredContent.test_evidence.last_message.attempt_n === 2,
    `run 1 must now surface only its attempt-2 artifact: ${JSON.stringify(reread1.structuredContent.test_evidence.last_message)}`);
  assert(reread2.structuredContent.test_evidence.last_message.path === rel2b &&
    reread2.structuredContent.test_evidence.last_message.attempt_n === 2,
    `run 2 must now surface only its attempt-2 artifact: ${JSON.stringify(reread2.structuredContent.test_evidence.last_message)}`);
  console.log('ok: A1 MCP (two runs sharing one workdir + continuations stay isolated; no cross-attribution)');
}

// ---------- A2: preoccupied EMPTY legacy file -> unavailable, never filled/claimed ----------
{
  const preDir = path.join(wsRoot, 'preocc-empty');
  fs.mkdirSync(preDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(preDir, 'opencode-last-message.json'), '');
  const o = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'preocc-empty', task: OC_TASK, delegation_group: 'team-artifact-isolation',
    request_id: 'req-iso-preocc-empty', timeout_ms: 60000
  });
  assert(!o.isError, `preoccupied run must launch: ${JSON.stringify(o.structuredContent)}`);
  const runId = o.structuredContent.run_id;
  await waitSettled(runId);
  assert(fs.statSync(path.join(preDir, 'opencode-last-message.json')).size === 0,
    'pre-existing empty legacy file must stay empty (never a slot to fill, never claimed)');
  const ownRel = Tools.lastMessageRelPathForAttempt('opencode', 1, runId);
  assert(ownRel !== 'opencode-last-message.json', 'the new attempt must bind its run, never the legacy shared name');
  assert(fs.existsSync(path.join(preDir, ownRel)), `new attempt must write its own run-bound path: ${ownRel}`);
  assert(fs.readFileSync(path.join(preDir, ownRel), 'utf8').includes('OUTPUT-MARKER-'),
    'owned run-bound path must carry the worker output');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'present' && lm.path === ownRel && lm.attempt_n === 1,
    `read must surface the attempt-owned file with provenance: ${JSON.stringify(lm)}`);
  const noProv = Tools.describeAttemptArtifact(preDir, 'opencode', 1);
  assert(noProv.status === 'unavailable',
    `provenance-free lookup reads unavailable, never the preoccupied file: ${JSON.stringify(noProv)}`);
  console.log('ok: A2 MCP (preoccupied empty file unavailable + untouched; new run writes + reads its own run-bound file)');
}

// ---------- A3: preoccupied NONEMPTY legacy file -> unavailable + reason, never claimed ----------
{
  const preDir = path.join(wsRoot, 'preocc-junk');
  fs.mkdirSync(preDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(preDir, 'opencode-last-message.json'), 'JUNK-FROM-ANOTHER-RUN');
  const o = await call('delegation_launch', {
    workspace_id: wid, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: 'preocc-junk', task: OC_TASK, delegation_group: 'team-artifact-isolation',
    request_id: 'req-iso-preocc-junk', timeout_ms: 60000
  });
  assert(!o.isError, `junk-preoccupied run must launch: ${JSON.stringify(o.structuredContent)}`);
  const runId = o.structuredContent.run_id;
  await waitSettled(runId);
  assert(fs.readFileSync(path.join(preDir, 'opencode-last-message.json'), 'utf8') === 'JUNK-FROM-ANOTHER-RUN',
    'pre-existing nonempty legacy file must stay intact (never overwritten, never claimed)');
  const ownRel = Tools.lastMessageRelPathForAttempt('opencode', 1, runId);
  assert(fs.existsSync(path.join(preDir, ownRel)), `new attempt must write its own run-bound path: ${ownRel}`);
  const ownContent = fs.readFileSync(path.join(preDir, ownRel), 'utf8');
  assert(ownContent.includes('OUTPUT-MARKER-') && ownContent !== 'JUNK-FROM-ANOTHER-RUN',
    'owned run-bound path must carry only this run output');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'present' && lm.path === ownRel && lm.attempt_n === 1,
    `read must surface the attempt-owned file, never the preoccupied junk: ${JSON.stringify(lm)}`);
  const noProv = Tools.describeAttemptArtifact(preDir, 'opencode', 1);
  assert(noProv.status === 'unavailable' && (noProv.reason ?? '').length > 0,
    `provenance-free lookup is unavailable with a reason: ${JSON.stringify(noProv)}`);
  const unprovenRecord = Tools.describeAttemptArtifact(preDir, 'opencode', 1, { relPath: 'opencode-last-message.json', created: false });
  assert(unprovenRecord.status === 'unavailable' && /without this run/.test(unprovenRecord.reason ?? ''),
    `pre-existing file without a creation verdict is never claimed: ${JSON.stringify(unprovenRecord)}`);
  console.log('ok: A3 MCP (preoccupied nonempty file unavailable + reason + intact; new run writes + reads its own run-bound file)');
}

// ---------- X0: the finding's colliding pair binds distinct artifacts (helper-level) ----------
// run_000000001234abcd and run_ffffffff1234abcd share the trailing 8 hex
// yet must never cross-attribute. OpenCode-only handler tests do NOT
// qualify the Codex path, so the Codex binding is proven here plus X1-X4
// through the launch/read/followup handlers below.
{
  const C1 = 'run_000000001234abcd';
  const C2 = 'run_ffffffff1234abcd';
  assert(Tools.isValidRunIdForArtifact(C1) && Tools.isValidRunIdForArtifact(C2), 'both colliding ids validate');
  const p1 = Tools.lastMessageRelPathForAttempt('codex', 1, C1);
  const p2 = Tools.lastMessageRelPathForAttempt('codex', 1, C2);
  assert(p1 !== p2, `colliding ids bind distinct Codex artifacts: ${p1} vs ${p2}`);
  const f1 = Tools.attemptArtifactFallbackPaths('codex', 1, C1);
  const f2 = Tools.attemptArtifactFallbackPaths('codex', 1, C2);
  assert(f1.every((f) => !f2.includes(f) && f !== p2) && f2.every((f) => f !== p1),
    'colliding fallbacks stay within their own run namespace too');
  const xdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-iso-collide-'));
  // Forge junk at C1's exact primary, then run the reservation flow for
  // BOTH ids: C1 must divert within its own namespace (junk untouched,
  // never claimed without a clean reserve); C2 must be unaffected (its
  // own primary is clean and binds the worker verdict).
  await fsp.writeFile(path.join(xdir, p1), 'FORGED-C1-JUNK');
  const noRes1 = Tools.persistAttemptArtifact(xdir, 'codex', 1, null, C1, new Date().toISOString(), null);
  assert(noRes1.created === false && noRes1.provenance === 'unavailable',
    `C1 without a reservation is unavailable (timestamp alone never binds): ${JSON.stringify(noRes1)}`);
  const res1 = Tools.reserveAttemptArtifactPath(xdir, 'codex', 1, C1);
  assert(res1.absentAtReserve === true && res1.relPath !== p1,
    `C1 reserves a clean fallback, never the forged primary: ${JSON.stringify(res1)}`);
  await fsp.writeFile(path.join(xdir, res1.relPath), 'C1 worker output');
  const w1 = Tools.persistAttemptArtifact(xdir, 'codex', 1, null, C1, new Date().toISOString(), res1);
  assert(w1.provenance === 'worker' && w1.relPath === res1.relPath, `C1 binds only its reserved fallback: ${JSON.stringify(w1)}`);
  const res2 = Tools.reserveAttemptArtifactPath(xdir, 'codex', 1, C2);
  assert(res2.absentAtReserve === true && res2.relPath === p2, `C2 reserves its own clean primary: ${JSON.stringify(res2)}`);
  await fsp.writeFile(path.join(xdir, p2), 'C2 worker output');
  const w2 = Tools.persistAttemptArtifact(xdir, 'codex', 1, null, C2, new Date().toISOString(), res2);
  assert(w2.provenance === 'worker' && w2.relPath === p2, `C2 binds only its own artifact: ${JSON.stringify(w2)}`);
  const d1 = Tools.describeAttemptArtifact(xdir, 'codex', 1, w1);
  const d2 = Tools.describeAttemptArtifact(xdir, 'codex', 1, w2);
  assert(d1.status === 'present' && d1.path === res1.relPath, 'C1 surfaces only its reserved fallback');
  assert(d2.status === 'present' && d2.path === p2, 'C2 surfaces only its own artifact (no cross-attribution)');
  assert(d1.path !== d2.path, 'the colliding pair never shares an artifact');
  assert(fs.readFileSync(path.join(xdir, p1), 'utf8') === 'FORGED-C1-JUNK', 'forged C1 file stays untouched');
  console.log('ok: X0 helper (colliding run ids bind distinct Codex artifacts; no cross-attribution)');
}

// Codex handler-level isolation through delegation_launch /
// delegation_read_result / delegation_followup (canary slice, Luna profile
// CODEX_SCOUT_FAST; counter shim writes distinct markers).
const codexBound = (runId, n) => Tools.lastMessageRelPathForAttempt('codex', n, runId);
const launchCodexCanary = async (workdir, requestId) => {
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
    workdir, canary: true, delegation_group: 'hestia-cli-canary',
    request_id: requestId, timeout_ms: 60000
  });
  assert(!launched.isError, `codex canary must launch: ${JSON.stringify(launched.structuredContent)}`);
  return launched.structuredContent.run_id;
};

// ---------- X1: two Codex runs sharing one workdir + continuations (4 isolated artifacts) ----------
{
  const wd = path.join(wsRoot, 'shared-wd-codex');
  const run1 = await launchCodexCanary('shared-wd-codex', 'req-iso-cx1');
  await waitSettled(run1);
  const run2 = await launchCodexCanary('shared-wd-codex', 'req-iso-cx2');
  assert(run2 !== run1, 'the two Codex runs must have distinct ids');
  await waitSettled(run2);
  const rel1a = codexBound(run1, 1);
  const rel2a = codexBound(run2, 1);
  assert(rel1a !== rel2a, `distinct runs bind distinct files: ${rel1a} vs ${rel2a}`);
  assert(!fs.existsSync(path.join(wd, 'codex-last-message.md')),
    'no legacy shared Codex artifact may be created for new runs');
  assert(fs.existsSync(path.join(wd, rel1a)) && fs.existsSync(path.join(wd, rel2a)),
    `both Codex run-bound attempt-1 artifacts must exist: ${rel1a}, ${rel2a}`);
  const c1a = fs.readFileSync(path.join(wd, rel1a), 'utf8');
  const c2a = fs.readFileSync(path.join(wd, rel2a), 'utf8');
  assert(c1a.includes('CODEX-MARKER-') && c2a.includes('CODEX-MARKER-') && c1a !== c2a,
    'each Codex artifact must carry only its own output');
  const read1 = await call('delegation_read_result', { workspace_id: wid, run_id: run1 });
  const read2 = await call('delegation_read_result', { workspace_id: wid, run_id: run2 });
  assert(read1.structuredContent.test_evidence.last_message.path === rel1a &&
    read1.structuredContent.test_evidence.last_message.status === 'present',
    `run 1 must surface only its own artifact: ${JSON.stringify(read1.structuredContent.test_evidence.last_message)}`);
  assert(read2.structuredContent.test_evidence.last_message.path === rel2a &&
    read2.structuredContent.test_evidence.last_message.status === 'present',
    `run 2 must surface only its own artifact: ${JSON.stringify(read2.structuredContent.test_evidence.last_message)}`);
  for (const [runId, tag] of [[run1, 'isocx1'], [run2, 'isocx2']]) {
    const q = await call('delegation_followup', {
      workspace_id: wid, run_id: runId,
      checkpoint: { id: `${tag}q1`, run_id: runId, seq: 0, payload: {}, questions: [{ id: `${tag}qq`, question: 'Proceed?' }] }
    });
    assert(!q.isError && q.structuredContent.state === 'needs-input', `question must move ${runId} to needs-input`);
    const a = await call('delegation_followup', {
      workspace_id: wid, run_id: runId,
      checkpoint: { id: `${tag}a1`, run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: `${tag}q1` }
    });
    assert(!a.isError && a.structuredContent.executed === true && a.structuredContent.attempt_n === 2,
      `answer must dispatch Codex attempt 2 for ${runId}: ${JSON.stringify(a.structuredContent)}`);
    await waitSettled(runId);
  }
  const rel1b = codexBound(run1, 2);
  const rel2b = codexBound(run2, 2);
  for (const rel of [rel1a, rel1b, rel2a, rel2b]) assert(fs.existsSync(path.join(wd, rel)), `all four Codex artifacts must exist: ${rel}`);
  assert(new Set([rel1a, rel1b, rel2a, rel2b]).size === 4, 'all four Codex artifact paths must be distinct');
  const contents = [rel1a, rel1b, rel2a, rel2b].map((rel) => fs.readFileSync(path.join(wd, rel), 'utf8'));
  assert(new Set(contents).size === 4 && contents.every((c) => c.includes('CODEX-MARKER-')),
    'each of the four Codex artifacts must carry only its own distinct output');
  assert(fs.readFileSync(path.join(wd, rel1a), 'utf8') === c1a && fs.readFileSync(path.join(wd, rel2a), 'utf8') === c2a,
    'Codex attempt-1 artifacts must be untouched by the continuations (never overwritten; earlier attempts preserved)');
  const reread1 = await call('delegation_read_result', { workspace_id: wid, run_id: run1 });
  const reread2 = await call('delegation_read_result', { workspace_id: wid, run_id: run2 });
  assert(reread1.structuredContent.test_evidence.last_message.path === rel1b &&
    reread1.structuredContent.test_evidence.last_message.attempt_n === 2,
    `run 1 must now surface only its attempt-2 artifact: ${JSON.stringify(reread1.structuredContent.test_evidence.last_message)}`);
  assert(reread2.structuredContent.test_evidence.last_message.path === rel2b &&
    reread2.structuredContent.test_evidence.last_message.attempt_n === 2,
    `run 2 must now surface only its attempt-2 artifact: ${JSON.stringify(reread2.structuredContent.test_evidence.last_message)}`);
  console.log('ok: X1 MCP Codex (two runs sharing one workdir + continuations stay isolated; no cross-attribution)');
}

// ---------- X2: Codex preoccupied EMPTY legacy file -> untouched, unclaimed; own run-bound file ----------
// ---------- X3: Codex preoccupied NONEMPTY legacy file (recent mtime) -> untouched, unclaimed ----------
for (const [tag, junk, req] of [['empty', '', 'req-iso-cx-preocc-empty'], ['junk-recent', 'JUNK-FROM-ANOTHER-RUN', 'req-iso-cx-preocc-junk']]) {
  const preDir = path.join(wsRoot, `preocc-codex-${tag}`);
  fs.mkdirSync(preDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(preDir, 'codex-last-message.md'), junk);
  // Recent mtime on the junk (the old timestamp-only check would have
  // claimed it): the reservation still observes preoccupation... but the
  // legacy name is not even in this run's namespace — it must stay
  // untouched and unclaimed regardless.
  const nowTs = new Date();
  fs.utimesSync(path.join(preDir, 'codex-last-message.md'), nowTs, nowTs);
  const runId = await launchCodexCanary(`preocc-codex-${tag}`, req);
  await waitSettled(runId);
  assert(fs.readFileSync(path.join(preDir, 'codex-last-message.md'), 'utf8') === junk,
    `pre-existing ${tag} legacy file must stay intact (never overwritten, never claimed)`);
  const ownRel = codexBound(runId, 1);
  assert(ownRel !== 'codex-last-message.md', 'the new Codex attempt must bind its run, never the legacy shared name');
  assert(fs.existsSync(path.join(preDir, ownRel)), `new Codex attempt must write its own run-bound path: ${ownRel}`);
  assert(fs.readFileSync(path.join(preDir, ownRel), 'utf8').includes('CODEX-MARKER-'),
    'owned run-bound path must carry the worker output');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'present' && lm.path === ownRel && lm.attempt_n === 1,
    `read must surface the attempt-owned file, never the preoccupied legacy file: ${JSON.stringify(lm)}`);
  console.log(`ok: X2/X3 MCP Codex (preoccupied ${tag} legacy file untouched + unclaimed incl. recent mtime; own run-bound file)`);
}

// ---------- X4: Codex worker that exits without producing output -> unavailable, not present ----------
{
  process.env.CODEXPRO_CODEX_BIN = codexSilent;
  const runId = await launchCodexCanary('silent-codex', 'req-iso-cx-silent');
  await waitSettled(runId);
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError, 'silent run must be readable');
  const lm = read.structuredContent.test_evidence.last_message;
  assert(lm.status === 'unavailable',
    `a worker that wrote nothing reports unavailable, never present: ${JSON.stringify(lm)}`);
  process.env.CODEXPRO_CODEX_BIN = codexCounter;
  console.log('ok: X4 MCP Codex (silent worker exits without output -> unavailable, not present)');
}

console.log('delegation-artifact-isolation-smoke: PASS (no live model calls; fake-binary results labeled shim)');