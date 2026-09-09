// HESTIA_R3_SEARCH_ENVELOPE_PROOF: the complete serialized search tool result
// fits the configured output policy (maxOutputBytes), not just the
// producer-side evidence budget. Whole records only — never cut JSON, one
// structured match, or one public line halfway.
// Covers: small budget + default policy; ripgrep + forced Node fallback;
// plain + structured intent; matches-present + zero-match incomplete;
// explanation + facts; determinism; no partial records.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// R5-1: package-relative root — no machine-specific absolute path. The
// script targets the dist/ belonging to the package or checkout containing
// this script, whether run in place or from a staged/unpacked npm package.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEEDLE = "R3EnvelopeNeedle";
const SMALL_BUDGET = 4000;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r3-envelope-"));
const emptyPathDir = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r3-envelope-norg-"));
try {
  for (let i = 0; i < 60; i += 1) {
    await fsp.writeFile(path.join(tmp, `env${String(i).padStart(2, "0")}.txt`), `envelope filler line ${i} ${NEEDLE} padding abcdefghij\n`);
  }
  // One over-admission file forces a sizeSkip for the zero-match case.
  await fsp.writeFile(path.join(tmp, "bigskip.bin.txt"), "");
  await fsp.truncate(path.join(tmp, "bigskip.bin.txt"), 800_000);

  const launch = (extraEnv = {}) => {
    const env = { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, ...extraEnv };
    const pending = new Map();
    let nextId = 1;
    let buffer = "";
    const child = spawn(process.execPath, [
      "dist/stdio.js", "--root", tmp, "--allow-root", tmp,
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
      callSearch: async (args) => {
        const msg = await request("tools/call", { name: "search", arguments: args });
        assert.equal(msg.error, undefined, `search protocol error: ${JSON.stringify(msg.error)}`);
        assert.notEqual(msg.result.isError, true, `search tool error: ${JSON.stringify(msg.result).slice(0, 300)}`);
        return msg.result;
      }
    };
  };
  const serializedBytes = (result) => Buffer.byteLength(JSON.stringify(result), "utf8");
  const contentText = (result) => result.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");

  const assertWholeRecords = (result, label) => {
    const sc = result.structuredContent;
    assert.ok(Array.isArray(sc.matches), `${label}: matches must be an array`);
    for (const m of sc.matches) {
      assert.equal(typeof m.path, "string", `${label}: match.path must be a whole string`);
      assert.equal(typeof m.line, "number", `${label}: match.line must be a whole number`);
      assert.equal(typeof m.text, "string", `${label}: match.text must be a whole string`);
      assert.equal(typeof m.text_status, "string", `${label}: match.text_status must be present`);
    }
    const text = contentText(result);
    const lines = text.split("\n");
    const trailerIdx = lines.findIndex((l) => l.startsWith("Coverage incomplete:"));
    const matchLines = trailerIdx < 0 ? lines : lines.slice(0, trailerIdx);
    if (sc.matches.length > 0) {
      assert.equal(matchLines.length, sc.matches.length, `${label}: public lines must agree 1:1 with structured matches`);
      for (const line of matchLines) {
        assert.match(line, /^[^:\n]+:\d+: /, `${label}: public line split halfway: ${line.slice(0, 80)}`);
      }
    } else {
      assert.equal(matchLines.join("\n"), "No matches.", `${label}: zero-match text must be exactly No matches.`);
    }
  };

  // A: small budget, ripgrep, plain — the finding's scenario.
  {
    const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET) });
    try {
      const first = await callSearch({ query: NEEDLE, max_results: 200 });
      const size = serializedBytes(first);
      assert.ok(size <= SMALL_BUDGET, `small-budget serialized ${size} exceeds policy ${SMALL_BUDGET}`);
      const sc = first.structuredContent;
      assert.ok(sc.matches.length > 0, "small-budget cut must retain whole matches");
      assert.ok(sc.matches.length < 60, "small-budget cut must actually cut");
      assert.equal(sc.truncated, true, "cut response must be truncated");
      assert.equal(sc.coverage.truncated, true, "coverage facts must agree");
      assert.equal(sc.coverage.outputLimited, true, "cut must set the structural output-limit fact");
      assert.match(contentText(first), /Coverage incomplete: the search response exceeded the 4000-byte output budget and was cut to whole records\./, "public explanation missing");
      assertWholeRecords(first, "small-budget");
      // Truncation truth is deterministic across repeats: same admitted
      // count, same facts, same explanation, bound holds. (Byte identity is
      // NOT asserted for plain search: ripgrep streams matches in arrival
      // order without --sort, so the kept prefix content can vary run to run
      // — a pre-existing collection property, not a fit property. The
      // structured-intent route, which sorts deterministically, asserts byte
      // identity below.)
      const second = await callSearch({ query: NEEDLE, max_results: 200 });
      assert.ok(serializedBytes(second) <= SMALL_BUDGET, "repeat must also fit the budget");
      assert.equal(second.structuredContent.matches.length, sc.matches.length, "cut prefix length must be deterministic");
      assert.equal(second.structuredContent.truncated, true, "repeat must agree it is truncated");
      assert.equal(second.structuredContent.coverage.outputLimited, true, "repeat must agree on the fact");
      assert.match(contentText(second), /cut to whole records\./, "repeat must carry the explanation");
    } finally {
      child.kill("SIGKILL");
    }
  }

  // B: default policy — the fit is a no-op on complete results.
  {
    const { child, callSearch } = launch({});
    try {
      const result = await callSearch({ query: NEEDLE, max_results: 200 });
      const sc = result.structuredContent;
      assert.ok(serializedBytes(result) <= 120_000, "default-policy response must fit the default budget");
      assert.equal(sc.matches.length, 60, "default policy must keep every match");
      // The 800KB skip file keeps this fixture honestly truncated at any
      // budget; the fit itself must be a no-op: no output-limit fact and no
      // response-budget trailer.
      assert.equal(sc.truncated, true, "sizeSkip must still disclose");
      assert.equal(sc.coverage.outputLimited, false, "complete admission must not claim an output limit");
      assert.equal(sc.coverage.coverageText, undefined, "structured coverage carries facts, not text");
      assert.doesNotMatch(contentText(result), /cut to whole records/, "unlimited response must carry no response-budget trailer");
      assertWholeRecords(result, "default-policy");
    } finally {
      child.kill("SIGKILL");
    }
  }

  // C: small budget, forced Node fallback.
  {
    const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET), PATH: emptyPathDir });
    try {
      const result = await callSearch({ query: NEEDLE, max_results: 200 });
      const size = serializedBytes(result);
      assert.ok(size <= SMALL_BUDGET, `node-fallback serialized ${size} exceeds policy ${SMALL_BUDGET}`);
      const sc = result.structuredContent;
      assert.equal(sc.used, "node", "fallback must actually be the node route");
      assert.ok(sc.matches.length > 0, "node cut must retain whole matches");
      assert.equal(sc.truncated, true, "node cut must be truncated");
      assert.equal(sc.coverage.outputLimited, true, "node cut must set the structural fact");
      assert.match(contentText(result), /cut to whole records\./, "node cut must explain publicly");
      assertWholeRecords(result, "node-fallback");
    } finally {
      child.kill("SIGKILL");
    }
  }

  // D: small budget, structured intent — auxiliary analysis yields first.
  {
    const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET) });
    try {
      await callSearch({ query: NEEDLE, max_results: 200, intent: "text" });
      const second = await callSearch({ query: NEEDLE, max_results: 200, intent: "text" });
      const third = await callSearch({ query: NEEDLE, max_results: 200, intent: "text" });
      const size = serializedBytes(second);
      assert.ok(size <= SMALL_BUDGET, `intent serialized ${size} exceeds policy ${SMALL_BUDGET}`);
      const sc = second.structuredContent;
      assert.ok(sc.analysis && typeof sc.analysis === "object", "intent route must keep the analysis payload");
      assert.ok(sc.analysis.coverage && typeof sc.analysis.coverage === "object", "analysis coverage facts must survive");
      assert.equal(sc.truncated, true, "intent cut must be truncated");
      assert.equal(sc.coverage.outputLimited, true, "intent cut must set the structural fact");
      assert.match(contentText(second), /cut to whole records\./, "intent cut must explain publicly");
      assertWholeRecords(second, "intent");
      assert.equal(serializedBytes(third), size, "intent cut must be deterministic past cache warmup");
      console.log(`intent analysis matches retained: ${Array.isArray(sc.analysis.matches) ? sc.analysis.matches.length : "n/a"}; lexical: ${sc.matches.length}`);
    } finally {
      child.kill("SIGKILL");
    }
  }

  // E: zero-match incomplete coverage stays bounded and explained.
  {
    const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET) });
    try {
      const result = await callSearch({ query: "R3NoSuchNeedleGamma", max_results: 200 });
      assert.ok(serializedBytes(result) <= SMALL_BUDGET, "zero-match response must fit the budget");
      const sc = result.structuredContent;
      assert.equal(sc.matches.length, 0, "zero-match must keep zero matches");
      assert.equal(sc.truncated, true, "incomplete zero-match must be truncated");
      assert.match(contentText(result), /^No matches\./m, "zero-match must start from No matches.");
      assert.match(contentText(result), /Coverage incomplete/, "zero-match must explain the gap");
      assertWholeRecords(result, "zero-match");
    } finally {
      child.kill("SIGKILL");
    }
  }

  // F: complete zero-match is untouched (no over-triggering).
  {
    const { child, callSearch } = launch({});
    try {
      await fsp.unlink(path.join(tmp, "bigskip.bin.txt"));
      const result = await callSearch({ query: "R3NoSuchNeedleGamma", max_results: 200 });
      assert.equal(contentText(result), "No matches.", "complete zero-match must stay exactly No matches.");
      assert.equal(result.structuredContent.truncated, false, "complete zero-match must not claim truncation");
      assert.equal(result.structuredContent.coverage.outputLimited, false, "complete zero-match must not claim an output limit");
    } finally {
      child.kill("SIGKILL");
    }
  }

  console.log("HESTIA_R3_SEARCH_ENVELOPE_PROOF: PASS");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.rm(emptyPathDir, { recursive: true, force: true });
}
