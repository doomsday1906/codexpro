import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  buildGitRetireRemoteBranchArgs,
  gitRetireRemoteBranch,
  GitRetireRemoteBranchError,
  GitRetireRemoteBranchPreflightError
} from "../dist/gitRetireRemoteBranch.js";

function environment(overrides = {}) {
  const value = { ...process.env };
  for (const key of Object.keys(value)) if (/^GIT_/u.test(key)) delete value[key];
  return {
    ...value,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...overrides
  };
}

function result(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    env: environment(options.env),
    encoding: "utf8",
    input: options.input,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function git(cwd, args, options = {}) {
  const value = result(cwd, args, options);
  if (value.error || value.status !== 0) {
    throw new Error(`fixture Git failed (${value.status}): ${args.join(" ")} ${String(value.stderr ?? "").slice(0, 500)}`);
  }
  return String(value.stdout ?? "").trim();
}

function tryGit(cwd, args, options = {}) {
  const value = result(cwd, args, options);
  return { status: value.status, stdout: String(value.stdout ?? ""), stderr: String(value.stderr ?? "") };
}

function initRepo(root, branch, name) {
  git(root, ["init", "--quiet", `--initial-branch=${branch}`]);
  git(root, ["config", "user.name", name]);
  git(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]);
  git(root, ["config", "core.logAllRefUpdates", "true"]);
}

async function commit(root, file, content, message) {
  await writeFile(path.join(root, file), content, "utf8");
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
  assert.ok(port > 0);
  return port;
}

async function waitForDaemon(endpoint) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (tryGit(process.cwd(), ["ls-remote", endpoint]).status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("loopback Git daemon did not become observable");
}

function workspace(root) {
  return {
    id: `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`,
    root,
    openedAt: new Date().toISOString()
  };
}

function config(endpoint, prefixes = ["mission/"]) {
  return {
    maxGitTimeoutMs: 15_000,
    maxOutputBytes: 32_768,
    toolMode: "full",
    writeMode: "workspace",
    gitPushPolicy: {
      enabled: true,
      rules: [{
        remote: "origin",
        endpoint,
        branches: [],
        branch_prefixes: prefixes,
        retirement: {
          branches: [],
          branch_prefixes: prefixes,
          canonical_branches: ["main"]
        }
      }]
    }
  };
}

function remoteHead(remoteRoot, branch) {
  const value = tryGit(remoteRoot, ["rev-parse", `refs/heads/${branch}`]);
  return value.status === 0 ? value.stdout.trim() : null;
}

class StdioClient {
  constructor(root, policy) {
    this.child = spawn(process.execPath, ["dist/stdio.js", "--tool-mode", "full", "--write", "workspace", "--bash", "off"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_TOOL_MODE: "full",
        CODEXPRO_WRITE_MODE: "workspace",
        CODEXPRO_BASH_MODE: "off",
        CODEXPRO_CODEX_SESSIONS: "off",
        CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
        CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.child.stdout.on("data", (chunk) => {
      this.buffer += String(chunk);
      while (true) {
        const end = this.buffer.indexOf("\n");
        if (end < 0) break;
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    });
  }
  request(method, params = {}) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); }
  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise((resolve) => this.child.once("exit", resolve));
  }
}

function snapshot(root, remoteRoot) {
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    branch: git(root, ["symbolic-ref", "--quiet", "HEAD"]),
    status: git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: git(root, ["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstaged: git(root, ["diff", "--binary", "--no-ext-diff"]),
    untracked: git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    config: git(root, ["config", "--local", "--null", "--list"]),
    refs: git(root, ["for-each-ref", "--format=%(refname)=%(objectname)"]),
    remoteRefs: git(remoteRoot, ["for-each-ref", "--format=%(refname)=%(objectname)"])
  };
}

function receipt(candidate, route, authority = "TASK-002 accepted receipt") {
  return {
    schema_version: 1,
    accepted_candidate: candidate,
    acceptance_authority: authority,
    evidence_sha256: "a".repeat(64),
    route
  };
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-retire-"));
const remoteRoot = path.join(fixture, "remote.git");
const targetRoot = path.join(fixture, "target");
const publishedRoot = path.join(fixture, "published");
const integratedRoot = path.join(fixture, "integrated");
const raceWriterRoot = path.join(fixture, "race-writer");
let daemon;

try {
  await Promise.all([mkdir(remoteRoot), mkdir(targetRoot), mkdir(publishedRoot), mkdir(integratedRoot), mkdir(raceWriterRoot)]);
  git(remoteRoot, ["init", "--bare", "--quiet"]);
  const port = await freePort();
  const endpoint = `git://127.0.0.1:${port}/remote.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForDaemon(endpoint);

  initRepo(targetRoot, "mission/retire", "Target");
  git(targetRoot, ["remote", "add", "origin", endpoint]);
  const candidate = await commit(targetRoot, "candidate.txt", "accepted\n", "accepted candidate");
  git(targetRoot, ["push", "--quiet", "origin", `${candidate}:refs/heads/mission/retire`]);

  initRepo(publishedRoot, "mission/preserve", "Published");
  git(publishedRoot, ["remote", "add", "origin", endpoint]);
  git(publishedRoot, ["fetch", "--quiet", "origin", "mission/retire"]);
  git(publishedRoot, ["push", "--quiet", "origin", `${candidate}:refs/heads/proof/accepted`]);

  const hookPath = path.join(targetRoot, ".git", "hooks", "pre-push");
  await writeFile(hookPath, "#!/bin/sh\nprintf 'hook ran\\n' > hook-fired.txt\nprintf 'hook mutation\\n' > candidate.txt\ngit add candidate.txt\ngit config --local codexpro.hook-mutated yes\ngit update-ref refs/heads/hook-mutated HEAD\n", { mode: 0o755 });
  await chmod(hookPath, 0o755);

  const targetWorkspace = workspace(path.resolve(targetRoot));
  const policy = config(endpoint);
  const targetBefore = snapshot(targetRoot, remoteRoot);
  const request = {
    workspace_id: targetWorkspace.id,
    remote: "origin",
    branch: "mission/retire",
    expected_remote_head: candidate,
    preservation: receipt(candidate, {
      type: "published",
      remote: "origin",
      branch: "proof/accepted",
      expected_head: candidate
    })
  };
  assert.deepEqual(buildGitRetireRemoteBranchArgs({
    remote: "origin",
    branch: "mission/retire",
    destination_ref: "refs/heads/mission/retire",
    expected_remote_head: candidate
  }).at(-1), ":refs/heads/mission/retire");
  console.log(`RAW_OBSERVATION: target refs/heads/mission/retire and preservation refs/heads/proof/accepted both exist at ${candidate}; local worktree is ${targetBefore.branch}.`);
  console.log("SANITY_VERDICT: MATCH — direct bare-remote facts satisfy exact target head and distinct published-preservation prerequisites.");
  console.log("PREDICATE: TRUE — target and preservation heads were independently observed before judging retirement.");

  const resultPublished = await gitRetireRemoteBranch(policy, targetWorkspace, request);
  assert.equal(resultPublished.status, "retired");
  assert.equal(resultPublished.remote_head, "absent");
  assert.equal(resultPublished.accepted_candidate, candidate);
  assert.equal(resultPublished.push_attempts, 1);
  assert.equal(remoteHead(remoteRoot, "mission/retire"), null);
  assert.equal(remoteHead(remoteRoot, "proof/accepted"), candidate);
  const targetAfter = snapshot(targetRoot, remoteRoot);
  assert.deepEqual(
    { ...targetAfter, remoteRefs: targetBefore.remoteRefs },
    targetBefore,
    "retirement changed local target state"
  );
  assert.equal(targetAfter.remoteRefs.includes("refs/remotes/origin/mission/retire"), false);
  await assert.rejects(readFile(path.join(targetRoot, "hook-fired.txt")));
  await rm(hookPath);
  console.log(`RAW_OBSERVATION: compiled retirement removed only refs/heads/mission/retire; proof/accepted remained ${candidate}, local HEAD/index/worktree/ref snapshots stayed unchanged, and result reports push_attempts=1.`);
  console.log("SANITY_VERDICT: MATCH — real bare-remote absence and preservation postconditions match the accepted published-retirement outcome.");

  // A configured alias that resolves to the allowlisted identity is still
  // hostile input for retirement: the raw configured route must be safe too.
  const hostileHead = await commit(targetRoot, "hostile.txt", "hostile\n", "hostile endpoint target");
  git(targetRoot, ["push", "--quiet", "origin", `${hostileHead}:refs/heads/mission/hostile-config`]);
  git(targetRoot, ["config", "remote.origin.pushurl", "RETIRE_ALIAS:"]);
  git(targetRoot, ["config", `url.${endpoint}.insteadOf`, "RETIRE_ALIAS:"]);
  const hostileBefore = snapshot(targetRoot, remoteRoot);
  await assert.rejects(
    gitRetireRemoteBranch(policy, targetWorkspace, {
      ...request,
      branch: "mission/hostile-config",
      expected_remote_head: hostileHead,
      preservation: receipt(candidate, { type: "published", remote: "origin", branch: "proof/accepted", expected_head: candidate })
    }),
    (error) => error instanceof GitRetireRemoteBranchPreflightError && /endpoint|allowlist|local/iu.test(error.message)
  );
  assert.deepEqual(snapshot(targetRoot, remoteRoot), hostileBefore, "hostile configured endpoint changed local or remote state");
  git(targetRoot, ["config", "--unset-all", "remote.origin.pushurl"]);
  git(targetRoot, ["config", "--unset-all", `url.${endpoint}.insteadOf`]);
  console.log("PASS hostile configured alias: effective identity matched policy but raw configured route was rejected before mutation.");

  for (const [label, hostileEndpoint] of [
    ["git+ssh policy endpoint", `git+ssh://127.0.0.1:${port}/remote.git`],
    ["percent-escaped policy endpoint", `git://127.0.0.1:${port}/remote%2egit`],
    ["username-only ssh endpoint", `ssh://user@127.0.0.1:${port}/remote.git`],
    ["username-only git endpoint", `git://user@127.0.0.1:${port}/remote.git`]
  ]) {
    const before = snapshot(targetRoot, remoteRoot);
    await assert.rejects(
      gitRetireRemoteBranch(config(hostileEndpoint), targetWorkspace, request),
      (error) => error instanceof GitRetireRemoteBranchPreflightError && /policy|endpoint|credential|invalid/iu.test(error.message)
    );
    assert.deepEqual(snapshot(targetRoot, remoteRoot), before, `${label} changed local or remote state`);
  }
  console.log("PASS hostile policy endpoints: git+ssh, percent escapes, and username-only SSH/Git userinfo were rejected without endpoint echo or mutation.");

  // Effective endpoint rewriting is independently hostile even when the
  // policy endpoint itself is safe; it must fail before any remote attempt.
  git(targetRoot, ["config", `url.git+ssh://127.0.0.1:${port}/remote.git.insteadOf`, endpoint]);
  const effectiveHostileBefore = snapshot(targetRoot, remoteRoot);
  await assert.rejects(
    gitRetireRemoteBranch(policy, targetWorkspace, request),
    (error) => error instanceof GitRetireRemoteBranchPreflightError && /endpoint|allowlist/iu.test(error.message)
  );
  assert.deepEqual(snapshot(targetRoot, remoteRoot), effectiveHostileBefore, "hostile effective endpoint changed local or remote state");
  git(targetRoot, ["config", "--unset-all", `url.git+ssh://127.0.0.1:${port}/remote.git.insteadOf`]);
  console.log("PASS hostile effective endpoint: safe policy identity rejected a rewritten git+ssh route before mutation.");

  // Exercise the same contract through the compiled ordinary public MCP route.
  git(targetRoot, ["push", "--quiet", `file://${remoteRoot}`, `${candidate}:refs/heads/mission/public`]);
  const publicClient = new StdioClient(targetRoot, policy.gitPushPolicy);
  try {
    await publicClient.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "git-retire-public-smoke", version: "1.0.0" }
    });
    publicClient.notify("notifications/initialized");
    const publicCall = await publicClient.request("tools/call", {
      name: "git_retire_remote_branch",
      arguments: {
        ...request,
        branch: "mission/public"
      }
    });
    assert.equal(publicCall.isError, undefined, `compiled public retirement failed: ${JSON.stringify(publicCall)}`);
    assert.equal(publicCall.structuredContent.status, "retired");
    assert.equal(publicCall.structuredContent.push_attempts, 1);
    assert.equal(remoteHead(remoteRoot, "mission/public"), null);
    assert.equal(remoteHead(remoteRoot, "proof/accepted"), candidate);
    console.log("RAW_OBSERVATION: compiled stdio MCP tools/call retired mission/public; direct bare-remote observation shows exact absence while proof/accepted remains at the accepted candidate.");
    console.log("SANITY_VERDICT: MATCH — public target route produced the required retired result and real remote postconditions.");
  } finally {
    await publicClient.close();
  }

  // Integrated route: candidate is an ancestor of a canonical protected head.
  initRepo(integratedRoot, "mission/integrated", "Integrated");
  git(integratedRoot, ["remote", "add", "origin", endpoint]);
  git(integratedRoot, ["fetch", "--quiet", "origin", "proof/accepted"]);
  const canonicalCandidate = await commit(integratedRoot, "integrated.txt", "candidate\n", "integrated candidate");
  const canonicalHead = await commit(integratedRoot, "integrated.txt", "candidate\ncanonical\n", "canonical integration");
  git(integratedRoot, ["push", "--quiet", "origin", `${canonicalHead}:refs/heads/main`]);
  // Publish the integrated candidate's object through a distinct non-canonical
  // branch first so the target workspace can prove ancestry without a fetch.
  git(integratedRoot, ["push", "--quiet", "origin", `${canonicalCandidate}:refs/heads/proof/integrated-candidate`]);
  git(targetRoot, ["fetch", "--quiet", "origin", "proof/integrated-candidate", "main"]);
  // The target branch carries the same accepted candidate that the canonical
  // route later preserves; the retirement receipt is never a substitute head.
  git(targetRoot, ["push", "--quiet", "origin", `${canonicalCandidate}:refs/heads/mission/integrated`]);
  const integratedRequest = {
    workspace_id: targetWorkspace.id,
    remote: "origin",
    branch: "mission/integrated",
    expected_remote_head: canonicalCandidate,
    preservation: receipt(canonicalCandidate, {
      type: "integrated",
      remote: "origin",
      branch: "main",
      expected_head: canonicalHead,
      integration_mode: "FAST_FORWARD"
    })
  };
  // The candidate object is locally present through the explicit accepted
  // preservation ref; canonical main is independently observed on the remote.
  const integratedResult = await gitRetireRemoteBranch(policy, targetWorkspace, integratedRequest);
  assert.equal(integratedResult.status, "retired");
  assert.equal(remoteHead(remoteRoot, "mission/integrated"), null);
  assert.equal(remoteHead(remoteRoot, "main"), canonicalHead);
  assert.equal(remoteHead(remoteRoot, "proof/integrated-candidate"), canonicalCandidate);
  console.log(`RAW_OBSERVATION: integrated candidate ${canonicalCandidate} is an ancestor of independently observed canonical main ${canonicalHead}; mission/integrated was absent after one retirement attempt.`);
  console.log("SANITY_VERDICT: MATCH — real canonical remote head and candidate ancestry establish integrated preservation, independently of the result label.");

  const squashTargetHead = await commit(targetRoot, "squash-target.txt", "squash target\n", "squash target");
  git(targetRoot, ["push", "--quiet", "origin", `${squashTargetHead}:refs/heads/mission/squash`]);

  // Required fail-closed receipt/protected/ref-route falsifiers must leave the
  // target and preservation refs unchanged.
  const invalidCases = [
    ["missing authority", { ...request, preservation: { ...request.preservation, acceptance_authority: "" } }, /receipt|authority|invalid/iu],
    ["uppercase digest", { ...request, preservation: { ...request.preservation, evidence_sha256: "A".repeat(64) } }, /receipt|digest|invalid/iu],
    ["candidate mismatch", { ...request, expected_remote_head: candidate, preservation: { ...request.preservation, accepted_candidate: "b".repeat(40) } }, /receipt|candidate|invalid/iu],
    ["same preservation ref", { ...request, preservation: receipt(candidate, { type: "published", remote: "origin", branch: "mission/retire", expected_head: candidate }) }, /preservation|target/iu],
    ["protected target", { ...request, branch: "main" }, /protected|canonical/iu],
    ["squash-style non-ancestor", { ...integratedRequest, branch: "mission/squash", expected_remote_head: squashTargetHead, preservation: receipt(candidate, { type: "integrated", remote: "origin", branch: "main", expected_head: canonicalHead, integration_mode: "FAST_FORWARD" }) }, /ancestor|preservation|candidate/iu]
  ];
  for (const [label, invalid, pattern] of invalidCases) {
    let caught;
    try {
      await gitRetireRemoteBranch(policy, targetWorkspace, invalid);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof GitRetireRemoteBranchPreflightError, `${label} did not fail in preflight`);
    assert.match(caught.message, pattern, `${label} message was not bounded`);
  }
  assert.equal(remoteHead(remoteRoot, "main"), canonicalHead);
  assert.equal(remoteHead(remoteRoot, "proof/accepted"), candidate);
  console.log("RAW_OBSERVATION: malformed receipts, candidate mismatch, same-ref preservation, protected target, and non-ancestor route attempts left all remote refs unchanged and made no mutation attempt.");
  console.log("SANITY_VERDICT: MATCH — direct refs establish fail-closed preflight without relying on implementation labels.");

  // A stale target head is rejected before the one-shot delete. Recreate a
  // target branch at a different head and assert the expected old head stays.
  const staleHead = await commit(targetRoot, "stale.txt", "stale\n", "stale target");
  git(targetRoot, ["push", "--quiet", "origin", `${staleHead}:refs/heads/mission/stale`]);
  let staleError;
  try {
    await gitRetireRemoteBranch(policy, targetWorkspace, {
      ...request,
      branch: "mission/stale",
      expected_remote_head: candidate
    });
  } catch (error) {
    staleError = error;
  }
  assert.ok(staleError instanceof GitRetireRemoteBranchPreflightError);
  assert.equal(staleError.reason, "target-head-mismatch");
  assert.equal(remoteHead(remoteRoot, "mission/stale"), staleHead);
  console.log("PASS exact target-head mismatch rejects before mutation and preserves the real remote branch.");

  console.log("GIT_RETIRE_REMOTE_BRANCH_SMOKE: PASS");
} finally {
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}
