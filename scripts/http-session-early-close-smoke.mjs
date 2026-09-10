// Early-close first-operation regression — RepoConnect HTTP MCP Session Churn Continuity R3.
//
// TARGET_PRODUCER: real `dist/http.js` OS child -> Express -> StreamableHTTPServerTransport.
//
// TEST-R3 (FIRST-APPLICATION-CLOSE-001, maxSessions=2, fully sequential):
//   U: handshake + open + one list (score exactly 2 + counted diag polls).
//   A: handshake only (score 0, fixed deadline active).
//   A begins a first LONG neutral operation (wait_for_handoff on U's
//     workspace); the client aborts after 250ms with no result received.
//   Wait until the 3s internal window is closed AND A is released-but-retained
//     (aggregate inFlight == self-only, active == 2).
//   N initializes (pressure). Required: N 200 (no 503), U reclaimed as the
//     eligible used idle victim, A retained, A's next op 200, U later 404,
//     evict entry reports U's exact real score, no fabricated completion.
//   A late internal settlement after the ended response must not score (R3 S5):
//     the ring diff across the window shows whether a late finish occurred;
//     either shape must leave A protected.
//
// TEST-CTRL (normal-completion exactly-once, maxSessions=2, sequential):
//   A: handshake + ONE normal tools/list. B: handshake + ONE normal tools/list.
//   C pressure init must evict A (1-1 tie broken by age). Score 0 would have
//   protected A (B dies); score 2 would outrank B (B dies). A dying with
//   evict completed == 1 proves exactly-once incl. finish+close.
//
// Usage: node scripts/http-session-early-close-smoke.mjs [R3|CTRL]  (default: both)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TOKEN = "codexpro-early-close-smoke-token-7d1c";
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-early-close-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-early-close-home-"));
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
async function removeServerDirs(server) {
  await fs.rm(server.root, { recursive: true, force: true });
  await fs.rm(server.home, { recursive: true, force: true });
}

let nextId = 300;
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
        clientInfo: { name: "early-close-smoke", version: "0.0.0" }
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

// Start a tools/call and abort the client side after abortAfterMs. The server
// sees a premature response close; no completed result is received here.
async function abortedToolCall(baseUrl, sessionId, name, args, abortAfterMs) {
  const id = allocId();
  const ctl = new AbortController();
  const pending = fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: ctl.signal
  })
    .then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) }))
    .catch((e) => ({ aborted: true, err: String((e && e.message) || e).slice(0, 120) }));
  await sleep(abortAfterMs);
  ctl.abort();
  return pending;
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

// ---------------------------------------------------------------- TEST-R3: early close must release without scoring
async function testR3() {
  const server = await spawnServer({ maxSessions: 2 });
  const baseUrl = server.baseUrl;
  try {
    // U: handshake + open + one list = application score exactly 2.
    const u = await rawInitialize(baseUrl);
    assert.equal(u.status, 200, `U initialize failed: ${u.status}`);
    assert.equal(await rawInitialized(baseUrl, u.sessionId), 202, "U notification failed");
    const opened = await toolCall(baseUrl, u.sessionId, "open_current_workspace", { include_tree: false });
    assert.equal(opened.status, 200, "U open failed");
    const wsId = opened.envelope?.result?.structuredContent?.workspace_id;
    assert.ok(wsId, "no workspace_id");
    const uList = await rawCall(baseUrl, u.sessionId, "tools/list", {});
    assert.equal(uList.status, 200, "U list failed");
    let uScore = 2;
    log(`TEST-R3 U settled (open+list, score=${uScore}, ws ${String(wsId).slice(0, 12)}…)`);

    // Baseline ring high-water (diag poll itself scores +1 on U — counted).
    let d0 = await diagVia(baseUrl, u.sessionId);
    uScore += 1;
    const ringHighWater = Math.max(0, ...d0.diag.recent_lifecycle_events.map((e) => e.seq));
    log(`TEST-R3 ring baseline seq=${ringHighWater} (U score now ${uScore})`);

    // A: handshake only — score 0, fixed deadline active.
    const aInit = await rawInitialize(baseUrl);
    assert.equal(aInit.status, 200, `A initialize failed: ${aInit.status}`);
    const aSession = aInit.sessionId;
    seenSessionIds.push(u.sessionId, aSession);
    assert.equal(await rawInitialized(baseUrl, aSession), 202, "A notification failed");
    const tA0 = Date.now();
    log(`TEST-R3 A handshake complete, score 0 (session ${String(aSession).slice(0, 8)}…)`);

    // A begins its first LONG neutral operation; client ends it at 250ms with
    // no completed result received. wait_for_handoff holds up to 3s server-side.
    const tAbortStart = Date.now();
    const outcome = await abortedToolCall(baseUrl, aSession, "wait_for_handoff", {
      workspace_id: wsId, max_wait_seconds: 3, poll_ms: 250
    }, 250);
    assert.ok(outcome.aborted, `expected client-side abort, got: ${JSON.stringify(outcome).slice(0, 160)}`);
    log(`TEST-R3 A first op aborted at 250ms (client: ${outcome.err})`);

    // Wait until BOTH: the 3s internal window is closed (late settlement, if
    // any, has happened) AND A is released-but-retained. Sleep through the
    // window first (no traffic), then poll. Every poll is an awaited U diag
    // op — counted into uScore exactly.
    const windowEnd = tAbortStart + 4100;
    const sleepLeft = windowEnd - Date.now();
    if (sleepLeft > 0) await sleep(sleepLeft);
    let last = null;
    const pollDeadline = tAbortStart + 12000;
    for (;;) {
      last = await diagVia(baseUrl, u.sessionId);
      uScore += 1;
      const idleOnlySelf = last.diag.in_flight_requests === 1;
      const retained = last.diag.active === 2;
      if (idleOnlySelf && retained) break;
      assert.ok(Date.now() < pollDeadline, `A never reached released-but-retained (inFlight=${last.diag.in_flight_requests} active=${last.diag.active})`);
      await sleep(250);
    }
    log(`TEST-R3 A released-but-retained (inFlight=self-only, active=2, U score now ${uScore})`);

    // Ring diff across the window: which POST finishes settled after baseline?
    // Baseline members: diag#0's own finish + A init + A notify (all early).
    // A late finish (event time > abort+1500ms) means internal settlement
    // after the ended response — it must NOT have scored (proven by
    // A-protection below). Exposed entries carry age_ms (ms before this read).
    const readNow = Date.now();
    const eventTime = (e) => readNow - e.age_ms;
    const fresh = last.diag.recent_lifecycle_events.filter((e) => e.seq > ringHighWater);
    const finishes = fresh.filter((e) => e.event === "request_finish" && e.method === "POST");
    const early = finishes.filter((e) => eventTime(e) <= tAbortStart + 1500);
    const late = finishes.filter((e) => eventTime(e) > tAbortStart + 1500);
    log(`TEST-R3 ring window: ${finishes.length} POST finishes (${early.length} early, ${late.length} late)`);
    assert.ok(early.length >= 3, `ring missing baseline traffic (early=${early.length})`);
    assert.ok(late.length <= 1, `unexpected late finishes (late=${late.length})`);
    log(late.length === 1
      ? "TEST-R3 late internal settlement OBSERVED after ended response (must stay unscored)"
      : "TEST-R3 no late settlement (server cancelled on abort; vacuously unscored)");

    // Fixed deadline must still be active for A.
    const ageA = Date.now() - tA0;
    log(`TEST-R3 A age at pressure: ${ageA}ms (grace ${GRACE_MS}ms)`);
    assert.ok(ageA < GRACE_MS, "test overran A's fixed deadline");

    // N pressure: must admit cleanly and reclaim U (score uScore), never A.
    const nInit = await rawInitialize(baseUrl);
    assert.equal(nInit.status, 200, `N pressure initialize failed (no 503 while idle exists): ${nInit.status}`);
    seenSessionIds.push(nInit.sessionId);
    log("TEST-R3 N pressure admission complete");
    const aNext = await rawCall(baseUrl, aSession, "tools/list", {});
    const uProbe = await rawCall(baseUrl, u.sessionId, "tools/list", {});
    log(`TEST-R3 after pressure: A-next=${aNext.status} (expect 200), U=${uProbe.status} (expect 404)`);
    assert.equal(aNext.status, 200, `FIRST-APPLICATION-CLOSE-001: A stranded after unscored early close: ${aNext.status} ${aNext.body.slice(0, 160)}`);
    assert.equal(uProbe.status, 404, "expected used U reclaimed instead of first-use A");
    assert.equal(uProbe.envelope?.error?.code, -32001, "stale code wrong");
    assert.equal(uProbe.envelope?.id, null, "stale id should be null");

    // Ring truth: exactly one evict, U's exact real score, no fabrication.
    const fin = await diagVia(baseUrl, aSession);
    const events = fin.diag.recent_lifecycle_events ?? [];
    const evicts = events.filter((e) => e.event === "capacity_evict");
    log(`TEST-R3 ring: ${events.length} exposed, evicted total=${fin.diag.total_capacity_evicted}, last evict=${JSON.stringify(evicts.at(-1))}`);
    assert.equal(fin.diag.total_capacity_evicted, 1, "expected exactly one reclamation");
    assert.ok(evicts.length >= 1, "ring omitted the reclamation");
    assert.equal(evicts.at(-1)?.reason, "idle_reclamation", `wrong band: ${evicts.at(-1)?.reason}`);
    assert.equal(evicts.at(-1)?.completed, uScore, `evict score ${evicts.at(-1)?.completed} != U real score ${uScore}`);
    assert.ok(events.length <= 32, "exposed ring exceeds bound");
    for (const e of events) {
      if (e.fp !== null) assert.match(e.fp, /^[0-9a-f]{12}$/, "fingerprint shape wrong");
    }
    assertNoLeak(JSON.stringify(fin.raw.envelope?.result), "TEST-R3 diagnostics");
    assert.ok(fin.diag.active >= 0 && fin.diag.in_flight_requests >= 0 && fin.diag.pending_initializations >= 0, "negative counter");
    assert.equal(server.child.exitCode, null, "server process died");
    console.log("TEST-R3 PASS — early close releases without scoring; used idle reclaimed instead");
  } finally {
    await stopServer(server.child);
    await removeServerDirs(server);
  }
}

// ---------------------------------------------------------------- TEST-CTRL: normal completion scores exactly once
async function testCtrl() {
  const server = await spawnServer({ maxSessions: 2 });
  const baseUrl = server.baseUrl;
  try {
    // A and B: handshake + ONE normal tools/list each (score 1 each, A older).
    const a = await rawInitialize(baseUrl);
    assert.equal(a.status, 200, "A initialize failed");
    assert.equal(await rawInitialized(baseUrl, a.sessionId), 202, "A notification failed");
    assert.equal((await rawCall(baseUrl, a.sessionId, "tools/list", {})).status, 200, "A op failed");
    const b = await rawInitialize(baseUrl);
    assert.equal(b.status, 200, "B initialize failed");
    assert.equal(await rawInitialized(baseUrl, b.sessionId), 202, "B notification failed");
    assert.equal((await rawCall(baseUrl, b.sessionId, "tools/list", {})).status, 200, "B op failed");
    seenSessionIds.push(a.sessionId, b.sessionId);
    log("TEST-CTRL A+B settled with one normal op each (A older)");

    // C pressure: 1-1 tie must break by age -> A evicted. Score 0 on A would
    // have protected it (B dies); score 2 would have outranked B (B dies).
    const c = await rawInitialize(baseUrl);
    assert.equal(c.status, 200, "C pressure initialize failed");
    const probeA = await rawCall(baseUrl, a.sessionId, "tools/list", {});
    const probeB = await rawCall(baseUrl, b.sessionId, "tools/list", {});
    log(`TEST-CTRL after pressure: A=${probeA.status} (expect 404), B=${probeB.status} (expect 200)`);
    assert.equal(probeA.status, 404, "tie did not break by age — A op did not score exactly once");
    assert.equal(probeA.envelope?.error?.code, -32001, "stale code wrong");
    assert.equal(probeB.status, 200, "B should survive");
    const fin = await diagVia(baseUrl, b.sessionId);
    const evicts = (fin.diag.recent_lifecycle_events ?? []).filter((e) => e.event === "capacity_evict");
    assert.equal(fin.diag.total_capacity_evicted, 1, "expected exactly one reclamation");
    assert.ok(evicts.length >= 1, "ring omitted the reclamation");
    assert.equal(evicts.at(-1)?.completed, 1, `single normal op must score exactly 1 (got ${evicts.at(-1)?.completed})`);
    assert.equal(evicts.at(-1)?.reason, "idle_reclamation", `wrong band: ${evicts.at(-1)?.reason}`);
    assertNoLeak(JSON.stringify(fin.raw.envelope?.result), "TEST-CTRL diagnostics");
    assert.equal(server.child.exitCode, null, "server process died");
    console.log("TEST-CTRL PASS — normal completion scores exactly once (finish+close never double-counts)");
  } finally {
    await stopServer(server.child);
    await removeServerDirs(server);
  }
}

const ONLY = (process.argv[2] ?? "ALL").toUpperCase();
const TESTS = ONLY === "CTRL" ? [["CTRL", testCtrl]] : ONLY === "R3" ? [["R3", testR3]] : [["R3", testR3], ["CTRL", testCtrl]];
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
  console.log("✗ http session early-close smoke FAILED");
  process.exit(1);
}
console.log("✓ http session early-close smoke passed");
