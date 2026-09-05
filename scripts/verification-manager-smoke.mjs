import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import {
  VerificationManager,
  compileRunnerArgv,
  validatePackageScriptName
} from "../dist/verificationOps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M009 VerificationManager Core Smoke");

const fakeWorkspace = {
  id: "ws_e2e2e49f30435c519293253a",
  root: repoRoot,
  openedAt: new Date().toISOString()
};

const config = loadConfig(["--root", repoRoot]);
const guard = new PathGuard(config);

async function runTests() {
  // Test 1: Start and Wait on a quick succeeded verification job
  console.log("\n[Test 1] Start and wait on a quick succeeded verification job...");
  const mgr1 = new VerificationManager(config, {
    maxActiveJobs: 3,
    minLifetimeMs: 500,
    defaultLifetimeMs: 5000,
    maxLifetimeMs: 10000
  });

  const startRecord1 = await mgr1.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "build",
    args: ["--help"]
  });

  assert.match(startRecord1.jobId, /^vjob_[0-9a-f]{24}$/, "jobId must match vjob grammar");
  assert.match(startRecord1.generationId, /^vgen_[0-9a-f]{32}$/, "generationId must match vgen grammar");
  assert.equal(startRecord1.generationId, mgr1.generationId, "job generationId must match manager generationId");
  assert.equal(startRecord1.state, "running");
  assert.equal(startRecord1.workspaceId, fakeWorkspace.id);
  assert.equal(startRecord1.runner, "package_script");
  assert.equal(mgr1.getActiveCount(), 1);

  const waitRecord1 = await mgr1.waitVerification(startRecord1.jobId, 10);
  assert.equal(waitRecord1.jobId, startRecord1.jobId);
  assert.equal(waitRecord1.generationId, mgr1.generationId, "waitRecord generationId must match manager generationId");
  assert.equal(waitRecord1.state, "succeeded");
  assert.equal(waitRecord1.exitCode, 0);
  assert.ok(waitRecord1.durationMs >= 0, "durationMs must be recorded");
  assert.equal(mgr1.getActiveCount(), 0, "active count must decrement on completion");
  console.log("  PASS: Succeeded job finished with exit code 0");

  // Test 2: Cancellation of a running verification job
  console.log("\n[Test 2] Cancellation of a running verification job...");
  const mgr2 = new VerificationManager(config, {
    maxActiveJobs: 3,
    minLifetimeMs: 500,
    defaultLifetimeMs: 30000
  });
  assert.notEqual(mgr2.generationId, mgr1.generationId, "different manager must have different generationId");

  // Use verification:fixture as a lawful finite process to test cancellation, concurrency, and timeouts
  const startRecord2 = await mgr2.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "30000"]
  });

  assert.equal(startRecord2.state, "running");
  const cancelRecord2 = await mgr2.cancelVerification(startRecord2.jobId);
  assert.equal(cancelRecord2.jobId, startRecord2.jobId);
  assert.equal(cancelRecord2.state, "cancelled");
  assert.equal(mgr2.getActiveCount(), 0);

  // Idempotence: cancelling again returns the same terminal record
  const cancelRecord2b = await mgr2.cancelVerification(startRecord2.jobId);
  assert.equal(cancelRecord2b.state, "cancelled");
  console.log("  PASS: Cancellation killed process and is idempotent");

  // Test 3: Concurrency cap (max 3 active) and capacity rejection
  console.log("\n[Test 3] Concurrency cap and rejection...");
  const mgr3 = new VerificationManager(config, {
    maxActiveJobs: 2, // set cap to 2 for test
    minLifetimeMs: 500,
    defaultLifetimeMs: 15000
  });

  const j1 = await mgr3.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "15000"]
  });
  const j2 = await mgr3.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "15000"]
  });
  assert.equal(mgr3.getActiveCount(), 2);

  // 3rd job should fail with capacity reached
  let capacityError = null;
  try {
    await mgr3.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "15000"]
    });
  } catch (err) {
    capacityError = err;
  }
  assert.ok(capacityError, "Must throw capacity error");
  assert.equal(capacityError.code, "verification_capacity_reached");

  // Clean up running jobs
  await mgr3.cancelVerification(j1.jobId);
  await mgr3.cancelVerification(j2.jobId);
  assert.equal(mgr3.getActiveCount(), 0);
  console.log("  PASS: Active capacity enforced, 3rd job rejected");

  // Test 4: Lifetime timeout expiration
  console.log("\n[Test 4] Lifetime timeout expiration...");
  const mgr4 = new VerificationManager(config, {
    minLifetimeMs: 300,
    defaultLifetimeMs: 400
  });

  const jTimeout = await mgr4.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "10000"],
    lifetime_ms: 300
  });

  const timeoutResult = await mgr4.waitVerification(jTimeout.jobId, 5);
  assert.equal(timeoutResult.state, "timed_out");
  assert.match(timeoutResult.terminalReason, /lifetime of \d+ ms exceeded/);
  assert.equal(mgr4.getActiveCount(), 0);
  console.log("  PASS: Job timed out and process tree terminated");

  // Test 5: Output ceiling enforcement
  console.log("\n[Test 5] Hard output ceiling enforcement...");
  const mgr5 = new VerificationManager(config, {
    minLifetimeMs: 500,
    defaultLifetimeMs: 10000,
    hardOutputCeilingBytes: 256, // small ceiling for test
    retainedTailBytes: 128
  });

  // tsc --help produces > 1KB of text
  const jOutput = await mgr5.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "tsc",
    args: ["--help"]
  });

  const outputResult = await mgr5.waitVerification(jOutput.jobId, 5);
  assert.equal(outputResult.state, "output_limit_exceeded");
  assert.match(outputResult.terminalReason, /Output ceiling of 256 bytes exceeded/);
  assert.ok(outputResult.truncated, "Must be flagged as truncated");
  console.log("  PASS: Output ceiling stopped runaway process");

  // Test 6: Terminal record TTL and eviction
  console.log("\n[Test 6] Terminal record retention cap and eviction...");
  const mgr6 = new VerificationManager(config, {
    terminalRecordMax: 3,
    terminalRecordTtlMs: 5000
  });

  // Create 5 jobs sequentially and finish them
  const completedIds = [];
  for (let i = 0; i < 5; i++) {
    const job = await mgr6.startVerification(fakeWorkspace, guard, {
      workspace_id: fakeWorkspace.id,
      runner: "tsc",
      args: ["--version"]
    });
    await mgr6.waitVerification(job.jobId, 5);
    completedIds.push(job.jobId);
  }

  // Oldest 2 jobs should have been pruned down to max 3
  assert.equal(mgr6.getJobRecord(completedIds[0]), undefined, "Job 0 should be evicted");
  assert.equal(mgr6.getJobRecord(completedIds[1]), undefined, "Job 1 should be evicted");
  assert.ok(mgr6.getJobRecord(completedIds[2]), "Job 2 must be retained");
  assert.ok(mgr6.getJobRecord(completedIds[3]), "Job 3 must be retained");
  assert.ok(mgr6.getJobRecord(completedIds[4]), "Job 4 must be retained");
  console.log("  PASS: Oldest terminal records evicted down to max cap");

  // Test 7: Controlled manager shutdown
  console.log("\n[Test 7] Controlled manager close/shutdown...");
  const mgr7 = new VerificationManager(config, {
    defaultLifetimeMs: 30000
  });
  const shut1 = await mgr7.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  const shut2 = await mgr7.startVerification(fakeWorkspace, guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "20000"]
  });
  assert.equal(mgr7.getActiveCount(), 2);
  await mgr7.close();
  assert.equal(mgr7.getActiveCount(), 0);
  assert.equal(mgr7.getJobRecord(shut1.jobId).state, "cancelled");
  assert.equal(mgr7.getJobRecord(shut2.jobId).state, "cancelled");
  console.log("  PASS: Manager shutdown cancelled all active jobs cleanly");

  console.log("\nALL VERIFICATION MANAGER TESTS PASSED.");
}

runTests().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
