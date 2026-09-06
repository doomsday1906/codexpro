#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = "1";

import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager, CodexProError } from "../dist/guard.js";
import { PTY_LIMITS } from "../dist/ptyValidator.js";
import {
  PtyRunManager,
  isPidAlive,
  isProcessGroupAlive,
  isProcessTreeAlive,
  getProcessTreePids,
  terminatePtyProcessTree,
  terminateAndAwaitProcessTree
} from "../dist/ptyRunManager.js";
import { createCodexProHttpApp, createHttpShutdownHandler } from "../dist/http.js";
import { createStdioShutdownHandler } from "../dist/stdio.js";
import { VerificationManager } from "../dist/verificationOps.js";
import * as zigpty from "zigpty";

function findHostProcessesWithToken(token) {
  const survivors = [];
  try {
    const entries = fsSync.readdirSync("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const cmdline = fsSync.readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (cmdline.includes(token)) {
          survivors.push({ pid, cmdline: cmdline.replace(/\0/g, " ").trim() });
        }
      } catch {}
    }
  } catch {}
  return survivors;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-005 Lifecycle / Concurrency / Descendant / Race Smoke");

// Set up isolated temporary workspace directory
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m010-task005-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "fixture-pkg" }, null, 2));
await fs.mkdir(path.join(realFixtureRoot, "src"), { recursive: true });
await fs.mkdir(path.join(realFixtureRoot, ".git"), { recursive: true });

// Setup test synthetic scripts

// 1. Real nested tree script: leader -> child -> grandchild
const nestedTreeScript = path.join(realFixtureRoot, "nested_tree.mjs");
await fs.writeFile(
  nestedTreeScript,
  `import cp from "node:child_process";
import readline from "node:readline";

const token = process.argv[2] || ("TREE_" + Date.now());
const childToken = token + "_CHILD";
const grandchildToken = token + "_GRANDCHILD";

const child = cp.spawn("node", ["-e", \`
  import cp from "node:child_process";
  const grandchild = cp.spawn("sleep", ["300", process.argv[1]], { stdio: "ignore" });
  console.log("GRANDCHILD_READY");
  setInterval(() => {}, 1000);
\`, grandchildToken], { stdio: ["pipe", "pipe", "inherit"] });

child.stdout.on("data", (data) => {
  if (data.toString().includes("GRANDCHILD_READY")) {
    console.log(\`OWNED_TREE_READY: \${token}\`);
  }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("", () => {
  process.exit(0);
});
`
);

// 2. Escaped descendant script: child spawns grandchild using setsid
const escapedDescendantScript = path.join(realFixtureRoot, "escaped_tree.mjs");
await fs.writeFile(
  escapedDescendantScript,
  `import cp from "node:child_process";
import readline from "node:readline";

const token = process.argv[2] || ("ESCAPED_" + Date.now());
const grandchildToken = token + "_GRANDCHILD";

const child = cp.spawn("sh", ["-c", \`
  setsid sleep 300 "\$1" &
  echo "GRANDCHILD_READY"
  sleep 300
\`, "sh", grandchildToken], { stdio: ["pipe", "pipe", "inherit"] });

child.stdout.on("data", (data) => {
  if (data.toString().includes("GRANDCHILD_READY")) {
    console.log(\`OWNED_ESCAPED_READY: \${token}\`);
  }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("", () => {
  process.exit(0);
});
`
);

// 3. Normal exit with lingering child
const normalExitLingeringScript = path.join(realFixtureRoot, "normal_exit_lingering.mjs");
await fs.writeFile(
  normalExitLingeringScript,
  `import cp from "node:child_process";

const token = process.argv[2] || ("LINGERING_" + Date.now());
const child = cp.spawn("sleep", ["300", token], { stdio: "ignore" });
console.log(\`LINGERING_CHILD_READY: \${token}\`);
setTimeout(() => {
  console.log("LEADER_EXITING_ZERO");
  process.exit(0);
}, 100);
`
);

// 4. Flood script for output ceiling
const floodScript = path.join(realFixtureRoot, "flood_cli.mjs");
await fs.writeFile(
  floodScript,
  `let count = 0;
const interval = setInterval(() => {
  process.stdout.write("FLOOD_DATA_LINE_" + count++ + "_abcdefghijklmnopqrstuvwxyz0123456789\\n");
}, 2);
`
);

// 5. Fast-exit prompt script for send/exit race
const raceExitScript = path.join(realFixtureRoot, "race_exit_cli.mjs");
await fs.writeFile(
  raceExitScript,
  `process.stdout.write("PROMPT_READY: ");
setTimeout(() => {
  process.exit(0);
}, 20);
`
);

const baseConfig = loadConfig([
  "--root", realFixtureRoot,
  "--allow-root", realFixtureRoot,
  "--bash", "full"
]);
const guard = new PathGuard(baseConfig);
const workspaces = new WorkspaceManager(baseConfig);
const testWorkspace = workspaces.openWorkspace(realFixtureRoot, { select: true });
const validWorkspaceId = testWorkspace.id;
const context = { guard, workspaces };

console.log(`Initialized fixture workspace: ${validWorkspaceId} -> ${realFixtureRoot}`);

function spawnDecoy() {
  const decoy = spawn("sleep", ["300"], { stdio: "ignore" });
  assert(decoy.pid && decoy.pid > 0, "Decoy must spawn successfully");
  return decoy;
}

function assertDecoyAliveAndClean(decoy) {
  const alive = isPidAlive(decoy.pid);
  assert.equal(alive, true, `Decoy ${decoy.pid} must survive cleanup`);
  try {
    process.kill(decoy.pid, "SIGKILL");
  } catch {}
}

let testsRun = 0;
let testsPassed = 0;

async function test(name, fn) {
  testsRun++;
  try {
    await fn();
    testsPassed++;
    console.log(`  [PASS] Test ${String(testsRun).padStart(2, "0")}: ${name}`);
  } catch (error) {
    console.error(`  [FAIL] Test ${String(testsRun).padStart(2, "0")}: ${name}`);
    console.error(error);
    process.exit(1);
  }
}

// --------------------------------------------------------------------------
// Test 01: Overall timeout kills full owned tree (leader -> child -> grandchild)
// --------------------------------------------------------------------------
await test("overall timeout kills full owned tree and preserves unrelated decoy", async () => {
  const decoy = spawnDecoy();
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const token = `NESTED_TREE_T1_${Date.now()}`;
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript, token],
      steps: [
        {
          wait_for: "OWNED_TREE_READY: ",
          send: "hello",
          submit: false,
          timeout_ms: 3000
        }
      ],
      timeout_ms: 1000
    },
    context
  );

  assert(result.transcript.includes(`OWNED_TREE_READY: ${token}`), `Output must announce owned tree ready; got: ${result.transcript}`);
  assert.equal(result.state, "timed_out");
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(token + "_GRANDCHILD"), [], "Grandchild must be dead after overall timeout");
  assert.deepEqual(findHostProcessesWithToken(token + "_CHILD"), [], "Child must be dead after overall timeout");
  assert.deepEqual(findHostProcessesWithToken(token), [], "Leader must be dead after overall timeout");

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 02: Step timeout kills full owned tree (leader -> child -> grandchild)
// --------------------------------------------------------------------------
await test("step timeout kills full owned tree and preserves unrelated decoy", async () => {
  const decoy = spawnDecoy();
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const token = `NESTED_TREE_T2_${Date.now()}`;
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript, token],
      steps: [
        {
          wait_for: "OWNED_TREE_READY: ",
          timeout_ms: 3000
        },
        {
          wait_for: "NEVER_MATCHING_PROMPT_FRAGMENT_404",
          timeout_ms: 300
        }
      ],
      timeout_ms: 5000
    },
    context
  );

  assert(result.transcript.includes(`OWNED_TREE_READY: ${token}`), `Output must announce owned tree ready; got: ${result.transcript}`);
  assert.equal(result.state, "step_timeout");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].matched, true);
  assert.equal(result.steps[1].matched, false);
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(token + "_GRANDCHILD"), [], "Grandchild must be dead after step timeout");
  assert.deepEqual(findHostProcessesWithToken(token + "_CHILD"), [], "Child must be dead after step timeout");
  assert.deepEqual(findHostProcessesWithToken(token), [], "Leader must be dead after step timeout");

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 03: Output ceiling kills full owned tree and verifies exact result fields
// --------------------------------------------------------------------------
await test("output ceiling kills full owned tree with exact state and preserves decoy", async () => {
  const decoy = spawnDecoy();
  const testCeiling = 10_000;

  const grandchildToken = `FLOOD_GRANDCHILD_${Date.now()}`;
  const childToken = `FLOOD_CHILD_${Date.now()}`;
  const leaderToken = `FLOOD_LEADER_${Date.now()}`;

  const grandchildScript = path.join(realFixtureRoot, "flood_grandchild_nested.mjs");
  await fs.writeFile(
    grandchildScript,
    `while (true) { process.stdout.write("NESTED_FLOOD_DATA_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ\\n"); }`
  );

  const childScript = path.join(realFixtureRoot, "flood_child_nested.mjs");
  await fs.writeFile(
    childScript,
    `import cp from "node:child_process";
cp.spawn("node", ["${grandchildScript}", "${grandchildToken}"], { stdio: ["ignore", "inherit", "ignore"] });
setInterval(() => {}, 1000);`
  );

  const nestedFloodScript = path.join(realFixtureRoot, "flood_tree_nested.mjs");
  await fs.writeFile(
    nestedFloodScript,
    `import cp from "node:child_process";
cp.spawn("node", ["${childScript}", "${childToken}"], { stdio: ["ignore", "inherit", "ignore"] });
setInterval(() => {}, 1000);`
  );

  const manager = new PtyRunManager({ ...baseConfig, maxOutputBytes: 5_000 }, {
    hardOutputCeilingBytes: testCeiling,
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedFloodScript, leaderToken],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "output_limit_exceeded");
  assert.equal("raw_output_ceiling_exceeded" in result, false, "Result must NOT contain raw_output_ceiling_exceeded");
  assert.equal(result.truncated, true);
  assert(result.raw_observed_bytes >= testCeiling, `raw_observed_bytes ${result.raw_observed_bytes} >= ${testCeiling}`);
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(grandchildToken), [], "Grandchild must be dead");
  assert.deepEqual(findHostProcessesWithToken(childToken), [], "Child must be dead");
  assert.deepEqual(findHostProcessesWithToken(leaderToken), [], "Leader must be dead");

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 04: Normal exit (exit 0) cleans lingering background child before return
// --------------------------------------------------------------------------
await test("normal exit cleans lingering background child before succeeded return", async () => {
  const decoy = spawnDecoy();
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const token = `LINGERING_T4_${Date.now()}`;
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", normalExitLingeringScript, token],
      timeout_ms: 10000
    },
    context
  );

  assert(result.transcript.includes(`LINGERING_CHILD_READY: ${token}`), `Transcript must record child readiness; got: ${result.transcript}`);
  assert.equal(result.state, "succeeded");
  assert.equal(result.exit_code, 0);

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(token), [], "Lingering child must be dead at succeeded return");
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 05: Escaped process group / session descendant (setsid) is owned and killed
// --------------------------------------------------------------------------
await test("escaped process group / session descendant (setsid) is owned and killed", async () => {
  const decoy = spawnDecoy();
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const token = `ESCAPED_T5_${Date.now()}`;
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", escapedDescendantScript, token],
      steps: [
        {
          wait_for: "OWNED_ESCAPED_READY: ",
          timeout_ms: 3000
        }
      ],
      timeout_ms: 1000
    },
    context
  );

  assert(result.transcript.includes(`OWNED_ESCAPED_READY: ${token}`), `Output must announce escaped tree ready; got: ${result.transcript}`);
  assert.equal(result.state, "timed_out");
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(token + "_GRANDCHILD"), [], "Escaped descendant must be dead after cleanup");
  assert.deepEqual(findHostProcessesWithToken(token), [], "Leader must be dead after cleanup");

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 06: Capacity = 2 rejects third start immediately with no queue
// --------------------------------------------------------------------------
await test("capacity cap=2 rejects third start immediately and creates no queued child", async () => {
  const markerPath = path.join(realFixtureRoot, "cap_marker.txt");
  try { await fs.unlink(markerPath); } catch {}

  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const run1Promise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 1000
    },
    context
  );

  const run2Promise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 1000
    },
    context
  );

  // Allow async validation to complete and runs to spawn
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(manager.getActiveCount(), 2, "Active count must equal maxActive (2)");

  let thirdError;
  try {
    await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", "-e", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerPath)}, "ran");`],
        timeout_ms: 2000
      },
      context
    );
  } catch (err) {
    thirdError = err;
  }

  assert(thirdError instanceof CodexProError);
  assert.equal(thirdError.code, "pty_capacity_reached");
  assert.equal(manager.getActiveCount(), 2, "Active count must remain 2 after rejected start");

  let markerExists = false;
  try {
    await fs.stat(markerPath);
    markerExists = true;
  } catch {}
  assert.equal(markerExists, false, "Third run marker must never be created");

  await Promise.all([run1Promise, run2Promise]);
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0 after runs complete");
});

// --------------------------------------------------------------------------
// Test 07: Controlled HTTP shutdown seals admission, closes server, cleans active PTYs, and enforces truthful exit code
// --------------------------------------------------------------------------
await test("controlled HTTP shutdown handler closes server, seals admission, cleans active PTYs, and enforces truthful exit code", async () => {
  const decoy = spawnDecoy();
  const ptyRunManager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });
  const verificationManager = new VerificationManager(baseConfig);
  const app = createCodexProHttpApp(baseConfig, { verificationManager, ptyRunManager });
  assert.equal(app.ptyRunManager, ptyRunManager, "HTTP app must carry process-scoped ptyRunManager");

  let serverClosed = false;
  const mockServer = {
    close: (cb) => {
      serverClosed = true;
      cb?.();
    }
  };

  let exitCode = null;
  const gracefulShutdown = createHttpShutdownHandler({
    server: mockServer,
    verificationManager,
    ptyRunManager,
    exitFn: (code) => { exitCode = code; }
  });

  const token = `HTTP_SHUTDOWN_${Date.now()}`;
  const runPromise = ptyRunManager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript, token],
      steps: [
        {
          wait_for: "OWNED_TREE_READY: ",
          timeout_ms: 3000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(ptyRunManager.getActiveCount(), 1, "Run must be active before shutdown");

  // Call the actual HTTP shutdown handler with SIGTERM
  const shutdownPromise = gracefulShutdown("SIGTERM");

  // Admission is synchronously sealed
  assert.equal(ptyRunManager.state, "closing");

  // Late start must immediately fail with pty_shutting_down
  let lateErr;
  try {
    await ptyRunManager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", "-e", "process.exit(0)"],
        timeout_ms: 1000
      },
      context
    );
  } catch (err) {
    lateErr = err;
  }
  assert(lateErr instanceof CodexProError);
  assert.equal(lateErr.code, "pty_shutting_down");

  await shutdownPromise;
  const result = await runPromise;

  assert.equal(serverClosed, true, "HTTP server close() must be invoked");
  assert.equal(exitCode, 0, "Graceful HTTP shutdown must exit with 0");
  assert.equal(result.state, "terminated_on_shutdown");
  assert.equal(ptyRunManager.state, "closed");
  assert.equal(ptyRunManager.getActiveCount(), 0);

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(token + "_GRANDCHILD"), [], "Grandchild must be dead after HTTP shutdown");
  assert.deepEqual(findHostProcessesWithToken(token + "_CHILD"), [], "Child must be dead after HTTP shutdown");
  assert.deepEqual(findHostProcessesWithToken(token), [], "Leader must be dead after HTTP shutdown");

  assertDecoyAliveAndClean(decoy);

  // Failure path: Cleanup failure during HTTP shutdown must exit 1 (HIGH-SHUTDOWN-FAILURE-TRUTH-001)
  const faultyManager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 50,
    processKillWaitTimeoutMs: 50,
    isAliveChecker: () => true
  });
  let failureExitCode = null;
  const failureShutdown = createHttpShutdownHandler({
    server: mockServer,
    verificationManager,
    ptyRunManager: faultyManager,
    exitFn: (code) => { failureExitCode = code; }
  });

  const lingeringRun = faultyManager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 5000
    },
    context
  ).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));
  await failureShutdown("SIGTERM");
  assert.equal(failureExitCode, 1, "HTTP shutdown must exit 1 when cleanup fails");
  await lingeringRun;
});

// --------------------------------------------------------------------------
// Test 08: Concurrent late starts during closing cannot create children
// --------------------------------------------------------------------------
await test("concurrent late starts during closing cannot create children", async () => {
  const markerDir = path.join(realFixtureRoot, "late_markers");
  await fs.mkdir(markerDir, { recursive: true });

  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const activePromise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 5000
    },
    context
  );

  await new Promise((r) => setTimeout(r, 50));

  const closePromise = manager.close();
  assert.equal(manager.state, "closing");

  // Concurrently fan out late start attempts
  const attempts = Array.from({ length: 5 }, async (_, i) => {
    const marker = path.join(markerDir, `marker_${i}.txt`);
    try {
      await manager.run(
        {
          workspace_id: validWorkspaceId,
          argv: ["node", "-e", `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "ran");`],
          timeout_ms: 1000
        },
        context
      );
      return { ok: true, i };
    } catch (err) {
      return { ok: false, code: err.code, i };
    }
  });

  const results = await Promise.all(attempts);
  for (const res of results) {
    assert.equal(res.ok, false, `Late start attempt ${res.i} must fail`);
    assert.equal(res.code, "pty_shutting_down");
  }

  await closePromise;
  await activePromise;

  const markers = await fs.readdir(markerDir);
  assert.equal(markers.length, 0, "No late start marker files must exist");
  assert.equal(manager.state, "closed");
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 09: Stdio shutdown cleans active PTYs and enforces truthful exit code
// --------------------------------------------------------------------------
await test("stdio shutdown handler cleans active PTYs and enforces truthful exit code", async () => {
  const decoy = spawnDecoy();
  const ptyRunManager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });
  const verificationManager = new VerificationManager(baseConfig);

  let exitCode = null;
  const stdioShutdown = createStdioShutdownHandler({
    verificationManager,
    ptyRunManager,
    exitFn: (code) => { exitCode = code; }
  });

  const token = `STDIO_SHUTDOWN_${Date.now()}`;
  const runPromise = ptyRunManager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript, token],
      steps: [
        {
          wait_for: "OWNED_TREE_READY: ",
          timeout_ms: 3000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  await new Promise((r) => setTimeout(r, 200));

  // Trigger stdio shutdown via SIGINT
  await stdioShutdown("SIGINT");
  const result = await runPromise;

  assert.equal(exitCode, 0, "Graceful stdio shutdown must exit 0");
  assert.equal(result.state, "terminated_on_shutdown");
  assert.equal(ptyRunManager.state, "closed");
  assert.equal(ptyRunManager.getActiveCount(), 0);

  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(findHostProcessesWithToken(token + "_GRANDCHILD"), [], "Grandchild must be dead after stdio cleanup");
  assert.deepEqual(findHostProcessesWithToken(token + "_CHILD"), [], "Child must be dead after stdio cleanup");
  assert.deepEqual(findHostProcessesWithToken(token), [], "Leader must be dead after stdio cleanup");

  assertDecoyAliveAndClean(decoy);

  // Failure path: Cleanup failure during stdio shutdown must exit 1 (HIGH-SHUTDOWN-FAILURE-TRUTH-001)
  const faultyManager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 50,
    processKillWaitTimeoutMs: 50,
    isAliveChecker: () => true
  });
  let failureExitCode = null;
  const failureStdioShutdown = createStdioShutdownHandler({
    verificationManager,
    ptyRunManager: faultyManager,
    exitFn: (code) => { failureExitCode = code; }
  });

  const lingeringRun = faultyManager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 5000
    },
    context
  ).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));
  await failureStdioShutdown("SIGTERM");
  assert.equal(failureExitCode, 1, "Stdio shutdown must exit 1 when cleanup fails");
  await lingeringRun;
});

// --------------------------------------------------------------------------
// Test 10: Child-exit / final-send race cannot crash host and preserves truthful metadata
// --------------------------------------------------------------------------
await test("child-exit / final-send race cannot crash host and preserves truthful metadata", async () => {
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  // Run multiple iterations of rapid prompt/exit to stress the race window
  for (let i = 0; i < 5; i++) {
    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", raceExitScript],
        steps: [
          {
            wait_for: "PROMPT_READY: ",
            send: "DATA_TO_SEND",
            submit: true,
            timeout_ms: 2000
          }
        ],
        timeout_ms: 3000
      },
      context
    );

    // Either succeeded (clean exit) or failed (exit during write), but must not crash host or double-finalize
    assert(result.state === "succeeded" || result.state === "failed");
    assert.equal(typeof result.duration_ms, "number");
    assert.equal(manager.getActiveCount(), 0, "Active count must be 0 after race completion");
  }
});

// --------------------------------------------------------------------------
// Test 11: Combined backend-error / timeout / exit race yields exactly one terminal result
// --------------------------------------------------------------------------
await test("combined backend-error + timeout + exit race yields exactly one terminal result and clean accounting", async () => {
  const decoy = spawnDecoy();
  const manager = new PtyRunManager(baseConfig, {
    faultInjection: {
      onSpawn: ({ injectBackendError, triggerTimeout }) => {
        setTimeout(() => {
          injectBackendError(new Error("Injected race backend error in lifecycle test"));
          triggerTimeout();
        }, 20);
      }
    }
  });

  let outcomeType = "none";
  let outcomeVal = null;
  try {
    outcomeVal = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", "-e", "setTimeout(() => process.exit(0), 20);"],
        timeout_ms: 1000
      },
      context
    );
    outcomeType = "resolved";
  } catch (err) {
    outcomeType = "rejected";
    outcomeVal = err;
  }

  assert.ok(outcomeType === "resolved" || outcomeType === "rejected");
  if (outcomeType === "resolved") {
    assert.ok(["succeeded", "failed", "timed_out"].includes(outcomeVal.state));
  } else {
    assert.ok(outcomeVal instanceof CodexProError);
    assert.equal(outcomeVal.code, "pty_backend_error");
  }

  assert.equal(manager.getActiveCount(), 0, "Active count must release exactly once to 0");
  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 12: MCP session loss creates no resume claim and run stays bounded by manager
// --------------------------------------------------------------------------
await test("MCP session loss creates no resume claim and run stays bounded by manager", async () => {
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  // Verify manager surface has NO continuity methods
  assert.equal(manager.getRun, undefined, "manager.getRun must not exist");
  assert.equal(manager.attach, undefined, "manager.attach must not exist");
  assert.equal(manager.resume, undefined, "manager.resume must not exist");
  assert.equal(manager.cancel, undefined, "manager.cancel must not exist");
  assert.equal(manager.listRuns, undefined, "manager.listRuns must not exist");

  // Start run and abandon the promise (session loss)
  const abandonedPromise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 1000
    },
    context
  );

  // Allow async validation to complete and run to spawn
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(manager.getActiveCount(), 1);

  // Await the abandoned run's completion on the manager
  const result = await abandonedPromise;
  assert.equal(result.state, "timed_out");
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");
});

// --------------------------------------------------------------------------
// Test 13: Post-spawn backend error terminates spawned child and releases capacity
// --------------------------------------------------------------------------
await test("post-spawn backend error terminates spawned child and releases capacity", async () => {
  const decoy = spawnDecoy();

  // Create a backend wrapper where spawn succeeds but onData throws
  let spawnedPid = 0;
  const faultyBackend = {
    hasNative: true,
    spawn: (file, args, opts) => {
      const realPty = zigpty.spawn(file, args, opts);
      spawnedPid = realPty.pid;
      return {
        ...realPty,
        pid: realPty.pid,
        onData: () => {
          throw new Error("Simulated onData backend failure");
        },
        onExit: realPty.onExit.bind(realPty),
        close: realPty.close.bind(realPty),
        write: realPty.write.bind(realPty)
      };
    }
  };

  const manager = new PtyRunManager(baseConfig, {
    backend: faultyBackend,
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  let thrownError;
  try {
    await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", "-e", "setInterval(() => {}, 1000)"],
        timeout_ms: 5000
      },
      context
    );
  } catch (err) {
    thrownError = err;
  }

  assert(thrownError instanceof CodexProError);
  assert.equal(thrownError.code, "pty_backend_error");
  assert(spawnedPid > 0, "Child must have spawned before error");
  assert.equal(isPidAlive(spawnedPid), false, `Spawned child ${spawnedPid} must be killed on backend error`);
  assert.equal(manager.getActiveCount(), 0, "Capacity must be released exactly once");

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 14: Post-SIGKILL wait expiry fails closed with pty_cleanup_incomplete
// --------------------------------------------------------------------------
await test("post-SIGKILL wait expiry fails closed with pty_cleanup_incomplete", async () => {
  // Use deterministic test seam: isAliveChecker returns true simulating unkillable process
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 50,
    processKillWaitTimeoutMs: 50,
    isAliveChecker: () => true
  });

  let thrownError;
  try {
    await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", "-e", "process.exit(0)"],
        timeout_ms: 1000
      },
      context
    );
  } catch (err) {
    thrownError = err;
  }

  assert(thrownError instanceof CodexProError, "Must fail closed with CodexProError");
  assert.equal(thrownError.code, "pty_cleanup_incomplete");
  assert.match(thrownError.message, /PTY process tree cleanup incomplete/);

  // Now test that close() also fails closed and does not transition to 'closed'
  const manager2 = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 50,
    processKillWaitTimeoutMs: 50,
    isAliveChecker: () => true
  });

  const run2Promise = manager2.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 5000
    },
    context
  ).catch(() => {});

  await new Promise((r) => setTimeout(r, 50));

  let closeError;
  try {
    await manager2.close();
  } catch (err) {
    closeError = err;
  }

  assert(closeError instanceof CodexProError);
  assert.equal(closeError.code, "pty_cleanup_incomplete");
  assert.notEqual(manager2.state, "closed", "Manager must NOT transition to closed when cleanup is incomplete");

  await run2Promise;
});

// --------------------------------------------------------------------------
// Test 15: Idempotent shutdown & state transitions
// --------------------------------------------------------------------------
await test("close() is idempotent and shares one shutdown promise", async () => {
  const manager = new PtyRunManager(baseConfig);
  assert.equal(manager.state, "open");

  const close1 = manager.close();
  const close2 = manager.close();
  assert.equal(close1, close2, "Concurrent close() calls must return the same promise");

  await close1;
  assert.equal(manager.state, "closed");

  const close3 = manager.close();
  await close3;
  assert.equal(manager.state, "closed");
});

console.log(`\nAll ${testsPassed} of ${testsRun} TASK-005 lifecycle/concurrency/descendant/race tests passed successfully!\n`);
