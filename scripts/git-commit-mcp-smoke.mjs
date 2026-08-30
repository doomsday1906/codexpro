import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = path.resolve(".");
const HOSTILE_KEY = "OPENAI_API_KEY_HOSTILE_UNKNOWN_PROPERTY";
const HOSTILE_VALUE = "sk-live-git-commit-mcp-hostile-envelope-7x9";
const HOSTILE_PATH = "OPENAI_API_KEY_HOSTILE_PATH.txt";
const HOSTILE_MESSAGE = "sk-live-git-commit-mcp-hostile-message-7x9";
const DEFAULT_SENTINEL = "AMBIENT_DEFAULT_SENTINEL_7X9";
const TARGET_SENTINEL = "EXPLICIT_TARGET_SENTINEL_7X9";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15_000);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code} ${signal ?? ""}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
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

function directGit(root, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      ...options.env
    },
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git failed: git ${args.join(" ")} status=${result.status} stderr=${Buffer.from(result.stderr ?? "").toString("utf8")}`);
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(root, args) {
  return directGit(root, args).toString("utf8").trim();
}

function commitFixture(root, message) {
  directGit(root, ["add", "--all"]);
  directGit(root, ["commit", "--quiet", "-m", message]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function initRepo(root, name) {
  directGit(root, ["init", "--quiet"]);
  directGit(root, ["config", "user.name", name]);
  directGit(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]);
  directGit(root, ["config", "core.logAllRefUpdates", "true"]);
}

function workspaceIdForRoot(root) {
  return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

function parseEnvelopeBody(capture) {
  const body = capture?.body ?? "";
  if (!body.trim()) return undefined;
  if (capture.contentType?.includes("application/json")) return JSON.parse(body);
  const events = [...body.matchAll(/^data:\s*(.+)$/gmu)].map((match) => match[1]).filter(Boolean);
  if (events.length === 0) return undefined;
  return JSON.parse(events.at(-1));
}

function captureFetch(captures) {
  return async (input, init = {}) => {
    const response = await fetch(input, init);
    const clone = response.clone();
    const body = await clone.text().catch(() => "");
    captures.push({
      method: init.method ?? "GET",
      requestBody: typeof init.body === "string" ? init.body : "",
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body
    });
    return response;
  };
}

async function connectClient(url, label) {
  const captures = [];
  const client = new Client({ name: `git-commit-mcp-smoke-${label}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: captureFetch(captures)
  });
  await client.connect(transport);
  return { client, transport, captures };
}

async function closeClient(session) {
  if (!session) return;
  await session.transport.terminateSession().catch(() => {});
  await session.client.close().catch(() => {});
}

async function callTool(session, name, args) {
  const start = session.captures.length;
  let result;
  let error;
  try {
    result = await session.client.callTool({ name, arguments: args });
  } catch (caught) {
    error = caught;
  }
  const calls = session.captures.slice(start).filter((capture) => {
    if (capture.method !== "POST" || !capture.requestBody) return false;
    try {
      const request = JSON.parse(capture.requestBody);
      return request.method === "tools/call" && request.params?.name === name;
    } catch {
      return false;
    }
  });
  const rawEnvelope = parseEnvelopeBody(calls.at(-1));
  return { result, error, rawEnvelope, rawBody: calls.at(-1)?.body ?? "" };
}

function resultText(output) {
  return output?.result?.content?.find?.((part) => part.type === "text")?.text ?? JSON.stringify(output?.result ?? output?.rawEnvelope ?? output?.error);
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function assertNoRawLiterals(value, literals, label) {
  const text = serialized(value);
  for (const literal of literals) assert.equal(text.includes(literal), false, `${label} leaked ${literal}`);
}

function lastEnvelopeForMethod(session, method) {
  const capture = [...session.captures].reverse().find((candidate) => {
    if (candidate.method !== "POST" || !candidate.requestBody) return false;
    try {
      return JSON.parse(candidate.requestBody).method === method;
    } catch {
      return false;
    }
  });
  return parseEnvelopeBody(capture);
}

function expectSuccess(output, label) {
  assert.equal(output.error, undefined, `${label} threw: ${output.error?.message ?? output.error}`);
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} did not produce a complete JSON-RPC envelope`);
  assert.ok(output.rawEnvelope?.result, `${label} envelope omitted result`);
  assert.notEqual(output.result?.isError, true, `${label} failed: ${resultText(output)}`);
  assert.ok(output.result?.structuredContent && typeof output.result.structuredContent === "object", `${label} omitted structuredContent`);
  return output.result;
}

function expectError(output, label) {
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} did not produce a complete JSON-RPC envelope`);
  if (output.error) return output;
  assert.equal(output.result?.isError, true, `${label} unexpectedly succeeded: ${resultText(output)}`);
  return output;
}

function assertNoToolCard(tool, label) {
  const meta = tool?._meta ?? {};
  assert.equal(meta.ui, undefined, `${label} exposed tool-card ui metadata`);
  assert.equal(meta["openai/outputTemplate"], undefined, `${label} exposed an output template`);
}

function assertCommitToolDescriptor(tool) {
  assert.ok(tool, "full workspace-write mode omitted git_commit");
  assertNoToolCard(tool, "git_commit");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false
  }, "git_commit annotations changed");
  const schema = tool.inputSchema;
  assert.equal(schema?.type, "object", "git_commit schema is not an object");
  assert.equal(schema?.additionalProperties, false, "git_commit schema accepts unknown keys");
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), ["expected_head", "message", "paths", "workspace_id"]);
  assert.deepEqual(new Set(schema.required ?? []), new Set(["workspace_id", "paths", "message", "expected_head"]));
  assert.equal(schema.properties?.workspace_id?.type, "string");
  assert.equal(schema.properties?.workspace_id?.minLength, 1);
  assert.equal(schema.properties?.workspace_id?.maxLength, 128);
  assert.equal(schema.properties?.paths?.type, "array");
  assert.equal(schema.properties?.paths?.minItems, 1);
  assert.equal(schema.properties?.paths?.maxItems, 100);
  assert.equal(schema.properties?.paths?.items?.type, "string");
  assert.equal(schema.properties?.paths?.items?.minLength, 1);
  assert.equal(schema.properties?.paths?.items?.maxLength, 4_096);
  assert.equal(schema.properties?.message?.type, "string");
  assert.equal(schema.properties?.message?.minLength, 1);
  assert.equal(schema.properties?.message?.maxLength, 20_000);
  assert.equal(schema.properties?.expected_head?.type, "string");
  assert.equal(schema.properties?.expected_head?.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
}

async function repositorySnapshot(root) {
  const values = {
    head: gitText(root, ["rev-parse", "HEAD"]),
    refs: directGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]).toString("base64"),
    index: directGit(root, ["ls-files", "--stage", "-z"]).toString("base64"),
    staged: directGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]).toString("base64"),
    unstaged: directGit(root, ["diff", "--binary", "--no-ext-diff"]).toString("base64"),
    untracked: directGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).toString("base64"),
    status: directGit(root, ["status", "--porcelain=v1", "--branch"]).toString("base64")
  };
  return values;
}

function changedPaths(root, oldHead, newHead) {
  const fields = directGit(root, ["diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "--no-renames", oldHead, newHead])
    .toString("utf8")
    .split("\u0000")
    .filter(Boolean);
  assert.equal(fields.length % 2, 0, "fixture diff-tree output was malformed");
  const result = [];
  for (let index = 0; index < fields.length; index += 2) result.push({ status: fields[index], path: fields[index + 1] });
  return result;
}

async function withHttpServer({ defaultRoot, allowedRoots, toolMode, writeMode, extraEnv = {} }, callback) {
  const port = await freePort();
  const env = {
    ...process.env,
    CODEXPRO_ROOT: defaultRoot,
    CODEXPRO_ALLOWED_ROOTS: allowedRoots.join(path.delimiter),
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
    CODEXPRO_BASH_MODE: "off",
    CODEXPRO_WRITE_MODE: writeMode,
    CODEXPRO_TOOL_MODE: toolMode,
    CODEXPRO_TOOL_CARDS: "1",
    CODEXPRO_CODEX_SESSIONS: "off",
    CODEXPRO_CONNECTION_TEST: "0",
    ...extraEnv
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.CODEXPRO_REQUIRE_HTTP_TOKEN;
  delete env.CODEXPRO_TUNNEL_MODE;
  const child = spawn(process.execPath, ["dist/http.js"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForListening(child);
    return await callback(`http://127.0.0.1:${port}/mcp`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child);
  }
}

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-commit-mcp-"));
const defaultRoot = path.join(fixtureRoot, "ambient-default");
const targetParent = path.join(fixtureRoot, "allowed-parent");
const targetRoot = path.join(targetParent, "explicit-target");
const remoteRoot = path.join(fixtureRoot, "origin.git");
const hostileGitTracePath = path.join(fixtureRoot, "hostile-git-trace.log");
const hostileGitTrace2Path = path.join(fixtureRoot, "hostile-git-trace2.log");
let sessionA;
let sessionB;
try {
  await mkdir(defaultRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  initRepo(defaultRoot, "MCP Ambient Default");
  initRepo(targetRoot, "MCP Explicit Target");
  await writeFile(path.join(defaultRoot, "default.txt"), `${DEFAULT_SENTINEL}\n`, "utf8");
  const defaultHead = commitFixture(defaultRoot, "ambient default baseline");
  await writeFile(path.join(targetRoot, "selected.txt"), `${TARGET_SENTINEL} baseline\n`, "utf8");
  await writeFile(path.join(targetRoot, "unrelated.txt"), "unrelated baseline\n", "utf8");
  const targetHead = commitFixture(targetRoot, "explicit target baseline");
  await mkdir(remoteRoot, { recursive: true });
  directGit(remoteRoot, ["init", "--bare", "--quiet"]);
  directGit(targetRoot, ["remote", "add", "origin", remoteRoot]);
  directGit(targetRoot, ["update-ref", "refs/remotes/origin/master", targetHead]);
  const defaultCanonicalRoot = await realpath(defaultRoot);
  const targetCanonicalRoot = await realpath(targetRoot);
  const targetWorkspaceId = workspaceIdForRoot(targetCanonicalRoot);
  const defaultWorkspaceId = workspaceIdForRoot(defaultCanonicalRoot);

  // PASS 1: independent direct refs and bytes establish the target/default
  // distinction before any public result is interpreted.
  assert.equal(defaultHead.length, 40);
  assert.equal(targetHead.length, 40);
  assert.equal((await readFile(path.join(defaultRoot, "default.txt"), "utf8")).includes(DEFAULT_SENTINEL), true);
  assert.equal((await readFile(path.join(targetRoot, "selected.txt"), "utf8")).includes(`${TARGET_SENTINEL} baseline`), true);
  console.log("AUTHORITY: MISSION_ANCHOR.md A001 Public Contract/Laws 001, 004, 005, 013, 014, plus MISSION_PLAN.md P001 TASK-005 AP-009/AP-010.");
  console.log(`TARGET_PRODUCER_ROUTE: persistent real MCP HTTP server, WorkspaceManager process-known identity, and direct gitCommit mutation in disposable target=${targetCanonicalRoot}; ambient default=${defaultCanonicalRoot}.`);
  console.log(`TARGET_EVIDENCE: complete JSON-RPC tools/list/tools/call envelopes plus direct target/default refs, status, bytes, and commit tree inspection.`);
  console.log(`RAW_OBSERVATION: default HEAD=${defaultHead} contains ${DEFAULT_SENTINEL}; target HEAD=${targetHead} contains ${TARGET_SENTINEL} baseline and is not the default root.`);
  console.log("SANITY_VERDICT: MATCH — direct fixture refs and bytes establish distinct ambient and explicit targets before mutation.");
  console.log("PREDICATE: TRUE — session A will save the deterministic target workspace identity from the target root, independently verified by the same canonical-root hash formula.");

  await withHttpServer({
    defaultRoot,
    allowedRoots: [defaultCanonicalRoot, path.dirname(targetCanonicalRoot)],
    toolMode: "full",
    writeMode: "workspace",
    extraEnv: { GIT_TRACE: hostileGitTracePath, GIT_TRACE2: hostileGitTrace2Path }
  }, async (mcpUrl) => {
    sessionA = await connectClient(mcpUrl, "session-a");
    const listingA = await sessionA.client.listTools();
    const namesA = listingA.tools.map((tool) => tool.name);
    const listEnvelopeA = lastEnvelopeForMethod(sessionA, "tools/list");
    assert.equal(listEnvelopeA?.jsonrpc, "2.0", "tools/list did not produce a complete JSON-RPC envelope");
    assert.ok(Array.isArray(listEnvelopeA?.result?.tools), "tools/list envelope omitted tools");
    assert.equal(namesA.filter((name) => name === "git_commit").length, 1, "full workspace-write mode did not register exactly one git_commit");
    assert.equal(namesA.includes("codex_sessions"), false, "M004 codex session diagnostics leaked into focused TASK-005 surface");
    assert.equal(namesA.includes("read_codex_session"), false, "M004 transcript diagnostics leaked into focused TASK-005 surface");
    assertCommitToolDescriptor(listingA.tools.find((tool) => tool.name === "git_commit"));
    const opened = await callTool(sessionA, "open_workspace", { path: targetCanonicalRoot, include_tree: false });
    const openedResult = expectSuccess(opened, "session A open target");
    assert.equal(openedResult.structuredContent.workspace_id, targetWorkspaceId);
    assert.equal(openedResult.structuredContent.root, targetCanonicalRoot);
    await closeClient(sessionA);
    sessionA = undefined;

    // Session B is a distinct MCP session in the same HTTP process. Its
    // manager starts with no local selection; list_workspaces materializes
    // only the configured ambient default and marks it selected.
    await writeFile(path.join(targetRoot, "selected.txt"), `${TARGET_SENTINEL} first public commit\n`, "utf8");
    const targetBefore = await repositorySnapshot(targetRoot);
    const defaultBefore = await repositorySnapshot(defaultRoot);
    const remoteRefBefore = gitText(targetRoot, ["rev-parse", "refs/remotes/origin/master"]);
    const remoteConfigBefore = directGit(targetRoot, ["config", "--local", "--get-regexp", "^remote\\."]).toString("base64");
    sessionB = await connectClient(mcpUrl, "session-b");
    const ambient = await callTool(sessionB, "list_workspaces", {});
    const ambientResult = expectSuccess(ambient, "session B ambient workspace");
    assert.equal(ambientResult.structuredContent.selected_workspace_id, defaultWorkspaceId, "session B selected a non-default workspace before explicit targeting");
    assert.equal(ambientResult.structuredContent.workspaces.length, 1, "session B unexpectedly carried session A workspace selection");
    assert.equal(ambientResult.structuredContent.workspaces[0].root, defaultCanonicalRoot);
    const hostileGitTraceBeforeCommit = await readFile(hostileGitTracePath).catch(() => null);
    const hostileGitTrace2BeforeCommit = await readFile(hostileGitTrace2Path).catch(() => null);

    const commit = await callTool(sessionB, "git_commit", {
      workspace_id: targetWorkspaceId,
      paths: ["selected.txt"],
      message: "public explicit target commit",
      expected_head: targetHead
    });
    const commitResult = expectSuccess(commit, "explicit target git_commit");
    const commitData = commitResult.structuredContent;
    assert.equal(commitData.schema_version, 1);
    assert.equal(commitData.workspace_id, targetWorkspaceId);
    assert.equal(commitData.root, targetCanonicalRoot);
    const targetBranch = gitText(targetRoot, ["branch", "--show-current"]);
    assert.equal(commitData.branch, targetBranch);
    assert.equal(commitData.old_head, targetHead);
    assert.match(commitData.new_head, /^[0-9a-f]{40}$/u);
    assert.equal(commitData.requested_path_count, 1);
    assert.equal(commitData.committed_path_count, 1);
    assert.deepEqual(commitData.committed_paths, ["selected.txt"]);
    assert.equal(commitData.new_head, gitText(targetRoot, ["rev-parse", "HEAD"]));
    assert.equal(resultText(commit).includes("public explicit target commit"), false, "success content echoed the commit message");
    const successEnvelope = commit.rawEnvelope;
    assert.equal(successEnvelope.result?.isError, undefined, "success JSON-RPC envelope was marked as an error");
    assert.equal((commit.rawBody.match(/"structuredContent"/gu) ?? []).length, 1, "success envelope duplicated structuredContent");

    // PASS 1 after success: inspect raw Git refs/tree before relying on the
    // implementation result fields as an explanation.
    const targetAfter = await repositorySnapshot(targetRoot);
    const defaultAfter = await repositorySnapshot(defaultRoot);
    const newHead = targetAfter.head;
    const targetCommitRaw = directGit(targetRoot, ["cat-file", "commit", newHead]).toString("utf8");
    const parentLines = targetCommitRaw.split("\n").filter((line) => line.startsWith("parent "));
    const changed = changedPaths(targetRoot, targetHead, newHead);
    assert.notEqual(newHead, targetHead, "target branch did not advance");
    assert.deepEqual(parentLines, [`parent ${targetHead}`], "target commit did not have exactly the expected parent");
    assert.deepEqual(changed, [{ status: "M", path: "selected.txt" }], "target commit changed an unexpected path");
    assert.deepEqual(defaultAfter, defaultBefore, "ambient default repository changed during explicit target commit");
    assert.equal(gitText(targetRoot, ["rev-parse", "refs/remotes/origin/master"]), remoteRefBefore, "git_commit moved a remote-tracking ref");
    assert.deepEqual(directGit(targetRoot, ["config", "--local", "--get-regexp", "^remote\\."]).toString("base64"), remoteConfigBefore, "git_commit changed remote configuration");
    const hostileGitTraceAfterCommit = await readFile(hostileGitTracePath).catch(() => null);
    const hostileGitTrace2AfterCommit = await readFile(hostileGitTrace2Path).catch(() => null);
    assert.deepEqual(hostileGitTraceAfterCommit, hostileGitTraceBeforeCommit, "git_commit leaked inherited GIT_TRACE into additional trace output");
    assert.deepEqual(hostileGitTrace2AfterCommit, hostileGitTrace2BeforeCommit, "git_commit leaked inherited GIT_TRACE2 into additional trace output");
    console.log(`RAW_OBSERVATION: success envelope=${JSON.stringify(successEnvelope)}; target refs moved ${targetHead} -> ${newHead}; direct parent=${targetHead}; changed paths=${JSON.stringify(changed)}; remote-tracking origin/master remained ${remoteRefBefore}; default HEAD remained ${defaultAfter.head}.`);
    console.log("SANITY_VERDICT: MATCH — the real HTTP call advanced only the explicit target branch by one commit with one selected path; ambient default refs and bytes stayed unchanged.");
    console.log("PREDICATE: TRUE — independent pre-call ambient listing selected the default, while the supplied target ID mapped to the target root and direct post-call refs show only that root advanced.");

    const afterSelection = await callTool(sessionB, "list_workspaces", {});
    const afterSelectionResult = expectSuccess(afterSelection, "session B workspace selection after explicit commit");
    assert.equal(afterSelectionResult.structuredContent.selected_workspace_id, defaultWorkspaceId, "explicit git_commit changed ambient selection");
    assert.ok(afterSelectionResult.structuredContent.workspaces.some((workspace) => workspace.id === targetWorkspaceId && workspace.root === targetCanonicalRoot));

    const missingIdBefore = await repositorySnapshot(targetRoot);
    const missingId = expectError(await callTool(sessionB, "git_commit", {
      paths: ["selected.txt"],
      message: "missing workspace id must not fall back",
      expected_head: newHead
    }), "missing workspace_id");
    assert.match(resultText(missingId), /workspace_id/iu, "missing workspace_id error omitted the field name");
    assert.deepEqual(await repositorySnapshot(targetRoot), missingIdBefore, "missing workspace_id changed target state");
    assert.equal((await callTool(sessionB, "list_workspaces", {})).result.structuredContent.selected_workspace_id, defaultWorkspaceId);
    assertNoRawLiterals(missingId, [DEFAULT_SENTINEL, TARGET_SENTINEL], "missing workspace_id complete envelope");

    const wrongId = expectError(await callTool(sessionB, "git_commit", {
      workspace_id: "ws_000000000000000000000000",
      paths: ["selected.txt"],
      message: "wrong workspace id",
      expected_head: newHead
    }), "wrong workspace_id");
    assert.match(resultText(wrongId), /workspace/iu, "wrong workspace_id error omitted workspace identity wording");
    assert.deepEqual(await repositorySnapshot(targetRoot), missingIdBefore, "wrong workspace_id changed target state");
    assertNoRawLiterals(wrongId, [DEFAULT_SENTINEL, TARGET_SENTINEL], "wrong workspace_id complete envelope");

    await writeFile(path.join(targetRoot, "selected.txt"), `${TARGET_SENTINEL} stale-head rejection\n`, "utf8");
    const staleBefore = await repositorySnapshot(targetRoot);
    const staleHead = expectError(await callTool(sessionB, "git_commit", {
      workspace_id: targetWorkspaceId,
      paths: ["selected.txt"],
      message: "stale expected head must reject",
      expected_head: targetHead
    }), "wrong expected_head");
    assert.match(resultText(staleHead), /expected_head|current HEAD/iu, "wrong expected_head error omitted the precondition wording");
    assert.deepEqual(await repositorySnapshot(targetRoot), staleBefore, "wrong expected_head changed target state");
    assertNoRawLiterals(staleHead, [DEFAULT_SENTINEL, TARGET_SENTINEL], "wrong expected_head complete envelope");

    const hostileBefore = await repositorySnapshot(targetRoot);
    const hostile = expectError(await callTool(sessionB, "git_commit", {
      workspace_id: targetWorkspaceId,
      paths: ["selected.txt"],
      message: "hostile unknown key must be redacted",
      expected_head: newHead,
      [HOSTILE_KEY]: HOSTILE_VALUE
    }), "hostile unknown key");
    assert.match(resultText(hostile), /unknown|invalid arguments|not allowed/iu, "hostile unknown-key error was not a schema rejection");
    assertNoRawLiterals(hostile, [HOSTILE_KEY, HOSTILE_VALUE], "hostile unknown-key complete envelope");
    assert.deepEqual(await repositorySnapshot(targetRoot), hostileBefore, "hostile unknown key changed target state");

    const hostilePathBefore = await repositorySnapshot(targetRoot);
    const hostilePath = expectError(await callTool(sessionB, "git_commit", {
      workspace_id: targetWorkspaceId,
      paths: [HOSTILE_PATH],
      message: HOSTILE_MESSAGE,
      expected_head: newHead
    }), "hostile path/message");
    assertNoRawLiterals(hostilePath, [HOSTILE_PATH, HOSTILE_MESSAGE], "hostile path/message complete envelope");
    assert.deepEqual(await repositorySnapshot(targetRoot), hostilePathBefore, "hostile path/message changed target state");
    console.log(`RAW_OBSERVATION: complete error envelopes for missing ID, wrong ID, stale HEAD, hostile unknown key, and hostile path/message were returned; target HEAD stayed ${newHead} and selected worktree bytes stayed pending-only.`);
    console.log("SANITY_VERDICT: MATCH — every rejected call left refs and direct repository state unchanged, and the hostile property name/value were absent from complete serialized output.");
    console.log("PREDICATE: TRUE — rejection predicates were established from request shape/independent stale refs before judging that no mutation occurred.");
    await closeClient(sessionB);
    sessionB = undefined;
  });

  for (const boundary of [
    { toolMode: "standard", writeMode: "workspace", label: "standard" },
    { toolMode: "minimal", writeMode: "workspace", label: "minimal" },
    { toolMode: "full", writeMode: "off", label: "full-write-off" },
    { toolMode: "full", writeMode: "handoff", label: "full-write-handoff" }
  ]) {
    await withHttpServer({ defaultRoot, allowedRoots: [defaultCanonicalRoot, path.dirname(targetCanonicalRoot)], ...boundary }, async (mcpUrl) => {
      const session = await connectClient(mcpUrl, boundary.label);
      try {
        const listing = await session.client.listTools();
        const names = listing.tools.map((tool) => tool.name);
        assert.equal(names.includes("git_commit"), false, `${boundary.label} mode exposed git_commit: ${names.join(", ")}`);
        const unavailableBefore = await repositorySnapshot(targetRoot);
        const unavailable = await callTool(session, "git_commit", {
          workspace_id: targetWorkspaceId,
          paths: ["selected.txt"],
          message: "unavailable mode",
          expected_head: targetHead
        });
        expectError(unavailable, `${boundary.label} unavailable git_commit`);
        assertNoRawLiterals(unavailable, [HOSTILE_KEY, HOSTILE_VALUE], `${boundary.label} unavailable response`);
        assert.deepEqual(await repositorySnapshot(targetRoot), unavailableBefore, `${boundary.label} unavailable call changed target state`);
      } finally {
        await closeClient(session);
      }
    });
  }
  console.log("PASS AP-009: full+workspace-write exposes exactly one strict git_commit with false/false/false annotations and no card/template; standard/minimal/write-off/non-workspace omit or reject it.");
  console.log("PASS AP-010: persistent real HTTP session churn targeted only the saved process-known workspace ID, preserved the ambient default selection, enforced missing/wrong ID and stale HEAD, and kept hostile complete envelopes clean.");
  console.log("GIT_COMMIT_MCP_SMOKE: PASS (AP-009/AP-010 focused public-surface proof).");
} finally {
  await closeClient(sessionA);
  await closeClient(sessionB);
  await rm(fixtureRoot, { recursive: true, force: true });
}
