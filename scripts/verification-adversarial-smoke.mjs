import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const pkgJson = {
  name: "adv-fixture",
  scripts: {
    "tree-spin": "node -e 'const { spawn } = require(\"node:child_process\"); const child = spawn(process.execPath, [\"-e\", \"setInterval(() => {}, 500)\"], { stdio: \"ignore\" }); setInterval(() => {}, 500);'",
    "noisy-loop": "node -e 'setInterval(() => { process.stdout.write(\"X\".repeat(1024)); }, 5);'",
    "quick": "node -e 'process.exit(0);'"
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
    ["arg\nwith\nnewline"]
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

  // Cleanup fixture
  try {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  } catch {}

  console.log("\nALL 10 ADVERSARIAL MATRIX TESTS PASSED.");
}

runTests().catch((err) => {
  console.error("ADVERSARIAL SUITE FAILED:", err);
  process.exit(1);
});
