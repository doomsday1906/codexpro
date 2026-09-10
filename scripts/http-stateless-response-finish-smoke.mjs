#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCodexProHttpApp, createStatelessResponseCoordinator } from "../dist/http.js";
import { loadConfig } from "../dist/config.js";
import { VerificationManager } from "../dist/verificationOps.js";
import { PtyRunManager } from "../dist/ptyRunManager.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function orderingCase(name, steps, expectedCleanup) {
  let cleanupCount = 0;
  const coordinator = createStatelessResponseCoordinator(async () => {
    cleanupCount += 1;
  });
  for (const step of steps) {
    if (step === "H") coordinator.onHandlerSuccess();
    else if (step === "E") coordinator.onHandlerError();
    else if (step === "F") coordinator.onResponseFinish();
    else if (step === "C") coordinator.onResponseClose();
    else if (step === "A") coordinator.onRequestAborted();
    else if (step === "T") coordinator.terminateAfterError();
    else throw new Error(`${name}: unknown signal ${step}`);
  }
  return (async () => {
    if (expectedCleanup) await coordinator.waitForCleanup();
    else await sleep(0);
    assert.equal(cleanupCount, expectedCleanup ? 1 : 0, `${name}: cleanup count ${cleanupCount}`);
  })();
}

async function runOrderingMatrix() {
  await Promise.all([
    orderingCase("handler-then-finish", ["H", "F"], true),
    orderingCase("finish-then-handler", ["F", "H"], true),
    orderingCase("close-before-handler", ["C", "H"], true),
    orderingCase("handler-then-close-before-finish", ["H", "C"], true),
    orderingCase("handler-finish-close", ["H", "F", "C"], true),
    orderingCase("finish-handler-close", ["F", "H", "C"], true),
    orderingCase("handler-error-then-finish", ["E", "F"], true),
    orderingCase("finish-then-handler-error", ["F", "E"], true),
    orderingCase("handler-error-close", ["E", "C"], true),
    orderingCase("request-abort", ["A"], true),
    orderingCase("committed-error-termination", ["E", "T"], true),
    orderingCase("success-held-before-finish", ["H"], false),
    orderingCase("finish-held-before-handler", ["F"], false)
  ]);
  console.log("RAW_OBSERVATION: coordinator matrix covered both success/error and finish/close/abort orderings; every terminal case cleaned exactly once.");
}

function parseSse(body) {
  const data = body.split(/\r?\n/).find((line) => line.startsWith("data:"));
  return data ? JSON.parse(data.slice(5).trim()) : JSON.parse(body);
}

function rpc(base, message, { throttleMs = 0, timeline } = {}) {
  const payload = JSON.stringify(message);
  const target = new URL(`${base}/mcp`);
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    });
    const chunks = [];
    let chunkCount = 0;
    request.once("error", reject);
    request.once("response", (response) => {
      response.on("data", (chunk) => {
        chunks.push(chunk);
        chunkCount += 1;
        if (throttleMs > 0) {
          response.pause();
          setTimeout(() => response.resume(), throttleMs);
        }
      });
      response.once("end", () => {
        const clientEnd = { event: "client_end", at: Date.now() };
        timeline?.push(clientEnd);
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body,
          envelope: parseSse(body),
          chunkCount,
          complete: response.complete,
          clientEnd
        });
      });
      response.once("error", reject);
    });
    request.end(payload);
  });
}

function setTestEnvironment(fixtureRoot) {
  const keys = [
    "CODEXPRO_ROOT", "CODEXPRO_ALLOWED_ROOTS", "CODEXPRO_HOST", "CODEXPRO_PORT",
    "CODEXPRO_ALLOW_NO_HTTP_TOKEN", "CODEXPRO_HTTP_TOKEN", "CODEBASE_BRIDGE_HTTP_TOKEN",
    "CODEXPRO_HTTP_SESSION_MODE", "CODEXPRO_TOOL_MODE", "CODEXPRO_MAX_READ_BYTES",
    "CODEXPRO_MAX_OUTPUT_BYTES", "CODEXPRO_ANALYSIS"
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.CODEXPRO_ROOT = fixtureRoot;
  process.env.CODEXPRO_ALLOWED_ROOTS = fixtureRoot;
  process.env.CODEXPRO_HOST = "127.0.0.1";
  process.env.CODEXPRO_PORT = "8787";
  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = "1";
  delete process.env.CODEXPRO_HTTP_TOKEN;
  delete process.env.CODEBASE_BRIDGE_HTTP_TOKEN;
  process.env.CODEXPRO_HTTP_SESSION_MODE = "stateless";
  process.env.CODEXPRO_TOOL_MODE = "full";
  process.env.CODEXPRO_MAX_READ_BYTES = "2000000";
  process.env.CODEXPRO_MAX_OUTPUT_BYTES = "2000000";
  process.env.CODEXPRO_ANALYSIS = "0";
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withApp(fixtureRoot, { onStatelessRequestCreated, timeline }, callback) {
  const restoreEnvironment = setTestEnvironment(fixtureRoot);
  const config = loadConfig(["--root", fixtureRoot, "--host", "127.0.0.1"]);
  const verificationManager = new VerificationManager(config);
  const ptyRunManager = new PtyRunManager(config);
  const app = createCodexProHttpApp(config, {
    verificationManager,
    ptyRunManager,
    onStatelessLifecycleEvent: (event) => timeline.push(event),
    onStatelessRequestCreated
  });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({ base, timeline });
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    await Promise.allSettled([verificationManager.close(), ptyRunManager.close()]);
    restoreEnvironment();
  }
}

function countEvents(timeline, event) {
  return timeline.filter((entry) => entry.event === event).length;
}

function assertLifecycleOrder(timeline, { handlerEvent, requireClientEnd = true }) {
  for (const event of [handlerEvent, "response_finish", "listeners_removed", "observer_listeners_removed", "cleanup_start", "transport_close", "server_close", "cleanup_complete"]) {
    assert.equal(countEvents(timeline, event), 1, `${event} did not occur exactly once: ${JSON.stringify(timeline)}`);
  }
  const index = (event) => timeline.findIndex((entry) => entry.event === event);
  assert.ok(index("response_finish") > index(handlerEvent), `${handlerEvent} must settle before finish: ${JSON.stringify(timeline)}`);
  assert.ok(index("listeners_removed") > index("response_finish"), `coordinator listeners were not removed after finish: ${JSON.stringify(timeline)}`);
  assert.ok(index("observer_listeners_removed") < index("response_finish"), `observer listeners were not removed in the response finish boundary: ${JSON.stringify(timeline)}`);
  assert.ok(index("transport_close") > index("response_finish"), `transport closed before finish: ${JSON.stringify(timeline)}`);
  assert.ok(index("server_close") > index("response_finish"), `server closed before finish: ${JSON.stringify(timeline)}`);
  assert.ok(index("cleanup_complete") > index("transport_close") && index("cleanup_complete") > index("server_close"));
  if (requireClientEnd) {
    assert.ok(index("client_end") > index("transport_close"), `client ended before transport close: ${JSON.stringify(timeline)}`);
    assert.ok(index("client_end") > index("server_close"), `client ended before server close: ${JSON.stringify(timeline)}`);
  }
}

async function runRealBackpressure() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-finish-order-"));
  const largeText = ("finish-order-backpressure-line-" + "x".repeat(980) + "\n").repeat(1700);
  await fs.writeFile(path.join(fixtureRoot, "large.txt"), largeText, "utf8");
  const timeline = [];
  try {
    const result = await withApp(fixtureRoot, { timeline }, async ({ base }) => rpc(base, {
      jsonrpc: "2.0",
      id: 101,
      method: "tools/call",
      params: { name: "read", arguments: { path: "large.txt", max_bytes: 1_800_000 } }
    }, { throttleMs: 3, timeline }));
    const bytes = Buffer.byteLength(result.body, "utf8");
    assert.equal(result.status, 200, `large read failed: ${result.body.slice(0, 300)}`);
    assert.equal(result.headers["mcp-session-id"], undefined, "stateless large response exposed a session header");
    assert.equal(result.complete, true, "throttled response did not complete");
    assert.ok(result.chunkCount >= 2, `response did not exercise throttled/backpressure chunks: ${result.chunkCount}`);
    assert.ok(bytes > 1_000_000 && bytes < 2_000_000, `response bytes ${bytes} outside 1-2MB target`);
    assert.equal(result.envelope?.jsonrpc, "2.0");
    assert.equal(result.envelope?.id, 101);
    assert.equal(result.envelope?.result?.structuredContent?.path, "large.txt");
    await sleep(25);
    assertLifecycleOrder(timeline, { handlerEvent: "handler_success" });
    console.log(`RAW_OBSERVATION: real in-process MCP read produced ${bytes} bytes across ${result.chunkCount} throttled chunks; ordered events ${timeline.map((entry) => entry.event).join(" -> ")}; transport/server each closed once after finish and before client end.`);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function runHandlerError() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-finish-error-"));
  const timeline = [];
  try {
    const result = await withApp(fixtureRoot, {
      timeline,
      onStatelessRequestCreated: (transport) => {
        transport.handleRequest = async () => {
          throw new Error("focused handler exception");
        };
      }
    }, async ({ base }) => rpc(base, {
      jsonrpc: "2.0",
      id: 102,
      method: "tools/list",
      params: {}
    }, { timeline }));
    assert.equal(result.status, 500, `handler exception was not completed as 500: ${result.body}`);
    assert.match(result.body, /Internal CodexPro MCP error/);
    await sleep(25);
    assertLifecycleOrder(timeline, { handlerEvent: "handler_error", requireClientEnd: true });
    console.log(`RAW_OBSERVATION: injected real transport handler exception completed HTTP 500; ordered events ${timeline.map((entry) => entry.event).join(" -> ")}; both listener sets and both resources closed exactly once.`);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

await runOrderingMatrix();
await runRealBackpressure();
await runHandlerError();
console.log("PASS stateless response-finish/backpressure smoke");
