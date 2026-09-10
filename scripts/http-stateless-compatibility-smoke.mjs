#!/usr/bin/env node
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(mode, { token, toolMode = "minimal", extraEnv = {}, rootPath = root } = {}) {
  const port = await freePort();
  const env = {
    ...process.env,
    CODEXPRO_ROOT: rootPath,
    CODEXPRO_ALLOWED_ROOTS: rootPath,
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: token ? "0" : "1",
    CODEXPRO_TOOL_MODE: toolMode,
    ...(mode ? { CODEXPRO_HTTP_SESSION_MODE: mode } : {}),
    ...(token ? { CODEXPRO_HTTP_TOKEN: token } : {}),
    ...extraEnv
  };
  const child = spawn(process.execPath, ["dist/http.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const healthHeaders = token ? { authorization: `Bearer ${token}` } : {};
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`, { headers: healthHeaders });
      if (response.ok) return { child, base, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`HTTP server did not start: ${stderr}`);
}

async function procMetrics(pid) {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024;
    const vmData = Number(status.match(/^VmData:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024;
    const handles = (await fs.readdir(`/proc/${pid}/fd`)).length;
    return { rss, vmData, fileDescriptors: handles, timers: "not exposed by target" };
  } catch {
    return { rss: null, vmData: null, fileDescriptors: null, timers: "target exited" };
  }
}

function assertStatelessEnvelope(result, label) {
  assert.equal(result.response.status, 200, `${label} failed: ${result.body.slice(0, 300)}`);
  assert.equal(result.response.headers.get("mcp-session-id"), null, `${label} exposed a session header`);
  assert.ok(result.envelope?.result, `${label} returned no JSON-RPC result`);
}

async function stopServer(server) {
  if (server.child.exitCode === null) server.child.kill("SIGTERM");
  await once(server.child, "exit");
}

const initBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-stateless-compatibility-smoke", version: "1" }
  }
};

async function postInitialize(server, headers = {}) {
  return fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    body: JSON.stringify(initBody)
  });
}

async function postRpc(server, method, params = {}, headers = {}, id = 20) {
  const response = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const body = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    const data = body.split(/\r?\n/).find((line) => line.startsWith("data:"));
    envelope = data ? JSON.parse(data.slice(5).trim()) : undefined;
  }
  return { response, body, envelope };
}

const contractFailures = [];

async function runStateless() {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-stateless-"));
  const secondRoot = path.join(fixtureRoot, "second");
  const nestedRoot = path.join(fixtureRoot, "src");
  await fs.mkdir(secondRoot);
  await fs.mkdir(nestedRoot);
  const largeFixture = "# stateless large response fixture\n" + ("x".repeat(1023) + "\n").repeat(1800);
  await fs.writeFile(path.join(fixtureRoot, "large.txt"), largeFixture, "utf8");
  const server = await startServer(undefined, {
    toolMode: "full",
    rootPath: root,
    extraEnv: {
      CODEXPRO_MAX_OUTPUT_BYTES: "2000000",
      CODEXPRO_MAX_READ_BYTES: "2000000",
      CODEXPRO_BASH_MODE: "full",
      CODEXPRO_ALLOWED_ROOTS: `${root}${path.delimiter}${fixtureRoot}`
    }
  });
  try {
    const metrics = [{ phase: "warm-up", ...(await procMetrics(server.child.pid)) }];
    const responses = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await postInitialize(server, i === 3 ? { "mcp-session-id": "00000000-0000-0000-0000-000000000000" } : {});
      responses.push({ status: response.status, session: response.headers.get("mcp-session-id") });
      await response.text();
      assert.equal(response.status, 200, `stateless initialize ${i} failed`);
      assert.equal(response.headers.get("mcp-session-id"), null, "stateless response exposed a session header");
    }

    const notification = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    });
    await notification.text();
    assert.equal(notification.status, 202, "stateless initialized notification was not accepted");
    assert.equal(notification.headers.get("mcp-session-id"), null);

    const list = await postRpc(server, "tools/list", {}, {}, 3);
    assert.equal(list.response.status, 200, `stateless tools/list failed: ${list.body.slice(0, 300)}`);
    assert.equal(list.response.headers.get("mcp-session-id"), null, "stateless tools/list exposed a session header");
    assert.ok(Array.isArray(list.envelope?.result?.tools), "stateless tools/list did not return a tool catalog");

    const call = await postRpc(server, "tools/call", { name: "list_workspaces", arguments: {} }, {}, 4);
    assert.equal(call.response.status, 200, `stateless tools/call failed: ${call.body.slice(0, 300)}`);
    assert.equal(call.response.headers.get("mcp-session-id"), null, "stateless tools/call exposed a session header");
    assert.ok(call.envelope?.result, "stateless tools/call returned no JSON-RPC result");

    // ChatGPT-shaped request churn: each request is a fresh transport/server;
    // no session header or retained map may be used as a hidden shortcut.
    let sequentialOk = 0;
    for (let i = 0; i < 1_000; i += 1) {
      const result = await postRpc(server, "tools/list", {}, {}, 100 + i);
      assertStatelessEnvelope(result, `stateless sequential tools/list ${i}`);
      sequentialOk += 1;
    }
    const concurrent = await Promise.all(Array.from({ length: 64 }, (_, i) => postRpc(server, "tools/list", {}, {}, 2_000 + i)));
    concurrent.forEach((result, i) => assertStatelessEnvelope(result, `stateless concurrent tools/list ${i}`));
    metrics.push({ phase: "after-1000-sequential-64-concurrent", ...(await procMetrics(server.child.pid)) });
    console.log(`RAW_OBSERVATION: stateless request churn completed sequential=${sequentialOk} concurrent=${concurrent.length}; all ${sequentialOk + concurrent.length} responses were HTTP 200 without Mcp-Session-Id.`);

    const diagnostics = await postRpc(server, "tools/call", { name: "session_workspace_diagnostics", arguments: {} }, {}, 5);
    assert.equal(diagnostics.response.status, 200, `stateless diagnostics call failed: ${diagnostics.body.slice(0, 300)}`);
    assert.equal(diagnostics.response.headers.get("mcp-session-id"), null);
    const httpSessions = diagnostics.envelope?.result?.structuredContent?.http_sessions;
    assert.equal(httpSessions?.mode, "stateless");
    assert.equal(httpSessions?.retention_enabled, false);
    assert.equal(httpSessions?.active, 0, `stateless diagnostics exposed active retained sessions: ${JSON.stringify(httpSessions)}`);
    assert.equal(httpSessions?.max, 0);
    assert.equal(httpSessions?.ttl_ms, 0);
    assert.ok(httpSessions?.configured_max > 0, "stateless diagnostics omitted configured retained max");
    assert.ok(httpSessions?.retained_settings?.ignored, "stateless diagnostics did not mark retained settings ignored");
    assert.ok(httpSessions?.total_initialize_observations >= 4);
    assert.ok(httpSessions?.total_ordinary_requests >= 8);
    assert.ok(httpSessions?.current_request?.in_flight_requests >= 1, "stateless diagnostic did not observe its current request");
    assert.ok(httpSessions?.in_flight_requests >= 1, "stateless diagnostics did not expose current in-flight request count");
    assert.ok(httpSessions?.current_http_requests >= 1, "stateless diagnostics omitted the process-wide current HTTP in-flight count");
    assert.equal(httpSessions?.current_request?.in_flight_requests, httpSessions?.current_http_requests,
      "stateless process-wide and request-local in-flight counts disagree");

    const nested = await postRpc(server, "tools/call", {
      name: "open_workspace",
      arguments: { root: `${root}/src`, include_tree: false }
    }, {}, 6);
    const nestedWorkspaceId = nested.envelope?.result?.structuredContent?.workspace_id;
    assert.equal(nested.response.status, 200, `stateless open_workspace failed: ${nested.body.slice(0, 300)}`);
    assert.match(String(nestedWorkspaceId), /^ws_[0-9a-f]{24}$/);
    const defaultAfterNested = await postRpc(server, "tools/call", { name: "list_workspaces", arguments: {} }, {}, 7);
    assert.equal(defaultAfterNested.response.status, 200);
    assert.notEqual(defaultAfterNested.envelope?.result?.structuredContent?.selected_workspace_id, nestedWorkspaceId,
      "stateless list_workspaces inherited another request's selected workspace");
    const explicitDiagnostic = await postRpc(server, "tools/call", {
      name: "session_workspace_diagnostics",
      arguments: { workspace_id: nestedWorkspaceId }
    }, {}, 8);
    const requested = explicitDiagnostic.envelope?.result?.structuredContent?.requested_workspace;
    assert.equal(requested?.id, nestedWorkspaceId);
    assert.ok(["process_known_reconstructible", "configured_allowed_root_reconstructible"].includes(requested?.classification),
      `explicit workspace id did not reconstruct deterministically: ${JSON.stringify(requested)}`);
    const explicitSnapshot = await postRpc(server, "tools/call", {
      name: "workspace_snapshot",
      arguments: { workspace_id: nestedWorkspaceId, max_depth: 1, max_files: 10 }
    }, {}, 10);
    assert.equal(explicitSnapshot.response.status, 200, `explicit workspace snapshot failed: ${explicitSnapshot.body.slice(0, 300)}`);
    assert.equal(explicitSnapshot.envelope?.result?.structuredContent?.workspace_id, nestedWorkspaceId);
    assert.equal(explicitSnapshot.envelope?.result?.structuredContent?.root, `${root}/src`);

    // Two same-token request streams cannot inherit each other's selected
    // workspace. Explicit IDs reconstruct later, while omission uses the
    // configured default for the fresh request.
    const clientA = await postRpc(server, "tools/call", {
      name: "open_workspace", arguments: { root: fixtureRoot, include_tree: false }
    }, {}, 13);
    const clientB = await postRpc(server, "tools/call", {
      name: "open_workspace", arguments: { root: secondRoot, include_tree: false }
    }, {}, 14);
    const wsA = clientA.envelope?.result?.structuredContent?.workspace_id;
    const wsB = clientB.envelope?.result?.structuredContent?.workspace_id;
    assert.match(String(wsA), /^ws_[0-9a-f]{24}$/);
    assert.match(String(wsB), /^ws_[0-9a-f]{24}$/);
    assert.notEqual(wsA, wsB, "same-token stateless clients unexpectedly shared workspace identity");
    const freshA = await postRpc(server, "tools/call", { name: "list_workspaces", arguments: {} }, {}, 15);
    const freshB = await postRpc(server, "tools/call", { name: "list_workspaces", arguments: {} }, {}, 16);
    const selectedA = freshA.envelope?.result?.structuredContent?.selected_workspace_id;
    const selectedB = freshB.envelope?.result?.structuredContent?.selected_workspace_id;
    assert.equal(selectedA, selectedB, "same-token stateless clients did not resolve the same configured default independently");
    assert.ok(![wsA, wsB].includes(selectedA), "a fresh stateless request inherited a prior client's selected workspace");

    const changes = await postRpc(server, "tools/call", {
      name: "show_changes",
      arguments: { since: "last_shown", include_diff: false }
    }, {}, 11);
    const changesStructured = changes.envelope?.result?.structuredContent;
    assert.equal(changes.response.status, 200, `stateless show_changes failed: ${changes.body.slice(0, 300)}`);
    assert.equal(changesStructured?.review_since, "workspace");
    assert.equal(changesStructured?.review_since_requested, "last_shown");
    assert.equal(changesStructured?.review_checkpoint_hit, false);
    assert.equal(changesStructured?.review_checkpoint_persistent, false);
    assert.equal(changesStructured?.review_marked, false);
    assert.match(String(changes.envelope?.result?.content?.[0]?.text ?? ""), /fresh full workspace comparison/u);

    const fixtureWorkspace = await postRpc(server, "tools/call", {
      name: "open_workspace", arguments: { root: fixtureRoot, include_tree: false }
    }, {}, 16);
    const fixtureWorkspaceId = fixtureWorkspace.envelope?.result?.structuredContent?.workspace_id;
    const openForJobs = await postRpc(server, "tools/call", {
      name: "open_current_workspace", arguments: { include_tree: false }
    }, {}, 17);
    const jobWorkspaceId = openForJobs.envelope?.result?.structuredContent?.workspace_id;
    const started = await postRpc(server, "tools/call", {
      name: "start_verification",
      arguments: {
        workspace_id: jobWorkspaceId,
        runner: "package_script",
        package_manager: "npm",
        script: "verification:fixture",
        args: ["--sleep", "120"]
      }
    }, {}, 18);
    assertStatelessEnvelope(started, `stateless start_verification (workspace=${jobWorkspaceId})`);
    const jobId = started.envelope?.result?.structuredContent?.jobId;
    assert.match(String(jobId), /^vjob_[0-9a-f]{24}$/);
    const waited = await postRpc(server, "tools/call", {
      name: "wait_verification", arguments: { job_id: jobId, max_wait_seconds: 10 }
    }, {}, 19);
    assertStatelessEnvelope(waited, "stateless wait_verification");
    assert.equal(waited.envelope?.result?.structuredContent?.jobId, jobId);
    assert.equal(waited.envelope?.result?.structuredContent?.state, "succeeded");
    console.log(`RAW_OBSERVATION: process-scoped managed verification started in one stateless request and completed from an independent request via job_id=${jobId}.`);

    const pty = await postRpc(server, "tools/call", {
      name: "pty_run",
      arguments: {
        workspace_id: jobWorkspaceId,
        argv: ["node", "-e", "process.stdout.write('stateless-pty-ok\\n')"]
      }
    }, {}, 20);
    assertStatelessEnvelope(pty, "stateless synchronous pty_run");
    const ptyStructured = pty.envelope?.result?.structuredContent;
    assert.equal(ptyStructured?.state, "succeeded");
    assert.match(String(ptyStructured?.transcript), /stateless-pty-ok/u);
    assert.equal("job_id" in (ptyStructured ?? {}), false);
    assert.equal("run_id" in (ptyStructured ?? {}), false);
    console.log("RAW_OBSERVATION: stateless pty_run returned synchronously with terminal transcript and no continuation/job/run surface.");

    const largeRead = await postRpc(server, "tools/call", {
      name: "read", arguments: { workspace_id: fixtureWorkspaceId, path: "large.txt", max_bytes: 1_900_000 }
    }, {}, 21);
    assertStatelessEnvelope(largeRead, "stateless full large read");
    const largeText = largeRead.envelope?.result?.structuredContent?.text ?? "";
    assert.ok(largeText.length > 900_000, `full large response was only ${largeText.length} bytes`);
    const partialController = new AbortController();
    const partialPromise = fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 22, method: "tools/call", params: {
        name: "read", arguments: { workspace_id: fixtureWorkspaceId, path: "large.txt", max_bytes: 1_900_000 }
      }}),
      signal: partialController.signal
    });
    const partialResponse = await partialPromise;
    const reader = partialResponse.body?.getReader();
    assert.ok(reader, "partial large response had no readable body");
    await reader.read();
    await reader.cancel();
    partialController.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const afterPartial = await postRpc(server, "tools/call", {
      name: "session_workspace_diagnostics", arguments: {}
    }, {}, 23);
    const afterPartialHttp = afterPartial.envelope?.result?.structuredContent?.http_sessions;
    assert.equal(afterPartialHttp?.active, 0);
    assert.equal(afterPartialHttp?.idle, 0);
    assert.equal(afterPartialHttp?.max, 0);
    assert.equal(afterPartialHttp?.ttl_ms, 0);
    assert.equal(afterPartialHttp?.current_http_requests, afterPartialHttp?.current_request?.in_flight_requests);
    metrics.push({ phase: "final-settle", ...(await procMetrics(server.child.pid)) });
    console.log(`RAW_OBSERVATION: full large response bytes=${largeText.length}; partial response was cancelled after first chunk; stateless diagnostics settled active=${afterPartialHttp?.active}, idle=${afterPartialHttp?.idle}, in_flight=${afterPartialHttp?.in_flight_requests}.`);
    console.log(`RESOURCE_OBSERVATION: ${JSON.stringify(metrics)}; RSS/VmData/file-descriptor growth is measured, target V8 heap/active-handle/timer counts are not exposed by the product diagnostics.`);

    const get = await fetch(`${server.base}/mcp`, { headers: { accept: "application/json" } });
    await get.text();
    assert.equal(get.status, 406, "stateless GET did not follow SDK v1 Accept semantics");
    assert.equal(get.headers.get("mcp-session-id"), null);

    const del = await fetch(`${server.base}/mcp`, { method: "DELETE" });
    await del.text();
    assert.equal(del.status, 200, "stateless DELETE did not follow SDK v1 no-session semantics");
    assert.equal(del.headers.get("mcp-session-id"), null);

    const malformed = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: "{not-json"
    });
    await malformed.text();
    assert.equal(malformed.status, 400, "malformed body did not fail before stateless construction");
    assert.equal(malformed.headers.get("mcp-session-id"), null);

    const abortController = new AbortController();
    const aborted = fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { padding: "x".repeat(2_000_000) } }),
      signal: abortController.signal
    });
    abortController.abort();
    await aborted.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    console.log("RAW_OBSERVATION: default stateless path returned four successful initialize responses, notification, tools/list, and tools/call without Mcp-Session-Id; repeated GET/DELETE and malformed-body paths remained sessionless; an aborted large request was tolerated.");
    console.log(`AP-009/AP-010_PROVISIONAL: mode=stateless(default), initialize_count=${responses.length}, retained_session_headers=0, diagnostic_active=${httpSessions.active}, diagnostic_in_flight=${httpSessions.in_flight_requests}; route=per-request SDK v1 transport; list_tools=${list.envelope.result.tools.length}; call_result=${Boolean(call.envelope.result)}`);
  } finally {
    await stopServer(server);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function runInvalidMode() {
  for (const mode of ["auto", "bogus"]) {
    let server;
    try {
      server = await startServer(mode);
      const response = await postInitialize(server);
      const body = await response.text();
      const session = response.headers.get("mcp-session-id");
      contractFailures.push(`CODEXPRO_HTTP_SESSION_MODE=${mode} started and silently selected ${session ? "retained" : "stateless"} (HTTP ${response.status})`);
      console.log(`RAW_OBSERVATION: invalid explicit mode ${mode} started successfully; initialize returned HTTP ${response.status} with session_header=${session ?? "none"}.`);
      console.log(`RAW_BODY_PREFIX(${mode}): ${body.slice(0, 180)}`);
    } catch (error) {
      console.log(`RAW_OBSERVATION: invalid explicit mode ${mode} was rejected before healthz: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (server) await stopServer(server);
    }
  }
}

async function runAuthFailure() {
  const server = await startServer("stateless", { token: "http-stateless-auth-smoke-token-123456" });
  try {
    const response = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify(initBody)
    });
    await response.text();
    assert.equal(response.status, 401, "unauthenticated request was not rejected before construction");
    assert.equal(response.headers.get("mcp-session-id"), null);
    console.log("RAW_OBSERVATION: unauthenticated stateless MCP request returned 401 without a session header.");
  } finally {
    await stopServer(server);
  }
}

async function runOrdering() {
  const token = "http-stateless-ordering-smoke-token-123456";
  const server = await startServer("retained", { token, toolMode: "full" });
  try {
    const unauthMalformed = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: "{not-json"
    });
    const unauthMalformedBody = await unauthMalformed.text();
    assert.equal(unauthMalformed.status, 401, `auth did not precede malformed parsing: ${unauthMalformed.status} ${unauthMalformedBody}`);

    const unauthOversized = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list", params: { filler: "x".repeat(20 * 1024 * 1024 + 1) } })
    });
    const unauthOversizedBody = await unauthOversized.text();
    assert.equal(unauthOversized.status, 401, `auth did not precede body-limit parsing: ${unauthOversized.status} ${unauthOversizedBody.slice(0, 180)}`);

    const malformed = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: "{not-json"
    });
    const malformedBody = await malformed.text();
    assert.equal(malformed.status, 400, `malformed body status ${malformed.status}: ${malformedBody}`);

    const oversized = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: { filler: "x".repeat(20 * 1024 * 1024 + 1) } })
    });
    const oversizedBody = await oversized.text();
    assert.equal(oversized.status, 413, `body-limit status ${oversized.status}: ${oversizedBody.slice(0, 180)}`);

    const init = await postInitialize(server, { authorization: `Bearer ${token}` });
    const sessionId = init.headers.get("mcp-session-id");
    await init.text();
    assert.equal(init.status, 200);
    assert.ok(sessionId);
    const diagnostics = await postRpc(
      server,
      "tools/call",
      { name: "session_workspace_diagnostics", arguments: {} },
      { authorization: `Bearer ${token}`, "mcp-session-id": sessionId },
      10
    );
    assert.equal(diagnostics.response.status, 200, diagnostics.body.slice(0, 300));
    const httpSessions = diagnostics.envelope?.result?.structuredContent?.http_sessions;
    assert.equal(httpSessions?.mode, "retained");
    assert.equal(httpSessions?.retention_enabled, true);
    assert.equal(httpSessions?.total_initialized, 1, `pre-init failures created a retained transport: ${JSON.stringify(httpSessions)}`);
    assert.equal(httpSessions?.total_initialize_observations, 1);
    assert.ok(httpSessions?.current_session, "retained diagnostics lost current session continuity");
    assert.ok(httpSessions?.current_http_requests >= 1,
      `retained diagnostics omitted the process-wide current HTTP in-flight count; legacy in_flight_requests=${httpSessions?.in_flight_requests}`);
    console.log(`RAW_OBSERVATION: auth-before-parser returned unauthorized malformed=${unauthMalformed.status} and oversized=${unauthOversized.status}; authorized malformed=${malformed.status}, oversized=${oversized.status}; first valid initialize then reported total_initialized=${httpSessions.total_initialized}.`);
  } finally {
    await stopServer(server);
  }
}

async function runRetained() {
  const server = await startServer("retained", { toolMode: "full" });
  try {
    const initialize = await postInitialize(server);
    const sessionId = initialize.headers.get("mcp-session-id");
    await initialize.text();
    assert.equal(initialize.status, 200);
    assert.ok(sessionId, "retained initialize did not return a session header");

    const diagnostics = await postRpc(server, "tools/call", {
      name: "session_workspace_diagnostics",
      arguments: {}
    }, { "mcp-session-id": sessionId }, 12);
    const httpSessions = diagnostics.envelope?.result?.structuredContent?.http_sessions;
    assert.equal(diagnostics.response.status, 200, diagnostics.body.slice(0, 300));
    assert.equal(httpSessions?.mode, "retained");
    assert.equal(httpSessions?.retention_enabled, true);
    assert.equal(httpSessions?.max, 64);
    assert.equal(httpSessions?.ttl_ms, 1_800_000);
    assert.equal(httpSessions?.total_initialized, 1);
    assert.equal(httpSessions?.total_initialize_observations, 1);
    assert.ok(httpSessions?.total_ordinary_requests >= 2);

    const notification = await fetch(`${server.base}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })
    });
    await notification.text();
    assert.equal(notification.status, 202);

    const terminated = await fetch(`${server.base}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId, accept: "application/json, text/event-stream" }
    });
    await terminated.text();
    assert.equal(terminated.status, 200);
    console.log(`RAW_OBSERVATION: retained compatibility path returned session header ${sessionId.slice(0, 8)}… and accepted a follow-up notification plus DELETE through that retained session.`);
  } finally {
    await stopServer(server);
  }
}

await runStateless();
await runInvalidMode();
await runAuthFailure();
await runOrdering();
await runRetained();
if (contractFailures.length > 0) {
  console.error(`CONTRACT_FAILURES: ${contractFailures.join("; ")}`);
  process.exitCode = 1;
} else {
  console.log("PASS http stateless compatibility smoke");
}
