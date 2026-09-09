// Hestia R2-3 proof: public search routes carry coverage incompleteness as
// structural bounded facts AND keep the explanation in the public text.
// Broad ripgrep with an admission-excluded file, plus the same under a forced
// Node fallback (rg neutralized via empty-PATH), through compiled stdio MCP:
//   - matches present: match text preserved + explanation retained;
//   - zero matches caused by admission: "No matches." + explanation (never a
//     bare "No matches."), with reason/count facts in structured coverage.
// Direct `node` run must PASS.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const NEEDLE = "R2CoverageNeedleBeta";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-pubcov-"));
const emptyPathDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-empty-path-"));
const rgGone = (env) => spawnSync("/bin/sh", ["-lc", "command -v rg"], { encoding: "utf8", env }).status !== 0;
assert.equal(rgGone(process.env), false, "test host needs rg for the ripgrep route");

try {
  await fsp.writeFile(path.join(tmp, "small.txt"), `hit ${NEEDLE} here\n`);
  // Over the broad search admission (textScanByteLimit) so broad coverage is
  // partial; the ONLY occurrence of the zero-needle lives inside it.
  await fsp.writeFile(path.join(tmp, "huge.txt"), `x\n`.repeat(400000));
  await fsp.appendFile(path.join(tmp, "huge.txt"), `only R2ZeroNeedleGamma inside excluded file\n`);

  const launch = (root, extraEnv = {}) => {
    const env = { ...process.env, CODEXPRO_ROOT: root, CODEXPRO_ALLOWED_ROOTS: root, ...extraEnv };
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    const child = spawn(process.execPath, [
      "dist/stdio.js", "--root", root, "--allow-root", root,
      "--bash", "off", "--write", "off", "--tool-mode", "full"
    ], { cwd: projectRoot, env });
    child.stdout.on("data", (chunk) => {
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
    child.stderr.on("data", () => {});
    const request = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      timer.unref();
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    return {
      child,
      search: async (args) => {
        const msg = await request("tools/call", { name: "search", arguments: args });
        assert.equal(msg.error, undefined, `search protocol error: ${JSON.stringify(msg.error)}`);
        assert.notEqual(msg.result.isError, true, `search tool error: ${JSON.stringify(msg.result).slice(0, 400)}`);
        return msg.result;
      }
    };
  };
  const contentText = (result) => result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");

  for (const mode of ["ripgrep", "node"]) {
    const extraEnv = {};
    if (mode === "node") {
      extraEnv.PATH = emptyPathDir;
      assert.equal(rgGone({ ...process.env, ...extraEnv }), true, "fallback not forced: rg still resolves");
    }
    const { child, search } = launch(tmp, extraEnv);
    try {
      // Matches present: projected text preserved + explanation retained.
      const hit = await search({ query: NEEDLE });
      const hitText = contentText(hit);
      const hitSc = hit.structuredContent;
      assert.match(hitText, /small\.txt:1: hit/, `${mode}: projected match text lost`);
      assert.match(hitText, /Coverage incomplete/, `${mode}: coverage explanation dropped from public text`);
      assert.equal(hitSc.truncated, true, `${mode}: truncated must be true`);
      assert.ok(
        (hitSc.coverage.sizeSkips > 0 || hitSc.coverage.incompleteFiles > 0),
        `${mode}: structural coverage must count the exclusion`
      );

      // Zero matches caused by admission: explanation survives, facts agree.
      const zero = await search({ query: "R2ZeroNeedleGamma" });
      const zeroText = contentText(zero);
      const zeroSc = zero.structuredContent;
      assert.match(zeroText, /^No matches\./m, `${mode}: zero-match must start from No matches.`);
      assert.notEqual(zeroText.trim(), "No matches.", `${mode}: REGRESSION: partial search collapsed to bare No matches.`);
      assert.match(zeroText, /Coverage incomplete/, `${mode}: zero-match explanation missing`);
      assert.equal(zeroSc.truncated, true, `${mode}: zero-match partial search must be truncated`);
      assert.equal(zeroSc.matches.length, 0, `${mode}: zero-match must keep zero matches`);
      assert.ok(
        (zeroSc.coverage.sizeSkips > 0 || zeroSc.coverage.incompleteFiles > 0 || zeroSc.coverage.coverageUnknown),
        `${mode}: zero-match structural coverage must record the gap`
      );
      // No source echo: the excluded file's content never appears.
      assert.doesNotMatch(zeroText, /only R2ZeroNeedleGamma inside/, `${mode}: excluded content leaked into public text`);
    } finally {
      child.kill("SIGKILL");
    }
  }
  // Output-budget cut (R2 review R3-T1): truncated=true must come with an
  // explanation and a structural fact, never a bare complete-looking list.
  const cutTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-pubcov-cut-"));
  let cutChild;
  try {
    for (let i = 0; i < 60; i += 1) {
      await fsp.writeFile(path.join(cutTmp, `cut${String(i).padStart(2, "0")}.txt`), `cut filler line ${i} ${NEEDLE} padding abcdefghij\n`);
    }
    const cut = launch(cutTmp, { CODEXPRO_MAX_OUTPUT_BYTES: "4000" });
    cutChild = cut.child;
    try {
      const cutResult = await cut.search({ query: NEEDLE, max_results: 200 });
      const sc = cutResult.structuredContent;
      const text = contentText(cutResult);
      assert.equal(sc.truncated, true, "evidence-budget cut must truncate");
      assert.equal(sc.coverage.outputLimited, true, "REGRESSION: output-budget cut missing structural fact");
      assert.match(text, /Coverage incomplete: the search evidence exceeded the 4000-byte evidence budget/, "REGRESSION: output-budget cut missing public explanation");
      assert.ok(sc.matches.length > 0, "cut fixture must retain the admitted matches");
    } finally {
      cutChild.kill("SIGKILL");
    }
  } finally {
    await fsp.rm(cutTmp, { recursive: true, force: true });
  }
  console.log("HESTIA_R2_PUBLIC_COVERAGE_PROOF: PASS");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rm(emptyPathDir, { recursive: true, force: true });
}
