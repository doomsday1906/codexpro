import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGitPushArgs, GIT_PUSH_FIXED_OPTIONS } from "../dist/gitPush.js";

const REPO_ROOT = path.resolve(".");
const BRANCH = "main";
const SECRET = "TASK004_CREDENTIAL_SENTINEL_7X9";
const SUCCESS_HOOK_SENTINEL = "TASK004_SUCCESS_PRE_PUSH_HOOK_7X9";
const RACE_HOOK_SENTINEL = "TASK004_RACE_PRE_PUSH_HOOK_7X9";

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

function gitResult(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    input: options.input === undefined ? undefined : Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input)),
    env: cleanGitEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function git(cwd, args, options = {}) {
  const result = gitResult(cwd, args, options);
  if (result.error || result.status !== 0) {
    const stderr = Buffer.from(result.stderr ?? "").toString("utf8");
    throw new Error(`fixture git failed (${result.status}): ${args.join(" ")} ${stderr.slice(0, 400)}`);
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(cwd, args, options = {}) {
  return git(cwd, args, options).toString("utf8").trim();
}

function initRepo(root, name) {
  git(root, ["init", "--quiet", "--initial-branch", BRANCH]);
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

function readGit(cwd, args) {
  const result = gitResult(cwd, args);
  if (result.error || result.status !== 0) return `<exit:${result.status}>`;
  return Buffer.from(result.stdout ?? "").toString("base64");
}

async function digestFile(filePath) {
  const bytes = await readFile(filePath).catch(() => null);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

async function repositorySnapshot(root, remoteRoot, hookFired, files) {
  const fileBytes = {};
  for (const file of files) fileBytes[file] = await readFile(path.join(root, file)).catch(() => null);
  const indexPath = gitText(root, ["rev-parse", "--git-path", "index"]);
  const index = await digestFile(path.isAbsolute(indexPath) ? indexPath : path.resolve(root, indexPath));
  return {
    head: readGit(root, ["rev-parse", "HEAD"]),
    branch: readGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    refs: readGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    tracking: readGit(root, ["for-each-ref", "refs/remotes", "--format=%(refname)%00%(objectname)%00"]),
    status: readGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: readGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstaged: readGit(root, ["diff", "--binary", "--no-ext-diff"]),
    config: readGit(root, ["config", "--local", "--null", "--list"]),
    index,
    files: fileBytes,
    hookFired: await readFile(hookFired).catch(() => null),
    remoteRefs: readGit(remoteRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    remoteHead: readGit(remoteRoot, ["rev-parse", `refs/heads/${BRANCH}`]),
    remoteConfig: readGit(remoteRoot, ["config", "--null", "--list"])
  };
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
    const result = gitResult(REPO_ROOT, ["ls-remote", url, `refs/heads/${BRANCH}`]);
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
  const client = new Client({ name: `git-push-task004-smoke-${label}`, version: "1.0.0" });
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

function resultText(output) {
  return output?.result?.content?.find?.((part) => part.type === "text")?.text
    ?? JSON.stringify(output?.result ?? output?.rawEnvelope ?? output?.error);
}

function expectSuccess(output, label) {
  assert.equal(output.error, undefined, `${label} threw: ${output.error?.message ?? output.error}`);
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} omitted JSON-RPC envelope`);
  assert.ok(output.rawEnvelope?.result, `${label} omitted result`);
  assert.notEqual(output.result?.isError, true, `${label} failed: ${resultText(output)}`);
  return output.result;
}

function expectError(output, label) {
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} omitted JSON-RPC envelope`);
  if (output.error) return output;
  assert.equal(output.result?.isError, true, `${label} unexpectedly succeeded: ${resultText(output)}`);
  return output;
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function assertSafe(value, label) {
  const body = serialized(value);
  assert.equal(body.includes(SECRET), false, `${label} leaked credential sentinel`);
  assert.equal(body.includes("git://127.0.0.1"), false, `${label} leaked raw endpoint`);
}

async function withHttpServer({ defaultRoot, allowedRoots, policy }, callback) {
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
    CODEXPRO_TOOL_CARDS: "0",
    CODEXPRO_CODEX_SESSIONS: "off",
    CODEXPRO_CONNECTION_TEST: "0",
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy)
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.CODEXPRO_REQUIRE_HTTP_TOKEN;
  delete env.CODEXPRO_TUNNEL_MODE;
  const child = spawn(process.execPath, ["dist/http.js"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server timeout\n${stderr.slice(0, 500)}`)), 15_000);
    timer.unref();
    child.stderr.on("data", () => {
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code} ${signal ?? ""}`));
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

function assertGitPushDescriptor(tool) {
  assert.ok(tool, "full workspace-write mode omitted git_push");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false
  });
  const fields = ["workspace_id", "remote", "branch", "expected_local_head", "expected_remote_head"];
  assert.deepEqual(Object.keys(tool.inputSchema?.properties ?? {}).sort(), [...fields].sort());
  assert.deepEqual(new Set(tool.inputSchema?.required ?? []), new Set(fields));
  assert.equal(tool.inputSchema?.additionalProperties, false);
}

function assertExactInternalArgv() {
  const preflight = {
    schema_version: 1,
    workspace_id: "ws_000000000000000000000000",
    root: "/tmp/target",
    git_dir: "/tmp/target/.git",
    object_format: "sha1",
    remote: "origin",
    endpoint: "git://127.0.0.1:1/remote.git",
    branch: BRANCH,
    source_ref: `refs/heads/${BRANCH}`,
    destination_ref: `refs/heads/${BRANCH}`,
    expected_local_head: "a".repeat(40),
    expected_remote_head: "b".repeat(40)
  };
  assert.deepEqual(["push", ...buildGitPushArgs(preflight)], [
    "push",
    ...GIT_PUSH_FIXED_OPTIONS,
    `--force-with-lease=refs/heads/${BRANCH}:${"b".repeat(40)}`,
    "--",
    "origin",
    `${"a".repeat(40)}:refs/heads/${BRANCH}`
  ]);
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-task004-"));
const remoteRoot = path.join(fixture, "remote.git");
const seedRoot = path.join(fixture, "seed");
const targetRoot = path.join(fixture, "success target");
const raceSourceRoot = path.join(fixture, "race source");
const raceTargetRoot = path.join(fixture, "race target");
const raceWriterRoot = path.join(fixture, "race writer");
const hookFired = path.join(fixture, "success-hook-fired");
const raceHookFired = path.join(fixture, "race-hook-fired");
const raceWriterFired = path.join(fixture, "race-writer-fired");
const hookPath = path.join(targetRoot, ".git", "hooks", "pre-push");
const raceHookPath = path.join(raceTargetRoot, ".git", "hooks", "pre-push");
let daemon;
let successSession;
let raceSession;

try {
  await mkdir(seedRoot, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  initRepo(seedRoot, "Seed");
  await writeFile(path.join(seedRoot, "notes.txt"), "R0\n", "utf8");
  const r0 = commit(seedRoot, "R0");
  git(remoteRoot, ["init", "--bare", "--quiet"]);
  git(seedRoot, ["push", "--quiet", remoteRoot, `${r0}:refs/heads/${BRANCH}`]);
  git(remoteRoot, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);

  const port = await freePort();
  const endpoint = `git://127.0.0.1:${port}/remote.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", "--verbose", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForGitDaemon(endpoint, daemon);

  git(fixture, ["clone", "--quiet", endpoint, targetRoot]);
  git(targetRoot, ["config", "user.name", "Success Target"]);
  git(targetRoot, ["config", "user.email", "success-target@example.test"]);
  await writeFile(path.join(targetRoot, "notes.txt"), "R0\nL1\n", "utf8");
  const localHead = commit(targetRoot, "L1");
  await writeFile(path.join(targetRoot, "staged.txt"), "staged-but-uncommitted\n", "utf8");
  git(targetRoot, ["add", "staged.txt"]);
  await writeFile(path.join(targetRoot, "untracked.txt"), "untracked\n", "utf8");
  await writeFile(hookPath, `#!/bin/sh\nprintf '%s\\n' '${SUCCESS_HOOK_SENTINEL}' >> '${hookFired}'\nexit 0\n`, "utf8");
  await chmod(hookPath, 0o755);

  const targetCanonical = await realpath(targetRoot);
  const targetWorkspaceId = workspaceId(targetCanonical);
  const policy = { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] };
  const request = {
    workspace_id: targetWorkspaceId,
    remote: "origin",
    branch: BRANCH,
    expected_local_head: localHead,
    expected_remote_head: r0
  };

  const parentResult = gitResult(targetRoot, ["rev-parse", "HEAD^"]);
  assert.equal(parentResult.status, 0, `success L1 has no parent (log=${gitText(targetRoot, ["log", "--oneline", "--all"])} refs=${gitText(targetRoot, ["show-ref"])} remote=${gitText(remoteRoot, ["show-ref"])})`);
  assert.equal(Buffer.from(parentResult.stdout ?? "").toString("utf8").trim(), r0, "success L1 is not a descendant of R0");
  assert.equal(gitText(remoteRoot, ["rev-parse", `refs/heads/${BRANCH}`]), r0, "success remote did not remain at R0 before baseline");
  const ordinary = gitResult(targetRoot, ["push", "--quiet", "origin", `${localHead}:refs/heads/${BRANCH}`]);
  assert.equal(ordinary.status, 0, `ordinary named-remote baseline push failed (${Buffer.from(ordinary.stderr ?? "").toString("utf8").slice(0, 300)})`);
  const ordinaryTracking = gitText(targetRoot, ["rev-parse", `refs/remotes/origin/${BRANCH}`]);
  assert.equal(ordinaryTracking, localHead, "ordinary named-remote push did not update native tracking ref");
  const ordinaryRemoteHead = gitText(remoteRoot, ["rev-parse", `refs/heads/${BRANCH}`]);
  assert.equal(ordinaryRemoteHead, localHead, "ordinary baseline did not update the remote branch");
  git(remoteRoot, ["update-ref", `refs/heads/${BRANCH}`, r0]);
  git(targetRoot, ["update-ref", `refs/remotes/origin/${BRANCH}`, r0]);
  await rm(hookFired, { force: true });

  for (const [key, value] of [
    ["push.followTags", "true"],
    ["push.useForceIfIncludes", "true"],
    ["push.gpgSign", "true"],
    ["push.recurseSubmodules", "on-demand"],
    ["push.pushOption", SECRET],
    ["push.atomic", "true"],
    ["push.autoSetupRemote", "true"]
  ]) git(targetRoot, ["config", key, value]);

  const successBefore = await repositorySnapshot(targetRoot, remoteRoot, hookFired, ["notes.txt", "staged.txt", "untracked.txt"]);
  console.log("AUTHORITY: MISSION_PLAN.md P002 TASK-004/AP-007/AP-008, MISSION_ANCHOR.md A002, and MISSION_CORRECTIONS.md COR-001 Option A.");
  console.log("TARGET_PRODUCER_ROUTE: real MCP HTTP server -> explicit workspace_id -> gitPush -> named-remote Git push -> loopback git daemon.");
  console.log(`RAW_OBSERVATION: before success call, target branch is refs/heads/${BRANCH}, local HEAD is L1 ${localHead}, remote branch is R0 ${r0}, staged and untracked bytes exist, and ordinary named-remote push tracking ref is ${ordinaryTracking}.`);
  console.log("SANITY_VERDICT: MATCH — direct target and bare-remote facts establish an existing branch, descendant local head, and untouched pending work before mutation.");
  console.log("PREDICATE: TRUE — independent branch/head/remote/object/ancestry/policy facts satisfy the accepted success precondition before judging push effects.");
  assertExactInternalArgv();

  await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [path.dirname(targetCanonical)], policy }, async (url) => {
    successSession = await connect(url, "success");
    const listing = await successSession.client.listTools();
    assertGitPushDescriptor(listing.tools.find((tool) => tool.name === "git_push"));
    const opened = expectSuccess(await call(successSession, "open_current_workspace", {}), "open target workspace");
    assert.equal(opened.structuredContent.workspace_id, targetWorkspaceId);
    const result = expectSuccess(await call(successSession, "git_push", request), "successful exact CAS push");
    assert.deepEqual(result.structuredContent, {
      codexpro_tool: "git_push",
      codexpro_title: "Git Push",
      schema_version: 1,
      workspace_id: targetWorkspaceId,
      root: targetCanonical,
      remote: "origin",
      branch: BRANCH,
      destination_ref: `refs/heads/${BRANCH}`,
      source_head: localHead,
      expected_remote_head: r0,
      remote_head: localHead,
      push_attempts: 1
    });
    assertSafe(result, "successful public result");
    await close(successSession);
    successSession = undefined;
  });

  const successAfter = await repositorySnapshot(targetRoot, remoteRoot, hookFired, ["notes.txt", "staged.txt", "untracked.txt"]);
  const expectedLocalRefs = Buffer.from(
    `refs/heads/${BRANCH}\u0000${localHead}\u0000\nrefs/remotes/origin/HEAD\u0000${localHead}\u0000\nrefs/remotes/origin/${BRANCH}\u0000${localHead}\u0000\n`
  ).toString("base64");
  const expectedTrackingRefs = Buffer.from(
    `refs/remotes/origin/HEAD\u0000${localHead}\u0000\nrefs/remotes/origin/${BRANCH}\u0000${localHead}\u0000\n`
  ).toString("base64");
  const expectedRemoteRefs = Buffer.from(
    `refs/heads/${BRANCH}\u0000${localHead}\u0000\n`
  ).toString("base64");
  assert.equal(successAfter.refs, expectedLocalRefs, "CAS push created/deleted/unexpected local refs");
  assert.equal(successAfter.tracking, expectedTrackingRefs, "CAS push did not preserve exact native tracking-ref shape");
  assert.equal(successAfter.remoteRefs, expectedRemoteRefs, "CAS push created/deleted/unexpected remote refs");
  assert.equal(gitText(targetRoot, ["rev-parse", `refs/remotes/origin/${BRANCH}`]), ordinaryTracking, "CAS push did not preserve native tracking behavior");
  assert.equal(gitText(remoteRoot, ["rev-parse", `refs/heads/${BRANCH}`]), localHead, "CAS success remote branch is not exact local head");
  assert.equal(successAfter.head, successBefore.head, "CAS push changed local HEAD");
  assert.equal(successAfter.branch, successBefore.branch, "CAS push changed attached branch");
  assert.equal(successAfter.status, successBefore.status, "CAS push changed worktree status");
  assert.equal(successAfter.staged, successBefore.staged, "CAS push changed staged bytes");
  assert.equal(successAfter.unstaged, successBefore.unstaged, "CAS push changed unstaged bytes");
  assert.equal(successAfter.config, successBefore.config, "CAS push changed local config");
  assert.equal(successAfter.remoteConfig, successBefore.remoteConfig, "CAS push changed remote config");
  assert.equal(successAfter.index, successBefore.index, "CAS push changed index bytes");
  assert.deepEqual(successAfter.files, successBefore.files, "CAS push changed worktree files");
  assert.equal(successAfter.hookFired?.toString(), `${SUCCESS_HOOK_SENTINEL}\n`, "successful synchronous pre-push hook did not run exactly once");
  assert.equal(successAfter.remoteHead, Buffer.from(`${localHead}\n`).toString("base64"));
  assert.equal(Object.keys(JSON.parse(JSON.stringify(successAfter.files))).length, 3);
  console.log(`RAW_OBSERVATION: success remote branch is ${localHead}; target branch/head, pending bytes, index, config, and unrelated refs stayed unchanged; native refs/remotes/origin/${BRANCH} moved exactly as in the ordinary named-remote baseline; hook sentinel is present.`);
  console.log("SANITY_VERDICT: MATCH — direct post-mutation target and remote evidence matches AP-008 exact existing-branch success and preservation requirements.");
  console.log("AP-008: PASS — one exact named-remote push updated only refs/heads/main, retained ordinary tracking behavior, and invoked the synchronous successful pre-push hook.");

  git(remoteRoot, ["update-ref", `refs/heads/${BRANCH}`, r0]);
  await mkdir(raceSourceRoot, { recursive: true });
  git(fixture, ["clone", "--quiet", seedRoot, raceSourceRoot]);
  git(raceSourceRoot, ["config", "user.name", "Race Source"]);
  git(raceSourceRoot, ["config", "user.email", "race-source@example.test"]);
  await writeFile(path.join(raceSourceRoot, "notes.txt"), "R0\nR1\n", "utf8");
  const r1 = commit(raceSourceRoot, "R1");
  await writeFile(path.join(raceSourceRoot, "notes.txt"), "R0\nR1\nL1\n", "utf8");
  const raceLocalHead = commit(raceSourceRoot, "L1");
  git(fixture, ["clone", "--quiet", raceSourceRoot, raceTargetRoot]);
  git(fixture, ["clone", "--quiet", raceSourceRoot, raceWriterRoot]);
  for (const root of [raceTargetRoot, raceWriterRoot]) {
    git(root, ["config", "user.name", path.basename(root)]);
    git(root, ["config", "user.email", `${path.basename(root).replaceAll(" ", "-")}@example.test`]);
    git(root, ["remote", "set-url", "origin", endpoint]);
    git(root, ["update-ref", `refs/remotes/origin/${BRANCH}`, r0]);
  }
  git(raceTargetRoot, ["checkout", "--quiet", BRANCH]);
  git(raceWriterRoot, ["reset", "--quiet", "--hard", r1]);
  await writeFile(raceHookPath, `#!/bin/sh\nset -eu\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${raceWriterRoot}' push --quiet origin '${r1}:refs/heads/${BRANCH}'\nprintf '%s\\n' '${RACE_HOOK_SENTINEL}' >> '${raceHookFired}'\nprintf '%s' 'writer-b-advanced' > '${raceWriterFired}'\nexit 0\n`, "utf8");
  await chmod(raceHookPath, 0o755);
  const raceCanonical = await realpath(raceTargetRoot);
  const raceWorkspaceId = workspaceId(raceCanonical);
  const raceRequest = {
    workspace_id: raceWorkspaceId,
    remote: "origin",
    branch: BRANCH,
    expected_local_head: raceLocalHead,
    expected_remote_head: r0
  };
  const raceBefore = await repositorySnapshot(raceTargetRoot, remoteRoot, raceHookFired, []);
  const ancestry = gitResult(raceTargetRoot, ["merge-base", "--is-ancestor", r0, raceLocalHead]);
  assert.equal(ancestry.status, 0, "race precondition R0 is not ancestor of local L1");
  await mkdir(path.join(fixture, "empty-hooks"), { recursive: true });
  const nonCasPossibleBefore = gitResult(raceTargetRoot, ["-c", `core.hooksPath=${path.join(fixture, "empty-hooks")}`, "push", "--dry-run", "origin", `${raceLocalHead}:refs/heads/${BRANCH}`]);
  assert.equal(nonCasPossibleBefore.status, 0, `ordinary non-CAS FF probe from R0 to L1 did not succeed before race: ${Buffer.from(nonCasPossibleBefore.stderr ?? "").toString("utf8").slice(0, 500)}`);
  console.log(`RAW_OBSERVATION: before race call, graph is R0 ${r0} -> R1 ${r1} -> L1 ${raceLocalHead}; A sees remote R0, and an independent ordinary non-CAS dry-run is fast-forwardable.`);
  console.log("SANITY_VERDICT: MATCH — independent graph and dry-run facts establish the race predicate before the CAS attempt.");
  console.log("PREDICATE: TRUE — R0 is independently observed as remote head, R0 is an ancestor of L1, and ordinary non-CAS R1-to-L1 remains a lawful fast-forward shape.");

  await withHttpServer({ defaultRoot: raceCanonical, allowedRoots: [path.dirname(raceCanonical)], policy }, async (url) => {
    raceSession = await connect(url, "race");
    const opened = expectSuccess(await call(raceSession, "open_current_workspace", {}), "open race target workspace");
    assert.equal(opened.structuredContent.workspace_id, raceWorkspaceId);
    const raceError = expectError(await call(raceSession, "git_push", raceRequest), "stale CAS race");
    assert.match(resultText(raceError), /compare.and.swap|stale|remote branch changed/iu, "race error did not expose bounded stale/CAS truth");
    assertSafe(raceError, "race error");
    await close(raceSession);
    raceSession = undefined;
  });

  const raceAfter = await repositorySnapshot(raceTargetRoot, remoteRoot, raceHookFired, []);
  const remoteAfterRace = gitText(remoteRoot, ["rev-parse", `refs/heads/${BRANCH}`]);
  assert.equal(remoteAfterRace, r1, "CAS race did not leave Writer B's R1 physically in the remote");
  assert.equal(raceAfter.head, raceBefore.head, "CAS race changed A local HEAD");
  assert.equal(raceAfter.branch, raceBefore.branch, "CAS race changed A attached branch");
  assert.equal(raceAfter.refs, raceBefore.refs, "CAS race changed A local refs or tracking refs");
  assert.equal(raceAfter.status, raceBefore.status, "CAS race changed A worktree status");
  assert.equal(raceAfter.config, raceBefore.config, "CAS race changed A local config");
  assert.equal(raceAfter.remoteConfig, raceBefore.remoteConfig, "CAS race changed remote config");
  assert.equal(raceAfter.index, raceBefore.index, "CAS race changed A index");
  assert.equal(raceAfter.hookFired?.toString(), `${RACE_HOOK_SENTINEL}\n`, "race hook did not run exactly once synchronously");
  assert.equal((await readFile(raceWriterFired)).toString(), "writer-b-advanced");
  assert.equal(raceAfter.remoteRefs, Buffer.from(`refs/heads/${BRANCH}\u0000${r1}\u0000\n`).toString("base64"), "race changed an unrelated remote ref");
  const nonCasPossibleAfter = gitResult(raceTargetRoot, ["-c", `core.hooksPath=${path.join(fixture, "empty-hooks")}`, "push", "--dry-run", "origin", `${raceLocalHead}:refs/heads/${BRANCH}`]);
  assert.equal(nonCasPossibleAfter.status, 0, "ordinary non-CAS FF from R1 to L1 was not physically possible after Writer B advanced");
  console.log(`RAW_OBSERVATION: Writer B advanced the bare remote to R1 ${r1}; A's local branch/head/tracking/config/index stayed unchanged; no unrelated remote refs appeared; ordinary non-CAS dry-run from R1 to L1 exits 0.`);
  console.log("SANITY_VERDICT: MATCH — direct remote and A-local evidence contradicts any ordinary-push overwrite but matches exact lease CAS rejection.");
  console.log("AP-007: PASS — one bounded push attempt classified the stale lease race without retry; physical remote remains R1 even though non-CAS fast-forward was possible.");
  console.log("GIT_PUSH_TASK004_SMOKE: PASS");
} finally {
  await close(successSession);
  await close(raceSession);
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}
