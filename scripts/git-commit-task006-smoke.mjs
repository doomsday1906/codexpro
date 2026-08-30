import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Exact authority: MISSION_ANCHOR.md A001 Laws 001/002/004/005/007/008/009/010/012/013/015
// and MISSION_PLAN.md P001 TASK-006 AP-011/AP-012. This script owns hostile public proof,
// not final acceptance. Target producer/route is a real MCP HTTP call -> WorkspaceManager
// -> gitCommit -> ordinary native Git in disposable local repositories. Direct Git refs,
// trees, index/worktree bytes, hook artifacts, and remote-tracking refs are TARGET_EVIDENCE;
// MCP result fields, test assertions, and fixture scripts are SUPPORTING_ORACLE only.
const HOSTILE_HOOK_SECRET = "sk-live-task006-hook-output-secret-7x9";
const DEFAULT_SENTINEL = "TASK006_AMBIENT_DEFAULT_7X9";
const TARGET_SENTINEL = "TASK006_TARGET_BASELINE_7X9";

const REPO_ROOT = path.resolve(".");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-commit-task006-"));
const defaultRoot = path.join(fixtureRoot, "ambient-default");
const targetParent = path.join(fixtureRoot, "target-parent");
const targetRoot = path.join(targetParent, "target");
const targetHooks = path.join(fixtureRoot, "target-hooks");
const targetHookLog = path.join(fixtureRoot, "target-hook-events.log");
const failureParent = path.join(fixtureRoot, "failure-parent");
const failureRoot = path.join(failureParent, "failure-target");
const failureHooks = path.join(fixtureRoot, "failure-hooks");
const failureHookLog = path.join(fixtureRoot, "failure-hook-events.log");
const failureSecretEvidence = path.join(fixtureRoot, "failure-hook-secret-evidence.log");
const redirectRoot = path.join(fixtureRoot, "hostile-redirect");
const hostileConfig = path.join(fixtureRoot, "hostile.gitconfig");
const hostileGlobalConfig = path.join(fixtureRoot, "hostile-global.gitconfig");
const hostileSystemConfig = path.join(fixtureRoot, "hostile-system.gitconfig");
const hostileTrace = path.join(fixtureRoot, "hostile-trace.log");
const hostileTrace2 = path.join(fixtureRoot, "hostile-trace2.log");
const hostileTracePerformance = path.join(fixtureRoot, "hostile-trace-performance.log");
const hostileTracePacket = path.join(fixtureRoot, "hostile-trace-packet.log");

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    LC_ALL: "C",
    LANG: "C"
  });
  return env;
}

function directGit(root, args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: { ...gitEnv(), ...(options.env ?? {}) },
    input: options.input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  const stderr = Buffer.from(result.stderr ?? []).toString("utf8");
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git failed: git ${args.join(" ")} status=${result.status} stderr=${stderr}`);
  }
  return Buffer.from(result.stdout ?? []);
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

function quoteShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathState(root, relativePath) {
  const absolute = path.join(root, relativePath);
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return { kind: "missing" };
  }
  if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(absolute) };
  if (info.isFile()) {
    return {
      kind: "file",
      mode: info.mode & 0o7777,
      size: info.size,
      bytes: (await readFile(absolute)).toString("base64")
    };
  }
  if (info.isDirectory()) return { kind: "directory", mode: info.mode & 0o7777 };
  return { kind: "other", mode: info.mode & 0o7777 };
}

async function repositorySnapshot(root, paths) {
  const states = {};
  for (const relativePath of paths) states[relativePath] = await pathState(root, relativePath);
  return {
    head: gitText(root, ["rev-parse", "HEAD"]),
    branch: gitText(root, ["branch", "--show-current"]),
    refs: directGit(root, ["for-each-ref", "--format=%(refname)=%(objectname)"]).toString("base64"),
    remoteRefs: directGit(root, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]).toString("base64"),
    index: directGit(root, ["ls-files", "--stage", "-z"]).toString("base64"),
    staged: directGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]).toString("base64"),
    unstaged: directGit(root, ["diff", "--binary", "--no-ext-diff"]).toString("base64"),
    status: directGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]).toString("base64"),
    paths: states
  };
}

function changedPaths(root, oldHead, newHead) {
  const fields = directGit(root, ["diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "--no-renames", oldHead, newHead])
    .toString("utf8")
    .split("\u0000")
    .filter(Boolean);
  assert.equal(fields.length % 2, 0, "raw diff-tree output was malformed");
  const result = [];
  for (let index = 0; index < fields.length; index += 2) result.push({ status: fields[index], path: fields[index + 1] });
  return result;
}

function rawCommitFacts(root, commit) {
  const text = directGit(root, ["cat-file", "commit", commit]).toString("utf8");
  const separator = text.indexOf("\n\n");
  const header = separator < 0 ? text : text.slice(0, separator);
  const message = separator < 0 ? "" : text.slice(separator + 2);
  const tree = /^tree ([0-9a-f]+)$/mu.exec(header)?.[1];
  const parents = [...header.matchAll(/^parent ([0-9a-f]+)$/gmu)].map((match) => match[1]);
  const firstNewline = message.indexOf("\n");
  const subject = firstNewline < 0 ? message.replace(/\r$/u, "") : message.slice(0, firstNewline).replace(/\r$/u, "");
  let body = firstNewline < 0 ? "" : message.slice(firstNewline + 1);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  assert.ok(tree, "raw commit omitted tree header");
  return { tree, parents, subject, body };
}

function parseEnvelopeBody(capture) {
  const body = capture?.body ?? "";
  if (!body.trim()) return undefined;
  if (capture.contentType?.includes("application/json")) return JSON.parse(body);
  const events = [...body.matchAll(/^data:\s*(.+)$/gmu)].map((match) => match[1]).filter(Boolean);
  return events.length > 0 ? JSON.parse(events.at(-1)) : undefined;
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
  const client = new Client({ name: `git-commit-task006-${label}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: captureFetch(captures) });
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
  const capture = calls.at(-1);
  return {
    result,
    error,
    rawEnvelope: parseEnvelopeBody(capture),
    rawBody: capture?.body ?? ""
  };
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function expectSuccess(output, label) {
  assert.equal(output.error, undefined, `${label} threw: ${output.error?.message ?? output.error}`);
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} lacked a complete JSON-RPC envelope`);
  assert.ok(output.rawEnvelope?.result, `${label} envelope omitted result`);
  assert.notEqual(output.result?.isError, true, `${label} returned an MCP error: ${serialized(output.result)}`);
  assert.ok(output.result?.structuredContent && typeof output.result.structuredContent === "object", `${label} omitted structuredContent`);
  return output.result;
}

function expectError(output, label) {
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} lacked a complete JSON-RPC envelope`);
  assert.ok(output.rawEnvelope?.id !== undefined, `${label} envelope omitted id`);
  if (output.error === undefined) assert.equal(output.result?.isError, true, `${label} unexpectedly succeeded`);
  return output;
}

function timedCall(session, name, args) {
  const startedAt = Date.now();
  return callTool(session, name, args).then((output) => ({ ...output, startedAt, endedAt: Date.now() }));
}

async function waitForText(filePath, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (pattern.test(text)) return text;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${pattern} in ${filePath}`);
}

function parseHookEvents(text) {
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const match = /^(start|end) \d+ (\d+)$/u.exec(line);
    assert.ok(match, `unexpected hook event line: ${line}`);
    return { event: match[1], timeMs: Number(match[2]) };
  });
}

function lastResultText(output) {
  return output.result?.content?.find?.((part) => part.type === "text")?.text ?? "";
}

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

async function withHttpServer({ defaultRoot, allowedRoots, extraEnv }, callback) {
  const port = await freePort();
  const env = {
    ...process.env,
    CODEXPRO_ROOT: defaultRoot,
    CODEXPRO_ALLOWED_ROOTS: allowedRoots.join(path.delimiter),
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
    CODEXPRO_BASH_MODE: "off",
    CODEXPRO_WRITE_MODE: "workspace",
    CODEXPRO_TOOL_MODE: "full",
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

let sessionA;
let sessionB;
try {
  await Promise.all([
    mkdir(defaultRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
    mkdir(targetHooks, { recursive: true }),
    mkdir(failureRoot, { recursive: true }),
    mkdir(failureHooks, { recursive: true }),
    mkdir(redirectRoot, { recursive: true })
  ]);
  await writeFile(hostileConfig, "[user]\n\tname = Hostile Config\n\temail = hostile-config@example.invalid\n", "utf8");
  await writeFile(hostileGlobalConfig, "[user]\n\tname = Hostile Global\n\temail = hostile-global@example.invalid\n", "utf8");
  await writeFile(hostileSystemConfig, "[user]\n\tname = Hostile System\n\temail = hostile-system@example.invalid\n", "utf8");

  initRepo(defaultRoot, "TASK006 Ambient Default");
  await writeFile(path.join(defaultRoot, "default.txt"), `${DEFAULT_SENTINEL}\n`, "utf8");
  const defaultHead = commitFixture(defaultRoot, "task006 ambient baseline");

  initRepo(targetRoot, "TASK006 Target");
  await writeFile(path.join(targetRoot, "selected-a.txt"), `${TARGET_SENTINEL} A baseline\n`, "utf8");
  await writeFile(path.join(targetRoot, "selected-b.txt"), `${TARGET_SENTINEL} B baseline\n`, "utf8");
  await writeFile(path.join(targetRoot, "unrelated-staged.txt"), "staged baseline\n", "utf8");
  await writeFile(path.join(targetRoot, "unrelated-unstaged.txt"), "unstaged baseline\n", "utf8");
  const targetHead = commitFixture(targetRoot, "task006 target baseline");
  await writeFile(path.join(targetRoot, "selected-a.txt"), `${TARGET_SENTINEL} A winner\n`, "utf8");
  await writeFile(path.join(targetRoot, "selected-b.txt"), `${TARGET_SENTINEL} B loser remains\n`, "utf8");
  await writeFile(path.join(targetRoot, "unrelated-staged.txt"), "staged changed but must remain staged\n", "utf8");
  directGit(targetRoot, ["add", "--", "unrelated-staged.txt"]);
  await writeFile(path.join(targetRoot, "unrelated-unstaged.txt"), "unstaged changed but must remain unstaged\n", "utf8");
  await writeFile(path.join(targetRoot, "untracked.txt"), "untracked must remain\n", "utf8");

  const targetHook = path.join(targetHooks, "pre-commit");
  await writeFile(targetHook, [
    "#!/bin/sh",
    "set -eu",
    `printf 'start %s %s\\n' \"$$\" \"$(date +%s%3N)\" >> ${quoteShell(targetHookLog)}`,
    "sleep 0.75",
    `printf 'end %s %s\\n' \"$$\" \"$(date +%s%3N)\" >> ${quoteShell(targetHookLog)}`,
    "exit 0",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  await chmod(targetHook, 0o700);
  directGit(targetRoot, ["config", "core.hooksPath", targetHooks]);

  directGit(redirectRoot, ["init", "--quiet"]);
  directGit(redirectRoot, ["config", "user.name", "Hostile Redirect"]);
  directGit(redirectRoot, ["config", "user.email", "hostile-redirect@example.invalid"]);
  await writeFile(path.join(redirectRoot, "redirect.txt"), "wrong repository\n", "utf8");
  commitFixture(redirectRoot, "hostile redirect baseline");

  initRepo(failureRoot, "TASK006 Hook Failure");
  await writeFile(path.join(failureRoot, "failure-unrelated.txt"), "failure baseline\n", "utf8");
  const failureHead = commitFixture(failureRoot, "task006 hook failure baseline");
  await writeFile(path.join(failureRoot, "selected-untracked.txt"), "plain untracked selected content\n", "utf8");
  const failureHook = path.join(failureHooks, "pre-commit");
  await writeFile(failureHook, [
    "#!/bin/sh",
    "set -eu",
    `printf 'invoked\\n' >> ${quoteShell(failureHookLog)}`,
    `printf '%s\\n' ${quoteShell(HOSTILE_HOOK_SECRET)} >&2`,
    `printf '%s\\n' ${quoteShell(HOSTILE_HOOK_SECRET)} > ${quoteShell(failureSecretEvidence)}`,
    "exit 1",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  await chmod(failureHook, 0o700);
  directGit(failureRoot, ["config", "core.hooksPath", failureHooks]);

  const defaultCanonicalRoot = await realpath(defaultRoot);
  const targetCanonicalRoot = await realpath(targetRoot);
  const failureCanonicalRoot = await realpath(failureRoot);
  const targetWorkspaceId = workspaceIdForRoot(targetCanonicalRoot);
  const failureWorkspaceId = workspaceIdForRoot(failureCanonicalRoot);
  const targetPaths = ["selected-a.txt", "selected-b.txt", "unrelated-staged.txt", "unrelated-unstaged.txt", "untracked.txt"];

  // PASS 1: direct native facts and the accepted authority precede all MCP/test labels.
  const targetBefore = await repositorySnapshot(targetRoot, targetPaths);
  const defaultBefore = await repositorySnapshot(defaultRoot, ["default.txt"]);
  assert.equal(targetBefore.head, targetHead);
  assert.equal(targetBefore.branch.length > 0, true);
  assert.equal(defaultBefore.head, defaultHead);
  assert.notEqual(targetBefore.head, defaultBefore.head);
  assert.equal(targetBefore.paths["selected-a.txt"].kind, "file");
  assert.equal(targetBefore.paths["selected-b.txt"].kind, "file");
  assert.equal(targetBefore.paths["untracked.txt"].kind, "file");
  console.log("AUTHORITY: MISSION_ANCHOR.md A001 Laws 001/002/004/005/007/008/009/010/012/013/015 and MISSION_PLAN.md P001 TASK-006 AP-011/AP-012.");
  console.log(`TARGET_PRODUCER_ROUTE: real MCP HTTP JSON-RPC -> WorkspaceManager -> gitCommit -> ordinary native Git; target=${targetCanonicalRoot}; default=${defaultCanonicalRoot}.`);
  console.log("TARGET_EVIDENCE: direct refs/parents/tree/index/worktree/hook/remote facts plus complete JSON-RPC envelopes; MCP classifications are supporting only.");
  console.log(`RAW_OBSERVATION: target attached branch=${targetBefore.branch} HEAD=${targetBefore.head}; default HEAD=${defaultBefore.head}; target paths include two changed candidates, staged+unstaged unrelated work, and one untracked file.`);
  console.log("SANITY_VERDICT: MATCH — raw disposable repositories establish the required distinct target/default roots and complete hostile pre-state.");

  await withHttpServer({
    defaultRoot,
    allowedRoots: [defaultCanonicalRoot, path.dirname(targetCanonicalRoot), path.dirname(failureCanonicalRoot)],
    extraEnv: {
      GIT_DIR: path.join(redirectRoot, ".git"),
      GIT_WORK_TREE: redirectRoot,
      GIT_INDEX_FILE: path.join(redirectRoot, "hostile-index"),
      GIT_COMMON_DIR: path.join(redirectRoot, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(redirectRoot, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(redirectRoot, ".git", "objects"),
      GIT_CONFIG: hostileConfig,
      GIT_CONFIG_GLOBAL: hostileGlobalConfig,
      GIT_CONFIG_SYSTEM: hostileSystemConfig,
      GIT_TRACE: hostileTrace,
      GIT_TRACE2: hostileTrace2,
      GIT_TRACE_PERFORMANCE: hostileTracePerformance,
      GIT_TRACE_PACKET: hostileTracePacket
    }
  }, async (mcpUrl) => {
    sessionA = await connectClient(mcpUrl, "a");
    const listing = await sessionA.client.listTools();
    const listedNames = listing.tools.map((tool) => tool.name);
    assert.equal(listedNames.filter((name) => name === "git_commit").length, 1);
    assert.equal(listedNames.includes("git_show_commit"), true, "M001 git_show_commit missing from public route");
    assert.equal(listedNames.includes("git_diff_range"), true, "M002 git_diff_range missing from public route");
    const opened = expectSuccess(await callTool(sessionA, "open_workspace", { path: targetCanonicalRoot, include_tree: false }), "open public target");
    assert.equal(opened.structuredContent.workspace_id, targetWorkspaceId);
    assert.equal(opened.structuredContent.root, targetCanonicalRoot);

    sessionB = await connectClient(mcpUrl, "b");
    const ambient = expectSuccess(await callTool(sessionB, "list_workspaces", {}), "ambient session B list");
    assert.equal(ambient.structuredContent.selected_workspace_id, workspaceIdForRoot(defaultCanonicalRoot));
    assert.equal(ambient.structuredContent.workspaces[0].root, defaultCanonicalRoot);
    const hostileTraceBeforeRace = await readFile(hostileTrace).catch(() => null);
    const hostileTrace2BeforeRace = await readFile(hostileTrace2).catch(() => null);
    const hostileTracePerformanceBeforeRace = await readFile(hostileTracePerformance).catch(() => null);
    const hostileTracePacketBeforeRace = await readFile(hostileTracePacket).catch(() => null);

    // PREDICATE proof is independent: A is physically inside a sleeping hook before B starts.
    const callA = timedCall(sessionA, "git_commit", {
      workspace_id: targetWorkspaceId,
      paths: ["selected-a.txt"],
      message: "task006 public race A",
      expected_head: targetHead
    });
    const hookStartText = await waitForText(targetHookLog, /^start \d+ \d+$/mu);
    const hookStartEvent = parseHookEvents(hookStartText).find((event) => event.event === "start");
    assert.ok(hookStartEvent, "winner hook did not start before second public request");
    const callB = timedCall(sessionB, "git_commit", {
      workspace_id: targetWorkspaceId,
      paths: ["selected-b.txt"],
      message: "task006 public race B",
      expected_head: targetHead
    });
    const [raceA, raceB] = await Promise.all([callA, callB]);

    // PASS 1: inspect raw target state and hook timing before interpreting either MCP result.
    const targetAfterRace = await repositorySnapshot(targetRoot, targetPaths);
    const raceChanged = changedPaths(targetRoot, targetHead, targetAfterRace.head);
    const raceCommit = rawCommitFacts(targetRoot, targetAfterRace.head);
    const hookEvents = parseHookEvents(await readFile(targetHookLog, "utf8"));
    const hookEndEvent = hookEvents.find((event) => event.event === "end");
    assert.ok(hookEndEvent, "winner hook did not finish");
    assert.deepEqual(hookEvents.map((event) => event.event), ["start", "end"]);
    assert.equal(raceCommit.parents.length, 1);
    assert.equal(raceCommit.parents[0], targetHead);
    assert.deepEqual(raceChanged, [{ status: "M", path: "selected-a.txt" }]);
    assert.equal(targetAfterRace.remoteRefs, targetBefore.remoteRefs, "public race moved a remote-tracking ref");
    assert.deepEqual(targetAfterRace.paths["selected-b.txt"], targetBefore.paths["selected-b.txt"]);
    for (const relativePath of ["unrelated-staged.txt", "unrelated-unstaged.txt", "untracked.txt"]) {
      assert.deepEqual(targetAfterRace.paths[relativePath], targetBefore.paths[relativePath], `${relativePath} changed during public race`);
    }
    assert.equal(targetAfterRace.paths["selected-a.txt"].kind, "file");
    assert.equal(Buffer.from(targetAfterRace.paths["selected-a.txt"].bytes, "base64").toString("utf8"), `${TARGET_SENTINEL} A winner\n`);
    assert.equal(gitText(targetRoot, ["diff", "--cached", "--name-only"]), "unrelated-staged.txt");
    assert.deepEqual(gitText(targetRoot, ["diff", "--name-only"]).split("\n").filter(Boolean).sort(), ["selected-b.txt", "unrelated-unstaged.txt"]);
    assert.equal(gitText(targetRoot, ["ls-files", "--others", "--exclude-standard"]), "untracked.txt");
    assert.deepEqual(await readFile(hostileTrace).catch(() => null), hostileTraceBeforeRace, "public mutation added inherited GIT_TRACE output");
    assert.deepEqual(await readFile(hostileTrace2).catch(() => null), hostileTrace2BeforeRace, "public mutation added inherited GIT_TRACE2 output");
    assert.deepEqual(await readFile(hostileTracePerformance).catch(() => null), hostileTracePerformanceBeforeRace, "public mutation added inherited GIT_TRACE_PERFORMANCE output");
    assert.deepEqual(await readFile(hostileTracePacket).catch(() => null), hostileTracePacketBeforeRace, "public mutation added inherited GIT_TRACE_PACKET output");
    assert.ok(raceA.startedAt < hookEndEvent.timeMs, "public request A did not overlap hook execution");
    assert.ok(raceB.startedAt < hookEndEvent.timeMs, "public request B did not overlap hook execution");
    assert.ok(raceB.endedAt >= hookEndEvent.timeMs, "loser completed before the winner released the serialized mutation");
    console.log(`RAW_OBSERVATION: concurrent public calls started while hook was blocked; hook events=${hookEvents.map((event) => event.event).join("->")}; raw target HEAD advanced ${targetHead} -> ${targetAfterRace.head}; parent=${raceCommit.parents[0]}; raw changed paths=${JSON.stringify(raceChanged)}.`);
    console.log(`RAW_OBSERVATION: selected-b, staged/unstaged unrelated files, untracked file, and remote refs matched their exact pre-race bytes/records; hostile redirect/trace artifacts did not gain mutation-time output.`);
    console.log("PREDICATE: TRUE — direct hook start/end timing independently proves both public requests overlapped one held mutation window; the second completed only after release.");
    console.log("SANITY_VERDICT: MATCH — raw Git shows exactly one ordinary child commit with the first selected path and no clobber/residue before MCP outcomes are classified.");
    console.log("EVIDENCE_CONFLICT: NONE — direct raw target facts and public transport timing agree.");

    const successes = [raceA, raceB].filter((output) => output.error === undefined && output.result?.isError !== true);
    const failures = [raceA, raceB].filter((output) => output.error !== undefined || output.result?.isError === true);
    assert.equal(successes.length, 1, "public race did not produce exactly one success");
    assert.equal(failures.length, 1, "public race did not produce exactly one bounded loser");
    const winner = successes[0];
    const loser = expectError(failures[0], "public race loser");
    assert.match(serialized(loser.rawEnvelope), /head|preflight|changed|retry|workspace/iu, "race loser was not a bounded expected-head/serialization failure");
    assert.equal(serialized(winner.rawEnvelope).includes("task006 public race"), false, "success envelope echoed caller commit message");
    const winnerData = expectSuccess(winner, "public race winner").structuredContent;
    assert.equal(winnerData.old_head, targetHead);
    assert.equal(winnerData.new_head, targetAfterRace.head);
    assert.deepEqual(winnerData.committed_paths, ["selected-a.txt"]);
    console.log("PASS public concurrency: two distinct real HTTP git_commit calls sharing one expected head yielded one ordinary commit, one bounded loser, physical lock overlap timing, exact preservation, and no remote/trace residue.");

    // PASS 1 for immutable review: raw commit/tree/range facts are collected before public M001/M002 output interpretation.
    const rawReviewFacts = rawCommitFacts(targetRoot, targetAfterRace.head);
    const rawRangePaths = changedPaths(targetRoot, targetHead, targetAfterRace.head);
    const rawNumstat = directGit(targetRoot, ["diff", "--numstat", "--no-renames", targetHead, targetAfterRace.head]).toString("utf8").trim();
    const rawNumstatMatch = /^(\d+)\t(\d+)\tselected-a\.txt$/u.exec(rawNumstat);
    assert.equal(rawReviewFacts.parents.length, 1);
    assert.deepEqual(rawRangePaths, [{ status: "M", path: "selected-a.txt" }]);
    assert.ok(rawNumstatMatch, `unexpected raw numstat: ${JSON.stringify(rawNumstat)}`);
    console.log(`RAW_OBSERVATION: immutable Git review producer reports commit=${targetAfterRace.head}, tree=${rawReviewFacts.tree}, parent=${rawReviewFacts.parents[0]}, range=${JSON.stringify(rawRangePaths)}, numstat=${JSON.stringify(rawNumstat)}.`);
    console.log("SANITY_VERDICT: MATCH — direct object database and two-tree range facts independently establish the exact commit to be reviewed.");

    const shown = await callTool(sessionA, "git_show_commit", { workspace_id: targetWorkspaceId, ref: targetAfterRace.head });
    const shownData = expectSuccess(shown, "M001 public show of created commit").structuredContent;
    const ranged = await callTool(sessionA, "git_diff_range", {
      workspace_id: targetWorkspaceId,
      base_ref: targetHead,
      head_ref: targetAfterRace.head,
      include_patch: false
    });
    const rangedData = expectSuccess(ranged, "M002 public range of created commit").structuredContent;
    assert.equal(shownData.commit_sha, targetAfterRace.head);
    assert.equal(shownData.tree_sha, rawReviewFacts.tree);
    assert.deepEqual(shownData.parents, rawReviewFacts.parents);
    assert.equal(shownData.is_root, false);
    assert.equal(shownData.is_merge, false);
    assert.equal(shownData.subject, rawReviewFacts.subject);
    assert.equal(shownData.body, rawReviewFacts.body);
    assert.equal(rangedData.base_commit_sha, targetHead);
    assert.equal(rangedData.head_commit_sha, targetAfterRace.head);
    assert.equal(rangedData.changed_file_count, 1);
    assert.equal(rangedData.eligible_changed_file_count, 1);
    assert.equal(rangedData.returned_file_count, 1);
    assert.deepEqual(rangedData.changed_files, [{
      status: "M",
      old_path: "selected-a.txt",
      new_path: "selected-a.txt",
      similarity: null,
      additions: Number(rawNumstatMatch[1]),
      deletions: Number(rawNumstatMatch[2]),
      binary: false
    }]);
    assert.equal(shown.rawEnvelope?.jsonrpc, "2.0");
    assert.equal(ranged.rawEnvelope?.jsonrpc, "2.0");
    assert.equal((shown.rawBody.match(/"structuredContent"/gu) ?? []).length, 1);
    assert.equal((ranged.rawBody.match(/"structuredContent"/gu) ?? []).length, 1);
    console.log("PASS immutable public review: current M001 git_show_commit and M002 git_diff_range reviewed the created commit and matched independent raw commit/tree/parent/range/numstat facts.");

    // Public hostile hook-output proof: direct hook artifact proves the secret was emitted,
    // then the complete JSON-RPC envelope is checked without relying on a client projection.
    const failureBefore = await repositorySnapshot(failureRoot, ["selected-untracked.txt", "failure-unrelated.txt"]);
    assert.equal(failureBefore.head, failureHead);
    const failureOpened = expectSuccess(await callTool(sessionA, "open_workspace", { path: failureCanonicalRoot, include_tree: false }), "open hook-failure target");
    assert.equal(failureOpened.structuredContent.workspace_id, failureWorkspaceId);
    const failure = await callTool(sessionA, "git_commit", {
      workspace_id: failureWorkspaceId,
      paths: ["selected-untracked.txt"],
      message: "task006 hostile hook failure",
      expected_head: failureHead
    });
    const failureAfter = await repositorySnapshot(failureRoot, ["selected-untracked.txt", "failure-unrelated.txt"]);
    const failureHookEvents = await readFile(failureHookLog, "utf8");
    const producedSecret = await readFile(failureSecretEvidence, "utf8");
    assert.match(failureHookEvents, /^invoked\n$/u);
    assert.equal(producedSecret.trim(), HOSTILE_HOOK_SECRET);
    assert.equal(failureAfter.head, failureBefore.head);
    assert.equal(failureAfter.refs, failureBefore.refs);
    assert.equal(failureAfter.remoteRefs, failureBefore.remoteRefs);
    assert.equal(failureAfter.index, failureBefore.index);
    assert.equal(failureAfter.status, failureBefore.status);
    assert.deepEqual(failureAfter.paths, failureBefore.paths);
    assert.equal(await exists(path.join(failureRoot, ".git", "index.lock")), false);
    const failureEnvelopeText = serialized(failure.rawEnvelope) + failure.rawBody + serialized(failure.result) + serialized(failure.error);
    assert.equal(failureEnvelopeText.includes(HOSTILE_HOOK_SECRET), false, "hostile hook output leaked into complete JSON-RPC error envelope");
    expectError(failure, "hostile hook failure");
    console.log(`RAW_OBSERVATION: external pre-commit hook invocation marker=${failureHookEvents.trim()}; direct hook artifact emitted a secret (${producedSecret.trim().length} bytes), while failure HEAD/index/status/worktree/remote facts remained exact.`);
    console.log("SANITY_VERDICT: MATCH — direct hook producer and raw repository restoration facts establish the hostile failure before envelope interpretation.");
    console.log("PASS hostile public hook envelope: the secret emitted by a real configured hook was absent from every serialized JSON-RPC error-envelope surface.");

    console.log("COVERAGE_MAP: existing git-commit-smoke covers selected states, path/blocked/directory/gitlink/ignored/detached/in-progress/unmerged rejection, preservation, no-change, environment, and remote falsifiers; task004 smoke covers stale/mid-commit race, hooks/policy, identity/signing, and restoration; git-commit-mcp smoke covers mode/write boundaries, explicit fresh-session identity, stale/wrong/missing IDs, and complete hostile envelopes; TASK-006 script adds public lock race, public M001/M002 review, public hostile-hook redaction, and hostile inherited redirect/trace checks.");
    console.log("GIT_COMMIT_TASK006_SMOKE: PASS (hostile public proof only; no final acceptance claim).");
  });
} finally {
  await closeClient(sessionA);
  await closeClient(sessionB);
  await rm(fixtureRoot, { recursive: true, force: true });
}
