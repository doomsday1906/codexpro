// HANDSHAKE-FIRST-CALL-001 gate — RepoConnect HTTP MCP Session Churn Continuity R1.
//
// TARGET_PRODUCER: real `dist/http.js` OS child -> Express -> StreamableHTTPServerTransport.
// At maxSessions=3, fully SEQUENTIAL and deterministic (no concurrency at all):
//   S1: initialize -> notifications/initialized -> one tools/list (settled/used)
//   S2: initialize -> notifications/initialized -> one tools/list (settled/used)
//   A:  initialize -> notifications/initialized, NO operation yet (first-use)
//   B:  one additional initialize applies capacity pressure (must reclaim S1)
//   A:  FIRST actual tools/list -> MUST return 200.
//
// Defect under test (HANDSHAKE-FIRST-CALL-001): scoring continuity with a generic
// completed-request count lets initialize + notifications/initialized masquerade as
// application reuse, so A becomes a normal settled eviction candidate before its
// first real operation and B's admission reclaims A instead of older used idle.
// The exact rejected eeba31e candidate FAILS this script (A first call 404/-32001).
//
// Usage: node scripts/http-session-first-use-smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TOKEN = "codexpro-first-use-smoke-token-9f2a";

const obs = [];
function log(line) {
  obs.push(line);
  console.log(`  obs: ${line}`);
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

let nextId = 100;
const allocId = () => { nextId += 1; return nextId; };

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

async function rawInitialize(baseUrl) {
  const id = allocId();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "first-use-smoke", version: "0.0.0" }
      }
    })
  });
  const body = await response.text();
  return { status: response.status, body, sessionId: response.headers.get("mcp-session-id"), envelope: parseRpcEnvelope(body, id) };
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

async function rawCall(baseUrl, sessionId, method, params = {}) {
  const id = allocId();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.text();
  return { status: response.status, body, envelope: parseRpcEnvelope(body, id) };
}

async function toolCall(baseUrl, sessionId, name, args) {
  return rawCall(baseUrl, sessionId, "tools/call", { name, arguments: args });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-first-use-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-first-use-home-"));
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
      CODEXPRO_BASH_MODE: "safe",
      CODEXPRO_WRITE_MODE: "handoff",
      CODEXPRO_TOOL_MODE: "full",
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_MAX_HTTP_SESSIONS: "3",
      CODEXPRO_HTTP_SESSION_TTL_MS: "60000",
      CODEXPRO_HOME: home
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.resume();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForListening(child);

    // S1 + S2: settled (handshake + one real operation each). Capacity 3: one free slot.
    const s1 = await rawInitialize(baseUrl);
    assert.equal(s1.status, 200, `S1 initialize failed: ${s1.status}`);
    assert.equal(await rawInitialized(baseUrl, s1.sessionId), 202, "S1 notification failed");
    const s1call = await rawCall(baseUrl, s1.sessionId, "tools/list", {});
    assert.equal(s1call.status, 200, "S1 first operation failed");
    const s2 = await rawInitialize(baseUrl);
    assert.equal(s2.status, 200, `S2 initialize failed: ${s2.status}`);
    assert.equal(await rawInitialized(baseUrl, s2.sessionId), 202, "S2 notification failed");
    const s2call = await rawCall(baseUrl, s2.sessionId, "tools/list", {});
    assert.equal(s2call.status, 200, "S2 first operation failed");
    log("S1+S2 settled (init+notif+one real op each)");

    // A: handshake only — first-use, no operation yet. Takes the last free slot.
    const aInit = await rawInitialize(baseUrl);
    assert.equal(aInit.status, 200, `A initialize failed: ${aInit.status}`);
    const aSession = aInit.sessionId;
    const aNotif = await rawInitialized(baseUrl, aSession);
    assert.equal(aNotif, 202, `A notification failed: ${aNotif}`);
    log(`A handshake complete, no operation yet (session ${String(aSession).slice(0, 8)}…)`);

    // B: one additional initialize applies capacity pressure (3/3 full).
    const bInit = await rawInitialize(baseUrl);
    assert.equal(bInit.status, 200, `B pressure initialize failed: ${bInit.status}`);
    assert.equal(await rawInitialized(baseUrl, bInit.sessionId), 202, "B notification failed");
    log("B pressure admission complete; exactly one idle session must have been reclaimed");

    // A FIRST actual operation: must survive. This is the R1 gate.
    const aFirst = await rawCall(baseUrl, aSession, "tools/list", {});
    log(`A first actual tools/list: status=${aFirst.status}`);
    assert.equal(aFirst.status, 200, `HANDSHAKE-FIRST-CALL-001: A first real call stranded: ${aFirst.status} ${aFirst.body.slice(0, 200)}`);

    // The reclaimed victim must be the oldest already-used idle (S1), not A or S2.
    const probeS1 = await rawCall(baseUrl, s1.sessionId, "tools/list", {});
    const probeS2 = await rawCall(baseUrl, s2.sessionId, "tools/list", {});
    log(`victim check: S1=${probeS1.status} (expect 404), S2=${probeS2.status} (expect 200)`);
    assert.equal(probeS1.status, 404, "expected oldest used S1 reclaimed instead of first-use A");
    assert.equal(probeS1.envelope?.error?.code, -32001, "stale code wrong");
    assert.equal(probeS2.status, 200, "S2 should survive");

    // Ring truth: exactly one capacity evict, via normal idle reclamation
    // (not the burst-newborn fallback), process healthy and bounded.
    const diagRes = await toolCall(baseUrl, s2.sessionId, "session_workspace_diagnostics", {});
    assert.equal(diagRes.status, 200, "diagnostics call failed");
    const httpSessions = diagRes.envelope?.result?.structuredContent?.http_sessions;
    assert.ok(httpSessions, "diagnostics omitted http_sessions");
    const events = httpSessions.recent_lifecycle_events ?? [];
    const evicts = events.filter((e) => e.event === "capacity_evict");
    log(`ring: ${events.length} exposed (cap 32), capacity_evicted total=${httpSessions.total_capacity_evicted}`);
    assert.equal(httpSessions.total_capacity_evicted, 1, "expected exactly one reclamation");
    assert.ok(evicts.length >= 1, "ring omitted the reclamation");
    assert.equal(evicts.at(-1)?.reason, "idle_reclamation", `reclamation used wrong band: ${evicts.at(-1)?.reason}`);
    assert.ok(events.length <= 32, "exposed ring exceeds bound");
    for (const e of events) {
      if (e.fp !== null) assert.match(e.fp, /^[0-9a-f]{12}$/, "fingerprint shape wrong");
    }
    const payload = JSON.stringify(diagRes.envelope?.result);
    assert.equal(payload.includes(aSession), false, "diagnostics leaked a routing session id");
    assert.equal(payload.includes(TOKEN), false, "diagnostics leaked the auth token");
    assert.equal(child.exitCode, null, "server process died");
  } finally {
    await stopServer(child);
  }
}

try {
  await main();
  console.log("✓ http session first-use (HANDSHAKE-FIRST-CALL-001) smoke passed");
} catch (error) {
  console.log(`REPRODUCER_RESULT: FAIL — ${error.message.slice(0, 500)}`);
  console.log("✗ http session first-use (HANDSHAKE-FIRST-CALL-001) smoke FAILED");
  process.exit(1);
}
