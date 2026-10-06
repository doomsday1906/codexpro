import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, readFile, rm, realpath, chmod } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const BRANCH = "main";

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/u.test(key)) delete env[key];
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
    input: options.input,
    env: cleanEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function git(cwd, args, options = {}) {
  const r = gitResult(cwd, args, options);
  if (r.error || r.status !== 0) {
    throw new Error(`fixture git failed (${r.status}): ${args.join(" ")} ${Buffer.from(r.stderr ?? "").toString("utf8").slice(0, 500)}`);
  }
  return Buffer.from(r.stdout ?? "");
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

function commitAll(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", message]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function workspaceIdForRoot(root) {
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
  assert.ok(port > 0);
  return port;
}

async function waitForDaemon(url, daemon) {
  for (let i = 0; i < 120; i++) {
    const r = gitResult(path.resolve("."), ["ls-remote", url, `refs/heads/${BRANCH}`]);
    if (r.status === 0 && String(r.stdout ?? "").endsWith(`\trefs/heads/${BRANCH}\n`)) return;
    await new Promise((r2) => setTimeout(r2, 25));
  }
  throw new Error("daemon not observable");
}

function expectPromoteError(promise, expectedReason) {
  return promise.then(
    () => { throw new Error(`expected GitPromoteError(${expectedReason}) but succeeded`); },
    (e) => {
      assert.equal(e.name === "GitPromotePreflightError" || e.name === "GitPromoteError", true, `wrong error ${e?.name}: ${e?.message}`);
      assert.equal(e.reason, expectedReason, `wrong reason ${e.reason}, message ${e.message}`);
      assert.ok(!String(e.message).includes("HOSTILE"), "leaked");
      return e;
    }
  );
}

function expectPushError(promise, expectedReason) {
  return promise.then(
    () => { throw new Error(`expected GitPushError(${expectedReason}) but succeeded`); },
    (e) => {
      assert.equal(e.reason, expectedReason, `wrong push reason ${e.reason}`);
      return e;
    }
  );
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-promote-"));
let daemon;
try {
  const { gitPromote, buildGitPromoteArgs } = await import("../dist/gitPromote.js");
  const { gitPush } = await import("../dist/gitPush.js");
  const { evaluateGitPromotePolicy } = await import("../dist/gitPromotePolicy.js");

  // Daemon serving fixture dir
  const port = await freePort();
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  const endpointFor = (bareName) => `git://127.0.0.1:${port}/${bareName}`;

  // ---- P1 happy path ----
  {
    const bareName = "remote-p1.git";
    const bareRoot = path.join(fixture, bareName);
    const seedRoot = path.join(fixture, "seed-p1");
    const integrationRoot0 = path.join(fixture, "integration-p1");
    await mkdir(seedRoot, { recursive: true });
    await mkdir(bareRoot, { recursive: true });
    initRepo(seedRoot, "Seed P1");
    await writeFile(path.join(seedRoot, "notes.txt"), "A\n", "utf8");
    const commitA = commitAll(seedRoot, "A");
    git(bareRoot, ["init", "--bare", "--quiet"]);
    git(seedRoot, ["push", "--quiet", bareRoot, `${commitA}:refs/heads/${BRANCH}`]);
    git(bareRoot, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);
    const endpoint = endpointFor(bareName);
    await waitForDaemon(endpoint, daemon);

    // Clone to integration worktree (starts on main at A)
    git(fixture, ["clone", "--quiet", endpoint, integrationRoot0]);
    const integrationRoot = await realpath(integrationRoot0);
    git(integrationRoot, ["config", "user.name", "Integration P1"]);
    git(integrationRoot, ["config", "user.email", "integration-p1@example.test"]);
    assert.equal(gitText(integrationRoot, ["rev-parse", "HEAD"]), commitA);
    assert.equal(gitText(integrationRoot, ["branch", "--show-current"]), BRANCH);

    // Create integration lane from exactly A
    git(integrationRoot, ["checkout", "--quiet", "-b", "integration-1", commitA]);
    assert.equal(gitText(integrationRoot, ["branch", "--show-current"]), "integration-1");
    assert.equal(gitText(integrationRoot, ["rev-parse", "HEAD"]), commitA);

    // Qualified integration commit B descends from A
    await writeFile(path.join(integrationRoot, "notes.txt"), "A\nB\n", "utf8");
    const commitB = commitAll(integrationRoot, "B qualified");
    const ancestry = gitResult(integrationRoot, ["merge-base", "--is-ancestor", commitA, commitB]);
    assert.equal(ancestry.status, 0, "B must descend from A");
    assert.equal(gitText(integrationRoot, ["branch", "--show-current"]), "integration-1");

    const wsId = workspaceIdForRoot(integrationRoot);
    const workspace = { id: wsId, root: integrationRoot, openedAt: new Date().toISOString() };
    const promotePolicy = {
      enabled: true,
      rules: [{ remote: "origin", endpoint, branches: [BRANCH] }]
    };
    const pushPolicyDisabled = { enabled: false, rules: [] };
    const config = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: pushPolicyDisabled,
      gitPromotePolicy: promotePolicy
    };

    // Exact internal argv uses source SHA, not HEAD branch
    const fakePreflight = {
      schema_version: 1,
      workspace_id: wsId,
      root: integrationRoot,
      git_dir: "x",
      object_format: "sha1",
      remote: "origin",
      endpoint,
      branch: BRANCH,
      source_ref: `refs/heads/${BRANCH}`,
      destination_ref: `refs/heads/${BRANCH}`,
      source_commit: commitB,
      expected_remote_head: commitA
    };
    // buildGitPromoteArgs validates destination only; source_ref not used, so construct minimal
    const argv = buildGitPromoteArgs({
      ...fakePreflight,
      workspace_id: wsId,
      root: integrationRoot,
      remote: "origin",
      branch: BRANCH,
      destination_ref: `refs/heads/${BRANCH}`,
      source_commit: commitB,
      expected_remote_head: commitA
    });
    assert.ok(argv.includes(`--force-with-lease=refs/heads/${BRANCH}:${commitA}`));
    assert.ok(argv.includes(`${commitB}:refs/heads/${BRANCH}`));

    const rawBeforeMain = gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]);
    assert.equal(rawBeforeMain, commitA);

    // Promote while attached to integration-1, NOT main
    const result = await gitPromote(config, workspace, {
      workspace_id: wsId,
      remote: "origin",
      branch: BRANCH,
      source_commit: commitB,
      expected_remote_head: commitA
    });
    assert.equal(result.source_commit, commitB);
    assert.equal(result.expected_remote_head, commitA);
    assert.equal(result.remote_head, commitB);
    assert.equal(result.branch, BRANCH);
    assert.equal(result.push_attempts, 1);

    // Remote main becomes exactly B
    assert.equal(gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]), commitB);
    assert.equal(gitText(integrationRoot, ["ls-remote", "--refs", "--heads", "origin", `refs/heads/${BRANCH}`]).split("\t")[0], commitB);

    // Main was never checked out: HEAD still integration-1, local main still A
    assert.equal(gitText(integrationRoot, ["branch", "--show-current"]), "integration-1");
    assert.equal(gitText(integrationRoot, ["rev-parse", "HEAD"]), commitB);
    // Local main ref still A (clone's main not auto-updated by push from other branch)
    assert.equal(gitText(integrationRoot, ["rev-parse", "refs/heads/main"]), commitA);

    console.log(`RAW_OBSERVATION: P1 canonical A=${commitA} integration B=${commitB} promoted while HEAD=integration-1; remote main now ${commitB}; local main still ${commitA}.`);
    console.log("SANITY_VERDICT: MATCH — promotion from integration worktree without checking out main.");

    // Mirror refresh without checking out main (bookkeeping only)
    git(integrationRoot, ["fetch", "--quiet", "origin", `${BRANCH}:${BRANCH}`]);
    assert.equal(gitText(integrationRoot, ["rev-parse", "refs/heads/main"]), commitB);
    assert.equal(gitText(integrationRoot, ["branch", "--show-current"]), "integration-1");
    console.log("RAW_OBSERVATION: local refs/heads/main refreshed to B via fetch while HEAD stayed integration-1.");
    console.log("PASS P1 happy path + mirror refresh");

    // Preserve for stale test? Use fresh remote for P2/P3 to keep isolation.
  }

  // ---- P2 stale lease ----
  {
    const bareName = "remote-p2.git";
    const bareRoot = path.join(fixture, bareName);
    const seedRoot = path.join(fixture, "seed-p2");
    await mkdir(seedRoot, { recursive: true });
    await mkdir(bareRoot, { recursive: true });
    initRepo(seedRoot, "Seed P2");
    await writeFile(path.join(seedRoot, "notes.txt"), "A\n", "utf8");
    const commitA = commitAll(seedRoot, "P2 A");
    git(bareRoot, ["init", "--bare", "--quiet"]);
    git(seedRoot, ["push", "--quiet", bareRoot, `${commitA}:refs/heads/${BRANCH}`]);
    git(bareRoot, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);
    const endpoint = endpointFor(bareName);
    await waitForDaemon(endpoint, daemon);

    const integration0 = path.join(fixture, "integration-p2");
    git(fixture, ["clone", "--quiet", endpoint, integration0]);
    const integrationRoot = await realpath(integration0);
    git(integrationRoot, ["config", "user.name", "Integration P2"]);
    git(integrationRoot, ["config", "user.email", "integration-p2@example.test"]);
    git(integrationRoot, ["checkout", "--quiet", "-b", "integration-p2", commitA]);
    await writeFile(path.join(integrationRoot, "notes.txt"), "A\nB\n", "utf8");
    const commitB = commitAll(integrationRoot, "P2 B");

    // Concurrent writer advances remote A->C
    const writer0 = path.join(fixture, "writer-p2");
    git(fixture, ["clone", "--quiet", endpoint, writer0]);
    const writerRoot = await realpath(writer0);
    git(writerRoot, ["config", "user.name", "Writer P2"]);
    git(writerRoot, ["config", "user.email", "writer-p2@example.test"]);
    await writeFile(path.join(writerRoot, "notes.txt"), "A\nC\n", "utf8");
    const commitC = commitAll(writerRoot, "P2 C");
    git(writerRoot, ["push", "--quiet", "origin", `${BRANCH}:${BRANCH}`]);
    assert.equal(gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]), commitC);

    const wsId = workspaceIdForRoot(integrationRoot);
    const workspace = { id: wsId, root: integrationRoot, openedAt: new Date().toISOString() };
    const config = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: { enabled: false, rules: [] },
      gitPromotePolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] }
    };
    await expectPromoteError(
      gitPromote(config, workspace, {
        workspace_id: wsId,
        remote: "origin",
        branch: BRANCH,
        source_commit: commitB,
        expected_remote_head: commitA
      }),
      "remote-head-mismatch"
    );
    assert.equal(gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]), commitC);
    console.log(`RAW_OBSERVATION: P2 stale expected A=${commitA} but remote is C=${commitC}; promote B=${commitB} refused; remote still C.`);
    console.log("PASS P2 stale lease");
  }

  // ---- P3 non-fast-forward ----
  {
    const bareName = "remote-p3.git";
    const bareRoot = path.join(fixture, bareName);
    const seedRoot = path.join(fixture, "seed-p3");
    await mkdir(seedRoot, { recursive: true });
    await mkdir(bareRoot, { recursive: true });
    initRepo(seedRoot, "Seed P3");
    await writeFile(path.join(seedRoot, "notes.txt"), "A\n", "utf8");
    const commitA = commitAll(seedRoot, "P3 A");
    git(bareRoot, ["init", "--bare", "--quiet"]);
    git(seedRoot, ["push", "--quiet", bareRoot, `${commitA}:refs/heads/${BRANCH}`]);
    git(bareRoot, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);
    const endpoint = endpointFor(bareName);
    await waitForDaemon(endpoint, daemon);

    // Integration B diverges from A
    const integration0 = path.join(fixture, "integration-p3");
    git(fixture, ["clone", "--quiet", endpoint, integration0]);
    const integrationRoot = await realpath(integration0);
    git(integrationRoot, ["config", "user.name", "Integration P3"]);
    git(integrationRoot, ["config", "user.email", "integration-p3@example.test"]);
    git(integrationRoot, ["checkout", "--quiet", "-b", "integration-p3", commitA]);
    await writeFile(path.join(integrationRoot, "notes.txt"), "A\nB-divergent\n", "utf8");
    const commitB = commitAll(integrationRoot, "P3 B divergent");

    // Writer C also diverges from A (different content), push to remote so remote is C
    const writer0 = path.join(fixture, "writer-p3");
    git(fixture, ["clone", "--quiet", endpoint, writer0]);
    const writerRoot = await realpath(writer0);
    git(writerRoot, ["config", "user.name", "Writer P3"]);
    git(writerRoot, ["config", "user.email", "writer-p3@example.test"]);
    await writeFile(path.join(writerRoot, "notes.txt"), "A\nC-divergent\n", "utf8");
    const commitC = commitAll(writerRoot, "P3 C divergent");
    git(writerRoot, ["push", "--quiet", "origin", `${BRANCH}:${BRANCH}`]);
    assert.equal(gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]), commitC);
    // Bring C objects into the integration lane so ancestry can be proven
    // without checking out main (fetch only, HEAD stays on integration-p3).
    git(integrationRoot, ["fetch", "--quiet", "origin"]);
    assert.equal(gitText(integrationRoot, ["branch", "--show-current"]), "integration-p3");
    // B does not descend from C (divergent children of A)
    const isAncestor = gitResult(integrationRoot, ["merge-base", "--is-ancestor", commitC, commitB]);
    assert.equal(isAncestor.status, 1, "fixture must be divergent for P3");

    const wsId = workspaceIdForRoot(integrationRoot);
    const workspace = { id: wsId, root: integrationRoot, openedAt: new Date().toISOString() };
    const config = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: { enabled: false, rules: [] },
      gitPromotePolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] }
    };
    await expectPromoteError(
      gitPromote(config, workspace, {
        workspace_id: wsId,
        remote: "origin",
        branch: BRANCH,
        source_commit: commitB,
        expected_remote_head: commitC
      }),
      "non-fast-forward"
    );
    assert.equal(gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]), commitC);
    console.log(`RAW_OBSERVATION: P3 source B=${commitB} does not descend from current C=${commitC}; promotion refused; remote still C.`);
    console.log("PASS P3 non-fast-forward");
  }

  // ---- P4 policy boundary ----
  {
    const bareName = "remote-p4.git";
    const bareRoot = path.join(fixture, bareName);
    const seedRoot = path.join(fixture, "seed-p4");
    await mkdir(seedRoot, { recursive: true });
    await mkdir(bareRoot, { recursive: true });
    initRepo(seedRoot, "Seed P4");
    await writeFile(path.join(seedRoot, "notes.txt"), "A\n", "utf8");
    const commitA = commitAll(seedRoot, "P4 A");
    git(bareRoot, ["init", "--bare", "--quiet"]);
    git(seedRoot, ["push", "--quiet", bareRoot, `${commitA}:refs/heads/${BRANCH}`]);
    git(bareRoot, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);
    const endpoint = endpointFor(bareName);
    await waitForDaemon(endpoint, daemon);

    const work0 = path.join(fixture, "work-p4");
    git(fixture, ["clone", "--quiet", endpoint, work0]);
    const workRoot = await realpath(work0);
    git(workRoot, ["config", "user.name", "Work P4"]);
    git(workRoot, ["config", "user.email", "work-p4@example.test"]);
    git(workRoot, ["checkout", "--quiet", "-b", "integration-p4", commitA]);
    await writeFile(path.join(workRoot, "notes.txt"), "A\nB\n", "utf8");
    const commitB = commitAll(workRoot, "P4 B");
    const wsId = workspaceIdForRoot(workRoot);
    const workspace = { id: wsId, root: workRoot, openedAt: new Date().toISOString() };

    // Push policy allows feature branch, promote policy disabled -> promote to main must fail
    const pushOnlyConfig = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches: ["feature-p4"], branch_prefixes: undefined }] },
      gitPromotePolicy: { enabled: false, rules: [] }
    };
    // Need push policy to allow feature-p4 for push test, but promote to main must still fail
    await expectPromoteError(
      gitPromote(pushOnlyConfig, workspace, {
        workspace_id: wsId,
        remote: "origin",
        branch: BRANCH,
        source_commit: commitB,
        expected_remote_head: commitA
      }),
      "policy-disabled"
    );
    // Push permission alone does not grant promote: even if push policy allowed main, promote still needs its own rule.
    const pushAllowsMainConfig = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] },
      gitPromotePolicy: { enabled: false, rules: [] }
    };
    await expectPromoteError(
      gitPromote(pushAllowsMainConfig, workspace, {
        workspace_id: wsId,
        remote: "origin",
        branch: BRANCH,
        source_commit: commitB,
        expected_remote_head: commitA
      }),
      "policy-disabled"
    );
    // With explicit promote authority, same promotion succeeds (push policy still disabled for main is fine)
    const promoteOnlyConfig = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: { enabled: false, rules: [] },
      gitPromotePolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH] }] }
    };
    const ok = await gitPromote(promoteOnlyConfig, workspace, {
      workspace_id: wsId,
      remote: "origin",
      branch: BRANCH,
      source_commit: commitB,
      expected_remote_head: commitA
    });
    assert.equal(ok.remote_head, commitB);
    assert.equal(gitText(bareRoot, ["rev-parse", `refs/heads/${BRANCH}`]), commitB);

    // Evaluate helper directly also shows separation
    assert.equal(evaluateGitPromotePolicy(workRoot, pushOnlyConfig.gitPromotePolicy, "origin", BRANCH).allowed, false);
    console.log("RAW_OBSERVATION: P4 push-only permission refused promote with policy-disabled; explicit promote authority succeeded.");
    console.log("PASS P4 policy boundary");
  }

  // ---- P5 push regression ----
  {
    const bareName = "remote-p5.git";
    const bareRoot = path.join(fixture, bareName);
    const seedRoot = path.join(fixture, "seed-p5");
    await mkdir(seedRoot, { recursive: true });
    await mkdir(bareRoot, { recursive: true });
    initRepo(seedRoot, "Seed P5");
    await writeFile(path.join(seedRoot, "notes.txt"), "A\n", "utf8");
    const commitA = commitAll(seedRoot, "P5 A");
    git(bareRoot, ["init", "--bare", "--quiet"]);
    git(seedRoot, ["push", "--quiet", bareRoot, `${commitA}:refs/heads/${BRANCH}`]);
    git(bareRoot, ["symbolic-ref", "HEAD", `refs/heads/${BRANCH}`]);
    const endpoint = endpointFor(bareName);
    await waitForDaemon(endpoint, daemon);

    const work0 = path.join(fixture, "work-p5");
    git(fixture, ["clone", "--quiet", endpoint, work0]);
    const workRoot = await realpath(work0);
    git(workRoot, ["config", "user.name", "Work P5"]);
    git(workRoot, ["config", "user.email", "work-p5@example.test"]);
    const wsId = workspaceIdForRoot(workRoot);
    const workspace = { id: wsId, root: workRoot, openedAt: new Date().toISOString() };
    const config = {
      maxGitTimeoutMs: 15000,
      maxOutputBytes: 120000,
      toolMode: "full",
      writeMode: "workspace",
      gitPushPolicy: { enabled: true, rules: [{ remote: "origin", endpoint, branches: [BRANCH, "feature-p5"] }] },
      gitPromotePolicy: { enabled: false, rules: [] }
    };
    // Attached-branch guard still works: attached to main but request feature-p5
    const { GitPushPreflightError } = await import("../dist/gitPushPreflight.js");
    let guardErr;
    try {
      await gitPush(config, workspace, {
        workspace_id: wsId,
        remote: "origin",
        branch: "feature-p5",
        expected_local_head: commitA,
        expected_remote_head: "absent"
      });
    } catch (e) {
      guardErr = e;
    }
    assert.ok(guardErr, "expected branch-mismatch");
    assert.equal(guardErr.reason, "branch-mismatch");

    // Ordinary push to feature-p5 first publication still works
    git(workRoot, ["checkout", "--quiet", "-b", "feature-p5", commitA]);
    await writeFile(path.join(workRoot, "notes.txt"), "A\nF\n", "utf8");
    const commitF = commitAll(workRoot, "P5 F");
    const pushRes = await gitPush(config, workspace, {
      workspace_id: wsId,
      remote: "origin",
      branch: "feature-p5",
      expected_local_head: commitF,
      expected_remote_head: "absent"
    });
    assert.equal(pushRes.remote_head, commitF);
    assert.equal(gitText(bareRoot, ["rev-parse", "refs/heads/feature-p5"]), commitF);
    console.log("RAW_OBSERVATION: P5 attached-branch guard branch-mismatch preserved; ordinary feature push succeeded.");
    console.log("PASS P5 push regression");
  }

  console.log("P1: PASS");
  console.log("P2: PASS");
  console.log("P3: PASS");
  console.log("P4: PASS");
  console.log("P5: PASS");
} finally {
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  if (daemon && daemon.exitCode === null) daemon.kill("SIGKILL");
  await rm(fixture, { recursive: true, force: true });
}
