// HESTIA_R3_EXCLUSION_CARDINALITY_PROOF: inventory exclusion identity is
// bounded streaming state (32-byte XOR fold + exact counter), never a
// retained per-exclusion list. With maxInventoryFiles=100 and 12,000
// excluded files (sparse, so bytes are real to stat but cost no I/O):
// - completes with the exact oversizedSkippedFiles count;
// - heap growth stays under a blowup tripwire (no per-exclusion retention);
// - repeated unchanged inventory yields the identical fingerprint;
// - one excluded-file identity change flips the fingerprint, and restoring
//   it restores the fingerprint (fact-equivalent reuse);
// - add/remove of one excluded file flips/restores the fingerprint;
// - no excluded path leaks anywhere in the serialized inventory result.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = "/home/andrew/AgentWorkspace/worktrees/codexpro/repoconnect-large-file-surgical-readability/primary";
const importBuilt = (rel) => import(pathToFileURL(path.join(projectRoot, "dist", rel)).href);

process.env.CODEXPRO_ANALYSIS_MAX_INVENTORY_FILES = "100";
process.env.CODEXPRO_MAX_READ_BYTES = "4000";

const EXCLUDED_COUNT = 12_000;
const EXCLUDED_BYTES = 16_001; // admission = min(2M, 4000*4) = 16000

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r3-cardinality-"));
try {
  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { inventoryWorkspace }] = await Promise.all([
    importBuilt("config.js"), importBuilt("guard.js"), importBuilt("analysis/inventory.js")
  ]);
  const config = loadConfig(["--root", tmp, "--allow-root", tmp, "--bash", "off", "--write", "off"]);
  assert.equal(config.analysisLimits.maxInventoryFiles, 100);
  const guard = new PathGuard(config);
  const ws = new WorkspaceManager(config).defaultWorkspace();

  for (let i = 0; i < 5; i += 1) {
    await fsp.writeFile(path.join(tmp, `kept0${i}.txt`), `kept admitted file ${i}\n`);
  }
  for (let i = 0; i < EXCLUDED_COUNT; i += 1) {
    const p = path.join(tmp, `excl${String(i).padStart(5, "0")}.txt`);
    const fh = await fsp.open(p, "w");
    await fh.truncate(EXCLUDED_BYTES + (i % 7));
    await fh.close();
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const first = await inventoryWorkspace(config, guard, ws);
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(first.coverage.oversizedSkippedFiles, EXCLUDED_COUNT, "all 12,000 over-admission files must count exactly");
  assert.equal(first.coverage.truncated, true, "exclusions must truncate coverage");
  assert.equal(first.files.length, 5, "admitted files stay under the cap");
  assert.ok(heapAfter - heapBefore < 64 * 1024 * 1024, `heap growth ${(heapAfter - heapBefore) / 1048576}MB exceeds the no-retention tripwire`);
  console.log(`excluded=${first.coverage.oversizedSkippedFiles} heap_growth_mb=${((heapAfter - heapBefore) / 1048576).toFixed(2)} fingerprint=${first.fingerprint.slice(0, 16)}…`);

  // Deterministic on repeated unchanged inventory.
  const repeat = await inventoryWorkspace(config, guard, ws);
  assert.equal(repeat.fingerprint, first.fingerprint, "unchanged inventory must fingerprint identically");

  // No excluded path retained anywhere observable.
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /excl0\d{4}\.txt/, "REGRESSION: excluded paths retained in the inventory result");
  assert.match(serialized, /kept00\.txt/, "admitted files must still be present (sanity)");

  // One excluded-file identity change flips the key; restore flips it back.
  // (Whole-second mtimes: sub-second mtimes are not exactly representable
  // through utimes' double-second conversion, so the round-trip pins time.)
  const victim = path.join(tmp, "excl06000.txt");
  const pinnedDate = new Date(1_700_000_000_000);
  await fsp.utimes(victim, pinnedDate, pinnedDate);
  const pinned = await inventoryWorkspace(config, guard, ws);
  await fsp.truncate(victim, EXCLUDED_BYTES + 500);
  const changed = await inventoryWorkspace(config, guard, ws);
  assert.notEqual(changed.fingerprint, pinned.fingerprint, "excluded identity change must update the fingerprint");
  assert.equal(changed.coverage.oversizedSkippedFiles, EXCLUDED_COUNT, "count unchanged by identity edit");
  await fsp.truncate(victim, EXCLUDED_BYTES + (6000 % 7));
  await fsp.utimes(victim, pinnedDate, pinnedDate);
  const checkStat = await fsp.stat(victim);
  assert.equal(checkStat.mtimeMs, 1_700_000_000_000, "restore must reset mtime");
  const restored = await inventoryWorkspace(config, guard, ws);
  assert.equal(restored.fingerprint, pinned.fingerprint, "restored identity must restore fact-equivalent reuse");

  // Add/remove transitions.
  const extra = path.join(tmp, "excl_extra.txt");
  const fh = await fsp.open(extra, "w");
  await fh.truncate(EXCLUDED_BYTES);
  await fh.close();
  const grown = await inventoryWorkspace(config, guard, ws);
  assert.equal(grown.coverage.oversizedSkippedFiles, EXCLUDED_COUNT + 1, "added exclusion must count");
  assert.notEqual(grown.fingerprint, pinned.fingerprint, "added exclusion must change cache identity");
  await fsp.unlink(extra);
  const shrunk = await inventoryWorkspace(config, guard, ws);
  assert.equal(shrunk.coverage.oversizedSkippedFiles, EXCLUDED_COUNT, "removal must restore the count");
  assert.equal(shrunk.fingerprint, pinned.fingerprint, "removal must restore the original cache identity");

  // Count-independence: double the exclusions; retained state must not scale
  // with cardinality (same tripwire at 2x files).
  for (let i = 0; i < EXCLUDED_COUNT; i += 1) {
    const p = path.join(tmp, `more${String(i).padStart(5, "0")}.txt`);
    const fh = await fsp.open(p, "w");
    await fh.truncate(EXCLUDED_BYTES + (i % 5));
    await fh.close();
  }
  const heapBefore2x = process.memoryUsage().heapUsed;
  const doubled = await inventoryWorkspace(config, guard, ws);
  const heapAfter2x = process.memoryUsage().heapUsed;
  assert.equal(doubled.coverage.oversizedSkippedFiles, EXCLUDED_COUNT * 2, "doubled exclusions must count exactly");
  assert.ok(heapAfter2x - heapBefore2x < 64 * 1024 * 1024, `2x heap growth ${(heapAfter2x - heapBefore2x) / 1048576}MB exceeds the tripwire`);
  console.log(`excluded_2x=${doubled.coverage.oversizedSkippedFiles} heap_growth_2x_mb=${((heapAfter2x - heapBefore2x) / 1048576).toFixed(2)}`);

  console.log("HESTIA_R3_EXCLUSION_CARDINALITY_PROOF: PASS");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
