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
  validateContainmentWrapper,
  validatePackageScriptName,
  validateArgs,
  compileRunnerArgv
} from "../dist/verificationOps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const realRepoRoot = fsNative.realpathSync.native(repoRoot);
const realWsId = `ws_${createHash("sha256").update(realRepoRoot).digest("hex").slice(0, 24)}`;

console.log("# RepoConnect M009 TASK-007R2 Comprehensive Falsifiers");

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

  const jobGen2 = await mgrGen2.startVerification(fakeWorkspace, genGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "500"]
  });
  assert.equal(jobGen2.generationId, mgrGen2.generationId);
  assert.notEqual(jobGen2.generationId, jobGen1A.generationId, "Job in fresh manager must have fresh generationId");

  // 2.4: Old job ID in new manager must NOT be resumed and returns not-found
  let oldJobLookupError = null;
  try {
    await mgrGen2.waitVerification(jobGen1A.jobId, 1);
  } catch (err) {
    oldJobLookupError = err;
  }
  assert.ok(oldJobLookupError, "Querying old job ID in fresh manager must fail");
  assert.match(oldJobLookupError.message, /not found or expired/i);

  // Clean up remaining jobs
  await mgrGen1.cancelVerification(jobGen1B.jobId);
  await mgrGen2.cancelVerification(jobGen2.jobId);

  console.log("PASS: HIGH-GENERATION-IDENTITY-001 fully closed and verified.");

  // =========================================================================
  // Finding 3: HIGH-HTTP-SHUTDOWN-PROOF-001 Physical Falsifier
  // Spawn real HTTP process, start lawful verification, spawn unrelated decoy,
  // discover owned descendant tree, assert decoy is NOT a descendant,
  // SIGTERM HTTP process without job cancellation, prove HTTP exits 0,
  // prove all owned descendants DEAD, prove decoy process STILL ALIVE, clean up decoy.
  // =========================================================================
  console.log("\n--- [3] Testing HIGH-HTTP-SHUTDOWN-PROOF-001 (Real-HTTP Owned Descendant Shutdown Proof) ---");
  const httpPort = await freePort();
  const testToken = "test-token-task007r2-shutdown-proof";

  // Step 3.1: Spawn unrelated decoy process running verification-fixture.mjs
  console.log("  Spawning unrelated decoy verification-fixture process...");
  const decoyChild = spawn(process.execPath, [path.join(repoRoot, "scripts", "verification-fixture.mjs"), "--sleep", "60000"], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const decoyPid = decoyChild.pid;
  assert.ok(decoyPid, "Decoy PID must exist");
  console.log(`  Decoy process spawned with PID: ${decoyPid}`);

  // Step 3.2: Spawn real HTTP server process
  console.log(`  Spawning real HTTP process on port ${httpPort}...`);
  const httpChild = spawn(process.execPath, [path.join(repoRoot, "dist", "http.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEXPRO_ROOT: repoRoot,
      CODEXPRO_PORT: String(httpPort),
      CODEXPRO_HOST: "127.0.0.1",
      CODEXPRO_BASH_MODE: "safe",
      CODEXPRO_HTTP_TOKEN: testToken,
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let httpStderr = "";
  httpChild.stderr.on("data", (chunk) => { httpStderr += String(chunk); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      httpChild.kill("SIGTERM");
      decoyChild.kill("SIGKILL");
      reject(new Error(`Timed out waiting for HTTP server:\n${httpStderr}`));
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
      decoyChild.kill("SIGKILL");
      reject(new Error(`HTTP server exited early with code ${code}\n${httpStderr}`));
    });
  });

  console.log(`  HTTP server is listening on port ${httpPort}. Connecting MCP client...`);
  const client = new Client({ name: "r2-falsifier-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${testToken}` } }
  });
  await client.connect(transport);

  // Step 3.3: Start lawful long-running managed verification in real HTTP server
  console.log("  Starting lawful verification job with 30s sleep in real HTTP process...");
  const startRes = await client.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "30000"]
    }
  });
  assert.ok(startRes && !startRes.isError, "start_verification must succeed");
  const jobInfo = startRes.structuredContent;
  assert.equal(jobInfo.state, "running");
  assert.match(jobInfo.generationId, /^vgen_[0-9a-f]{32}$/, "job must have generationId");
  console.log(`  Job started with ID: ${jobInfo.jobId}, Gen: ${jobInfo.generationId}`);

  // Disconnect client cleanly
  await transport.close();

  // Allow process tree to settle
  await sleep(600);

  // Step 3.4: Discover the actual descendant tree rooted at exact spawned HTTP PID
  console.log(`  Discovering descendant tree rooted at HTTP process PID ${httpChild.pid}...`);
  const ownedDescendants = getDescendantPids(httpChild.pid);
  const ownedPidsArray = [...ownedDescendants];
  console.log(`  Discovered ${ownedPidsArray.length} descendant processes: [${ownedPidsArray.join(", ")}]`);
  assert.ok(ownedPidsArray.length > 0, "HTTP server must have spawned child processes for the verification job");

  // Step 3.5: Prove decoy process is NOT in HTTP's descendant tree
  assert.equal(
    ownedDescendants.has(decoyPid),
    false,
    `Decoy PID ${decoyPid} must NOT be in HTTP process's descendant tree [${ownedPidsArray.join(", ")}]`
  );
  console.log(`  PROVED: Decoy PID ${decoyPid} is NOT an owned descendant of HTTP PID ${httpChild.pid}`);

  // Step 3.6: Prove all owned descendants and the decoy are currently alive
  for (const pid of ownedPidsArray) {
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    assert.ok(alive, `Owned descendant PID ${pid} must be alive before shutdown`);
  }

  let decoyAliveBefore = false;
  try {
    process.kill(decoyPid, 0);
    decoyAliveBefore = true;
  } catch {}
  assert.ok(decoyAliveBefore, `Decoy PID ${decoyPid} must be alive before shutdown`);

  // Step 3.7: Send SIGTERM to the HTTP process WITHOUT prior cancellation of the job!
  console.log(`  Sending SIGTERM to HTTP parent process (PID ${httpChild.pid}) without cancelling job...`);
  const httpExitPromise = new Promise((resolve) => {
    httpChild.once("exit", (code, signal) => resolve({ code, signal }));
  });
  httpChild.kill("SIGTERM");

  const httpExit = await httpExitPromise;
  console.log(`  HTTP parent process exited with code ${httpExit.code}, signal ${httpExit.signal}`);
  assert.equal(httpExit.code, 0, "HTTP server must exit cleanly with code 0 on SIGTERM");

  // Step 3.8: Prove every owned descendant PID is DEAD
  console.log("  Verifying all owned descendants are terminated...");
  for (const pid of ownedPidsArray) {
    let dead = false;
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
        await sleep(100);
      } catch (err) {
        if (err.code === "ESRCH") {
          dead = true;
          break;
        }
      }
    }
    assert.ok(dead, `Owned descendant PID ${pid} must be DEAD (ESRCH) after HTTP process SIGTERM`);
    console.log(`    PID ${pid}: DEAD (ESRCH) confirmed`);
  }

  // Step 3.9: Prove unrelated decoy process is STILL ALIVE
  let decoyAliveAfter = false;
  try {
    process.kill(decoyPid, 0);
    decoyAliveAfter = true;
  } catch {}
  assert.ok(decoyAliveAfter, `Decoy PID ${decoyPid} must STILL BE ALIVE after HTTP process SIGTERM`);
  console.log(`  PROVED: Decoy PID ${decoyPid} survived HTTP shutdown (not killed because not an owned descendant)`);

  // Step 3.10: Explicitly clean up decoy process
  console.log("  Cleaning up decoy process...");
  decoyChild.kill("SIGKILL");
  await new Promise((resolve) => decoyChild.once("exit", resolve));
  console.log("  Decoy process cleaned up.");

  console.log("PASS: HIGH-HTTP-SHUTDOWN-PROOF-001 fully closed and verified.");

  // =========================================================================
  // Finding 4: MEDIUM-OUTPUT-BOUND-001 Falsifiers
  // Combined rolling tail buffer bounding retained stdout + stderr
  // =========================================================================
  console.log("\n--- [4] Testing MEDIUM-OUTPUT-BOUND-001 (Combined Retained Output Buffer) ---");
  const outputLimit = 100_000;
  const outputConfig = loadConfig(["--root", repoRoot, "--max-output-bytes", String(outputLimit)]);
  const outputGuard = new PathGuard(outputConfig);
  const outputMgr = new VerificationManager(outputConfig, { retainedTailBytes: outputLimit });

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
  assert.ok(outputRecord.observedStdoutBytes >= 60000);
  assert.ok(outputRecord.observedStderrBytes >= 60000);
  assert.ok(outputRecord.observedTotalBytes >= 120000);

  const retainedCombinedBytes = Buffer.byteLength(outputRecord.stdout, "utf8") + Buffer.byteLength(outputRecord.stderr, "utf8");
  console.log(`  Observed total: ${outputRecord.observedTotalBytes} bytes, Retained combined: ${retainedCombinedBytes} bytes (limit: ${outputLimit})`);
  assert.ok(
    retainedCombinedBytes <= outputLimit,
    `Retained combined bytes (${retainedCombinedBytes}) must NOT exceed budget (${outputLimit})`
  );
  assert.equal(outputRecord.truncated, true, "truncated must be true when observedTotalBytes > outputLimit");
  console.log("PASS: MEDIUM-OUTPUT-BOUND-001 fully closed and verified.");

  // =========================================================================
  // Finding 5: MEDIUM-CONTAINMENT-ROUTE-001 Falsifiers
  // Validate containment wrapper executable and CLI forwarding
  // =========================================================================
  console.log("\n--- [5] Testing MEDIUM-CONTAINMENT-ROUTE-001 (Containment Route & Executable Validation) ---");

  const validWrapper = validateContainmentWrapper(["node", "-v"], process.env.PATH);
  assert.deepEqual(validWrapper, ["node", "-v"], "Executable on PATH must validate successfully");

  assert.throws(
    () => validateContainmentWrapper(["nonexistent_wrapper_executable_xyz_123"], process.env.PATH),
    /was not found or is not executable/i,
    "Missing relative executable on PATH must throw during validation"
  );

  assert.throws(
    () => validateContainmentWrapper(["/nonexistent/absolute/wrapper/path"], process.env.PATH),
    /was not found or is not executable/i,
    "Missing absolute executable must throw during validation"
  );

  console.log("  Testing scripts/codexpro.mjs forwards --containment-wrapper to serverEnv...");
  const launcherPort = await freePort();
  const printEnvOutput = execSync(
    `node scripts/codexpro.mjs start --root "${repoRoot}" --port ${launcherPort} --no-auth --tunnel none --containment-wrapper "node" --print-env`,
    { cwd: repoRoot, encoding: "utf8" }
  );
  const parsedServerEnv = JSON.parse(printEnvOutput);
  assert.equal(
    parsedServerEnv.CODEXPRO_CONTAINMENT_WRAPPER,
    "node",
    "serverEnv.CODEXPRO_CONTAINMENT_WRAPPER must be set from --containment-wrapper"
  );
  console.log("PASS: MEDIUM-CONTAINMENT-ROUTE-001 fully closed and verified.");

  console.log("\n=========================================================================");
  console.log("ALL TASK-007R2 FALSIFIER TESTS PASSED SUCCESSFULLY.");
  console.log("=========================================================================");
}

runFalsifiers().catch((err) => {
  console.error("\nFALSIFIER SUITE FAILED:", err);
  process.exit(1);
});
