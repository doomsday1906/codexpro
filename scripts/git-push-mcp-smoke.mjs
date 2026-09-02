import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const REPO_ROOT = path.resolve(".");
const UNKNOWN_PROPERTY = "OPENAI_API_KEY_GIT_PUSH_UNKNOWN_PROPERTY";
const UNKNOWN_VALUE = "sk-live-git-push-unknown-property-7x9";
const HOOK_SENTINEL = "PUSH_HOOK_MUST_NOT_RUN_7X9";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    input: options.input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...options.env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git failed: git ${args.join(" ")} status=${result.status} stderr=${Buffer.from(result.stderr ?? "").toString("utf8")}`);
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(cwd, args) {
  return git(cwd, args).toString("utf8").trim();
}

function initRepo(root, name, initialBranch = "main") {
  git(root, ["init", "--quiet", "--initial-branch", initialBranch]);
  git(root, ["config", "user.name", name]);
  git(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]);
  git(root, ["config", "core.logAllRefUpdates", "true"]);
}

function commit(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", message]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function workspaceId(root) {
  return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => listener.close(resolve));
  assert.ok(port > 0, "failed to reserve loopback port");
  return port;
}

async function waitForGitDaemon(url, daemon) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = spawnSync("git", ["ls-remote", url, "refs/heads/main"], {
      encoding: "utf8",
      timeout: 1_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }
    });
    if (result.status === 0 && String(result.stdout ?? "").endsWith("\trefs/heads/main\n")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`loopback git daemon did not become observable (exit=${daemon.exitCode})`);
}

function parseEnvelope(capture) {
  const body = capture?.body ?? "";
  if (!body.trim()) return undefined;
  if (capture.contentType?.includes("application/json")) return JSON.parse(body);
  const events = [...body.matchAll(/^data:\s*(.+)$/gmu)].map((match) => match[1]).filter(Boolean);
  return events.length ? JSON.parse(events.at(-1)) : undefined;
}

function captureFetch(captures) {
  return async (input, init = {}) => {
    const response = await fetch(input, init);
    const body = await response.clone().text().catch(() => "");
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

async function connect(url, label) {
  const captures = [];
  const client = new Client({ name: `git-push-mcp-smoke-${label}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: captureFetch(captures) });
  await client.connect(transport);
  return { client, transport, captures };
}

async function close(session) {
  if (!session) return;
  await session.transport.terminateSession().catch(() => {});
  await session.client.close().catch(() => {});
}

async function call(session, name, args) {
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
  const last = calls.at(-1);
  return { result, error, rawEnvelope: parseEnvelope(last), rawBody: last?.body ?? "" };
}

function text(output) {
  return output?.result?.content?.find?.((part) => part.type === "text")?.text
    ?? JSON.stringify(output?.result ?? output?.rawEnvelope ?? output?.error);
}

function expectSuccess(output, label) {
  assert.equal(output.error, undefined, `${label} threw: ${output.error?.message ?? output.error}`);
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} omitted JSON-RPC envelope`);
  assert.ok(output.rawEnvelope?.result, `${label} omitted result`);
  assert.notEqual(output.result?.isError, true, `${label} failed: ${text(output)}`);
  return output.result;
}

function expectError(output, label) {
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} omitted JSON-RPC envelope`);
  if (output.error) return output;
  assert.equal(output.result?.isError, true, `${label} unexpectedly succeeded: ${text(output)}`);
  return output;
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function assertNoSecrets(value, label) {
  assert.equal(serialized(value).includes(UNKNOWN_PROPERTY), false, `${label} leaked hostile property name`);
  assert.equal(serialized(value).includes(UNKNOWN_VALUE), false, `${label} leaked hostile property value`);
}

async function repositorySnapshot(root, hookPath) {
  const read = (args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      encoding: "buffer",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    return result.error || result.status !== 0
      ? `<exit:${result.status}>${Buffer.from(result.stderr ?? "").toString("base64")}`
      : Buffer.from(result.stdout ?? "").toString("base64");
  };
  return {
    head: read(["rev-parse", "HEAD"]),
    branch: read(["symbolic-ref", "--quiet", "HEAD"]),
    refs: read(["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    status: read(["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: read(["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstaged: read(["diff", "--binary", "--no-ext-diff"]),
    untracked: read(["ls-files", "--others", "--exclude-standard", "-z"]),
    config: read(["config", "--local", "--null", "--list"]),
    hook: await readFile(hookPath).catch(() => null)
  };
}

function readRemote(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "buffer",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.error || result.status !== 0
    ? `<exit:${result.status}>${Buffer.from(result.stderr ?? "").toString("base64")}`
    : Buffer.from(result.stdout ?? "").toString("base64");
}

async function snapshot(root, remoteRoot, hookPath) {
  const value = await repositorySnapshot(root, hookPath);
  value.remoteRefs = readRemote(remoteRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]);
  return value;
}

function assertDescriptor(tool) {
  assert.ok(tool, "full workspace-write mode omitted git_push");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false
  }, "git_push annotations were not truthful");
  const schema = tool.inputSchema;
  assert.equal(schema?.type, "object", "git_push schema is not an object");
  assert.equal(schema?.additionalProperties, false, "git_push schema accepts unknown keys");
  const fields = ["workspace_id", "remote", "branch", "expected_local_head", "expected_remote_head"];
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...fields].sort(), "git_push schema has optional or missing fields");
  assert.deepEqual(new Set(schema.required ?? []), new Set(fields), "git_push schema does not require every field");
  for (const field of fields) assert.equal(schema.properties?.[field]?.type, "string", `${field} is not a string`);
  assert.equal(schema.properties?.workspace_id?.minLength, 1);
  assert.equal(schema.properties?.workspace_id?.maxLength, 128);
  assert.equal(schema.properties?.expected_local_head?.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
  assert.equal(schema.properties?.expected_remote_head?.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
}

async function freeHttpServer({ defaultRoot, allowedRoots, policy, toolMode, writeMode }, callback) {
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
    ...(policy === undefined ? {} : { CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy) })
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.CODEXPRO_REQUIRE_HTTP_TOKEN;
  delete env.CODEXPRO_TUNNEL_MODE;
  const child = spawn(process.execPath, ["dist/http.js"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server timeout\n${stderr}`)), 15_000);
    timer.unref();
    child.stderr.on("data", () => {
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
  try {
    await listening;
    return await callback(`http://127.0.0.1:${port}/mcp`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
  }
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-mcp-"));
const defaultRoot = path.join(fixture, "ambient-default");
const targetRoot = path.join(fixture, "explicit-target");
const remoteRoot = path.join(fixture, "remote.git");
const hookPath = path.join(targetRoot, ".git", "hooks", "pre-push");
let daemon;
let sessionA;
let sessionB;
try {
  await mkdir(defaultRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  initRepo(defaultRoot, "Ambient Default");
  await writeFile(path.join(defaultRoot, "ambient.txt"), "ambient\n");
  const defaultHead = commit(defaultRoot, "ambient baseline");
  initRepo(targetRoot, "Explicit Target");
  await writeFile(path.join(targetRoot, "target.txt"), "target baseline\n");
  const initialHead = commit(targetRoot, "target baseline");
  await mkdir(remoteRoot, { recursive: true });
  git(remoteRoot, ["init", "--bare", "--quiet"]);
  git(targetRoot, ["push", "--quiet", `file://${remoteRoot}`, "HEAD:refs/heads/main"]);

  const port = await freePort();
  const endpoint = `git://127.0.0.1:${port}/remote.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--verbose", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForGitDaemon(endpoint, daemon);
  git(targetRoot, ["remote", "add", "origin", endpoint]);
  await writeFile(path.join(targetRoot, "target.txt"), "target descendant\n");
  const localHead = commit(targetRoot, "target descendant");
  await writeFile(path.join(targetRoot, "staged.txt"), "staged\n");
  git(targetRoot, ["add", "staged.txt"]);
  await writeFile(path.join(targetRoot, "untracked.txt"), "untracked\n");
  await writeFile(hookPath, `#!/bin/sh\nprintf '%s' '${HOOK_SENTINEL}' > '${path.join(fixture, "hook-fired")}'\nexit 1\n`, "utf8");
  await chmod(hookPath, 0o755);

  const defaultCanonical = await realpath(defaultRoot);
  const targetCanonical = await realpath(targetRoot);
  const targetWorkspaceId = workspaceId(targetCanonical);
  const defaultWorkspaceId = workspaceId(defaultCanonical);
  const policy = { enabled: true, rules: [{ remote: "origin", endpoint, branches: ["main"] }] };
  const request = {
    workspace_id: targetWorkspaceId,
    remote: "origin",
    branch: "main",
    expected_local_head: localHead,
    expected_remote_head: initialHead
  };

  const targetBefore = await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired"));
  const defaultBefore = await snapshot(defaultRoot, remoteRoot, path.join(fixture, "hook-fired"));
  assert.equal(defaultHead.length, 40);
  assert.equal(initialHead.length, 40);
  assert.equal(localHead.length, 40);
  console.log("AUTHORITY: MISSION_PLAN.md TASK-003/AP-005/AP-006, MISSION_ANCHOR.md A002, and launcher public contract sections 13-15.");
  console.log(`TARGET_PRODUCER_ROUTE: real MCP HTTP server -> WorkspaceManager explicit workspace_id -> preflightGitPush -> loopback git daemon; target=${targetCanonical}; ambient=${defaultCanonical}.`);
  console.log("TARGET_EVIDENCE: complete tools/list/tools/call envelopes plus direct local/remote refs, config, index, worktree, and hook sentinel snapshots.");
  console.log(`RAW_OBSERVATION: target local HEAD=${localHead} descends from remote main=${initialHead}; target has staged and untracked bytes; ambient HEAD=${defaultHead}.`);
  console.log("SANITY_VERDICT: MATCH — direct fixture refs and bytes establish the requested target and untouched ambient repository before public calls.");
  console.log("PREDICATE: TRUE — exact policy tuple, explicit target workspace identity, and independent loopback remote branch observation are established before judging the valid call.");

  await freeHttpServer({
    defaultRoot,
    allowedRoots: [defaultCanonical, path.dirname(targetCanonical)],
    policy,
    toolMode: "full",
    writeMode: "workspace"
  }, async (url) => {
    sessionA = await connect(url, "a");
    const listingA = await sessionA.client.listTools();
    const namesA = listingA.tools.map((tool) => tool.name);
    assert.equal(namesA.filter((name) => name === "git_push").length, 1, "full workspace-write did not expose exactly one git_push");
    assertDescriptor(listingA.tools.find((tool) => tool.name === "git_push"));

    const opened = expectSuccess(await call(sessionA, "open_workspace", { path: targetCanonical, include_tree: false }), "open explicit target");
    assert.equal(opened.structuredContent.workspace_id, targetWorkspaceId);
    assert.equal(opened.structuredContent.root, targetCanonical);
    await close(sessionA);
    sessionA = undefined;

    sessionB = await connect(url, "b");
    const ambient = expectSuccess(await call(sessionB, "list_workspaces", {}), "materialize ambient default");
    assert.equal(ambient.structuredContent.selected_workspace_id, defaultWorkspaceId, "session B did not select ambient default");
    assert.equal(ambient.structuredContent.workspaces.length, 1, "session B inherited session A selection");

    const actions = expectSuccess(await call(sessionB, "codexpro", { action: "list_actions" }), "wrapper action listing");
    assert.equal(actions.structuredContent.actions.includes("git_push"), false, "codexpro advertised git_push");
    const wrapperBefore = await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired"));
    const wrapper = expectError(await call(sessionB, "codexpro", {
      action: "git_push",
      args: { ...request, [UNKNOWN_PROPERTY]: UNKNOWN_VALUE }
    }), "wrapper git_push action");
    assert.match(text(wrapper), /explicit public tool|general wrapper|not available/iu, "wrapper rejection was not bounded");
    assertNoSecrets(wrapper, "wrapper rejection");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired")), wrapperBefore, "wrapper changed target state");

    const missingBefore = await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired"));
    const missing = expectError(await call(sessionB, "git_push", {
      remote: "origin", branch: "main", expected_local_head: localHead, expected_remote_head: initialHead
    }), "missing workspace_id");
    assert.match(text(missing), /workspace_id/iu, "missing workspace_id was not named");
    assertNoSecrets(missing, "missing workspace_id");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired")), missingBefore, "missing workspace_id changed target state");
    assert.equal((await call(sessionB, "list_workspaces", {})).result.structuredContent.selected_workspace_id, defaultWorkspaceId, "missing ID changed ambient selection");

    const unknown = expectError(await call(sessionB, "git_push", { ...request, workspace_id: "ws_000000000000000000000000" }), "unknown workspace_id");
    assert.match(text(unknown), /workspace/iu, "unknown workspace_id omitted bounded workspace wording");
    assertNoSecrets(unknown, "unknown workspace_id");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired")), missingBefore, "unknown workspace_id changed target state");

    const hostileBefore = await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired"));
    const hostile = expectError(await call(sessionB, "git_push", { ...request, [UNKNOWN_PROPERTY]: UNKNOWN_VALUE }), "unknown schema property");
    assert.match(text(hostile), /unknown|invalid|not allowed/iu, "unknown property was not rejected");
    assertNoSecrets(hostile, "unknown property");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired")), hostileBefore, "unknown property changed target state");

    const staleBefore = await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired"));
    const stale = expectError(await call(sessionB, "git_push", { ...request, expected_local_head: initialHead }), "stale local head");
    assert.match(text(stale), /head|precondition|current/iu, "stale local head rejection was not bounded");
    assertNoSecrets(stale, "stale local head");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired")), staleBefore, "stale local head changed target state");

    const ambientAttempt = expectError(await call(sessionB, "git_push", {
      remote: "origin", branch: "main", expected_local_head: localHead, expected_remote_head: initialHead
    }), "ambient fallback attempt");
    assert.match(text(ambientAttempt), /workspace_id/iu, "ambient fallback did not fail at explicit identity boundary");
    assertNoSecrets(ambientAttempt, "ambient fallback");

    const valid = expectError(await call(sessionB, "git_push", request), "fully valid preflight stub");
    assert.match(text(valid), /Git push mutation is not yet available\./u, "valid preflight did not reach the constant mutation-unavailable error");
    assertNoSecrets(valid, "valid preflight stub");
    const targetAfter = await snapshot(targetRoot, remoteRoot, path.join(fixture, "hook-fired"));
    const defaultAfter = await snapshot(defaultRoot, remoteRoot, path.join(fixture, "hook-fired"));
    assert.deepEqual(targetAfter, targetBefore, "fully valid TASK-003 checkpoint mutated target local or remote state");
    assert.deepEqual(defaultAfter, defaultBefore, "fully valid TASK-003 checkpoint mutated ambient default state");
    assert.equal(await readFile(path.join(fixture, "hook-fired")).catch(() => null), null, "pre-push hook ran before TASK-004");
    console.log("RAW_OBSERVATION: direct target/ambient snapshots remained byte-identical after wrapper, missing/unknown/ambient, hostile, stale, and fully valid calls; hook sentinel is absent and remote main remains at the expected SHA.");
    console.log("SANITY_VERDICT: MATCH — valid preflight reaches only the bounded mutation-unavailable error and performs no push or hook invocation.");
    console.log("PREDICATE: TRUE — direct before/after refs/config/index/worktree/remote snapshots establish nonmutation independently of the error classification.");
    await close(sessionB);
    sessionB = undefined;
  });

  for (const boundary of [
    { toolMode: "standard", writeMode: "workspace", label: "standard" },
    { toolMode: "minimal", writeMode: "workspace", label: "minimal" },
    { toolMode: "full", writeMode: "off", label: "full-write-off" },
    { toolMode: "full", writeMode: "handoff", label: "full-write-handoff" },
    { toolMode: "full", writeMode: "workspace", policy: { enabled: false, rules: [] }, label: "full-policy-disabled" }
  ]) {
    await freeHttpServer({
      defaultRoot,
      allowedRoots: [defaultCanonical, path.dirname(targetCanonical)],
      policy: boundary.policy ?? policy,
      toolMode: boundary.toolMode,
      writeMode: boundary.writeMode
    }, async (url) => {
      const session = await connect(url, boundary.label);
      try {
        const listing = await session.client.listTools();
        const names = listing.tools.map((tool) => tool.name);
        assert.equal(names.includes("git_push"), false, `${boundary.label} exposed git_push`);
        const actions = expectSuccess(await call(session, "codexpro", { action: "list_actions" }), `${boundary.label} wrapper actions`);
        assert.equal(actions.structuredContent.actions.includes("git_push"), false, `${boundary.label} wrapper advertised git_push`);
        console.log(`PASS ${boundary.label}: git_push absent from direct and compatibility-wrapper catalogs.`);
      } finally {
        await close(session);
      }
    });
  }

  console.log("PASS AP-005: exact five-field direct git_push is exposed once only in full+workspace-write+enabled-policy, with strict schema, truthful remote-write annotations, and wrapper exclusion.");
  console.log("PASS AP-006: explicit workspace identity, preflight rejection boundaries, fully valid mutation-unavailable stub, loopback remote observation, and local/remote nonmutation are proven.");
  console.log("GIT_PUSH_MCP_SMOKE: PASS (TASK-003 AP-005/AP-006 focused public-surface proof).");
} finally {
  await close(sessionA);
  await close(sessionB);
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}
