// HESTIA_R4_SEARCH_ERROR_ENVELOPE_PROOF: every public search outcome obeys
// the complete serialized-response policy — including errors thrown before a
// normal SearchResult exists (producer diagnostics, spawn failures,
// validation, the success-fitter's own envelope error).
// Covers: mandated 3500-byte-stderr exit-2 reproducer (result + frame within
// policy, agreement, marker, valid JSON/UTF-8); small ordinary producer
// error (classification intact); executable-start failure; minimum-success-
// cannot-fit error (giant query + intent); default policy; multibyte
// diagnostic (no split code point); tiny constant fallback fits the lawful
// minimum (direct unit call at an unlawful budget); wrapper reachability.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

const projectRoot = "/home/andrew/AgentWorkspace/worktrees/codexpro/repoconnect-large-file-surgical-readability/primary";
const SMALL_BUDGET = 4000;
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r4-errenv-"));
const binDir = path.join(tmp, "bin");
await fsp.mkdir(binDir);
await fsp.writeFile(path.join(tmp, "a.txt"), "hello world\n");
try {
  const writeFakeRg = async (name, body) => {
    const p = path.join(binDir, name);
    await fsp.writeFile(p, body);
    await fsp.chmod(p, 0o755);
    return p;
  };
  // Mandated producer: ~3500 harmless ASCII stderr chars, exit 2.
  await writeFakeRg("rg", '#!/bin/sh\nprintf "%3500s" " " | tr " " "E" >&2\necho " rgboom" >&2\nexit 2\n');
  // Small ordinary producer error.
  await writeFakeRg("rg_small", '#!/bin/sh\necho "rg: tiny boom" >&2\nexit 2\n');
  // Executable-start failure: resolvable via PATH but the kernel cannot
  // start it (exec-only script: the shell fallback reports Permission
  // denied). Deterministic producer-start failure through the public tool.
  await writeFakeRg("rg_nostart", '#!/bin/sh\nexit 0\n');
  // Multibyte diagnostic: 2000 e-acute = 4000 stderr bytes, exit 2.
  await writeFakeRg("rg_multi", '#!/bin/sh\npython3 -c "import sys; sys.stderr.write(\'\\u00e9\'*2000)"\nexit 2\n');

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
          pending.get(msg.id)({ msg, raw: line });
          pending.delete(msg.id);
        }
      }
    });
    child.stderr.on("data", () => {});
    const request = (method, params, timeoutMs = 120000) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      timer.unref();
      pending.set(id, (out) => { clearTimeout(timer); resolve(out); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    return {
      child,
      callSearch: async (args) => {
        const { msg, raw } = await request("tools/call", { name: "search", arguments: args });
        assert.equal(msg.error, undefined, `search protocol error: ${JSON.stringify(msg.error)}`);
        return { result: msg.result, raw };
      }
    };
  };
  const assertBoundedError = (result, raw, label, budget) => {
    assert.equal(result.isError, true, `${label}: must be an error result`);
    const size = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(size <= budget, `${label}: serialized ${size} exceeds policy ${budget}`);
    const frame = Buffer.byteLength(raw, "utf8");
    assert.ok(frame <= budget, `${label}: raw frame ${frame} exceeds policy ${budget}`);
    const texts = result.content.filter((p) => p.type === "text").map((p) => p.text);
    assert.equal(texts.length, 1, `${label}: exactly one public text part`);
    assert.equal(texts[0], result.structuredContent.error, `${label}: content and structured error must agree`);
    fatalUtf8.decode(Buffer.from(JSON.stringify(result), "utf8"));
    fatalUtf8.decode(Buffer.from(raw, "utf8"));
    fatalUtf8.decode(Buffer.from(texts[0], "utf8"));
    return texts[0];
  };

  // 1. Mandated reproducer: 3500-byte stderr, exit 2, budget 4000.
  {
    const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET), PATH: `${binDir}:${process.env.PATH}` });
    try {
      const { result, raw } = await callSearch({ query: "hello" });
      const text = assertBoundedError(result, raw, "mandated", SMALL_BUDGET);
      assert.match(text, /truncated/, "mandated: a bounded truncation indication must exist");
      assert.match(text, /^CodexProError: /, "mandated: error classification must survive");
      console.log(`mandated serialized=${Buffer.byteLength(JSON.stringify(result))} frame=${Buffer.byteLength(raw)}`);
    } finally {
      child.kill("SIGKILL");
    }
  }

  // 2. Small ordinary producer error: full classification intact.
  {
    const onlySmall = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r4-errenv-smallbin-"));
    try {
      await fsp.writeFile(path.join(onlySmall, "rg"), '#!/bin/sh\necho "rg: tiny boom" >&2\nexit 2\n');
      await fsp.chmod(path.join(onlySmall, "rg"), 0o755);
      const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET), PATH: `${onlySmall}:/usr/bin:/bin` });
      try {
        const { result, raw } = await callSearch({ query: "hello" });
        const text = assertBoundedError(result, raw, "small-error", SMALL_BUDGET);
        assert.match(text, /rg: tiny boom/, "small-error: ordinary diagnostic must survive intact");
        assert.doesNotMatch(text, /truncated|withheld/, "small-error: fitting detail needs no marker");
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      await fsp.rm(onlySmall, { recursive: true, force: true });
    }
  }

  // 3. Executable-start failure (exec-only script: resolves on PATH, the
  // kernel/shell cannot open it → deterministic Permission denied, exit 2).
  {
    const onlyNoStart = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r4-errenv-nostart-"));
    try {
      await fsp.writeFile(path.join(onlyNoStart, "rg"), '#!/bin/sh\nexit 0\n');
      await fsp.chmod(path.join(onlyNoStart, "rg"), 0o111);
      const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET), PATH: `${onlyNoStart}:/usr/bin:/bin` });
      try {
        const { result, raw } = await callSearch({ query: "hello" });
        const text = assertBoundedError(result, raw, "start-failure", SMALL_BUDGET);
        assert.match(text, /Permission denied/, "start-failure: start-failure classification must survive");
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      await fsp.rm(onlyNoStart, { recursive: true, force: true });
    }
  }

  // 4. Minimum successful response cannot fit (giant lawful query + intent):
  // the success fitter's envelope error itself arrives bounded, with no
  // unbounded query echo.
  {
    const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET) });
    try {
      const giant = `Q${"q".repeat(50_000)}`;
      const { result, raw } = await callSearch({ query: giant, max_results: 200, intent: "text" });
      const text = assertBoundedError(result, raw, "min-unfittable", SMALL_BUDGET);
      assert.match(text, /output envelope/, "min-unfittable: must carry the envelope classification");
      assert.ok(!text.includes(giant.slice(0, 1000)), "min-unfittable: unbounded query must not leak into the error");
    } finally {
      child.kill("SIGKILL");
    }
  }

  // 5. Default policy: small error fully intact, well within budget.
  {
    const onlySmall = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r4-errenv-defbin-"));
    try {
      await fsp.writeFile(path.join(onlySmall, "rg"), '#!/bin/sh\necho "rg: tiny boom" >&2\nexit 2\n');
      await fsp.chmod(path.join(onlySmall, "rg"), 0o755);
      const { child, callSearch } = launch({ PATH: `${onlySmall}:/usr/bin:/bin` });
      try {
        const { result, raw } = await callSearch({ query: "hello" });
        const text = assertBoundedError(result, raw, "default-policy", 120_000);
        assert.match(text, /rg: tiny boom/, "default-policy: diagnostic intact");
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      await fsp.rm(onlySmall, { recursive: true, force: true });
    }
  }

  // 6. Multibyte diagnostic: shrink never splits a UTF-8 code point.
  {
    const onlyMulti = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r4-errenv-multibin-"));
    try {
      await fsp.writeFile(path.join(onlyMulti, "rg"), '#!/bin/sh\npython3 -c "import sys; sys.stderr.write(\'\\u00e9\'*2000)"\nexit 2\n');
      await fsp.chmod(path.join(onlyMulti, "rg"), 0o755);
      const { child, callSearch } = launch({ CODEXPRO_MAX_OUTPUT_BYTES: String(SMALL_BUDGET), PATH: `${onlyMulti}:/usr/bin:/bin` });
      try {
        const { result, raw } = await callSearch({ query: "hello" });
        const text = assertBoundedError(result, raw, "multibyte", SMALL_BUDGET);
        assert.match(text, /truncated/, "multibyte: marker must exist");
      } finally {
        child.kill("SIGKILL");
      }
    } finally {
      await fsp.rm(onlyMulti, { recursive: true, force: true });
    }
  }

  // 7. Tiny constant fallback: direct unit call at an unlawful budget forces
  // the static fallback; it must be exactly the constant and fit the lawful
  // minimum (4000) by construction.
  {
    const server = await import(pathToFileURL(path.join(projectRoot, "dist", "server.js")).href);
    const giant = new Error(`G${"g".repeat(100_000)}`);
    const fb = server.buildSearchErrorResponse({ maxOutputBytes: 100 }, giant);
    assert.equal(fb.isError, true, "fallback: isError");
    const texts = fb.content.filter((p) => p.type === "text").map((p) => p.text);
    assert.deepEqual(texts, ["Search failed: error detail withheld by the output budget."], "fallback: exact static text only");
    assert.equal(fb.structuredContent.error, texts[0], "fallback: fields agree");
    assert.ok(Buffer.byteLength(JSON.stringify(fb), "utf8") <= SMALL_BUDGET, "fallback: fits the lawful minimum");
  }

  // 8. Wrapper reachability: scripts/codexpro.mjs carries no tool-call path
  // to search, so the compiled stdio route above (the same server binary the
  // wrapper launches) is the reachable surface. Tripwire if that changes.
  {
    const wrapper = await fsp.readFile(path.join(projectRoot, "scripts", "codexpro.mjs"), "utf8");
    assert.ok(!wrapper.includes("tools/call"), "wrapper: no MCP tool-call path exists");
  }

  console.log("HESTIA_R4_SEARCH_ERROR_ENVELOPE_PROOF: PASS");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
