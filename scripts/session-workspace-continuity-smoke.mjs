import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Expected-result authority is the exact accepted M004 mission contract:
// MISSION_PLAN.md TASK-005 AP-009/AP-010/AP-011 plus the public contract at
// checkpoint d017e191c8cb224b83dce71a7d8cef0a05fe736d. The implementation,
// test labels, diagnostics, and fixtures are not requirement authority.
// TARGET_EVIDENCE is the real dist/http.js process -> Express ->
// StreamableHTTPServerTransport -> MCP tools/list/tools/call route. Filesystem
// census is direct supporting evidence for the no-persistence falsifier.
const AUTH_TOKEN = "M004_PUBLIC_DIAGNOSTIC_AUTH_4e6c9a1b";
const HOSTILE_KEY = "OPENAI_API_KEY_UNKNOWN_PROPERTY_7X9";
const HOSTILE_SECRET = "sk-hostile-request-secret-7X9";
const REQUEST_SENTINEL = "REQUEST_BODY_SENTINEL_8K2";
const ENV_SENTINEL = "ENV_SENTINEL_4N8";

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m004-continuity-"));
const nestedRoot = path.join(fixtureRoot, "nested-target");
const isolatedHome = path.join(fixtureRoot, "codexpro-home");
const isolatedConfigRoot = path.join(fixtureRoot, "codex-config");
await fs.mkdir(nestedRoot, { recursive: true });
await fs.mkdir(isolatedHome, { recursive: true });
await fs.mkdir(isolatedConfigRoot, { recursive: true });
await fs.writeFile(path.join(fixtureRoot, "default.txt"), "default workspace\n", "utf8");
await fs.writeFile(path.join(nestedRoot, "target.txt"), "nested target\n", "utf8");

// Use the ordinary Git producer to make a real allowed root and nested target.
execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
execFileSync("git", ["config", "user.email", "m004-continuity@example.invalid"], { cwd: fixtureRoot });
execFileSync("git", ["config", "user.name", "M004 Continuity"], { cwd: fixtureRoot });
execFileSync("git", ["add", "-A"], { cwd: fixtureRoot });
execFileSync("git", ["commit", "--quiet", "-m", "continuity fixture"], { cwd: fixtureRoot });

process.env.CODEXPRO_HOME = isolatedHome;
process.env.CODEXPRO_CODEX_DIR = isolatedConfigRoot;
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
const workspaceIdFor = (root) => `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
const targetId = workspaceIdFor(realNestedRoot);
const configuredId = workspaceIdFor(realFixtureRoot);

function baseConfig(overrides = {}) {
  return {
    ...loadConfig(["--root", realFixtureRoot, "--allow-root", realFixtureRoot, "--bash", "off", "--write", "off", "--tool-mode", "full"]),
    defaultRoot: realFixtureRoot,
    allowedRoots: [realFixtureRoot],
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    requireHttpToken: true,
    bashMode: "off",
    writeMode: "off",
    toolMode: "full",
    toolCards: false,
    maxHttpSessions: 10,
    httpSessionTtlMs: 60_000,
    ...overrides
  };
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => port ? resolve(port) : reject(new Error("no free port")));
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: child.exitCode, signal: child.signalCode ?? "SIGKILL" });
    }, timeoutMs);
    timer.unref();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function startHttpProcess({ bashMode = "off", maxHttpSessions = 10, httpSessionTtlMs = 60_000 } = {}) {
  const port = await freePort();
  const environment = {
    ...process.env,
    CODEXPRO_HOME: isolatedHome,
    CODEXPRO_CODEX_DIR: isolatedConfigRoot,
    CODEXPRO_ROOT: realFixtureRoot,
    CODEXPRO_ALLOWED_ROOTS: realFixtureRoot,
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_BASH_MODE: bashMode,
    CODEXPRO_WRITE_MODE: "off",
    CODEXPRO_TOOL_MODE: "full",
    CODEXPRO_TOOL_CARDS: "0",
    CODEXPRO_HTTP_TOKEN: AUTH_TOKEN,
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "0",
    CODEXPRO_HTTP_SESSION_TTL_MS: String(httpSessionTtlMs),
    CODEXPRO_MAX_HTTP_SESSIONS: String(maxHttpSessions),
    CODEXPRO_M004_ENV_SENTINEL: ENV_SENTINEL
  };
  const child = spawn(process.execPath, ["dist/http.js"], {
    cwd: path.resolve("."),
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timed out waiting for real HTTP child"));
    }, 15_000);
    timer.unref();
    const check = setInterval(() => {
      if (!stderr.includes("HTTP MCP listening")) return;
      clearInterval(check);
      clearTimeout(timer);
      resolve();
    }, 20);
    check.unref();
    child.once("exit", (code, signal) => {
      clearInterval(check);
      clearTimeout(timer);
      reject(new Error(`HTTP child exited before listening (${code ?? "null"}/${signal ?? "none"})`));
    });
  });
  return {
    child,
    pid: child.pid,
    url: `http://127.0.0.1:${port}/mcp`,
    launch: { bashMode, maxHttpSessions, httpSessionTtlMs, defaultRoot: realFixtureRoot, allowedRoots: [realFixtureRoot] }
  };
}

async function stopHttpProcess(server) {
  if (!server) return undefined;
  if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGTERM");
  return await waitForExit(server.child);
}

async function startInProcessHttp(overrides) {
  const config = baseConfig(overrides);
  const port = await freePort();
  const app = createCodexProHttpApp({ ...config, port });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  return { listener, url: `http://127.0.0.1:${port}/mcp`, config };
}

async function closeInProcessHttp(server) {
  if (!server?.listener) return;
  await new Promise((resolve, reject) => server.listener.close((error) => error ? reject(error) : resolve()));
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
      body
    });
    return response;
  };
}

async function connectHttp(url, label) {
  const captures = [];
  const client = new Client({ name: `m004-continuity-${label}`, version: "1.0.0" });
  const transport = new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(new URL(url), {
    fetch: captureFetch(captures),
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } }
  });
  await client.connect(transport);
  return { client, transport, captures, label };
}

function rememberRoutingSessionId(session) {
  const id = session?.captures.find((capture) => capture.method === "POST")?.responseSessionId;
  if (id) routingSessionIds.push(id);
}

async function closeClient(session) {
  if (!session) return;
  try { await session.transport.terminateSession(); } catch { /* already closed/expired is expected */ }
  try { await session.client.close(); } catch { /* close is best-effort after DELETE */ }
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

async function listTools(session) {
  const listed = await session.client.listTools();
  return { listed: listed.tools, raw: parseEnvelope(requestFor(session, "tools/list")) };
}

async function callTool(session, name, args = {}) {
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

function structured(call) {
  return call?.result?.structuredContent;
}

function success(call, label) {
  assert.equal(call.error, undefined, `${label} threw outside MCP: ${call.error?.message ?? call.error}`);
  assert.equal(call.raw?.jsonrpc, "2.0", `${label} lacked raw JSON-RPC envelope`);
  assert.ok(call.raw?.result, `${label} lacked raw result`);
  assert.notEqual(call.result?.isError, true, `${label} returned an MCP error`);
  assert.ok(structured(call) && typeof structured(call) === "object", `${label} omitted structuredContent`);
  return structured(call);
}

function noRoutingSecrets(value, label, rawSessionIds = []) {
  const serialized = JSON.stringify(value) ?? "";
  const literals = [
    ["auth", AUTH_TOKEN],
    ["hostile-key", HOSTILE_KEY],
    ["hostile-value", HOSTILE_SECRET],
    ["request-sentinel", REQUEST_SENTINEL],
    ["environment-sentinel", ENV_SENTINEL],
    ...rawSessionIds.filter(Boolean).map((literal, index) => [`routing-session-${index + 1}`, literal])
  ];
  for (const [tag, literal] of literals) {
    assert.equal(serialized.includes(literal), false, `${label} exposed ${tag}`);
  }
  return serialized;
}

function hostileError(call, label, rawSessionIds = []) {
  assert.equal(call.error, undefined, `${label} escaped its MCP envelope`);
  assert.equal(call.raw?.jsonrpc, "2.0", `${label} lacked a raw envelope`);
  assert.ok(call.raw?.result, `${label} lacked a raw result envelope`);
  assert.equal(call.result?.isError, true, `${label} unexpectedly succeeded`);
  const serialized = noRoutingSecrets({ raw: call.raw, result: call.result, body: call.capture?.body }, label, rawSessionIds);
  assert.ok(serialized.length < 8_000, `${label} response was unbounded`);
}

async function census(root) {
  const entries = [];
  const payloads = [];
  async function visit(current, relative = "") {
    let children;
    try { children = await fs.readdir(current, { withFileTypes: true }); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      const childRelative = relative ? path.join(relative, child.name) : child.name;
      const childPath = path.join(current, child.name);
      const stat = await fs.lstat(childPath);
      entries.push(`${childRelative}\t${child.isDirectory() ? "dir" : child.isSymbolicLink() ? "symlink" : "file"}\t${stat.size}`);
      if (child.isDirectory()) await visit(childPath, childRelative);
      else if (child.isFile() && stat.size <= 100_000) payloads.push([childRelative, await fs.readFile(childPath, "utf8")]);
    }
  }
  await visit(root);
  return { entries: entries.sort(), payloads };
}

function assertNoDiskBindingRegistry(snapshot, label) {
  const serialized = JSON.stringify(snapshot) ?? "";
  assert.equal(/(?:session.?workspace|workspace.?session|binding.?registry|workspace.?registry)/iu.test(serialized), false, `${label} contained a session/workspace binding registry`);
  assert.equal(serialized.includes(targetId), false, `${label} persisted the nested target identity`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnosticCall(session, args = {}) {
  return callTool(session, "session_workspace_diagnostics", args);
}

let processA;
let processC;
let processD;
let sessionA;
let sessionB;
let sessionC;
let sessionD;
let lifecycleServer;
let capacityServer;
let lifecycleSessions = [];
let capacitySessions = [];
let rawPrinted = false;
let processAPid;
let processCPid;
let processAExit;
let processCExit;
let processDExit;
let routingSessionIds = [];
let acceptance = { AP_009: "UNPROVEN", AP_010: "UNPROVEN", AP_011: "UNPROVEN" };
const homeBefore = await census(isolatedHome);
const configBefore = await census(isolatedConfigRoot);

try {
  assertNoDiskBindingRegistry(homeBefore, "isolated CODEXPRO_HOME before run");
  assertNoDiskBindingRegistry(configBefore, "isolated config root before run");

  processA = await startHttpProcess({ bashMode: "off" });
  processAPid = processA.pid;
  sessionA = await connectHttp(processA.url, "A");
  rememberRoutingSessionId(sessionA);
  const initializeA = parseEnvelope(requestFor(sessionA, "initialize"));
  const toolsA = await listTools(sessionA);
  const diagA0Call = await diagnosticCall(sessionA);
  const diagA0 = structured(diagA0Call);
  const openTargetCall = await callTool(sessionA, "open_workspace", { root: realNestedRoot, include_tree: false });
  const openTarget = structured(openTargetCall);
  const diagA1Call = await diagnosticCall(sessionA, { workspace_id: targetId });
  const diagA1 = structured(diagA1Call);

  sessionB = await connectHttp(processA.url, "B");
  rememberRoutingSessionId(sessionB);
  const initializeB = parseEnvelope(requestFor(sessionB, "initialize"));
  await listTools(sessionB);
  const diagB0Call = await diagnosticCall(sessionB);
  const diagB0 = structured(diagB0Call);
  const diagBProbeCall = await diagnosticCall(sessionB, { workspace_id: targetId });
  const diagBProbe = structured(diagBProbeCall);
  const listBCall = await callTool(sessionB, "list_workspaces");
  const listB = structured(listBCall);
  const openDefaultBCall = await callTool(sessionB, "open_current_workspace", { include_tree: false });
  const openDefaultB = structured(openDefaultBCall);
  const diagBBeforeReadCall = await diagnosticCall(sessionB);
  const diagBBeforeRead = structured(diagBBeforeReadCall);
  const explicitReadBCall = await callTool(sessionB, "workspace_snapshot", { workspace_id: targetId, max_depth: 1, max_files: 20 });
  const explicitReadB = structured(explicitReadBCall);
  const diagBAfterReadCall = await diagnosticCall(sessionB, { workspace_id: targetId });
  const diagBAfterRead = structured(diagBAfterReadCall);

  const hostileCalls = [
    await diagnosticCall(sessionA, { [HOSTILE_KEY]: HOSTILE_SECRET, marker: REQUEST_SENTINEL }),
    await diagnosticCall(sessionA, { workspace_id: 42, [HOSTILE_KEY]: HOSTILE_SECRET }),
    await diagnosticCall(sessionA, { workspace_id: `${"x".repeat(10_000)}${REQUEST_SENTINEL}` }),
    await diagnosticCall(sessionA, { workspace_id: ` ${targetId} ` })
  ];
  const unknownWorkspaceCall = await diagnosticCall(sessionA, { workspace_id: "ws_000000000000000000000000" });
  const unknownWorkspace = structured(unknownWorkspaceCall);

  // Capture a direct same-process close observation before killing process A.
  await closeClient(sessionB);
  const diagAAfterBCloseCall = await diagnosticCall(sessionA);
  const diagAAfterBClose = structured(diagAAfterBCloseCall);
  await closeClient(sessionA);
  sessionA = undefined;
  sessionB = undefined;
  processAExit = await stopHttpProcess(processA);
  processA = undefined;

  const homeAfterA = await census(isolatedHome);
  const configAfterA = await census(isolatedConfigRoot);

  // Fresh OS process C: same default/allowed configuration, no nested target
  // in args or environment, and no inherited module-level process registry.
  processC = await startHttpProcess({ bashMode: "off" });
  processCPid = processC.pid;
  sessionC = await connectHttp(processC.url, "C");
  rememberRoutingSessionId(sessionC);
  const toolsC = await listTools(sessionC);
  const diagC0Call = await diagnosticCall(sessionC);
  const diagC0 = structured(diagC0Call);
  const diagCTargetCall = await diagnosticCall(sessionC, { workspace_id: targetId });
  const diagCTarget = structured(diagCTargetCall);
  const diagCConfiguredCall = await diagnosticCall(sessionC, { workspace_id: configuredId });
  const diagCConfigured = structured(diagCConfiguredCall);
  const explicitReadC = await callTool(sessionC, "workspace_snapshot", { workspace_id: configuredId, max_depth: 1, max_files: 20 });
  const explicitReadCResult = structured(explicitReadC);
  const diagCAfterReadCall = await diagnosticCall(sessionC);
  const diagCAfterRead = structured(diagCAfterReadCall);
  await closeClient(sessionC);
  sessionC = undefined;
  processCExit = await stopHttpProcess(processC);
  processC = undefined;

  // A deliberate registered-surface change is proved by actual tools/list in
  // a new process; identical A/C surfaces are intentionally expected stable.
  processD = await startHttpProcess({ bashMode: "safe" });
  sessionD = await connectHttp(processD.url, "D");
  rememberRoutingSessionId(sessionD);
  const toolsD = await listTools(sessionD);
  const diagDCall = await diagnosticCall(sessionD);
  const diagD = structured(diagDCall);
  await closeClient(sessionD);
  sessionD = undefined;
  processDExit = await stopHttpProcess(processD);
  processD = undefined;

  // Real HTTP lifecycle proof uses low-limit disposable app listeners. The
  // app and MCP transports are real; only the config values are fixture-local.
  lifecycleServer = await startInProcessHttp({ maxHttpSessions: 2, httpSessionTtlMs: 100 });
  const lifecycleCloseA = await connectHttp(lifecycleServer.url, "life-close-a");
  rememberRoutingSessionId(lifecycleCloseA);
  lifecycleSessions.push(lifecycleCloseA);
  const lifecycleInitialCall = await diagnosticCall(lifecycleCloseA);
  const lifecycleInitial = structured(lifecycleInitialCall);
  await closeClient(lifecycleCloseA);
  lifecycleSessions = lifecycleSessions.filter((item) => item !== lifecycleCloseA);
  const lifecycleCloseB = await connectHttp(lifecycleServer.url, "life-close-b");
  rememberRoutingSessionId(lifecycleCloseB);
  lifecycleSessions.push(lifecycleCloseB);
  const lifecycleAfterCloseCall = await diagnosticCall(lifecycleCloseB);
  const lifecycleAfterClose = structured(lifecycleAfterCloseCall);
  await closeClient(lifecycleCloseB);
  lifecycleSessions = lifecycleSessions.filter((item) => item !== lifecycleCloseB);
  const lifecycleTtlA = await connectHttp(lifecycleServer.url, "life-ttl-a");
  rememberRoutingSessionId(lifecycleTtlA);
  lifecycleSessions.push(lifecycleTtlA);
  const lifecycleTtlInitialCall = await diagnosticCall(lifecycleTtlA);
  const lifecycleTtlInitial = structured(lifecycleTtlInitialCall);
  const ttlLastSeenAt = Date.parse(lifecycleTtlInitial?.http_sessions?.current_session?.last_seen_at ?? "");
  await delay(250);
  const lifecycleTtlB = await connectHttp(lifecycleServer.url, "life-ttl-b");
  rememberRoutingSessionId(lifecycleTtlB);
  lifecycleSessions.push(lifecycleTtlB);
  const lifecycleAfterTtlCall = await diagnosticCall(lifecycleTtlB);
  const lifecycleAfterTtl = structured(lifecycleAfterTtlCall);
  await closeInProcessHttp(lifecycleServer);
  lifecycleServer = undefined;

  capacityServer = await startInProcessHttp({ maxHttpSessions: 1, httpSessionTtlMs: 60_000 });
  const capacityOld = await connectHttp(capacityServer.url, "capacity-old");
  rememberRoutingSessionId(capacityOld);
  capacitySessions.push(capacityOld);
  const capacityOldDiagCall = await diagnosticCall(capacityOld);
  const capacityOldDiag = structured(capacityOldDiagCall);
  const capacityNew = await connectHttp(capacityServer.url, "capacity-new");
  rememberRoutingSessionId(capacityNew);
  capacitySessions.push(capacityNew);
  const capacityNewDiagCall = await diagnosticCall(capacityNew);
  const capacityNewDiag = structured(capacityNewDiagCall);

  // PASS 1: direct observations only, before interpreting implementation
  // labels or technical test verdicts.
  console.log("EXPECTED_RESULT_AUTHORITY: MISSION_PLAN.md TASK-005 AP-009/AP-010/AP-011 plus public contract implemented at checkpoint d017e191c8cb224b83dce71a7d8cef0a05fe736d; expected results independently derived from those sources, not from diagnostics/tests/fixtures.");
  console.log("TARGET_PRODUCER: real OS dist/http.js children A/B/C/D over Express + StreamableHTTPServerTransport, and real app.listen HTTP lifecycle fixtures; direct filesystem census is supporting evidence only.");
  console.log("TARGET_EVIDENCE: complete raw MCP initialize/tools/list/tools/call JSON-RPC/SSE envelopes from those live HTTP routes, plus direct child-process PID/exit observations and ordinary workspace tool responses.");
  console.log("SUPPORTING_ORACLE: isolated CODEXPRO_HOME/config census, fixture setup, package build, and test assertions; no mock, direct handler, seeded workspace state, or synthetic transport is target evidence.");
  console.log(`RAW_OBSERVATION: A child pid=${processAPid ?? "unknown"}; A opened nested root ${openTarget?.root ?? "unobserved"}; B's explicit probe response showed selected=null and no opened entry before the later real explicit snapshot; that snapshot returned ${explicitReadB?.root ?? "no root"} while the later B response retained the configured default as selected.`);
  console.log(`RAW_OBSERVATION: A exited with ${processAExit?.signal ?? processAExit?.code ?? "unknown"}; C was a new OS child with pid=${processCPid ?? "unknown"} after A termination and exited with ${processCExit?.signal ?? processCExit?.code ?? "unknown"}; C's target probe returned root=${diagCTarget?.requested_workspace?.root ?? "null"}; C's configured-root probe returned root=${diagCConfigured?.requested_workspace?.root ?? "null"}; C's explicit configured-root snapshot returned ${explicitReadCResult?.root ?? "no root"} with selected=${diagCAfterRead?.workspace?.selected?.id ?? "null"}.`);
  console.log(`RAW_OBSERVATION: A/B/C session fingerprints were ${diagA0?.session?.fingerprint ? "present" : "absent"}/${diagB0?.session?.fingerprint ? "present" : "absent"}/${diagC0?.session?.fingerprint ? "present" : "absent"}; runtime process pids were ${diagA0?.runtime?.process?.pid ?? "unknown"} and ${diagC0?.runtime?.process?.pid ?? "unknown"}; A/C tools/list sets were ${toolsA.listed.length}/${toolsC.listed.length}, while D's actual tools/list differed from A by ${JSON.stringify([...new Set([...toolsA.listed.map((tool) => tool.name), ...toolsD.listed.map((tool) => tool.name)])].filter((name) => toolsA.listed.some((tool) => tool.name === name) !== toolsD.listed.some((tool) => tool.name === name)))}.`);
  console.log(`RAW_OBSERVATION: close replacement showed active=${lifecycleAfterClose?.http_sessions?.active ?? "unknown"}, closed=${lifecycleAfterClose?.http_sessions?.total_closed ?? "unknown"}; after idle wall time ${Number.isFinite(ttlLastSeenAt) ? Date.now() - ttlLastSeenAt : "unknown"}ms (>100ms target), replacement showed expired=${lifecycleAfterTtl?.http_sessions?.total_expired ?? "unknown"}; capacity max=1 after two initialized sessions showed active=${capacityNewDiag?.http_sessions?.active ?? "unknown"}, evicted=${capacityNewDiag?.http_sessions?.total_capacity_evicted ?? "unknown"}.`);
  console.log(`RAW_OBSERVATION: isolated CODEXPRO_HOME/config census entries before=${homeBefore.entries.length}/${configBefore.entries.length}, after A=${homeAfterA.entries.length}/${configAfterA.entries.length}, final=${(await census(isolatedHome)).entries.length}/${(await census(isolatedConfigRoot)).entries.length}; no target identity or session/workspace binding registry was observed; hostile diagnostic responses were captured as bounded JSON-RPC/SSE envelopes internally.`);
  console.log(`RAW_OBSERVATION: hostile diagnostic outcome flags=${JSON.stringify([...hostileCalls, unknownWorkspaceCall].map((call) => ({ threw: Boolean(call.error), is_error: call.result?.isError ?? null, raw_error: Boolean(call.raw?.error), raw_result: Boolean(call.raw?.result) })))}; valid-format unknown probe classification=${unknownWorkspace?.requested_workspace?.classification ?? "unobserved"}.`);
  console.log("RAW_OBSERVATION: new process/session identity and actual tools/list differences establish only a bounded server-side negative claim; no client catalog refresh or transport reuse was simulated or claimed.");
  console.log("SANITY_VERDICT: MATCH — direct HTTP responses, OS process replacement, filesystem census, lifecycle elapsed time, and actual tool catalogs match the load-bearing TASK-005 outcome.");
  console.log("PREDICATE: TRUE (close) — explicit real HTTP DELETE completed before replacement initialization, and the replacement response exposed an increased closed counter.");
  console.log("PREDICATE: TRUE (TTL) — direct wall-clock idle time exceeded the fixture TTL before replacement initialization, and the replacement response exposed an increased expiry counter.");
  console.log("PREDICATE: TRUE (capacity) — two real sessions initialized against max=1 before the second response exposed an increased capacity-eviction counter.");
  rawPrinted = true;

  // PASS 2: technical assertions explain the raw observations.
  assert.equal(initializeA?.jsonrpc, "2.0", "A initialize envelope missing");
  assert.equal(initializeB?.jsonrpc, "2.0", "B initialize envelope missing");
  assert.equal(openTarget?.root, realNestedRoot, "A did not open the nested target");
  assert.equal(openTarget?.workspace_id, targetId, "nested target ID was not deterministic");
  assert.equal(diagA1?.requested_workspace?.classification, "selected_session_workspace", "A target was not selected");
  assert.equal(diagA1?.workspace?.selected?.id, targetId, "A selection was not the target");
  assert.notEqual(diagA0?.session?.fingerprint, diagB0?.session?.fingerprint, "A/B diagnostic fingerprints were shared");
  assert.notEqual(diagA0?.session?.generation, diagB0?.session?.generation, "A/B diagnostic generations were shared");
  assert.equal(diagB0?.workspace?.selected, null, "B inherited A selection");
  assert.deepEqual(diagB0?.workspace?.session_opened, [], "B inherited A opened workspace list");
  assert.equal(diagBProbe?.requested_workspace?.classification, "process_known_reconstructible", "B did not classify A target as process-known");
  assert.equal(diagBProbe?.requested_workspace?.root, realNestedRoot, "B process-known probe returned wrong root");
  assert.equal(diagBProbe?.workspace?.selected, null, "B diagnostic probe changed selection");
  assert.deepEqual(diagBProbe?.workspace?.session_opened, [], "B diagnostic probe opened target");
  assert.equal(listB?.selected_workspace_id, configuredId, "B list did not lawfully select configured default");
  assert.deepEqual(listB?.workspaces?.map((workspace) => workspace.id), [configuredId], "B diagnostic probe added target to ordinary list");
  assert.equal(openDefaultB?.selected_workspace_id, configuredId, "B default selection was not established");
  assert.equal(diagBBeforeRead?.workspace?.selected?.id, configuredId, "B prior selection was not default");
  assert.equal(explicitReadB?.root, realNestedRoot, "B explicit read did not reconstruct target");
  assert.equal(diagBAfterRead?.requested_workspace?.classification, "session_opened", "B explicit read did not create session-opened target");
  assert.equal(diagBAfterRead?.workspace?.selected?.id, configuredId, "B explicit target read changed ambient selection");
  assert.ok(diagBAfterRead?.workspace?.session_opened?.some((workspace) => workspace.id === targetId), "B explicit read did not add target to session list");
  for (const call of [diagA0Call, diagA1Call, diagB0Call, diagBProbeCall, diagBBeforeReadCall, diagBAfterReadCall, diagAAfterBCloseCall, unknownWorkspaceCall]) {
    noRoutingSecrets(call.raw, "diagnostic raw envelope", routingSessionIds);
    noRoutingSecrets(call.result, "diagnostic result", routingSessionIds);
  }
  for (const [index, call] of hostileCalls.entries()) hostileError(call, `hostile diagnostic response ${index + 1}`, [...routingSessionIds, targetId]);
  success(unknownWorkspaceCall, "bounded unknown-format diagnostic");
  assert.equal(unknownWorkspace?.requested_workspace?.classification, "unknown_or_invalid", "unknown valid-format workspace ID did not return bounded classification");
  noRoutingSecrets(unknownWorkspaceCall.raw, "unknown-format diagnostic raw envelope", routingSessionIds);
  noRoutingSecrets(unknownWorkspaceCall.result, "unknown-format diagnostic result", routingSessionIds);

  for (const call of [diagC0Call, diagCTargetCall, diagCConfiguredCall, diagCAfterReadCall, diagDCall, lifecycleInitialCall, lifecycleAfterCloseCall, lifecycleTtlInitialCall, lifecycleAfterTtlCall, capacityOldDiagCall, capacityNewDiagCall]) {
    noRoutingSecrets(call?.raw, "diagnostic raw envelope", routingSessionIds);
    noRoutingSecrets(call?.result, "diagnostic result", routingSessionIds);
  }

  assert.equal(processA, undefined, "A OS process was not killed before C");
  assert.equal(processC, undefined, "C OS process was not terminated");
  assert.equal(processAExit?.signal, "SIGTERM", "A did not terminate as a killed OS process");
  assert.equal(processCExit?.signal, "SIGTERM", "C did not terminate cleanly after proof");
  assert.equal(processDExit?.signal, "SIGTERM", "D did not terminate cleanly after catalog proof");
  assert.equal(diagCTarget?.requested_workspace?.classification, "unknown_or_invalid", "C resurrected process-local nested target identity");
  assert.equal(diagCTarget?.requested_workspace?.root, null, "C unknown target probe leaked a root");
  assert.equal(diagCConfigured?.requested_workspace?.classification, "configured_allowed_root_reconstructible", "C lost configured deterministic recovery");
  assert.equal(diagCConfigured?.requested_workspace?.root, realFixtureRoot, "C configured-root recovery returned wrong root");
  assert.equal(explicitReadCResult?.root, realFixtureRoot, "C explicit configured-root read failed");
  assert.equal(diagC0?.workspace?.selected, null, "C unexpectedly selected a workspace before explicit read");
  assert.equal(diagCAfterRead?.workspace?.selected, null, "C configured explicit read changed ambient selection");
  assert.ok(diagCAfterRead?.workspace?.session_opened?.some((workspace) => workspace.id === configuredId), "C explicit read did not reconstruct configured root");
  assert.equal(diagA0?.runtime?.process?.pid, processAPid, "A runtime process PID did not identify the actual child");
  assert.notEqual(diagA0?.session?.fingerprint, diagC0?.session?.fingerprint, "A/C session fingerprints were reused across OS processes");
  assert.equal(routingSessionIds.includes(diagA0?.session?.fingerprint), false, "A diagnostic fingerprint matched a raw MCP routing ID");
  assert.equal(routingSessionIds.includes(diagB0?.session?.fingerprint), false, "B diagnostic fingerprint matched a raw MCP routing ID");
  assert.equal(routingSessionIds.includes(diagC0?.session?.fingerprint), false, "C diagnostic fingerprint matched a raw MCP routing ID");
  assert.equal(diagC0?.runtime?.process?.pid, processCPid, "C runtime process PID did not identify the actual child");
  assert.notEqual(diagA0?.runtime?.process?.pid, diagC0?.runtime?.process?.pid, "A/C runtime process identity did not change");
  assert.equal(diagA0?.server?.catalog_fingerprint, diagC0?.server?.catalog_fingerprint, "identical A/C registered surfaces changed catalog fingerprint");
  assert.equal([...new Set([...toolsA.listed.map((tool) => tool.name), ...toolsD.listed.map((tool) => tool.name)])].filter((name) => toolsA.listed.some((tool) => tool.name === name) !== toolsD.listed.some((tool) => tool.name === name)).join(","), "bash", "D tools/list did not show the deliberate registered-surface change");
  assert.notEqual(diagD?.server?.catalog_fingerprint, diagA0?.server?.catalog_fingerprint, "catalog fingerprint ignored actual tools/list change");

  assert.equal(lifecycleInitial?.http_sessions?.active, 1, "close fixture did not start with one active session");
  assert.ok(lifecycleAfterClose?.http_sessions?.total_initialized >= 2, "close fixture did not initialize replacement session");
  assert.ok(lifecycleAfterClose?.http_sessions?.total_closed >= 1, "real HTTP close was not counted");
  assert.equal(lifecycleAfterClose?.http_sessions?.active, 1, "close replacement active count was wrong");
  assert.ok(lifecycleAfterTtl?.http_sessions?.total_expired >= 1, "real TTL expiry was not counted");
  assert.equal(lifecycleAfterTtl?.http_sessions?.active, 1, "TTL replacement active count was wrong");
  assert.equal(capacityOldDiag?.http_sessions?.max, 1, "capacity fixture max was not one");
  assert.ok(capacityNewDiag?.http_sessions?.total_initialized >= 2, "capacity fixture did not initialize two sessions");
  assert.ok(capacityNewDiag?.http_sessions?.total_capacity_evicted >= 1, "real capacity eviction was not counted");
  assert.equal(capacityNewDiag?.http_sessions?.active, 1, "capacity fixture retained more than max active sessions");

  const finalHome = await census(isolatedHome);
  const finalConfig = await census(isolatedConfigRoot);
  assert.deepEqual(homeAfterA, homeBefore, "A process changed CODEXPRO_HOME");
  assert.deepEqual(configAfterA, configBefore, "A process changed isolated config root");
  assert.deepEqual(finalHome, homeBefore, "CODEXPRO_HOME changed during session/workspace proof");
  assert.deepEqual(finalConfig, configBefore, "isolated config root changed during session/workspace proof");
  assertNoDiskBindingRegistry(finalHome, "final isolated CODEXPRO_HOME");
  assertNoDiskBindingRegistry(finalConfig, "final isolated config root");
  acceptance = { AP_009: "PASS", AP_010: "PASS", AP_011: "PASS" };
  console.log("AP-009: PASS — real A/B HTTP session isolation, process-local target recovery, and ambient-selection preservation proved.");
  console.log("AP-010: PASS — killed-process C rejected the non-configured target while configured-root deterministic recovery remained available.");
  console.log("AP-011: PASS — real close/TTL/capacity counters, catalog fingerprints, filesystem census, and secret-safe envelopes proved.");
  console.log(`ACCEPTANCE_MATRIX: ${JSON.stringify(acceptance)}; EVIDENCE_CONFLICT: NONE.`);
  console.log("✓ session/workspace continuity falsifier smoke passed");
} catch (error) {
  if (!rawPrinted) {
    console.log("SANITY_VERDICT: UNPROVEN — direct target evidence did not complete before technical interpretation.");
  }
  console.log(`ACCEPTANCE_MATRIX: ${JSON.stringify(acceptance)}; EVIDENCE_CONFLICT: ${rawPrinted ? "TECHNICAL_ASSERTION_CONFLICT" : "TARGET_INPUT_MISSING_OR_ROUTE_FAILURE"}.`);
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = message.replaceAll(AUTH_TOKEN, "<auth>").replaceAll(HOSTILE_SECRET, "<hostile>").replaceAll(REQUEST_SENTINEL, "<request>").replaceAll(ENV_SENTINEL, "<env>");
  console.error(`FAILURE_ID: ${error?.name ?? "Error"}: ${safeMessage.slice(0, 500)}`);
  throw error;
} finally {
  await closeClient(sessionD);
  await closeClient(sessionC);
  await closeClient(sessionB);
  await closeClient(sessionA);
  for (const session of lifecycleSessions) await closeClient(session);
  for (const session of capacitySessions) await closeClient(session);
  await closeInProcessHttp(lifecycleServer).catch(() => {});
  await closeInProcessHttp(capacityServer).catch(() => {});
  await stopHttpProcess(processD).catch(() => {});
  await stopHttpProcess(processC).catch(() => {});
  await stopHttpProcess(processA).catch(() => {});
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
