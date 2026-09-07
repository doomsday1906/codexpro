import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gitPush, GitPushError, buildGitPushArgs } from "../dist/gitPush.js";
import { normalizeGitPushPolicy } from "../dist/gitPushPolicy.js";

function fixtureEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^GIT_/u.test(key)) delete environment[key];
  }
  return {
    ...environment,
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
    env: fixtureEnvironment(options.env),
    encoding: "utf8",
    input: options.input,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function git(cwd, args, options = {}) {
  const result = gitResult(cwd, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(`fixture Git failed (${result.status}): ${args.join(" ")} ${String(result.stderr ?? "").slice(0, 500)}`);
  }
  return String(result.stdout ?? "").trim();
}

function tryGit(cwd, args, options = {}) {
  const result = gitResult(cwd, args, options);
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function initRepo(root, branch, name) {
  git(root, ["init", "--quiet", `--initial-branch=${branch}`]);
  git(root, ["config", "user.name", name]);
  git(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]);
  git(root, ["config", "core.logAllRefUpdates", "true"]);
}

async function commit(root, relativePath, content, message) {
  await writeFile(path.join(root, relativePath), content, "utf8");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", message]);
  return git(root, ["rev-parse", "HEAD"]);
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

async function waitForGitDaemon(endpoint, daemon) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = tryGit(process.cwd(), ["ls-remote", endpoint]);
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`loopback Git daemon did not become observable (exit=${daemon.exitCode})`);
}

function workspaceId(root) {
  return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

function workspace(root) {
  return { id: workspaceId(root), root, openedAt: new Date().toISOString() };
}

function config(endpoint, prefixes = ["mission/"]) {
  return {
    maxGitTimeoutMs: 15_000,
    maxOutputBytes: 32_768,
    toolMode: "full",
    writeMode: "workspace",
    gitPushPolicy: {
      enabled: true,
      rules: [{ remote: "origin", endpoint, branches: [], branch_prefixes: prefixes }]
    }
  };
}

function branchHead(root, branch) {
  const result = tryGit(root, ["rev-parse", `refs/heads/${branch}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function remoteHead(remoteRoot, branch) {
  return branchHead(remoteRoot, branch);
}

async function repositorySnapshot(root, remoteRoot, branch, files = []) {
  const tracked = {};
  for (const file of files) tracked[file] = await readFile(path.join(root, file)).catch(() => null);
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    branch: git(root, ["symbolic-ref", "--quiet", "HEAD"]),
    status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: git(root, ["diff", "--cached", "--binary"]),
    unstaged: git(root, ["diff", "--binary"]),
    refs: git(root, ["for-each-ref", "--format=%(refname)=%(objectname)"]),
    remoteRefs: git(remoteRoot, ["for-each-ref", "--format=%(refname)=%(objectname)"]),
    tracked
  };
}

function assertAbsentFirstLease() {
  const branch = "mission/demo";
  const args = buildGitPushArgs({
    schema_version: 1,
    workspace_id: "ws_000000000000000000000000",
    root: "/tmp/target",
    git_dir: "/tmp/target/.git",
    config_path: "/tmp/target/.git/config",
    config_sources: [],
    object_format: "sha1",
    remote: "origin",
    endpoint: "git://127.0.0.1:1/remote.git",
    branch,
    source_ref: `refs/heads/${branch}`,
    destination_ref: `refs/heads/${branch}`,
    expected_local_head: "a".repeat(40),
    expected_remote_head: "absent"
  });
  assert.ok(args.includes(`--force-with-lease=refs/heads/${branch}:`), "absence-CAS did not use Git's empty expected value");
  assert.equal(args.some((arg) => arg === "--force" || arg.startsWith("--force=")), false, "unrestricted force was exposed");
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-absence-"));
const remoteRoot = path.join(fixture, "remote.git");
const targetRoot = path.join(fixture, "target");
const writerRoot = path.join(fixture, "writer");
const raceTargetRoot = path.join(fixture, "race-target");
const raceWriterRoot = path.join(fixture, "race-writer");
const raceHookPath = path.join(raceTargetRoot, ".git", "hooks", "pre-push");
const raceHookFired = path.join(fixture, "race-hook-fired");
let daemon;

try {
  await Promise.all([
    mkdir(remoteRoot, { recursive: true }),
    mkdir(targetRoot, { recursive: true }),
    mkdir(writerRoot, { recursive: true }),
    mkdir(raceTargetRoot, { recursive: true }),
    mkdir(raceWriterRoot, { recursive: true })
  ]);
  git(remoteRoot, ["init", "--bare", "--quiet"]);

  const port = await freePort();
  const endpoint = `git://127.0.0.1:${port}/remote.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForGitDaemon(endpoint, daemon);

  const branch = "mission/demo";
  initRepo(targetRoot, branch, "Absence Target");
  git(targetRoot, ["remote", "add", "origin", endpoint]);
  const localHead = await commit(targetRoot, "notes.txt", "R0\n", "first publication");
  await writeFile(path.join(targetRoot, "pending.txt"), "pending\n", "utf8");
  git(targetRoot, ["add", "pending.txt"]);
  await writeFile(path.join(targetRoot, "untracked.txt"), "untracked\n", "utf8");
  const canonicalTarget = path.resolve(targetRoot);
  const targetWorkspace = workspace(canonicalTarget);
  const firstRequest = {
    workspace_id: targetWorkspace.id,
    remote: "origin",
    branch,
    expected_local_head: localHead,
    expected_remote_head: "absent"
  };
  const policy = config(endpoint);
  const before = await repositorySnapshot(canonicalTarget, remoteRoot, branch, ["notes.txt", "pending.txt", "untracked.txt"]);
  assert.equal(remoteHead(remoteRoot, branch), null, "first-publication target branch was not independently absent");
  console.log(`RAW_OBSERVATION: before first publication, local ${branch} is ${localHead}, the real bare remote has no ${branch}, and staged/untracked bytes are present.`);
  console.log("SANITY_VERDICT: MATCH — direct local/bare-remote facts satisfy the accepted absence-CAS precondition.");
  console.log("PREDICATE: TRUE — independent branch/head/remote observations establish the absence predicate before judging the effect.");

  const firstResult = await gitPush(policy, targetWorkspace, firstRequest);
  assert.equal(firstResult.expected_remote_head, "absent");
  assert.equal(firstResult.remote_head, localHead);
  assert.equal(firstResult.push_attempts, 1);
  assert.equal(remoteHead(remoteRoot, branch), localHead, "first publication did not create exact local head");
  const after = await repositorySnapshot(canonicalTarget, remoteRoot, branch, ["notes.txt", "pending.txt", "untracked.txt"]);
  assert.deepEqual(after, { ...before, refs: after.refs, remoteRefs: after.remoteRefs }, "first publication changed local pending/worktree bytes");
  assert.equal(after.head, before.head);
  assert.equal(after.branch, before.branch);
  assert.equal(after.status, before.status);
  assert.equal(after.staged, before.staged);
  assert.equal(after.unstaged, before.unstaged);
  assert.deepEqual(after.tracked, before.tracked);
  console.log(`RAW_OBSERVATION: first publication created only refs/heads/${branch} at ${localHead}; local branch, pending bytes, and worktree files stayed unchanged; result reports push_attempts=1.`);
  console.log("SANITY_VERDICT: MATCH — compiled gitPush success and direct bare-remote postcondition match absence-CAS semantics.");

  // Existing branch retains exact-head fast-forward semantics.
  const expectedExistingHead = localHead;
  const nextHead = await commit(canonicalTarget, "notes.txt", "R0\nR1\n", "fast-forward update");
  const existingResult = await gitPush(policy, targetWorkspace, {
    ...firstRequest,
    expected_local_head: nextHead,
    expected_remote_head: expectedExistingHead
  });
  assert.equal(existingResult.expected_remote_head, expectedExistingHead);
  assert.equal(existingResult.remote_head, nextHead);
  assert.equal(existingResult.push_attempts, 1);
  assert.equal(remoteHead(remoteRoot, branch), nextHead);
  console.log(`RAW_OBSERVATION: existing ${branch} advanced from ${expectedExistingHead} to descendant ${nextHead} with one exact-head CAS push.`);
  console.log("SANITY_VERDICT: MATCH — direct local graph and bare-remote head match retained fast-forward behavior.");

  // A pre-push hook creates the absent branch from an independent writer after
  // mutation begins. The empty lease must reject the target update closed.
  const raceBranch = "mission/race";
  initRepo(raceWriterRoot, "mission/writer", "Race Writer");
  git(raceWriterRoot, ["remote", "add", "origin", endpoint]);
  const writerHead = await commit(raceWriterRoot, "writer.txt", "writer\n", "concurrent writer");
  initRepo(raceTargetRoot, raceBranch, "Race Target");
  git(raceTargetRoot, ["remote", "add", "origin", endpoint]);
  const raceLocalHead = await commit(raceTargetRoot, "race.txt", "target\n", "race target");
  await writeFile(raceHookPath, `#!/bin/sh\nset -eu\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\ngit -C '${raceWriterRoot}' push --quiet origin '${writerHead}:refs/heads/${raceBranch}'\nprintf '%s\\n' race >> '${raceHookFired}'\n`, "utf8");
  await chmod(raceHookPath, 0o755);
  const raceWorkspace = workspace(path.resolve(raceTargetRoot));
  assert.equal(remoteHead(remoteRoot, raceBranch), null);
  const raceBefore = await repositorySnapshot(raceTargetRoot, remoteRoot, raceBranch);
  console.log(`RAW_OBSERVATION: before concurrent-create falsifier, ${raceBranch} is absent on the real bare remote and an independent writer can create ${writerHead} during the target pre-push hook.`);
  console.log("SANITY_VERDICT: MATCH — the independent writer establishes the race predicate without using implementation labels.");
  console.log("PREDICATE: TRUE — the target absence and independent writer commit are directly observed before evaluating CAS failure.");
  let raceError;
  try {
    await gitPush(config(endpoint), raceWorkspace, {
      workspace_id: raceWorkspace.id,
      remote: "origin",
      branch: raceBranch,
      expected_local_head: raceLocalHead,
      expected_remote_head: "absent"
    });
  } catch (error) {
    raceError = error;
  }
  assert.ok(raceError instanceof GitPushError, "concurrent create did not fail with bounded GitPushError");
  assert.equal(raceError.reason, "cas-stale", `concurrent create returned ${raceError.reason}`);
  assert.equal(remoteHead(remoteRoot, raceBranch), writerHead, "concurrent writer head was not preserved");
  const raceAfter = await repositorySnapshot(raceTargetRoot, remoteRoot, raceBranch);
  for (const field of ["head", "branch", "status", "staged", "unstaged", "refs", "tracked"]) {
    assert.deepEqual(raceAfter[field], raceBefore[field], `stale absence-CAS changed target ${field}`);
  }
  assert.equal((await readFile(raceHookFired)).toString(), "race\n", "mutation attempted more than once or hook did not run once");
  console.log(`RAW_OBSERVATION: independent writer won ${raceBranch} at ${writerHead}; target local state stayed unchanged and compiled gitPush returned one stale-CAS failure after one mutation attempt.`);
  console.log("SANITY_VERDICT: MATCH — direct remote/local evidence rejects any claim that the target overwrote a concurrently created ref.");

  assertAbsentFirstLease();
  const normalized = normalizeGitPushPolicy({ enabled: true, rules: [{ remote: "origin", endpoint, branches: [], branch_prefixes: ["mission/", "aw/", "proof/"] }] });
  assert.deepEqual(normalized.rules[0].branch_prefixes, ["mission/", "aw/", "proof/"]);
  for (const invalid of [
    ["empty", { enabled: true, rules: [{ remote: "origin", endpoint, branch_prefixes: [""] }] }],
    ["glob", { enabled: true, rules: [{ remote: "origin", endpoint, branch_prefixes: ["mission/*"] }] }],
    ["regex", { enabled: true, rules: [{ remote: "origin", endpoint, branch_prefixes: ["^mission/.*"] }] }],
    ["refspec", { enabled: true, rules: [{ remote: "origin", endpoint, branch_prefixes: ["+mission/"] }] }],
    ["protected", { enabled: true, rules: [{ remote: "origin", endpoint, branch_prefixes: ["main/"] }] }],
    ["overlap", { enabled: true, rules: [{ remote: "origin", endpoint, branch_prefixes: ["mission/", "mission/release/"] }] }]
  ]) {
    assert.throws(() => normalizeGitPushPolicy(invalid[1]), Error, `${invalid[0]} branch prefix was accepted`);
  }
  console.log("RAW_OBSERVATION: literal mission/, aw/, and proof/ prefixes normalize; empty, glob, regex, refspec, protected, and overlapping prefixes are rejected before endpoint matching.");
  console.log("SANITY_VERDICT: MATCH — direct normalized policy facts match deterministic explicit-prefix semantics.");
  console.log("GIT_PUSH_ABSENCE_SMOKE: PASS");
} finally {
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}
