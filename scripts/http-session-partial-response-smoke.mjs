// Large partial-response regression — RepoConnect HTTP MCP Session Churn Continuity R4.
//
// TARGET_PRODUCER: real `dist/http.js` OS child -> Express -> StreamableHTTPServerTransport.
// Server fixture: ~1.75MB text file; server runs with CODEXPRO_MAX_OUTPUT_BYTES=2000000
// (documented output-budget knob, test-env only; product default untouched) so one
// ordinary `read` returns a genuinely large (~1.75MB) normal response.
//
// TEST-R4 (RESPONSE-FINISH-ORDER-001, maxSessions=2, fully sequential):
//   U: handshake + open + list + one FULL large read (score 3 + counted diag polls).
//   A: handshake only (score 0, fixed deadline active).
//   A starts its first LARGE read; the client reads exactly one response chunk
//     (~14KB « full size) and ends the connection before response `finish`.
//   Handler resolution alone must not score: the close-before-finish must win.
//   N pressure: N 200 (no 503), A-next 200, U reclaimed with its exact real
//     score, U later 404/-32001/id-null, no fabricated A score.
//
// TEST-HOLD (ordering control 7, maxSessions=2):
//   R starts a FULL large read (no abort); a concurrent diag observes
//   inFlight >= 2 (reader streaming + self) at least once before completion,
//   proving the record stays non-idle until handler success AND finish.
//   The read then completes 200 with the full byte count.
//
// Usage: node scripts/http-session-partial-response-smoke.mjs [R4|HOLD]  (default: both)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TOKEN = "codexpro-partial-response-smoke-token-3b7e";
const GRACE_MS = 10_000;
const FIXTURE_NAME = "r4_large_fixture.txt";

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-partial-resp-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-partial-resp-home-"));
  const lines = [];
  for (let i = 0; i < 30000; i += 1) {
    lines.push(`# filler line ${String(i).padStart(5, "0")} abcdefghijklmnopqrstuvwxyz0123456789 padded tail.\n`);
  }
  await fs.writeFile(path.join(root, FIXTURE_NAME), lines.join(""));
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
      CODEXPRO_MAX_OUTPUT_BYTES: "2000000",
      CODEXPRO_MAX_READ_BYTES: "2000000",
      CODEXPRO_HOME: home
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stderr.resume();
  await waitForListening(child);
  return { baseUrl: `http://127.0.0.1:${port}`, child, root, home };
}

// Remove this run's exact temporary directories after the child is stopped.
async function removeServerDirs(server) {
  await fs.rm(server.root, { recursive: true, force: true });
  await fs.rm(server.home, { recursive: true, force: true });
}

let nextId = 700;
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
        clientInfo: { name: "partial-response-smoke", version: "0.0.0" }
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
  return { status: response.status, body, bytes: body.length, envelope: parseRpcEnvelope(body, id) };
}

async function toolCall(baseUrl, sessionId, name, args) {
  return rawCall(baseUrl, sessionId, "tools/call", { name, arguments: args });
}

// Start a tools/call, read exactly one response chunk, then end the connection
// (abort destroys the socket) before the response can emit `finish`.
async function oneChunkThenAbort(baseUrl, sessionId, name, args) {
  const id = allocId();
  const ctl = new AbortController();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: ctl.signal
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  const received = first.value?.length ?? 0;
  ctl.abort();
  await reader.read().catch(() => {});
  return { status: response.status, received };
}

async function diagVia(baseUrl, sessionId) {
  const res = await toolCall(baseUrl, sessionId, "session_workspace_diagnostics", {});
  assert.equal(res.status, 200, `diagnostics call failed: ${res.status} ${res.body.slice(0, 200)}`);
  const httpSessions = res.envelope?.result?.structuredContent?.http_sessions;
  assert.ok(httpSessions, "diagnostics omitted http_sessions");
  return { diag: httpSessions, raw: res };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seenSessionIds = [];
function assertNoLeak(payload, label) {
  for (const id of seenSessionIds) assert.equal(payload.includes(id), false, `${label} leaked a routing session id`);
  assert.equal(payload.includes(TOKEN), false, `${label} leaked the auth token`);
}

// ---------------------------------------------------------------- TEST-R4: partial large receipt must not score
async function testR4() {
  const server = await spawnServer({ maxSessions: 2 });
  const baseUrl = server.baseUrl;
  try {
    // U: handshake + open + list + one FULL large read (score exactly 3).
    const u = await rawInitialize(baseUrl);
    assert.equal(u.status, 200, `U initialize failed: ${u.status}`);
    assert.equal(await rawInitialized(baseUrl, u.sessionId), 202, "U notification failed");
    const opened = await toolCall(baseUrl, u.sessionId, "open_current_workspace", { include_tree: false });
    assert.equal(opened.status, 200, "U open failed");
    const wsId = opened.envelope?.result?.structuredContent?.workspace_id;
    assert.ok(wsId, "no workspace_id");
    assert.equal((await rawCall(baseUrl, u.sessionId, "tools/list", {})).status, 200, "U list failed");
    const full = await toolCall(baseUrl, u.sessionId, "read", {
      workspace_id: wsId, path: FIXTURE_NAME, start_line: 1, end_line: 1000000
    });
    assert.equal(full.status, 200, `U full read failed: ${full.status}`);
    const fullSize = full.bytes;
    let uScore = 3;
    log(`TEST-R4 U settled (open+list+fullRead, score=${uScore}); full normal response=${fullSize} bytes`);
    assert.ok(fullSize > 1000000, `full response too small to prove anything (${fullSize})`);

    // A: handshake only — score 0, fixed deadline active.
    const aInit = await rawInitialize(baseUrl);
    assert.equal(aInit.status, 200, `A initialize failed: ${aInit.status}`);
    const aSession = aInit.sessionId;
    seenSessionIds.push(u.sessionId, aSession);
    assert.equal(await rawInitialized(baseUrl, aSession), 202, "A notification failed");
    const tA0 = Date.now();
    log(`TEST-R4 A handshake complete, score 0 (session ${String(aSession).slice(0, 8)}…)`);

    // A starts its first LARGE read; client reads exactly one chunk, then ends
    // the connection before response `finish`. Partial receipt (chunk « full)
    // proves the connection ended mid-response, i.e. close-before-finish.
    const partial = await oneChunkThenAbort(baseUrl, aSession, "read", {
      workspace_id: wsId, path: FIXTURE_NAME, start_line: 1, end_line: 1000000
    });
    log(`TEST-R4 A partial receipt: ${partial.received} bytes of ${fullSize} (ratio ${(100 * partial.received / fullSize).toFixed(2)}%)`);
    assert.ok(partial.received > 0, "client received nothing; abort raced the first byte");
    assert.ok(partial.received * 50 < fullSize, `receipt not materially partial (${partial.received}/${fullSize})`);

    // A must be released (inFlight self-only) but retained, inside its deadline.
    let last = null;
    const pollDeadline = Date.now() + 10000;
    for (;;) {
      last = await diagVia(baseUrl, u.sessionId);
      uScore += 1;
      if (last.diag.in_flight_requests === 1 && last.diag.active === 2) break;
      assert.ok(Date.now() < pollDeadline, `A never released-but-retained (inFlight=${last.diag.in_flight_requests} active=${last.diag.active})`);
      await sleep(250);
    }
    log(`TEST-R4 A released-but-retained (U score now ${uScore})`);
    const ageA = Date.now() - tA0;
    log(`TEST-R4 A age at pressure: ${ageA}ms (grace ${GRACE_MS}ms)`);
    assert.ok(ageA < GRACE_MS, "test overran A's fixed deadline");

    // N pressure: must admit cleanly and reclaim U (exact real score), never A.
    const nInit = await rawInitialize(baseUrl);
    assert.equal(nInit.status, 200, `N pressure initialize failed (no 503 while idle exists): ${nInit.status}`);
    seenSessionIds.push(nInit.sessionId);
    assert.equal(await rawInitialized(baseUrl, nInit.sessionId), 202, "N notification failed");
    log("TEST-R4 N pressure admission complete");
    const aNext = await rawCall(baseUrl, aSession, "tools/list", {});
    const uProbe = await rawCall(baseUrl, u.sessionId, "tools/list", {});
    log(`TEST-R4 after pressure: A-next=${aNext.status} (expect 200), U=${uProbe.status} (expect 404)`);
    assert.equal(aNext.status, 200, `RESPONSE-FINISH-ORDER-001: A stranded after partial receipt: ${aNext.status} ${aNext.body.slice(0, 160)}`);
    assert.equal(uProbe.status, 404, "expected used U reclaimed instead of first-use A");
    assert.equal(uProbe.envelope?.error?.code, -32001, "stale code wrong");
    assert.equal(uProbe.envelope?.id, null, "stale id should be null");

    // Ring truth: exactly one evict, U's exact real score, no fabrication.
    const fin = await diagVia(baseUrl, aSession);
    const events = fin.diag.recent_lifecycle_events ?? [];
    const evicts = events.filter((e) => e.event === "capacity_evict");
    log(`TEST-R4 ring: ${events.length} exposed, evicted total=${fin.diag.total_capacity_evicted}, last evict completed=${evicts.at(-1)?.completed} reason=${evicts.at(-1)?.reason}`);
    assert.equal(fin.diag.total_capacity_evicted, 1, "expected exactly one reclamation");
    assert.ok(evicts.length >= 1, "ring omitted the reclamation");
    assert.equal(evicts.at(-1)?.reason, "idle_reclamation", `wrong band: ${evicts.at(-1)?.reason}`);
    assert.equal(evicts.at(-1)?.completed, uScore, `evict score ${evicts.at(-1)?.completed} != U real score ${uScore}`);
    assert.ok(events.length <= 32, "exposed ring exceeds bound");
    for (const e of events) {
      if (e.fp !== null) assert.match(e.fp, /^[0-9a-f]{12}$/, "fingerprint shape wrong");
    }
    assertNoLeak(JSON.stringify(fin.raw.envelope?.result), "TEST-R4 diagnostics");
    assert.ok(fin.diag.active >= 0 && fin.diag.in_flight_requests >= 0 && fin.diag.pending_initializations >= 0, "negative counter");
    assert.equal(server.child.exitCode, null, "server process died");
    console.log("TEST-R4 PASS — partial large receipt never scores; used idle reclaimed instead");
  } finally {
    await stopServer(server.child);
    await removeServerDirs(server);
  }
}

// ---------------------------------------------------------------- TEST-HOLD: in-flight held through response completion
async function testHold() {
  const server = await spawnServer({ maxSessions: 2 });
  const baseUrl = server.baseUrl;
  try {
    const u = await rawInitialize(baseUrl);
    assert.equal(u.status, 200, "U initialize failed");
    assert.equal(await rawInitialized(baseUrl, u.sessionId), 202, "U notification failed");
    const opened = await toolCall(baseUrl, u.sessionId, "open_current_workspace", { include_tree: false });
    const wsId = opened.envelope?.result?.structuredContent?.workspace_id;
    assert.ok(wsId, "no workspace_id");
    const r = await rawInitialize(baseUrl);
    assert.equal(r.status, 200, "R initialize failed");
    assert.equal(await rawInitialized(baseUrl, r.sessionId), 202, "R notification failed");
    seenSessionIds.push(u.sessionId, r.sessionId);
    log("TEST-HOLD U+R ready; R starts a FULL large read (no abort)");

    // Start the large read without awaiting; sample in-flight while it streams.
    let readDone = false;
    let readResult = null;
    const pending = toolCall(baseUrl, r.sessionId, "read", {
      workspace_id: wsId, path: FIXTURE_NAME, start_line: 1, end_line: 1000000
    }).then((res) => { readDone = true; readResult = res; return res; });
    let observedHold = false;
    for (let i = 0; i < 40 && !readDone; i += 1) {
      const d = await diagVia(baseUrl, u.sessionId);
      // This diag call itself is 1 in-flight; the streaming read is another.
      if (d.diag.in_flight_requests >= 2) observedHold = true;
      if (!readDone) await sleep(20);
    }
    const res = await pending;
    log(`TEST-HOLD read completed: status=${res.status} bytes=${res.bytes}; hold observed=${observedHold}`);
    assert.equal(res.status, 200, "full read failed");
    assert.ok(res.bytes > 1000000, `full response too small (${res.bytes})`);
    assert.ok(observedHold, "record went idle while its large response was still completing");
    const d = await diagVia(baseUrl, u.sessionId);
    assert.ok(d.diag.in_flight_requests <= 1, "in-flight did not return to self-only after completion");
    assertNoLeak(JSON.stringify(d.raw.envelope?.result), "TEST-HOLD diagnostics");
    assert.equal(server.child.exitCode, null, "server process died");
    console.log("TEST-HOLD PASS — record stays in-flight until handler success AND finish");
  } finally {
    await stopServer(server.child);
    await removeServerDirs(server);
  }
}

const ONLY = (process.argv[2] ?? "ALL").toUpperCase();
const TESTS = ONLY === "HOLD" ? [["HOLD", testHold]] : ONLY === "R4" ? [["R4", testR4]] : [["R4", testR4], ["HOLD", testHold]];
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
  console.log("✗ http session partial-response smoke FAILED");
  process.exit(1);
}
console.log("✓ http session partial-response smoke passed");
