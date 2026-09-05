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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

console.log("# RepoConnect M009 TASK-007R5 Comprehensive Falsifiers");

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

function isPidDead(pid) {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code === "ESRCH") return true;
  }
  // Defunct/zombie processes in Linux have terminated but await init/subreaper reaping
  try {
    const stat = fsNative.readFileSync(`/proc/${pid}/stat`, "utf8").trim();
    const lastParen = stat.lastIndexOf(")");
    if (lastParen !== -1) {
      const state = stat.slice(lastParen + 2).split(" ")[0];
      if (state === "Z" || state === "X") return true;
    }
  } catch (e) {
    if (e.code === "ENOENT") return true;
  }
  return false;
}

function isPidAlive(pid) {
  return !isPidDead(pid);
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
  // =========================================================================
  console.log("\n--- [3] Testing HIGH-HTTP-SHUTDOWN-PROOF-001 (Real-HTTP Owned Descendant Shutdown Proof) ---");

  // 3.1: Start independent unrelated decoy process
  console.log("  Spawning unrelated decoy verification-fixture process...");
  const decoyChild = spawn(process.execPath, [
    path.join(repoRoot, "scripts", "verification-fixture.mjs"),
    "--sleep", "60000"
  ], {
    stdio: "ignore",
    detached: true
  });
  const decoyPid = decoyChild.pid;
  assert.ok(decoyPid, "Decoy process must have spawned");
  console.log(`  Decoy process spawned with PID: ${decoyPid}`);

  // 3.2: Spawn real HTTP server on dynamic free port
  const testPort = await freePort();
  console.log(`  Spawning real HTTP process on port ${testPort}...`);
  const httpChild = spawn(
    process.execPath,
    [path.join(repoRoot, "dist", "http.js"), "--port", String(testPort), "--root", repoRoot, "--bash", "safe"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1" }
    }
  );
  const httpPid = httpChild.pid;
  assert.ok(httpPid, "HTTP server process must have spawned");
  console.log(`  HTTP process spawned with PID: ${httpPid}`);

  let httpReady = false;
  httpChild.stderr.on("data", (chunk) => {
    if (chunk.toString().includes("HTTP MCP listening")) httpReady = true;
  });
  for (let i = 0; i < 50; i++) {
    if (httpReady) break;
    await sleep(100);
  }
  assert.ok(httpReady, "HTTP server must be listening");

  // Connect client via StreamableHTTPClientTransport
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${testPort}/mcp`));
  const client = new Client({ name: "r5-test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log("  Connected MCP client to HTTP server.");

  // 3.3: Start lawful verification job via MCP client
  const startRes = await client.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "30000"]
    }
  });
  assert.ok(startRes.structuredContent?.jobId, "Job ID must be returned");
  const activeJobId = startRes.structuredContent.jobId;
  const activeGenId = startRes.structuredContent.generationId;
  console.log(`  Job started with ID: ${activeJobId}, Gen: ${activeGenId}`);

  // Give process tree time to settle
  await sleep(1000);

  // 3.4: Discover all descendant processes rooted at httpPid
  console.log(`  Discovering descendant tree rooted at HTTP process PID ${httpPid}...`);
  const descendants = getDescendantPids(httpPid);
  assert.ok(descendants.size > 0, "HTTP process must have at least one descendant process");
  console.log(`  Discovered ${descendants.size} descendant processes: [${[...descendants].join(", ")}]`);

  // Assert decoy is NOT a descendant of HTTP process
  assert.ok(!descendants.has(decoyPid), "Decoy PID must not be in HTTP process descendant tree");
  console.log(`  PROVED: Decoy PID ${decoyPid} is NOT an owned descendant of HTTP PID ${httpPid}`);

  // 3.5: Send SIGTERM to HTTP parent process (simulating controlled process shutdown)
  console.log(`  Sending SIGTERM to HTTP parent process (PID ${httpPid}) without cancelling job...`);
  const exitPromise = new Promise((resolve) => {
    httpChild.on("exit", (code, signal) => resolve({ code, signal }));
  });
  process.kill(httpPid, "SIGTERM");

  const exitResult = await exitPromise;
  console.log(`  HTTP parent process exited with code ${exitResult.code}, signal ${exitResult.signal}`);
  assert.equal(exitResult.code, 0, "HTTP server must exit 0 on SIGTERM");

  // 3.6: Verify all owned descendant processes are terminated
  console.log("  Verifying all owned descendants are terminated...");
  for (const pid of descendants) {
    let dead = false;
    for (let i = 0; i < 30; i++) {
      if (isPidDead(pid)) {
        dead = true;
        break;
      }
      await sleep(100);
    }
    assert.ok(dead, `Descendant PID ${pid} must be dead after HTTP process shutdown`);
    console.log(`    PID ${pid}: DEAD confirmed`);
  }

  // 3.7: Verify decoy process is STILL ALIVE
  assert.ok(isPidAlive(decoyPid), `Decoy PID ${decoyPid} must still be alive`);
  console.log(`  PROVED: Decoy PID ${decoyPid} survived HTTP shutdown (not killed because not an owned descendant)`);

  // Cleanup decoy
  console.log("  Cleaning up decoy process...");
  try { process.kill(decoyPid, "SIGKILL"); } catch {}
  console.log("  Decoy process cleaned up.");
  console.log("PASS: HIGH-HTTP-SHUTDOWN-PROOF-001 fully closed and verified.");

  // =========================================================================
  // Finding 4: HIGH-SHUTDOWN-ADMISSION-RACE-001 Direct Manager Admission Race
  // =========================================================================
  console.log("\n--- [4] Testing HIGH-SHUTDOWN-ADMISSION-RACE-001 (Direct Manager Admission Race) ---");

  const raceConfig = loadConfig(["--root", repoRoot, "--bash", "safe"]);
  const raceGuard = new PathGuard(raceConfig);
  const raceMgr = new VerificationManager(raceConfig);

  assert.equal(raceMgr.state, "open", "Initial manager state must be open");

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

  const slowChildPid = raceMgr.getJob(slowJob.jobId)?.childProcess?.pid;
  assert.ok(slowChildPid, "Running job must have an active child process PID");

  console.log("  Initiating manager.close() while slow job is active...");
  const closePromise = raceMgr.close();
  assert.equal(raceMgr.state, "closing", "Manager must synchronously transition to closing state");

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

  assert.equal(raceMgr.getActiveCount(), 1, "Active jobs count must not increase on rejected start");
  assert.equal(raceMgr.getTotalCount(), 1, "Total jobs count must remain exactly 1");
  console.log("    PASS: Total jobs count remained 1; zero child processes spawned for rejected start");

  await closePromise;
  assert.equal(raceMgr.state, "closed", "Manager must transition to closed once close() resolves");

  assert.equal(raceMgr.getActiveCount(), 0, "Active jobs count must be 0 after close()");
  const cancelledRecord = raceMgr.getJobRecord(slowJob.jobId);
  assert.equal(cancelledRecord.state, "cancelled", "Slow job must be cancelled by close()");

  let slowChildDead = false;
  for (let i = 0; i < 30; i++) {
    if (isPidDead(slowChildPid)) {
      slowChildDead = true;
      break;
    }
    await sleep(100);
  }
  assert.ok(slowChildDead, `Slow job child PID ${slowChildPid} must be dead after close()`);
  console.log(`    PID ${slowChildPid}: DEAD confirmed`);

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

  console.log("  Calling second close() to verify idempotency...");
  await raceMgr.close();
  assert.equal(raceMgr.state, "closed", "Second close() must be a harmless no-op");
  console.log("    PASS: second close() is idempotent and safe");

  console.log("PASS: HIGH-SHUTDOWN-ADMISSION-RACE-001 fully closed and verified.");

  // =========================================================================
  // Finding 5: MEDIUM-SHUTDOWN-RACE-PROOF-002 Real-HTTP Controlled-Shutdown Race
  // Genuine concurrent requests + strict transport-catch isolation
  // =========================================================================
  console.log("\n--- [5] Testing MEDIUM-SHUTDOWN-RACE-PROOF-002 (Real-HTTP Controlled-Shutdown Race) ---");

  console.log("  Spawning unrelated decoy process for HTTP race test...");
  const httpRaceDecoy = spawn(process.execPath, [
    path.join(repoRoot, "scripts", "verification-fixture.mjs"),
    "--sleep", "60000"
  ], {
    stdio: "ignore",
    detached: true
  });
  const httpRaceDecoyPid = httpRaceDecoy.pid;
  assert.ok(httpRaceDecoyPid, "HTTP race decoy must have spawned");

  const raceHttpPort = await freePort();
  console.log(`  Spawning real HTTP server on port ${raceHttpPort}...`);
  const raceHttpChild = spawn(
    process.execPath,
    [path.join(repoRoot, "dist", "http.js"), "--port", String(raceHttpPort), "--root", repoRoot, "--bash", "safe"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1" }
    }
  );
  const raceHttpPid = raceHttpChild.pid;
  assert.ok(raceHttpPid, "Race HTTP server must have spawned");

  let raceHttpReady = false;
  raceHttpChild.stderr.on("data", (chunk) => {
    if (chunk.toString().includes("HTTP MCP listening")) raceHttpReady = true;
  });
  for (let i = 0; i < 50; i++) {
    if (raceHttpReady) break;
    await sleep(100);
  }
  assert.ok(raceHttpReady, "Race HTTP server must be listening");

  const raceHttpTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${raceHttpPort}/mcp`));
  const raceHttpClient = new Client({ name: "r5-http-race-client", version: "1.0.0" }, { capabilities: {} });
  await raceHttpClient.connect(raceHttpTransport);

  // 5.1: Start lawful long-running managed verification
  console.log("  Starting initial lawful verification job on HTTP server...");
  const initHttpJob = await raceHttpClient.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "30000"]
    }
  });
  assert.ok(initHttpJob.structuredContent?.jobId, "Initial HTTP job must have started");
  console.log(`    Initial HTTP job started: ${initHttpJob.structuredContent.jobId}`);

  await sleep(1000);
  const preSignalDescendants = getDescendantPids(raceHttpPid);
  assert.ok(preSignalDescendants.size > 0, "HTTP server must have active verification descendants");
  assert.ok(!preSignalDescendants.has(httpRaceDecoyPid), "Decoy must not be an HTTP descendant");
  console.log(`    Discovered ${preSignalDescendants.size} descendants before signal: [${[...preSignalDescendants].join(", ")}]`);

  // 5.2: Send SIGTERM to HTTP server and deliberately issue 5 genuinely concurrent late starts
  console.log("  Sending SIGTERM to HTTP server and launching 5 concurrent late start requests...");
  const httpExitPromise = new Promise((resolve) => {
    raceHttpChild.on("exit", (code, signal) => resolve({ code, signal }));
  });
  process.kill(raceHttpPid, "SIGTERM");

  // Construct all 5 call promises concurrently without awaiting them sequentially
  const latePromises = Array.from({ length: 5 }, (_, i) => {
    return (async () => {
      let callResult;
      try {
        callResult = await raceHttpClient.callTool({
          name: "start_verification",
          arguments: {
            workspace_id: realWsId,
            runner: "package_script",
            package_manager: "npm",
            script: "verification:fixture",
            args: ["--sleep", "10000"]
          }
        });
      } catch (transportErr) {
        // ONLY errors thrown directly by callTool / transport are classified as transport_closed
        return {
          call: i,
          disposition: "transport_closed",
          error: transportErr.message
        };
      }

      // Result validation is executed strictly OUTSIDE the transport catch
      const isToolError = Boolean(callResult.isError);
      assert.ok(isToolError, `Late call #${i} must NOT succeed as a valid job`);
      assert.ok(!callResult.structuredContent?.jobId, `Late call #${i} must not return a new jobId`);

      const text = callResult.content?.map((c) => c.text).join(" ") || "";
      const isClosingError = /verification manager is closing|verification_manager_closing/i.test(text);
      assert.ok(isClosingError, `Late call #${i} must indicate manager closing; got: ${text}`);

      return {
        call: i,
        disposition: "tool_error_closing",
        isError: true,
        text
      };
    })();
  });

  // Await settlement of all concurrent calls
  const settled = await Promise.allSettled(latePromises);
  const lateDispositions = [];
  for (const s of settled) {
    if (s.status === "rejected") {
      // An assertion failure occurred in validation: MUST fail the test!
      throw s.reason;
    }
    lateDispositions.push(s.value);
  }

  console.log(`    Late start dispositions recorded (${lateDispositions.length}):`, lateDispositions);
  assert.equal(lateDispositions.length, 5, "All 5 late start calls must have been recorded");
  for (const d of lateDispositions) {
    assert.ok(
      ["tool_error_closing", "transport_closed"].includes(d.disposition),
      `Disposition must be one of accepted set: ${d.disposition}`
    );
  }

  // 5.3: Await parent exit and observe descendants during/after shutdown
  const raceHttpExit = await httpExitPromise;
  console.log(`    HTTP server exited with code ${raceHttpExit.code}, signal ${raceHttpExit.signal}`);
  assert.equal(raceHttpExit.code, 0, "HTTP server must exit 0 on SIGTERM");

  // Re-enumerate descendants until none remain
  console.log("  Re-enumerating descendants to confirm complete termination...");
  let remainingDescendants = getDescendantPids(raceHttpPid);
  for (let i = 0; i < 30; i++) {
    if (remainingDescendants.size === 0) break;
    await sleep(100);
    remainingDescendants = getDescendantPids(raceHttpPid);
  }
  assert.equal(remainingDescendants.size, 0, "All HTTP descendants must be gone after shutdown");

  for (const pid of preSignalDescendants) {
    let dead = false;
    for (let i = 0; i < 30; i++) {
      if (isPidDead(pid)) {
        dead = true;
        break;
      }
      await sleep(100);
    }
    assert.ok(dead, `Descendant PID ${pid} must be dead`);
  }
  console.log("    PASS: All HTTP descendants verified dead");

  // 5.4: Prove decoy is alive
  assert.ok(isPidAlive(httpRaceDecoyPid), "Decoy must remain alive after HTTP server shutdown");
  console.log("    PASS: Decoy process survived HTTP server shutdown");

  try { process.kill(httpRaceDecoyPid, "SIGKILL"); } catch {}
  console.log("PASS: MEDIUM-SHUTDOWN-RACE-PROOF-002 (Real-HTTP) fully closed and verified.");

  // =========================================================================
  // Finding 6: MEDIUM-SHUTDOWN-RACE-PROOF-002 Real-Stdio Controlled-Shutdown Race
  // Genuine concurrent requests + strict transport-catch isolation
  // =========================================================================
  console.log("\n--- [6] Testing MEDIUM-SHUTDOWN-RACE-PROOF-002 (Real-Stdio Controlled-Shutdown Race) ---");

  console.log("  Spawning unrelated decoy process for stdio race test...");
  const stdioRaceDecoy = spawn(process.execPath, [
    path.join(repoRoot, "scripts", "verification-fixture.mjs"),
    "--sleep", "60000"
  ], {
    stdio: "ignore",
    detached: true
  });
  const stdioRaceDecoyPid = stdioRaceDecoy.pid;
  assert.ok(stdioRaceDecoyPid, "Stdio race decoy must have spawned");

  console.log("  Starting real stdio server via StdioClientTransport...");
  const stdioTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repoRoot, "dist", "stdio.js"), "--root", repoRoot, "--bash", "safe"]
  });
  const stdioClient = new Client({ name: "r5-stdio-race-client", version: "1.0.0" }, { capabilities: {} });
  await stdioClient.connect(stdioTransport);

  const stdioPid = stdioTransport._process?.pid;
  assert.ok(stdioPid, "Stdio server process must have an active PID");
  console.log(`  Stdio server running with PID: ${stdioPid}`);

  console.log("  Starting initial lawful verification job on stdio server...");
  const initStdioJob = await stdioClient.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "30000"]
    }
  });
  assert.ok(initStdioJob.structuredContent?.jobId, "Initial stdio job must have started");
  console.log(`    Initial stdio job started: ${initStdioJob.structuredContent.jobId}`);

  await sleep(1000);
  const stdioDescendants = getDescendantPids(stdioPid);
  assert.ok(stdioDescendants.size > 0, "Stdio server must have active verification descendants");
  assert.ok(!stdioDescendants.has(stdioRaceDecoyPid), "Decoy must not be in stdio descendant tree");
  console.log(`    Discovered ${stdioDescendants.size} stdio descendants: [${[...stdioDescendants].join(", ")}]`);

  console.log("  Sending SIGTERM to stdio server and launching 5 concurrent late start requests...");
  const stdioExitPromise = new Promise((resolve) => {
    stdioTransport._process.on("exit", (code, signal) => resolve({ code, signal }));
  });
  process.kill(stdioPid, "SIGTERM");

  // Construct all 5 stdio late call promises concurrently
  const stdioLatePromises = Array.from({ length: 5 }, (_, i) => {
    return (async () => {
      let callResult;
      try {
        callResult = await stdioClient.callTool({
          name: "start_verification",
          arguments: {
            workspace_id: realWsId,
            runner: "package_script",
            package_manager: "npm",
            script: "verification:fixture",
            args: ["--sleep", "10000"]
          }
        });
      } catch (transportErr) {
        // ONLY errors thrown directly by callTool / transport are classified as transport_closed
        return {
          call: i,
          disposition: "transport_closed",
          error: transportErr.message
        };
      }

      // Result validation is executed strictly OUTSIDE the transport catch
      const isToolError = Boolean(callResult.isError);
      assert.ok(isToolError, `Late stdio call #${i} must NOT succeed as a valid job`);
      assert.ok(!callResult.structuredContent?.jobId, `Late stdio call #${i} must not return a new jobId`);

      const text = callResult.content?.map((c) => c.text).join(" ") || "";
      const isClosingError = /verification manager is closing|verification_manager_closing/i.test(text);
      assert.ok(isClosingError, `Late stdio call #${i} must indicate manager closing; got: ${text}`);

      return {
        call: i,
        disposition: "tool_error_closing",
        isError: true,
        text
      };
    })();
  });

  const stdioSettled = await Promise.allSettled(stdioLatePromises);
  const stdioLateDispositions = [];
  for (const s of stdioSettled) {
    if (s.status === "rejected") {
      throw s.reason;
    }
    stdioLateDispositions.push(s.value);
  }

  console.log(`    Stdio late start dispositions recorded (${stdioLateDispositions.length}):`, stdioLateDispositions);
  assert.equal(stdioLateDispositions.length, 5, "All 5 stdio late start calls must have been recorded");
  for (const d of stdioLateDispositions) {
    assert.ok(
      ["tool_error_closing", "transport_closed"].includes(d.disposition),
      `Stdio disposition must be one of accepted set: ${d.disposition}`
    );
  }

  const stdioExit = await stdioExitPromise;
  console.log(`    Stdio server exited with code ${stdioExit.code}, signal ${stdioExit.signal}`);
  assert.equal(stdioExit.code, 0, "Stdio server must exit 0 on SIGTERM");

  console.log("  Re-enumerating stdio descendants to confirm complete termination...");
  let remainingStdioDescendants = getDescendantPids(stdioPid);
  for (let i = 0; i < 30; i++) {
    if (remainingStdioDescendants.size === 0) break;
    await sleep(100);
    remainingStdioDescendants = getDescendantPids(stdioPid);
  }
  assert.equal(remainingStdioDescendants.size, 0, "All stdio descendants must be gone after shutdown");

  for (const pid of stdioDescendants) {
    let dead = false;
    for (let i = 0; i < 30; i++) {
      if (isPidDead(pid)) {
        dead = true;
        break;
      }
      await sleep(100);
    }
    assert.ok(dead, `Descendant PID ${pid} must be dead`);
  }
  console.log("    PASS: All stdio descendants verified dead");

  assert.ok(isPidAlive(stdioRaceDecoyPid), "Decoy must remain alive after stdio server shutdown");
  console.log("    PASS: Decoy process survived stdio server shutdown");

  try { process.kill(stdioRaceDecoyPid, "SIGKILL"); } catch {}
  console.log("PASS: MEDIUM-SHUTDOWN-RACE-PROOF-002 (Real-Stdio) fully closed and verified.");

  // =========================================================================
  // Finding 7: HIGH-STREAMING-REDACTION-SPLIT-001 Falsifiers
  // Internal overlong-line split, ordinary credential, transport, running-state peek,
  // repeated pressure, and preserved R4 regressions
  // =========================================================================
  console.log("\n--- [7] Testing HIGH-STREAMING-REDACTION-SPLIT-001 (Overlong Split & Tail Invariant) ---");

  // 7.1: Mandatory Falsifier A — Exact internal-split ordinary credential witness
  console.log("  Testing 7.1: Exact internal-split ordinary credential witness (Witness A)...");
  const synthSecretVal = "syntheticordinarysecret999";
  const budget71 = 3000;
  const config71 = loadConfig(["--root", repoRoot]);
  config71.maxOutputBytes = budget71;
  const guard71 = new PathGuard(config71);
  const mgr71 = new VerificationManager(config71, { retainedTailBytes: budget71 });

  // A newline-free line > 4096 characters, positioning MY_CUSTOM_SECRET_KEY so its
  // boundary straddles character 2048 (the redactor's internal split point)
  const job71 = await mgr71.startVerification(fakeWorkspace, guard71, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-overlong-credential", "--exit", "0"]
  });
  const res71 = await mgr71.waitVerification(job71.jobId, 5000);

  assert.ok(!res71.stdout.includes(synthSecretVal), `stdout must NOT contain ${synthSecretVal}`);
  assert.ok(!res71.stderr.includes(synthSecretVal), `stderr must NOT contain ${synthSecretVal}`);
  assert.ok(!JSON.stringify(res71).includes(synthSecretVal), `structured content must NOT contain ${synthSecretVal}`);
  assert.ok(res71.stdout.includes("REDACTED_SECRET"), "stdout must contain REDACTED_SECRET");
  const combinedBytes71 = Buffer.byteLength(res71.stdout, "utf8") + Buffer.byteLength(res71.stderr, "utf8");
  assert.ok(combinedBytes71 <= budget71, `Combined UTF-8 bytes (${combinedBytes71}) must be <= budget (${budget71})`);
  assert.ok(res71.observedStdoutBytes >= 2030 + 20 + synthSecretVal.length + 2500, "observedStdoutBytes must reflect unredacted raw physical bytes");
  assert.equal(res71.truncated, true, "Job must be marked truncated");
  console.log("    PASS 7.1: Witness A (exact internal-split ordinary credential) verified absent, bounded, and truthful");

  // 7.2: Mandatory Falsifier B — Internal-split transport/direct-pattern witness
  console.log("  Testing 7.2: Internal-split transport/direct-pattern witness (Witness B)...");
  const synthAuthVal = "syntheticauthsecret789";
  const budget72 = 5000;
  const config72 = loadConfig(["--root", repoRoot]);
  config72.maxOutputBytes = budget72;
  const guard72 = new PathGuard(config72);
  const mgr72 = new VerificationManager(config72, { retainedTailBytes: budget72 });

  const job72 = await mgr72.startVerification(fakeWorkspace, guard72, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-overlong-authorization", "--exit", "0"]
  });
  const res72 = await mgr72.waitVerification(job72.jobId, 5000);

  assert.ok(!res72.stdout.includes(synthAuthVal), `stdout must NOT contain ${synthAuthVal}`);
  assert.ok(!res72.stderr.includes(synthAuthVal), `stderr must NOT contain ${synthAuthVal}`);
  assert.ok(!JSON.stringify(res72).includes(synthAuthVal), `structured content must NOT contain ${synthAuthVal}`);
  assert.ok(res72.stdout.includes("REDACTED_SECRET"), "stdout must contain REDACTED_SECRET");
  console.log("    PASS 7.2: Witness B (internal-split transport pattern) preserved without value leakage");

  // 7.3: Mandatory Falsifier C — Running-state / peekPending() witness
  console.log("  Testing 7.3: Running-state / peekPending() witness (Witness C)...");
  const runningSecretVal = "syntheticordinarysecret999";
  const config73 = loadConfig(["--root", repoRoot]);
  const guard73 = new PathGuard(config73);
  const mgr73 = new VerificationManager(config73);

  // Start job emitting overlong newline-free sensitive line but remaining running
  const job73 = await mgr73.startVerification(fakeWorkspace, guard73, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-overlong-credential", "--sleep", "30000"]
  });

  // Call wait_verification while the job is still running (1 s timeout)
  const resRunning = await mgr73.waitVerification(job73.jobId, 1);
  assert.equal(resRunning.state, "running", "Job must be observed in running state");
  assert.ok(!resRunning.stdout.includes(runningSecretVal), `Running stdout must NOT reveal ${runningSecretVal}`);
  assert.ok(!resRunning.stderr.includes(runningSecretVal), `Running stderr must NOT reveal ${runningSecretVal}`);
  assert.ok(!JSON.stringify(resRunning).includes(runningSecretVal), `Running structured record must NOT reveal ${runningSecretVal}`);
  console.log("    PASS 7.3a: peekPending() during active running state does NOT leak sensitive fragment");

  // Terminate the job and verify terminal record remains completely safe
  await mgr73.cancelVerification(job73.jobId);
  const resTerminal = await mgr73.waitVerification(job73.jobId, 5);
  assert.ok(resTerminal.state === "cancelled" || resTerminal.state === "failed", "Job must be terminal");
  assert.ok(!resTerminal.stdout.includes(runningSecretVal), `Terminal stdout must NOT reveal ${runningSecretVal}`);
  assert.ok(!resTerminal.stderr.includes(runningSecretVal), `Terminal stderr must NOT reveal ${runningSecretVal}`);
  assert.ok(!JSON.stringify(resTerminal).includes(runningSecretVal), `Terminal structured record must NOT reveal ${runningSecretVal}`);
  console.log("    PASS 7.3b: Terminal record after flush remains safe");

  // 7.4: Mandatory Falsifier D — Repeated internal-split pressure
  console.log("  Testing 7.4: Repeated internal-split pressure witness (Witness D)...");
  const pVal1 = "repeatedsecretone111";
  const pVal2 = "repeatedsecrettwo222";
  const pVal3 = "repeatedsecretthree333";
  const config74 = loadConfig(["--root", repoRoot]);
  const guard74 = new PathGuard(config74);
  const mgr74 = new VerificationManager(config74);

  const job74 = await mgr74.startVerification(fakeWorkspace, guard74, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-overlong-repeated", "--exit", "0"]
  });
  const res74 = await mgr74.waitVerification(job74.jobId, 5000);

  assert.ok(!res74.stdout.includes(pVal1), `stdout must NOT contain ${pVal1}`);
  assert.ok(!res74.stdout.includes(pVal2), `stdout must NOT contain ${pVal2}`);
  assert.ok(!res74.stdout.includes(pVal3), `stdout must NOT contain ${pVal3}`);
  assert.ok(!JSON.stringify(res74).includes(pVal1), `record must NOT contain ${pVal1}`);
  assert.ok(!JSON.stringify(res74).includes(pVal2), `record must NOT contain ${pVal2}`);
  assert.ok(!JSON.stringify(res74).includes(pVal3), `record must NOT contain ${pVal3}`);
  console.log("    PASS 7.4: Witness D (repeated internal-split pressure) verified across all boundaries");

  // 7.5: Mandatory Falsifier E — Preserve R4 regressions
  console.log("  Testing 7.5: Preserved R4 regressions (Witness E)...");

  // E.1: Prefix-cut ordinary credential witness
  const fakeSecretVal = "ordinarysecret123";
  const budgetA = 24;
  const configA = loadConfig(["--root", repoRoot]);
  configA.maxOutputBytes = budgetA;
  const guardA = new PathGuard(configA);
  const mgrA = new VerificationManager(configA, { retainedTailBytes: budgetA });

  const jobA = await mgrA.startVerification(fakeWorkspace, guardA, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-prefix-credential", "MY_SUPER_SECRET_TOKEN", fakeSecretVal, "--exit", "0"]
  });
  const resA = await mgrA.waitVerification(jobA.jobId, 5000);
  assert.ok(!resA.stdout.includes(fakeSecretVal), `stdout must NOT contain ${fakeSecretVal}`);
  assert.ok(!resA.stderr.includes(fakeSecretVal), `stderr must NOT contain ${fakeSecretVal}`);
  assert.ok(resA.stdout.includes("REDACTED_SECRET"), "stdout must contain REDACTED_SECRET");
  assert.ok(Buffer.byteLength(resA.stdout, "utf8") + Buffer.byteLength(resA.stderr, "utf8") <= budgetA, "Returned UTF-8 bytes must be <= budget");
  assert.equal(resA.truncated, true, "truncated must be true");
  assert.ok(resA.observedStdoutBytes >= `MY_SUPER_SECRET_TOKEN=${fakeSecretVal}\n`.length, "observedStdoutBytes truthful");
  console.log("    PASS E.1: Prefix-cut ordinary credential withheld, truncated=true, observed bytes truthful");

  // E.2: Chunk-boundary credential witness
  const fakePassVal = "ordinarypass456";
  const budgetB = 40;
  const configB = loadConfig(["--root", repoRoot]);
  configB.maxOutputBytes = budgetB;
  const guardB = new PathGuard(configB);
  const mgrB = new VerificationManager(configB, { retainedTailBytes: budgetB });

  const jobB = await mgrB.startVerification(fakeWorkspace, guardB, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-chunk-credential", "ADMIN_PASSWORD", fakePassVal, "80", "--exit", "0"]
  });
  const resB = await mgrB.waitVerification(jobB.jobId, 5000);
  assert.ok(!resB.stdout.includes(fakePassVal), `stdout must NOT contain ${fakePassVal}`);
  assert.ok(!resB.stderr.includes(fakePassVal), `stderr must NOT contain ${fakePassVal}`);
  assert.ok(Buffer.byteLength(resB.stdout, "utf8") + Buffer.byteLength(resB.stderr, "utf8") <= budgetB, "Combined bytes <= budget");
  console.log("    PASS E.2: Chunk-boundary split credential redacted safely");

  // E.3: Multiline and unclosed private-key witnesses
  const budgetD = 50;
  const configD = loadConfig(["--root", repoRoot]);
  configD.maxOutputBytes = budgetD;
  const guardD = new PathGuard(configD);
  const mgrD = new VerificationManager(configD, { retainedTailBytes: budgetD });

  const jobD = await mgrD.startVerification(fakeWorkspace, guardD, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-private-key", "50", "--exit", "0"]
  });
  const resD = await mgrD.waitVerification(jobD.jobId, 5000);
  assert.ok(!resD.stdout.includes("fakekeymaterialline"), "Private key body lines must NOT leak");
  assert.ok(!resD.stderr.includes("fakekeymaterialline"), "Private key body lines must NOT leak");

  const jobD2 = await mgrD.startVerification(fakeWorkspace, guardD, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-unclosed-private-key", "20", "--exit", "0"]
  });
  const resD2 = await mgrD.waitVerification(jobD2.jobId, 5000);
  assert.ok(!resD2.stdout.includes("fakeunclosedkeymaterialline"), "Unclosed private key body lines must NOT leak");
  console.log("    PASS E.3: Multiline and unclosed private key bodies safely suppressed");

  // E.4: Redaction-expansion output bound
  const credBudget = 800;
  const credConfig = loadConfig(["--root", repoRoot]);
  credConfig.maxOutputBytes = credBudget;
  const credGuard = new PathGuard(credConfig);
  const credMgr = new VerificationManager(credConfig, { retainedTailBytes: credBudget });

  const credJob = await credMgr.startVerification(fakeWorkspace, credGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-credentials", "50", "--exit", "0"]
  });
  const credRec = await credMgr.waitVerification(credJob.jobId, 5000);
  assert.equal(credRec.state, "succeeded");
  const credStdoutBytes = Buffer.byteLength(credRec.stdout, "utf8");
  const credStderrBytes = Buffer.byteLength(credRec.stderr, "utf8");
  assert.ok(credStdoutBytes + credStderrBytes <= credBudget, `Redacted bytes (${credStdoutBytes + credStderrBytes}) must be <= ${credBudget}`);
  assert.equal(credRec.truncated, true, "Job must be marked truncated");
  console.log("    PASS E.4: Redaction-expansion output strictly bounded");

  // E.5: Multibyte UTF-8 boundary trimming
  const utf8Budget = 25;
  const utf8Config = loadConfig(["--root", repoRoot]);
  utf8Config.maxOutputBytes = utf8Budget;
  const utf8Guard = new PathGuard(utf8Config);
  const utf8Mgr = new VerificationManager(utf8Config, { retainedTailBytes: utf8Budget });

  const utf8Job = await utf8Mgr.startVerification(fakeWorkspace, utf8Guard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--emit-utf8", "30", "--exit", "0"]
  });
  const utf8Rec = await utf8Mgr.waitVerification(utf8Job.jobId, 5000);
  assert.equal(utf8Rec.state, "succeeded");
  const totalUtf8 = Buffer.byteLength(utf8Rec.stdout, "utf8") + Buffer.byteLength(utf8Rec.stderr, "utf8");
  assert.ok(totalUtf8 <= utf8Budget, `Combined UTF-8 bytes (${totalUtf8}) must be <= ${utf8Budget}`);
  assert.ok(!utf8Rec.stdout.includes("\uFFFD"), "stdout must not contain replacement character \\uFFFD");
  console.log("    PASS E.5: Multibyte UTF-8 trimming preserves codepoint boundaries");

  // E.6: Dual stream 60k + 60k
  const dualBudget = 120000;
  const dualConfig = loadConfig(["--root", repoRoot]);
  dualConfig.maxOutputBytes = dualBudget;
  const dualGuard = new PathGuard(dualConfig);
  const dualMgr = new VerificationManager(dualConfig, { retainedTailBytes: dualBudget });

  const dualJob = await dualMgr.startVerification(fakeWorkspace, dualGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--stdout", "60000", "--stderr", "60000", "--exit", "0"]
  });
  const dualRec = await dualMgr.waitVerification(dualJob.jobId, 5000);
  assert.equal(dualRec.state, "succeeded");
  const dualCombined = Buffer.byteLength(dualRec.stdout, "utf8") + Buffer.byteLength(dualRec.stderr, "utf8");
  assert.ok(dualCombined <= dualBudget, `Dual combined (${dualCombined}) must be <= ${dualBudget}`);
  console.log("    PASS E.6: Combined stdout+stderr budget strictly enforced");

  // E.7: Hard output ceiling process termination
  const ceilingBudget = 5000;
  const ceilingLimit = 10000;
  const ceilingConfig = loadConfig(["--root", repoRoot]);
  ceilingConfig.maxOutputBytes = ceilingBudget;
  const ceilingGuard = new PathGuard(ceilingConfig);
  const ceilingMgr = new VerificationManager(ceilingConfig, {
    retainedTailBytes: ceilingBudget,
    hardOutputCeilingBytes: ceilingLimit
  });

  const ceilingJob = await ceilingMgr.startVerification(fakeWorkspace, ceilingGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--stdout", "20000", "--sleep", "10000"]
  });
  const ceilingRec = await ceilingMgr.waitVerification(ceilingJob.jobId, 10000);
  assert.equal(ceilingRec.state, "output_limit_exceeded");
  assert.match(ceilingRec.terminalReason || "", /Output ceiling of 10000 bytes exceeded/i);
  console.log("    PASS E.7: Process terminated on hard output ceiling breach");

  console.log("PASS: HIGH-STREAMING-REDACTION-SPLIT-001 fully closed and verified.");

  // =========================================================================
  // Finding 8: MEDIUM-CONTAINMENT-ROUTE-001 Falsifiers
  // Prove containment wrapper flag wiring and fail-closed executable validation
  // =========================================================================
  console.log("\n--- [8] Testing MEDIUM-CONTAINMENT-ROUTE-001 (Containment Route & Executable Validation) ---");

  // 8.1: CLI wiring test: scripts/codexpro.mjs forwards --containment-wrapper
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

  // 8.2: Fail-closed validation for non-existent wrapper binary
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
  console.log("ALL TASK-007R5 FALSIFIERS PASSED (Groups 1 through 8)");
  console.log("=========================================================================");
}

runFalsifiers().catch((err) => {
  console.error("FALSIFIER FAILURE:", err);
  process.exit(1);
});
