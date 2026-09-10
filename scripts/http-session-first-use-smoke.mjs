// First-use protection regressions — RepoConnect HTTP MCP Session Churn Continuity.
//
// TARGET_PRODUCER: real `dist/http.js` OS child -> Express -> StreamableHTTPServerTransport.
//
// TEST A (HANDSHAKE-FIRST-CALL-001, maxSessions=3, fully sequential):
//   S1: initialize -> notifications/initialized -> one tools/list (settled/used)
//   S2: initialize -> notifications/initialized -> one tools/list (settled/used)
//   A:  initialize -> notifications/initialized, NO operation yet (first-use)
//   B:  one additional initialize applies capacity pressure (must reclaim S1)
//   A:  FIRST actual tools/list -> MUST return 200.
//
// TEST B (FIRST-USE-GRACE-RENEWAL-001, maxSessions=2, real elapsed time):
//   U: handshake + one real operation (settled/used).
//   P: handshake but no real operation; ping every 2s for >12s (> 10s grace).
//   N: one new initialize applies capacity pressure (no ping in flight).
//   Required: P reclaimed (404/-32001 on later use, ring score 0,
//   reason idle_reclamation), U stays routable, N admits cleanly (no 503).
//   Protocol pings must not renew the fixed first-use deadline.
//
// Usage: node scripts/http-session-first-use-smoke.mjs [A|B]  (default: both)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TOKEN = "codexpro-first-use-smoke-token-9f2a";
// First-use grace mirrors the server's FIRST_USE_GRACE_MS (10s). Test B must run
// protocol chatter strictly past this boundary using real elapsed time.
const GRACE_MS = 10_000;

function log(line) {
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

async function spawnServer({ maxSessions }) {
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
      CODEXPRO_MAX_HTTP_SESSIONS: String(maxSessions),
      CODEXPRO_HTTP_SESSION_TTL_MS: "60000",
      CODEXPRO_HOME: home
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.resume();
  await waitForListening(child);
  return { baseUrl: `http://127.0.0.1:${port}`, child, root, home };
}

// Remove this run's exact temporary directories after the child is stopped.
// Only ever removes the two paths this run created via mkdtemp above.
async function removeServerDirs(server) {
  await fs.rm(server.root, { recursive: true, force: true });
  await fs.rm(server.home, { recursive: true, force: true });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertNoLeak(payload, label) {
  for (const id of seenSessionIds) assert.equal(payload.includes(id), false, `${label} leaked a routing session id`);
  assert.equal(payload.includes(TOKEN), false, `${label} leaked the auth token`);
}
const seenSessionIds = [];

// ---------------------------------------------------------------- TEST A: pre-grace first-use survives pressure
async function testA() {
  const server = await spawnServer({ maxSessions: 3 });
  const baseUrl = server.baseUrl;
  try {
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
    log("TEST-A S1+S2 settled (init+notif+one real op each)");

    // A: handshake only — first-use, no operation yet. Takes the last free slot.
    const aInit = await rawInitialize(baseUrl);
    assert.equal(aInit.status, 200, `A initialize failed: ${aInit.status}`);
    const aSession = aInit.sessionId;
    seenSessionIds.push(aSession);
    const aNotif = await rawInitialized(baseUrl, aSession);
    assert.equal(aNotif, 202, `A notification failed: ${aNotif}`);
    log(`TEST-A A handshake complete, no operation yet (session ${String(aSession).slice(0, 8)}…)`);

    // B: one additional initialize applies capacity pressure (3/3 full).
    const bInit = await rawInitialize(baseUrl);
    assert.equal(bInit.status, 200, `B pressure initialize failed: ${bInit.status}`);
    assert.equal(await rawInitialized(baseUrl, bInit.sessionId), 202, "B notification failed");
    log("TEST-A B pressure admission complete; exactly one idle session must have been reclaimed");

    // A FIRST actual operation: must survive. This is the R1 gate.
    const aFirst = await rawCall(baseUrl, aSession, "tools/list", {});
    log(`TEST-A A first actual tools/list: status=${aFirst.status}`);
    assert.equal(aFirst.status, 200, `HANDSHAKE-FIRST-CALL-001: A first real call stranded: ${aFirst.status} ${aFirst.body.slice(0, 200)}`);

    // The reclaimed victim must be the oldest already-used idle (S1), not A or S2.
    const probeS1 = await rawCall(baseUrl, s1.sessionId, "tools/list", {});
    const probeS2 = await rawCall(baseUrl, s2.sessionId, "tools/list", {});
    log(`TEST-A victim check: S1=${probeS1.status} (expect 404), S2=${probeS2.status} (expect 200)`);
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
    log(`TEST-A ring: ${events.length} exposed (cap 32), capacity_evicted total=${httpSessions.total_capacity_evicted}`);
    assert.equal(httpSessions.total_capacity_evicted, 1, "expected exactly one reclamation");
    assert.ok(evicts.length >= 1, "ring omitted the reclamation");
    assert.equal(evicts.at(-1)?.reason, "idle_reclamation", `reclamation used wrong band: ${evicts.at(-1)?.reason}`);
    assert.ok(events.length <= 32, "exposed ring exceeds bound");
    for (const e of events) {
      if (e.fp !== null) assert.match(e.fp, /^[0-9a-f]{12}$/, "fingerprint shape wrong");
    }
    assertNoLeak(JSON.stringify(diagRes.envelope?.result), "TEST-A diagnostics");
    assert.equal(server.child.exitCode, null, "server process died");
    console.log("TEST-A PASS — pre-grace first-use survives pressure; oldest used reclaimed");
  } finally {
    await stopServer(server.child);
    await removeServerDirs(server);
  }
}

// ---------------------------------------------------------------- TEST B: fixed deadline — protocol pings must not renew grace
async function testB() {
  const server = await spawnServer({ maxSessions: 2 });
  const baseUrl = server.baseUrl;
  try {
    // U: settled (handshake + one real operation).
    const u = await rawInitialize(baseUrl);
    assert.equal(u.status, 200, `U initialize failed: ${u.status}`);
    assert.equal(await rawInitialized(baseUrl, u.sessionId), 202, "U notification failed");
    const uCall = await rawCall(baseUrl, u.sessionId, "tools/list", {});
    assert.equal(uCall.status, 200, "U first operation failed");
    log("TEST-B U settled (init+notif+one real op)");

    // P: handshake only — first-use, no operation ever.
    const pInit = await rawInitialize(baseUrl);
    assert.equal(pInit.status, 200, `P initialize failed: ${pInit.status}`);
    const pSession = pInit.sessionId;
    seenSessionIds.push(pSession);
    assert.equal(await rawInitialized(baseUrl, pSession), 202, "P notification failed");
    const pStart = Date.now();
    log(`TEST-B P handshake complete, no operation yet (session ${String(pSession).slice(0, 8)}…)`);

    // Ping P periodically at intervals shorter than the grace, until strictly
    // more than GRACE_MS has elapsed since P's fixed first-use start. Every
    // ping is awaited: none is ever in flight when pressure is applied.
    let pings = 0;
    while (Date.now() - pStart <= GRACE_MS + 2000) {
      const ping = await rawCall(baseUrl, pSession, "ping", {});
      assert.equal(ping.status, 200, `P ping ${pings} failed: ${ping.status} ${ping.body.slice(0, 160)}`);
      pings += 1;
      await sleep(2000);
    }
    const elapsed = Date.now() - pStart;
    log(`TEST-B P received ${pings} pings over ${elapsed}ms (> ${GRACE_MS}ms grace); no ping in flight`);
    assert.ok(elapsed > GRACE_MS, "test did not run past the fixed deadline");

    // N: one new initialize applies capacity pressure (2/2 full).
    const nInit = await rawInitialize(baseUrl);
    log(`TEST-B N pressure initialize: status=${nInit.status}`);
    assert.equal(nInit.status, 200, `N pressure initialize failed (no 503 may occur while an idle victim exists): ${nInit.status}`);
    assert.equal(await rawInitialized(baseUrl, nInit.sessionId), 202, "N notification failed");

    // P must be reclaimed (expired first-use, score 0 sorts before used idle);
    // U must remain routable.
    const probeU = await rawCall(baseUrl, u.sessionId, "tools/list", {});
    const probeP = await rawCall(baseUrl, pSession, "tools/list", {});
    log(`TEST-B after pressure: U=${probeU.status} (expect 200), P=${probeP.status} (expect 404)`);
    assert.equal(probeU.status, 200, "FIRST-USE-GRACE-RENEWAL-001: used session U displaced by grace-renewed first-use P");
    assert.equal(probeP.status, 404, "expired first-use P was not reclaimed");
    assert.equal(probeP.envelope?.error?.code, -32001, "stale code wrong");
    assert.equal(probeP.envelope?.id, null, "stale id should be null");

    // Ring truth: exactly one evict, score 0, normal idle reclamation band.
    const diagRes = await toolCall(baseUrl, u.sessionId, "session_workspace_diagnostics", {});
    assert.equal(diagRes.status, 200, "diagnostics call failed");
    const httpSessions = diagRes.envelope?.result?.structuredContent?.http_sessions;
    assert.ok(httpSessions, "diagnostics omitted http_sessions");
    const events = httpSessions.recent_lifecycle_events ?? [];
    const evicts = events.filter((e) => e.event === "capacity_evict");
    log(`TEST-B ring: ${events.length} exposed (cap 32), capacity_evicted total=${httpSessions.total_capacity_evicted}`);
    assert.equal(httpSessions.total_capacity_evicted, 1, "expected exactly one reclamation");
    assert.ok(evicts.length >= 1, "ring omitted the reclamation");
    assert.equal(evicts.at(-1)?.reason, "idle_reclamation", `reclamation used wrong band: ${evicts.at(-1)?.reason}`);
    assert.equal(evicts.at(-1)?.completed, 0, `reclaimed victim score wrong (pings must not score): ${evicts.at(-1)?.completed}`);
    assert.ok(events.length <= 32, "exposed ring exceeds bound");
    for (const e of events) {
      if (e.fp !== null) assert.match(e.fp, /^[0-9a-f]{12}$/, "fingerprint shape wrong");
    }
    assertNoLeak(JSON.stringify(diagRes.envelope?.result), "TEST-B diagnostics");
    assert.equal(server.child.exitCode, null, "server process died");
    console.log("TEST-B PASS — fixed deadline holds under protocol chatter; expired first-use reclaimed");
  } finally {
    await stopServer(server.child);
    await removeServerDirs(server);
  }
}

const ONLY = (process.argv[2] ?? "ALL").toUpperCase();
const TESTS = ONLY === "B" ? [["B", testB]] : ONLY === "A" ? [["A", testA]] : [["A", testA], ["B", testB]];
let failed = 0;
for (const [id, fn] of TESTS) {
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.log(`TEST-${id} FAIL — ${error.message.slice(0, 500)}`);
  }
}
if (failed > 0) {
  console.log("✗ http session first-use smoke FAILED");
  process.exit(1);
}
console.log("✓ http session first-use smoke passed");
