// Hestia R2-4 proof: a selected line that fits max_bytes but cannot serialize
// into maxOutputBytes gets the SAME specific output-envelope classification
// on read and read_at_ref (never "range exceeds max_bytes" on the latter).
// Fixture: one complete 60,000-char high-escaping line (each `"` doubles in
// JSON, so ~60KB raw serializes past the 120KB output budget). Assert aligned
// bounded errors and no source echo. Direct `node` run must PASS.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const MARKER = "R2E4ESCAPEMARKER";
const LINE = `${MARKER}${'"'.repeat(60000)}\n`;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-r2-envelope-"));
let child;
const pending = new Map();
let nextId = 1;
let buffer = "";
try {
  await fsp.writeFile(path.join(tmp, "escape.txt"), LINE);
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  execFileSync("git", ["config", "user.email", "r24@invalid"], { cwd: tmp });
  execFileSync("git", ["config", "user.name", "r24"], { cwd: tmp });
  execFileSync("git", ["add", "-A"], { cwd: tmp });
  execFileSync("git", ["commit", "-qm", "r24"], { cwd: tmp });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

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
  const callTool = async (name, args) => {
    const msg = await request("tools/call", { name, arguments: args });
    assert.equal(msg.error, undefined, `${name} protocol error: ${JSON.stringify(msg.error)}`);
    return msg.result;
  };

  const opened = await callTool("open_current_workspace", { include_tree: false });
  const ws = opened.structuredContent.workspace_id;

  const readErr = await callTool("read", { path: "escape.txt" });
  assert.equal(readErr.isError, true, "read must fail the envelope");
  const readText = JSON.stringify(readErr);
  assert.match(readText, /does not fit the configured output envelope/, "read must carry the envelope classification");

  const refErr = await callTool("read_at_ref", { workspace_id: ws, ref: head, path: "escape.txt" });
  assert.equal(refErr.isError, true, "read_at_ref must fail the envelope");
  const refText = JSON.stringify(refErr);
  assert.match(refText, /does not fit the configured output envelope/, "REGRESSION: read_at_ref misclassified the envelope floor");
  assert.doesNotMatch(refText, /exceeds the byte limit/, "read_at_ref must not claim the raw range exceeded max_bytes");

  for (const [label, text] of [["read", readText], ["read_at_ref", refText]]) {
    assert.doesNotMatch(text, new RegExp(MARKER), `${label}: source echo in bounded error`);
    assert.ok(!text.includes('"'.repeat(100)), `${label}: escaped source run in bounded error`);
  }
  console.log("HESTIA_R2_ENVELOPE_PROOF: PASS");
} finally {
  if (child) child.kill("SIGKILL");
  await fsp.rm(tmp, { recursive: true, force: true });
}
