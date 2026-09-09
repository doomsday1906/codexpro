// Hestia R1 F5 proof: the final serialized MCP response independently fits the
// output policy even though max_bytes (raw numbered-window budget) exceeds
// maxOutputBytes. Measures exact serialized tools/call result bytes AND raw
// stdio transport frames for read / read_many / read_at_ref, exercises
// redaction-expansion lines, and verifies continuation is deterministic and
// non-overlapping. Direct `node` run must PASS.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { loadConfig } = await import("../dist/config.js");
const config = loadConfig();
assert.ok(
  config.maxReadBytes > config.maxOutputBytes,
  `F5 needs maxReadBytes > maxOutputBytes, got ${config.maxReadBytes}/${config.maxOutputBytes}`
);
const POLICY = config.maxOutputBytes;
const RESERVE = 2048; // must match READ_SINGLE_RESPONSE_RESERVE_BYTES in src/server.ts

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-envelope-proof-"));
let child;
try {
  // Benign file sized so one unbounded page approaches the raw budget.
  await fsp.writeFile(
    path.join(tmp, "big.txt"),
    "benign envelope witness line padding 0123456789 abcdefgh\n".repeat(4000)
  );
  // Short-raw lines whose redaction expands into markers (each raw ~9B).
  const exp = [];
  for (let i = 0; i < 6000; i += 1) exp.push(`api_token${i}="v"\n`);
  await fsp.writeFile(path.join(tmp, "expand.txt"), exp.join(""));
  // Disposable Git repo for read_at_ref.
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  execFileSync("git", ["config", "user.email", "f5@invalid"], { cwd: tmp });
  execFileSync("git", ["config", "user.name", "f5"], { cwd: tmp });
  execFileSync("git", ["add", "-A"], { cwd: tmp });
  execFileSync("git", ["commit", "-qm", "f5"], { cwd: tmp });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  child = spawn(process.execPath, [
    "dist/stdio.js", "--root", tmp, "--allow-root", tmp,
    "--bash", "off", "--write", "off", "--tool-mode", "full"
  ], { cwd: path.resolve("."), env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp } });
  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  let maxFrameBytes = 0;
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!rawLine.trim()) continue;
      maxFrameBytes = Math.max(maxFrameBytes, Buffer.byteLength(rawLine, "utf8"));
      const message = JSON.parse(rawLine);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
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
    assert.notEqual(msg.result.isError, true, `${name} tool error: ${JSON.stringify(msg.result).slice(0, 300)}`);
    return msg.result;
  };

  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "envelope-proof", version: "0.1.0" } });
  const opened = await callTool("open_current_workspace", { include_tree: false });
  const ws = opened.structuredContent.workspace_id;

  const checkEnvelope = (label, result) => {
    const serialized = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(
      serialized + RESERVE <= POLICY,
      `${label}: serialized ${serialized} + reserve exceeds policy ${POLICY}`
    );
    return serialized;
  };

  // 1-2. Unbounded read pages (benign + redaction-expansion) fit the envelope.
  const big = await callTool("read", { workspace_id: ws, path: "big.txt" });
  const bigBytes = checkEnvelope("read big.txt", big);
  assert.ok(big.structuredContent.text.includes("benign envelope witness"), "body missing");
  assert.ok(typeof big.structuredContent.nextStartLine === "number", "continuation missing");
  // returnedBytes still means UTF-8 bytes of the public source body.
  assert.equal(
    big.structuredContent.returnedBytes,
    Buffer.byteLength(big.structuredContent.text, "utf8"),
    "returnedBytes must equal public body bytes"
  );
  console.log(`ok read benign page serialized=${bigBytes} lines=${big.structuredContent.startLine}-${big.structuredContent.endLine}`);

  const expanded = await callTool("read", { workspace_id: ws, path: "expand.txt" });
  const expBytes = checkEnvelope("read expand.txt", expanded);
  assert.ok(expanded.structuredContent.text.includes("[REDACTED_SECRET]"), "expansion marker missing: fixture did not expand");
  console.log(`ok read expansion page serialized=${expBytes} lines=${expanded.structuredContent.startLine}-${expanded.structuredContent.endLine}`);

  // 3. Continuation is deterministic and non-overlapping; every page fits.
  {
    let start;
    const seen = new Set();
    let pages = 0;
    for (;;) {
      const page = await callTool("read", { workspace_id: ws, path: "big.txt", ...(start === undefined ? {} : { start_line: start }) });
      checkEnvelope(`read big.txt page ${pages + 1}`, page);
      const sc = page.structuredContent;
      for (let l = sc.startLine; l <= sc.endLine; l += 1) {
        assert.ok(!seen.has(l), `overlap at line ${l}`);
        seen.add(l);
      }
      pages += 1;
      if (sc.nextStartLine === undefined) break;
      start = sc.nextStartLine;
      assert.ok(pages < 20, "page explosion");
    }
    assert.equal(seen.size, 4001, "continuation must cover the whole file");
    console.log(`ok continuation chains ${pages} pages over 4001 lines without overlap`);
  }

  // 4. read_many aggregate fits its own budget — with real content and with
  // an over-budget large item (bounded item error + cursor, never truncation).
  {
    const fitting = await callTool("read_many", {
      workspace_id: ws,
      items: [
        { path: "big.txt", start_line: 1, end_line: 10 },
        { path: "expand.txt", start_line: 1, end_line: 10 }
      ],
      max_total_bytes: 90000
    });
    const fittingBytes = Buffer.byteLength(JSON.stringify(fitting), "utf8");
    assert.ok(fittingBytes <= 90000, `read_many serialized ${fittingBytes} exceeds its budget`);
    assert.ok(fitting.structuredContent.results.length === 2, "both items must be served");
    const pressured = await callTool("read_many", {
      workspace_id: ws,
      items: [{ path: "big.txt" }],
      max_total_bytes: 90000
    });
    const pressuredBytes = Buffer.byteLength(JSON.stringify(pressured), "utf8");
    assert.ok(pressuredBytes <= 90000, `pressured read_many serialized ${pressuredBytes} exceeds its budget`);
    console.log(`ok read_many aggregate serialized=${fittingBytes}/${pressuredBytes}`);
  }

  // 5. read_at_ref unbounded page fits the envelope with immutable metadata.
  {
    const ref = await callTool("read_at_ref", { workspace_id: ws, ref: head, path: "big.txt" });
    const refBytes = checkEnvelope("read_at_ref big.txt", ref);
    assert.equal(ref.structuredContent.returned_bytes, Buffer.byteLength(ref.structuredContent.text, "utf8"));
    assert.ok(typeof ref.structuredContent.blob_sha === "string", "immutable metadata missing");
    console.log(`ok read_at_ref page serialized=${refBytes}`);
  }

  // 6. Raw transport frames (JSON-RPC lines) stay within policy: the reserve
  // is pure margin, not load-bearing.
  assert.ok(maxFrameBytes <= POLICY, `transport frame ${maxFrameBytes} exceeds policy ${POLICY}`);
  console.log(`ok raw transport frames bounded (max ${maxFrameBytes} <= ${POLICY})`);

  console.log("HESTIA_ENVELOPE_PROOF: PASS");
} finally {
  try {
    child?.kill("SIGTERM");
  } catch {}
  await fsp.rm(tmp, { recursive: true, force: true });
}
