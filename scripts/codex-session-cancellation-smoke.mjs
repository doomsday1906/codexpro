import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-session-cancel-"));
const historyRoot = path.join(fixtureRoot, "history");
const sessionDir = path.join(historyRoot, "sessions", "2026", "10", "03");
await fs.mkdir(sessionDir, { recursive: true });
const sessionId = "019cc369-bd7c-7891-b371-7b20b4fe0b18";
const sourcePath = path.join(sessionDir, "rollout-2026-10-03T12-00-00-" + sessionId + ".jsonl");

function jsonl(value) {
  return JSON.stringify(value);
}
function metaLine(id) {
  return jsonl({
    timestamp: "2026-10-03T12:00:00Z",
    type: "session_meta",
    payload: { id, cwd: fixtureRoot, title: "Synthetic cancellation fixture" }
  });
}
function messageLine(role, content, second) {
  return jsonl({
    timestamp: "2026-10-03T12:00:" + String(second).padStart(2, "0") + "Z",
    type: "response_item",
    payload: { type: "message", role, content }
  });
}
const firstMessage = messageLine("user", "Synthetic first message", 1);
const lastMessage = messageLine("assistant", "Synthetic latest message", 2);
const smallLines = [metaLine(sessionId), jsonl({ type: "event", payload: { note: "ignored" } }), firstMessage, lastMessage];
const smallSource = smallLines.join("\n") + "\n";
await fs.writeFile(sourcePath, smallSource, "utf8");

function syntheticNoiseText(length, seed) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = 97 + ((index * 17 + Math.floor(index / 97) + seed) % 26);
  }
  return bytes.toString("ascii");
}
const noiseBlock = [0, 1].map((ordinal) =>
  jsonl({ type: "event", payload: { ordinal, note: syntheticNoiseText(600_000, ordinal) } })
).join("\n") + "\n";
const largeSessionId = "019cc368-1111-7222-8333-123456789abc";
const largePath = path.join(sessionDir, "rollout-2026-10-03T12-01-00-" + largeSessionId + ".jsonl");
const alignedSessionId = "019cc367-aaaa-7bbb-8ccc-123456789abc";
const alignedTailPath = path.join(sessionDir, "rollout-2026-10-03T12-02-00-" + alignedSessionId + ".jsonl");
const alignedTailBlockBytes = 64 * 1024;
const alignedTargetLine = messageLine("assistant", "Synthetic aligned tail message", 4);
const alignedPrefix = metaLine(alignedSessionId) + "\n" +
  jsonl({ type: "event", payload: { note: "synthetic boundary prefix" } });
const alignedRows = [alignedTargetLine];
let alignedTailSuffix = "\n" + alignedRows.join("\n");
function alignmentEvent(ordinal, note) {
  return jsonl({ type: "event", payload: { ordinal, note } });
}
const alignmentBaseEvent = alignmentEvent(999_999, "");
let alignmentOrdinal = 0;
while (alignedTailBlockBytes - Buffer.byteLength(alignedTailSuffix, "utf8") >
  Buffer.byteLength(alignmentBaseEvent, "utf8") + 100) {
  alignedRows.unshift(alignmentEvent(alignmentOrdinal++, "synthetic tail padding " + alignmentOrdinal));
  alignedTailSuffix = "\n" + alignedRows.join("\n");
}
const alignmentNoteBytes = alignedTailBlockBytes -
  Buffer.byteLength(alignedTailSuffix, "utf8") -
  Buffer.byteLength(alignmentBaseEvent, "utf8") - 1;
const alignmentFiller = alignmentEvent(999_999, "x".repeat(alignmentNoteBytes));
alignedRows.unshift(alignmentFiller);
alignedTailSuffix = "\n" + alignedRows.join("\n");
assert.equal(Buffer.byteLength(alignedTailSuffix, "utf8"), alignedTailBlockBytes);
assert.equal(alignedTailSuffix[0], "\n");
const alignedTailSource = alignedPrefix + alignedTailSuffix;
assert.equal(
  Buffer.byteLength(alignedTailSource, "utf8") - alignedTailBlockBytes,
  Buffer.byteLength(alignedPrefix, "utf8")
);
assert.equal(alignedTailSource[Buffer.byteLength(alignedPrefix, "utf8")], "\n");
await fs.writeFile(alignedTailPath, alignedTailSource, "utf8");

function largeSource(layout) {
  const meta = metaLine(largeSessionId) + "\n";
  const target = messageLine("user", "Synthetic scan target", 3) + "\n";
  if (layout === "head") return meta + noiseBlock + target;
  if (layout === "tail") return meta + target + noiseBlock;
  if (layout === "empty") return meta + noiseBlock;
  throw new Error("unknown synthetic session layout");
}

class McpStdioClient {
  constructor() {
    this.child = spawn(process.execPath, ["dist/stdio.js", "--root", fixtureRoot, "--allow-root", fixtureRoot, "--tool-mode", "full"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        CODEXPRO_ROOT: fixtureRoot,
        CODEXPRO_ALLOWED_ROOTS: fixtureRoot,
        CODEXPRO_CODEX_DIR: historyRoot,
        CODEXPRO_CODEX_SESSIONS: "read",
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_LOG_TOOL_CALLS: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrBuffer = "";
    this.logs = [];
    this.logWaiters = [];
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => this.onStderr(String(chunk)));
    this.child.on("exit", (code) => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("CodexPro stdio server exited " + code));
      }
      this.pending.clear();
      for (const waiter of this.logWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("CodexPro stdio server exited before logging tool completion"));
      }
      this.logWaiters = [];
    });
  }
  onStderr(chunk) {
    this.stderrBuffer += chunk;
    while (true) {
      const newline = this.stderrBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      this.logs.push(line);
      for (const waiter of [...this.logWaiters]) {
        if (this.logs.length <= waiter.afterIndex || !waiter.predicate(line)) continue;
        this.logWaiters = this.logWaiters.filter((item) => item !== waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      }
    }
  }
  waitForLog(afterIndex, predicate, timeoutMs = 5_000) {
    const existing = this.logs.slice(afterIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { afterIndex, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.logWaiters = this.logWaiters.filter((item) => item !== waiter);
        reject(new Error("Timed out waiting for a CodexPro tool completion log"));
      }, timeoutMs);
      this.logWaiters.push(waiter);
    });
  }
  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const item = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error(message.error.message));
        else item.resolve(message.result);
      }
    }
  }
  startRequest(method, params, timeoutMs = 12_000) {
    const id = this.nextId++;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error("Timed out waiting for " + method));
    }, timeoutMs);
    this.pending.set(id, { resolve, reject, timer });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return { id, promise };
  }
  request(method, params, timeoutMs) {
    return this.startRequest(method, params, timeoutMs).promise;
  }
  call(name, args, timeoutMs) {
    return this.startRequest("tools/call", { name, arguments: args }, timeoutMs);
  }
  cancel(requestId) {
    this.child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId, reason: "synthetic cancellation proof" }
    }) + "\n");
    const pending = this.pending.get(requestId);
    if (pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error("request cancelled locally by test harness"));
    }
  }
  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const exited = once(this.child, "exit");
    let timeout;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("stdio server did not exit after input EOF")), 5_000);
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

let client;
let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    passed += 1;
    process.stdout.write("PASS " + name + "\n");
  } catch (error) {
    failed += 1;
    process.stderr.write("FAIL " + name + ": " + String(error?.message ?? error) + "\n");
  }
}
function assertPage(result, direction, expectedContent, expectedCursor, expectedResume, expectedHasMore) {
  assert.equal(result.isError, undefined, "session read returned an MCP error");
  const value = result.structuredContent;
  assert.equal(value.direction, direction);
  assert.deepEqual(value.messages.map((message) => message.content), [expectedContent]);
  assert.equal(value.cursor, expectedCursor);
  assert.equal(value.resume_cursor, expectedResume);
  assert.equal(value.next_cursor, expectedResume);
  assert.equal(value.has_more, expectedHasMore);
  assert.equal(value.source_size_bytes, Buffer.byteLength(smallSource, "utf8"));
}

try {
  process.env.CODEXPRO_CODEX_DIR = historyRoot;
  process.env.CODEXPRO_CODEX_SESSIONS = "read";
  const { loadConfig } = await import("../dist/config.js");
  const { readCodexSession } = await import("../dist/codexSessions.js");
  const config = loadConfig([
    "--root", fixtureRoot,
    "--allow-root", fixtureRoot,
    "--tool-mode", "full"
  ]);

  client = new McpStdioClient();
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "codexpro-session-cancellation-smoke", version: "0.1.0" }
  });
  client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  const catalog = await client.request("tools/list", {});
  const toolNames = catalog.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("read_codex_session"), "ordinary session read tool is absent");
  assert.ok(toolNames.includes("codexpro"), "compatibility supertool is absent");

  const firstStart = Buffer.byteLength(smallLines.slice(0, 2).join("\n") + "\n", "utf8");
  const firstEnd = firstStart + Buffer.byteLength(firstMessage + "\n", "utf8");
  const latestStart = Buffer.byteLength(smallLines.slice(0, 3).join("\n") + "\n", "utf8");
  const sourceSize = Buffer.byteLength(smallSource, "utf8");

  await check("uncancelled ordinary head page preserves exact messages and cursors", async () => {
    const logStart = client.logs.length;
    const result = await client.request("tools/call", {
      name: "read_codex_session",
      arguments: { source_path: sourcePath, direction: "head", max_messages: 1 }
    });
    assertPage(result, "head", "Synthetic first message", 0, firstEnd, true);
    const outcome = await client.waitForLog(logStart, (line) => line.startsWith("[CodexProTool] read_codex_session "));
    assert.match(outcome, /\bok\b/u, "uncancelled head handler did not complete successfully");
  });
  await check("uncancelled ordinary tail page preserves exact messages and cursors", async () => {
    const logStart = client.logs.length;
    const result = await client.request("tools/call", {
      name: "read_codex_session",
      arguments: { source_path: sourcePath, direction: "tail", max_messages: 1 }
    });
    assertPage(result, "tail", "Synthetic latest message", sourceSize, latestStart, true);
    const outcome = await client.waitForLog(logStart, (line) => line.startsWith("[CodexProTool] read_codex_session "));
    assert.match(outcome, /\bok\b/u, "uncancelled tail handler did not complete successfully");
  });

  await check("pre-aborted session read stops before scanning", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      readCodexSession(config, { sourcePath, direction: "head", signal: controller.signal }),
      (error) => error?.name === "AbortError"
    );
  });

  async function cancelRoute(label, toolName, args, direction) {
    await fs.writeFile(largePath, largeSource(direction), "utf8");
    const logStart = client.logs.length;
    const call = client.call(toolName, args(largePath, direction), 15_000);
    const locallySettled = call.promise.catch(() => undefined);
    const heartbeat = client.call("server_config", {}, 5_000);
    let heartbeatError;
    try {
      await heartbeat.promise;
    } catch (error) {
      heartbeatError = error;
    }
    const scanCompletedBeforeHeartbeat = client.logs.slice(logStart)
      .some((line) => line.startsWith("[CodexProTool] " + toolName + " "));
    client.cancel(call.id);
    await locallySettled;
    const outcome = await client.waitForLog(
      logStart,
      (line) => line.startsWith("[CodexProTool] " + toolName + " ")
    );
    assert.equal(
      heartbeatError,
      undefined,
      label + " scan blocked the server heartbeat: " + String(heartbeatError?.message ?? heartbeatError)
    );
    assert.equal(
      scanCompletedBeforeHeartbeat,
      false,
      label + " completed before the heartbeat, so cancellation was not during an active scan"
    );
    assert.match(
      outcome,
      /\berror\b/u,
      label + " handler completed without observing request cancellation: " + outcome
    );
  }

  const directArgs = (file, direction) => ({
    source_path: file,
    direction,
    max_messages: 1
  });
  const wrappedArgs = (file, direction) => ({
    action: "read_codex_session",
    args: directArgs(file, direction)
  });
  await check("ordinary MCP route cancels a head scan", () =>
    cancelRoute("ordinary head", "read_codex_session", directArgs, "head"));
  await check("ordinary MCP route cancels a tail scan", () =>
    cancelRoute("ordinary tail", "read_codex_session", directArgs, "tail"));
  await check("compatibility supertool route cancels a head scan", () =>
    cancelRoute("supertool head", "codexpro", wrappedArgs, "head"));
  await check("compatibility supertool route cancels a tail scan", () =>
    cancelRoute("supertool tail", "codexpro", wrappedArgs, "tail"));

  await check("server event loop answers while a substantial session read is scanning", async () => {
    await fs.writeFile(largePath, largeSource("empty"), "utf8");
    const order = [];
    const readCall = client.call("read_codex_session", {
      source_path: largePath,
      direction: "head",
      max_messages: 1
    }, 15_000);
    const readResult = readCall.promise.then((value) => {
      order.push("read");
      return value;
    });
    await delay(1);
    const heartbeat = client.call("server_config", {}, 5_000);
    const heartbeatResult = heartbeat.promise.then((value) => {
      order.push("heartbeat");
      return value;
    });
    const [read, beat] = await Promise.all([readResult, heartbeatResult]);
    assert.equal(read.isError, undefined, "substantial session read returned an MCP error");
    assert.ok(beat.structuredContent, "server heartbeat returned no structured result");
    assert.ok(order.indexOf("heartbeat") >= 0 && order.indexOf("heartbeat") < order.indexOf("read"),
      "server_config did not complete before the substantial session read");
  });

  await check("ordinary tail read handles a newline at the aligned 64 KiB block start", async () => {
    const sourceSize = Buffer.byteLength(alignedTailSource, "utf8");
    const targetStart = sourceSize - Buffer.byteLength(alignedTargetLine, "utf8");
    assert.equal(sourceSize - alignedTailBlockBytes, Buffer.byteLength(alignedPrefix, "utf8"));
    assert.equal(alignedTailSource[sourceSize - alignedTailBlockBytes], "\n");
    const logStart = client.logs.length;
    const result = await client.request("tools/call", {
      name: "read_codex_session",
      arguments: { source_path: alignedTailPath, direction: "tail", max_messages: 1 }
    }, 3_000);
    assert.equal(result.isError, undefined, "aligned tail session read returned an MCP error");
    assert.equal(result.structuredContent.direction, "tail");
    assert.deepEqual(result.structuredContent.messages.map((message) => message.content), [
      "Synthetic aligned tail message"
    ]);
    assert.equal(result.structuredContent.cursor, sourceSize);
    assert.equal(result.structuredContent.resume_cursor, targetStart);
    assert.equal(result.structuredContent.next_cursor, null);
    assert.equal(result.structuredContent.has_more, false);
    assert.equal(result.structuredContent.source_size_bytes, sourceSize);
    const outcome = await client.waitForLog(logStart,
      (line) => line.startsWith("[CodexProTool] read_codex_session "));
    assert.match(outcome, /\bok\b/u, "aligned tail read did not complete successfully");
  });

  process.stdout.write("SESSION_READ_CANCELLATION_MATRIX: " + passed + "/" + (passed + failed) + " checks passed; " + failed + " failed.\n");
} finally {
  if (client) await client.close().catch((error) => {
    process.stderr.write("stdio cleanup: " + String(error?.message ?? error) + "\n");
  });
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
if (failed > 0) process.exitCode = 1;
