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
  DEFAULT_UNSHARE_PATH,
  probePtyOwnershipCapability,
  isPidAlive,
  isProcessTreeAlive,
  getProcessTreePids
} from "../dist/ptyRunManager.js";
import * as zigpty from "zigpty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-005R1 PTY Kernel Ownership Smoke Suite");

// Set up isolated temporary workspace directory
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m010-ownership-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "fixture-pkg" }, null, 2));
await fs.mkdir(path.join(realFixtureRoot, "src"), { recursive: true });
await fs.mkdir(path.join(realFixtureRoot, ".git"), { recursive: true });

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

const baseConfig = loadConfig([
  "--root", realFixtureRoot,
  "--allow-root", realFixtureRoot,
  "--bash", "full"
]);
const guard = new PathGuard(baseConfig);
const workspaces = new WorkspaceManager(baseConfig);
const testWorkspace = workspaces.openWorkspace(realFixtureRoot, { select: true });
const validWorkspaceId = testWorkspace.id;
const validationContext = { guard, workspaces };

function spawnDecoy() {
  const decoy = spawn("sleep", ["300"], { stdio: "ignore" });
  assert(decoy.pid && decoy.pid > 0, "Decoy must spawn successfully");
  return decoy;
}

function assertDecoyAliveAndClean(decoy) {
  const alive = isPidAlive(decoy.pid);
  assert.equal(alive, true, `Decoy ${decoy.pid} must survive cleanup`);
  if (alive) {
    try {
      process.kill(decoy.pid, "SIGKILL");
    } catch {}
  }
}

let passedTests = 0;
let totalTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [PASS] Test ${String(totalTests).padStart(2, "0")}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] Test ${String(totalTests).padStart(2, "0")}: ${name}`);
    console.error(err);
    throw err;
  }
}

try {
  // Test 01: Host capability canary passes
  await runTest("Host kernel ownership capability gate passes with real unshare", async () => {
    const cap = probePtyOwnershipCapability();
    assert.equal(cap.supported, true, `Expected unshare capability to be supported, got: ${cap.reason}`);
    assert.equal(cap.executablePath, DEFAULT_UNSHARE_PATH);
    assert.equal(cap.reason, undefined);
  });

  // Test 02: Capability failure fails closed before target execution / reservation / marker creation
  await runTest("Ownership capability failure fails closed before target execution or slot reservation", async () => {
    const markerFile = path.join(realFixtureRoot, "forbidden_marker_" + Date.now());
    const manager = new PtyRunManager(baseConfig, {
      ownershipCapabilityOverride: { supported: false, reason: "Injected capability failure for test" }
    });

    let caughtError = null;
    try {
      await manager.run(
        {
          workspace_id: validWorkspaceId,
          argv: ["touch", markerFile],
          timeout_ms: 5000
        },
        validationContext
      );
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof CodexProError);
    assert.equal(caughtError.code, "pty_ownership_unavailable");
    assert.match(caughtError.message, /PTY ownership boundary is unavailable: Injected capability failure for test/);
    assert.equal(manager.getActiveCount(), 0, "Active count must stay 0 on capability failure");
    assert.equal(fsSync.existsSync(markerFile), false, "Marker file must not be created");
  });

  // Test 03: Identity, TTY profile, prompt, input, and exit semantics preserved under ownership boundary
  await runTest("Preserve caller UID/GID, cwd, true TTY, 80x24 profile, prompt, Enter, and exit status", async () => {
    const identityScript = path.join(realFixtureRoot, "identity_probe.mjs");
    await fs.writeFile(
      identityScript,
      `import readline from "node:readline";
const info = {
  uid: process.getuid(),
  gid: process.getgid(),
  cwd: process.cwd(),
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  term: process.env.TERM,
  noColor: process.env.NO_COLOR,
  ci: process.env.CI
};
console.log("PROBE_INFO:" + JSON.stringify(info));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("ENTER_SECRET:", (answer) => {
  console.log("RECEIVED_ANSWER:" + answer);
  process.exit(0);
});`
    );

    const manager = new PtyRunManager(baseConfig);
    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", identityScript],
        steps: [
          {
            wait_for: "ENTER_SECRET:",
            send: "secret_token_123",
            submit: true
          }
        ],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].matched, true);
    assert.equal(result.steps[0].input_bytes_sent, "secret_token_123".length);
    assert.equal(result.steps[0].submit, true);
    assert.equal(result.terminal_profile.cols, 80);
    assert.equal(result.terminal_profile.rows, 24);
    assert.equal(result.terminal_profile.term, "xterm-256color");
    assert.equal(result.terminal_profile.no_color, "1");

    // Parse child probe output
    const match = result.transcript.match(/PROBE_INFO:(\{[^}]+\})/);
    assert.ok(match, "Probe info JSON must be present in transcript");
    const info = JSON.parse(match[1]);

    assert.equal(info.uid, process.getuid(), "Target UID must match caller UID");
    assert.equal(info.gid, process.getgid(), "Target GID must match caller GID");
    assert.equal(info.cwd, realFixtureRoot, "Target cwd must match resolved workspace cwd");
    assert.equal(info.stdinIsTTY, true, "stdin must be a real TTY");
    assert.equal(info.stdoutIsTTY, true, "stdout must be a real TTY");
    assert.equal(info.cols, 80, "columns must be 80");
    assert.equal(info.rows, 24, "rows must be 24");
    assert.equal(info.term, "xterm-256color", "TERM must be xterm-256color");
    assert.equal(info.noColor, "1", "NO_COLOR must be 1");
    assert.equal(info.ci, undefined, "CI must be absent");
    assert.match(result.transcript, /RECEIVED_ANSWER:secret_token_123/);
    assert.equal(manager.getActiveCount(), 0);
  });

  // Test 04: Decisive silent fast-detach setsid regression (immediate parent exit)
  await runTest("Decisive fast-detach: immediate parent exit kills silent setsid descendant", async () => {
    const decoy = spawnDecoy();
    const manager = new PtyRunManager(baseConfig);
    const token = `FAST_DETACH_TOKEN_IMM_${Date.now()}`;

    const detachScript = path.join(realFixtureRoot, "fast_detach_imm.mjs");
    await fs.writeFile(
      detachScript,
      `import cp from "node:child_process";
cp.spawn("setsid", ["sleep", "300", "${token}"], { stdio: "ignore" });
process.exit(0);
`
    );

    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", detachScript],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.equal(manager.getActiveCount(), 0);

    // Wait a bounded 50ms and check host /proc for any survivor carrying the token
    await new Promise((r) => setTimeout(r, 50));
    const survivors = findHostProcessesWithToken(token);
    assert.deepEqual(survivors, [], `Expected zero survivors carrying token ${token}, found: ${JSON.stringify(survivors)}`);
    assertDecoyAliveAndClean(decoy);
  });

  // Test 05: Decisive silent fast-detach setsid regression (parent exit after 1ms)
  await runTest("Decisive fast-detach: parent exit after 1ms kills silent setsid descendant", async () => {
    const decoy = spawnDecoy();
    const manager = new PtyRunManager(baseConfig);
    const token = `FAST_DETACH_TOKEN_1MS_${Date.now()}`;

    const detachScript = path.join(realFixtureRoot, "fast_detach_1ms.mjs");
    await fs.writeFile(
      detachScript,
      `import cp from "node:child_process";
cp.spawn("setsid", ["sleep", "300", "${token}"], { stdio: "ignore" });
setTimeout(() => process.exit(0), 1);
`
    );

    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", detachScript],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.equal(manager.getActiveCount(), 0);

    await new Promise((r) => setTimeout(r, 50));
    const survivors = findHostProcessesWithToken(token);
    assert.deepEqual(survivors, [], `Expected zero survivors carrying token ${token}, found: ${JSON.stringify(survivors)}`);
    assertDecoyAliveAndClean(decoy);
  });

  // Test 06: Decisive silent fast-detach setsid regression (parent exit after 10ms)
  await runTest("Decisive fast-detach: parent exit after 10ms kills silent setsid descendant", async () => {
    const decoy = spawnDecoy();
    const manager = new PtyRunManager(baseConfig);
    const token = `FAST_DETACH_TOKEN_10MS_${Date.now()}`;

    const detachScript = path.join(realFixtureRoot, "fast_detach_10ms.mjs");
    await fs.writeFile(
      detachScript,
      `import cp from "node:child_process";
cp.spawn("setsid", ["sleep", "300", "${token}"], { stdio: "ignore" });
setTimeout(() => process.exit(0), 10);
`
    );

    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", detachScript],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.equal(manager.getActiveCount(), 0);

    await new Promise((r) => setTimeout(r, 50));
    const survivors = findHostProcessesWithToken(token);
    assert.deepEqual(survivors, [], `Expected zero survivors carrying token ${token}, found: ${JSON.stringify(survivors)}`);
    assertDecoyAliveAndClean(decoy);
  });

  // Test 07: Decisive silent fast-detach setsid regression (descendant double-fork)
  await runTest("Decisive fast-detach: descendant double-fork kills escaped grandchild", async () => {
    const decoy = spawnDecoy();
    const manager = new PtyRunManager(baseConfig);
    const token = `FAST_DETACH_TOKEN_DBL_${Date.now()}`;

    const detachScript = path.join(realFixtureRoot, "fast_detach_dbl.mjs");
    await fs.writeFile(
      detachScript,
      `import cp from "node:child_process";
cp.spawn("node", ["-e", \`
  import cp from "node:child_process";
  cp.spawn("setsid", ["sleep", "300", "${token}"], { stdio: "ignore" });
  process.exit(0);
\`], { stdio: "ignore" });
process.exit(0);
`
    );

    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", detachScript],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "succeeded");
    assert.equal(result.exit_code, 0);
    assert.equal(manager.getActiveCount(), 0);

    await new Promise((r) => setTimeout(r, 50));
    const survivors = findHostProcessesWithToken(token);
    assert.deepEqual(survivors, [], `Expected zero survivors carrying token ${token}, found: ${JSON.stringify(survivors)}`);
    assertDecoyAliveAndClean(decoy);
  });

  // Test 08: Decisive silent fast-detach setsid regression (5 repeated iterations)
  await runTest("Decisive fast-detach: 5 repeated iterations confirm zero surviving descendants", async () => {
    const decoy = spawnDecoy();
    const manager = new PtyRunManager(baseConfig);
    for (let i = 0; i < 5; i++) {
      const token = `FAST_DETACH_TOKEN_REP_${i}_${Date.now()}`;
      const detachScript = path.join(realFixtureRoot, `fast_detach_rep_${i}.mjs`);
      await fs.writeFile(
        detachScript,
        `import cp from "node:child_process";
cp.spawn("setsid", ["sleep", "300", "${token}"], { stdio: "ignore" });
process.exit(0);
`
      );

      const result = await manager.run(
        {
          workspace_id: validWorkspaceId,
          argv: ["node", detachScript],
          timeout_ms: 10000
        },
        validationContext
      );

      assert.equal(result.state, "succeeded");
      assert.equal(result.exit_code, 0);
      assert.equal(manager.getActiveCount(), 0);

      await new Promise((r) => setTimeout(r, 25));
      const survivors = findHostProcessesWithToken(token);
      assert.deepEqual(survivors, [], `Iteration ${i}: Expected zero survivors carrying token ${token}`);
    }
    assertDecoyAliveAndClean(decoy);
  });

  // Test 09: Server-owned containment + ownership composition
  await runTest("Server-owned containment composition preserves TTY, prompt, and prevents fast-detach escape", async () => {
    const decoy = spawnDecoy();
    const token = `CONTAINMENT_DETACH_TOKEN_${Date.now()}`;
    const targetScript = path.join(realFixtureRoot, "containment_test.mjs");
    await fs.writeFile(
      targetScript,
      `import cp from "node:child_process";
import readline from "node:readline";

cp.spawn("sh", ["-c", \`setsid sleep 300 "${token}" &\`], { stdio: "ignore" });

console.log("CONTAINMENT_READY: isTTY=" + Boolean(process.stdout.isTTY));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("ENTER_ANSWER:", (answer) => {
  console.log("ANSWER_OK:" + answer);
  process.exit(0);
});`
    );

    const manager = new PtyRunManager(baseConfig, {
      containmentWrapper: ["/usr/bin/env"]
    });

    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", targetScript],
        steps: [
          {
            wait_for: "ENTER_ANSWER:",
            send: "test_answer",
            submit: true
          }
        ],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "succeeded");
    assert.equal(result.containment_enabled, true);
    assert.match(result.transcript, /CONTAINMENT_READY: isTTY=true/);
    assert.match(result.transcript, /ANSWER_OK:test_answer/);
    assert.equal(manager.getActiveCount(), 0);

    // Verify fast-detach child under containment was killed
    await new Promise((r) => setTimeout(r, 50));
    const survivors = findHostProcessesWithToken(token);
    assert.deepEqual(survivors, [], "Detached child under containment must not survive");
    assertDecoyAliveAndClean(decoy);
  });

  // Test 10: Invalid containment wrapper configuration fails closed before spawn
  await runTest("Invalid containment wrapper configuration fails before target execution", async () => {
    let initError = null;
    try {
      new PtyRunManager(baseConfig, {
        containmentWrapper: ["/nonexistent/containment/wrapper"]
      });
    } catch (err) {
      initError = err;
    }

    assert.ok(initError instanceof CodexProError);
    assert.equal(initError.code, "pty_containment_wrapper_invalid");
  });

  // Test 11: Nested descendant output-ceiling kills 3-level tree and preserves decoy
  await runTest("Nested output-ceiling kills leader -> child -> grandchild and preserves decoy", async () => {
    const decoy = spawnDecoy();
    const grandchildToken = `FLOOD_GRANDCHILD_${Date.now()}`;
    const childToken = `FLOOD_CHILD_${Date.now()}`;
    const leaderToken = `FLOOD_LEADER_${Date.now()}`;

    const grandchildScript = path.join(realFixtureRoot, "flood_grandchild.mjs");
    await fs.writeFile(
      grandchildScript,
      `// Grandchild floods output
while (true) {
  process.stdout.write("NESTED_FLOOD_0123456789ABCDEF\\n");
}`
    );

    const childScript = path.join(realFixtureRoot, "flood_child.mjs");
    await fs.writeFile(
      childScript,
      `import cp from "node:child_process";
cp.spawn("node", ["${grandchildScript}", "${grandchildToken}"], { stdio: ["ignore", "inherit", "ignore"] });
setInterval(() => {}, 1000);`
    );

    const floodScript = path.join(realFixtureRoot, "nested_flood_tree.mjs");
    await fs.writeFile(
      floodScript,
      `import cp from "node:child_process";
cp.spawn("node", ["${childScript}", "${childToken}"], { stdio: ["ignore", "inherit", "ignore"] });
setInterval(() => {}, 1000);`
    );

    const manager = new PtyRunManager(
      { ...baseConfig, maxOutputBytes: 2048 },
      { hardOutputCeilingBytes: 4096 }
    );

    const result = await manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", floodScript, leaderToken],
        timeout_ms: 10000
      },
      validationContext
    );

    assert.equal(result.state, "output_limit_exceeded");
    assert.ok(result.raw_observed_bytes >= 4096, `Expected >= 4096 raw bytes, got: ${result.raw_observed_bytes}`);
    assert.equal(result.truncated, true);
    assert.equal(manager.getActiveCount(), 0);

    // Verify all namespace descendants are dead
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(findHostProcessesWithToken(grandchildToken), [], "Grandchild must be dead");
    assert.deepEqual(findHostProcessesWithToken(childToken), [], "Child must be dead");
    assert.deepEqual(findHostProcessesWithToken(leaderToken), [], "Leader must be dead");
    assertDecoyAliveAndClean(decoy);
  });

  // Test 12: Manager close terminates active namespace process tree and verifies closed state
  await runTest("Manager close synchronously seals admission and cleans active namespace tree", async () => {
    const decoy = spawnDecoy();
    const token = `SHUTDOWN_NAMESPACE_TOKEN_${Date.now()}`;
    const targetScript = path.join(realFixtureRoot, "shutdown_target.mjs");
    await fs.writeFile(
      targetScript,
      `import cp from "node:child_process";
cp.spawn("setsid", ["sleep", "300", "${token}"], { stdio: "ignore" });
console.log("SHUTDOWN_FIXTURE_RUNNING");
setInterval(() => {}, 1000);`
    );

    const manager = new PtyRunManager(baseConfig);
    const runPromise = manager.run(
      {
        workspace_id: validWorkspaceId,
        argv: ["node", targetScript],
        steps: [{ wait_for: "SHUTDOWN_FIXTURE_RUNNING" }],
        timeout_ms: 15000
      },
      validationContext
    );

    // Wait until run is active
    let waited = 0;
    while (manager.getActiveCount() === 0 && waited < 40) {
      await new Promise((r) => setTimeout(r, 50));
      waited++;
    }
    assert.equal(manager.getActiveCount(), 1);

    // Close manager
    const closePromise = manager.close();
    assert.equal(manager.state, "closing");

    // Concurrent start during closing must reject immediately
    let lateStartError = null;
    try {
      await manager.run(
        { workspace_id: validWorkspaceId, argv: ["echo", "late"] },
        validationContext
      );
    } catch (err) {
      lateStartError = err;
    }
    assert.ok(lateStartError instanceof CodexProError);
    assert.equal(lateStartError.code, "pty_shutting_down");

    await closePromise;
    assert.equal(manager.state, "closed");
    assert.equal(manager.getActiveCount(), 0);

    const result = await runPromise;
    assert.equal(result.state, "terminated_on_shutdown");

    // Verify all namespace processes (including detached setsid) are dead on host
    await new Promise((r) => setTimeout(r, 50));
    const survivors = findHostProcessesWithToken(token);
    assert.deepEqual(survivors, [], "Detached setsid process must be dead after manager close");
    assertDecoyAliveAndClean(decoy);
  });

  // Test 13: Combined backend-error + timeout + exit race has exactly one outcome and clean accounting
  await runTest("Combined backend-error + timeout + exit race produces exactly one terminal outcome", async () => {
    const decoy = spawnDecoy();
    let triggerCount = 0;
    const manager = new PtyRunManager(baseConfig, {
      faultInjection: {
        onSpawn: ({ injectBackendError, triggerTimeout }) => {
          triggerCount++;
          // Concurrently trigger backend error, timeout, and child is exiting
          setTimeout(() => {
            injectBackendError(new Error("Injected race backend error"));
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
        validationContext
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

    assert.equal(manager.getActiveCount(), 0, "Capacity must be decremented exactly once");
    assertDecoyAliveAndClean(decoy);
  });

  // Test 14: Post-SIGKILL wait expiry fails closed with pty_cleanup_incomplete
  await runTest("Post-SIGKILL wait expiry fails closed with pty_cleanup_incomplete", async () => {
    const manager = new PtyRunManager(baseConfig, {
      processGraceTimeoutMs: 50,
      processKillWaitTimeoutMs: 50,
      isAliveChecker: () => true // Simulate processes refusing to exit even after SIGKILL
    });

    let caughtError = null;
    try {
      await manager.run(
        {
          workspace_id: validWorkspaceId,
          argv: ["node", "-e", "process.exit(0);"],
          timeout_ms: 1000
        },
        validationContext
      );
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof CodexProError);
    assert.equal(caughtError.code, "pty_cleanup_incomplete");
    assert.match(caughtError.message, /PTY process tree cleanup incomplete/);
    assert.equal(manager.getActiveCount(), 0, "Active count must be decremented even on cleanup failure");
  });

  console.log(`\nAll ${passedTests} of ${totalTests} TASK-005R1 ownership tests passed successfully!`);
} finally {
  try {
    await fs.rm(realFixtureRoot, { recursive: true, force: true });
  } catch {}
}
