import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Expected-result authority: MISSION_PLAN.md TASK-004/AP-007/AP-008 and
// MISSION_ANCHOR.md A001 LAW-003/005/006/007/008/009/010/012/013/014.
// The implementation, tests, diagnostics, and labels below are not authority.
// TARGET_EVIDENCE is the real MCP registration/validation/handler route over
// HTTP and stdio. Direct source/schema inspection would be SUPPORTING_ORACLE.
const AUTH_TOKEN = "M004_PUBLIC_DIAGNOSTIC_AUTH_4e6c9a1b";
const HOSTILE_KEY = "OPENAI_API_KEY_UNKNOWN_PROPERTY_7X9";
const HOSTILE_SECRET = "sk-hostile-request-secret-7X9";
const REQUEST_SENTINEL = "REQUEST_BODY_SENTINEL_8K2";
const ENV_SENTINEL = "ENV_SENTINEL_4N8";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m004-public-diagnostics-"));
const nestedRoot = path.join(fixtureRoot, "nested-target");
await fs.mkdir(nestedRoot, { recursive: true });
await fs.writeFile(path.join(fixtureRoot, "fixture.txt"), "public diagnostic fixture\n", "utf8");
await fs.writeFile(path.join(nestedRoot, "target.txt"), "nested target fixture\n", "utf8");
execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
execFileSync("git", ["config", "user.email", "m004-public-diagnostic@example.invalid"], { cwd: fixtureRoot });
execFileSync("git", ["config", "user.name", "M004 Public Diagnostic"], { cwd: fixtureRoot });
execFileSync("git", ["add", "-A"], { cwd: fixtureRoot });
execFileSync("git", ["commit", "--quiet", "-m", "public diagnostic fixture"], { cwd: fixtureRoot });

process.env.CODEXPRO_ROOT = fixtureRoot;
process.env.CODEXPRO_ALLOWED_ROOTS = fixtureRoot;
process.env.CODEXPRO_HOST = "127.0.0.1";
process.env.CODEXPRO_TOOL_MODE = "full";
process.env.CODEXPRO_BASH_MODE = "off";
process.env.CODEXPRO_WRITE_MODE = "off";
process.env.CODEXPRO_TOOL_CARDS = "0";
process.env.CODEXPRO_HTTP_TOKEN = AUTH_TOKEN;
process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = "0";
process.env.CODEXPRO_M004_ENV_SENTINEL = ENV_SENTINEL;

const { loadConfig } = await import("../dist/config.js");
const { createCodexProHttpApp } = await import("../dist/http.js");

const realFixtureRoot = await fs.realpath(fixtureRoot);
const realNestedRoot = await fs.realpath(nestedRoot);
const targetId = `ws_${createHash("sha256").update(realNestedRoot).digest("hex").slice(0, 24)}`;

function configFor(bashMode) {
  return {
    ...loadConfig(),
    defaultRoot: realFixtureRoot,
    allowedRoots: [realFixtureRoot],
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    requireHttpToken: true,
    bashMode,
    writeMode: "off",
    toolMode: "full",
    toolCards: false,
    maxHttpSessions: 10,
    httpSessionTtlMs: 60_000
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => port ? resolve(port) : reject(new Error("no free port")));
    });
  });
}

async function listen(app) {
  const port = await freePort();
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  return { listener, url: `http://127.0.0.1:${port}/mcp` };
}

async function closeListener(listener) {
  if (!listener) return;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
}

function parseEnvelope(capture) {
  if (!capture?.body) return undefined;
  try {
    const parsed = JSON.parse(capture.body);
    if (parsed && typeof parsed === "object" && parsed.jsonrpc) return parsed;
  } catch {
    // Streamable HTTP commonly uses an SSE response body.
  }
  const messages = [];
  for (const line of capture.body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && parsed.jsonrpc) messages.push(parsed);
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }
  return messages.at(-1);
}

function captureFetch(captures) {
  return async (input, init) => {
    const response = await fetch(input, init);
    const body = await response.clone().text().catch(() => "");
    captures.push({
      method: init?.method ?? (typeof input === "object" ? input.method : "GET"),
      requestBody: typeof init?.body === "string" ? init.body : "",
      responseSessionId: response.headers.get("mcp-session-id") ?? "",
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body
    });
    return response;
  };
}

async function connectHttp(url, label) {
  const captures = [];
  const client = new Client({ name: `m004-public-diagnostic-${label}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: captureFetch(captures),
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport, captures, label };
}

function requestFor(session, method, name) {
  return [...session.captures].reverse().find((capture) => {
    if (capture.method !== "POST" || !capture.requestBody) return false;
    try {
      const request = JSON.parse(capture.requestBody);
      return request.method === method && (!name || request.params?.name === name);
    } catch {
      return false;
    }
  });
}

async function listHttp(session) {
  const listed = await session.client.listTools();
  const raw = parseEnvelope(requestFor(session, "tools/list"));
  assert.equal(raw?.jsonrpc, "2.0", `${session.label} tools/list had no complete raw envelope`);
  assert.ok(Array.isArray(raw?.result?.tools), `${session.label} raw tools/list omitted tools`);
  return { listed: listed.tools, raw };
}

async function callHttp(session, name, args = {}) {
  const before = session.captures.length;
  let result;
  let error;
  try {
    result = await session.client.callTool({ name, arguments: args });
  } catch (caught) {
    error = caught;
  }
  const capture = session.captures.slice(before).findLast((candidate) => {
    if (candidate.method !== "POST" || !candidate.requestBody) return false;
    try {
      const request = JSON.parse(candidate.requestBody);
      return request.method === "tools/call" && request.params?.name === name;
    } catch {
      return false;
    }
  });
  return { result, error, capture, raw: parseEnvelope(capture) };
}

function resultText(result) {
  return result?.content?.find?.((part) => part.type === "text")?.text ?? JSON.stringify(result?.structuredContent ?? result);
}

function assertSuccess(call, label) {
  assert.equal(call.error, undefined, `${label} threw: ${call.error?.message ?? call.error}`);
  assert.equal(call.raw?.jsonrpc, "2.0", `${label} lacked a complete JSON-RPC envelope`);
  assert.ok(call.raw?.result, `${label} raw envelope omitted result`);
  assert.notEqual(call.result?.isError, true, `${label} returned a tool error: ${resultText(call.result)}`);
  assert.ok(call.result?.structuredContent && typeof call.result.structuredContent === "object", `${label} omitted structuredContent`);
  return call.result;
}

function assertHostileError(call, label, literals, rawSessionIds = []) {
  assert.equal(call.error, undefined, `${label} threw outside the MCP envelope`);
  assert.equal(call.raw?.jsonrpc, "2.0", `${label} lacked a complete JSON-RPC envelope`);
  assert.ok(call.raw?.result, `${label} returned no raw result envelope`);
  assert.equal(call.result?.isError, true, `${label} unexpectedly succeeded`);
  const serialized = JSON.stringify({ raw: call.raw, result: call.result, body: call.capture?.body }) ?? "";
  assert.ok(serialized.length < 8_000, `${label} hostile response was unbounded (${serialized.length} bytes)`);
  for (const literal of [...literals, ...rawSessionIds]) assert.equal(serialized.includes(literal), false, `${label} echoed ${literal}`);
  return serialized;
}

function assertNoRoutingSecrets(value, label, rawSessionIds = []) {
  const serialized = JSON.stringify(value) ?? "";
  for (const literal of [AUTH_TOKEN, HOSTILE_SECRET, REQUEST_SENTINEL, ENV_SENTINEL, ...rawSessionIds]) {
    assert.equal(serialized.includes(literal), false, `${label} exposed ${literal}`);
  }
}

function diagnosticTool(tools, label) {
  const matches = tools.filter((tool) => tool.name === "session_workspace_diagnostics");
  assert.equal(matches.length, 1, `${label} exposed ${matches.length} diagnostic tools`);
  const tool = matches[0];
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  }, `${label} diagnostic annotations drifted`);
  const schema = tool.inputSchema;
  assert.equal(schema?.type, "object", `${label} diagnostic schema was not an object`);
  assert.equal(schema?.additionalProperties, false, `${label} diagnostic schema accepted unknown properties`);
  assert.deepEqual(Object.keys(schema.properties ?? {}), ["workspace_id"], `${label} diagnostic schema exposed extra properties`);
  assert.deepEqual(schema.required ?? [], [], `${label} diagnostic workspace_id became required`);
  assert.equal(schema.properties.workspace_id.type, "string", `${label} workspace_id was not a string`);
  assert.equal(schema.properties.workspace_id.minLength, 1, `${label} workspace_id lower bound drifted`);
  assert.equal(schema.properties.workspace_id.maxLength, 128, `${label} workspace_id upper bound drifted`);
  assert.equal(tool._meta?.ui, undefined, `${label} diagnostic unexpectedly exposed widget metadata`);
  assert.equal(tool._meta?.["openai/outputTemplate"], undefined, `${label} diagnostic unexpectedly exposed output template`);
  return tool;
}

function assertDiagnosticShape(data, label, requested = false) {
  assert.equal(data.codexpro_tool, "session_workspace_diagnostics", `${label} omitted stable tool tag`);
  assert.equal(data.codexpro_title, "Session and Workspace Diagnostics", `${label} changed stable tool title`);
  const domain = { ...data };
  delete domain.codexpro_tool;
  delete domain.codexpro_title;
  const expected = ["http_sessions", "runtime", "schema_version", "server", "session", "workspace"];
  if (requested) expected.push("requested_workspace");
  assert.deepEqual(Object.keys(domain).sort(), expected.sort(), `${label} structured groups drifted`);
  assert.equal(domain.schema_version, 1, `${label} schema_version was not 1`);
  assert.equal(typeof domain.runtime, "object", `${label} runtime group missing`);
  assert.equal(typeof domain.server, "object", `${label} server group missing`);
  assert.equal(typeof domain.session, "object", `${label} session group missing`);
  assert.equal(typeof domain.workspace, "object", `${label} workspace group missing`);
  assert.equal(typeof domain.server.catalog_fingerprint, "string", `${label} catalog fingerprint missing`);
  assert.match(domain.server.catalog_fingerprint, /^cat_[0-9a-f]{32}$/u, `${label} catalog fingerprint format drifted`);
  assert.equal(typeof domain.session.fingerprint, "string", `${label} session fingerprint missing`);
  assert.match(domain.session.fingerprint, /^[A-Za-z0-9_-]{20,}$/u, `${label} session fingerprint was not opaque`);
  assert.equal(Number.isInteger(domain.session.generation), true, `${label} session generation missing`);
  assert.equal(typeof domain.session.created_at, "string", `${label} session creation identity missing`);
  assert.equal(Number.isInteger(domain.session.age_ms), true, `${label} session age was not bounded integer`);
  assert.equal(typeof domain.server.registered_tool_count, "number", `${label} registered count missing`);
  assert.equal(typeof domain.workspace.process_known.valid, "number", `${label} process-known valid count missing`);
  assert.equal(typeof domain.workspace.process_known.stale, "number", `${label} process-known stale count missing`);
  assert.equal(Array.isArray(domain.workspace.session_opened), true, `${label} session-opened group missing`);
  assert.ok(JSON.stringify(data).length < 30_000, `${label} structured diagnostics exceeded bounded payload`);
}

class StdioClient {
  constructor(mode) {
    this.mode = mode;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(process.execPath, [
      "dist/stdio.js",
      "--root", fixtureRoot,
      "--allow-root", fixtureRoot,
      "--bash", "off",
      "--write", "off",
      "--tool-mode", mode
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        CODEXPRO_ROOT: fixtureRoot,
        CODEXPRO_ALLOWED_ROOTS: fixtureRoot,
        CODEXPRO_TOOL_MODE: mode,
        CODEXPRO_BASH_MODE: "off",
        CODEXPRO_WRITE_MODE: "off",
        CODEXPRO_HTTP_TOKEN: AUTH_TOKEN,
        CODEXPRO_M004_ENV_SENTINEL: ENV_SENTINEL
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`stdio server exited code=${code} signal=${signal}; stderr=${this.stderr}`));
      }
      this.pending.clear();
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
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.child.kill("SIGTERM");
    });
  }
}

function callStdio(client, name, args = {}) {
  return client.request("tools/call", { name, arguments: args });
}

function assertInstructions(instructions, label) {
  assert.match(instructions, /transport or MCP session change can lose the prior session selection/iu, `${label} omitted fresh-session selection loss`);
  assert.match(instructions, /diagnostics cannot force client transport reuse or refresh a stale direct tool catalog/iu, `${label} promised client control`);
  assert.match(instructions, /list_workspaces is session-local, not a process-global workspace directory/iu, `${label} omitted list_workspaces scope`);
  assert.match(instructions, /call session_workspace_diagnostics/iu, `${label} omitted diagnostic recovery route`);
  assert.match(instructions, /correctness-sensitive Git tools/iu, `${label} omitted explicit-ID guidance`);
  assert.match(instructions, /Harmless reads may omit it when ambient selection is clear/iu, `${label} forced explicit IDs for harmless reads`);
}

let offListener;
let safeListener;
let offUrl;
let safeUrl;
let sessionA;
let sessionB;
let safeSession;
const acceptance = { AP_007: "PASS", AP_008: "PASS" };

try {
  const offApp = createCodexProHttpApp(configFor("off"));
  ({ listener: offListener, url: offUrl } = await listen(offApp));
  sessionA = await connectHttp(offUrl, "http-a");
  const initializeCapture = requestFor(sessionA, "initialize");
  const initializeEnvelope = parseEnvelope(initializeCapture);
  assert.equal(initializeEnvelope?.jsonrpc, "2.0", "HTTP initialize lacked a complete raw envelope");
  assertInstructions(String(initializeEnvelope.result?.instructions ?? ""), "HTTP initialize");
  assertNoRoutingSecrets(initializeEnvelope, "HTTP initialize raw envelope", [initializeCapture?.responseSessionId ?? ""]);

  const listingA = await listHttp(sessionA);
  const diagTool = diagnosticTool(listingA.listed, "full HTTP");
  assertNoRoutingSecrets(listingA.raw, "HTTP tools/list raw envelope", [initializeCapture?.responseSessionId ?? ""]);
  assert.equal(listingA.listed.filter((tool) => tool.name === "session_workspace_diagnostics").length, 1);
  assert.equal(listingA.listed.some((tool) => tool.name === "bash"), false, "bash-off catalog still exposed bash");
  assert.equal(diagTool.annotations.readOnlyHint, true, "diagnostic was not read-only");
  assert.equal(diagTool.annotations.destructiveHint, false, "diagnostic was destructive");
  assert.equal(diagTool.annotations.openWorldHint, false, "diagnostic was open-world");

  // PASS 1: raw target evidence is the HTTP MCP route itself. Before reading
  // test verdicts/implementation fields, the observable contract is one tool
  // in full mode, a compact object response, and no routing/session secrets.
  const firstCall = await callHttp(sessionA, "session_workspace_diagnostics");
  const first = assertSuccess(firstCall, "HTTP diagnostic A first");
  const repeatedCall = await callHttp(sessionA, "session_workspace_diagnostics");
  const repeated = assertSuccess(repeatedCall, "HTTP diagnostic A repeated");
  assertDiagnosticShape(first.structuredContent, "HTTP A first");
  assertDiagnosticShape(repeated.structuredContent, "HTTP A repeated");
  assert.equal(first.structuredContent.session.fingerprint, repeated.structuredContent.session.fingerprint, "same HTTP session fingerprint changed");
  assert.equal(first.structuredContent.session.generation, repeated.structuredContent.session.generation, "same HTTP session generation changed");
  assert.equal(first.structuredContent.session.created_at, repeated.structuredContent.session.created_at, "same HTTP session creation identity changed");
  assert.equal(first.structuredContent.session.transport, "http", "HTTP diagnostic reported the wrong transport");
  assert.ok(first.structuredContent.http_sessions, "HTTP diagnostic omitted HTTP lifecycle aggregate");
  assert.equal(first.structuredContent.server.registered_tool_count, listingA.listed.length, "catalog count disagreed with actual tools/list");
  assert.deepEqual(first.structuredContent.workspace, repeated.structuredContent.workspace, "same-session diagnostics changed workspace state");
  assertNoRoutingSecrets(first, "HTTP diagnostic A first");
  assertNoRoutingSecrets(repeated, "HTTP diagnostic A repeated");
  assertNoRoutingSecrets(firstCall.raw, "HTTP diagnostic A first raw envelope", [firstCall.capture?.responseSessionId ?? ""]);
  assertNoRoutingSecrets(repeatedCall.raw, "HTTP diagnostic A repeated raw envelope", [repeatedCall.capture?.responseSessionId ?? ""]);
  assert.equal(resultText(first).length < 5_000, true, "diagnostic human text was not compact");

  const targetOpenCall = await callHttp(sessionA, "open_workspace", { root: nestedRoot, include_tree: false });
  const targetOpen = assertSuccess(targetOpenCall, "HTTP A target open");
  assert.equal(targetOpen.structuredContent.workspace_id, targetId, "target workspace id was not deterministic");
  const selectedCall = await callHttp(sessionA, "session_workspace_diagnostics", { workspace_id: targetId });
  const selected = assertSuccess(selectedCall, "HTTP A selected diagnostic");
  assertDiagnosticShape(selected.structuredContent, "HTTP A selected", true);
  assert.equal(selected.structuredContent.requested_workspace.classification, "selected_session_workspace");
  assert.equal(selected.structuredContent.requested_workspace.root, realNestedRoot);
  assert.equal(selected.structuredContent.workspace.selected.id, targetId);
  assertNoRoutingSecrets(selected, "HTTP A selected");
  assertNoRoutingSecrets(selectedCall.raw, "HTTP A selected raw envelope", [selectedCall.capture?.responseSessionId ?? ""]);

  // A/B same-server continuity: A has a selected target; B is a genuinely
  // separate HTTP MCP session and must not inherit A's selection or identity.
  sessionB = await connectHttp(offUrl, "http-b");
  const listingB = await listHttp(sessionB);
  assert.deepEqual(listingB.listed.map((tool) => tool.name), listingA.listed.map((tool) => tool.name), "same server config changed its actual tool set");
  const initialBCall = await callHttp(sessionB, "session_workspace_diagnostics");
  const initialB = assertSuccess(initialBCall, "HTTP B initial diagnostic");
  assertDiagnosticShape(initialB.structuredContent, "HTTP B initial");
  assert.equal(initialB.structuredContent.workspace.selected, null, "B diagnostic inherited A selection");
  assert.deepEqual(initialB.structuredContent.workspace.session_opened, [], "B diagnostic inherited A opened workspaces");
  assert.notEqual(initialB.structuredContent.session.fingerprint, first.structuredContent.session.fingerprint, "A/B session fingerprints were shared");
  assert.notEqual(initialB.structuredContent.session.generation, first.structuredContent.session.generation, "A/B session generations were shared");
  assert.equal(initialB.structuredContent.server.catalog_fingerprint, first.structuredContent.server.catalog_fingerprint, "A/B catalog fingerprint changed under same config");
  assert.equal(JSON.stringify(initialB.structuredContent).includes(targetId), false, "B initial diagnostic exposed A target outside a requested probe");
  assertNoRoutingSecrets(initialB, "HTTP B initial", [initialBCall.capture?.responseSessionId ?? "", requestFor(sessionA, "initialize")?.responseSessionId ?? ""]);

  const requestedBCall = await callHttp(sessionB, "session_workspace_diagnostics", { workspace_id: targetId });
  const requestedB = assertSuccess(requestedBCall, "HTTP B explicit diagnostic");
  assertDiagnosticShape(requestedB.structuredContent, "HTTP B explicit", true);
  assert.equal(requestedB.structuredContent.requested_workspace.id, targetId);
  assert.equal(requestedB.structuredContent.requested_workspace.classification, "process_known_reconstructible");
  assert.equal(requestedB.structuredContent.requested_workspace.root, realNestedRoot);
  assert.equal(requestedB.structuredContent.workspace.selected, null, "explicit diagnostic selected B workspace");
  assert.deepEqual(requestedB.structuredContent.workspace.session_opened, [], "explicit diagnostic opened target in B");
  assert.deepEqual(requestedB.structuredContent.workspace, initialB.structuredContent.workspace, "explicit diagnostic changed B workspace state");
  assert.equal(requestedB.structuredContent.workspace.process_known.valid >= 1, true, "explicit diagnostic omitted process-known target count");
  assertNoRoutingSecrets(requestedB, "HTTP B explicit", [requestedBCall.capture?.responseSessionId ?? "", requestFor(sessionA, "initialize")?.responseSessionId ?? ""]);
  const listAfterProbe = assertSuccess(await callHttp(sessionB, "list_workspaces"), "HTTP B ordinary list after diagnostic");
  assert.equal(listAfterProbe.structuredContent.selected_workspace_id, `ws_${createHash("sha256").update(realFixtureRoot).digest("hex").slice(0, 24)}`, "diagnostic changed B ordinary selection");
  const afterProbe = assertSuccess(await callHttp(sessionB, "session_workspace_diagnostics", { workspace_id: targetId }), "HTTP B post-list diagnostic");
  assert.equal(afterProbe.structuredContent.requested_workspace.classification, "process_known_reconstructible");
  assert.equal(afterProbe.structuredContent.workspace.selected.id, listAfterProbe.structuredContent.selected_workspace_id);
  assert.equal(afterProbe.structuredContent.workspace.session_opened.some((workspace) => workspace.id === targetId), false, "diagnostic/opened state unexpectedly contained target");

  const wrapperBaselineCall = await callHttp(sessionA, "session_workspace_diagnostics");
  const wrapperBaseline = assertSuccess(wrapperBaselineCall, "HTTP wrapper baseline diagnostic");
  assertDiagnosticShape(wrapperBaseline.structuredContent, "HTTP wrapper baseline");
  const actionsCall = await callHttp(sessionA, "codexpro", { action: "list_actions" });
  const actionsA = assertSuccess(actionsCall, "full HTTP wrapper list_actions");
  assert.equal(actionsA.structuredContent.actions.filter((action) => action === "session_workspace_diagnostics").length, 1, "full wrapper omitted or duplicated diagnostic action");
  const wrappedCall = await callHttp(sessionA, "codexpro", { action: "session_workspace_diagnostics", args: {} });
  const wrapped = assertSuccess(wrappedCall, "full HTTP wrapper diagnostic");
  assert.equal(wrapped.structuredContent.codexpro_super_action, "session_workspace_diagnostics");
  assert.equal(wrapped.structuredContent.schema_version, 1, "wrapper diagnostic omitted diagnostic schema");
  assert.equal(wrapped.structuredContent.session.fingerprint, wrapperBaseline.structuredContent.session.fingerprint, "wrapper diagnostic changed session identity");
  assert.equal(wrapped.structuredContent.server.catalog_fingerprint, wrapperBaseline.structuredContent.server.catalog_fingerprint, "wrapper diagnostic changed catalog identity");
  assert.deepEqual(wrapped.structuredContent.workspace, wrapperBaseline.structuredContent.workspace, "wrapper diagnostic changed workspace state");
  assertNoRoutingSecrets(wrapped, "HTTP wrapper diagnostic");
  assertNoRoutingSecrets(wrappedCall.raw, "HTTP wrapper diagnostic raw envelope", [wrappedCall.capture?.responseSessionId ?? ""]);

  const malformed = await callHttp(sessionA, "session_workspace_diagnostics", { [HOSTILE_KEY]: HOSTILE_SECRET, marker: REQUEST_SENTINEL });
  const knownHttpSessionIds = [
    initializeCapture?.responseSessionId,
    requestFor(sessionB, "initialize")?.responseSessionId
  ].filter(Boolean);
  assertHostileError(malformed, "unknown-property diagnostic", [HOSTILE_KEY, HOSTILE_SECRET, REQUEST_SENTINEL], knownHttpSessionIds);
  const malformedType = await callHttp(sessionA, "session_workspace_diagnostics", { workspace_id: 42, [HOSTILE_KEY]: HOSTILE_SECRET });
  assertHostileError(malformedType, "malformed-id diagnostic", [HOSTILE_KEY, HOSTILE_SECRET], knownHttpSessionIds);
  const oversized = await callHttp(sessionA, "session_workspace_diagnostics", { workspace_id: `${"x".repeat(10_000)}${REQUEST_SENTINEL}` });
  assertHostileError(oversized, "oversized-id diagnostic", [REQUEST_SENTINEL], knownHttpSessionIds);
  const whitespace = await callHttp(sessionA, "session_workspace_diagnostics", { workspace_id: ` ${targetId} ` });
  assertHostileError(whitespace, "whitespace-id diagnostic", [targetId], knownHttpSessionIds);

  const safeApp = createCodexProHttpApp(configFor("safe"));
  ({ listener: safeListener, url: safeUrl } = await listen(safeApp));
  safeSession = await connectHttp(safeUrl, "http-safe");
  const safeListing = await listHttp(safeSession);
  const safeNames = new Set(safeListing.listed.map((tool) => tool.name));
  const offNames = new Set(listingA.listed.map((tool) => tool.name));
  const actualCatalogDifference = [...new Set([...safeNames, ...offNames])].filter((name) => safeNames.has(name) !== offNames.has(name));
  assert.deepEqual(actualCatalogDifference, ["bash"], "bash mode did not produce an independently observed registered-tool-set difference");
  const safeDiagnosticCall = await callHttp(safeSession, "session_workspace_diagnostics");
  const safeDiagnostic = assertSuccess(safeDiagnosticCall, "safe-mode diagnostic");
  assert.notEqual(safeDiagnostic.structuredContent.server.catalog_fingerprint, first.structuredContent.server.catalog_fingerprint, "catalog fingerprint ignored actual registered surface change");
  assert.equal(safeDiagnostic.structuredContent.server.registered_tool_count, safeListing.listed.length, "safe catalog count disagreed with actual tools/list");
  assertNoRoutingSecrets(safeDiagnostic, "safe-mode diagnostic");
  assertNoRoutingSecrets(safeDiagnosticCall.raw, "safe-mode diagnostic raw envelope", [safeDiagnosticCall.capture?.responseSessionId ?? ""]);

  // Stdio target route independently proves truthful transport semantics and
  // null HTTP applicability, while the mode catalogs exercise real process
  // registration (not direct function/schema inspection).
  const stdioFull = new StdioClient("full");
  try {
    const init = await stdioFull.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "m004-public-diagnostic-stdio", version: "1.0.0" }
    });
    stdioFull.notify("notifications/initialized");
    assert.equal(init.jsonrpc, "2.0", "stdio initialize lacked a complete envelope");
    assertInstructions(String(init.result?.instructions ?? ""), "stdio initialize");
    const tools = await stdioFull.request("tools/list", {});
    assert.equal(tools.jsonrpc, "2.0", "stdio tools/list lacked a complete envelope");
    diagnosticTool(tools.result?.tools ?? [], "full stdio");
    const stdioDiagnostic = await callStdio(stdioFull, "session_workspace_diagnostics");
    assert.equal(stdioDiagnostic.jsonrpc, "2.0", "stdio diagnostic lacked a complete envelope");
    assert.notEqual(stdioDiagnostic.result?.isError, true, `stdio diagnostic failed: ${resultText(stdioDiagnostic.result)}`);
    assertDiagnosticShape(stdioDiagnostic.result.structuredContent, "stdio diagnostic");
    assert.equal(stdioDiagnostic.result.structuredContent.session.transport, "stdio", "stdio diagnostic reported the wrong transport");
    assert.equal(stdioDiagnostic.result.structuredContent.http_sessions, null, "stdio diagnostic fabricated HTTP lifecycle data");
    assertNoRoutingSecrets(stdioDiagnostic.result, "stdio diagnostic");
  } finally {
    await stdioFull.close();
  }

  for (const mode of ["standard", "minimal"]) {
    const stdio = new StdioClient(mode);
    try {
      await stdio.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `m004-public-diagnostic-${mode}`, version: "1.0.0" }
      });
      stdio.notify("notifications/initialized");
      const tools = await stdio.request("tools/list", {});
      const names = (tools.result?.tools ?? []).map((tool) => tool.name);
      assert.equal(names.includes("session_workspace_diagnostics"), false, `${mode} tools/list exposed full-only diagnostic`);
      const actions = await callStdio(stdio, "codexpro", { action: "list_actions" });
      assert.notEqual(actions.result?.isError, true, `${mode} wrapper list_actions failed`);
      assert.equal(actions.result.structuredContent.actions.includes("session_workspace_diagnostics"), false, `${mode} wrapper listed full-only diagnostic`);
      const denied = await callStdio(stdio, "codexpro", { action: "session_workspace_diagnostics" });
      assert.equal(denied.jsonrpc, "2.0", `${mode} wrapper denial lacked a complete envelope`);
      assert.equal(denied.result?.isError, true, `${mode} wrapper invoked unavailable diagnostic action`);
      assert.equal(denied.result?.structuredContent?.schema_version, undefined, `${mode} wrapper denial returned diagnostic semantics`);
    } finally {
      await stdio.close();
    }
  }

  // PASS 1 sanity verdict is based on the raw HTTP/stdio observations above;
  // technical assertions only explain/record those direct facts afterward.
  console.log("AUTHORITY: MISSION_PLAN.md TASK-004/AP-007/AP-008; MISSION_ANCHOR.md A001 LAW-003/005/006/007/008/009/010/012/013/014.");
  console.log("TARGET_PRODUCER: actual createCodexProHttpApp -> StreamableHTTPServerTransport and dist/stdio.js -> StdioServerTransport MCP registrations/handlers.");
  console.log(`RAW_OBSERVATION: full HTTP tools/list exposed exactly one session_workspace_diagnostics with only workspace_id; repeated A diagnostics kept fingerprint/generation/creation identity; B had a distinct identity and no inherited selection; raw JSON-RPC envelopes contained no MCP session IDs/auth/request/env sentinels.`);
  console.log(`RAW_OBSERVATION: explicit B workspace probe classified ${targetId} as process_known_reconstructible without selecting/opening it; ordinary list_workspaces subsequently selected only the configured default; bash-off vs bash-safe actual catalogs differed by [bash] before catalog hashes were compared.`);
  console.log("RAW_OBSERVATION: full stdio diagnostic reported transport=stdio and http_sessions=null; standard/minimal tools/list and wrapper actions omitted the diagnostic and denied wrapper invocation.");
  console.log("SANITY_VERDICT: MATCH — direct MCP catalogs, response envelopes, continuity identities, state classifications, and transport facts match the accepted TASK-004 public outcome.");
  console.log("PREDICATE: TRUE — actual tools/list established the registered-surface difference independently before catalog fingerprint comparison; raw tool-call envelopes established the corresponding diagnostic results and hostile failures.");
  console.log("TARGET_EVIDENCE: real HTTP/stdio MCP tools/list, initialize, and tools/call envelopes plus actual catalog sets and ordinary workspace state transitions.");
  console.log("SUPPORTING_ORACLE: package script/build and source/schema inspection only; no mock, fixture, direct handler, or generated stand-in was used as target evidence.");
  console.log(`ACCEPTANCE_MATRIX: ${JSON.stringify(acceptance)}; EVIDENCE_CONFLICT: none.`);
  console.log("✓ session_workspace_diagnostics public MCP smoke passed");
} finally {
  await safeSession?.transport.terminateSession().catch(() => {});
  await safeSession?.client.close().catch(() => {});
  await sessionB?.transport.terminateSession().catch(() => {});
  await sessionB?.client.close().catch(() => {});
  await sessionA?.transport.terminateSession().catch(() => {});
  await sessionA?.client.close().catch(() => {});
  await closeListener(safeListener).catch(() => {});
  await closeListener(offListener).catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
