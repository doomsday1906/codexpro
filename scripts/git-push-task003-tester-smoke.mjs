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
const BRANCH = "feature/release";
const UNKNOWN_PROPERTY = "OPENAI_API_KEY_TASK003_UNKNOWN_PROPERTY";
const UNKNOWN_VALUE = "sk-live-task003-unknown-property-7x9";
const SECRET = "TASK003_CREDENTIAL_SENTINEL_7X9";
const HOOK_SENTINEL = "TASK003_PRE_PUSH_MUST_NOT_RUN_7X9";

function cleanGitEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/u.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...overrides
  };
}

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    input: options.input === undefined ? undefined : Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input)),
    env: cleanGitEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git failed: git ${args.join(" ")} status=${result.status} stderr=${Buffer.from(result.stderr ?? "").toString("utf8")}`);
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(cwd, args, options = {}) {
  return git(cwd, args, options).toString("utf8").trim();
}

function unsetAllPushUrls(root) {
  const result = spawnSync("git", ["config", "--unset-all", "remote.origin.pushurl"], {
    cwd: root,
    env: cleanGitEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0 && result.status !== 5) {
    throw new Error(`fixture git pushurl cleanup failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

function initRepo(root, name, branch = BRANCH) {
  git(root, ["init", "--quiet", "--initial-branch", branch]);
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync("git", ["ls-remote", url, `refs/heads/${BRANCH}`], {
      encoding: "utf8",
      timeout: 1_000,
      env: cleanGitEnvironment()
    });
    if (result.status === 0 && String(result.stdout ?? "").endsWith(`\trefs/heads/${BRANCH}\n`)) return;
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
  const client = new Client({ name: `git-push-task003-tester-${label}`, version: "1.0.0" });
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

function assertSafe(value, label) {
  assert.equal(serialized(value).includes(UNKNOWN_PROPERTY), false, `${label} leaked hostile property name`);
  assert.equal(serialized(value).includes(UNKNOWN_VALUE), false, `${label} leaked hostile property value`);
  assert.equal(serialized(value).includes(SECRET), false, `${label} leaked credential sentinel`);
}

function readGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    env: cleanGitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  return result.error || result.status !== 0
    ? `<exit:${result.status}>${Buffer.from(result.stderr ?? "").toString("base64")}`
    : Buffer.from(result.stdout ?? "").toString("base64");
}

async function indexDigest(root) {
  const index = gitText(root, ["rev-parse", "--git-path", "index"]);
  return await readFile(path.isAbsolute(index) ? index : path.resolve(root, index)).then((bytes) => createHash("sha256").update(bytes).digest("hex")).catch(() => null);
}

async function snapshot(root, remoteRoot, hookFired, knownFiles) {
  const files = {};
  for (const file of knownFiles) files[file] = await readFile(path.join(root, file)).catch(() => null);
  return {
    head: readGit(root, ["rev-parse", "HEAD"]),
    branch: readGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    status: readGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    localRefs: readGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    branchConfig: readGit(root, ["config", "--local", "--get-regexp", "^branch\\."]),
    localConfig: readGit(root, ["config", "--local", "--null", "--list"]),
    staged: readGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstaged: readGit(root, ["diff", "--binary", "--no-ext-diff"]),
    index: await indexDigest(root),
    files,
    hookFired: await readFile(hookFired).catch(() => null),
    remoteRefs: readGit(remoteRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    remoteConfig: readGit(remoteRoot, ["config", "--null", "--list"])
  };
}

async function startHttp({ defaultRoot, allowedRoots, policy, toolMode = "full", writeMode = "workspace", hostileEnv = {} }, callback) {
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
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy),
    ...hostileEnv
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

function assertDescriptor(tool) {
  assert.ok(tool, "full workspace-write mode omitted git_push");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false
  }, "git_push annotations were not truthful");
  const schema = tool.inputSchema;
  const fields = ["workspace_id", "remote", "branch", "expected_local_head", "expected_remote_head"];
  assert.equal(schema?.type, "object", "git_push schema is not an object");
  assert.equal(schema?.additionalProperties, false, "git_push schema accepts unknown keys");
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [...fields].sort(), "git_push schema has optional or extra fields");
  assert.deepEqual(new Set(schema.required ?? []), new Set(fields), "git_push schema does not require every field");
  for (const field of fields) assert.equal(schema.properties?.[field]?.type, "string", `${field} is not a string`);
  assert.equal(schema.properties?.expected_local_head?.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
  assert.equal(schema.properties?.expected_remote_head?.pattern, "^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-task003-tester-"));
const defaultRoot = path.join(fixture, "ambient repo");
const targetRoot = path.join(fixture, "target repo with spaces");
const alternateRoot = path.join(fixture, "poisoned alternate");
const remoteRoot = path.join(fixture, "remote.git");
const hookFired = path.join(fixture, "hook-fired");
const hookPath = path.join(targetRoot, ".git", "hooks", "pre-push");
let daemon;
let sessionA;
let sessionB;
try {
  await Promise.all([mkdir(defaultRoot), mkdir(targetRoot), mkdir(alternateRoot)]);
  initRepo(defaultRoot, "Ambient Default");
  await writeFile(path.join(defaultRoot, "ambient.txt"), "ambient\n");
  const ambientHead = commit(defaultRoot, "ambient baseline");
  initRepo(targetRoot, "Target With Spaces");
  await writeFile(path.join(targetRoot, "notes.txt"), "base\n");
  const initialHead = commit(targetRoot, "target baseline");
  await mkdir(remoteRoot);
  git(remoteRoot, ["init", "--bare", "--quiet"]);
  git(targetRoot, ["push", "--quiet", `file://${remoteRoot}`, `HEAD:refs/heads/${BRANCH}`]);

  const port = await freePort();
  const endpoint = `git://127.0.0.1:${port}/remote.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--verbose", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForGitDaemon(endpoint, daemon);
  git(targetRoot, ["remote", "add", "origin", endpoint]);
  await writeFile(path.join(targetRoot, "notes.txt"), "base\ndescendant\n");
  const localHead = commit(targetRoot, "target descendant");
  await writeFile(path.join(targetRoot, "staged.txt"), "staged\n");
  git(targetRoot, ["add", "staged.txt"]);
  await writeFile(path.join(targetRoot, "untracked.txt"), "untracked\n");
  await writeFile(hookPath, `#!/bin/sh\nprintf '%s' '${HOOK_SENTINEL}' > '${hookFired}'\nexit 1\n`, "utf8");
  await chmod(hookPath, 0o755);

  initRepo(alternateRoot, "Poisoned Alternate");
  await writeFile(path.join(alternateRoot, "alternate.txt"), "alternate\n");
  commit(alternateRoot, "alternate baseline");
  const defaultCanonical = await realpath(defaultRoot);
  const targetCanonical = await realpath(targetRoot);
  const alternateCanonical = await realpath(alternateRoot);
  const targetWorkspaceId = workspaceId(targetCanonical);
  const defaultWorkspaceId = workspaceId(defaultCanonical);
  const policy = { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] };
  const request = {
    workspace_id: targetWorkspaceId,
    remote: "origin",
    branch: BRANCH,
    expected_local_head: localHead,
    expected_remote_head: initialHead
  };
  const knownFiles = ["notes.txt", "staged.txt", "untracked.txt"];
  const before = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
  const ambientBefore = await snapshot(defaultRoot, remoteRoot, hookFired, ["ambient.txt"]);
  const directRemote = gitText(targetRoot, ["ls-remote", "--refs", "--heads", "--", endpoint, `refs/heads/${BRANCH}`]);
  const directBranch = gitText(targetRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  const directHead = gitText(targetRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", initialHead, localHead], { cwd: targetRoot, env: cleanGitEnvironment() });
  console.log(`AUTHORITY: MISSION_PLAN.md TASK-003/AP-005/AP-006 and MISSION_ANCHOR.md A002 sections 1-16.`);
  console.log(`TARGET_PRODUCER_ROUTE: real MCP HTTP server -> explicit workspace_id -> gitPush -> bounded named-remote mutation attempt -> ordinary Git ls-remote -> read-only loopback git daemon; target=${targetCanonical}.`);
  console.log(`TARGET_EVIDENCE: tools/list/tools/call envelopes plus direct target/ambient refs, branch/tracking config, worktree/index bytes, and bare-remote refs/config.`);
  console.log(`RAW_OBSERVATION: target path contains spaces; attached branch=${directBranch}; local HEAD=${directHead}; ordinary ls-remote=${directRemote}; merge-base ancestor exit=${ancestry.status}; ambient HEAD=${ambientHead}.`);
  assert.equal(directBranch, `refs/heads/${BRANCH}`);
  assert.equal(directHead, localHead);
  assert.equal(directRemote, `${initialHead}\trefs/heads/${BRANCH}`);
  assert.equal(ancestry.status, 0);
  console.log("SANITY_VERDICT: MATCH — direct path, branch, full SHA, existing remote ref, and ancestry facts match the accepted preflight target before MCP calls.");
  console.log("PREDICATE: TRUE — branch attachment, exact local head, local remote commit object, ancestry, policy tuple, and ordinary remote observation are independently established.");

  const poisonedEnv = {
    GIT_DIR: path.join(alternateCanonical, ".git"),
    GIT_WORK_TREE: alternateCanonical,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_0: `https://user:${SECRET}@poisoned.example/repo.git`,
    GIT_CONFIG_GLOBAL: path.join(alternateCanonical, "global.gitconfig"),
    GIT_CONFIG_SYSTEM: path.join(alternateCanonical, "system.gitconfig"),
    GIT_OBJECT_DIRECTORY: path.join(alternateCanonical, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(alternateCanonical, ".git", "objects"),
    GIT_TRACE: path.join(alternateCanonical, "trace-sentinel"),
    GIT_SSH_COMMAND: `sh -c 'touch ${path.join(alternateCanonical, "ssh-sentinel")}'`,
    GIT_ASKPASS: path.join(alternateCanonical, "askpass-sentinel"),
    GIT_PROXY_COMMAND: path.join(alternateCanonical, "proxy-sentinel")
  };

  await startHttp({
    defaultRoot,
    allowedRoots: [defaultCanonical, path.dirname(targetCanonical)],
    policy,
    hostileEnv: poisonedEnv
  }, async (url) => {
    sessionA = await connect(url, "fresh-a");
    const listing = await sessionA.client.listTools();
    assert.equal(listing.tools.filter((tool) => tool.name === "git_push").length, 1);
    assertDescriptor(listing.tools.find((tool) => tool.name === "git_push"));
    const opened = expectSuccess(await call(sessionA, "open_workspace", { path: targetCanonical, include_tree: false }), "explicit target open");
    assert.equal(opened.structuredContent.workspace_id, targetWorkspaceId);
    assert.equal(opened.structuredContent.root, targetCanonical);
    await close(sessionA);
    sessionA = undefined;

    sessionB = await connect(url, "fresh-b");
    const ambient = expectSuccess(await call(sessionB, "list_workspaces", {}), "fresh ambient session");
    assert.equal(ambient.structuredContent.selected_workspace_id, defaultWorkspaceId);
    assert.equal(ambient.structuredContent.workspaces.length, 1);

    const actions = expectSuccess(await call(sessionB, "codexpro", { action: "list_actions" }), "wrapper action listing");
    assert.equal(actions.structuredContent.actions.includes("git_push"), false, "supertool advertised explicit git_push");
    const wrapperBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const wrapper = expectError(await call(sessionB, "codexpro", { action: "git_push", args: { ...request, [UNKNOWN_PROPERTY]: UNKNOWN_VALUE } }), "wrapper git_push");
    assert.match(text(wrapper), /explicit public tool|general wrapper|not available/iu);
    assertSafe(wrapper, "wrapper rejection");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), wrapperBefore);

    for (const [label, args, pattern] of [
      ["missing workspace id", { remote: "origin", branch: BRANCH, expected_local_head: localHead, expected_remote_head: initialHead }, /workspace_id/iu],
      ["unknown workspace id", { ...request, workspace_id: "ws_000000000000000000000000" }, /workspace/iu],
      ["hostile unknown property", { ...request, [UNKNOWN_PROPERTY]: UNKNOWN_VALUE }, /unknown|invalid|not allowed/iu],
      ["hostile known remote value", { ...request, remote: UNKNOWN_VALUE }, /remote|allowlist|invalid/iu],
      ["hostile known branch value", { ...request, branch: UNKNOWN_VALUE }, /branch|allowlist|invalid/iu],
      ["stale local head", { ...request, expected_local_head: initialHead }, /head|precondition|current/iu]
    ]) {
      const beforeCall = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
      const output = expectError(await call(sessionB, "git_push", args), label);
      assert.match(text(output), pattern, `${label} had an unexpected bounded error`);
      assertSafe(output, label);
      assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), beforeCall, `${label} mutated target state`);
      assert.equal((await readFile(path.join(alternateCanonical, "ssh-sentinel")).catch(() => null)), null, `${label} invoked poisoned SSH command`);
    }

    for (const [label, badHead] of [["ref name", "HEAD"], ["abbreviated SHA", "a".repeat(39)], ["wrong SHA length", "a".repeat(41)], ["wrong SHA object format", "a".repeat(64)]]) {
      const beforeCall = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
      const output = expectError(await call(sessionB, "git_push", { ...request, expected_local_head: badHead }), `malformed ${label}`);
      assert.match(text(output), /head|invalid|SHA/iu, `malformed ${label} had an unexpected bounded error`);
      assertSafe(output, `malformed ${label}`);
      assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), beforeCall, `malformed ${label} mutated target state`);
    }

    await writeFile(path.join(targetRoot, ".git", "MERGE_HEAD"), `${initialHead}\n`);
    const activeBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const active = expectError(await call(sessionB, "git_push", request), "active history operation");
    assert.match(text(active), /history|progress/iu);
    assertSafe(active, "active history operation");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), activeBefore);
    await rm(path.join(targetRoot, ".git", "MERGE_HEAD"));

    git(targetRoot, ["checkout", "--quiet", "--detach", "HEAD"]);
    const detachedBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const detached = expectError(await call(sessionB, "git_push", request), "detached HEAD");
    assert.match(text(detached), /detached|branch/iu);
    assertSafe(detached, "detached HEAD");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), detachedBefore);
    git(targetRoot, ["checkout", "--quiet", BRANCH]);

    const mismatchBranch = `task003-mismatch-${Date.now()}`;
    git(targetRoot, ["checkout", "--quiet", "-b", mismatchBranch]);
    const mismatchBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const mismatch = expectError(await call(sessionB, "git_push", request), "attached branch mismatch");
    assert.match(text(mismatch), /branch/iu);
    assertSafe(mismatch, "attached branch mismatch");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), mismatchBefore);
    git(targetRoot, ["checkout", "--quiet", BRANCH]);
    git(targetRoot, ["branch", "-D", mismatchBranch]);

    const uppercaseValid = { ...request, expected_local_head: localHead.toUpperCase(), expected_remote_head: initialHead.toUpperCase() };
    const validBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const valid = expectError(await call(sessionB, "git_push", uppercaseValid), "fully valid uppercase full-SHA mutation attempt");
    assert.match(text(valid), /Git push mutation failed|remote branch was not confirmed|pre-push/iu);
    assertSafe(valid, "valid mutation attempt");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), validBefore);
    assert.equal(await readFile(hookFired).catch(() => null), null, "read-only loopback transport reached the pre-push hook unexpectedly");
    const validAgain = expectError(await call(sessionB, "git_push", uppercaseValid), "repeated fully valid mutation attempt");
    assert.match(text(validAgain), /Git push mutation failed|remote branch was not confirmed|pre-push/iu);
    assertSafe(validAgain, "repeated mutation attempt");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), validBefore);

    const blob = gitText(targetRoot, ["hash-object", "-w", "--stdin"], { input: "not a commit\n" });
    const objectBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const objectError = expectError(await call(sessionB, "git_push", { ...request, expected_remote_head: blob }), "remote object is not commit");
    assert.match(text(objectError), /commit|remote/iu);
    assertSafe(objectError, "remote object error");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), objectBefore);

    const targetTree = gitText(targetRoot, ["rev-parse", "HEAD^{tree}"]);
    const independentHead = gitText(targetRoot, ["commit-tree", targetTree], { input: "independent history\n" });
    const ancestryBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const ancestryError = expectError(await call(sessionB, "git_push", { ...request, expected_remote_head: independentHead }), "non-fast-forward ancestry");
    assert.match(text(ancestryError), /fast.forward|ancestor|history/iu);
    assertSafe(ancestryError, "ancestry error");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), ancestryBefore);

    for (const [label, pushurls, pattern] of [
      ["endpoint substitution", ["https://other.example/repo.git"], /endpoint|allowlist/iu],
      ["multiple push URLs", [endpoint, "https://mirror.example/repo.git"], /multiple|ambiguous/iu],
      ["credential endpoint", [`https://user:${SECRET}@host.example/repo.git`], /credential|endpoint/iu],
      ["local endpoint", ["/tmp/repo.git"], /local|endpoint/iu],
      ["file endpoint", ["file:///tmp/repo.git"], /file|endpoint/iu],
      ["ext helper endpoint", ["ext::ssh://host.example/repo.git"], /helper|scheme|endpoint/iu],
      ["named helper endpoint", ["helper::value"], /helper|scheme|endpoint/iu]
    ]) {
      unsetAllPushUrls(targetRoot);
      for (const pushurl of pushurls) git(targetRoot, ["config", "--add", "remote.origin.pushurl", pushurl]);
      const endpointBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
      const endpointError = expectError(await call(sessionB, "git_push", request), label);
      assert.match(text(endpointError), pattern, `${label} had an unexpected rejection`);
      assertSafe(endpointError, label);
      assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), endpointBefore, `${label} mutated repository state`);
    }
    unsetAllPushUrls(targetRoot);

    const remoteAbsentBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    git(remoteRoot, ["update-ref", "-d", `refs/heads/${BRANCH}`]);
    const absentBefore = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const absent = expectError(await call(sessionB, "git_push", request), "remote branch absent");
    assert.match(text(absent), /remote|absent|branch/iu);
    assertSafe(absent, "remote branch absent");
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), absentBefore);
    git(remoteRoot, ["update-ref", `refs/heads/${BRANCH}`, initialHead]);
    assert.deepEqual(await snapshot(targetRoot, remoteRoot, hookFired, knownFiles), remoteAbsentBefore, "remote restoration changed baseline unexpectedly");

    const finalTarget = await snapshot(targetRoot, remoteRoot, hookFired, knownFiles);
    const finalAmbient = await snapshot(defaultRoot, remoteRoot, hookFired, ["ambient.txt"]);
    assert.deepEqual(finalTarget, before, "integrated preflight and mutation-failure calls changed target state");
    assert.deepEqual(finalAmbient, ambientBefore, "integrated preflight and mutation-failure calls changed ambient selected repository");
    console.log("RAW_OBSERVATION: fresh explicit-ID session calls, wrapper/missing/unknown/hostile/stale inputs, uppercase full-SHA mutation attempts, object/ancestry failures, endpoint substitutions/forms, and absent remote branch left target, ambient, index, tracking/config, worktree, hook, and remote refs byte-identical.");
    console.log("SANITY_VERDICT: MATCH — direct before/after physical evidence agrees with the accepted preflight boundaries and bounded mutation-failure outcome.");
    console.log("PREDICATE: TRUE — independent branch/head/object/ancestry/policy/ordinary ls-remote facts preceded every effect judgment; poisoned GIT_* did not redirect the target.");
    await close(sessionB);
    sessionB = undefined;
  });

  for (const boundary of [
    ["standard", "standard", "workspace", policy],
    ["minimal", "minimal", "workspace", policy],
    ["write-off", "full", "off", policy],
    ["handoff", "full", "handoff", policy],
    ["policy-off", "full", "workspace", { enabled: false, rules: [] }]
  ]) {
    const [label, toolMode, writeMode, boundaryPolicy] = boundary;
    await startHttp({ defaultRoot, allowedRoots: [defaultCanonical, path.dirname(targetCanonical)], policy: boundaryPolicy, toolMode, writeMode }, async (url) => {
      const session = await connect(url, `boundary-${label}`);
      try {
        const listing = await session.client.listTools();
        assert.equal(listing.tools.some((tool) => tool.name === "git_push"), false, `${label} exposed git_push`);
        const actions = expectSuccess(await call(session, "codexpro", { action: "list_actions" }), `${label} wrapper actions`);
        assert.equal(actions.structuredContent.actions.includes("git_push"), false, `${label} wrapper advertised git_push`);
        console.log(`PASS ${label}: direct and compatibility-wrapper catalogs exclude git_push without probing remote fixture.`);
      } finally {
        await close(session);
      }
    });
  }
  console.log("PASS TASK-003 tester matrix: AP-005 schema/annotations/gating/wrapper and AP-006 explicit-ID/local-remote-policy/nonmutation boundaries.");
  console.log("GIT_PUSH_TASK003_TESTER_SMOKE: PASS");
} finally {
  await close(sessionA);
  await close(sessionB);
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}
