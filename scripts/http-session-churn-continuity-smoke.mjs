// HTTP session churn continuity regression (RepoConnect HTTP MCP Session Churn Continuity).
//
// TARGET_PRODUCER: real `dist/http.js` OS child -> Express -> StreamableHTTPServerTransport.
// Guards the CLASS-A repair: continuity-aware victim scoring must strand no legitimate
// reusable session while provably one-shot sessions exist to reclaim, while admission
// still always succeeds with idle capacity (fresh clients never starve), in-flight work
// stays non-evictable, stale sessions stay protocol-correct (404/-32001), and the
// lifecycle ring stays bounded and secret-free.
//
// Every case is SEQUENTIAL and deterministic: no all-parallel oversubscription bursts
// (a >capacity burst inside one millisecond gap must reclaim somebody; who is timing).
//
// Usage: node scripts/http-session-churn-continuity-smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "codexpro-churn-continuity-smoke-token-4c1e";
const FIXTURE_NAME = "gap_fixture.py";
const FIXTURE_TEXT = '"""Continuity smoke fixture (lexical search target)."""\n\n\ndef load_alpha(path):\n    return path\n\n\ndef load_beta(path, strict=False):\n    return (path, strict)\n';

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

async function spawnServer({ maxSessions = 4, ttlMs = 60000 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-churn-cont-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-churn-cont-home-"));
  await fs.writeFile(path.join(root, FIXTURE_NAME), FIXTURE_TEXT);
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

let nextId = 5000;
function allocId() {
  nextId += 1;
  return nextId;
}

const seenIds = [];
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
        clientInfo: { name: "churn-continuity-smoke", version: "0.0.0" }
      }
    })
  });
  const body = await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) seenIds.push(sessionId);
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

async function toolCall(baseUrl, sessionId, name, args) {
  return rawCall(baseUrl, sessionId, "tools/call", { name, arguments: args });
}

async function diagVia(baseUrl, sessionId) {
  const res = await toolCall(baseUrl, sessionId, "session_workspace_diagnostics", {});
  assert.equal(res.status, 200, `diagnostics call failed: ${res.status} ${res.body.slice(0, 200)}`);
  const structured = res.envelope?.result?.structuredContent;
  assert(structured?.http_sessions, "diagnostics omitted http_sessions");
  return { diag: structured.http_sessions, raw: res };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT waiting for ${label} after ${ms}ms`)), ms))
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- C1: reusable multi-call session survives think gaps under churn
// Models the observed production failure: one conversation does an ordinary tool
// block, then reuses its session across think gaps while two other clients churn
// fresh one-shot sessions. Pre-repair this strands at the first gap reuse (404);
// repaired, the recurrent session outranks one-shots for reclamation.
async function caseC1() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 4 });
  const stopFlag = { stop: false };
  // R1 GATE (HANDSHAKE-FIRST-CALL-001): every churn iteration is an
  // initialize -> notifications/initialized -> first-call shape whose continuity
  // is under test, so callsLost MUST equal 0. Any first-call loss fails the
  // matrix: the foreground holds a settled session throughout, therefore a
  // settled-or-expired idle victim always exists and first-use sessions must
  // never be reclaimed. Loss here is never an acceptable "contention race".
  const churn = async (label) => {
    let inits = 0;
    let callsOk = 0;
    let callsLost = 0;
    try {
      while (!stopFlag.stop) {
        const s = await rawSession(server.baseUrl);
        inits += 1;
        const r = await rawCall(server.baseUrl, s, "tools/list", {});
        if (r.status === 200) callsOk += 1;
        else callsLost += 1;
        await sleep(15);
      }
    } catch (error) {
      return { label, inits, callsOk, callsLost, error: String(error).slice(0, 120) };
    }
    return { label, inits, callsOk, callsLost };
  };
  try {
    const fg = await rawSession(server.baseUrl);
    const opened = await toolCall(server.baseUrl, fg, "open_current_workspace", { include_tree: false });
    assert.equal(opened.status, 200, "foreground open failed");
    const wsId = opened.envelope?.result?.structuredContent?.workspace_id;
    assert.ok(wsId, "no workspace_id");
    const l0 = await rawCall(server.baseUrl, fg, "tools/list", {});
    const r0 = await toolCall(server.baseUrl, fg, "read", { workspace_id: wsId, path: FIXTURE_NAME, start_line: 1, end_line: 10 });
    assert.equal(l0.status, 200, "foreground list failed");
    assert.equal(r0.status, 200, "foreground read failed");
    obs.push("foreground block complete (open+list+read); session recurrent");
    const churnA = churn("A");
    const churnB = churn("B");
    const steps = [];
    await sleep(1200);
    let r = await toolCall(server.baseUrl, fg, "search", {
      workspace_id: wsId, query: "def load", path: FIXTURE_NAME, intent: "text", max_results: 50
    });
    steps.push(["search1", r.status, r.envelope?.result?.structuredContent?.matches?.length]);
    await sleep(1200);
    r = await toolCall(server.baseUrl, fg, "read", { workspace_id: wsId, path: FIXTURE_NAME, start_line: 1, end_line: 10 });
    steps.push(["read2", r.status]);
    await sleep(1200);
    r = await toolCall(server.baseUrl, fg, "search", {
      workspace_id: wsId, query: "def load", path: FIXTURE_NAME, intent: "text", max_results: 50
    });
    steps.push(["search2", r.status, r.envelope?.result?.structuredContent?.matches?.length]);
    stopFlag.stop = true;
    const churnRes = await Promise.all([churnA, churnB]);
    const churned = churnRes.reduce((a, b) => a + (b.inits ?? 0), 0);
    obs.push(`gap reuses: ${JSON.stringify(steps)}; churn inits served meanwhile: ${churned} ${JSON.stringify(churnRes)}`);
    for (const churner of churnRes) {
      assert.equal(churner.error ?? null, null, `churn loop ${churner.label} errored: ${churner.error}`);
      assert.equal(churner.callsLost ?? -1, 0, `churn loop ${churner.label} lost a first call under continuity protection (inits=${churner.inits} ok=${churner.callsOk} lost=${churner.callsLost})`);
    }
    for (const [name, status, matches] of steps) {
      assert.equal(status, 200, `foreground ${name} stranded under churn`);
    }
    assert.equal(steps[0][2], 2, "search1 did not return the two expected matches");
    assert.equal(steps[2][2], 2, "search2 did not return the two expected matches");
    assert.ok(churned > 20, "churn pressure too low to prove anything");
    assert.equal(server.child.exitCode, null, "server process died");
    record("C1", "reusable multi-call session survives think gaps under one-shot churn", true, obs);
  } catch (error) {
    stopFlag.stop = true;
    record("C1", "reusable multi-call session survives think gaps under one-shot churn", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    stopFlag.stop = true;
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- C2: fresh one-shot churn fully admitted, never 503 with idle around
async function caseC2() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 4 });
  try {
    let ok = 0;
    for (let i = 0; i < 12; i += 1) {
      const s = await rawSession(server.baseUrl);
      const r = await rawCall(server.baseUrl, s, "tools/list", {});
      assert.equal(r.status, 200, `one-shot ${i} call failed`);
      ok += 1;
    }
    const diag = await diagVia(server.baseUrl, await rawSession(server.baseUrl));
    obs.push(`12 one-shots served: ok=${ok}; initialized=${diag.diag.total_initialized} evicted=${diag.diag.total_capacity_evicted} rejected=${diag.diag.total_capacity_rejected}`);
    assert.equal(diag.diag.total_capacity_rejected, 0, "fresh init rejected while idle existed");
    assert.ok(diag.diag.active <= 4, "retained more than max");
    record("C2", "fresh one-shot churn fully admitted, never starved", true, obs);
  } catch (error) {
    record("C2", "fresh one-shot churn fully admitted, never starved", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- C3: mid-handshake newborn protected while settled idle exists
async function caseC3() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 3 });
  try {
    const s1 = await rawSession(server.baseUrl);
    await rawCall(server.baseUrl, s1, "tools/list", {});
    const s2 = await rawSession(server.baseUrl);
    await rawCall(server.baseUrl, s2, "tools/list", {});
    obs.push("S1+S2 settled (init+notif+call); capacity 3 has one free slot");
    // Newborn N completes initialize but has NOT yet sent notifications/initialized:
    // idle with a single completion. It must not be reclaimed while settled idle exists.
    const initN = await rawInitialize(server.baseUrl);
    assert.equal(initN.status, 200, "newborn init failed");
    const newborn = initN.sessionId;
    // One more admission must reclaim settled S1 (oldest), never the newborn.
    const s3 = await rawSession(server.baseUrl);
    void s3;
    const diag = await diagVia(server.baseUrl, s2);
    obs.push(`after pressure: evicted=${diag.diag.total_capacity_evicted}`);
    assert.equal(diag.diag.total_capacity_evicted, 1, "expected exactly one reclamation");
    await rawInitialized(server.baseUrl, newborn);
    const first = await rawCall(server.baseUrl, newborn, "tools/list", {});
    obs.push(`newborn first call after handshake: status=${first.status}`);
    assert.equal(first.status, 200, "newborn first call stranded while settled idle existed");
    const probeS1 = await rawCall(server.baseUrl, s1, "tools/list", {});
    assert.equal(probeS1.status, 404, "expected oldest settled S1 reclaimed");
    assert.equal(probeS1.envelope?.error?.code, -32001, "stale code wrong");
    const probeS2 = await rawCall(server.baseUrl, s2, "tools/list", {});
    assert.equal(probeS2.status, 200, "S2 should survive (newest settled)");
    record("C3", "mid-handshake newborn protected; oldest settled reclaimed instead", true, obs);
  } catch (error) {
    record("C3", "mid-handshake newborn protected; oldest settled reclaimed instead", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- C4: lifecycle ring bounded, fingerprinted, secret-free
async function caseC4() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 4 });
  try {
    for (let i = 0; i < 40; i += 1) await rawSession(server.baseUrl);
    const observer = await rawSession(server.baseUrl);
    // Force one stale reuse so session_not_found is represented.
    const stale = await rawCall(server.baseUrl, "00000000-0000-4000-8000-000000000000", "tools/list", {});
    assert.equal(stale.status, 404, "unknown session did not 404");
    const { diag, raw } = await diagVia(server.baseUrl, observer);
    const events = diag.recent_lifecycle_events;
    assert.ok(Array.isArray(events), "ring missing from diagnostics");
    obs.push(`ring exposed: ${events.length} entries (cap 32)`);
    assert.ok(events.length <= 32, "exposed ring exceeds bound");
    assert.ok(events.length >= 4, "ring too small to be useful");
    let prevSeq = -1;
    const kinds = new Set();
    for (const e of events) {
      kinds.add(e.event);
      assert.ok(e.seq > prevSeq, "ring seq not strictly increasing");
      prevSeq = e.seq;
      for (const f of ["event", "method", "status", "duration_ms", "fp", "active", "pending", "reason", "completed", "idle_ms"]) {
        assert.ok(f in e, `ring entry missing ${f}`);
      }
      if (e.fp !== null) assert.match(e.fp, /^[0-9a-f]{12}$/, "fingerprint shape wrong");
      if (e.event === "capacity_evict") {
        assert.equal(typeof e.completed, "number", "evict entry lacks victim completions");
        assert.equal(typeof e.idle_ms, "number", "evict entry lacks victim idle age");
      }
    }
    for (const k of ["initialize_admitted", "request_finish", "session_not_found", "capacity_evict"]) {
      assert.ok(kinds.has(k), `ring never observed ${k}`);
    }
    const payload = JSON.stringify(raw.envelope?.result);
    for (const id of seenIds) assert.equal(payload.includes(id), false, "ring/diagnostics leaked a routing session id");
    assert.equal(payload.includes(TOKEN), false, "diagnostics leaked the auth token");
    record("C4", "lifecycle ring bounded, fingerprinted, secret-free", true, obs);
  } catch (error) {
    record("C4", "lifecycle ring bounded, fingerprinted, secret-free", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- C5: stale/invalid sessions stay protocol-correct
async function caseC5() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 2 });
  try {
    const a = await rawSession(server.baseUrl);
    const b = await rawSession(server.baseUrl);
    void b;
    await rawSession(server.baseUrl); // reclaims oldest first-use via burst fallback (A)
    const stale = await rawCall(server.baseUrl, a, "tools/list", {});
    assert.equal(stale.status, 404, "stale reuse did not 404");
    assert.equal(stale.envelope?.jsonrpc, "2.0", "stale response not JSON-RPC");
    assert.equal(stale.envelope?.error?.code, -32001, "stale code wrong");
    assert.equal(stale.envelope?.error?.message, "Session not found", "stale message wrong");
    assert.equal(stale.envelope?.id, null, "stale id should be null");
    const malformed = await rawCall(server.baseUrl, "not-a-session", "tools/list", {});
    assert.equal(malformed.status, 400, "malformed id did not 400");
    const missing = await (async () => {
      const response = await fetch(`${server.baseUrl}/mcp`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: allocId(), method: "tools/list", params: {} })
      });
      await response.text();
      return response.status;
    })();
    assert.equal(missing, 400, "missing id did not 400");
    obs.push("stale 404/-32001/id-null; malformed 400; missing 400");
    const healthy = await rawSession(server.baseUrl);
    void healthy;
    assert.equal(server.child.exitCode, null, "server process died");
    record("C5", "stale/invalid sessions stay protocol-correct, process healthy", true, obs);
  } catch (error) {
    record("C5", "stale/invalid sessions stay protocol-correct, process healthy", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

// ---------------------------------------------------------------- C6: in-flight still non-evictable, all-busy still cleanly 503
async function caseC6() {
  const obs = [];
  const server = await spawnServer({ maxSessions: 2 });
  const connectSdk = async (label) => {
    const client = new Client({ name: `churn-c6-${label}`, version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } }
    });
    await client.connect(transport);
    return { client, sessionId: transport.sessionId };
  };
  try {
    const sdkA = await connectSdk("a");
    const sdkB = await connectSdk("b");
    const wsA = (await sdkA.client.callTool({ name: "open_current_workspace", arguments: { include_tree: false } })).structuredContent.workspace_id;
    const wsB = (await sdkB.client.callTool({ name: "open_current_workspace", arguments: { include_tree: false } })).structuredContent.workspace_id;
    const busyA = sdkA.client.callTool({ name: "wait_for_handoff", arguments: { workspace_id: wsA, max_wait_seconds: 6, poll_ms: 250 } });
    const busyB = sdkB.client.callTool({ name: "wait_for_handoff", arguments: { workspace_id: wsB, max_wait_seconds: 6, poll_ms: 250 } });
    await sleep(400);
    const initC = await rawInitialize(server.baseUrl);
    obs.push(`all-busy third init: status=${initC.status}`);
    assert.equal(initC.status, 503, "all-busy init was not cleanly rejected");
    assert.equal(initC.envelope?.error?.code, -32002, "rejection code wrong");
    assert.equal(initC.sessionId, null, "rejection leaked a session id");
    const [rA, rB] = await Promise.all([
      withTimeout(busyA, 12000, "busy A"),
      withTimeout(busyB, 12000, "busy B")
    ]);
    assert.ok(!rA.isError && !rB.isError, "in-flight work failed under pressure");
    obs.push("in-flight incumbents both received results; newcomer cleanly rejected");
    await sdkA.client.close().catch(() => {});
    await sdkB.client.close().catch(() => {});
    record("C6", "in-flight non-evictable; all-busy cleanly 503", true, obs);
  } catch (error) {
    record("C6", "in-flight non-evictable; all-busy cleanly 503", false, [...obs, `FAILURE: ${error.message.slice(0, 400)}`]);
    throw error;
  } finally {
    await stopServer(server.child);
  }
}

const CASES = { C1: caseC1, C2: caseC2, C3: caseC3, C4: caseC4, C5: caseC5, C6: caseC6 };

let failed = 0;
for (const [id, fn] of Object.entries(CASES)) {
  try {
    await fn();
  } catch {
    failed += 1;
  }
}
console.log(`MATRIX_SUMMARY: ${JSON.stringify(results.map((r) => ({ case: r.case, verdict: r.verdict })))}`);
if (failed > 0) {
  console.log(`✗ http session churn continuity smoke FAILED (${failed} case(s))`);
  process.exit(1);
}
console.log("✓ http session churn continuity smoke passed");
