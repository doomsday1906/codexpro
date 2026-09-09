// Hestia R2-2 proof: explicit wide-record recovery reconciles fallback line
// identities against admitted matches while preserving total-match evidence.
// Fixture: one short hit (line 1) + one 70,000-character hit (line 2) whose
// rg JSON record exceeds the parser bound.
//   max_results=1 -> line 1 only, truncated=true (2 known, 1 slot);
//   max_results=2 -> lines 1+2, truncated=false, wide text bounded.
// Exercised via direct searchWorkspace, compiled stdio MCP search, and
// structured search (intent text). Direct `node` run must PASS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importBuilt = (rel) => import(pathToFileURL(path.join(projectRoot, "dist", rel)).href);
const NEEDLE = "R2WideNeedleAlpha";
const WIDE_LEN = 70000;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-recovery-"));
let child;
const pending = new Map();
let nextId = 1;
let buffer = "";
try {
  const line1 = `const one = "${NEEDLE}";\n`;
  const line2 = `const two = "${NEEDLE}${"x".repeat(WIDE_LEN)}";\n`;
  await fsp.writeFile(path.join(tmp, "wide.txt"), line1 + line2);

  const check = (label, result, { expectLines, expectTruncated }) => {
    const lines = result.matches.map((m) => m.line);
    assert.deepEqual(lines, expectLines, `${label}: wrong line identities: ${JSON.stringify(lines)}`);
    assert.equal(result.truncated, expectTruncated, `${label}: wrong truncation`);
    for (const m of result.matches) {
      assert.ok(
        Buffer.byteLength(m.text, "utf8") <= 512,
        `${label}: wide text leaked unbounded (${m.line}: ${Buffer.byteLength(m.text, "utf8")}B)`
      );
    }
  };

  // Direct searchWorkspace.
  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { searchWorkspace }] = await Promise.all([
    importBuilt("config.js"), importBuilt("guard.js"), importBuilt("searchOps.js")
  ]);
  const config = loadConfig(["--root", tmp, "--allow-root", tmp, "--bash", "off", "--write", "off"]);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  check("direct mr=1", await searchWorkspace(config, guard, workspace, {
    query: NEEDLE, regex: false, root: "wide.txt", maxResults: 1
  }), { expectLines: [1], expectTruncated: true });
  check("direct mr=2", await searchWorkspace(config, guard, workspace, {
    query: NEEDLE, regex: false, root: "wide.txt", maxResults: 2
  }), { expectLines: [1, 2], expectTruncated: false });

  // Compiled stdio MCP search (+ structured intent text).
  child = spawn(process.execPath, [
    "dist/stdio.js", "--root", tmp, "--allow-root", tmp,
    "--bash", "off", "--write", "off", "--tool-mode", "full"
  ], { cwd: projectRoot, env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp } });
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
  const search = async (args) => {
    const msg = await request("tools/call", { name: "search", arguments: args });
    assert.equal(msg.error, undefined, `search protocol error: ${JSON.stringify(msg.error)}`);
    assert.notEqual(msg.result.isError, true, `search tool error: ${JSON.stringify(msg.result).slice(0, 400)}`);
    return msg.result.structuredContent;
  };
  const mcp1 = await search({ query: NEEDLE, path: "wide.txt", max_results: 1 });
  check("mcp mr=1", mcp1, { expectLines: [1], expectTruncated: true });
  const mcp2 = await search({ query: NEEDLE, path: "wide.txt", max_results: 2 });
  check("mcp mr=2", mcp2, { expectLines: [1, 2], expectTruncated: false });
  const mcpS = await search({ query: NEEDLE, path: "wide.txt", max_results: 2, intent: "text" });
  check("mcp structured mr=2", mcpS, { expectLines: [1, 2], expectTruncated: false });

  console.log("HESTIA_R2_RECOVERY_PROOF: PASS");
} finally {
  if (child) child.kill("SIGKILL");
  await fsp.rm(tmp, { recursive: true, force: true });
}
