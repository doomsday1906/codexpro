#!/usr/bin/env node
// Task B regression: central run-scoped artifact storage.
//
// - Foreign primary file forces fallback: the run reserves + writes its OWN
//   artifact (foreign bytes + presence untouched), finalize relocates the
//   verified worker bytes centrally (single source of truth; workdir keeps
//   only task code), reads resolve centrally with provenance.
// - Prune consults RECORDS only: the recorded central artifact disappears;
//   the foreign file, task code, and other runs survive (asserted by bytes
//   + presence, pre/post sha256).
// - Missing/corrupt records fail closed to no-delete with an explicit reason.
// - opencode harness-persisted output goes DIRECTLY central (no workdir file
//   ever); legacy workdir persist path still works without a central dir.
//
// Adapter-level, labeled shim EXCEPT where the live 2026-10-05 probe proved
// the shape: worker-writes-into-the-reserved-path (truncate-write, identity
// preserved) and queue/thread shapes are live-observed; the shim write below
// replays that proved shape and is labeled as such. No live model calls.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));

const bridge = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-central-bridge-'));
const workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-central-work-'));
const RUN = 'run_eeeeeeeeeeeeeeee';
const centralDir = Store.centralArtifactsDirForRun(bridge, RUN);
assert(centralDir === path.join(bridge, 'delegation-artifacts', RUN),
  `central dir must be run-scoped under the bridge: ${centralDir}`);
let threw = false;
try { Store.centralArtifactsDirForRun(bridge, 'bogus'); } catch { threw = true; }
assert(threw, 'central dir must throw on an invalid run id (fail closed, never a shared dir)');

// ---------- codex: foreign primary forces fallback, then central relocate ----------
const primaryRel = Tools.lastMessageRelPathForAttempt('codex', 1, RUN);
const FOREIGN = 'FOREIGN BYTES — not this run\n';
await fsp.writeFile(path.join(workdir, primaryRel), FOREIGN);
const foreignPreHash = sha256(FOREIGN);
await fsp.writeFile(path.join(workdir, 'task-code.txt'), 'task code\n');

const reservation = Tools.reserveAttemptArtifactPath(workdir, 'codex', 1, RUN);
assert(reservation.absentAtReserve === true && reservation.relPath !== primaryRel,
  `reservation must divert from the preoccupied primary to a fallback sibling: ${JSON.stringify(reservation)}`);
assert(reservation.claim && Number.isSafeInteger(reservation.claim.dev),
  'reservation must carry the exclusive-claim proof');
// Shim worker write replays the LIVE-PROVED shape (2026-10-05: the worker
// fills the reserved path; truncate-write preserves claim identity).
await fsp.writeFile(path.join(workdir, reservation.relPath), 'worker last message\n');
const workerHash = sha256('worker last message\n');

const startedAt = new Date(Date.parse(reservation.reservedAt) - 1000).toISOString();
const rec = Tools.persistAttemptArtifact(workdir, 'codex', 1, null, RUN, startedAt, reservation, centralDir);
assert(rec.base === 'central' && rec.provenance === 'worker',
  `codex finalize must record a central worker verdict: ${JSON.stringify(rec)}`);
assert(rec.sha256 === workerHash && rec.bytes === Buffer.byteLength('worker last message\n', 'utf8'),
  'central record must carry the observed bytes + hash');
assert(rec.relocatedFrom === reservation.relPath && (rec.relocatedVia === 'rename' || rec.relocatedVia === 'copy-unlink'),
  'central record must carry relocation provenance (single source of truth afterwards)');
assert(!fs.existsSync(path.join(workdir, reservation.relPath)),
  'workdir source must be gone after relocate (workdir keeps only task code)');
assert(fs.existsSync(path.join(centralDir, rec.relPath)),
  'central artifact file must exist');
assert(sha256(await fsp.readFile(path.join(centralDir, rec.relPath), 'utf8')) === workerHash,
  'central bytes must equal the worker bytes (hash)');
assert(fs.existsSync(path.join(workdir, primaryRel)) &&
  sha256(await fsp.readFile(path.join(workdir, primaryRel), 'utf8')) === foreignPreHash,
  'foreign primary file must survive with identical bytes (presence + hash)');
assert(fs.existsSync(path.join(workdir, 'task-code.txt')), 'task code must survive finalize');

// Central reads resolve with provenance through the ordinary read route.
const described = Tools.describeAttemptArtifact(centralDir, 'codex', 1, rec);
assert(described.status === 'present' && described.path === rec.relPath,
  `central artifact must read present with provenance: ${JSON.stringify(described)}`);
// The retired workdir name resolves to nothing (no second source of truth).
const ghost = Tools.describeAttemptArtifact(workdir, 'codex', 1, { relPath: reservation.relPath, created: false });
assert(ghost.status === 'unavailable',
  'the retired workdir path must never read present without a record');
console.log('ok: C1 codex foreign-primary fallback + central relocate (foreign bytes+presence intact, single central source)');

// ---------- opencode: direct-central persist, never a workdir file ----------
const workdir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-central-work2-'));
const RUN2 = 'run_ffffffffffffffff';
const centralDir2 = Store.centralArtifactsDirForRun(bridge, RUN2);
const rec2 = Tools.persistAttemptArtifact(workdir2, 'opencode', 1, '{"session":"s1"}', RUN2, new Date().toISOString(), null, centralDir2);
assert(rec2.base === 'central' && rec2.created === true && rec2.provenance === 'created',
  `opencode finalize must O_EXCL-create centrally: ${JSON.stringify(rec2)}`);
assert(rec2.sha256 === sha256('{"session":"s1"}'), 'central record must hash the persisted bytes');
assert((await fsp.readdir(workdir2)).length === 0,
  'opencode must never create a workdir file (workdir keeps only task code)');
const described2 = Tools.describeAttemptArtifact(centralDir2, 'opencode', 1, rec2);
assert(described2.status === 'present', 'direct-central artifact must read present');
console.log('ok: C2 opencode direct-central persist (no workdir file ever)');

// ---------- prune: record authority only (bytes + presence, pre/post hashes) ----------
const centralPreHash = sha256(await fsp.readFile(path.join(centralDir, rec.relPath), 'utf8'));
const victim = {
  runId: RUN, workdir,
  attempts: [{
    n: 1, startedAt, state: 'completed',
    outputArtifact: rec,
    artifactReservation: { relPath: reservation.relPath, absentAtReserve: true, reservedAt: reservation.reservedAt, claim: reservation.claim }
  }]
};
const torn = Store.teardownRunArtifacts(bridge, victim);
assert(torn.removed.some((f) => f === `central:${rec.relPath}`),
  `prune must remove the recorded central artifact: ${JSON.stringify(torn)}`);
assert(!fs.existsSync(path.join(centralDir, rec.relPath)),
  'recorded central artifact must disappear after prune');
assert(centralPreHash === workerHash, 'pre-hash pins the removed bytes');
assert(fs.existsSync(path.join(workdir, primaryRel)) &&
  sha256(await fsp.readFile(path.join(workdir, primaryRel), 'utf8')) === foreignPreHash,
  'foreign file must survive prune with identical bytes (presence + post hash)');
assert(fs.existsSync(path.join(workdir, 'task-code.txt')), 'task code must survive prune');
// Other runs in the same bridge are untouched.
assert(fs.existsSync(path.join(centralDir2, rec2.relPath)), 'other runs must survive prune');
console.log('ok: C3 prune removes ONLY recorded owned artifacts (foreign/task-code/other-run survive, pre/post hashes)');

// ---------- transient reservation placeholder: identity-match removal, tamper survives ----------
const workdir3 = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-central-work3-'));
const RUN3 = 'run_3333333333333333';
const res3 = Tools.reserveAttemptArtifactPath(workdir3, 'codex', 1, RUN3);
// Crash between reserve and finalize: empty placeholder left behind.
const crashVictim = {
  runId: RUN3, workdir: workdir3,
  attempts: [{ n: 1, startedAt: new Date().toISOString(), state: 'failed', artifactReservation: res3 }]
};
const torn3 = Store.teardownRunArtifacts(bridge, crashVictim);
assert(torn3.removed.some((f) => f === `reservation:${res3.relPath}`),
  `crashed-run empty placeholder (claim identity match) must be retired: ${JSON.stringify(torn3)}`);
assert(!fs.existsSync(path.join(workdir3, res3.relPath)), 'retired placeholder must be gone');
// Tampered placeholder (deleted + recreated foreign file): identity differs -> survives.
const res4 = Tools.reserveAttemptArtifactPath(workdir3, 'codex', 1, RUN3);
await fsp.rm(path.join(workdir3, res4.relPath));
await fsp.writeFile(path.join(workdir3, res4.relPath), 'tampered foreign bytes\n');
const tamperVictim = {
  runId: RUN3, workdir: workdir3,
  attempts: [{ n: 1, startedAt: new Date().toISOString(), state: 'failed', artifactReservation: res4 }]
};
const torn4 = Store.teardownRunArtifacts(bridge, tamperVictim);
assert(!torn4.removed.some((f) => f.includes(res4.relPath)) &&
  fs.existsSync(path.join(workdir3, res4.relPath)),
  `tampered placeholder (claim identity mismatch) must survive: ${JSON.stringify(torn4)}`);
console.log('ok: C4 transient reservation teardown (identity match retires; tampered survives)');

// ---------- missing/corrupt records fail closed ----------
const m1 = Store.teardownRunArtifacts(bridge, null);
const m2 = Store.teardownRunArtifacts(bridge, { runId: RUN, workdir });
const m3 = Store.teardownRunArtifacts('', victim);
assert(m1.removed.length === 0 && m1.reason && m2.removed.length === 0 && m2.reason && m3.removed.length === 0 && m3.reason,
  `missing/corrupt inputs must fail closed with reasons: ${JSON.stringify([m1, m2, m3])}`);
console.log('ok: C5 missing/corrupt records fail closed (no-delete + explicit reason)');

console.log('delegation-central-artifact-smoke: PASS (no live model calls; shim replays live-proved worker-write shape, labeled)');
