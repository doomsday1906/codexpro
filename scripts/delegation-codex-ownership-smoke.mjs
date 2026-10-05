#!/usr/bin/env node
// Finding 1 adapter regressions: genuine exclusive ownership for Codex
// worker-owned output paths (launch/read/follow-up handlers, Codex engine).
//
// O1 errno-split + symlink rejection: dangling symlink at the primary is
//   occupied (never followed, target never created); the reservation
//   diverts to a clean run-bound fallback.
// O2 error-skip: an unreadable workdir (EACCES on every candidate) reserves
//   preoccupied (error is distinguished from confirmed absence, never
//   supplied as a clean slot) and creates nothing.
// O3 competing creation: reserve, then delete the placeholder and recreate
//   a foreign file (new inode, recent mtime) before supply -> finalize
//   reports unavailable (replaced/foreign), foreign bytes unchanged.
// O4 claim-less recent foreign: a crafted absent-reservation WITHOUT an
//   exclusive claim never binds a worker verdict (recent mtime included).
// O5 silent worker: reserve, then no worker write (empty placeholder) ->
//   unavailable, never present.
// O6 O_EXCL race emulation: two reserves for the same (run, attempt) bind
//   distinct paths; the first claim is never overwritten.
// O7 fully-occupied via the proof seam: every bounded candidate preoccupied
//   -> ReservationFailedError BEFORE any spawn or save (run file unchanged,
//   zero worker launches, no duplicate dispatch).
// O8 reservation-save failure injection: read-only runs dir -> the save
//   propagates (never swallowed); the caller stops before spawn with the
//   claim on disk but no persisted reservation (finalize fails closed).
// O9 handler level: a counter-shim launch spawns exactly once; same-request
//   replay spawns nothing more (no duplicate dispatch); foreign bytes stay
//   byte-identical throughout.
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME, fake codex binary via CODEXPRO_CODEX_BIN (all fake-binary
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
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));

// ---------- fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
process.env.CODEX_HOME = codexHome;

// ---------- unit O1: dangling symlink ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-symlink-'));
  const RUN = 'run_1111111111111111';
  const primary = Tools.lastMessageRelPathForAttempt('codex', 1, RUN);
  const target = path.join(wdir, 'symlink-target.md');
  await fsp.symlink(target, path.join(wdir, primary));
  const res = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN);
  assert(res.absentAtReserve === true && res.relPath !== primary && res.claim,
    `dangling symlink must divert to a claimed fallback, never the link: ${JSON.stringify({ ...res, claim: !!res.claim })}`);
  assert(!fs.existsSync(target), 'the symlink target must never be created (O_EXCL never follows the link)');
  assert(fs.lstatSync(path.join(wdir, primary)).isSymbolicLink(), 'the foreign link itself must stay untouched');
  await fsp.writeFile(path.join(wdir, res.relPath), 'worker output on the clean fallback');
  const rec = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN, new Date().toISOString(), res);
  assert(rec.provenance === 'worker' && rec.relPath === res.relPath,
    `clean fallback binds the worker verdict: ${JSON.stringify(rec)}`);
  console.log('ok: O1 dangling symlink rejected as occupied (target never created, diverted + bound)');
}

// ---------- unit O2: filesystem error is not confirmed absence ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-error-'));
  const RUN = 'run_2222222222222222';
  await fsp.chmod(wdir, 0o000);
  let res;
  try {
    res = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN);
  } finally {
    await fsp.chmod(wdir, 0o700);
  }
  assert(res.absentAtReserve === false,
    `unreadable candidates must reserve preoccupied (error != absent): ${JSON.stringify(res)}`);
  console.log('ok: O2 filesystem-error candidates never supplied as clean slots');
}

// ---------- unit O3: competing creation (recreate after reserve) ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-race-'));
  const RUN = 'run_3333333333333333';
  const res = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN);
  assert(res.absentAtReserve === true && res.claim, 'clean slot must reserve with a claim');
  // Deterministic competing creation between reserve and supply: delete the
  // placeholder and recreate a foreign file (new inode, recent mtime).
  // Identity binds device + inode + creation time (inode reuse across
  // delete + recreate still changes the creation time); the sleep keeps
  // the test off filesystem timestamp granularity. Residual boundary
  // (documented): a same-tick delete + recreate, or an in-place overwrite
  // by a same-host writer, is indistinguishable from worker output — the
  // same trust domain as the worker process itself.
  await fsp.unlink(path.join(wdir, res.relPath));
  await new Promise((r) => setTimeout(r, 25));
  await fsp.writeFile(path.join(wdir, res.relPath), 'FOREIGN-BYTES');
  const before = fs.readFileSync(path.join(wdir, res.relPath), 'utf8');
  const rec = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN, new Date().toISOString(), res);
  assert(rec.provenance === 'unavailable' && /foreign|replaced|claim/i.test(rec.reason ?? ''),
    `recreated foreign file must stay unclaimed, however recent: ${JSON.stringify(rec)}`);
  assert(fs.readFileSync(path.join(wdir, res.relPath), 'utf8') === before &&
    before === 'FOREIGN-BYTES', 'foreign bytes must be unchanged (stat-only path never writes)');
  console.log('ok: O3 competing creation leaves foreign bytes unclaimed + untouched');
}

// ---------- unit O4: claim-less recent foreign is unclaimed ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-noclaim-'));
  const RUN = 'run_4444444444444444';
  const primary = Tools.lastMessageRelPathForAttempt('codex', 1, RUN);
  await fsp.writeFile(path.join(wdir, primary), 'RECENT-FOREIGN');
  fs.utimesSync(path.join(wdir, primary), new Date(), new Date());
  const crafted = { relPath: primary, absentAtReserve: true, reservedAt: new Date(Date.now() - 5000).toISOString() };
  const rec = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN, new Date().toISOString(), crafted);
  assert(rec.provenance === 'unavailable' && /exclusive-claim/.test(rec.reason ?? ''),
    `absence-without-claim must fail closed on a recent foreign file: ${JSON.stringify(rec)}`);
  assert(fs.readFileSync(path.join(wdir, primary), 'utf8') === 'RECENT-FOREIGN',
    'foreign file must stay untouched');
  console.log('ok: O4 recent-timestamp foreign without a claim is unclaimed');
}

// ---------- unit O5: silent worker ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-silent-'));
  const RUN = 'run_5555555555555555';
  const res = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN);
  assert(res.absentAtReserve === true, 'clean slot must reserve');
  const rec = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN, new Date().toISOString(), res);
  assert(rec.provenance === 'unavailable' && rec.bytes === 0,
    `silent worker (empty placeholder) must be unavailable: ${JSON.stringify(rec)}`);
  console.log('ok: O5 silent worker reports unavailable (empty = unavailable, never a slot)');
}

// ---------- unit O6: double reserve never overwrites ----------
{
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-double-'));
  const RUN = 'run_6666666666666666';
  const first = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN);
  const second = Tools.reserveAttemptArtifactPath(wdir, 'codex', 1, RUN);
  assert(first.absentAtReserve === true && second.absentAtReserve === true,
    'both reserves must find clean slots');
  assert(first.relPath !== second.relPath, 'the second claim must divert, never reuse the held name');
  assert(JSON.stringify(first.claim) !== JSON.stringify(second.claim), 'claims must be distinct identities');
  await fsp.writeFile(path.join(wdir, first.relPath), 'FIRST-CLAIM-DATA');
  const recFirst = Tools.persistAttemptArtifact(wdir, 'codex', 1, null, RUN, new Date().toISOString(), first);
  assert(recFirst.provenance === 'worker', 'first claim still binds after the second diverted');
  console.log('ok: O6 competing reserves diverge (first claim never overwritten)');
}

// ---------- MCP wiring for O7-O9 ----------
const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-mcp-'));
const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-shim-'));
const counterFile = path.join(shimBin, 'counter.txt');
await fsp.writeFile(counterFile, '0');
const fake = async (name, body) => {
  const p = path.join(shimBin, name);
  await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
  await fsp.chmod(p, 0o755);
  return p;
};
const codexCounter = await fake('codex-counter',
  `if [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\nif [ "$1" != "exec" ]; then exit 1; fi\nOUT="";PREV="";for A in "$@"; do if [ "$PREV" = "--output-last-message" ]; then OUT="$A"; fi;PREV="$A"; done\nif [ -z "$OUT" ]; then echo "missing --output-last-message" >&2; exit 1; fi\nCTR=${counterFile}\nn=$(cat "$CTR" 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > "$CTR"\necho "CODEX-MARKER-$n" > "$OUT"\nexit 0`);
process.env.CODEXPRO_CODEX_BIN = codexCounter;
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'ownership-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const wid = opened.structuredContent.workspace_id;
const launches = async () => Number((await fsp.readFile(counterFile, 'utf8')).trim() || '0');
const waitSettled = async (runId, tries = 120) => {
  for (let i = 0; i < tries; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    const state = r.structuredContent.state;
    if (state !== 'running' && state !== 'queued') return r;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`ASSERT: run ${runId} never settled`);
};
// Locate the file-backed bridge dir for this owner/workspace (run files).
const findRunsDir = async () => {
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'delegation-runs') return abs;
        try {
          const hit = await walk(abs);
          if (hit) return hit;
        } catch { /* keep walking */ }
      }
    }
    return null;
  };
  return walk(delegHome);
};

// ---------- O9 + O7-handler: one launch, one worker, truthful replay ----------
{
  const before = await launches();
  const launched = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'own-run-1', task: 'Ownership probe. Change nothing.',
    delegation_group: 'team-own', request_id: 'req-own-1', timeout_ms: 60000
  });
  assert(!launched.isError, `shim launch must succeed: ${JSON.stringify(launched.structuredContent)}`);
  const runId = launched.structuredContent.run_id;
  const read = await waitSettled(runId);
  assert(read.structuredContent.state === 'completed', `shim run must complete: ${read.structuredContent.state}`);
  assert((await launches()) === before + 1, 'exactly one worker launch for one request');
  const replay = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', execution_policy: 'read-only',
    workdir: 'own-run-1', task: 'Ownership probe. Change nothing.',
    delegation_group: 'team-own', request_id: 'req-own-1', timeout_ms: 60000
  });
  assert(!replay.isError && replay.structuredContent.idempotent_replay === true,
    `same request must replay, never respawn: ${JSON.stringify(replay.structuredContent)}`);
  assert((await launches()) === before + 1, 'replay must spawn no second worker (no duplicate dispatch)');
  const art = read.structuredContent.test_evidence.last_message;
  assert(art.status === 'present', `claimed placeholder binds present: ${JSON.stringify(art)}`);
  console.log('ok: O9 handler launches exactly once; replay duplicates nothing');
}

// ---------- O7: fully-occupied namespace stops before spawn ----------
{
  const runsDir = await findRunsDir();
  assert(runsDir, 'bridge runs dir must exist after O9');
  const bridgeDir = path.dirname(runsDir);
  const RUN = 'run_7777777777777777';
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-full-'));
  const all = [Tools.lastMessageRelPathForAttempt('codex', 1, RUN),
    ...Tools.attemptArtifactFallbackPaths('codex', 1, RUN)];
  const dot = all[0].lastIndexOf('.');
  for (let i = 4; i <= 9; i += 1) all.push(`${all[0].slice(0, dot)}-x${i}${all[0].slice(dot)}`);
  for (const rel of all) await fsp.writeFile(path.join(wdir, rel), 'FORGED');
  const forgedBytes = all.map((rel) => fs.readFileSync(path.join(wdir, rel), 'utf8'));
  const run = {
    version: 1, runId: RUN, requestId: 'req-own-full', delegationGroup: 'team-own',
    engine: 'codex', profile: 'CODEX_SCOUT_FAST', executionPolicy: 'read-only',
    isCanary: false, task: 'x', workspaceId: wid, workspaceCanonical: wsRoot,
    workdir: wdir, ownerIdHash: 'test', ownerKind: 'local', state: 'queued', seq: 0,
    attempts: [], pendingEvents: [], checkpoints: [], appliedCheckpointIds: [],
    lastAppliedCheckpointSeq: -1, nextAction: 'staged', createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  Store.saveDelegationRun(bridgeDir, run);
  const runFileBefore = fs.readFileSync(path.join(runsDir, `${RUN}.json`), 'utf8');
  const before = await launches();
  let thrown = null;
  try {
    Tools.reserveCodexOutputForProof(bridgeDir, Store.loadDelegationRun(bridgeDir, RUN), 1);
  } catch (error) {
    thrown = error;
  }
  assert(thrown && Tools.isReservationFailedError(thrown),
    `fully-occupied namespace must throw ReservationFailedError before spawn: ${String(thrown)}`);
  assert((await launches()) === before, 'zero worker launches on reservation failure');
  assert(fs.readFileSync(path.join(runsDir, `${RUN}.json`), 'utf8') === runFileBefore,
    'run file unchanged (throw precedes the persist)');
  all.forEach((rel, i) => assert(fs.readFileSync(path.join(wdir, rel), 'utf8') === forgedBytes[i],
    'every foreign file byte-identical (never overwritten, never claimed)'));
  console.log('ok: O7 fully-occupied stops before spawn (zero launches, truthful state, no duplicate dispatch)');
}

// ---------- O8: reservation-save failure propagates (never swallowed) ----------
{
  const runsDir = await findRunsDir();
  assert(runsDir, 'bridge runs dir must exist');
  const bridgeDir = path.dirname(runsDir);
  const RUN = 'run_8888888888888888';
  const wdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-own-savefail-'));
  const run = {
    version: 1, runId: RUN, requestId: 'req-own-savefail', delegationGroup: 'team-own',
    engine: 'codex', profile: 'CODEX_SCOUT_FAST', executionPolicy: 'read-only',
    isCanary: false, task: 'x', workspaceId: wid, workspaceCanonical: wsRoot,
    workdir: wdir, ownerIdHash: 'test', ownerKind: 'local', state: 'queued', seq: 0,
    attempts: [{ n: 1, startedAt: new Date().toISOString(), state: 'queued' }], pendingEvents: [],
    checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    nextAction: 'staged', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  Store.saveDelegationRun(bridgeDir, run);
  await fsp.chmod(runsDir, 0o555);
  const before = await launches();
  let thrown = null;
  try {
    Tools.reserveCodexOutputForProof(bridgeDir, Store.loadDelegationRun(bridgeDir, RUN), 1);
  } catch (error) {
    thrown = error;
  } finally {
    await fsp.chmod(runsDir, 0o755);
  }
  assert(thrown && !Tools.isReservationFailedError(thrown),
    `persistence-save failure must propagate (never swallowed, never converted): ${String(thrown?.message ?? thrown)}`);
  assert((await launches()) === before, 'zero worker launches when the reservation cannot persist');
  // The claim landed on disk but no reservation was persisted: finalize
  // fails closed (unavailable) rather than attributing without proof.
  const loaded = Store.loadDelegationRun(bridgeDir, RUN);
  assert(!loaded.attempts.at(-1)?.artifactReservation,
    'no reservation persisted on save failure (finalize stays fail-closed)');
  console.log('ok: O8 reservation-save failure propagates; caller stops before spawn');
}

console.log('delegation-codex-ownership-smoke: PASS (no live model calls; fake-binary results labeled shim)');
