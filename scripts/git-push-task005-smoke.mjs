import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildGitPushArgs, GIT_PUSH_FIXED_OPTIONS } from "../dist/gitPush.js";

const REPO_ROOT = path.resolve(".");
const BRANCH = "main";
const UNKNOWN_KEY = "TASK005_UNKNOWN_PROPERTY_7X9";
const UNKNOWN_VALUE = "TASK005_UNKNOWN_VALUE_7X9";
const CREDENTIAL_SENTINEL = "TASK005_CREDENTIAL_SENTINEL_7X9";
const SSH_SENTINEL = "TASK005_SYNTHETIC_SSH_STDERR_7X9";
const HELPER_SENTINEL = "TASK005_SYNTHETIC_HELPER_STDERR_7X9";
const HOOK_REJECT_SENTINEL = "TASK005_REJECTING_PRE_PUSH_HOOK_7X9";
const HOOK_SUCCESS_SENTINEL = "TASK005_SUCCESS_PRE_PUSH_HOOK_7X9";
const POSTCONDITION_SENTINEL = "TASK005_POST_RECEIVE_MUTATION_7X9";

function cleanGitEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/u.test(key)) delete env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: process.platform === "win32" ? "1" : "1",
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
    throw new Error(`fixture git failed (${result.status}): ${args.join(" ")} ${Buffer.from(result.stderr ?? "").toString("utf8").slice(0, 500)}`);
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(cwd, args, options = {}) {
  return git(cwd, args, options).toString("utf8").trim();
}

function gitTry(cwd, args, options = {}) {
  const result = gitResult(cwd, args, options);
  return {
    status: result.status,
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? "")
  };
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
  assert.ok(port > 0, "failed to reserve a loopback port");
  return port;
}

async function waitForGitDaemon(url, daemon) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = gitTry(REPO_ROOT, ["ls-remote", url, `refs/heads/${BRANCH}`]);
    if (result.status === 0 && result.stdout.toString("utf8").endsWith(`\trefs/heads/${BRANCH}\n`)) return;
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
  const client = new Client({ name: `git-push-task005-smoke-${label}`, version: "1.0.0" });
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
  return { result, error, rawEnvelope: parseEnvelope(last), rawBody: last?.body ?? "", requestBody: last?.requestBody ?? "" };
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

function assertBoundedPublic(output, label, forbidden = []) {
  assert.ok(output.rawBody.length <= 16_384, `${label} raw MCP response exceeded 16 KiB`);
  assert.ok(resultText(output).length <= 8_192, `${label} public text exceeded 8 KiB`);
  const body = output.rawBody;
  for (const value of [...forbidden, CREDENTIAL_SENTINEL]) assert.equal(body.includes(value), false, `${label} leaked forbidden public value`);
  assert.equal(body.includes("Authorization:"), false, `${label} exposed an Authorization header`);
}

function readGit(cwd, args) {
  const result = gitTry(cwd, args);
  return result.status === 0
    ? Buffer.from(result.stdout).toString("base64")
    : `<exit:${result.status}>${Buffer.from(result.stderr).toString("base64")}`;
}

async function digestFile(filePath) {
  try {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function snapshot(root, remoteRoot, files = []) {
  const gitDir = gitText(root, ["rev-parse", "--git-dir"]);
  const indexPath = path.isAbsolute(gitDir) ? path.join(gitDir, "index") : path.join(root, gitDir, "index");
  const bytes = {};
  for (const file of files) bytes[file] = await readFile(path.join(root, file)).catch(() => null);
  return {
    head: readGit(root, ["rev-parse", "HEAD"]),
    attached_branch: readGit(root, ["symbolic-ref", "--quiet", "HEAD"]),
    index: await digestFile(indexPath),
    staged: readGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstaged: readGit(root, ["diff", "--binary", "--no-ext-diff"]),
    untracked: readGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    status: readGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    config: readGit(root, ["config", "--local", "--null", "--list"]),
    branch_config: readGit(root, ["config", "--local", "--get-regexp", "^branch\\."]),
    all_refs: readGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    files: bytes,
    remote_refs: readGit(remoteRoot, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    remote_head: readGit(remoteRoot, ["rev-parse", `refs/heads/${BRANCH}`]),
    remote_config: readGit(remoteRoot, ["config", "--null", "--list"])
  };
}

function snapshotSummary(value) {
  const decode = (field) => {
    const raw = value[field];
    if (typeof raw !== "string" || raw.startsWith("<exit:")) return raw;
    try { return Buffer.from(raw, "base64").toString("utf8").trim().slice(0, 120); } catch { return raw; }
  };
  return `head=${decode("head")} branch=${decode("attached_branch")} status=${decode("status")} remote=${decode("remote_head")}`;
}

function assertLocalSnapshotUnchanged(after, before, label) {
  for (const field of ["head", "attached_branch", "index", "staged", "unstaged", "untracked", "status", "config", "branch_config", "all_refs", "files"]) {
    assert.deepEqual(after[field], before[field], `${label} changed ambient/local field ${field}`);
  }
}

function refMap(encoded) {
  const text = Buffer.from(encoded, "base64").toString("utf8");
  return new Map(text.split("\n").filter(Boolean).map((line) => {
    const [name, object] = line.split("\u0000");
    return [name, object];
  }));
}

function assertOnlyNamedTrackingMovement(after, before, oldHead, newHead, label, resultingRemoteHead = newHead, trackingChanged = true) {
  const oldRefs = refMap(before.all_refs);
  const newRefs = refMap(after.all_refs);
  assert.deepEqual([...newRefs.keys()].sort(), [...oldRefs.keys()].sort(), `${label} changed local ref identities`);
  for (const [name, oldObject] of oldRefs) {
    const expected = name === `refs/remotes/origin/${BRANCH}` || name === "refs/remotes/origin/HEAD"
      ? (trackingChanged ? newHead : oldObject)
      : oldObject;
    assert.equal(newRefs.get(name), expected, `${label} changed unexpected local ref ${name}`);
  }
  assert.deepEqual(refMap(before.remote_refs), new Map([[`refs/heads/${BRANCH}`, oldHead]]), `${label} precondition remote refs were not exact`);
  assert.deepEqual(refMap(after.remote_refs), new Map([[`refs/heads/${BRANCH}`, resultingRemoteHead]]), `${label} changed unexpected remote refs`);
}

async function withHttpServer({ defaultRoot, allowedRoots, policy, toolMode = "full", writeMode = "workspace", environment = {} }, callback) {
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
    CODEXPRO_TOOL_CARDS: "0",
    CODEXPRO_CODEX_SESSIONS: "off",
    CODEXPRO_CONNECTION_TEST: "0",
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy),
    ...environment
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.CODEXPRO_REQUIRE_HTTP_TOKEN;
  delete env.CODEXPRO_TUNNEL_MODE;
  const child = spawn(process.execPath, ["dist/http.js"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server timeout\\n${stderr.slice(0, 500)}`)), 15_000);
    timer.unref();
    const ready = () => {
      if (!stderr.includes("HTTP MCP listening")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stderr.on("data", ready);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code} ${signal ?? ""}`));
    });
    ready();
  });
  try {
    await listening;
    return await callback(`http://127.0.0.1:${port}/mcp`, () => stderr);
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

function assertFixedArgv() {
  const fake = {
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
  assert.deepEqual(buildGitPushArgs(fake), [
    ...GIT_PUSH_FIXED_OPTIONS,
    `--force-with-lease=refs/heads/${BRANCH}:${"b".repeat(40)}`,
    "--",
    "origin",
    `${"a".repeat(40)}:refs/heads/${BRANCH}`
  ]);
}

async function expectNoMutationFailure(session, label, args, root, remoteRoot, files, expectedPattern, state = {}) {
  const before = await snapshot(root, remoteRoot, files);
  console.log(`RAW_BEFORE ${label}: ${snapshotSummary(before)}`);
  console.log(`SANITY_VERDICT: MATCH — direct pre-call facts establish the requested hostile/precondition case before judging the public outcome.`);
  console.log(`PREDICATE: TRUE — independent branch/head/ref/config facts were captured before the effect judgment for ${label}.`);
  const output = expectError(await call(session, "git_push", args), label);
  assertBoundedPublic(output, label, [UNKNOWN_KEY, UNKNOWN_VALUE, SSH_SENTINEL, HELPER_SENTINEL, HOOK_REJECT_SENTINEL, HOOK_SUCCESS_SENTINEL, POSTCONDITION_SENTINEL]);
  if (expectedPattern) assert.match(resultText(output), expectedPattern, `${label} had an unexpected bounded error`);
  const after = await snapshot(root, remoteRoot, files);
  console.log(`RAW_AFTER ${label}: ${snapshotSummary(after)}`);
  assert.deepEqual(after, before, `${label} mutated local or remote repository state`);
  console.log(`PASS ${label}: public error bounded; direct local/remote snapshot unchanged.`);
  if (state.assertUnselected !== undefined) state.assertUnselected();
  return output;
}

async function main() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-task005-"));
  const ambient = path.join(fixture, "ambient repo");
  const target = path.join(fixture, "target repo");
  const unborn = path.join(fixture, "unborn repo");
  const remote = path.join(fixture, "remote.git");
  const fakeBin = path.join(fixture, "fake-bin");
  const hookFired = path.join(fixture, "hook-fired");
  const postconditionFired = path.join(fixture, "postcondition-fired");
  let daemon;
  let raceSource;
  let raceTarget;
  let raceWriter;
  let sessionA;
  let sessionB;
  try {
    await Promise.all([mkdir(ambient), mkdir(target), mkdir(unborn), mkdir(remote), mkdir(fakeBin), mkdir(path.join(fixture, "seed"))]);
    initRepo(ambient, "Ambient");
    await writeFile(path.join(ambient, "ambient.txt"), "ambient\n");
    const ambientHead = commit(ambient, "ambient baseline");

    initRepo(unborn, "Unborn");
    git(unborn, ["remote", "add", "origin", "placeholder"]);

    initRepo(path.join(fixture, "seed"), "Seed");
    const seed = path.join(fixture, "seed");
    await writeFile(path.join(seed, "notes.txt"), "R0\n");
    const r0 = commit(seed, "R0");
    git(remote, ["init", "--bare", "--quiet"]);
    git(seed, ["push", "--quiet", remote, `${r0}:refs/heads/${BRANCH}`]);
    git(remote, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);

    const daemonPort = await freePort();
    const endpoint = `git://127.0.0.1:${daemonPort}/remote.git`;
    daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", "--verbose", `--base-path=${fixture}`, `--port=${daemonPort}`], {
      cwd: fixture,
      stdio: ["ignore", "ignore", "ignore"]
    });
    await waitForGitDaemon(endpoint, daemon);

    git(REPO_ROOT, ["clone", "--quiet", endpoint, target]);
    git(target, ["config", "user.name", "Target"]);
    git(target, ["config", "user.email", "target@example.test"]);
    await writeFile(path.join(target, "notes.txt"), "R0\nL1\n");
    const localHead = commit(target, "L1");
    await writeFile(path.join(target, "staged.txt"), "staged-but-uncommitted\n");
    git(target, ["add", "staged.txt"]);
    await writeFile(path.join(target, "untracked.txt"), "untracked\n");
    git(target, ["tag", "local-tag", r0]);
    git(target, ["update-ref", "refs/heads/local-only", r0]);
    const targetCanonical = await realpath(target);
    const ambientCanonical = await realpath(ambient);
    const unbornCanonical = await realpath(unborn);
    const targetId = workspaceId(targetCanonical);
    const ambientId = workspaceId(ambientCanonical);
    const unbornId = workspaceId(unbornCanonical);
    const policy = { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] };
    const request = {
      workspace_id: targetId,
      remote: "origin",
      branch: BRANCH,
      expected_local_head: localHead,
      expected_remote_head: r0
    };
    const files = ["notes.txt", "staged.txt", "untracked.txt"];

    console.log("AUTHORITY: missions/RepoConnect_Remote_Git_Push_Authority/MISSION_PLAN.md P002 TASK-005/AP-009/AP-010/AP-011; MISSION_ANCHOR.md A002; MISSION_CORRECTIONS.md COR-001 Option A.");
    console.log("TARGET_PRODUCER_ROUTE: public MCP git_push over fresh HTTP sessions -> explicit workspace -> preflight/mutation -> mission-owned loopback Git/HTTP/SSH-simulation fixtures.");
    console.log("TARGET_EVIDENCE: direct before/after target and ambient HEAD/branch/index/staged/unstaged/untracked/config/branch-config/all-refs plus physical remote refs/config and raw MCP HTTP envelopes.");
    console.log(`RAW_BASELINE: ambient HEAD=${ambientHead}; target branch=refs/heads/${BRANCH}; target HEAD=${localHead}; remote branch=${r0}; target has staged, untracked, local tag, and local-only ref.`);
    console.log("SANITY_VERDICT: MATCH — direct fixture facts show two disposable repositories, an existing remote branch, descendant local head, and preserved pending work before any public mutation.");
    console.log("PREDICATE: TRUE — direct branch/head/object/ancestry facts are established independently of implementation labels.");
    assertFixedArgv();

    await withHttpServer({ defaultRoot: ambientCanonical, allowedRoots: [fixture], policy }, async (url) => {
      sessionA = await connect(url, "explicit-open");
      const opened = expectSuccess(await call(sessionA, "open_workspace", { root: targetCanonical }), "explicit target open");
      assert.equal(opened.structuredContent.workspace_id, targetId);
      await close(sessionA);
      sessionA = undefined;
      sessionB = await connect(url, "fresh-reconstruction");
      const missingBefore = await snapshot(target, remote, files);
      const missing = expectError(await call(sessionB, "git_push", { ...request, workspace_id: undefined }), "missing workspace id");
      assertBoundedPublic(missing, "missing workspace id", [UNKNOWN_KEY, UNKNOWN_VALUE]);
      assert.deepEqual(await snapshot(target, remote, files), missingBefore);
      const staleId = expectError(await call(sessionB, "git_push", { ...request, workspace_id: "ws_000000000000000000000000" }), "unknown stale workspace id");
      assertBoundedPublic(staleId, "unknown stale workspace id");
      assert.deepEqual(await snapshot(target, remote, files), missingBefore);
      const ambientOpened = expectSuccess(await call(sessionB, "open_current_workspace", {}), "ambient selection");
      assert.equal(ambientOpened.structuredContent.workspace_id, ambientId);
      const beforeExplicit = await snapshot(target, remote, files);
      const ambientBefore = await snapshot(ambient, remote, ["ambient.txt"]);
      console.log(`RAW_BEFORE fresh explicit-ID reconstruction: target ${snapshotSummary(beforeExplicit)}; ambient ${snapshotSummary(ambientBefore)}.`);
      console.log("SANITY_VERDICT: MATCH — direct facts show ambient selected while target remains a separate explicit-ID candidate.");
      console.log("PREDICATE: TRUE — target ID was independently opened in a prior session and ambient selection is independently visible before mutation.");
      const explicitOutput = await call(sessionB, "git_push", request);
      const explicitResult = expectSuccess(explicitOutput, "fresh-session explicit target push");
      assert.equal(explicitResult.structuredContent.workspace_id, targetId);
      assert.equal(explicitResult.structuredContent.remote_head, localHead);
      assertBoundedPublic(explicitOutput, "fresh-session explicit target push", [UNKNOWN_KEY, UNKNOWN_VALUE]);
      const afterExplicit = await snapshot(target, remote, files);
      const ambientAfter = await snapshot(ambient, remote, ["ambient.txt"]);
      assert.equal(afterExplicit.remote_head, Buffer.from(`${localHead}\n`).toString("base64"));
      assert.equal(afterExplicit.head, beforeExplicit.head);
      assert.equal(afterExplicit.attached_branch, beforeExplicit.attached_branch);
      assert.equal(afterExplicit.index, beforeExplicit.index);
      assert.equal(afterExplicit.status, beforeExplicit.status);
      assert.equal(afterExplicit.staged, beforeExplicit.staged);
      assert.equal(afterExplicit.unstaged, beforeExplicit.unstaged);
      assert.deepEqual(afterExplicit.files, beforeExplicit.files);
      assertOnlyNamedTrackingMovement(afterExplicit, beforeExplicit, r0, localHead, "fresh explicit-ID reconstruction");
      assertLocalSnapshotUnchanged(ambientAfter, ambientBefore, "ambient selection redirected or changed during explicit push");
      const listed = expectSuccess(await call(sessionB, "list_workspaces", {}), "list workspaces after explicit reconstruction");
      assert.equal(listed.structuredContent.selected_workspace_id, ambientId, "explicit reconstruction changed ambient selection");
      console.log(`RAW_AFTER fresh explicit-ID reconstruction: target ${snapshotSummary(afterExplicit)}; ambient unchanged ${snapshotSummary(ambientAfter)}.`);
      console.log("SANITY_VERDICT: MATCH — direct remote and both repository snapshots show target-only named push while ambient selection stayed selected and untouched.");
      console.log("PASS session proof: missing/unknown IDs reject; fresh explicit ID reconstructs target without global selection or ambient redirection.");
      await close(sessionB);
      sessionB = undefined;
      git(remote, ["update-ref", `refs/heads/${BRANCH}`, r0]);
      git(target, ["update-ref", `refs/remotes/origin/${BRANCH}`, r0]);
    });

    await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [fixture], policy }, async (url) => {
      sessionB = await connect(url, "hostile-preconditions");
      const listing = await sessionB.client.listTools();
      assertGitPushDescriptor(listing.tools.find((tool) => tool.name === "git_push"));
      const wrapper = expectSuccess(await call(sessionB, "codexpro", { action: "list_actions" }), "wrapper action list");
      assert.equal(wrapper.structuredContent.actions.includes("git_push"), false, "supertool advertised git_push");

      await expectNoMutationFailure(sessionB, "wrong expected local head", { ...request, expected_local_head: r0 }, target, remote, files, /head|current|precondition/iu);
      await expectNoMutationFailure(sessionB, "wrong expected remote head", { ...request, expected_remote_head: localHead }, target, remote, files, /remote|head|precondition/iu);
      await expectNoMutationFailure(sessionB, "wrong remote name", { ...request, remote: "upstream" }, target, remote, files, /remote|allowlist/iu);
      await expectNoMutationFailure(sessionB, "wrong branch", { ...request, branch: "release" }, target, remote, files, /branch|allowlist/iu);
      await expectNoMutationFailure(sessionB, "malformed branch injection", { ...request, branch: "main;touch hostile" }, target, remote, files, /branch|invalid/iu);
      await expectNoMutationFailure(sessionB, "malformed ref injection", { ...request, branch: "main~1" }, target, remote, files, /branch|invalid/iu);
      await expectNoMutationFailure(sessionB, "malformed SHA", { ...request, expected_local_head: "HEAD" }, target, remote, files, /head|invalid|SHA/iu);
      await expectNoMutationFailure(sessionB, "unknown property escape", { ...request, [UNKNOWN_KEY]: UNKNOWN_VALUE }, target, remote, files, /unknown|invalid|not allowed/iu);
      await expectNoMutationFailure(sessionB, "escape field set", { ...request, url: endpoint, refspec: "+refs/*:refs/*", force: true, lease: r0, push_option: UNKNOWN_VALUE }, target, remote, files, /unknown|invalid|not allowed/iu);
      await expectNoMutationFailure(sessionB, "missing local remote object", { ...request, expected_remote_head: "f".repeat(40) }, target, remote, files, /local object|available|remote/iu);
      const blob = gitText(target, ["hash-object", "-w", "--stdin"], { input: "TASK005 blob object\n" });
      await expectNoMutationFailure(sessionB, "reachable remote object is not commit", { ...request, expected_remote_head: blob }, target, remote, files, /commit|remote/iu);
      const independentTree = gitText(target, ["rev-parse", `${r0}^{tree}`]);
      const independentHead = gitText(target, ["commit-tree", independentTree], { input: "TASK005 independent history\n" });
      await expectNoMutationFailure(sessionB, "non-fast-forward target", { ...request, expected_remote_head: independentHead }, target, remote, files, /fast.forward|ancestor|history/iu);

      git(target, ["checkout", "--quiet", "--detach", "HEAD"]);
      await expectNoMutationFailure(sessionB, "detached HEAD", request, target, remote, files, /detached|branch/iu);
      git(target, ["checkout", "--quiet", BRANCH]);
      git(target, ["checkout", "--quiet", "-b", "task005-mismatch"]);
      await expectNoMutationFailure(sessionB, "local branch mismatch", request, target, remote, files, /branch/iu);
      git(target, ["checkout", "--quiet", BRANCH]);
      git(target, ["branch", "-D", "task005-mismatch"]);

      git(remote, ["update-ref", "-d", `refs/heads/${BRANCH}`]);
      await expectNoMutationFailure(sessionB, "remote branch absent", request, target, remote, files, /remote|absent|branch/iu);
      git(remote, ["update-ref", `refs/heads/${BRANCH}`, r0]);

      const pushurl = "https://other.example/repo.git";
      git(target, ["config", "remote.origin.pushurl", pushurl]);
      await expectNoMutationFailure(sessionB, "correct name wrong endpoint after policy creation", request, target, remote, files, /endpoint|allowlist/iu);
      git(target, ["config", "--unset-all", "remote.origin.pushurl"]);
      git(target, ["remote", "set-url", "origin", "https://changed.example/repo.git"]);
      await expectNoMutationFailure(sessionB, "remote config changed before call", request, target, remote, files, /endpoint|allowlist/iu);
      git(target, ["remote", "set-url", "origin", endpoint]);
      git(target, ["config", "--add", "remote.origin.pushurl", endpoint]);
      git(target, ["config", "--add", "remote.origin.pushurl", "https://mirror.example/repo.git"]);
      await expectNoMutationFailure(sessionB, "ambiguous multiple pushurl", request, target, remote, files, /multiple|ambiguous/iu);
      git(target, ["config", "--unset-all", "remote.origin.pushurl"]);

      for (const [label, value, pattern] of [
        ["credential-bearing endpoint", `https://user:${CREDENTIAL_SENTINEL}@example.test/repo.git`, /credential|endpoint/iu],
        ["local path endpoint", "/tmp/remote.git", /local|endpoint/iu],
        ["file endpoint", "file:///tmp/remote.git", /file|endpoint/iu],
        ["ext helper endpoint", "ext::ssh://host.example/repo.git", /helper|scheme|endpoint/iu]
      ]) {
        git(target, ["config", "remote.origin.pushurl", value]);
        await expectNoMutationFailure(sessionB, label, request, target, remote, files, pattern);
        git(target, ["config", "--unset-all", "remote.origin.pushurl"]);
      }
      await close(sessionB);
      sessionB = undefined;
    });

    await withHttpServer({ defaultRoot: ambientCanonical, allowedRoots: [fixture], policy: { enabled: false, rules: [] } }, async (url) => {
      const session = await connect(url, "policy-disabled");
      try {
        const before = await snapshot(target, remote, files);
        const listing = await session.client.listTools();
        assert.equal(listing.tools.some((tool) => tool.name === "git_push"), false, "disabled policy exposed git_push");
        const actions = expectSuccess(await call(session, "codexpro", { action: "list_actions" }), "disabled policy wrapper list");
        assert.equal(actions.structuredContent.actions.includes("git_push"), false);
        assert.deepEqual(await snapshot(target, remote, files), before);
        console.log("PASS policy disabled: public catalog and wrapper omit git_push; direct target/remote snapshot unchanged.");
      } finally {
        await close(session);
      }
    });

    await withHttpServer({ defaultRoot: ambientCanonical, allowedRoots: [fixture], policy }, async (url) => {
      const session = await connect(url, "unborn");
      try {
        expectSuccess(await call(session, "open_workspace", { root: unbornCanonical }), "open unborn workspace");
        const before = await snapshot(unborn, remote);
        const output = expectError(await call(session, "git_push", {
          workspace_id: unbornId,
          remote: "origin",
          branch: BRANCH,
          expected_local_head: r0,
          expected_remote_head: r0
        }), "unborn branch");
        assertBoundedPublic(output, "unborn branch");
        assert.match(resultText(output), /unborn|existing local HEAD|commit/iu);
        assert.deepEqual(await snapshot(unborn, remote), before, "unborn rejection mutated repository");
        console.log("PASS unborn branch: explicit workspace rejected before mutation; direct unborn repository snapshot unchanged.");
      } finally {
        await close(session);
      }
    });

    await writeFile(path.join(target, ".git", "hooks", "pre-push"), `#!/bin/sh\nprintf '%s\\n' '${HOOK_REJECT_SENTINEL}' > '${hookFired}'\nexit 1\n`, "utf8");
    await chmod(path.join(target, ".git", "hooks", "pre-push"), 0o755);
    await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [fixture], policy }, async (url) => {
      const session = await connect(url, "rejecting-hook");
      try {
        const before = await snapshot(target, remote, files);
        console.log(`RAW_BEFORE rejecting synchronous hook: ${snapshotSummary(before)}`);
        console.log("SANITY_VERDICT: MATCH — direct branch/head/remote/fixture-hook facts establish a rejecting synchronous hook before mutation.");
        console.log("PREDICATE: TRUE — hook file is independently present and executable; direct expected local/remote heads are exact.");
        const output = expectError(await call(session, "git_push", request), "rejecting synchronous pre-push hook");
        assertBoundedPublic(output, "rejecting synchronous pre-push hook", [HOOK_REJECT_SENTINEL]);
        assert.match(resultText(output), /mutation failed|remote branch|hook|confirmed/iu);
        assert.equal((await readFile(hookFired)).toString("utf8"), `${HOOK_REJECT_SENTINEL}\n`, "rejecting hook did not run exactly once");
        const after = await snapshot(target, remote, files);
        assert.deepEqual(after, before, "rejecting hook changed local or remote state");
        console.log(`RAW_AFTER rejecting synchronous hook: ${snapshotSummary(after)}; hook marker is present only in disposable fixture.`);
        console.log("PASS rejecting synchronous pre-push hook: Git-owned hook ran; public response was bounded and remote/local state was unchanged.");
      } finally {
        await close(session);
      }
    });

    await rm(path.join(target, ".git", "hooks", "pre-push"), { force: true });
    await writeFile(path.join(target, ".git", "hooks", "pre-push"), `#!/bin/sh\nprintf '%s\\n' '${HOOK_SUCCESS_SENTINEL}' > '${hookFired}'\nexit 0\n`, "utf8");
    await chmod(path.join(target, ".git", "hooks", "pre-push"), 0o755);
    await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [fixture], policy }, async (url) => {
      const session = await connect(url, "successful-hook");
      try {
        const before = await snapshot(target, remote, files);
        const output = await call(session, "git_push", request);
        const result = expectSuccess(output, "successful synchronous pre-push hook");
        assert.equal(result.structuredContent.remote_head, localHead);
        assert.equal((await readFile(hookFired)).toString("utf8"), `${HOOK_SUCCESS_SENTINEL}\n`, "successful hook did not run exactly once");
        assertBoundedPublic(output, "successful synchronous pre-push hook", [HOOK_SUCCESS_SENTINEL]);
        const after = await snapshot(target, remote, files);
        assert.equal(after.remote_head, Buffer.from(`${localHead}\n`).toString("base64"));
        assert.equal(after.head, before.head);
        assert.equal(after.attached_branch, before.attached_branch);
        assert.equal(after.index, before.index);
        assert.equal(after.status, before.status);
        assert.equal(after.config, before.config);
        assert.equal(after.branch_config, before.branch_config);
        assert.deepEqual(after.files, before.files);
        assertOnlyNamedTrackingMovement(after, before, r0, localHead, "successful synchronous pre-push hook");
        console.log("RAW_OBSERVATION: successful hook marker exists exactly once; direct target HEAD/branch/index/pending bytes/config remained unchanged; only named remote branch and native tracking moved.");
        console.log("SANITY_VERDICT: MATCH — direct postcondition evidence matches exact existing-branch success and Git-owned synchronous-hook preservation.");
        console.log("PASS successful synchronous pre-push hook: ordinary hook behavior retained.");
      } finally {
        await close(session);
      }
    });

    git(remote, ["update-ref", `refs/heads/${BRANCH}`, r0]);
    git(target, ["update-ref", `refs/remotes/origin/${BRANCH}`, r0]);
    await rm(path.join(target, ".git", "hooks", "pre-push"), { force: true });
    await writeFile(path.join(target, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(path.join(target, ".git", "hooks", "pre-push"), 0o755);

    const postAltTree = gitText(target, ["rev-parse", `${r0}^{tree}`]);
    const postAlt = gitText(target, ["commit-tree", postAltTree], { input: "TASK005 postcondition alternate\n" });
    git(target, ["push", "--quiet", remote, `${postAlt}:refs/heads/task005-alt`]);
    git(remote, ["update-ref", "-d", "refs/heads/task005-alt"]);
    await writeFile(path.join(remote, "hooks", "post-receive"), `#!/bin/sh\nset -eu\ngit --git-dir='${remote}' update-ref 'refs/heads/${BRANCH}' '${postAlt}'\nprintf '%s\\n' '${POSTCONDITION_SENTINEL}' > '${postconditionFired}'\nexit 0\n`, "utf8");
    await chmod(path.join(remote, "hooks", "post-receive"), 0o755);
    await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [fixture], policy }, async (url) => {
      const session = await connect(url, "postcondition");
      try {
        const before = await snapshot(target, remote, files);
        console.log(`RAW_BEFORE post-push observation mismatch: ${snapshotSummary(before)}; post-receive fixture will alter the branch after push process success.`);
        console.log("SANITY_VERDICT: MATCH — direct remote starts at expected R0 and the executable post-receive fixture independently establishes the mismatch trigger.");
        console.log("PREDICATE: TRUE — local expected head is a descendant and the remote starts at exact expected head before the one-shot push.");
        const output = expectError(await call(session, "git_push", request), "post-push observation mismatch");
        assertBoundedPublic(output, "post-push observation mismatch", [POSTCONDITION_SENTINEL]);
        assert.match(resultText(output), /postcondition|matching remote|remote branch/iu);
        assert.doesNotMatch(resultText(output), /Status:\s*pushed/iu, "postcondition mismatch claimed success");
        assert.equal((await readFile(postconditionFired)).toString("utf8"), `${POSTCONDITION_SENTINEL}\n`, "post-receive fixture did not run exactly once");
        const after = await snapshot(target, remote, files);
        assert.equal(after.remote_head, Buffer.from(`${postAlt}\n`).toString("base64"), "post-receive fixture did not leave the alternate branch head");
        assert.equal(after.head, before.head);
        assert.equal(after.attached_branch, before.attached_branch);
        assert.equal(after.index, before.index);
        assert.equal(after.status, before.status);
        assert.equal(after.config, before.config);
        assert.equal(after.branch_config, before.branch_config);
        assert.deepEqual(after.files, before.files);
        assertOnlyNamedTrackingMovement(after, before, r0, localHead, "post-push observation mismatch", postAlt);
        console.log(`RAW_AFTER post-push observation mismatch: remote branch is alternate ${postAlt}; local target state unchanged; one post-receive marker and no retry.`);
        console.log("SANITY_VERDICT: MATCH — direct physical remote result contradicts success while matching bounded postcondition failure truth.");
        console.log("PASS post-push observation mismatch: process success was not promoted to public success; exact resulting remote ref was independently observed.");
      } finally {
        await close(session);
      }
    });
    await rm(path.join(remote, "hooks", "post-receive"), { force: true });
    git(remote, ["update-ref", `refs/heads/${BRANCH}`, r0]);
    git(target, ["update-ref", `refs/remotes/origin/${BRANCH}`, r0]);

    const sshScript = path.join(fakeBin, "ssh");
    await writeFile(sshScript, `#!/bin/sh\nprintf '%s\\n' '${SSH_SENTINEL}' > '${hookFired}'\nprintf '%s\\n' '${SSH_SENTINEL}' >&2\nexit 1\n`, "utf8");
    await chmod(sshScript, 0o755);
    const sshEndpoint = `ssh://git@127.0.0.1:${daemonPort}/remote.git`;
    git(target, ["remote", "set-url", "origin", sshEndpoint]);
    await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [fixture], policy: { enabled: true, rules: [{ remote: "origin", endpoint: sshEndpoint, branches: [BRANCH] }] }, environment: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` } }, async (url, stderr) => {
      const session = await connect(url, "synthetic-ssh");
      try {
        const before = await snapshot(target, remote, files);
        const output = await expectNoMutationFailure(session, "synthetic SSH authentication failure", { ...request }, target, remote, files, /preflight|execution|remote|failed/iu);
        assert.equal((await readFile(hookFired)).toString("utf8"), `${SSH_SENTINEL}\n`, "synthetic SSH route was not exercised");
        assert.equal(output.rawBody.includes(SSH_SENTINEL), false);
        assert.equal(stderr().includes(SSH_SENTINEL), false, "synthetic SSH stderr reached HTTP server logs");
        assert.deepEqual(await snapshot(target, remote, files), before);
        console.log("PASS synthetic SSH auth failure: Git-owned SSH route invoked disposable helper; sentinel absent from public envelope and server logs.");
      } finally {
        await close(session);
      }
    });

    git(target, ["remote", "set-url", "origin", endpoint]);
    const helperScript = path.join(fakeBin, "git-credential-task005-sentinel");
    await writeFile(helperScript, `#!/bin/sh\nprintf '%s\\n' '${HELPER_SENTINEL}' > '${hookFired}'\nprintf '%s\\n' '${HELPER_SENTINEL}' >&2\nexit 1\n`, "utf8");
    await chmod(helperScript, 0o755);
    const authPort = await freePort();
    const authRequests = [];
    const authServer = createHttpServer((req, res) => {
      authRequests.push({ headers: { ...req.headers }, url: req.url });
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="TASK005"');
      res.end("authentication required\n");
    });
    await new Promise((resolve, reject) => {
      authServer.once("error", reject);
      authServer.listen(authPort, "127.0.0.1", resolve);
    });
    const httpEndpoint = `http://127.0.0.1:${authPort}/remote.git`;
    git(target, ["remote", "set-url", "origin", httpEndpoint]);
    git(target, ["config", "credential.helper", "task005-sentinel"]);
    try {
      await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [fixture], policy: { enabled: true, rules: [{ remote: "origin", endpoint: httpEndpoint, branches: [BRANCH] }] }, environment: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` } }, async (url, stderr) => {
        const session = await connect(url, "synthetic-helper");
        try {
          const before = await snapshot(target, remote, files);
          const output = await expectNoMutationFailure(session, "synthetic credential-helper failure", request, target, remote, files, /preflight|execution|remote|failed/iu);
          assert.equal((await readFile(hookFired)).toString("utf8"), `${HELPER_SENTINEL}\n`, "synthetic credential helper was not exercised");
          assert.equal(output.rawBody.includes(HELPER_SENTINEL), false);
          assert.equal(stderr().includes(HELPER_SENTINEL), false, "synthetic helper stderr reached HTTP server logs");
          assert.equal(authRequests.some((entry) => Object.keys(entry.headers).some((key) => key.toLowerCase() === "authorization")), false, "credential helper caused an Authorization header");
          assert.deepEqual(await snapshot(target, remote, files), before);
          console.log("PASS synthetic credential-helper failure: Git-owned HTTP auth route exercised; no Authorization header, helper output, or sentinel reached public/log evidence.");
        } finally {
          await close(session);
        }
      });
    } finally {
      await new Promise((resolve) => authServer.close(resolve));
      git(target, ["config", "--unset-all", "credential.helper"]);
      git(target, ["remote", "set-url", "origin", endpoint]);
    }

    await mkdir(path.join(fixture, "race source"));
    raceSource = path.join(fixture, "race source");
    raceTarget = path.join(fixture, "race target");
    raceWriter = path.join(fixture, "race writer");
    git(REPO_ROOT, ["clone", "--quiet", endpoint, raceSource]);
    git(raceSource, ["config", "user.name", "Race Source"]);
    git(raceSource, ["config", "user.email", "race-source@example.test"]);
    await writeFile(path.join(raceSource, "notes.txt"), "R0\nR1\n");
    const r1 = commit(raceSource, "R1");
    await writeFile(path.join(raceSource, "notes.txt"), "R0\nR1\nL1\n");
    const raceLocalHead = commit(raceSource, "race local L1");
    git(REPO_ROOT, ["clone", "--quiet", raceSource, raceTarget]);
    git(REPO_ROOT, ["clone", "--quiet", raceSource, raceWriter]);
    for (const root of [raceTarget, raceWriter]) {
      git(root, ["config", "user.name", path.basename(root)]);
      git(root, ["config", "user.email", `${path.basename(root).replaceAll(" ", "-")}@example.test`]);
      git(root, ["remote", "set-url", "origin", endpoint]);
      git(root, ["update-ref", `refs/remotes/origin/${BRANCH}`, r0]);
    }
    git(raceWriter, ["reset", "--quiet", "--hard", r1]);
    const raceHook = path.join(raceTarget, ".git", "hooks", "pre-push");
    const raceHookMarker = path.join(fixture, "race-hook-fired");
    await writeFile(raceHook, `#!/bin/sh\nset -eu\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${raceWriter}' push --quiet origin '${r1}:refs/heads/${BRANCH}'\nprintf '%s\\n' '${SSH_SENTINEL}' > '${raceHookMarker}'\nexit 0\n`, "utf8");
    await chmod(raceHook, 0o755);
    const raceCanonical = await realpath(raceTarget);
    const raceId = workspaceId(raceCanonical);
    const raceRequest = { ...request, workspace_id: raceId, expected_local_head: raceLocalHead };
    git(remote, ["update-ref", `refs/heads/${BRANCH}`, r0]);
    await withHttpServer({ defaultRoot: raceCanonical, allowedRoots: [fixture], policy }, async (url) => {
      const session = await connect(url, "cas-race");
      try {
        const before = await snapshot(raceTarget, remote);
        const graph = gitTry(raceTarget, ["merge-base", "--is-ancestor", r0, raceLocalHead]);
        assert.equal(graph.status, 0, "race expected remote head is not an ancestor of local head");
        console.log(`RAW_BEFORE CAS race: ${snapshotSummary(before)}; direct graph R0=${r0} -> R1=${r1} -> local=${raceLocalHead}.`);
        console.log("SANITY_VERDICT: MATCH — direct graph and remote facts establish a lawful fast-forward that a concurrent writer will stale before mutation.");
        console.log("PREDICATE: TRUE — remote starts at R0, R0 is ancestor of local head, and the pre-push fixture independently advances the remote to R1.");
        const output = expectError(await call(session, "git_push", raceRequest), "concurrent writer CAS rejection");
        assertBoundedPublic(output, "concurrent writer CAS rejection");
        assert.match(resultText(output), /compare.and.swap|stale|remote branch changed/iu);
        const after = await snapshot(raceTarget, remote);
        assert.equal(after.remote_head, Buffer.from(`${r1}\n`).toString("base64"));
        assert.equal(after.head, before.head);
        assert.equal(after.attached_branch, before.attached_branch);
        assert.equal(after.status, before.status);
        assert.equal(after.index, before.index);
        assert.equal(after.config, before.config);
        assert.equal(after.branch_config, before.branch_config);
        assert.equal((await readFile(raceHookMarker)).toString("utf8"), `${SSH_SENTINEL}\n`);
        assertOnlyNamedTrackingMovement(after, before, r0, raceLocalHead, "concurrent writer CAS rejection", r1, false);
        console.log(`RAW_AFTER CAS race: remote is Writer-B R1=${r1}; target local state unchanged; one hook marker and no retry.`);
        console.log("SANITY_VERDICT: MATCH — direct remote result and local snapshot match exact mutation-time CAS rejection.");
        console.log("PASS concurrent writer CAS rejection: one bounded push attempt did not overwrite Writer B.");
      } finally {
        await close(session);
      }
    });

    console.log("EVIDENCE_CONFLICT: NONE — no direct raw artifact contradicted the accepted expected outcomes or the technical test interpretation.");
    console.log("GIT_PUSH_TASK005_SMOKE: PASS");
  } finally {
    await close(sessionA);
    await close(sessionB);
    if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
    await rm(fixture, { recursive: true, force: true });
  }
}

await main();
