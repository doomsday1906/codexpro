#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager, CodexProError } from "../dist/guard.js";
import { PTY_LIMITS, validatePtyRunInput } from "../dist/ptyValidator.js";
import {
  PtyRunManager,
  terminatePtyProcessTree,
  isPidAlive,
  isProcessTreeAlive,
  trimMatcherBuffer
} from "../dist/ptyRunManager.js";
import * as zigpty from "zigpty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-004 PtyRunManager Core & Scripted Interaction Smoke");

// Set up isolated temporary workspace directory
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m010-task004-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "fixture-pkg" }, null, 2));
await fs.mkdir(path.join(realFixtureRoot, "src"), { recursive: true });
await fs.mkdir(path.join(realFixtureRoot, ".git"), { recursive: true });

// Setup test synthetic scripts
const promptCliScript = path.join(realFixtureRoot, "prompt_cli.mjs");
await fs.writeFile(
  promptCliScript,
  `import readline from "node:readline";

const stdinIsTTY = Boolean(process.stdin.isTTY);
const stdoutIsTTY = Boolean(process.stdout.isTTY);
const cols = process.stdout.columns ?? 0;
const rows = process.stdout.rows ?? 0;
const term = process.env.TERM ?? "";
const noColor = process.env.NO_COLOR ?? "";
const ci = process.env.CI ?? "NOT_SET";

console.log(\`DIAG: tty=\${stdinIsTTY}/\${stdoutIsTTY} cols=\${cols} rows=\${rows} term=\${term} no_color=\${noColor} ci=\${ci}\`);

if (!stdinIsTTY || !stdoutIsTTY || cols !== 80 || rows !== 24 || term !== "xterm-256color" || noColor !== "1" || ci !== "NOT_SET") {
  console.error("DIAG: Environment/profile check failed!");
  process.exit(2);
}

process.stdout.write("Enter confirmation code: ");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

rl.question("", (answer) => {
  rl.close();
  const trimmed = answer.trim();
  if (trimmed === "CONFIRM_42") {
    console.log("Success: code accepted!");
    process.exit(0);
  } else {
    console.error(\`Failure: unexpected code '\${trimmed}'\`);
    process.exit(1);
  }
});
`
);

// Multi-step script with stale-prompt emission
const multiStepScript = path.join(realFixtureRoot, "multi_step_cli.mjs");
await fs.writeFile(
  multiStepScript,
  `import readline from "node:readline";

// Intentionally emit Step 2 prompt EARLY before Step 1 is answered to falsify stale-prompt matching!
process.stdout.write("Step 1: enter token: Step 2: enter code: ");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

rl.question("", (ans1) => {
  const t1 = ans1.trim();
  if (t1 !== "token_alpha") {
    console.error("Step 1 token mismatch: " + t1);
    process.exit(1);
  }
  // Now emit the REAL fresh Step 2 prompt
  process.stdout.write("\\nStep 1 verified. Step 2: enter code: ");
  rl.question("", (ans2) => {
    rl.close();
    const t2 = ans2.trim();
    if (t2 !== "code_beta") {
      console.error("Step 2 code mismatch: " + t2);
      process.exit(2);
    }
    console.log("\\nAll steps successfully completed!");
    process.exit(0);
  });
});
`
);

// Wait-only script
const waitOnlyScript = path.join(realFixtureRoot, "wait_only_cli.mjs");
await fs.writeFile(
  waitOnlyScript,
  `import readline from "node:readline";

process.stdout.write("Subsystem initializing...\\n");
setTimeout(() => {
  process.stdout.write("Subsystem ready.\\n");
  setTimeout(() => {
    process.stdout.write("Proceed with finalization? [y/N]: ");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.question("", (ans) => {
      rl.close();
      if (ans.trim() === "y") {
        console.log("Finalized successfully!");
        process.exit(0);
      } else {
        process.exit(1);
      }
    });
  }, 50);
}, 50);
`
);

// Secret-echoing script
const secretScript = path.join(realFixtureRoot, "secret_cli.mjs");
await fs.writeFile(
  secretScript,
  `import readline from "node:readline";

process.stdout.write("Password prompt: ");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.question("", (ans) => {
  rl.close();
  console.log("Authentication complete.");
  process.exit(0);
});
`
);

// Output ceiling flood script
const floodScript = path.join(realFixtureRoot, "flood_cli.mjs");
await fs.writeFile(
  floodScript,
  `let count = 0;
const interval = setInterval(() => {
  process.stdout.write("FLOOD_DATA_LINE_" + count++ + "_abcdefghijklmnopqrstuvwxyz0123456789\\n");
}, 5);
`
);

// Escape and token script
const escapesAndTokenScript = path.join(realFixtureRoot, "escapes_token_cli.mjs");
await fs.writeFile(
  escapesAndTokenScript,
  `process.stdout.write("\\x1b[31mRed text\\x1b[0m and \\x1b]0;Evil Title\\x07Token: ghp_123456789012345678901234567890123456 is active.\\n");
setTimeout(() => {
  process.exit(0);
}, 50);
`
);

// Valid containment wrapper script
const wrapperScript = path.join(realFixtureRoot, "test_wrapper.sh");
await fs.writeFile(
  wrapperScript,
  `#!/bin/sh
exec "$@"
`
);
await fs.chmod(wrapperScript, 0o755);

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
// Test 01: Native backend gate on accepted environment
// --------------------------------------------------------------------------
await test("zigpty native backend is available on Linux/WSL x64", () => {
  assert.equal(zigpty.hasNative, true, "zigpty.hasNative must be true on supported environment");
  assert.equal(typeof zigpty.spawn, "function", "zigpty.spawn must be a function");
});

// --------------------------------------------------------------------------
// Test 02: Real PTY synthetic prompt CLI succeeds (AP-008)
// --------------------------------------------------------------------------
await test("synthetic prompt CLI succeeds under real PTY with fixed profile", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", promptCliScript],
      steps: [
        {
          wait_for: "Enter confirmation code: ",
          send: "CONFIRM_42",
          submit: true,
          timeout_ms: 5000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  assert.equal(result.exit_code, 0);
  assert.equal(result.signal, null);
  assert.match(result.transcript, /DIAG: tty=true\/true cols=80 rows=24 term=xterm-256color no_color=1 ci=NOT_SET/);
  assert.match(result.transcript, /Success: code accepted!/);
  assert.equal(result.terminal_profile.cols, 80);
  assert.equal(result.terminal_profile.rows, 24);
  assert.equal(result.terminal_profile.term, "xterm-256color");
  assert.equal(result.terminal_profile.no_color, "1");
  assert.equal(result.containment_enabled, false);

  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].step_index, 0);
  assert.equal(result.steps[0].matched, true);
  assert.equal(result.steps[0].submit, true);
  assert.equal(result.steps[0].input_bytes_sent, Buffer.byteLength("CONFIRM_42", "utf8")); // LAW-011: caller send bytes only, without Enter
  assert.ok(result.steps[0].elapsed_ms >= 0);

  assert.equal(manager.getActiveCount(), 0, "No active runs should remain in manager after completion");
});

// --------------------------------------------------------------------------
// Test 03: Multi-step sequential interaction + stale prompt falsifier
// --------------------------------------------------------------------------
await test("multi-step sequential interaction rejects stale early prompt", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", multiStepScript],
      steps: [
        {
          wait_for: "Step 1: enter token: ",
          send: "token_alpha",
          submit: true,
          timeout_ms: 5000
        },
        {
          wait_for: "Step 2: enter code: ",
          send: "code_beta",
          submit: true,
          timeout_ms: 5000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  assert.equal(result.exit_code, 0);
  assert.match(result.transcript, /All steps successfully completed!/);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].matched, true);
  assert.equal(result.steps[1].matched, true);
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 04: Wait-only step (matches without writing)
// --------------------------------------------------------------------------
await test("wait-only step matches without writing input", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", waitOnlyScript],
      steps: [
        {
          wait_for: "Subsystem ready.",
          submit: false,
          timeout_ms: 5000
        },
        {
          wait_for: "Proceed with finalization? [y/N]: ",
          send: "y",
          submit: true,
          timeout_ms: 5000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  assert.equal(result.exit_code, 0);
  assert.match(result.transcript, /Finalized successfully!/);
  assert.equal(result.steps[0].matched, true);
  assert.equal(result.steps[0].input_bytes_sent, 0, "Wait-only step must send 0 bytes");
  assert.equal(result.steps[0].submit, false);
  assert.equal(result.steps[1].matched, true);
  assert.equal(result.steps[1].input_bytes_sent, 1, "Must count only 1 byte from 'y' without Enter byte");
  assert.equal(result.steps[1].submit, true);
});

// --------------------------------------------------------------------------
// Test 05: Metadata secrecy (caller send text never leaks into metadata)
// --------------------------------------------------------------------------
await test("caller send text is strictly absent from step and result metadata", async () => {
  const manager = new PtyRunManager(baseConfig);
  const secretText = "TOP_SECRET_AUTH_TOKEN_XYZZY_99999";

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", secretScript],
      steps: [
        {
          wait_for: "Password prompt: ",
          send: secretText,
          submit: true,
          timeout_ms: 5000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  // Inspect metadata serialization
  const metadataJson = JSON.stringify(result.steps);
  assert.equal(metadataJson.includes(secretText), false, "Secret text must never appear in step metadata JSON");

  // Inspect result object properties (excluding transcript where child might echo)
  const nonTranscriptKeys = Object.keys(result).filter((k) => k !== "transcript");
  for (const key of nonTranscriptKeys) {
    const val = JSON.stringify(result[key]);
    assert.equal(val?.includes(secretText), false, `Secret text must not appear in result.${key}`);
  }

  // Exact step metadata shape
  const step0 = result.steps[0];
  assert.deepEqual(Object.keys(step0).sort(), ["elapsed_ms", "input_bytes_sent", "matched", "step_index", "submit"].sort());
  assert.equal(step0.input_bytes_sent, Buffer.byteLength(secretText, "utf8"), "Must count only caller send bytes");
  assert.equal(step0.submit, true);
});

// --------------------------------------------------------------------------
// Test 06: Native backend gate fails closed when hasNative=false
// --------------------------------------------------------------------------
await test("manager fails closed before spawn when backend hasNative is false", async () => {
  let spawnCalled = false;
  const mockBackend = {
    hasNative: false,
    spawn: () => {
      spawnCalled = true;
      throw new Error("spawn should not be called");
    }
  };

  const manager = new PtyRunManager(baseConfig, { backend: mockBackend });

  await assert.rejects(
    async () => {
      await manager.run(
        {
          workspace_id: validWorkspaceId,
          argv: ["node", "-e", "process.exit(0)"]
        },
        context
      );
    },
    (err) => {
      assert.ok(err instanceof CodexProError);
      assert.equal(err.code, "pty_backend_unavailable");
      assert.match(err.message, /PTY backend is unavailable: native PTY bindings are missing/);
      return true;
    }
  );

  assert.equal(spawnCalled, false, "Backend spawn must never be called when hasNative is false");
  assert.equal(manager.getActiveCount(), 0, "No capacity slot should remain reserved");
});

// --------------------------------------------------------------------------
// Test 07: Unproven platform fails closed before spawn
// --------------------------------------------------------------------------
await test("manager fails closed before spawn on unproven platforms", async () => {
  const manager = new PtyRunManager(baseConfig, { platform: "darwin", arch: "arm64" });

  await assert.rejects(
    async () => {
      await manager.run(
        {
          workspace_id: validWorkspaceId,
          argv: ["node", "-e", "process.exit(0)"]
        },
        context
      );
    },
    (err) => {
      assert.ok(err instanceof CodexProError);
      assert.equal(err.code, "pty_platform_unsupported");
      assert.match(err.message, /PTY execution is only supported on Linux\/WSL x64/);
      return true;
    }
  );

  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 08: Capacity limit maxActive=2 with immediate rejection and no queue
// --------------------------------------------------------------------------
await test("capacity limit maxActive=2 rejects 3rd run immediately with no queue", async () => {
  const manager = new PtyRunManager(baseConfig, { maxActive: 2 });

  const req1 = await validatePtyRunInput(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "console.log('READY1'); setInterval(() => {}, 1000);"],
      steps: [{ wait_for: "NEVER_HAPPENING", timeout_ms: 10000 }],
      timeout_ms: 10000
    },
    baseConfig,
    context
  );

  const req2 = await validatePtyRunInput(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "console.log('READY2'); setInterval(() => {}, 1000);"],
      steps: [{ wait_for: "NEVER_HAPPENING", timeout_ms: 10000 }],
      timeout_ms: 10000
    },
    baseConfig,
    context
  );

  const req3 = await validatePtyRunInput(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "process.exit(0)"]
    },
    baseConfig,
    context
  );

  // Synchronously execute run 1 and run 2
  const p1 = manager.execute(req1);
  const p2 = manager.execute(req2);

  assert.equal(manager.getActiveCount(), 2, "Active count must be exactly 2");

  // Attempt 3rd run synchronously
  await assert.rejects(
    async () => {
      await manager.execute(req3);
    },
    (err) => {
      assert.ok(err instanceof CodexProError);
      assert.equal(err.code, "pty_capacity_reached");
      assert.match(err.message, /PTY concurrency limit reached: maximum 2 active PTY runs/);
      return true;
    }
  );

  assert.equal(manager.getActiveCount(), 2, "Active count must remain 2 after rejected run");

  // Close manager to clean up the two running tasks
  await manager.close();
  assert.equal(manager.getActiveCount(), 0, "Active count must be 0 after close");

  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1.state, "terminated_on_shutdown");
  assert.equal(r2.state, "terminated_on_shutdown");
});

// --------------------------------------------------------------------------
// Test 09: Lifecycle open -> closing -> closed and synchronous admission seal
// --------------------------------------------------------------------------
await test("lifecycle transitions open -> closing -> closed with immediate admission seal", async () => {
  const manager = new PtyRunManager(baseConfig);
  assert.equal(manager.state, "open");

  const reqRun = await validatePtyRunInput(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "console.log('RUNNING'); setInterval(() => {}, 1000);"],
      timeout_ms: 10000
    },
    baseConfig,
    context
  );

  const reqBlocked = await validatePtyRunInput(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "process.exit(0)"]
    },
    baseConfig,
    context
  );

  const pRun = manager.execute(reqRun);

  // Trigger close
  const closePromise = manager.close();
  assert.equal(manager.state, "closing", "Manager must synchronously transition to closing");

  // Immediate admission seal: new runs must fail immediately while closing
  await assert.rejects(
    async () => {
      await manager.execute(reqBlocked);
    },
    (err) => {
      assert.ok(err instanceof CodexProError);
      assert.equal(err.code, "pty_shutting_down");
      assert.match(err.message, /PTY execution rejected: manager is closing/);
      return true;
    }
  );

  await closePromise;
  assert.equal(manager.state, "closed");

  // New runs must fail after closed
  await assert.rejects(
    async () => {
      await manager.execute(reqBlocked);
    },
    (err) => {
      assert.ok(err instanceof CodexProError);
      assert.equal(err.code, "pty_shutting_down");
      assert.match(err.message, /PTY execution rejected: manager is closed/);
      return true;
    }
  );

  const res = await pRun;
  assert.equal(res.state, "terminated_on_shutdown");
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 10: Server-owned containment wrapper preserves PTY execution
// --------------------------------------------------------------------------
await test("server-owned containment wrapper preserves TTY/interaction and reports boolean", async () => {
  const manager = new PtyRunManager(baseConfig, { containmentWrapper: [wrapperScript] });

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", promptCliScript],
      steps: [
        {
          wait_for: "Enter confirmation code: ",
          send: "CONFIRM_42",
          submit: true,
          timeout_ms: 5000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  assert.equal(result.exit_code, 0);
  assert.equal(result.containment_enabled, true, "containment_enabled must be true");
  assert.match(result.transcript, /Success: code accepted!/);

  // Verify private wrapper path/argv does not appear in result object
  const resultJson = JSON.stringify(result);
  assert.equal(resultJson.includes("test_wrapper.sh"), false, "Wrapper script path must not leak into result");
});

// --------------------------------------------------------------------------
// Test 11: Invalid containment wrapper fails before spawn
// --------------------------------------------------------------------------
await test("invalid containment wrapper fails closed before spawn", async () => {
  assert.throws(
    () => {
      new PtyRunManager(baseConfig, { containmentWrapper: ["/nonexistent/wrapper/path/to/fail"] });
    },
    (err) => {
      assert.ok(err instanceof CodexProError);
      assert.equal(err.code, "pty_containment_wrapper_invalid");
      assert.match(err.message, /containment wrapper/);
      return true;
    }
  );
});

// --------------------------------------------------------------------------
// Test 12: Output pipeline sanitization and secret redaction
// --------------------------------------------------------------------------
await test("output pipeline sanitizes terminal controls and redacts secrets", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", escapesAndTokenScript],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  // Terminal controls should be sanitized
  assert.equal(result.transcript.includes("\x1b[31m"), false, "CSI color escapes must be sanitized");
  assert.equal(result.transcript.includes("\x1b]0;"), false, "OSC title escapes must be sanitized");
  // Redaction should catch GitHub token
  assert.equal(result.transcript.includes("ghp_123456789012345678901234567890123456"), false, "Raw token must be redacted");
  assert.match(result.transcript, /\[REDACTED_SECRET\]/, "Redaction marker must be present");
  assert.ok(result.raw_observed_bytes > 0);
});

// --------------------------------------------------------------------------
// Test 13: Step timeout terminates process tree
// --------------------------------------------------------------------------
await test("step timeout terminates child and yields step_timeout state", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "console.log('INIT'); setInterval(() => {}, 1000);"],
      steps: [
        {
          wait_for: "NEVER_ARRIVING_PROMPT_STRING",
          timeout_ms: 1000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "step_timeout");
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].matched, false);
  assert.ok(result.steps[0].elapsed_ms >= 900);
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 14: Overall timeout terminates child
// --------------------------------------------------------------------------
await test("overall timeout terminates child and yields timed_out state", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "console.log('SLEEPING'); setInterval(() => {}, 1000);"],
      timeout_ms: 1000
    },
    context
  );

  assert.equal(result.state, "timed_out");
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 15: Output ceiling exceeded terminates child
// --------------------------------------------------------------------------
await test("hard output ceiling exceeded terminates child and yields output_limit_exceeded state", async () => {
  const manager = new PtyRunManager(baseConfig, { hardOutputCeilingBytes: 2048 });

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", floodScript],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "output_limit_exceeded");
  assert.ok(result.raw_observed_bytes >= 2048);
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 16: No continuity surface exists (AP-009)
// --------------------------------------------------------------------------
await test("runtime and manager expose zero continuity surface", async () => {
  const manager = new PtyRunManager(baseConfig);

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", "-e", "console.log('HELLO'); process.exit(0);"],
      timeout_ms: 5000
    },
    context
  );

  // Assert result object contains no continuity identity
  assert.equal("run_id" in result, false, "result must not contain run_id");
  assert.equal("pty_id" in result, false, "result must not contain pty_id");
  assert.equal("terminal_id" in result, false, "result must not contain terminal_id");

  // Assert manager contains no continuity methods or storage
  assert.equal(typeof manager.getRun, "undefined", "manager must not have getRun");
  assert.equal(typeof manager.lookup, "undefined", "manager must not have lookup");
  assert.equal(typeof manager.attach, "undefined", "manager must not have attach");
  assert.equal(typeof manager.resume, "undefined", "manager must not have resume");
  assert.equal(typeof manager.wait, "undefined", "manager must not have wait");
  assert.equal(typeof manager.cancel, "undefined", "manager must not have cancel");
  assert.equal(typeof manager.completed, "undefined", "manager must not have completed storage");
  assert.equal(typeof manager.history, "undefined", "manager must not have history");

  assert.equal(manager.getActiveCount(), 0, "Manager holds zero completed records");
});

// --------------------------------------------------------------------------
// Test 17: Release model verification (npm ci --omit=dev --ignore-scripts)
// --------------------------------------------------------------------------
await test("release model staging with npm ci --omit=dev --ignore-scripts loads zigpty native", async () => {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-release-staging-"));
  try {
    await fs.copyFile(path.join(repoRoot, "package.json"), path.join(staging, "package.json"));
    await fs.copyFile(path.join(repoRoot, "package-lock.json"), path.join(staging, "package-lock.json"));

    execSync("npm ci --omit=dev --ignore-scripts", { cwd: staging, stdio: "ignore" });

    const testLoadScript = "import('zigpty').then(z => console.log('STAGED_HAS_NATIVE=' + z.hasNative));";
    const out = execSync(`node --input-type=module -e "${testLoadScript}"`, { cwd: staging, encoding: "utf8" });
    assert.match(out, /STAGED_HAS_NATIVE=true/);

    const nodeModules = await fs.readdir(path.join(staging, "node_modules"));
    assert.ok(nodeModules.includes("zigpty"), "node_modules must include zigpty");

    const prebuildPath = path.join(staging, "node_modules/zigpty/prebuilds/zigpty.linux-x64.node");
    const stat = await fs.stat(prebuildPath);
    assert.ok(stat.isFile(), "Prebuild binary must exist");
    assert.ok((stat.mode & 0o111) !== 0, "Prebuild binary must be executable (0o755)");
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// Test 18: Physical proof of cleanup on shutdown with TERM/SIGHUP-resistant leader and descendant
// --------------------------------------------------------------------------
await test("shutdown cleanly awaits termination of TERM/SIGHUP-resistant leader and descendant", async () => {
  const leaderPidFile = path.join(realFixtureRoot, "shutdown_leader.pid");
  const descPidFile = path.join(realFixtureRoot, "shutdown_desc.pid");
  const testScript = path.join(realFixtureRoot, "term_hup_resistant_shutdown.sh");

  await fs.writeFile(
    testScript,
    `#!/bin/bash
trap '' TERM HUP
(
  trap '' TERM HUP
  echo "$BASHPID" > "${descPidFile}"
  while true; do sleep 0.05; done
) &
echo "$$" > "${leaderPidFile}"
while true; do sleep 0.05; done
`
  );
  await fs.chmod(testScript, 0o755);

  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 300,
    processKillWaitTimeoutMs: 500
  });

  const runPromise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: [testScript],
      steps: [
        {
          wait_for: "NEVER_HAPPENING_PROMPT",
          timeout_ms: 10000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  let leaderPid = 0;
  let descPid = 0;
  for (let i = 0; i < 100; i++) {
    try {
      const lText = (await fs.readFile(leaderPidFile, "utf8")).trim();
      const dText = (await fs.readFile(descPidFile, "utf8")).trim();
      if (lText && dText) {
        leaderPid = parseInt(lText, 10);
        descPid = parseInt(dText, 10);
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.ok(leaderPid > 0, "Leader PID must be established");
  assert.ok(descPid > 0, "Descendant PID must be established");
  assert.equal(isPidAlive(leaderPid), true, "Leader must be initially alive");
  assert.equal(isPidAlive(descPid), true, "Descendant must be initially alive");

  // Call close() on manager
  const closePromise = manager.close();
  assert.equal(manager.state, "closing", "Manager must immediately transition to closing");

  // Await close and run
  await closePromise;
  const result = await runPromise;

  // Assert IMMEDIATELY that both leader and descendant are physically dead
  assert.equal(isPidAlive(leaderPid), false, "Leader must be dead immediately after close completes");
  assert.equal(isPidAlive(descPid), false, "Descendant must be dead immediately after close completes");
  assert.equal(isProcessTreeAlive(leaderPid), false, "Process tree must be dead immediately after close completes");
  assert.equal(manager.state, "closed", "Manager state must be closed");
  assert.equal(manager.getActiveCount(), 0, "Active count must be 0");
  assert.equal(result.state, "terminated_on_shutdown", "Result state must be terminated_on_shutdown");

  // Verify that subsequent waiting does not uncover unhandled delayed kill timers
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 19: Physical proof of cleanup on timeout with TERM/SIGHUP-resistant leader and descendant
// --------------------------------------------------------------------------
await test("step timeout cleanly awaits termination of TERM/SIGHUP-resistant leader and descendant", async () => {
  const leaderPidFile = path.join(realFixtureRoot, "timeout_leader.pid");
  const descPidFile = path.join(realFixtureRoot, "timeout_desc.pid");
  const testScript = path.join(realFixtureRoot, "term_hup_resistant_timeout.sh");

  await fs.writeFile(
    testScript,
    `#!/bin/bash
trap '' TERM HUP
(
  trap '' TERM HUP
  echo "$BASHPID" > "${descPidFile}"
  while true; do sleep 0.05; done
) &
echo "$$" > "${leaderPidFile}"
while true; do sleep 0.05; done
`
  );
  await fs.chmod(testScript, 0o755);

  const manager = new PtyRunManager(baseConfig, {
    processGraceTimeoutMs: 300,
    processKillWaitTimeoutMs: 500
  });

  const runPromise = manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: [testScript],
      steps: [
        {
          wait_for: "NEVER_HAPPENING_PROMPT",
          timeout_ms: 600
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  let leaderPid = 0;
  let descPid = 0;
  for (let i = 0; i < 100; i++) {
    try {
      const lText = (await fs.readFile(leaderPidFile, "utf8")).trim();
      const dText = (await fs.readFile(descPidFile, "utf8")).trim();
      if (lText && dText) {
        leaderPid = parseInt(lText, 10);
        descPid = parseInt(dText, 10);
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }

  assert.ok(leaderPid > 0, "Leader PID must be established");
  assert.ok(descPid > 0, "Descendant PID must be established");
  assert.equal(isPidAlive(leaderPid), true, "Leader must be initially alive");
  assert.equal(isPidAlive(descPid), true, "Descendant must be initially alive");

  const result = await runPromise;

  // Assert IMMEDIATELY that both leader and descendant are physically dead
  assert.equal(isPidAlive(leaderPid), false, "Leader must be dead immediately after timeout resolves");
  assert.equal(isPidAlive(descPid), false, "Descendant must be dead immediately after timeout resolves");
  assert.equal(isProcessTreeAlive(leaderPid), false, "Process tree must be dead immediately after timeout resolves");
  assert.equal(manager.getActiveCount(), 0, "Active count must be 0");
  assert.equal(result.state, "step_timeout", "Result state must be step_timeout");
});

// --------------------------------------------------------------------------
// Test 20: Matcher bound repair with 1-character wait_for
// --------------------------------------------------------------------------
await test("one-character wait_for does not retain entire unmatched buffer via slice(-0)", async () => {
  // 1. Pure unit test on trimMatcherBuffer
  assert.equal(trimMatcherBuffer("ABC", 1), "", "wait_for length 1 must return empty suffix");
  assert.equal(trimMatcherBuffer("ABC", 2), "C", "wait_for length 2 must return 1-char suffix");
  assert.equal(trimMatcherBuffer("ABC", 3), "BC", "wait_for length 3 must return 2-char suffix");
  assert.equal(trimMatcherBuffer("ABC", 4), "ABC", "wait_for length 4 must return full 3-char buffer");

  // 2. Integration test under PTY execution emitting substantial output
  const floodNoZScript = path.join(realFixtureRoot, "flood_no_z.mjs");
  await fs.writeFile(
    floodNoZScript,
    `setInterval(() => {
  process.stdout.write("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n");
}, 5);
`
  );

  let observedMaxMatcherLen = 0;
  const manager = new PtyRunManager(baseConfig, {
    onMatcherBufferUpdate: (len) => {
      if (len > observedMaxMatcherLen) {
        observedMaxMatcherLen = len;
      }
    }
  });

  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", floodNoZScript],
      steps: [
        {
          wait_for: "Z", // 1 character that is never produced
          timeout_ms: 600
        }
      ],
      timeout_ms: 5000
    },
    context
  );

  assert.equal(result.state, "step_timeout");
  assert.ok(result.raw_observed_bytes > 1000, "Should have processed substantial output");
  assert.equal(observedMaxMatcherLen, 0, "For wait_for.length === 1, matcher buffer must remain strictly 0 bytes after trim");
  assert.equal(manager.getActiveCount(), 0);
});

// --------------------------------------------------------------------------
// Test 21: LAW-011 caller-byte metadata accounting and submit separation
// --------------------------------------------------------------------------
await test("LAW-011 caller-byte metadata counts only caller send bytes and separates submit", async () => {
  const metadataCli = path.join(realFixtureRoot, "metadata_test_cli.mjs");
  await fs.writeFile(
    metadataCli,
    `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

process.stdout.write("P1: ");
rl.question("", (a1) => {
  process.stdout.write("P2: ");
  // Do not read for P2; output P3
  setTimeout(() => {
    process.stdout.write("P3: ");
    rl.question("", (a3) => {
      process.stdout.write("P4: ");
      setTimeout(() => {
        console.log("DONE");
        process.exit(0);
      }, 50);
    });
  }, 50);
});
`
  );

  const manager = new PtyRunManager(baseConfig);
  const result = await manager.run(
    {
      workspace_id: validWorkspaceId,
      argv: ["node", metadataCli],
      steps: [
        {
          wait_for: "P1: ",
          send: "HELLO",
          submit: true,
          timeout_ms: 3000
        },
        {
          wait_for: "P2: ",
          send: "WORLD",
          submit: false,
          timeout_ms: 3000
        },
        {
          wait_for: "P3: ",
          send: "",
          submit: true,
          timeout_ms: 3000
        },
        {
          wait_for: "P4: ",
          submit: false,
          timeout_ms: 3000
        }
      ],
      timeout_ms: 10000
    },
    context
  );

  assert.equal(result.state, "succeeded");
  assert.equal(result.steps.length, 4);

  // Step 0: "HELLO", submit: true -> input_bytes_sent: 5, submit: true
  assert.equal(result.steps[0].matched, true);
  assert.equal(result.steps[0].input_bytes_sent, 5, "Must count exactly 5 bytes from 'HELLO' without Enter byte");
  assert.equal(result.steps[0].submit, true);

  // Step 1: "WORLD", submit: false -> input_bytes_sent: 5, submit: false
  assert.equal(result.steps[1].matched, true);
  assert.equal(result.steps[1].input_bytes_sent, 5, "Must count exactly 5 bytes from 'WORLD'");
  assert.equal(result.steps[1].submit, false);

  // Step 2: "", submit: true -> input_bytes_sent: 0, submit: true
  assert.equal(result.steps[2].matched, true);
  assert.equal(result.steps[2].input_bytes_sent, 0, "Empty send must count 0 bytes even when submit is true");
  assert.equal(result.steps[2].submit, true);

  // Step 3: undefined send, submit: false -> input_bytes_sent: 0, submit: false
  assert.equal(result.steps[3].matched, true);
  assert.equal(result.steps[3].input_bytes_sent, 0, "Omitted send must count 0 bytes");
  assert.equal(result.steps[3].submit, false);
});

// Cleanup fixture
try {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
} catch {}

console.log(`\nAll ${testsPassed} of ${testsRun} TASK-004 tests passed successfully!`);
