// HTTP session reliability hostile matrix (RepoConnect HTTP MCP Session Reliability, TASK-001).
//
// TARGET_PRODUCER: real `dist/http.js` OS child -> Express -> StreamableHTTPServerTransport.
// Each CASE spawns a fresh server with fixture limits, drives real MCP initialize /
// tools-call / DELETE traffic over loopback, and asserts the in-flight-safe lifecycle
// contract (LAW-001..LAW-007): busy sessions are never TTL-expired or capacity-evicted,
// initialization capacity is reserved synchronously, all-busy capacity rejects the NEW
// session with HTTP 503 + bounded JSON-RPC error, and diagnostics stay truthful.
//
// Raw-fetch sessions never open a GET SSE listener, so they are idle the moment their
// POST completes (models fresh ChatGPT-style sessions). SDK clients hold a GET SSE
// listener after connect, so they count as in-flight until closed (LAW-006).
//
// Usage: node scripts/http-session-reliability-smoke.mjs [--only=A,B,C,D,E,F,G,H]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "codexpro-http-reliability-smoke-token-9d4b";
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const ONLY = new Set(
  (onlyArg ? onlyArg.slice("--only=".length) : "A,B,C,D,E,F,G,H").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
);

const results = [];
function record(caseId, name, passed, observations) {
  results.push({ case: caseId, name, verdict: passed ? "PASS" : "FAIL", observations });
  console.log(`CASE-${caseId} ${passed ? "PASS" : "FAIL"} — ${name}`);
  for (const line of observations) console.log(`  obs: ${line}`);
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function spawnServer({ maxSessions = 64, ttlMs = 60000, bashMode = "safe" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-http-rel-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-http-rel-home-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/http.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: "127.0.0.1",
      CODEXPRO_PORT: String(port),
      CODEXPRO_HTTP_TOKEN: TOKEN,
      CODEXPRO_BASH_MODE: bashMode,
      CODEXPRO_WRITE_MODE: "handoff",
      CODEXPRO_TOOL_MODE: "full",
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_MAX_HTTP_SESSIONS: String(maxSessions),
      CODEXPRO_HTTP_SESSION_TTL_MS: String(ttlMs),
      CODEXPRO_HOME: home
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.resume();
  await waitForListening(child);
  return { baseUrl: `http://127.0.0.1:${port}`, child, root, home };
}

function authHeaders(extra = {}) {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
    ...extra
  };
}

function parseRpcEnvelope(text, id) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && parsed.jsonrpc) return parsed;
    } catch { /* fall through to SSE scan */ }
  }
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && parsed.jsonrpc) messages.push(parsed);
    } catch { /* ignore */ }
  }
  if (id !== undefined) {
    const match = messages.find((m) => m.id === id);
    if (match) return match;
  }
  return messages.at(-1);
}

let nextId = 1000;
function allocId() {
  nextId += 1;
  return nextId;
}

// Raw initialize POST. Never throws on HTTP error status: returns {status, body, sessionId, envelope}.
async function rawInitialize(baseUrl, { id = allocId(), params } = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: params ?? {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "reliability-smoke", version: "0.0.0" }
      }
    })
  });
  const body = await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  return { status: response.status, body, sessionId, envelope: parseRpcEnvelope(body, id), id };
}

async function rawInitialized(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });
  await response.text().catch(() => "");
  return response.status;
}

async function rawSession(baseUrl, id) {
  const init = await rawInitialize(baseUrl, { id: id ?? allocId() });
  assert.equal(init.status, 200, `raw initialize failed: ${init.status} ${init.body.slice(0, 300)}`);
  assert.match(init.sessionId ?? "", /^[0-9a-f-]{36}$/i, "raw initialize did not return a UUID session id");
  await rawInitialized(baseUrl, init.sessionId);
  return init.sessionId;
}

async function rawCall(baseUrl, sessionId, method, params = {}, id = allocId()) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.text();
  return { status: response.status, body, envelope: parseRpcEnvelope(body, id), id };
}

async function rawDelete(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: authHeaders({ "mcp-session-id": sessionId })
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

async function rawProbe404(baseUrl, sessionId) {
  return rawCall(baseUrl, sessionId ?? "00000000-0000-4000-8000-000000000000", "tools/list", {});
}

async function connectSdk(baseUrl, label) {
  const client = new Client({ name: `reliability-smoke-${label}`, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport, sessionId: transport.sessionId };
}

async function sdkWorkspaceId(client) {
  const opened = await client.callTool({ name: "open_current_workspace", arguments: { include_tree: false } });
  if (opened.isError) throw new Error(`open_current_workspace failed: ${JSON.stringify(opened.structuredContent)}`);
  return opened.structuredContent.workspace_id;
}

async function diagVia(baseUrl, sessionId) {
  const res = await rawCall(baseUrl, sessionId, "tools/call", {
    name: "session_workspace_diagnostics",
    arguments: {}
  });
  assert.equal(res.status, 200, `diagnostics call failed: ${res.status} ${res.body.slice(0, 200)}`);
  const structured = res.envelope?.result?.structuredContent;
  assert(structured?.http_sessions, "diagnostics omitted http_sessions");
  return structured.http_sessions;
}

// Quiescence: only the polling POST itself is in flight (requests==1, sessions==1).
async function waitForQuiescence(baseUrl, sessionId, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await diagVia(baseUrl, sessionId);
    if (last.in_flight_requests === 1 && last.in_flight_sessions === 1) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: no quiescence (last requests=${last?.in_flight_requests} sessions=${last?.in_flight_sessions})`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT waiting for ${label} after ${ms}ms`)), ms))
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CASE-A: busy + idle + new
async function caseA() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 2, ttlMs: 60000, bashMode: "safe" });
  try {
    const sdkA = await connectSdk(server.baseUrl, "a-busy");
    const wsA = await sdkWorkspaceId(sdkA.client);
    const busyA = sdkA.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsA, max_wait_seconds: 6, poll_ms: 250 }
    });
    await sleep(400);
    const sessionB = await rawSession(server.baseUrl);
    obs.push(`A busy (SDK+GET), B idle raw session established; active=${(await diagVia(server.baseUrl, sessionB)).active}`);
    const sessionC = await rawSession(server.baseUrl);
    obs.push("C initialized while A busy + B idle");
    const resultA = await withTimeout(busyA, 12000, "busy A result");
    obs.push(`A result received: isError=${resultA.isError}`);
    assert.ok(!resultA.isError, "busy A call failed");
    const diag = await diagVia(server.baseUrl, sessionC);
    obs.push(`active=${diag.active} initialized=${diag.total_initialized} closed=${diag.total_closed} evicted=${diag.total_capacity_evicted} prevented=${diag.total_inflight_eviction_prevented}`);
    assert.ok(diag.active <= 2, "retained more than max");
    assert.equal(diag.total_initialized, 3, "expected exactly 3 initializations");
    assert.equal(diag.total_capacity_evicted, 1, "expected exactly one idle capacity eviction (B)");
    assert.equal(diag.total_inflight_eviction_prevented, 1, "expected busy A to be spared exactly once");
    // Evicted B must be gone; C must route.
    const probeB = await rawCall(server.baseUrl, sessionB, "tools/list", {});
    assert.equal(probeB.status, 404, "evicted idle B still routes");
    const probeC = await rawCall(server.baseUrl, sessionC, "tools/list", {});
    assert.equal(probeC.status, 200, "new session C does not route");
    await sdkA.client.close().catch(() => {});
    record("A", "busy+idle+new reclaims idle, protects busy", true, obs);
  } catch (error) {
    record("A", "busy+idle+new reclaims idle, protects busy", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-B: all busy, new rejected
async function caseB() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 2, ttlMs: 60000, bashMode: "safe" });
  try {
    const sdkA = await connectSdk(server.baseUrl, "a-busy");
    const sdkB = await connectSdk(server.baseUrl, "b-busy");
    const wsA = await sdkWorkspaceId(sdkA.client);
    const wsB = await sdkWorkspaceId(sdkB.client);
    const busyA = sdkA.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsA, max_wait_seconds: 6, poll_ms: 250 }
    });
    const busyB = sdkB.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsB, max_wait_seconds: 6, poll_ms: 250 }
    });
    await sleep(400);
    const initC = await rawInitialize(server.baseUrl);
    obs.push(`C initialize status=${initC.status} body=${initC.body.slice(0, 200)}`);
    assert.equal(initC.status, 503, "all-busy initializer was not rejected with 503");
    assert.equal(initC.envelope?.jsonrpc, "2.0", "rejection is not a JSON-RPC envelope");
    assert.equal(initC.envelope?.error?.code, -32002, "rejection code is not -32002");
    assert.equal(initC.envelope?.error?.message, "HTTP session capacity exhausted; retry later", "rejection message mismatch");
    assert.equal(initC.envelope?.id, initC.id, "rejection did not echo the request id");
    assert.equal(initC.sessionId, null, "rejection leaked a session id");
    const resultA = await withTimeout(busyA, 12000, "busy A result");
    const resultB = await withTimeout(busyB, 12000, "busy B result");
    obs.push(`A isError=${resultA.isError} B isError=${resultB.isError}`);
    assert.ok(!resultA.isError, "busy A call failed");
    assert.ok(!resultB.isError, "busy B call failed");
    // NOTE: capacity is full of busy sessions; read diagnostics through A itself.
    const diagA = await (async () => {
      const res = await rawCall(server.baseUrl, sdkA.sessionId, "tools/call", {
        name: "session_workspace_diagnostics",
        arguments: {}
      });
      return res.envelope?.result?.structuredContent?.http_sessions;
    })();
    obs.push(`active=${diagA.active} initialized=${diagA.total_initialized} rejected=${diagA.total_capacity_rejected} evicted=${diagA.total_capacity_evicted} prevented=${diagA.total_inflight_eviction_prevented}`);
    assert.ok(diagA.active <= 2, "retained more than max");
    assert.equal(diagA.total_initialized, 2, "rejected initializer must not materialize a session");
    assert.equal(diagA.total_capacity_rejected, 1, "rejection was not counted");
    assert.equal(diagA.total_capacity_evicted, 0, "a busy session was evicted");
    assert.ok(diagA.total_inflight_eviction_prevented >= 1, "busy protection was not counted");
    await sdkA.client.close().catch(() => {});
    await sdkB.client.close().catch(() => {});
    record("B", "all-busy rejects new initializer, incumbents succeed", true, obs);
  } catch (error) {
    record("B", "all-busy rejects new initializer, incumbents succeed", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-C: TTL while busy (TTL=60s minimum, 70s hold)
async function caseC() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 10, ttlMs: 60000, bashMode: "full" });
  try {
    const sdkA = await connectSdk(server.baseUrl, "a-long");
    const wsA = await sdkWorkspaceId(sdkA.client);
    const startedAt = Date.now();
    const busyA = sdkA.client.callTool(
      {
        name: "bash",
        arguments: { workspace_id: wsA, command: "sleep 70", timeout_ms: 80000 }
      },
      undefined,
      { timeout: 120000 }
    );
    await sleep(5000);
    // Hostile prune pressure while busy and young: must survive.
    for (let i = 0; i < 3; i += 1) {
      await rawProbe404(server.baseUrl);
    }
    obs.push("3 prune-triggering probes sent while A busy+under-TTL; A alive");
    // Wait until A is in flight BEYOND the 60s TTL, then prove it still routes.
    const elapsed1 = Date.now() - startedAt;
    await sleep(Math.max(0, 63000 - elapsed1));
    const midFlight = await rawCall(server.baseUrl, sdkA.sessionId, "tools/list", {});
    obs.push(`A routes at age>${Math.round((Date.now() - startedAt) / 1000)}s (past 60s TTL): status=${midFlight.status}`);
    assert.equal(midFlight.status, 200, "busy A was TTL-expired while in flight");
    const resultA = await withTimeout(busyA, 30000, "long busy A result");
    obs.push(`A result received after ~${Math.round((Date.now() - startedAt) / 1000)}s: isError=${resultA.isError}`);
    assert.ok(!resultA.isError, "long busy A call failed");
    await sdkA.client.close().catch(() => {});
    // Quiescence proves the listener is gone; then a full idle TTL must pass.
    const observer = await rawSession(server.baseUrl);
    await waitForQuiescence(server.baseUrl, observer, "CASE-C quiescence");
    obs.push("quiescence reached (only polling POST in flight)");
    const idleStart = Date.now();
    await sleep(63000);
    await rawProbe404(server.baseUrl);
    const afterTtl = await rawCall(server.baseUrl, sdkA.sessionId, "tools/list", {});
    obs.push(`A after completion + ${Math.round((Date.now() - idleStart) / 1000)}s idle: status=${afterTtl.status}`);
    assert.equal(afterTtl.status, 404, "idle A was not reclaimed after full TTL");
    // NOTE: the pre-wait observer itself is past TTL by now and was lawfully
    // expired by the same prune; read final counters through a fresh session.
    const diag = await diagVia(server.baseUrl, await rawSession(server.baseUrl));
    obs.push(`expired=${diag.total_expired} prevented=${diag.total_inflight_eviction_prevented}`);
    assert.ok(diag.total_expired >= 1, "expiry was not counted");
    assert.ok(diag.total_inflight_eviction_prevented >= 1, "mid-flight TTL protection was not counted");
    record("C", "TTL spares busy, reclaims after full idle TTL", true, obs);
  } catch (error) {
    record("C", "TTL spares busy, reclaims after full idle TTL", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-D: >64 fresh-session churn with protected work
async function caseD() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 64, ttlMs: 60000, bashMode: "safe" });
  const seenIds = [];
  try {
    const sdkA = await connectSdk(server.baseUrl, "a-protected");
    seenIds.push(sdkA.sessionId);
    const wsA = await sdkWorkspaceId(sdkA.client);
    const busyA = sdkA.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsA, max_wait_seconds: 15, poll_ms: 250 }
    });
    await sleep(400);
    const CHURN = 70;
    for (let i = 0; i < CHURN; i += 1) {
      seenIds.push(await rawSession(server.baseUrl));
    }
    obs.push(`${CHURN} fresh sessions initialized while A protected`);
    const resultA = await withTimeout(busyA, 25000, "protected A result");
    obs.push(`protected A result received: isError=${resultA.isError}`);
    assert.ok(!resultA.isError, "protected call failed under churn");
    const probeA = await rawCall(server.baseUrl, sdkA.sessionId, "tools/list", {});
    assert.equal(probeA.status, 200, "protected session lost its response channel");
    const diag = await diagVia(server.baseUrl, seenIds[seenIds.length - 1]);
    obs.push(`active=${diag.active} initialized=${diag.total_initialized} evicted=${diag.total_capacity_evicted} prevented=${diag.total_inflight_eviction_prevented} high_watermark=${diag.high_watermark}`);
    assert.ok(diag.active <= 64, "retained more than max under churn");
    assert.equal(diag.total_initialized, CHURN + 1, "initialization count wrong");
    assert.equal(diag.total_capacity_evicted, CHURN + 1 - 64, "idle reclamation count wrong");
    assert.ok(diag.total_inflight_eviction_prevented >= CHURN + 1 - 64, "busy protection undercounted");
    assert.ok(diag.high_watermark <= 64, "high watermark exceeded max");
    const payload = JSON.stringify(diag);
    for (const id of seenIds) {
      assert.equal(payload.includes(id), false, "diagnostics leaked a routing session id");
    }
    await sdkA.client.close().catch(() => {});
    record("D", "70-session churn protects active channel, stays bounded", true, obs);
  } catch (error) {
    record("D", "70-session churn protects active channel, stays bounded", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-E: concurrent initialization race
// max=4 with two busy incumbents leaves two free slots. Six racers contend.
// Late arrivals may lawfully evict an already-settled idle winner, so the exact
// admit count is interleaving-dependent; the EXACT invariants under every
// interleaving are: admitted+rejected==6, evicted==admitted-2 (every admission
// beyond the 2 free slots evicts exactly one idle), initialized==2+admitted,
// pending returns to zero, incumbents survive.
async function caseE() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 4, ttlMs: 60000, bashMode: "safe" });
  try {
    const sdkA = await connectSdk(server.baseUrl, "a-incumbent");
    const sdkB = await connectSdk(server.baseUrl, "b-incumbent");
    const wsA = await sdkWorkspaceId(sdkA.client);
    const wsB = await sdkWorkspaceId(sdkB.client);
    const busyA = sdkA.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsA, max_wait_seconds: 10, poll_ms: 250 }
    });
    const busyB = sdkB.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsB, max_wait_seconds: 10, poll_ms: 250 }
    });
    await sleep(400);
    obs.push("incumbents A+B busy; 6 initializers race for 2 free slots");
    const racers = await Promise.all(
      Array.from({ length: 6 }, () => rawInitialize(server.baseUrl))
    );
    const ok = racers.filter((r) => r.status === 200);
    const rejected = racers.filter((r) => r.status === 503);
    obs.push(`race outcome: ${ok.length} admitted, ${rejected.length} rejected`);
    assert.equal(ok.length + rejected.length, 6, "a racer got an unexpected verdict");
    assert.ok(ok.length >= 2, "race did not admit at least the free capacity");
    for (const r of rejected) {
      assert.equal(r.envelope?.error?.code, -32002, "race rejection code wrong");
    }
    const resultA = await withTimeout(busyA, 15000, "incumbent A result");
    const resultB = await withTimeout(busyB, 15000, "incumbent B result");
    assert.ok(!resultA.isError, "incumbent A call failed");
    assert.ok(!resultB.isError, "incumbent B call failed");
    // Diagnostics through incumbent A (busy sessions always survive).
    const winnerDiag = await diagVia(server.baseUrl, sdkA.sessionId);
    obs.push(`active=${winnerDiag.active} initialized=${winnerDiag.total_initialized} evicted=${winnerDiag.total_capacity_evicted} rejected=${winnerDiag.total_capacity_rejected} pending=${winnerDiag.pending_initializations}`);
    assert.ok(winnerDiag.active <= 4, "race oversubscribed capacity");
    assert.equal(winnerDiag.active, Math.min(4, 2 + ok.length), "retained count wrong");
    assert.equal(winnerDiag.total_initialized, 2 + ok.length, "initialization accounting wrong");
    assert.equal(winnerDiag.total_capacity_evicted, Math.max(0, ok.length - 2), "eviction accounting wrong");
    assert.equal(winnerDiag.total_capacity_rejected, rejected.length, "rejection count wrong");
    assert.equal(winnerDiag.pending_initializations, 0, "pending reservations leaked");
    const probeA = await rawCall(server.baseUrl, sdkA.sessionId, "tools/list", {});
    const probeB = await rawCall(server.baseUrl, sdkB.sessionId, "tools/list", {});
    assert.equal(probeA.status, 200, "incumbent A did not survive the race");
    assert.equal(probeB.status, 200, "incumbent B did not survive the race");
    await sdkA.client.close().catch(() => {});
    await sdkB.client.close().catch(() => {});
    record("E", "concurrent initializers cannot oversubscribe; reservations exact", true, obs);
  } catch (error) {
    record("E", "concurrent initializers cannot oversubscribe; reservations exact", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-F: initialization failure / abort
async function caseF() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 4, ttlMs: 60000, bashMode: "safe" });
  try {
    const observer = await rawSession(server.baseUrl);
    // F1: structurally invalid initialize (passes routing, fails SDK validation).
    const bad = await rawInitialize(server.baseUrl, { params: { capabilities: {} } });
    obs.push(`invalid initialize status=${bad.status} session=${bad.sessionId ?? "none"}`);
    assert.ok(bad.status !== 200 || bad.envelope?.error, "invalid initialize looked successful");
    assert.equal(bad.sessionId, null, "failed initialize leaked a session id");
    let diag = await diagVia(server.baseUrl, observer);
    assert.equal(diag.pending_initializations, 0, "failed initialize leaked a reservation");
    assert.equal(diag.total_initialized, 1, "failed initialize materialized a session");
    const good = await rawSession(server.baseUrl);
    obs.push("valid initialize after failure succeeded (no capacity leak)");
    void good;
    // F2: best-effort client aborts during initialization.
    let trueAborts = 0;
    let completedBeforeAbort = 0;
    const strays = [];
    for (let i = 0; i < 5; i += 1) {
      const controller = new AbortController();
      const attempt = fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: allocId(),
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "reliability-smoke-abort", version: "0.0.0" }
          }
        }),
        signal: controller.signal
      });
      setTimeout(() => controller.abort(), 2).unref?.();
      try {
        const res = await attempt;
        await res.text().catch(() => {});
        const sid = res.headers.get("mcp-session-id");
        if (sid) {
          completedBeforeAbort += 1;
          strays.push(sid);
        } else {
          trueAborts += 1;
        }
      } catch {
        trueAborts += 1;
      }
      await sleep(200);
    }
    for (const sid of strays) await rawDelete(server.baseUrl, sid).catch(() => {});
    obs.push(`abort attempts: ${trueAborts} client-aborts, ${completedBeforeAbort} completed-before-abort`);
    // NOTE: a client-side abort that lands after the server materialized the
    // session lawfully retains an idle session (reclaimed by TTL/capacity).
    // The leak-sensitive assertions are reservation accounting, exact
    // retained reconciliation, and continued admission.
    const observer2 = await rawSession(server.baseUrl);
    obs.push("fresh observer admitted after abort storm (idle strays evicted if needed)");
    diag = await diagVia(server.baseUrl, observer2);
    obs.push(`pending=${diag.pending_initializations} in_flight_requests=${diag.in_flight_requests} active=${diag.active} initialized=${diag.total_initialized} evicted=${diag.total_capacity_evicted} closed=${diag.total_closed}`);
    assert.equal(diag.pending_initializations, 0, "abort leaked a reservation");
    assert.ok(diag.in_flight_requests >= 0, "negative in-flight counter");
    assert.ok(diag.active <= 4, "retained more than max");
    assert.equal(diag.active + diag.total_closed, diag.total_initialized, "retained/closed reconciliation wrong");
    const final = await rawSession(server.baseUrl);
    void final;
    obs.push("valid initialize after aborts succeeded (no capacity leak)");
    record("F", "failed/aborted initialization releases reservation exactly once", true, obs);
  } catch (error) {
    record("F", "failed/aborted initialization releases reservation exactly once", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-G: DELETE / onclose / request-finally races
async function caseG() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 2, ttlMs: 60000, bashMode: "safe" });
  try {
    const observer = await rawSession(server.baseUrl);
    const sessionX = await rawSession(server.baseUrl);
    const opened = await rawCall(server.baseUrl, sessionX, "tools/call", {
      name: "open_current_workspace",
      arguments: { include_tree: false }
    });
    const wsX = opened.envelope?.result?.structuredContent?.workspace_id;
    assert.ok(wsX, "could not open workspace on X");
    const before = await diagVia(server.baseUrl, observer);
    const busyX = rawCall(server.baseUrl, sessionX, "tools/call", {
      name: "wait_for_handoff",
      arguments: { workspace_id: wsX, max_wait_seconds: 5, poll_ms: 250 }
    });
    await sleep(400);
    const del = await rawDelete(server.baseUrl, sessionX);
    obs.push(`DELETE during in-flight POST: status=${del.status}`);
    assert.equal(del.status, 200, "DELETE during in-flight request failed");
    const settled = await withTimeout(busyX, 10000, "in-flight POST after DELETE");
    obs.push(`in-flight POST settled after DELETE: status=${settled.status}`);
    const probe = await rawCall(server.baseUrl, sessionX, "tools/list", {});
    assert.equal(probe.status, 404, "deleted session still routes");
    const del2 = await rawDelete(server.baseUrl, sessionX);
    assert.equal(del2.status, 404, "double DELETE did not return 404");
    const after = await diagVia(server.baseUrl, observer);
    obs.push(`closed delta=${after.total_closed - before.total_closed} in_flight=${after.in_flight_requests} active=${after.active}`);
    assert.equal(after.total_closed - before.total_closed, 1, "duplicate close accounting");
    assert.equal(after.in_flight_requests, 1, "in-flight counter wrong after races (only polling POST expected)");
    assert.equal(after.active, 1, "retained zombie after DELETE");
    assert.ok(after.in_flight_requests >= 0, "negative in-flight counter");
    record("G", "DELETE/onclose/finally races stay exact", true, obs);
  } catch (error) {
    record("G", "DELETE/onclose/finally races stay exact", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- CASE-H: diagnostics truth
async function caseH() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 3, ttlMs: 60000, bashMode: "safe" });
  const knownIds = [];
  try {
    // Scripted pressure: A busy oldest; R1/R2 idle; R3 evicts R1 (A spared +1).
    const sdkA = await connectSdk(server.baseUrl, "a-oldest");
    knownIds.push(sdkA.sessionId);
    const wsA = await sdkWorkspaceId(sdkA.client);
    const busyA = sdkA.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsA, max_wait_seconds: 8, poll_ms: 250 }
    });
    await sleep(300);
    const r1 = await rawSession(server.baseUrl);
    const r2 = await rawSession(server.baseUrl);
    knownIds.push(r1, r2);
    const r3 = await rawSession(server.baseUrl);
    knownIds.push(r3);
    // B admitted by evicting oldest idle R2... (age order A,R1,R2 -> victim R1? R1 older than R2)
    // Admission for R3: retained A,R1,R2 full -> oldest idle R1 evicted, A spared.
    const sdkB = await connectSdk(server.baseUrl, "b-busy");
    knownIds.push(sdkB.sessionId);
    const wsB = await sdkWorkspaceId(sdkB.client);
    const busyB = sdkB.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsB, max_wait_seconds: 8, poll_ms: 250 }
    });
    await sleep(300);
    // B admission evicted oldest idle R2 (A spared again).
    const sdkC = await connectSdk(server.baseUrl, "c-busy");
    knownIds.push(sdkC.sessionId);
    const wsC = await sdkWorkspaceId(sdkC.client);
    const busyC = sdkC.client.callTool({
      name: "wait_for_handoff",
      arguments: { workspace_id: wsC, max_wait_seconds: 8, poll_ms: 250 }
    });
    await sleep(300);
    // C admission evicted oldest idle R3 (A,B spared... A older than R3: +1).
    const rej = await rawInitialize(server.baseUrl);
    obs.push(`all-busy extra initialize status=${rej.status}`);
    assert.equal(rej.status, 503, "expected rejection when all sessions busy");
    assert.equal(rej.envelope?.error?.code, -32002, "rejection code wrong");
    const resA = await withTimeout(busyA, 15000, "A result");
    const resB = await withTimeout(busyB, 15000, "B result");
    const resC = await withTimeout(busyC, 15000, "C result");
    assert.ok(!resA.isError, "A failed");
    assert.ok(!resB.isError, "B failed");
    assert.ok(!resC.isError, "C failed");
    // Read full diagnostics through C (still attached).
    const res = await rawCall(server.baseUrl, sdkC.sessionId, "tools/call", {
      name: "session_workspace_diagnostics",
      arguments: {}
    });
    const diag = res.envelope?.result?.structuredContent?.http_sessions;
    assert(diag, "diagnostics omitted http_sessions");
    obs.push(`active=${diag.active} idle=${diag.idle} in_flight_sessions=${diag.in_flight_sessions} in_flight_requests=${diag.in_flight_requests} pending=${diag.pending_initializations} high_watermark=${diag.high_watermark}`);
    obs.push(`initialized=${diag.total_initialized} closed=${diag.total_closed} expired=${diag.total_expired} evicted=${diag.total_capacity_evicted} rejected=${diag.total_capacity_rejected} prevented=${diag.total_inflight_eviction_prevented}`);
    // Exact expectations: 6 inits (A,R1,R2,R3,B,C); evicted R1,R2,R3; rejected 1.
    assert.equal(diag.total_initialized, 6, "initialized mismatch");
    assert.equal(diag.total_capacity_evicted, 3, "evicted mismatch");
    assert.equal(diag.total_capacity_rejected, 1, "rejected mismatch");
    assert.equal(diag.total_expired, 0, "expired mismatch");
    assert.equal(diag.total_closed, 3, "closed superset mismatch");
    assert.equal(diag.active, 3, "active mismatch");
    assert.equal(diag.max, 3, "max mismatch");
    // During this read: A,B GETs (2) + C GET+POST (2) = 4 requests on 3 sessions.
    assert.equal(diag.in_flight_sessions, 3, "in_flight_sessions mismatch");
    assert.equal(diag.in_flight_requests, 4, "in_flight_requests mismatch");
    assert.equal(diag.idle, 0, "idle mismatch");
    assert.equal(diag.pending_initializations, 0, "pending mismatch");
    assert.equal(diag.high_watermark, 3, "high_watermark mismatch");
    assert.equal(diag.total_inflight_eviction_prevented, 4, "prevented mismatch (R3-adm, B-adm, C-adm, rejection)");
    for (const field of ["active", "idle", "in_flight_sessions", "in_flight_requests", "pending_initializations", "high_watermark", "total_initialized", "total_closed", "total_expired", "total_capacity_evicted", "total_capacity_rejected", "total_inflight_eviction_prevented"]) {
      assert.ok(diag[field] !== undefined, `diagnostics missing ${field}`);
    }
    const payload = JSON.stringify(res.envelope?.result);
    for (const id of knownIds) {
      assert.equal(payload.includes(id), false, "diagnostics leaked a routing session id");
    }
    assert.equal(payload.includes(TOKEN), false, "diagnostics leaked the auth token");
    await sdkA.client.close().catch(() => {});
    await sdkB.client.close().catch(() => {});
    await sdkC.client.close().catch(() => {});
    record("H", "diagnostics match direct observations, no routing secrets", true, obs);
  } catch (error) {
    record("H", "diagnostics match direct observations, no routing secrets", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

const CASES = { A: caseA, B: caseB, C: caseC, D: caseD, E: caseE, F: caseF, G: caseG, H: caseH };

let failed = 0;
for (const [id, fn] of Object.entries(CASES)) {
  if (!ONLY.has(id)) continue;
  try {
    await fn();
  } catch {
    failed += 1;
  }
}
console.log(`MATRIX_SUMMARY: ${JSON.stringify(results.map((r) => ({ case: r.case, verdict: r.verdict })))}`);
if (failed > 0) {
  console.log(`✗ http session reliability smoke FAILED (${failed} case(s))`);
  process.exit(1);
}
console.log("✓ http session reliability smoke passed");
