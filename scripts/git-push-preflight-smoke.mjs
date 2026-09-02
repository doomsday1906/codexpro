import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { GitPushPreflightError, preflightGitPush } from "../dist/gitPushPreflight.js";

const SECRET = "PREFLIGHT_CREDENTIAL_SENTINEL_7X9";
const repoRoot = path.resolve(".");

function runGit(cwd, args, options = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input: options.input,
    env: options.env,
    maxBuffer: 256 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git command failed (${args.join(" ")}): ${result.stderr || result.stdout || result.error?.message || result.status}`);
  }
  return String(result.stdout ?? "").trim();
}

function tryGit(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port > 0, "failed to reserve loopback port");
  return port;
}

async function waitForDaemon(url, daemon, daemonStderr) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = spawnSync("git", ["ls-remote", url, "refs/heads/main"], { encoding: "utf8", timeout: 1_000 });
    if (result.status === 0 && String(result.stdout ?? "").includes("\trefs/heads/main\n")) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`loopback git daemon did not become observable (exit=${daemon.exitCode}, stderr=${daemonStderr})`);
}

function workspaceId(root) {
  return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

function currentIndexPath(root) {
  const gitDir = runGit(root, ["rev-parse", "--git-dir"]);
  return path.resolve(root, gitDir, "index");
}

async function fileDigest(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function commandOutput(cwd, args) {
  const result = tryGit(cwd, args);
  if (result.status !== 0) return `<exit:${result.status}>${result.stderr}`;
  return result.stdout;
}

async function snapshot(root, remoteRoot) {
  return {
    head: commandOutput(root, ["rev-parse", "--verify", "HEAD"]),
    branch: commandOutput(root, ["symbolic-ref", "--quiet", "HEAD"]),
    status: commandOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    staged: commandOutput(root, ["diff", "--cached", "--binary"]),
    unstaged: commandOutput(root, ["diff", "--binary"]),
    untracked: commandOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
    local_config: commandOutput(root, ["config", "--local", "--null", "--list"]),
    branch_config: commandOutput(root, ["config", "--local", "--get-regexp", "^branch\\."]),
    local_refs: commandOutput(root, ["for-each-ref", "--format=%(refname)=%(objectname)"]),
    index: await fileDigest(currentIndexPath(root)),
    remote_refs: commandOutput(remoteRoot, ["for-each-ref", "--format=%(refname)=%(objectname)"]),
    remote_config: commandOutput(remoteRoot, ["config", "--null", "--list"])
  };
}

function configFor(endpoint, branches = ["main"]) {
  return {
    maxGitTimeoutMs: 10_000,
    maxOutputBytes: 16_384,
    toolMode: "full",
    writeMode: "workspace",
    gitPushPolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches }] }
  };
}

async function withEnvironment(values, callback) {
  const before = new Map();
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-preflight-"));
  const isolatedHome = path.join(fixture, "home");
  const priorHome = process.env.HOME;
  const priorXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const remoteRoot = path.join(fixture, "remote.git");
  const workRoot = path.join(fixture, "work");
  const missingIncludePath = path.join(fixture, "missing-include-target.conf");
  let daemon;
  try {
    await fs.mkdir(isolatedHome);
    process.env.HOME = isolatedHome;
    delete process.env.XDG_CONFIG_HOME;
    await fs.mkdir(workRoot);
    runGit(fixture, ["init", "--bare", remoteRoot]);
    runGit(workRoot, ["init", "--initial-branch=main"]);
    runGit(workRoot, ["config", "user.name", "Preflight Fixture"]);
    runGit(workRoot, ["config", "user.email", "preflight@example.invalid"]);
    await fs.writeFile(path.join(workRoot, "notes.txt"), "base\n");
    await fs.writeFile(path.join(workRoot, "staged.txt"), "staged-base\n");
    runGit(workRoot, ["add", "notes.txt", "staged.txt"]);
    runGit(workRoot, ["commit", "--message", "fixture base"]);
    const initialHead = runGit(workRoot, ["rev-parse", "HEAD"]);
    runGit(workRoot, ["push", `file://${remoteRoot}`, "HEAD:refs/heads/main"]);

    const port = await reservePort();
    const endpoint = `git://127.0.0.1:${port}/remote.git`;
    daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--verbose", `--base-path=${fixture}`, `--port=${port}`], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let daemonStderr = "";
    daemon.stderr.on("data", (chunk) => { daemonStderr += String(chunk); });
    await waitForDaemon(endpoint, daemon, daemonStderr);

    runGit(workRoot, ["remote", "add", "origin", endpoint]);
    await fs.writeFile(path.join(workRoot, "notes.txt"), "base\nlocal descendant\n");
    runGit(workRoot, ["commit", "--all", "--message", "fixture descendant"]);
    const localHead = runGit(workRoot, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workRoot, "staged.txt"), "staged-change\n");
    runGit(workRoot, ["add", "staged.txt"]);
    await fs.writeFile(path.join(workRoot, "untracked.txt"), "untracked-change\n");

    const workspace = { id: workspaceId(workRoot), root: workRoot, openedAt: new Date().toISOString() };
    const request = {
      workspace_id: workspace.id,
      remote: "origin",
      branch: "main",
      expected_local_head: localHead,
      expected_remote_head: initialHead
    };
    const config = configFor(endpoint);

    async function expectFailure(label, input, reason, expectedConfig = config) {
      const before = await snapshot(workRoot, remoteRoot);
      let error;
      try {
        await preflightGitPush(expectedConfig, workspace, input);
        assert.fail(`${label} unexpectedly succeeded`);
      } catch (candidateError) {
        error = candidateError;
      }
      assert.ok(error instanceof GitPushPreflightError, `${label} did not return the bounded preflight error class`);
      assert.equal(error.reason, reason, `${label} returned an unexpected reason`);
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes(SECRET), false, `${label} leaked credential sentinel`);
      const after = await snapshot(workRoot, remoteRoot);
      assert.deepEqual(after, before, `${label} mutated local or remote repository state`);
      console.log(`PASS ${label}: ${reason}; direct local/remote snapshot unchanged`);
    }

    const beforeSuccess = await snapshot(workRoot, remoteRoot);
    const success = await preflightGitPush(config, workspace, request);
    const afterSuccess = await snapshot(workRoot, remoteRoot);
    assert.deepEqual(afterSuccess, beforeSuccess, "successful preflight mutated repository state");
    const { config_sources: configSources, ...successFacts } = success;
    assert.deepEqual(successFacts, {
      schema_version: 1,
      workspace_id: workspace.id,
      root: workRoot,
      git_dir: path.join(workRoot, ".git"),
      config_path: path.join(workRoot, ".git", "config"),
      object_format: "sha1",
      remote: "origin",
      endpoint,
      branch: "main",
      source_ref: "refs/heads/main",
      destination_ref: "refs/heads/main",
      expected_local_head: localHead,
      expected_remote_head: initialHead
    }, "successful preflight returned unexpected source/destination facts");
    assert.ok(configSources.includes(path.join(isolatedHome, ".gitconfig")), "preflight omitted the writable global target");
    assert.ok(configSources.includes(path.join(isolatedHome, ".config", "git", "config")), "preflight omitted the XDG global target");
    assert.ok(configSources.includes(path.join(workRoot, ".git", "config")), "preflight omitted the repository config source");
    assert.ok(configSources.includes(path.join(workRoot, ".git", "config.worktree")), "preflight omitted the exact config.worktree target");
    if (process.platform !== "win32") {
      // Git 2.43 exposes the system target through `git var GIT_CONFIG_SYSTEM`; this
      // environment's ordinary user cannot write it, so no native lock is
      // required for that source. The assertion reads metadata only.
      assert.equal(configSources.includes("/etc/gitconfig"), true, "preflight omitted the Git var system target");
      let systemWritable = false;
      try {
        await fs.access("/etc/gitconfig", fsConstants.W_OK);
        systemWritable = true;
      } catch {
        // Missing or read-only system config is both non-writable for this
        // invocation and safe to leave outside the cooperative lock set.
      }
      assert.equal(systemWritable, false, "test environment unexpectedly made the system config writable");
    }
    runGit(workRoot, ["config", "--local", "include.path", missingIncludePath]);
    const missingIncludePreflight = await preflightGitPush(config, workspace, request);
    assert.equal(missingIncludePreflight.config_sources.includes(missingIncludePath), true, "preflight omitted the configured missing include target");
    runGit(workRoot, ["config", "--local", "--unset-all", "include.path"]);
    console.log("PASS success preflight: exact local head, local remote commit, ancestry, policy, and loopback ls-remote matched");

    await expectFailure("wrong expected local head", { ...request, expected_local_head: initialHead }, "head-mismatch");
    await expectFailure("wrong expected remote head", { ...request, expected_remote_head: localHead }, "remote-head-mismatch");
    await expectFailure("malformed branch", { ...request, branch: "main;touch hostile" }, "invalid-remote-or-branch");
    await expectFailure("malformed SHA", { ...request, expected_local_head: "HEAD" }, "invalid-head");
    await expectFailure("unknown workspace id", { ...request, workspace_id: "ws_000000000000000000000000" }, "workspace");
    await expectFailure("full mode required", { ...request }, "mode", { ...config, toolMode: "standard" });
    await expectFailure("workspace write required", { ...request }, "write-mode", { ...config, writeMode: "off" });
    await expectFailure("policy disabled", { ...request }, "policy-disabled", { ...config, gitPushPolicy: { enabled: false, rules: [] } });
    await expectFailure("wrong remote tuple", { ...request, remote: "other" }, "remote-or-branch-not-allowlisted");
    await expectFailure("wrong branch policy tuple", { ...request }, "remote-or-branch-not-allowlisted", configFor(endpoint, ["release"]));

    await fs.writeFile(path.join(workRoot, ".git", "MERGE_HEAD"), `${initialHead}\n`);
    await expectFailure("active history operation", request, "in-progress");
    await fs.rm(path.join(workRoot, ".git", "MERGE_HEAD"));

    runGit(workRoot, ["checkout", "--detach", "--quiet", "HEAD"]);
    await expectFailure("detached HEAD", request, "detached");
    runGit(workRoot, ["checkout", "--quiet", "main"]);

    runGit(workRoot, ["checkout", "-b", "release"]);
    await expectFailure("attached branch mismatch", request, "branch-mismatch");
    runGit(workRoot, ["checkout", "--quiet", "main"]);
    runGit(workRoot, ["checkout", "--quiet", "release"]);
    await expectFailure("remote branch absent", { ...request, branch: "release" }, "remote-absent", configFor(endpoint, ["release"]));
    runGit(workRoot, ["checkout", "--quiet", "main"]);

    const missingRemoteHead = "f".repeat(40);
    await expectFailure("expected remote object missing locally", { ...request, expected_remote_head: missingRemoteHead }, "missing-remote-object");
    const blobHead = runGit(workRoot, ["hash-object", "-w", "--stdin"], { input: "not a commit\n" });
    await expectFailure("expected remote object is not a commit", { ...request, expected_remote_head: blobHead }, "remote-object-not-commit");

    runGit(workRoot, ["checkout", "-b", "independent"]);
    await fs.writeFile(path.join(workRoot, "independent.txt"), "independent\n");
    runGit(workRoot, ["add", "independent.txt"]);
    runGit(workRoot, ["commit", "--message", "independent history"]);
    const independentHead = runGit(workRoot, ["rev-parse", "HEAD"]);
    runGit(workRoot, ["checkout", "--quiet", "main"]);
    await expectFailure("non-fast-forward ancestry", { ...request, expected_remote_head: independentHead }, "non-fast-forward");

    runGit(workRoot, ["config", "remote.origin.pushurl", "https://other.example/repo.git"]);
    await expectFailure("endpoint substitution", request, "effective-endpoint-not-allowlisted");
    runGit(workRoot, ["config", "--unset-all", "remote.origin.pushurl"]);
    runGit(workRoot, ["config", "--add", "remote.origin.pushurl", endpoint]);
    runGit(workRoot, ["config", "--add", "remote.origin.pushurl", "https://mirror.example/repo.git"]);
    await expectFailure("multiple effective push URLs", request, "ambiguous-multiple-effective-push-endpoints");
    runGit(workRoot, ["config", "--unset-all", "remote.origin.pushurl"]);
    const credentialEndpoint = `https://user:${SECRET}@github.example/repo.git`;
    runGit(workRoot, ["config", "remote.origin.pushurl", credentialEndpoint]);
    await expectFailure("credential-bearing endpoint", request, "credential-bearing-endpoint");
    runGit(workRoot, ["config", "--unset-all", "remote.origin.pushurl"]);

    const alternate = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-preflight-ambient-"));
    try {
      runGit(alternate, ["init", "--quiet"]);
      const hostileConfig = path.join(alternate, "hostile.gitconfig");
      await fs.writeFile(hostileConfig, `[remote "origin"]\n\tpushurl = https://user:${SECRET}@hostile.example/repo.git\n`);
      const ambientBefore = await snapshot(workRoot, remoteRoot);
      let ambientSuccess;
      await withEnvironment({
        GIT_DIR: path.join(alternate, ".git"),
        GIT_WORK_TREE: alternate,
        GIT_CONFIG_GLOBAL: hostileConfig,
        GIT_CONFIG_SYSTEM: hostileConfig,
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_OBJECT_DIRECTORY: path.join(alternate, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(alternate, "objects"),
        GIT_TRACE: path.join(alternate, "trace-sentinel"),
        GIT_SSH_COMMAND: `sh -c 'touch ${path.join(alternate, "ssh-sentinel")}'`,
        GIT_ASKPASS: path.join(alternate, "askpass-sentinel"),
        GIT_PROXY_COMMAND: path.join(alternate, "proxy-sentinel")
      }, async () => {
        ambientSuccess = await preflightGitPush(config, workspace, request);
      });
      const ambientAfter = await snapshot(workRoot, remoteRoot);
      assert.deepEqual(ambientAfter, ambientBefore, "sealed ambient Git controls changed repository state");
      assert.equal(ambientSuccess.expected_remote_head, initialHead);
      assert.equal((await fs.stat(path.join(alternate, "ssh-sentinel")).catch(() => null)), null, "ambient SSH command was invoked");
      console.log("PASS sealed ambient Git controls: target repository/config and endpoint survived hostile GIT_* values");
    } finally {
      await fs.rm(alternate, { recursive: true, force: true });
    }

    const invalidEndpointConfig = configFor(endpoint);
    runGit(workRoot, ["config", "remote.origin.pushurl", `https://user:${SECRET}@github.example/repo.git`]);
    await expectFailure("bounded credential error", request, "credential-bearing-endpoint", invalidEndpointConfig);
    runGit(workRoot, ["config", "--unset-all", "remote.origin.pushurl"]);

    runGit(workRoot, ["checkout", "--orphan", "unborn"]);
    runGit(workRoot, ["rm", "-rf", "--ignore-unmatch", "."]);
    await expectFailure("unborn branch", { ...request, branch: "unborn" }, "unborn", configFor(endpoint, ["unborn"]));
    runGit(workRoot, ["checkout", "--quiet", "-f", "main"]);

    const finalSnapshot = await snapshot(workRoot, remoteRoot);
    assert.equal(finalSnapshot.head.trim(), localHead, "fixture restoration changed local HEAD");
    assert.equal(finalSnapshot.branch, "refs/heads/main\n", "fixture restoration changed local branch");
    assert.equal(finalSnapshot.remote_refs, `refs/heads/main=${initialHead}\n`, "fixture restoration changed remote refs");
    console.log("RAW_OBSERVATION: actual loopback git daemon ls-remote observed one existing refs/heads/main at the expected SHA; every accepted rejection left direct HEAD/branch/index/staged/unstaged/untracked/local-config/all-local-refs/bare-remote-config/all-remote-refs snapshots byte-identical.");
    console.log("SANITY_VERDICT: MATCH — the direct preflight result and physical before/after repository evidence match TASK-003/AP-006 local, remote, policy, and nonmutation requirements.");
    console.log("PREDICATE: TRUE — direct current branch/HEAD, local commit object, ancestry, configured policy endpoint, and independent loopback remote observation were each established before success was judged.");
  } finally {
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise((resolve) => daemon.once("close", resolve));
    }
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorXdgConfigHome;
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

await main();
