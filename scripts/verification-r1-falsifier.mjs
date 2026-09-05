import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
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

console.log("# RepoConnect M009 TASK-007R1 Comprehensive Falsifiers");

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

async function runFalsifiers() {
  // =========================================================================
  // Finding 1: HIGH-EXECUTION-BOUNDARY-001 Falsifiers
  // Prove that strict runner/flag/path/session safety is enforced in both safe and full modes
  // =========================================================================
  console.log("\n--- [1] Testing HIGH-EXECUTION-BOUNDARY-001 (Safe and Full Bash Modes) ---");

  for (const bashMode of ["safe", "full"]) {
    console.log(`\n  Checking boundary enforcement under CODEXPRO_BASH_MODE=${bashMode}...`);
    const config = loadConfig(["--root", repoRoot, "--bash", bashMode]);
    const guard = new PathGuard(config);
    const mgr = new VerificationManager(config);

    // 1.1: Rejection of --watch and -w across runners
    console.log("    Falsifying rejection of watch flags (--watch, -w)...");
    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "tsc",
        args: ["--watch"]
      }),
      /watch mode is forbidden/i,
      "tsc --watch must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "tsc",
        args: ["-w"]
      }),
      /watch mode is forbidden/i,
      "tsc -w must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "pytest",
        args: ["--watch"]
      }),
      /watch mode is forbidden/i,
      "pytest --watch must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "package_script",
        package_manager: "npm",
        script: "verification:fixture",
        args: ["--watch"]
      }),
      /watch mode is forbidden/i,
      "package_script with --watch in args must be rejected"
    );

    // 1.2: Rejection of mutating/writing flags
    console.log("    Falsifying rejection of mutating/writing flags (--fix, --write, --apply, -o, --output-file)...");
    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "eslint",
        args: ["--fix"]
      }),
      /source-mutating flags are forbidden|mutating source files is forbidden/i,
      "eslint --fix must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "eslint",
        args: ["--fix-dry-run"]
      }),
      /source-mutating flags are forbidden/i,
      "eslint --fix-dry-run must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "eslint",
        args: ["--output-file", "report.txt"]
      }),
      /output writing|execution delegation is forbidden/i,
      "eslint --output-file must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "biome_check",
        args: ["--write"]
      }),
      /source-mutating flags are forbidden/i,
      "biome_check --write must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "biome_check",
        args: ["--apply"]
      }),
      /source-mutating flags are forbidden/i,
      "biome_check --apply must be rejected"
    );

    // 1.3: Rejection of arbitrary executable delegation flags
    console.log("    Falsifying rejection of arbitrary executable delegation (-exec, --rulesdir)...");
    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "go_test",
        args: ["-exec", "rm"]
      }),
      /output writing or execution delegation is forbidden|arbitrary execution delegation is forbidden/i,
      "go_test -exec must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "cargo",
        args: ["run"]
      }),
      /Forbidden cargo subcommand/i,
      "cargo run must be rejected"
    );

    // 1.4: Rejection of paths escaping the workspace (absolute paths, home paths, parent traversal)
    console.log("    Falsifying rejection of paths escaping workspace (/etc/passwd, ~, ../...)...");
    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "eslint",
        args: ["/etc/passwd"]
      }),
      /forbidden absolute path/i,
      "Absolute path /etc/passwd must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "tsc",
        args: ["~/secret.ts"]
      }),
      /forbidden home path/i,
      "Home path ~/secret.ts must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "pytest",
        args: ["../tests"]
      }),
      /forbidden parent directory traversal/i,
      "Parent directory traversal ../tests must be rejected"
    );

    await assert.rejects(
      () => mgr.startVerification(fakeWorkspace, guard, {
        workspace_id: fakeWorkspace.id,
        runner: "package_script",
        package_manager: "npm",
        script: "verification:fixture",
        args: ["foo/../../bar"]
      }),
      /forbidden parent directory traversal/i,
      "Parent directory traversal foo/../../bar must be rejected"
    );

    // 1.5: Rejection of non-verification package script names (including lint:fix)
    console.log("    Falsifying rejection of lint:fix and mutating/lifecycle package scripts...");
    assert.throws(
      () => validatePackageScriptName("lint:fix"),
      /Package script 'lint:fix' is blocked.*mutating token 'fix'/i,
      "lint:fix must be rejected"
    );

    assert.throws(
      () => validatePackageScriptName("start"),
      /is blocked: non-verification lifecycle/i,
      "start must be rejected"
    );

    assert.throws(
      () => validatePackageScriptName("dev"),
      /is blocked: non-verification lifecycle/i,
      "dev must be rejected"
    );

    assert.throws(
      () => validatePackageScriptName("test:watch"),
      /is blocked.*token 'watch'/i,
      "test:watch must be rejected"
    );

    assert.throws(
      () => validatePackageScriptName("format:write"),
      /is blocked.*mutating token 'format'/i,
      "format:write must be rejected"
    );

    console.log(`  PASS: All argument, runner, and path protections held under bashMode=${bashMode}`);
  }

  // 1.6: Bash-session guard enforcement under requireBashSession=true
  console.log("\n  Checking Bash-session guard enforcement under requireBashSession=true...");
  const sessionConfig = loadConfig([
    "--root", repoRoot,
    "--bash", "safe",
    "--require-bash-session",
    "--bash-session", "valid-session-secret-token"
  ]);
  const sessionGuard = new PathGuard(sessionConfig);
  const sessionMgr = new VerificationManager(sessionConfig);

  // Missing session_id
  await assert.rejects(
    () => sessionMgr.startVerification(fakeWorkspace, sessionGuard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "100"]
    }),
    /bash session id is required/i,
    "Missing session_id must fail closed under requireBashSession"
  );

  // Mismatched session_id
  await assert.rejects(
    () => sessionMgr.startVerification(fakeWorkspace, sessionGuard, {
      workspace_id: fakeWorkspace.id,
      runner: "package_script",
      package_manager: "npm",
      script: "verification:fixture",
      args: ["--sleep", "100"],
      session_id: "wrong-session-token"
    }),
    /bash session id mismatch/i,
    "Mismatched session_id must fail closed under requireBashSession"
  );

  // Matching session_id succeeds
  const validStart = await sessionMgr.startVerification(fakeWorkspace, sessionGuard, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "verification:fixture",
    args: ["--sleep", "10000"],
    session_id: "valid-session-secret-token"
  });
  assert.equal(validStart.state, "running");
  console.log("    PASS: startVerification succeeded with valid matching session_id");

  // waitVerification with wrong session_id fails
  await assert.rejects(
    () => sessionMgr.waitVerification(validStart.jobId, 1, "wrong-token"),
    /bash session id mismatch/i,
    "waitVerification with wrong session_id must fail"
  );

  // waitVerification with valid session_id succeeds
  const validWait = await sessionMgr.waitVerification(validStart.jobId, 1, "valid-session-secret-token");
  assert.equal(validWait.state, "running");
  console.log("    PASS: waitVerification succeeded with valid matching session_id");

  // cancelVerification with wrong session_id fails
  await assert.rejects(
    () => sessionMgr.cancelVerification(validStart.jobId, "wrong-token"),
    /bash session id mismatch/i,
    "cancelVerification with wrong session_id must fail"
  );

  // cancelVerification with valid session_id succeeds
  const validCancel = await sessionMgr.cancelVerification(validStart.jobId, "valid-session-secret-token");
  assert.equal(validCancel.state, "cancelled");
  console.log("    PASS: cancelVerification succeeded with valid matching session_id");

  console.log("PASS: HIGH-EXECUTION-BOUNDARY-001 fully closed and verified.");

  // =========================================================================
  // Finding 4: MEDIUM-OUTPUT-BOUND-001 Dual-stream Falsifier
  // Prove that total retained stdout + stderr bytes cannot exceed maxOutputBytes
  // =========================================================================
  console.log("\n--- [2] Testing MEDIUM-OUTPUT-BOUND-001 (Combined Retained Output Budget) ---");
  const outputLimit = 100_000; // 100 KB total retained budget for test
  const outputConfig = loadConfig(["--root", repoRoot]);
  outputConfig.maxOutputBytes = outputLimit;
  const outputGuard = new PathGuard(outputConfig);
  const outputMgr = new VerificationManager(outputConfig, {
    retainedTailBytes: outputLimit
  });

  // Emit 60,000 bytes on stdout and 60,000 bytes on stderr (total 120,000 bytes > 100,000 limit)
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
  assert.ok(outputRecord.observedStdoutBytes >= 60000, `observedStdoutBytes (${outputRecord.observedStdoutBytes}) must include 60000 bytes`);
  assert.ok(outputRecord.observedStderrBytes >= 60000, `observedStderrBytes (${outputRecord.observedStderrBytes}) must include 60000 bytes`);
  assert.ok(outputRecord.observedTotalBytes >= 120000, `observedTotalBytes (${outputRecord.observedTotalBytes}) must be at least 120,000`);

  // Combined retained output must be at or below outputLimit
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
  // Prove that executable availability on PATH is validated and launcher CLI flag is forwarded
  // =========================================================================
  console.log("\n--- [3] Testing MEDIUM-CONTAINMENT-ROUTE-001 (Containment Route & Executable Validation) ---");

  // Valid executable on PATH (e.g. "node")
  const validWrapper = validateContainmentWrapper(["node", "-v"], process.env.PATH);
  assert.deepEqual(validWrapper, ["node", "-v"], "Executable on PATH must validate successfully");

  // Non-existent relative executable on PATH must fail closed
  assert.throws(
    () => validateContainmentWrapper(["nonexistent_wrapper_executable_xyz_123"], process.env.PATH),
    /was not found or is not executable/i,
    "Missing relative executable on PATH must throw during validation"
  );

  // Non-existent absolute executable path must fail closed
  assert.throws(
    () => validateContainmentWrapper(["/nonexistent/absolute/wrapper/path"], process.env.PATH),
    /was not found or is not executable/i,
    "Missing absolute executable must throw during validation"
  );

  // Test that codexpro launcher start command forwards --containment-wrapper to serverEnv
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

  // =========================================================================
  // Finding 2: HIGH-HTTP-SHUTDOWN-001 Physical Falsifier
  // Start lawful long verification in real HTTP process, find descendant PID,
  // send SIGTERM to real HTTP process without cancelling, prove HTTP exits and descendant PID is dead.
  // =========================================================================
  console.log("\n--- [4] Testing HIGH-HTTP-SHUTDOWN-001 (Physical Real-HTTP SIGTERM Cleanup Falsifier) ---");
  const httpPort = await freePort();
  const testToken = "test-token-task007r1-shutdown-proof";

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
      reject(new Error(`HTTP server exited early with code ${code}\n${httpStderr}`));
    });
  });

  console.log(`  HTTP server is listening on port ${httpPort}. Connecting MCP client...`);
  const client = new Client({ name: "r1-falsifier-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${testToken}` } }
  });
  await client.connect(transport);

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
  console.log(`  Job started with ID: ${jobInfo.jobId}`);

  // Disconnect client cleanly
  await transport.close();

  // Find the running verification fixture child PID
  await sleep(300);
  const pgrepOutput = execSync(`pgrep -f "verification-fixture.mjs" || true`, { encoding: "utf8" }).trim();
  const childPids = pgrepOutput.split(/\s+/).filter(Boolean).map((p) => parseInt(p, 10));
  assert.ok(childPids.length > 0, "Must find running verification-fixture descendant process");
  const childPid = childPids[0];
  console.log(`  Identified running descendant PID: ${childPid}`);

  // Verify that descendant PID is currently alive
  let isAliveBefore = false;
  try {
    process.kill(childPid, 0);
    isAliveBefore = true;
  } catch (e) {
    isAliveBefore = false;
  }
  assert.ok(isAliveBefore, `Descendant PID ${childPid} must be alive before SIGTERM`);

  // Send SIGTERM to the real HTTP server process WITHOUT prior cancellation of the job!
  console.log(`  Sending SIGTERM to HTTP parent process (PID ${httpChild.pid}) without cancelling job...`);
  const httpExitPromise = new Promise((resolve) => {
    httpChild.once("exit", (code, signal) => resolve({ code, signal }));
  });
  httpChild.kill("SIGTERM");

  const httpExit = await httpExitPromise;
  console.log(`  HTTP parent process exited with code ${httpExit.code}, signal ${httpExit.signal}`);
  assert.equal(httpExit.code, 0, "HTTP server must exit cleanly with code 0 on SIGTERM");

  // Check that the descendant child PID is DEAD
  console.log(`  Verifying descendant PID ${childPid} is terminated...`);
  let isDead = false;
  for (let i = 0; i < 30; i++) {
    try {
      process.kill(childPid, 0);
      await sleep(100);
    } catch (err) {
      if (err.code === "ESRCH") {
        isDead = true;
        break;
      }
    }
  }
  assert.ok(isDead, `Descendant PID ${childPid} must be DEAD (ESRCH) after HTTP process SIGTERM`);
  console.log(`  PASS: Descendant PID ${childPid} was verified DEAD (ESRCH) without orphaned leak`);

  console.log("PASS: HIGH-HTTP-SHUTDOWN-001 fully closed and verified.");

  console.log("\n=========================================================================");
  console.log("ALL TASK-007R1 FALSIFIER TESTS PASSED SUCCESSFULLY.");
  console.log("=========================================================================");
}

runFalsifiers().catch((err) => {
  console.error("\nFALSIFIER SUITE FAILED:", err);
  process.exit(1);
});
