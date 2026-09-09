// Hestia R1 F4 proof: repository with small files plus several files over
// broad admission; the match exists ONLY in an omitted large file. Broad
// lexical (ripgrep AND Node fallback) and structured results must disclose
// incomplete coverage; explicit search of the same file must succeed through
// the bounded route; no unavailable result may use [REDACTED_SECRET].
// Direct `node` run must PASS.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { loadConfig } = await import("../dist/config.js");
const { PathGuard } = await import("../dist/guard.js");
const { searchWorkspace } = await import("../dist/searchOps.js");
const { textScanByteLimit } = await import("../dist/fsOps.js");

const config = loadConfig();
const CEIL = textScanByteLimit(config);
const MARKER = "F4COVERAGEWITNESS7X9";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-coverage-proof-"));
try {
  await fsp.writeFile(path.join(tmp, "small-a.txt"), "nothing relevant here\n");
  await fsp.writeFile(path.join(tmp, "small-b.txt"), "also nothing relevant\n");
  // Three files over broad admission, each with the marker buried.
  for (let i = 0; i < 3; i += 1) {
    const body = `header ${i}\n${"padding line data 0123456789 abcdef\n".repeat(22000)}${MARKER} buried ${i}\n`;
    assert.ok(Buffer.byteLength(body, "utf8") > CEIL, "fixture must exceed broad admission");
    await fsp.writeFile(path.join(tmp, `big-over-${i}.txt`), body);
  }

  const guard = new PathGuard(config);
  const workspace = { id: "coverage-proof", root: tmp };
  const base = { query: MARKER, regex: false, includeHidden: false, maxResults: 10 };

  // 1. Broad lexical via ripgrep (when present) discloses the omission.
  {
    const lex = await searchWorkspace(config, guard, workspace, base);
    assert.equal(lex.matches.length, 0, "omitted files must not yield phantom matches");
    assert.equal(lex.truncated, true, "broad lexical must flag incomplete coverage");
    assert.match(lex.text, /Coverage incomplete: 3 files .* were not searched\./, "bounded omission warning");
    assert.ok(!lex.text.includes("[REDACTED_SECRET]"), "skips must not be secret-labeled");
    console.log(`ok broad lexical (${lex.used}) discloses 3 omitted files`);
  }

  // 2. Broad lexical via the Node fallback discloses the same omission.
  {
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { loadConfig } = await import(${JSON.stringify(path.resolve("dist/config.js"))});
      const { PathGuard } = await import(${JSON.stringify(path.resolve("dist/guard.js"))});
      const { searchWorkspace } = await import(${JSON.stringify(path.resolve("dist/searchOps.js"))});
      const config = loadConfig();
      const guard = new PathGuard(config);
      const r = await searchWorkspace(config, guard, { id: "x", root: ${JSON.stringify(tmp)} }, ${JSON.stringify(base)});
      console.log(JSON.stringify({ used: r.used, matches: r.matches.length, truncated: r.truncated, text: r.text }));
    `], {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent-rg-shadow" },
      maxBuffer: 1 << 20
    });
    assert.equal(probe.status, 0, `fallback child failed: ${probe.stderr.slice(0, 300)}`);
    const r = JSON.parse(probe.stdout.trim().split("\n").pop());
    assert.equal(r.used, "node", "fallback route not exercised");
    assert.equal(r.truncated, true, "broad fallback must flag incomplete coverage");
    assert.match(r.text, /Coverage incomplete: \d+ files could not be fully covered/, "bounded fallback warning");
    console.log("ok broad Node fallback discloses incomplete coverage");
  }

  // 3. Structured search discloses the omission (no complete claim).
  {
    const str = await searchWorkspace(config, guard, workspace, { ...base, intent: "text" });
    const cov = str.analysis.coverage;
    assert.equal(cov.truncated, true, "structured coverage must be truncated");
    assert.equal(cov.oversizedSkippedFiles, 3, "bounded skip count");
    assert.ok(cov.warnings.some((w) => /analysis admission/.test(w)), "bounded admission warning");
    console.log("ok structured coverage discloses 3 omitted files");
  }

  // 4. Explicit search of the same file succeeds through the bounded route.
  {
    const exp = await searchWorkspace(config, guard, workspace, { ...base, root: "big-over-1.txt" });
    assert.ok(exp.matches.length > 0, "explicit bounded search must find the marker");
    assert.ok(exp.matches.every((m) => m.text_status === "available"), "benign witness must be available");
    console.log("ok explicit bounded search succeeds");
  }

  // 5. No unavailable result anywhere uses the secret marker.
  {
    const str = await searchWorkspace(config, guard, workspace, { ...base, intent: "references", root: "big-over-2.txt" });
    const serialized = JSON.stringify(str);
    const unavailableUsesSecretMarker =
      (str.matches ?? []).some((m) => m.text_status === "unavailable" && String(m.text).includes("[REDACTED_SECRET]"));
    assert.equal(unavailableUsesSecretMarker, false, "unavailable must never use the secret marker");
    assert.ok(!serialized.includes("[REDACTED_SECRET]") || str.matches.some((m) => m.text_status === "redacted"), "secret marker only via genuine redaction");
    console.log("ok unavailable/secret marker separation holds");
  }

  console.log("HESTIA_COVERAGE_PROOF: PASS");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
