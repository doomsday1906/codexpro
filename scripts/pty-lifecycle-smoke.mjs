#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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
import { createCodexProHttpApp } from "../dist/http.js";
import * as zigpty from "zigpty";

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

const child = cp.spawn("node", ["-e", \`
  import cp from "node:child_process";
  const grandchild = cp.spawn("sleep", ["300"], { stdio: "ignore" });
  console.log("GRANDCHILD:" + grandchild.pid);
  setInterval(() => {}, 1000);
\`], { stdio: ["pipe", "pipe", "inherit"] });

let grandchildPid = 0;
child.stdout.on("data", (data) => {
  const m = data.toString().match(/GRANDCHILD:(\\d+)/);
  if (m) {
    grandchildPid = parseInt(m[1], 10);
    console.log(\`OWNED_TREE_READY: leader=\${process.pid} child=\${child.pid} grandchild=\${grandchildPid}\`);
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

const child = cp.spawn("sh", ["-c", \`
  setsid sleep 300 &
  grandchild_pid=$!
  echo "GRANDCHILD:\$grandchild_pid"
  sleep 300
\`], { stdio: ["pipe", "pipe", "inherit"] });

child.stdout.on("data", (data) => {
  const m = data.toString().match(/GRANDCHILD:(\\d+)/);
  if (m) {
    const grandchildPid = parseInt(m[1], 10);
    console.log(\`OWNED_ESCAPED_READY: leader=\${process.pid} child=\${child.pid} grandchild=\${grandchildPid}\`);
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

const child = cp.spawn("sleep", ["300"], { stdio: "ignore" });
console.log(\`LINGERING_CHILD:\${child.pid}\`);
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

  let ownedPids = [];
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript],
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

  const m = result.transcript.match(/OWNED_TREE_READY: leader=(\d+) child=(\d+) grandchild=(\d+)/);
  assert(m, `Output must announce owned tree PIDs; got: ${result.transcript}`);
  ownedPids = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];

  assert.equal(result.state, "timed_out");
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  for (const pid of ownedPids) {
    assert.equal(isPidAlive(pid), false, `Owned PID ${pid} must be dead after overall timeout`);
  }

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

  let ownedPids = [];
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript],
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

  const m = result.transcript.match(/OWNED_TREE_READY: leader=(\d+) child=(\d+) grandchild=(\d+)/);
  assert(m, `Output must announce owned tree PIDs; got: ${result.transcript}`);
  ownedPids = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];

  assert.equal(result.state, "step_timeout");
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].matched, true);
  assert.equal(result.steps[1].matched, false);
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  for (const pid of ownedPids) {
    assert.equal(isPidAlive(pid), false, `Owned PID ${pid} must be dead after step timeout`);
  }

  assertDecoyAliveAndClean(decoy);
});

// --------------------------------------------------------------------------
// Test 03: Output ceiling kills full owned tree and verifies exact result fields
// --------------------------------------------------------------------------
await test("output ceiling kills full owned tree with exact state and preserves decoy", async () => {
  const decoy = spawnDecoy();
  const testCeiling = 10_000;
  const manager = new PtyRunManager({ ...baseConfig, maxOutputBytes: 5_000 }, {
    hardOutputCeilingBytes: testCeiling,
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", floodScript],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "output_limit_exceeded");
  assert.equal("raw_output_ceiling_exceeded" in result, false, "Result must NOT contain raw_output_ceiling_exceeded");
  assert.equal(result.truncated, true);
  assert(result.raw_observed_bytes >= testCeiling, `raw_observed_bytes ${result.raw_observed_bytes} >= ${testCeiling}`);
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

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

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", normalExitLingeringScript],
      timeout_ms: 10000
    },
    context
  );

  const m = result.transcript.match(/LINGERING_CHILD:(\d+)/);
  assert(m, `Transcript must record child PID; got: ${result.transcript}`);
  const lingeringPid = parseInt(m[1], 10);

  assert.equal(result.state, "succeeded");
  assert.equal(result.exit_code, 0);
  assert.equal(isPidAlive(lingeringPid), false, `Lingering child ${lingeringPid} must be dead at succeeded return`);
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

  let ownedPids = [];
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", escapedDescendantScript],
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

  const m = result.transcript.match(/OWNED_ESCAPED_READY: leader=(\d+) child=(\d+) grandchild=(\d+)/);
  assert(m, `Output must announce owned tree PIDs; got: ${result.transcript}`);
  ownedPids = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];

  assert.equal(result.state, "timed_out");
  assert.equal(manager.getActiveCount(), 0, "Active count must return to 0");

  for (const pid of ownedPids) {
    assert.equal(isPidAlive(pid), false, `Escaped descendant ${pid} must be dead after cleanup`);
  }

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
// Test 07: Controlled HTTP shutdown seals admission and cleans active PTYs
// --------------------------------------------------------------------------
await test("controlled HTTP shutdown synchronously seals admission and cleans active PTYs", async () => {
  const decoy = spawnDecoy();
  const ptyRunManager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const app = createCodexProHttpApp(baseConfig, { ptyRunManager });
  assert.equal(app.ptyRunManager, ptyRunManager, "HTTP app must carry process-scoped ptyRunManager");

  const runPromise = ptyRunManager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript],
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

  // Wait briefly for tree to spawn and announce PIDs
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(ptyRunManager.getActiveCount(), 1, "Run must be active before shutdown");
  assert.equal(ptyRunManager.state, "open");

  // Initiate shutdown
  const closePromise = ptyRunManager.close();

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

  // Await close completion and run completion
  await closePromise;
  const result = await runPromise;

  assert.equal(result.state, "terminated_on_shutdown");
  assert.equal(ptyRunManager.state, "closed");
  assert.equal(ptyRunManager.getActiveCount(), 0);

  const m = result.transcript.match(/OWNED_TREE_READY: leader=(\d+) child=(\d+) grandchild=(\d+)/);
  if (m) {
    const pids = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    for (const pid of pids) {
      assert.equal(isPidAlive(pid), false, `PID ${pid} must be dead after shutdown`);
    }
  }

  assertDecoyAliveAndClean(decoy);
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
// Test 09: Stdio shutdown cleanup is equivalent
// --------------------------------------------------------------------------
await test("stdio shutdown cleanup closes process-scoped ptyRunManager", async () => {
  const decoy = spawnDecoy();
  const ptyRunManager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  const runPromise = ptyRunManager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", nestedTreeScript],
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

  // Simulate stdio SIGINT/SIGTERM cleanup
  await ptyRunManager.close();
  const result = await runPromise;

  assert.equal(result.state, "terminated_on_shutdown");
  assert.equal(ptyRunManager.state, "closed");
  assert.equal(ptyRunManager.getActiveCount(), 0);

  const m = result.transcript.match(/OWNED_TREE_READY: leader=(\d+) child=(\d+) grandchild=(\d+)/);
  if (m) {
    const pids = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
    for (const pid of pids) {
      assert.equal(isPidAlive(pid), false, `PID ${pid} must be dead after stdio cleanup`);
    }
  }

  assertDecoyAliveAndClean(decoy);
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
// Test 11: Backend-error / timeout / exit race yields exactly one terminal result
// --------------------------------------------------------------------------
await test("timeout / exit / close race yields exactly one terminal result and clean accounting", async () => {
  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 100,
    processKillWaitTimeoutMs: 150
  });

  // Run with 1000ms timeout
  const runPromise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "setTimeout(() => process.exit(0), 1000)"],
      timeout_ms: 1000
    },
    context
  );

  // Trigger close at ~990ms to race both exit and timeout
  await new Promise((r) => setTimeout(r, 990));
  const closePromise = manager.close();

  const [result] = await Promise.all([runPromise, closePromise]);
  assert(["succeeded", "timed_out", "terminated_on_shutdown"].includes(result.state));
  assert.equal(manager.getActiveCount(), 0, "Active count must release exactly once to 0");
  assert.equal(manager.state, "closed");
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
