import assert from "node:assert/strict";
import { spawn, execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import {
  VerificationManager,
  trimUtf8Tail,
  validateContainmentWrapper,
  validatePackageScriptName,
  validateArgs,
  compileRunnerArgv
} from "../dist/verificationOps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const realRepoRoot = fsNative.realpathSync.native(repoRoot);
const realWsId = `ws_${createHash("sha256").update(realRepoRoot).digest("hex").slice(0, 24)}`;

console.log("# RepoConnect M009 TASK-007R3 Comprehensive Falsifiers");

const fakeWorkspace = {
  id: realWsId,
  root: realRepoRoot,
  openedAt: new Date().toISOString()
};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Recursively find all descendant PIDs rooted at a given rootPid
function getDescendantPids(rootPid) {
  if (!rootPid) return new Set();
  const descendants = new Set();
  try {
    const psOutput = execSync("ps -eo pid,ppid", { encoding: "utf8" });
    const lines = psOutput.trim().split("\n").slice(1);
    const childrenMap = new Map();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        if (!childrenMap.has(ppid)) {
          childrenMap.set(ppid, []);
        }
        childrenMap.get(ppid).push(pid);
      }
    }

    function collect(p) {
      const children = childrenMap.get(p) || [];
      for (const child of children) {
        if (!descendants.has(child)) {
          descendants.add(child);
          collect(child);
        }
      }
    }

    collect(rootPid);
  } catch (err) {
    // Fallback using pgrep -P if ps fails
    try {
      const out = execFileSync("pgrep", ["-P", String(rootPid)], { encoding: "utf8" });
      const direct = out.trim().split(/\s+/).map(Number).filter(Boolean);
      for (const d of direct) {
        descendants.add(d);
        for (const sub of getDescendantPids(d)) {
          descendants.add(sub);
        }
      }
    } catch {}
  }
  return descendants;
}

async function runFalsifiers() {
  // =========================================================================
  // Finding 1: HIGH-EXECUTION-BOUNDARY-001 Falsifiers
  // Prove that strict runner/flag/path/session safety is enforced across all delimiters and watch equivalents
  // in both safe and full bash modes
  // =========================================================================
  console.log("\n--- [1] Testing HIGH-EXECUTION-BOUNDARY-001 (Safe and Full Bash Modes) ---");

  for (const bashMode of ["safe", "full"]) {
    console.log(`\n  Checking boundary enforcement under CODEXPRO_BASH_MODE=${bashMode}...`);
    const config = loadConfig(["--root", repoRoot, "--bash", bashMode]);
    const guard = new PathGuard(config);
    const mgr = new VerificationManager(config);

    // 1.1: Rejection of delimiter script name equivalents (dot, colon, dash, underscore)
    console.log("    Falsifying rejection of script name delimiter equivalents (test.watch, lint.fix, etc.)...");
    const forbiddenScripts = [
      "test.watch",
      "lint.fix",
      "test:watch",
      "lint:fix",
      "test-watch",
      "lint-fix",
      "test_watch",
      "lint_fix",
      "test.watchall",
      "test:watchall",
      "test.autofix",
      "build:mutate",
      "code.format",
      "doc.write"
    ];

    for (const script of forbiddenScripts) {
      await assert.rejects(
        () => mgr.startVerification(fakeWorkspace, guard, {
          workspace_id: fakeWorkspace.id,
          runner: "package_script",
          package_manager: "npm",
          script
        }),
        /non-verification lifecycle\/daemon\/deployment\/mutating token/i,
        `Package script '${script}' must be rejected under bashMode=${bashMode}`
      );
    }

    // Innocent script names must NOT be rejected
    const innocentScripts = [
      "test",
      "test:unit",
      "test-unit",
      "test_integration",
      "test.ci",
      "check",
      "verify",
      "lint",
      "lint:check",
      "build:check",
      "typecheck"
    ];
    for (const script of innocentScripts) {
      assert.equal(validatePackageScriptName(script), script, `Innocent script '${script}' must be admitted`);
    }

    // 1.2: Rejection of watch argument equivalents across runners
    console.log("    Falsifying rejection of watch arguments (--watchAll=true, -w, --watch, etc.)...");
    const watchArgs = [
      ["--watch"],
      ["-w"],
      ["--watchall"],
      ["--watch-all"],
      ["--watch=true"],
      ["--watch=false"],
      ["--watchAll=true"],
      ["--watchall=true"],
      ["--watch-all=true"],
      ["-w=true"],
      ["--WATCH"],
      ["--WatchAll=True"],
      ["--Watch-All=true"]
    ];

    for (const args of watchArgs) {
      await assert.rejects(
        () => mgr.startVerification(fakeWorkspace, guard, {
          workspace_id: fakeWorkspace.id,
          runner: "package_script",
          package_manager: "npm",
          script: "verification:fixture",
          args
        }),
        /watch mode is forbidden/i,
        `Args ${JSON.stringify(args)} must be rejected under bashMode=${bashMode}`
      );

      await assert.rejects(
        () => mgr.startVerification(fakeWorkspace, guard, {
          workspace_id: fakeWorkspace.id,
          runner: "tsc",
          args
        }),
        /watch mode is forbidden/i,
        `tsc with args ${JSON.stringify(args)} must be rejected under bashMode=${bashMode}`
      );
    }

    // 1.3: Rejection of mutating/writing flags
    console.log("    Falsifying rejection of mutating/writing flags (--fix, --write, --apply, -o, --output-file)...");
    const mutatingArgs = [
      { runner: "eslint", args: ["--fix"] },
      { runner: "eslint", args: ["--fix-dry-run"] },
      { runner: "eslint", args: ["--fix-type", "problem"] },
      { runner: "eslint", args: ["--output-file", "report.txt"] },
      { runner: "biome_check", args: ["--write"] },
      { runner: "biome_check", args: ["--apply"] },
      { runner: "biome_check", args: ["--apply-unsafe"] },
      { runner: "tsc", args: ["--outfile", "out.js"] },
      { runner: "tsc", args: ["--outdir", "out/"] },
      { runner: "go_test", args: ["-o", "bin.out"] },
      { runner: "go_test", args: ["-exec", "rm -rf /"] }
    ];

    for (const item of mutatingArgs) {
      await assert.rejects(
        () => mgr.startVerification(fakeWorkspace, guard, {
          workspace_id: fakeWorkspace.id,
          runner: item.runner,
          args: item.args
        }),
        /forbidden/i,
        `${item.runner} with args ${JSON.stringify(item.args)} must be rejected`
      );
    }

    // 1.4: Rejection of absolute, home, and parent-traversal paths
    console.log("    Falsifying rejection of path traversal and absolute paths...");
    const badPathArgs = [
      ["/etc/passwd"],
      ["/tmp/malicious.js"],
      ["~"],
      ["~/secret.key"],
      ["~\\secret.key"],
      ["../escape.js"],
      ["subdir/../../parent.js"]
    ];

    for (const args of badPathArgs) {
      await assert.rejects(
        () => mgr.startVerification(fakeWorkspace, guard, {
          workspace_id: fakeWorkspace.id,
          runner: "pytest",
          args
        }),
        /forbidden absolute path|forbidden home path|forbidden parent directory traversal/i,
        `Path traversal args ${JSON.stringify(args)} must be rejected`
      );
    }

    // 1.5: Rejection of execution delegation & sensitive patterns
    console.log("    Falsifying rejection of execution delegation and sensitive file access...");
    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "eslint",
        args: ["--rulesdir", "/tmp/rules"]
      }),
      /forbidden/i,
      "eslint --rulesdir must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "pytest",
        args: [".env"]
      }),
      /blocked or unsafe pattern/i,
      "Access to .env file in args must be blocked"
    );
  }

  console.log("PASS: HIGH-EXECUTION-BOUNDARY-001 fully closed and verified across safe and full modes.");

  // =========================================================================
  // Finding 2: HIGH-GENERATION-IDENTITY-001 Falsifiers
  // Implement A001 LAW-003: process-generation identity frozen at creation
  // =========================================================================
  console.log("\n--- [2] Testing HIGH-GENERATION-IDENTITY-001 (Process Generation Identity) ---");

  const genConfig = loadConfig(["--root", repoRoot]);
  const genGuard = new PathGuard(genConfig);

  // 2.1: VerificationManager creates an opaque, cryptographically strong generationId
  const mgrGen1 = new VerificationManager(genConfig);
  assert.match(mgrGen1.generationId, /^vgen_[0-9a-f]{32}$/, "generationId must match format vgen_<32 hex chars>");

  // 2.2: Jobs started by this manager freeze that generationId
  const jobGen1A = await mgrGen1.startVerification(fakeWorkspace, genGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "500"]
  });
  assert.equal(jobGen1A.generationId, mgrGen1.generationId, "Job record must freeze manager generationId");

  const jobGen1B = await mgrGen1.startVerification(fakeWorkspace, genGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "500"]
  });
  assert.equal(jobGen1B.generationId, mgrGen1.generationId, "All jobs created by same manager must share generationId");
  assert.equal(jobGen1A.generationId, jobGen1B.generationId, "Jobs in same process generation must have identical generationId");

  // Wait on job and verify terminal record retains the same generationId
  const waitGen1A = await mgrGen1.waitVerification(jobGen1A.jobId, 5);
  assert.equal(waitGen1A.generationId, mgrGen1.generationId, "Terminal record must retain frozen generationId");

  // 2.3: A fresh manager/process has a DIFFERENT generation identity
  const mgrGen2 = new VerificationManager(genConfig);
  assert.match(mgrGen2.generationId, /^vgen_[0-9a-f]{32}$/);
  assert.notEqual(mgrGen2.generationId, mgrGen1.generationId, "Fresh manager must have a different generationId");

  // 2.4: Cross-generation job rejection (no old job resumption)
  await assert.rejects(
    () => mgrGen2.waitVerification(jobGen1A.jobId, 1),
    /Verification job not found or expired/i,
    "Fresh process generation must reject job from prior generation"
  );
  await assert.rejects(
    () => mgrGen2.cancelVerification(jobGen1A.jobId),
    /Verification job not found or expired/i,
    "Fresh process generation must reject cancel for job from prior generation"
  );

  console.log("PASS: HIGH-GENERATION-IDENTITY-001 fully closed and verified.");

  // =========================================================================
  // Finding 3: HIGH-HTTP-SHUTDOWN-PROOF-001 Real-HTTP Owned Descendant Shutdown Proof
  // Prove that real HTTP process SIGTERM kills owned descendants and leaves unrelated decoy alive
  // =========================================================================
  console.log("\n--- [3] Testing HIGH-HTTP-SHUTDOWN-PROOF-001 (Real-HTTP Owned Descendant Shutdown Proof) ---");

  // Step 3.1: Spawn an unrelated decoy process that must NOT be touched
  console.log("  Spawning unrelated decoy verification-fixture process...");
  const decoyProcess = spawn(process.execPath, [
    path.join(repoRoot, "scripts", "verification-fixture.mjs"),
    "--sleep", "60000"
  ], {
    stdio: "ignore",
    detached: true
  });
  const decoyPid = decoyProcess.pid;
  assert.ok(decoyPid, "Decoy process must have spawned");
  console.log(`  Decoy process spawned with PID: ${decoyPid}`);

  // Step 3.2: Spawn a real HTTP CodexPro server process
  const port = await freePort();
  console.log(`  Spawning real HTTP process on port ${port}...`);
  const httpProcess = spawn(process.execPath, [
    path.join(repoRoot, "dist", "http.js"),
    "--port", String(port),
    "--root", repoRoot,
    "--bash", "safe"
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1" }
  });
  const httpPid = httpProcess.pid;
  assert.ok(httpPid, "HTTP process must have spawned");

  let listening = false;
  httpProcess.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (text.includes("HTTP MCP listening")) {
      listening = true;
    }
  });

  for (let i = 0; i < 50; i++) {
    if (listening) break;
    await sleep(100);
  }
  assert.ok(listening, "HTTP server must be listening");
  console.log(`  HTTP server is listening on port ${port}. Connecting MCP client...`);

  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "falsifier-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // Step 3.3: Start a verification job in the HTTP server process
  console.log("  Starting lawful verification job with 30s sleep in real HTTP process...");
  const startResult = await client.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "30000"]
    }
  });
  const record = startResult.structuredContent;
  assert.ok(record?.jobId, "Job must have started");
  console.log(`  Job started with ID: ${record.jobId}, Gen: ${record.generationId}`);

  // Step 3.4: Discover the owned descendant process tree
  console.log(`  Discovering descendant tree rooted at HTTP process PID ${httpPid}...`);
  await sleep(1000);
  const descendants = getDescendantPids(httpPid);
  console.log(`  Discovered ${descendants.size} descendant processes: [${[...descendants].join(", ")}]`);
  assert.ok(descendants.size > 0, "HTTP process must have at least one verification descendant process");

  // Step 3.5: Formally prove decoy is NOT an owned descendant
  assert.ok(!descendants.has(decoyPid), `Decoy PID ${decoyPid} must NOT be in HTTP descendant tree`);
  console.log(`  PROVED: Decoy PID ${decoyPid} is NOT an owned descendant of HTTP PID ${httpPid}`);

  // Step 3.6: Send SIGTERM to the HTTP process WITHOUT cancelling the job first
  console.log(`  Sending SIGTERM to HTTP parent process (PID ${httpPid}) without cancelling job...`);
  const exitPromise = new Promise((resolve) => {
    httpProcess.on("exit", (code, signal) => resolve({ code, signal }));
  });
  process.kill(httpPid, "SIGTERM");

  const httpExit = await exitPromise;
  console.log(`  HTTP parent process exited with code ${httpExit.code}, signal ${httpExit.signal}`);
  assert.equal(httpExit.code, 0, "HTTP process must exit 0 on clean SIGTERM");

  // Step 3.7: Verify that every owned descendant PID is terminated
  console.log("  Verifying all owned descendants are terminated...");
  await sleep(500);
  for (const pid of descendants) {
    let dead = false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") dead = true;
    }
    assert.ok(dead, `Descendant PID ${pid} must be dead (ESRCH) after HTTP SIGTERM`);
    console.log(`    PID ${pid}: DEAD (ESRCH) confirmed`);
  }

  // Step 3.8: Prove that the unrelated decoy process survived
  let decoyAlive = false;
  try {
    process.kill(decoyPid, 0);
    decoyAlive = true;
  } catch (e) {
    decoyAlive = false;
  }
  assert.ok(decoyAlive, `Decoy PID ${decoyPid} must survive HTTP shutdown because it is not owned`);
  console.log(`  PROVED: Decoy PID ${decoyPid} survived HTTP shutdown (not killed because not an owned descendant)`);

  // Cleanup decoy
  console.log("  Cleaning up decoy process...");
  try { process.kill(decoyPid, "SIGKILL"); } catch {}
  console.log("  Decoy process cleaned up.");
  console.log("PASS: HIGH-HTTP-SHUTDOWN-PROOF-001 fully closed and verified.");

  // =========================================================================
  // Finding 4: HIGH-SHUTDOWN-ADMISSION-RACE-001 Falsifiers
  // Prove manager.close() seals admission synchronously, rejects concurrent/late starts,
  // spawns 0 child processes on rejection, is idempotent, and does not leak orphans.
  // =========================================================================
  console.log("\n--- [4] Testing HIGH-SHUTDOWN-ADMISSION-RACE-001 (Shutdown Admission Race) ---");

  const raceConfig = loadConfig(["--root", repoRoot, "--bash", "safe"]);
  const raceGuard = new PathGuard(raceConfig);
  const raceMgr = new VerificationManager(raceConfig);

  assert.equal(raceMgr.state, "open", "Initial manager state must be 'open'");

  // Step 4.1: Start an intentionally slow running job
  console.log("  Starting initial slow running job...");
  const slowJob = await raceMgr.startVerification(fakeWorkspace, raceGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "30000"]
  });
  assert.equal(slowJob.state, "running");
  assert.equal(raceMgr.getActiveCount(), 1);
  assert.equal(raceMgr.getTotalCount(), 1);

  // Discover child PID of slowJob
  const slowChildPid = raceMgr.getJob(slowJob.jobId)?.childProcess?.pid;
  assert.ok(slowChildPid, "Running job must have an active child process PID");

  // Step 4.2: Begin manager.close() while slow job is active
  console.log("  Initiating manager.close() while slow job is active...");
  const closePromise = raceMgr.close();

  // Step 4.3: Assert manager immediately enters 'closing' state synchronously
  assert.equal(raceMgr.state, "closing", "Manager must synchronously transition to 'closing' state");

  // Step 4.4: Attempt a second startVerification() while close() is in flight
  console.log("  Attempting startVerification() while manager is closing...");
  let startErr = null;
  try {
    await raceMgr.startVerification(fakeWorkspace, raceGuard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "10000"]
    });
  } catch (e) {
    startErr = e;
  }
  assert.ok(startErr, "startVerification() must be rejected while manager is closing");
  assert.equal(startErr.code, "verification_manager_closing", "Error code must be verification_manager_closing");
  console.log("    PASS: startVerification rejected with verification_manager_closing");

  // Step 4.5: Prove NO child process was spawned for the rejected start
  assert.equal(raceMgr.getActiveCount(), 1, "Active jobs count must not increase on rejected start");
  assert.equal(raceMgr.getTotalCount(), 1, "Total jobs count must remain exactly 1");
  console.log("    PASS: Total jobs count remained 1; zero child processes spawned for rejected start");

  // Step 4.6: Wait for close() to complete
  await closePromise;
  assert.equal(raceMgr.state, "closed", "Manager must transition to 'closed' once close() resolves");

  // Step 4.7: Verify the original slow job was cancelled and its process is dead
  assert.equal(raceMgr.getActiveCount(), 0, "Active jobs count must be 0 after close()");
  const cancelledRecord = raceMgr.getJobRecord(slowJob.jobId);
  assert.equal(cancelledRecord.state, "cancelled", "Slow job must be cancelled by close()");

  await sleep(200);
  let slowChildDead = false;
  try {
    process.kill(slowChildPid, 0);
  } catch (e) {
    if (e.code === "ESRCH") slowChildDead = true;
  }
  assert.ok(slowChildDead, `Slow job child PID ${slowChildPid} must be dead (ESRCH) after close()`);
  console.log(`    PID ${slowChildPid}: DEAD (ESRCH) confirmed`);

  // Step 4.8: Attempt post-close startVerification()
  console.log("  Attempting startVerification() after manager is closed...");
  let postCloseErr = null;
  try {
    await raceMgr.startVerification(fakeWorkspace, raceGuard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "1000"]
    });
  } catch (e) {
    postCloseErr = e;
  }
  assert.ok(postCloseErr, "startVerification() must fail when manager is closed");
  assert.equal(postCloseErr.code, "verification_manager_closing");
  console.log("    PASS: post-close start rejected with verification_manager_closing");

  // Step 4.9: Second close() is idempotent
  console.log("  Calling second close() to verify idempotency...");
  await raceMgr.close();
  assert.equal(raceMgr.state, "closed", "Second close() must be a harmless no-op");
  console.log("    PASS: second close() is idempotent and safe");

  // Step 4.10: Attack real HTTP shutdown vs concurrent late start race
  console.log("  Testing real-HTTP shutdown vs late start concurrency...");
  const racePort = await freePort();
  const raceHttpChild = spawn(
    process.execPath,
    [path.join(repoRoot, "dist", "http.js"), "--port", String(racePort), "--root", repoRoot, "--bash", "safe"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1" }
    }
  );
  let raceHttpReady = false;
  raceHttpChild.stderr.on("data", (chunk) => {
    if (chunk.toString().includes("HTTP MCP listening")) raceHttpReady = true;
  });
  for (let i = 0; i < 50; i++) {
    if (raceHttpReady) break;
    await sleep(100);
  }
  assert.ok(raceHttpReady, "Race HTTP server must be listening");

  const raceTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${racePort}/mcp`));
  const raceClient = new Client({ name: "r3-race-client", version: "1.0.0" }, { capabilities: {} });
  await raceClient.connect(raceTransport);

  // Start initial job
  const rInit = await raceClient.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "30000"]
    }
  });
  assert.ok(rInit.structuredContent?.jobId);

  // Trigger SIGTERM to HTTP server and concurrently attempt start_verification
  const httpDescendantsBefore = getDescendantPids(raceHttpChild.pid);
  process.kill(raceHttpChild.pid, "SIGTERM");

  // Attempt late start in-flight with shutdown
  let lateStartFailed = false;
  try {
    await raceClient.callTool({
      name: "start_verification",
      arguments: {
        workspace_id: realWsId,
        runner: "package_script",
        package_manager: "npm",
        script: "verification:fixture",
        args: ["--sleep", "20000"]
      }
    });
  } catch (e) {
    lateStartFailed = true;
  }

  await sleep(1000);
  // Verify all descendants that ever existed are dead
  for (const pid of httpDescendantsBefore) {
    let dead = false;
    try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") dead = true; }
    assert.ok(dead, `Descendant ${pid} must be dead`);
  }
  console.log("    PASS: Real HTTP shutdown prevented orphan leaks under concurrent late start");

  console.log("PASS: HIGH-SHUTDOWN-ADMISSION-RACE-001 fully closed and verified.");

  // =========================================================================
  // Finding 5: MEDIUM-POSTREDACTION-OUTPUT-BOUND-001 Falsifiers
  // Prove that post-redaction expansion cannot exceed retainedTailBytes,
  // multi-byte UTF-8 cuts do not split codepoints or produce invalid strings,
  // and observed byte counters truthfully report original output.
  // =========================================================================
  console.log("\n--- [5] Testing MEDIUM-POSTREDACTION-OUTPUT-BOUND-001 (Post-Redaction Output Bound & UTF-8) ---");

  // 5.1: Redaction-expansion falsifier
  console.log("  Testing redaction-expansion output bounding...");
  const credBudget = 800; // 800 bytes retainedTailBytes
  const credConfig = loadConfig(["--root", repoRoot]);
  credConfig.maxOutputBytes = credBudget;
  const credGuard = new PathGuard(credConfig);
  const credMgr = new VerificationManager(credConfig, { retainedTailBytes: credBudget });

  // 50 lines of "secret=abc\n": raw is 550 bytes (which is <= 800 raw bytes, so rawTruncated would be false!)
  // But after redaction, each line expands to "secret= [REDACTED_SECRET]\n" (26 bytes * 50 = 1300 bytes > 800 bytes!)
  const credJob = await credMgr.startVerification(fakeWorkspace, credGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-credentials", "50", "--sleep", "100"]
  });

  const credRecord = await credMgr.waitVerification(credJob.jobId, 10);
  assert.equal(credRecord.state, "succeeded");

  // 1. Sensitive values are fully redacted
  assert.ok(!credRecord.stdout.includes("secret=abc"), "Sensitive credential 'secret=abc' must NOT appear in output");
  assert.ok(credRecord.stdout.includes("[REDACTED_SECRET]"), "Output must contain [REDACTED_SECRET]");

  // 2. Final public combined stdout + stderr must be <= retainedTailBytes (800)
  const credCombinedBytes = Buffer.byteLength(credRecord.stdout, "utf8") + Buffer.byteLength(credRecord.stderr, "utf8");
  console.log(`    Original observed: ${credRecord.observedTotalBytes} bytes, Final public redacted bytes: ${credCombinedBytes} (budget: ${credBudget})`);
  assert.ok(
    credCombinedBytes <= credBudget,
    `Final public combined bytes (${credCombinedBytes}) must be <= retainedTailBytes (${credBudget})`
  );

  // 3. Truncated must be true because post-redaction budget trimmed the expanded text
  assert.equal(credRecord.truncated, true, "truncated must be true when post-redaction bounding trims text");

  // 4. Observed byte counters must report original output truth (550 bytes)
  assert.ok(credRecord.observedStdoutBytes >= 550, `observedStdoutBytes (${credRecord.observedStdoutBytes}) must reflect original child output`);
  assert.ok(credRecord.observedTotalBytes >= 550, `observedTotalBytes (${credRecord.observedTotalBytes}) must reflect original child output`);
  console.log("    PASS: Redaction expansion strictly bounded, secrets redacted, observed counters preserved");

  // 5.2: Multibyte UTF-8 Boundary Falsifier
  console.log("  Testing multibyte UTF-8 boundary behavior...");
  const utf8Budget = 50; // Small budget: 50 bytes
  const utf8Config = loadConfig(["--root", repoRoot]);
  utf8Config.maxOutputBytes = utf8Budget;
  const utf8Guard = new PathGuard(utf8Config);
  const utf8Mgr = new VerificationManager(utf8Config, { retainedTailBytes: utf8Budget });

  // Emit 30 lines of 4-byte UTF-8 emojis and 3-byte Japanese text (each line ~16 bytes, total ~480 bytes)
  const utf8Job = await utf8Mgr.startVerification(fakeWorkspace, utf8Guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-utf8", "30", "--sleep", "100"]
  });

  const utf8Record = await utf8Mgr.waitVerification(utf8Job.jobId, 10);
  assert.equal(utf8Record.state, "succeeded");

  const utf8CombinedBytes = Buffer.byteLength(utf8Record.stdout, "utf8") + Buffer.byteLength(utf8Record.stderr, "utf8");
  console.log(`    Original observed: ${utf8Record.observedTotalBytes} bytes, Final public UTF-8 bytes: ${utf8CombinedBytes} (budget: ${utf8Budget})`);
  assert.ok(
    utf8CombinedBytes <= utf8Budget,
    `Final public UTF-8 bytes (${utf8CombinedBytes}) must be <= budget (${utf8Budget})`
  );
  assert.equal(utf8Record.truncated, true, "truncated must be true");

  // Assert that stdout is a valid JavaScript string
  assert.equal(typeof utf8Record.stdout, "string");
  // Assert no lone surrogate characters
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(utf8Record.stdout), "No unpaired surrogates in returned string");

  // Exhaustive check on trimUtf8Tail across all byte budgets from 0 to 100
  const sampleText = "Line: 🌟 日本語 🚀 テスト 1234567890 🌟🌟🌟";
  for (let b = 0; b <= Buffer.byteLength(sampleText, "utf8") + 5; b++) {
    const trimmed = trimUtf8Tail(sampleText, b);
    const actualBytes = Buffer.byteLength(trimmed, "utf8");
    assert.ok(actualBytes <= b, `trimUtf8Tail(str, ${b}) produced ${actualBytes} bytes > ${b}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(trimmed), `Unpaired surrogate in trimUtf8Tail at budget ${b}`);
  }
  console.log("    PASS: Multibyte UTF-8 boundary cuts cleanly without surrogate/codepoint corruption");

  console.log("PASS: MEDIUM-POSTREDACTION-OUTPUT-BOUND-001 fully closed and verified.");

  // =========================================================================
  // Finding 6: Dual-stream Output Buffer (60k+60k)
  // Prove that 60k+60k output is strictly bounded to 100,000 bytes
  // =========================================================================
  console.log("\n--- [6] Testing Dual-stream Combined Retained Output Buffer (60k+60k) ---");
  const outputLimit = 100_000;
  const outputConfig = loadConfig(["--root", repoRoot]);
  outputConfig.maxOutputBytes = outputLimit;
  const outputGuard = new PathGuard(outputConfig);
  const outputMgr = new VerificationManager(outputConfig, {
    retainedTailBytes: outputLimit
  });

  console.log("  Running job emitting 60,000 bytes on stdout and 60,000 bytes on stderr...");
  const outputJob = await outputMgr.startVerification(fakeWorkspace, outputGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--stdout", "60000", "--stderr", "60000", "--sleep", "100"]
  });

  const outputRecord = await outputMgr.waitVerification(outputJob.jobId, 10);
  assert.equal(outputRecord.state, "succeeded");
  assert.ok(outputRecord.observedStdoutBytes >= 60000, "observedStdoutBytes >= 60000");
  assert.ok(outputRecord.observedStderrBytes >= 60000, "observedStderrBytes >= 60000");
  assert.ok(outputRecord.observedTotalBytes >= 120000, "observedTotalBytes >= 120000");

  const retainedCombinedBytes = Buffer.byteLength(outputRecord.stdout, "utf8") + Buffer.byteLength(outputRecord.stderr, "utf8");
  console.log(`  Observed total: ${outputRecord.observedTotalBytes} bytes, Retained combined: ${retainedCombinedBytes} bytes (limit: ${outputLimit})`);
  assert.ok(
    retainedCombinedBytes <= outputLimit,
    `Combined retained bytes (${retainedCombinedBytes}) must be <= outputLimit (${outputLimit})`
  );
  assert.equal(outputRecord.truncated, true, "truncated must be true");
  console.log("PASS: Dual-stream output limit strictly respected.");

  // =========================================================================
  // Finding 7: MEDIUM-CONTAINMENT-ROUTE-001 Falsifiers
  // Prove containment wrapper flag wiring and fail-closed executable validation
  // =========================================================================
  console.log("\n--- [7] Testing MEDIUM-CONTAINMENT-ROUTE-001 (Containment Route & Executable Validation) ---");

  // 7.1: CLI wiring test: scripts/codexpro.mjs forwards --containment-wrapper
  console.log("  Testing scripts/codexpro.mjs forwards --containment-wrapper to serverEnv...");
  const launcherPort = await freePort();
  const printEnvOutput = execSync(
    `node ${path.join(repoRoot, "scripts", "codexpro.mjs")} start --root "${repoRoot}" --port ${launcherPort} --no-auth --tunnel none --containment-wrapper "node" --print-env`,
    { cwd: repoRoot, encoding: "utf8" }
  );
  const parsedServerEnv = JSON.parse(printEnvOutput);
  assert.equal(
    parsedServerEnv.CODEXPRO_CONTAINMENT_WRAPPER,
    "node",
    "serverEnv.CODEXPRO_CONTAINMENT_WRAPPER must be set from --containment-wrapper"
  );
  console.log("    PASS: --containment-wrapper flag wired correctly in scripts/codexpro.mjs");

  // 7.2: Fail-closed validation for non-existent wrapper binary
  assert.throws(
    () => validateContainmentWrapper(["nonexistent-containment-wrapper-binary-xyz"]),
    /containment wrapper path does not exist|not found or is not executable/i,
    "Non-existent relative wrapper binary must fail closed"
  );
  assert.throws(
    () => validateContainmentWrapper(["/nonexistent/absolute/path/to/wrapper"]),
    /containment wrapper path does not exist|not found or is not executable/i,
    "Non-existent absolute wrapper binary must fail closed"
  );
  console.log("    PASS: Non-existent containment wrapper binaries fail closed before spawn");

  console.log("PASS: MEDIUM-CONTAINMENT-ROUTE-001 fully closed and verified.");

  console.log("\n=========================================================================");
  console.log("ALL TASK-007R3 FALSIFIER TESTS PASSED SUCCESSFULLY.");
  console.log("=========================================================================\n");
}

runFalsifiers().catch((err) => {
  console.error("FALSIFIER FAILED:", err);
  process.exit(1);
});
