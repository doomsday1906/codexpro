// Hestia R2-1 proof: structured coverage cache identity covers the exclusion
// set. Transitions through compiled stdio MCP inspect_workspace:
//   A: complete cache (0 skips) -> add one oversized file -> rerun must be a
//      FRESH partial result (new cache key, skips=1, warning), never a stale
//      cached complete result;
//   B: remove it -> rerun must be complete again with the ORIGINAL cache key;
//   C: a file crossing the admission boundary changes cache identity.
// Direct `node` run must PASS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { loadConfig } = await import("../dist/config.js");
const config = loadConfig();
const ADMISSION = Math.min(2_000_000, config.maxReadBytes * 4);
assert.ok(ADMISSION > 0, "admission must be positive");

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-cache-"));
let child;
const pending = new Map();
let nextId = 1;
let buffer = "";
const requestOn = (kid, method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
  timer.unref();
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  kid.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const launch = (root, extraEnv = {}) => {
  const kid = spawn(process.execPath, [
    "dist/stdio.js", "--root", root, "--allow-root", root,
    "--bash", "off", "--write", "off", "--tool-mode", "full"
  ], { cwd: path.resolve("."), env: { ...process.env, CODEXPRO_ROOT: root, CODEXPRO_ALLOWED_ROOTS: root, ...extraEnv } });
  kid.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  kid.stderr.on("data", () => {});
  return kid;
};
try {
  await fsp.writeFile(path.join(tmp, "a.txt"), "alpha one\n");
  await fsp.writeFile(path.join(tmp, "b.txt"), "beta two\n");

  child = launch(tmp);
  const request = (method, params, timeoutMs = 120000) => requestOn(child, method, params, timeoutMs);
  const inspect = async (req = request) => {
    const msg = await req("tools/call", {
      name: "inspect_workspace",
      arguments: { include_symbols: false, include_relationships: false }
    });
    assert.equal(msg.error, undefined, `inspect protocol error: ${JSON.stringify(msg.error)}`);
    assert.notEqual(msg.result.isError, true, `inspect tool error: ${JSON.stringify(msg.result).slice(0, 400)}`);
    const sc = msg.result.structuredContent;
    assert.ok(sc && typeof sc === "object", "missing structuredContent");
    return sc;
  };

  // A0: complete baseline.
  const base = await inspect();
  assert.equal(base.coverage.oversizedSkippedFiles, 0, "baseline must have zero skips");
  assert.equal(base.coverage.truncated, false, "baseline must be complete");
  assert.ok(!base.warnings.some((w) => /analysis admission/.test(w)), "baseline must carry no admission warning");
  assert.equal(base.cache.hit, false, "first inspect must compute");
  const keyBase = base.cache.key;
  assert.ok(typeof keyBase === "string" && keyBase.length > 0, "cache key must be a non-empty identity");
  const again = await inspect();
  assert.equal(again.cache.hit, true, "repeat inspect must hit");
  assert.equal(again.cache.key, keyBase, "repeat inspect must reuse the key");

  // A1: add one oversized file -> fresh partial, never stale complete.
  await fsp.writeFile(path.join(tmp, "big.bin.txt"), `x\n`.repeat(ADMISSION / 2 + 1000));
  const grown = await inspect();
  assert.equal(grown.coverage.oversizedSkippedFiles, 1, "added oversized file must count exactly one skip");
  assert.equal(grown.coverage.truncated, true, "added oversized file must truncate coverage");
  assert.ok(grown.warnings.some((w) => /1 file exceeds .* analysis admission/.test(w)), "added oversized file must warn");
  assert.notEqual(grown.cache.key, keyBase, "exclusion-set change must change cache identity");
  assert.equal(grown.cache.hit, false, "REGRESSION: stale cached complete result replaced fresh bounded coverage");

  // B: remove it -> complete again under the ORIGINAL key.
  await fsp.unlink(path.join(tmp, "big.bin.txt"));
  const shrunk = await inspect();
  assert.equal(shrunk.coverage.oversizedSkippedFiles, 0, "removal must clear the skip");
  assert.equal(shrunk.coverage.truncated, false, "removal must restore completeness");
  assert.equal(shrunk.cache.key, keyBase, "removal must restore the original cache identity");

  // C: file crossing the admission boundary.
  const edge = path.join(tmp, "edge.txt");
  await fsp.writeFile(edge, "e\n".repeat(ADMISSION / 2 - 5000));
  const under = await inspect();
  assert.equal(under.coverage.oversizedSkippedFiles, 0, "under-boundary file must be admitted");
  const keyUnder = under.cache.key;
  await fsp.writeFile(edge, "e\n".repeat(ADMISSION / 2 + 5000));
  const over = await inspect();
  assert.equal(over.coverage.oversizedSkippedFiles, 1, "over-boundary file must be excluded");
  assert.equal(over.coverage.truncated, true, "boundary crossing must truncate");
  assert.notEqual(over.cache.key, keyUnder, "boundary crossing must change cache identity");
  assert.equal(over.cache.hit, false, "boundary crossing must compute fresh");

  // D (R2 review R1-T1): traversal-capacity truncation is cache identity.
  // With the inventory capped at 100 files, the 101st file must produce a
  // fresh truncated result under a new key — never a stale cached complete.
  child.kill("SIGKILL");
  const capTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-cache-cap-"));
  let capChild;
  try {
    for (let i = 0; i < 100; i += 1) {
      await fsp.writeFile(path.join(capTmp, `f${String(i).padStart(3, "0")}.txt`), `cap file ${i}\n`);
    }
    capChild = launch(capTmp, { CODEXPRO_ANALYSIS_MAX_INVENTORY_FILES: "100" });
    const capReq = (method, params, t) => requestOn(capChild, method, params, t);
    const full = await inspect(capReq);
    assert.equal(full.coverage.truncated, false, "100 files at cap 100 must be complete");
    assert.equal(full.cache.hit, false, "capped baseline must compute");
    const keyFull = full.cache.key;
    await fsp.writeFile(path.join(capTmp, "zzz_last.txt"), "one file past the cap\n");
    const past = await inspect(capReq);
    assert.equal(past.coverage.truncated, true, "101st file must truncate coverage");
    assert.notEqual(past.cache.key, keyFull, "truncation onset must change cache identity");
    assert.equal(past.cache.hit, false, "REGRESSION: stale cached complete masked fresh truncation");
  } finally {
    if (capChild) capChild.kill("SIGKILL");
    await fsp.rm(capTmp, { recursive: true, force: true });
  }

  console.log("HESTIA_R2_CACHE_PROOF: PASS");
} finally {
  if (child) child.kill("SIGKILL");
  await fsp.rm(tmp, { recursive: true, force: true });
}
