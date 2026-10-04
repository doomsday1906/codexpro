import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import { VerificationManager } from "../dist/verificationOps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M009 TASK-005 Adversarial & Process Cleanup Smoke");

// Setup isolated workspace
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m009-adv-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

// Link node_modules into fixtureRoot
try {
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(realFixtureRoot, "node_modules"));
} catch {}

// package.json with scripts including nested child processes and noisy loops
await fs.copyFile(
  path.join(repoRoot, "scripts", "verification-lifecycle-fixture.mjs"),
  path.join(realFixtureRoot, "verification-lifecycle-fixture.mjs")
);
await fs.copyFile(
  path.join(repoRoot, "scripts", "verification-fixture.mjs"),
  path.join(realFixtureRoot, "verification-fixture.mjs")
);
const pkgJson = {
  name: "adv-fixture",
  scripts: {
    "tree-spin": "node -e 'const { spawn } = require(\"node:child_process\"); const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 500)\"], { stdio: \"ignore\" }); setInterval(() => {}, 500);'",
    "noisy-loop": "node -e 'setInterval(() => { process.stdout.write(\"X\".repeat(1024)); }, 5);'",
    "quick": "node -e 'process.exit(0);'",
    "verification:lifecycle": "node verification-lifecycle-fixture.mjs",
    "verification:fixture": "node verification-fixture.mjs"
  }
};
await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify(pkgJson, null, 2));
await fs.writeFile(path.join(realFixtureRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022" }, include: ["index.ts"] }));
await fs.writeFile(path.join(realFixtureRoot, "index.ts"), "export const x = 1;\n");

const fakeWorkspace = {
  id: "ws_adv_test_48a91c0b39e2",
  root: realFixtureRoot,
  openedAt: new Date().toISOString()
};

const baseConfig = loadConfig(["--root", realFixtureRoot, "--allow-root", realFixtureRoot]);
const guard = new PathGuard(baseConfig);

function getTreePids(rootPid) {
  if (!rootPid) return [];
  try {
    const out = execFileSync("pgrep", ["-P", String(rootPid)], { encoding: "utf8" });
    const directChildren = out.trim().split(/\s+/).map(Number).filter(Boolean);
    const all = [...directChildren];
    for (const c of directChildren) {
      all.push(...getTreePids(c));
    }
    return all;
  } catch {
    return [];
  }
}

function arePidsDead(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      return false; // Still alive
    } catch {
      // Dead
    }
  }
  return true;
}

async function runTests() {
  // Test 1: Timeout kills descendant process tree
  console.log("\n[Test 1] Timeout kills descendant process tree...");
  const mgr1 = new VerificationManager(baseConfig, {
    minLifetimeMs: 500,
    defaultLifetimeMs: 1000
  });

  const job1 = await mgr1.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "tree-spin",
    lifetime_ms: 600
  });

  // Allow process tree to spawn
  await new Promise((r) => setTimeout(r, 250));
  const jobObj1 = mgr1.getActiveJobs().find((j) => j.jobId === job1.jobId);
  const parentPid1 = jobObj1?.childProcess?.pid;
  assert.ok(parentPid1, "Parent PID must exist");
  const descendants1 = getTreePids(parentPid1);
  console.log(`  Spawned parent PID ${parentPid1} with descendants: [${descendants1.join(", ")}]`);

  // Wait for lifetime timeout
  const timedOutRecord = await mgr1.waitVerification(job1.jobId, 5);
  assert.equal(timedOutRecord.state, "timed_out");
  assert.equal(mgr1.getActiveCount(), 0);

  // Give 1.5s for escalation/cleanup
  await new Promise((r) => setTimeout(r, 1600));

  assert.ok(arePidsDead([parentPid1, ...descendants1]), "All parent and descendant PIDs must be dead");
  console.log("  PASS: Timeout killed entire descendant process tree without orphans");

  // Test 1b: Timeout must win when lifetime expires BEFORE bounded cleanup completes.
  // The root stays alive past the 500ms lifetime (--run-ms 1200), so the lifetime
  // timer necessarily fires first and locks the timed_out terminal; no early-close
  // path can precede it. The detached SIGTERM-ignoring pipe-holder (--detached-ignore-term,
  // inherit stdio) additionally survives the exit/escalation SIGTERM, holding 'close'
  // until bounded SIGKILL reaps it. Deterministic by construction (probe-verified),
  // and it self-exits at 2200ms so no orphan can linger if escalation ever missed.
  if (process.platform === "linux") {
    console.log("\n[Test 1b] Timeout terminates an exact-owned detached descendant...");
    const escapedManager = new VerificationManager(baseConfig, {
      minLifetimeMs: 500,
      defaultLifetimeMs: 500
    });
    const escapedJob = await escapedManager.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "2200", "--detached-ignore-term", "--run-ms", "1200"],
      lifetime_ms: 500
    });
    try {
      const escapedResult = await escapedManager.waitVerification(escapedJob.jobId, 5);
      assert.equal(escapedResult.state, "timed_out", "Timeout should become terminal after owned descendants are killed");
      assert.match(escapedResult.terminalReason, /lifetime of 500 ms exceeded/);
      assert.equal(escapedManager.getActiveCount(), 0);
    } finally {
      await escapedManager.close();
    }
    console.log("  PASS: Detached descendant no longer holds the job open after timeout");
  }

  // Test 2: Cancel kills descendant process tree
  console.log("\n[Test 2] Cancel kills descendant process tree...");
  const mgr2 = new VerificationManager(baseConfig, {
    minLifetimeMs: 500,
    defaultLifetimeMs: 30000
  });

  const job2 = await mgr2.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "tree-spin"
  });

  await new Promise((r) => setTimeout(r, 250));
  const jobObj2 = mgr2.getActiveJobs().find((j) => j.jobId === job2.jobId);
  const parentPid2 = jobObj2?.childProcess?.pid;
  assert.ok(parentPid2);
  const descendants2 = getTreePids(parentPid2);
  console.log(`  Spawned parent PID ${parentPid2} with descendants: [${descendants2.join(", ")}]`);

  const cancelRecord = await mgr2.cancelVerification(job2.jobId);
  assert.equal(cancelRecord.state, "cancelled");
  assert.equal(mgr2.getActiveCount(), 0);

  await new Promise((r) => setTimeout(r, 1600));
  assert.ok(arePidsDead([parentPid2, ...descendants2]), "All parent and descendant PIDs must be dead");
  console.log("  PASS: Cancel killed entire descendant process tree without orphans");

  // Test 3: Output ceiling terminates runaway stdout/stderr loop
  console.log("\n[Test 3] Output ceiling terminates runaway stdout/stderr loop...");
  const mgr3 = new VerificationManager(baseConfig, {
    minLifetimeMs: 500,
    defaultLifetimeMs: 30000,
    hardOutputCeilingBytes: 2048,
    retainedTailBytes: 512
  });

  const job3 = await mgr3.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "noisy-loop"
  });

  const outputCeilingResult = await mgr3.waitVerification(job3.jobId, 5);
  assert.equal(outputCeilingResult.state, "output_limit_exceeded");
  assert.match(outputCeilingResult.terminalReason, /Output ceiling of 2048 bytes exceeded/);
  assert.ok(outputCeilingResult.truncated);
  assert.equal(mgr3.getActiveCount(), 0);
  console.log("  PASS: Output ceiling stopped runaway loop and bounded output tail");

  // Test 4: Capacity cap rejects 4th job with clean structured error
  console.log("\n[Test 4] Capacity cap rejects 4th job with verification_capacity_reached...");
  const mgr4 = new VerificationManager(baseConfig, {
    maxActiveJobs: 3,
    minLifetimeMs: 500,
    defaultLifetimeMs: 30000
  });

  const jA = await mgr4.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  const jB = await mgr4.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  const jC = await mgr4.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  assert.equal(mgr4.getActiveCount(), 3);

  let capError = null;
  try {
    await mgr4.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "20000"]
    });
  } catch (err) {
    capError = err;
  }
  assert.ok(capError, "Must reject 4th job");
  assert.equal(capError.code, "verification_capacity_reached");
  assert.match(capError.message, /Verification capacity reached/);

  await mgr4.cancelVerification(jA.jobId);
  await mgr4.cancelVerification(jB.jobId);
  await mgr4.cancelVerification(jC.jobId);
  assert.equal(mgr4.getActiveCount(), 0);
  console.log("  PASS: 4th job rejected with verification_capacity_reached and clean message");

  // Test 5: Server SIGTERM/shutdown cleans all active jobs
  console.log("\n[Test 5] Server shutdown cleans all active jobs...");
  const mgr5 = new VerificationManager(baseConfig, {
    defaultLifetimeMs: 30000
  });

  const s1 = await mgr5.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  const s2 = await mgr5.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  assert.equal(mgr5.getActiveCount(), 2);

  await mgr5.close();
  assert.equal(mgr5.getActiveCount(), 0);
  assert.equal(mgr5.getJobRecord(s1.jobId).state, "cancelled");
  assert.equal(mgr5.getJobRecord(s2.jobId).state, "cancelled");
  console.log("  PASS: Manager shutdown cancelled all active jobs cleanly");

  // Test 6: Prune loop drops oldest terminal records down to cap
  console.log("\n[Test 6] Prune loop drops oldest terminal records down to cap...");
  const mgr6 = new VerificationManager(baseConfig, {
    terminalRecordMax: 2
  });

  const ids = [];
  for (let i = 0; i < 4; i++) {
    const j = await mgr6.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "quick"
    });
    await mgr6.waitVerification(j.jobId, 5);
    ids.push(j.jobId);
  }

  assert.equal(mgr6.getJobRecord(ids[0]), undefined);
  assert.equal(mgr6.getJobRecord(ids[1]), undefined);
  assert.ok(mgr6.getJobRecord(ids[2]));
  assert.ok(mgr6.getJobRecord(ids[3]));
  console.log("  PASS: Oldest terminal records pruned to terminalRecordMax");

  // Test 7: Invalid wrapper binary fails closed before spawn
  console.log("\n[Test 7] Invalid wrapper binary fails closed before spawn...");
  let wrapperError = null;
  try {
    const brokenConfig = {
      ...baseConfig,
      containmentWrapper: ["/nonexistent/bin/nonexistent_wrapper_binary_12345"]
    };
    const mgr7 = new VerificationManager(brokenConfig);
    await mgr7.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "quick"
    });
  } catch (err) {
    wrapperError = err;
  }
  assert.ok(wrapperError, "Invalid wrapper must throw error");
  assert.match(wrapperError.message, /containment wrapper path does not exist/);
  console.log("  PASS: Invalid containment wrapper failed closed before spawn");

  // Test 8: Unknown job id in wait/cancel returns clean not-found error
  console.log("\n[Test 8] Unknown job id in wait/cancel returns clean not-found error...");
  const mgr8 = new VerificationManager(baseConfig);
  let waitNotFoundError = null;
  try {
    await mgr8.waitVerification("vjob_deadbeefdeadbeefdeadbeef", 1);
  } catch (err) {
    waitNotFoundError = err;
  }
  assert.ok(waitNotFoundError);
  assert.match(waitNotFoundError.message, /Verification job not found or expired/);

  let cancelNotFoundError = null;
  try {
    await mgr8.cancelVerification("vjob_deadbeefdeadbeefdeadbeef");
  } catch (err) {
    cancelNotFoundError = err;
  }
  assert.ok(cancelNotFoundError);
  assert.match(cancelNotFoundError.message, /Verification job not found or expired/);
  console.log("  PASS: Unknown job id returns clean not-found error for both wait and cancel");

  // Test 9: Wait timeout returns current running status rather than hanging caller
  console.log("\n[Test 9] Wait timeout returns current running status without hanging...");
  const mgr9 = new VerificationManager(baseConfig, {
    defaultLifetimeMs: 30000
  });

  const jRunning = await mgr9.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "tree-spin"
  });

  const startT = Date.now();
  const waitSnapshot = await mgr9.waitVerification(jRunning.jobId, 1);
  const elapsed = Date.now() - startT;
  assert.equal(waitSnapshot.state, "running");
  assert.ok(elapsed >= 900 && elapsed < 3000, `Wait should return near max_wait_seconds (elapsed: ${elapsed}ms)`);
  assert.equal(mgr9.getActiveCount(), 1);

  await mgr9.cancelVerification(jRunning.jobId);
  assert.equal(mgr9.getActiveCount(), 0);
  console.log(`  PASS: Wait timeout returned current running status in ${elapsed}ms`);

  // Test 10: Package script and arg injection attempts rejected by admission before spawn
  console.log("\n[Test 10] Injection attempts rejected before spawn...");
  const mgr10 = new VerificationManager(baseConfig);

  const maliciousScripts = [
    "test; rm -rf /",
    "test && sleep 10",
    "start", // blocked token
    "dev",   // blocked token
    "serve", // blocked token
    "publish", // blocked token
    "deploy",  // blocked token
    "test.watch", // blocked dot-delimited watch
    "lint.fix",   // blocked dot-delimited fix
    "test:watch", // blocked colon-delimited watch
    "test-watch", // blocked dash-delimited watch
    "test_watch", // blocked underscore-delimited watch
    "test.watchall", // blocked watchall
    "lint:fix",   // blocked mutating fix
    "lint_fix",   // blocked underscore mutating fix
    "format",     // blocked mutating token
    "write",      // blocked mutating token
    "test`whoami`",
    "test|cat",
    "test$(whoami)"
  ];

  for (const script of maliciousScripts) {
    let err = null;
    try {
      await mgr10.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "package_script",
        package_manager: "npm",
        script
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `Malicious script name '${script}' must be rejected`);
  }

  // Malicious arguments
  const maliciousArgLists = [
    ["--flag; rm -rf /"],
    ["--option", "`whoami`"],
    ["$(echo evil)"],
    ["foo|bar"],
    ["foo&bar"],
    ["<input"],
    [">output"],
    ["arg\nwith\nnewline"],
    ["--watchAll=true"],
    ["--watchall=true"],
    ["--watch-all=true"],
    ["--watch"],
    ["-w"],
    ["--watch=true"],
    ["--fix"],
    ["--write"],
    ["--output", "foo.txt"],
    ["/etc/passwd"],
    ["../parent-traversal"],
    ["~/home-traversal"]
  ];

  for (const args of maliciousArgLists) {
    let err = null;
    try {
      await mgr10.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "tsc",
        args
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `Malicious args ${JSON.stringify(args)} must be rejected`);
  }
  console.log("  PASS: All script injection and shell metacharacter attempts rejected before spawn");

  function isPidAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === "ESRCH" ? false : true;
    }
  }

  async function readPidFile(absPath) {
    try {
      const text = await fs.readFile(absPath, "utf8");
      const pid = Number(text.trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {}
    return 0;
  }

  async function freePort() {
    return await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const port = typeof address === "object" && address ? address.port : 0;
        probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
      });
    });
  }

  // Test 11 [direct-manager]: detached SEPARATE-stdio child ignoring SIGTERM must need SIGKILL.
  // Root exits 0 immediately with separate stdio (close fires at once), but the owned
  // descendant survives SIGTERM and requires SIGKILL. Result must be cleanup-aware
  // (NOT clean succeeded) with no orphan.
  console.log("\n[Test 11] direct-manager: separate-stdio SIGTERM-ignoring detached child needs SIGKILL...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-11.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "15000", "--detached-separate", "--detached-ignore-term", "--detached-pid-file", pidName, "--run-ms", "400"]
    });
    // Allow root exit + initial SIGTERM to be delivered while the ignorer survives.
    await new Promise((r) => setTimeout(r, 1100));
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.ok(childPid > 0, "Fixture must record detached child PID");
    assert.ok(isPidAlive(childPid), `Detached ignorer PID ${childPid} must still be alive after SIGTERM (proves SIGKILL is required)`);
    const result = await mgr.waitVerification(started.jobId, 8);
    assert.notEqual(result.state, "succeeded", "Must not report clean success while an owned child was alive");
    assert.equal(result.state, "failed");
    assert.match(result.terminalReason ?? "", /cleanup|SIGKILL|owned descendant/i, "Terminal reason must be cleanup-aware");
    assert.equal(mgr.getActiveCount(), 0);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!isPidAlive(childPid), `Detached ignorer PID ${childPid} must be dead after bounded SIGKILL (no orphan)`);
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log("  PASS: SIGTERM ignored, SIGKILL cleaned, cleanup-aware failure, no orphan");
  }

  // Test 12 [direct-manager]: early-exiting root with inherited pipes + detached child
  // retaining pipes. 'close' is held back by the pipe holder; the exit handler must
  // TERM/KILL it boundedly so the job settles without hanging to self-exit.
  // Contract: normal-completion-with-intervention is a cleanup-aware `failed`
  // (never ordinary `succeeded`), even when the exit handler reaped the holder
  // before `close` pruned it (history recorded via cleanupPerformed).
  console.log("\n[Test 12] direct-manager: early root exit with inherited-pipe holder settles boundedly...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-12.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const startT = Date.now();
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "8000", "--detached-pid-file", pidName, "--run-ms", "400"]
    });
    const result = await mgr.waitVerification(started.jobId, 10);
    const elapsed = Date.now() - startT;
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.ok(elapsed < 6000, `Pipe-holder must be reaped boundedly, not held to self-exit (elapsed ${elapsed}ms)`);
    assert.equal(result.state, "failed", `Intervention must be cleanup-aware failure, got ${result.state}`);
    assert.match(result.terminalReason ?? "", /cleanup|owned descendant/i, "Terminal reason must be cleanup-aware");
    assert.ok((result.cleanupPerformed ?? 0) >= 1, `cleanupPerformed must record intervention, got ${result.cleanupPerformed}`);
    assert.equal(result.descendantsObserved, true, "Descendants must have been observed");
    assert.equal(mgr.getActiveCount(), 0);
    if (childPid > 0) {
      assert.ok(!isPidAlive(childPid), `Pipe-holding child PID ${childPid} must be dead (no orphan)`);
    }
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log(`  PASS: Pipe holder reaped in ${elapsed}ms with cleanup-aware failure`);
  }

  // Test 13 [direct-manager]: normal-root completion with surviving descendant (separate
  // stdio, TERM-sufficient). Even when TERM cleans it, the job must not claim clean
  // success — it must be cleanup-aware (failed) with no orphan.
  console.log("\n[Test 13] direct-manager: normal completion with surviving descendant is not clean success...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-13.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "15000", "--detached-separate", "--detached-pid-file", pidName, "--run-ms", "400"]
    });
    const result = await mgr.waitVerification(started.jobId, 8);
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.notEqual(result.state, "succeeded", "Surviving owned child must prevent clean succeeded");
    assert.equal(result.state, "failed");
    assert.match(result.terminalReason ?? "", /cleanup|owned descendant/i);
    assert.equal(mgr.getActiveCount(), 0);
    if (childPid > 0) {
      assert.ok(!isPidAlive(childPid), `Surviving descendant PID ${childPid} must be cleaned (no orphan)`);
    }
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log("  PASS: Surviving descendant cleaned, terminal is cleanup-aware failure");
  }

  // Test 14 [direct-manager]: stale/reused PID identity must never be signaled.
  // Inject a live innocent PID with a mismatched starttime into the owned set;
  // cancellation must prune it without signaling, leaving the innocent alive.
  console.log("\n[Test 14] direct-manager: stale PID identity (starttime mismatch) is never signaled...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "20000"]
    });
    await new Promise((r) => setTimeout(r, 250));
    const jobObj = mgr.getActiveJobs().find((j) => j.jobId === started.jobId);
    assert.ok(jobObj, "Job object must be active");
    const innocent = spawn(process.execPath, ["-e", "setInterval(() => {}, 500);"], { stdio: "ignore", detached: true });
    try { innocent.unref(); } catch {}
    const innocentPid = innocent.pid;
    assert.ok(innocentPid > 0, "Innocent PID must exist");
    assert.ok(isPidAlive(innocentPid), "Innocent must be alive before cancel");
    // Poison the owned set with a stale identity for a live innocent + a dead PID.
    jobObj.ownedDescendants?.set?.(innocentPid, "0");
    // Non-existent PID with bogus identity must also be pruned, never signaled.
    jobObj.ownedDescendants?.set?.(4199999, "0");
    const cancelled = await mgr.cancelVerification(started.jobId);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(mgr.getActiveCount(), 0);
    assert.ok(isPidAlive(innocentPid), `Innocent PID ${innocentPid} with stale starttime must survive cancellation`);
    try { process.kill(innocentPid, "SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!isPidAlive(innocentPid), "Innocent must be reaped by exact-owned test cleanup");
    try { await mgr.close(); } catch {}
    console.log("  PASS: Stale starttime mismatch pruned without signaling innocent");
  }

  // Test 16 [direct-manager]: early-exiting root WITHOUT the 400ms discovery
  // cushion (--run-ms 0) + inherited-pipes holder. Must still bound (no hang past
  // the independent settle deadline + wait bound), terminal cleanup-aware
  // (failed, never plain succeeded), no orphan. All kills PID+starttime gated.
  console.log("\n[Test 16] direct-manager: zero-cushion early exit with inherited-pipe holder still bounds...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-16.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const startT = Date.now();
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "8000", "--detached-pid-file", pidName, "--run-ms", "0"]
    });
    const result = await mgr.waitVerification(started.jobId, 10);
    const elapsed = Date.now() - startT;
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.ok(elapsed < 6000, `Zero-cushion pipe-holder must bound before self-exit (elapsed ${elapsed}ms)`);
    assert.equal(result.state, "failed", `Zero-cushion intervention must be cleanup-aware failure, got ${result.state}`);
    assert.match(result.terminalReason ?? "", /cleanup|owned descendant/i, "Terminal reason must be cleanup-aware");
    assert.equal(mgr.getActiveCount(), 0);
    if (childPid > 0) {
      assert.ok(!isPidAlive(childPid), `Pipe-holding child PID ${childPid} must be dead (no orphan)`);
    }
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log(`  PASS: Zero-cushion holder bounded in ${elapsed}ms with cleanup-aware failure, no orphan`);
  }

  // Test 17 [direct-manager]: controlled cleanup-failure via deterministic hook.
  // SIGKILL always succeeds on Linux, so real D-state is never manufactured;
  // instead testHookForceLive (fake PIDs, never signalled) forces the drain to
  // report live after the deadline, proving the `cleanup_incomplete` path with
  // truthful evidence, single terminal assignment, and retained recovery info.
  console.log("\n[Test 17] direct-manager: forced drain-timeout proves cleanup_incomplete with recovery hint...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-17.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "15000", "--detached-separate", "--detached-pid-file", pidName, "--run-ms", "400"]
    });
    const jobObj = mgr.getActiveJobs().find((j) => j.jobId === started.jobId);
    assert.ok(jobObj, "Job object must be active to inject deterministic failure");
    jobObj.testHookForceLive = [5999911, 5999912];
    const startT = Date.now();
    const result = await mgr.waitVerification(started.jobId, 10);
    const elapsed = Date.now() - startT;
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.equal(result.state, "failed", `Forced incomplete must be failure, got ${result.state}`);
    assert.match(result.terminalReason ?? "", /cleanup_incomplete/, "Terminal reason must carry cleanup_incomplete evidence");
    assert.ok((result.recoveryHint ?? "").includes("5999911"), "Recovery hint must retain forced live identities");
    assert.ok((result.recoveryHint ?? "").length <= 600, "Recovery hint must stay bounded");
    assert.equal(mgr.getActiveCount(), 0);
    // Single terminal assignment: a second wait observes the identical terminal.
    const second = await mgr.waitVerification(started.jobId, 2);
    assert.equal(second.state, result.state);
    assert.equal(second.finishedAt, result.finishedAt, "Finished timestamp must be single-assigned");
    if (childPid > 0) {
      assert.ok(!isPidAlive(childPid), `Real detached child PID ${childPid} must still be reaped (no orphan)`);
    }
    assert.ok(elapsed < 9000, `Forced incomplete must bound (elapsed ${elapsed}ms)`);
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log(`  PASS: cleanup_incomplete with recovery hint in ${elapsed}ms, single terminal, no orphan`);
  }

  // Test 18 [direct-manager]: pipe-holder admission allowlist + double identity binding
  // via injected snapshots exercising the REAL capturePipeHolders function (not
  // just the identity helper). Deterministic: no live-unrelated PIDs touched;
  // signalling is a suppressed dry-run (recorded, never delivered).
  console.log("\n[Test 18] direct-manager: pipe-holder admission rejects shared files/terminals + PID reuse...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "20000"]
    });
    const jobObj = mgr.getActiveJobs().find((j) => j.jobId === started.jobId);
    assert.ok(jobObj, "Admission job must be active");
    const captureScan = () => {
      if (typeof jobObj.testOnlyCapturePipeHolders === "function") jobObj.testOnlyCapturePipeHolders();
      else jobObj.capturePipeHolders();
    };
    const signalTree = (sig) => {
      if (typeof jobObj.testOnlySignalOwnedTree === "function") jobObj.testOnlySignalOwnedTree(sig);
      else jobObj.signalOwnedProcessTree(sig);
    };
    if (typeof jobObj.testOnlySetPipeInodes === "function") jobObj.testOnlySetPipeInodes(["pipe:[991001]", "socket:[992002]"]);
    else { jobObj.jobPipeInodes.clear(); jobObj.jobPipeInodes.add("pipe:[991001]"); jobObj.jobPipeInodes.add("socket:[992002]"); }
    const clearOwned = () => {
      if (typeof jobObj.testOnlyClearOwned === "function") jobObj.testOnlyClearOwned();
      else jobObj.ownedDescendants.clear();
    };
    const getOwned = (pid) => jobObj.ownedDescendants.get(pid);
    // Suppressed dry-run: group + per-PID kills are recorded, never delivered,
    // so the real fixture job is never touched while gating is still exercised.
    jobObj.testHookSuppressSignals = true;
    jobObj.testHookKillAttempts = [];
    const resetAttempts = () => { jobObj.testHookKillAttempts = []; };
    const attemptsFor = (pid) => jobObj.testHookKillAttempts.filter((a) => a.pid === pid);

    // (i) shared regular file must NOT adopt, NOT signal.
    clearOwned(); resetAttempts();
    jobObj.testHookPipeScan = {
      listPids: () => ["91001"],
      listFds: (pid) => (pid === 91001 ? ["0", "1"] : []),
      readFdTarget: (pid, fd) => (pid === 91001 && fd === "1" ? "/tmp/shared.log" : "pipe:[0]"),
      readIdentity: (pid) => (pid === 91001 ? { pid, startTime: "1111", processGroup: 1, state: "S" } : undefined)
    };
    captureScan();
    assert.ok(!jobObj.ownedDescendants.has(91001), "Shared regular-file holder must NOT be adopted");
    signalTree("SIGTERM");
    assert.equal(attemptsFor(91001).length, 0, "Shared-file PID must NOT be signalled");
    console.log("  sub(i) PASS: shared regular file rejected (no adopt, no signal)");

    // (ii) shared terminal (+ anon_inode + /dev/null spot checks) must NOT adopt/signal.
    clearOwned(); resetAttempts();
    jobObj.testHookPipeScan = {
      listPids: () => ["91002", "91003", "91004"],
      listFds: () => ["0", "1"],
      readFdTarget: (pid, fd) => {
        if (fd !== "1") return "pipe:[0]";
        if (pid === 91002) return "/dev/pts/7";
        if (pid === 91003) return "anon_inode:[eventpoll]";
        return "/dev/null";
      },
      readIdentity: (pid) => ({ pid, startTime: "2222", processGroup: 1, state: "S" })
    };
    captureScan();
    assert.ok(!jobObj.ownedDescendants.has(91002), "Shared terminal holder must NOT be adopted");
    assert.ok(!jobObj.ownedDescendants.has(91003), "anon_inode holder must NOT be adopted");
    assert.ok(!jobObj.ownedDescendants.has(91004), "/dev/null holder must NOT be adopted");
    signalTree("SIGTERM");
    assert.equal(attemptsFor(91002).length, 0, "Terminal PID must NOT be signalled");
    assert.equal(attemptsFor(91003).length, 0, "anon_inode PID must NOT be signalled");
    console.log("  sub(ii) PASS: terminal/anon_inode//dev/null rejected (no adopt, no signal)");

    // (iii-a) PID reuse: stale baseline T1 vs stable replacement T2 -> prune, never refresh, never signal.
    clearOwned(); resetAttempts();
    jobObj.ownedDescendants.set(92001, "T1-baseline");
    jobObj.testHookPipeScan = {
      listPids: () => ["92001"],
      listFds: () => ["3"],
      readFdTarget: () => "pipe:[991001]",
      readIdentity: (pid) => (pid === 92001 ? { pid, startTime: "T2-replacement", processGroup: 1, state: "S" } : undefined)
    };
    captureScan();
    assert.notEqual(getOwned(92001), "T2-replacement", "Stale baseline must NEVER be refreshed to replacement identity");
    assert.ok(!jobObj.ownedDescendants.has(92001) || getOwned(92001) === "T1-baseline", "Replacement must be pruned, never adopted as T2");
    // Re-seed stale for the signal phase (capture pruned it); signal must prune again, never signal.
    jobObj.ownedDescendants.set(92001, "T1-baseline");
    resetAttempts();
    signalTree("SIGTERM");
    assert.equal(attemptsFor(92001).length, 0, "Replaced PID must NOT be signalled after prune");
    assert.notEqual(getOwned(92001), "T2-replacement", "Signal path must never refresh baseline to T2");
    console.log("  sub(iii-a) PASS: stale baseline pruned, replacement rejected + not signalled");

    // (iii-b) PID changes mid-scan (before T1, after T2) -> reject, never refresh, never signal.
    clearOwned(); resetAttempts();
    jobObj.ownedDescendants.set(92002, "T1-mid");
    let midCalls = 0;
    jobObj.testHookPipeScan = {
      listPids: () => ["92002"],
      listFds: () => ["3"],
      readFdTarget: () => "pipe:[991001]",
      readIdentity: (pid) => {
        if (pid !== 92002) return undefined;
        midCalls += 1;
        return { pid, startTime: midCalls === 1 ? "T1-mid" : "T2-mid", processGroup: 1, state: "S" };
      }
    };
    captureScan();
    assert.equal(midCalls, 2, "Double identity binding must read before AND after the fd scan");
    assert.notEqual(getOwned(92002), "T2-mid", "Mid-scan replacement must never refresh baseline");
    // Signal phase with stable replacement vs re-seeded stale baseline.
    jobObj.ownedDescendants.set(92002, "T1-mid");
    resetAttempts();
    jobObj.testHookPipeScan = {
      listPids: () => ["92002"],
      listFds: () => ["3"],
      readFdTarget: () => "pipe:[991001]",
      readIdentity: (pid) => (pid === 92002 ? { pid, startTime: "T2-mid", processGroup: 1, state: "S" } : undefined)
    };
    signalTree("SIGTERM");
    assert.equal(attemptsFor(92002).length, 0, "Mid-scan-changed PID must NOT be signalled");
    console.log("  sub(iii-b) PASS: mid-scan PID reuse rejected, baseline not refreshed, not signalled");

    // (iv) positive: genuinely-owned pipe + socket holders adopted + eligible for gated signal.
    clearOwned(); resetAttempts();
    jobObj.testHookPipeScan = {
      listPids: () => ["93001"],
      listFds: (pid) => (pid === 93001 ? ["0", "3"] : []),
      readFdTarget: (pid, fd) => (pid === 93001 && fd === "3" ? "pipe:[991001]" : "pipe:[0]"),
      readIdentity: (pid) => (pid === 93001 ? { pid, startTime: "5555", processGroup: 1, state: "S" } : undefined)
    };
    captureScan();
    assert.equal(getOwned(93001), "5555", "Genuinely-owned pipe holder must be adopted with stable identity");
    signalTree("SIGTERM");
    assert.equal(attemptsFor(93001).length, 1, "Adopted pipe holder must be eligible for gated signal (recorded attempt)");
    clearOwned(); resetAttempts();
    jobObj.testHookPipeScan = {
      listPids: () => ["93002"],
      listFds: () => ["4"],
      readFdTarget: () => "socket:[992002]",
      readIdentity: (pid) => (pid === 93002 ? { pid, startTime: "6666", processGroup: 1, state: "S" } : undefined)
    };
    captureScan();
    assert.equal(getOwned(93002), "6666", "Socket-pair holder must be adopted");
    signalTree("SIGTERM");
    assert.equal(attemptsFor(93002).length, 1, "Socket holder must be signal-eligible");
    console.log("  sub(iv) PASS: genuinely-owned pipe/socket holders adopted + signal-eligible");

    // Teardown: clear injection + fake owned; cancel real job; no orphans.
    jobObj.testHookPipeScan = null;
    jobObj.testHookSuppressSignals = false;
    jobObj.testHookStubKill = false;
    clearOwned();
    const cancelled = await mgr.cancelVerification(started.jobId);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(mgr.getActiveCount(), 0);
    try { await mgr.close(); } catch {}
    console.log("  PASS: Admission allowlist + double-identity binding proven on real scan function");
  }

  // Test 16b [direct-manager]: discovery-miss -> pipe-holder scan still admits the
  // genuinely-owned holder. Forces the tree-walk to miss by clearing the owned
  // set after root exit (owned empty before pipe scan), then proves the REAL
  // pipe scan re-admits via allowlisted endpoint + stable identity and bounds
  // cleanup with a cleanup-aware terminal + no orphan.
  console.log("\n[Test 16b] direct-manager: discovery-miss still bounds via pipe-holder scan...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-16b.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const startT = Date.now();
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "8000", "--detached-ignore-term", "--detached-pid-file", pidName, "--run-ms", "400"]
    });
    // Root runs 400ms then exits; exit-handler TERMs (ignored) so the
    // inherited-pipe holder survives into the KILL window. Intervene at ~800ms:
    // job still running (close held by pipes), holder still alive pre-KILL.
    await new Promise((r) => setTimeout(r, 800));
    const jobObj = mgr.getActiveJobs().find((j) => j.jobId === started.jobId);
    assert.ok(jobObj, "16b job must still be running at intervention (close pending proves pipes held)");
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.ok(childPid > 0, "Fixture must record detached child PID");
    assert.ok(isPidAlive(childPid), `Holder PID ${childPid} must be alive at intervention (pre-KILL window)`);
    // Force discovery-miss: drop all tree-walk state.
    if (typeof jobObj.testOnlyClearOwned === "function") jobObj.testOnlyClearOwned();
    else jobObj.ownedDescendants.clear();
    assert.equal(jobObj.ownedDescendants.size, 0, "Discovery-miss condition: owned set empty before pipe scan");
    // Real pipe scan (no hooks) must re-admit the genuinely-owned holder.
    assert.ok(!jobObj.testHookPipeScan, "16b must use the real /proc scan, not injected snapshots");
    if (typeof jobObj.testOnlyCapturePipeHolders === "function") jobObj.testOnlyCapturePipeHolders();
    else jobObj.capturePipeHolders();
    const adopted = jobObj.ownedDescendants.size;
    assert.ok(adopted >= 1, `Pipe scan must adopt >=1 genuinely-owned holder after miss (got ${adopted})`);
    assert.equal(jobObj.ownedDescendants.get(childPid) !== undefined, true, `Pipe scan must re-admit the real holder PID ${childPid}`);
    const result = await mgr.waitVerification(started.jobId, 10);
    const elapsed = Date.now() - startT;
    assert.ok(elapsed < 9000, `Discovery-miss holder must bound before self-exit (elapsed ${elapsed}ms)`);
    assert.equal(result.state, "failed", `Discovery-miss intervention must be cleanup-aware failure, got ${result.state}`);
    assert.match(result.terminalReason ?? "", /cleanup|owned descendant/i, "Terminal reason must be cleanup-aware");
    assert.equal(mgr.getActiveCount(), 0);
    assert.ok(!isPidAlive(childPid), `Pipe-holding child PID ${childPid} must be dead (no orphan)`);
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log(`  PASS: Miss forced (0 before, ${adopted} adopted) + bounded ${elapsed}ms cleanup-aware failure, no orphan`);
  }

  // Test 17b [direct-manager]: independent watchdog with `close` pending.
  // Holder keeps job pipes open (inherited stdio); signalling is suppressed so
  // `close` stays pending past the 4000ms settle deadline. The watchdog must
  // reach EXACTLY ONE terminal within its bound with truthful
  // cleanup_incomplete + bounded recovery evidence and single finishedAt.
  console.log("\n[Test 17b] direct-manager: watchdog bounds close-pending holder to single cleanup_incomplete...");
  {
    const mgr = new VerificationManager(baseConfig, { minLifetimeMs: 500, defaultLifetimeMs: 30000 });
    const pidName = "detached-17b.pid";
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    const started = await mgr.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:lifecycle",
      args: ["--detached-child-ms", "15000", "--detached-pid-file", pidName, "--run-ms", "400"]
    });
    const jobObj = mgr.getActiveJobs().find((j) => j.jobId === started.jobId);
    assert.ok(jobObj, "17b job must be active to suppress signals");
    // Suppress ALL delivery (group + per-PID) so the pipe holder survives and
    // `close` stays pending; gating + capture still run and are recorded.
    jobObj.testHookSuppressSignals = true;
    jobObj.testHookKillAttempts = [];
    const startT = Date.now();
    // At ~2s (pre-watchdog) the job must still be running: proves `close` is
    // pending (pipes held), not early-settled via the close path.
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(mgr.getActiveCount(), 1, "Job must still be running pre-watchdog (close pending, pipes held)");
    const childPid = await readPidFile(path.join(realFixtureRoot, pidName));
    assert.ok(childPid > 0, "Fixture must record close-pending holder PID");
    assert.ok(isPidAlive(childPid), `Holder PID ${childPid} must be alive pre-watchdog (suppressed kills)`);
    const result = await mgr.waitVerification(started.jobId, 10);
    const elapsed = Date.now() - startT;
    assert.equal(result.state, "failed", `Watchdog incomplete must be failure, got ${result.state}`);
    assert.match(result.terminalReason ?? "", /cleanup_incomplete/, "Terminal reason must carry cleanup_incomplete evidence");
    assert.ok((result.recoveryHint ?? "").length <= 600, "Recovery hint must stay bounded");
    assert.ok((result.recoveryHint ?? "").includes("live"), "Recovery hint must carry live-set evidence");
    assert.ok(elapsed < 9000, `Watchdog must bound (elapsed ${elapsed}ms)`);
    assert.equal(mgr.getActiveCount(), 0);
    // Single terminal assignment: re-wait observes the identical terminal.
    const second = await mgr.waitVerification(started.jobId, 2);
    assert.equal(second.state, result.state);
    assert.equal(second.finishedAt, result.finishedAt, "Finished timestamp must be single-assigned (exactly one terminal)");
    // Cleanup the suppressed holder (reap stubbed/real holder, no orphans).
    try { jobObj.testHookSuppressSignals = false; } catch {}
    try { process.kill(childPid, "SIGKILL"); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!isPidAlive(childPid), `Close-pending holder PID ${childPid} must be reaped by test cleanup (no orphan)`);
    try { await mgr.close(); } catch {}
    try { await fs.rm(path.join(realFixtureRoot, pidName), { force: true }); } catch {}
    console.log(`  PASS: watchdog single cleanup_incomplete in ${elapsed}ms, single finishedAt, no orphan`);
  }

  // Test 15 [public-mcp public-default]: actual MCP start/wait/list/cancel/reconnect +
  // workspace isolation through the real HTTP transport with default limits.
  console.log("\n[Test 15] public-mcp public-default: start/wait/list/cancel/reconnect + isolation...");
  {
    const altRoot = path.join(realFixtureRoot, "alt-workspace");
    await fs.mkdir(altRoot, { recursive: true });
    const realAltRoot = await fs.realpath(altRoot);
    try {
      await fs.symlink(path.join(repoRoot, "node_modules"), path.join(realAltRoot, "node_modules"));
    } catch {}
    await fs.copyFile(
      path.join(repoRoot, "scripts", "verification-fixture.mjs"),
      path.join(realAltRoot, "verification-fixture.mjs")
    );
    await fs.writeFile(
      path.join(realAltRoot, "package.json"),
      JSON.stringify({ name: "alt-fixture", scripts: { "verification:fixture": "node verification-fixture.mjs", "quick": "node -e 'process.exit(0);'" } }, null, 2)
    );
    const workspaceIdFor = (root) => `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
    const fixtureWsId = workspaceIdFor(realFixtureRoot);
    const altWsId = workspaceIdFor(realAltRoot);
    assert.notEqual(fixtureWsId, altWsId, "Isolation fixtures must have distinct workspace ids");

    const port = await freePort();
    const httpChild = spawn(process.execPath, ["dist/http.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEXPRO_ROOT: realFixtureRoot,
        CODEXPRO_ALLOWED_ROOTS: [realFixtureRoot, realAltRoot].join(path.delimiter),
        CODEXPRO_HOST: "127.0.0.1",
        CODEXPRO_PORT: String(port),
        CODEXPRO_BASH_MODE: "safe",
        CODEXPRO_WRITE_MODE: "off",
        CODEXPRO_TOOL_MODE: "full",
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_HTTP_TOKEN: "ADV_CLEANUP_PUBLIC_TOKEN",
        CODEXPRO_ALLOW_NO_HTTP_TOKEN: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let httpStderr = "";
    httpChild.stderr.on("data", (chunk) => { httpStderr += String(chunk); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { httpChild.kill("SIGTERM"); } catch {}
        reject(new Error(`timed out waiting for HTTP server:\n${httpStderr}`));
      }, 15000);
      timer.unref();
      const interval = setInterval(() => {
        if (httpStderr.includes("HTTP MCP listening")) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      }, 50);
      interval.unref();
      httpChild.once("exit", (code) => {
        clearInterval(interval);
        clearTimeout(timer);
        reject(new Error(`HTTP server exited early with code ${code}\n${httpStderr}`));
      });
    });
    const serverUrl = `http://127.0.0.1:${port}/mcp`;
    const authHeaders = { authorization: "Bearer ADV_CLEANUP_PUBLIC_TOKEN" };
    let transportA = null;
    let transportB = null;
    try {
      const clientA = new Client({ name: "adv-cleanup-A", version: "1.0.0" });
      transportA = new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers: authHeaders } });
      await clientA.connect(transportA);
      // Public-default quick success (no custom lifetime_ms → server defaults).
      const startRes = await clientA.callTool({
        name: "start_verification",
        arguments: { workspace_id: fixtureWsId, runner: "package_script", package_manager: "npm", script: "quick" }
      });
      assert.ok(startRes && !startRes.isError, "public start_verification must succeed");
      const startedJob = startRes.structuredContent;
      assert.match(startedJob.jobId, /^vjob_[0-9a-f]{24}$/);
      const genId = startedJob.generationId;
      assert.match(genId, /^vgen_[0-9a-f]{32}$/);
      const waitRes = await clientA.callTool({
        name: "wait_verification",
        arguments: { job_id: startedJob.jobId, max_wait_seconds: 10 }
      });
      assert.ok(waitRes && !waitRes.isError);
      assert.equal(waitRes.structuredContent.state, "succeeded", "public-default quick job must succeed with no descendants");
      // Workspace isolation: alt workspace list must not contain the fixture job.
      const listMain = await clientA.callTool({ name: "list_verification_jobs", arguments: { workspace_id: fixtureWsId } });
      assert.ok(listMain && !listMain.isError);
      assert.ok((listMain.structuredContent.jobs ?? []).some((j) => j.jobId === startedJob.jobId), "Main workspace list must retain the job");
      const listAlt = await clientA.callTool({ name: "list_verification_jobs", arguments: { workspace_id: altWsId } });
      assert.ok(listAlt && !listAlt.isError);
      assert.ok(!(listAlt.structuredContent.jobs ?? []).some((j) => j.jobId === startedJob.jobId), "Alt workspace list must not leak the fixture job");
      // Reconnect: long job started in A, observed + cancelled in B (new MCP session, same process).
      const longRes = await clientA.callTool({
        name: "start_verification",
        arguments: { workspace_id: fixtureWsId, runner: "package_script", package_manager: "npm", script: "verification:fixture", args: ["--sleep", "30000"] }
      });
      assert.ok(longRes && !longRes.isError);
      const longJob = longRes.structuredContent;
      assert.equal(longJob.workspaceId ?? longJob.workspace_id, fixtureWsId);
      await transportA.close();
      transportA = null;
      const clientB = new Client({ name: "adv-cleanup-B", version: "1.0.0" });
      transportB = new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers: authHeaders } });
      await clientB.connect(transportB);
      const observed = await clientB.callTool({ name: "wait_verification", arguments: { job_id: longJob.jobId, max_wait_seconds: 1 } });
      assert.ok(observed && !observed.isError);
      assert.equal(observed.structuredContent.jobId, longJob.jobId);
      assert.equal(observed.structuredContent.state, "running");
      assert.equal(observed.structuredContent.generationId, genId, "Reconnect must observe the same process generation");
      const cancelled = await clientB.callTool({ name: "cancel_verification", arguments: { job_id: longJob.jobId } });
      assert.ok(cancelled && !cancelled.isError);
      assert.equal(cancelled.structuredContent.state, "cancelled");
      const listAfter = await clientB.callTool({ name: "list_verification_jobs", arguments: { workspace_id: fixtureWsId } });
      assert.ok(listAfter && !listAfter.isError);
      assert.equal(listAfter.structuredContent.activeCount, 0, "No active jobs may remain after public cancel");
      await transportB.close();
      transportB = null;
    } finally {
      try { if (transportA) await transportA.close(); } catch {}
      try { if (transportB) await transportB.close(); } catch {}
      try { httpChild.kill("SIGTERM"); } catch {}
      await new Promise((r) => {
        httpChild.once("exit", r);
        setTimeout(r, 3000);
      });
      await new Promise((r) => setTimeout(r, 800));
    }
    console.log("  PASS: Public MCP start/wait/list/cancel/reconnect + isolation with defaults");
  }

  // Cleanup fixture
  try {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  } catch {}

  console.log("\nALL 10 ADVERSARIAL MATRIX TESTS PASSED + 7 CLEANUP REGRESSIONS PASSED.");
}

runTests().catch((err) => {
  console.error("ADVERSARIAL SUITE FAILED:", err);
  process.exit(1);
});
