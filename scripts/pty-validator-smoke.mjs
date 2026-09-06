#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager, CodexProError } from "../dist/guard.js";
import {
  PTY_LIMITS,
  BLOCKED_SHELLS,
  BLOCKED_MULTIPLEXERS,
  BLOCKED_REMOTE_SESSIONS,
  BLOCKED_EDITORS_PAGERS,
  extractExecutableBasename,
  assertNotPersistentProgram,
  assertSafeArgv,
  assertPtyBashAuthority,
  validatePtyArgv,
  validatePtySteps,
  resolvePtyTimeout,
  validatePtyRunInput,
  PTY_RUN_ARGUMENTS_SCHEMA,
  PTY_STEP_ARGUMENTS_SCHEMA,
  PTY_RUN_PUBLIC_SCHEMA
} from "../dist/ptyValidator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-002 Public Schema & Authority Falsifier Smoke");

// Set up an isolated temporary workspace directory
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m010-task002-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

// Create valid workspace files
await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "fixture-pkg" }, null, 2));
await fs.mkdir(path.join(realFixtureRoot, "src"), { recursive: true });
await fs.writeFile(path.join(realFixtureRoot, "src", "index.js"), "console.log('hello');\n");
await fs.mkdir(path.join(realFixtureRoot, ".git"), { recursive: true });

const baseConfig = loadConfig([
  "--root", realFixtureRoot,
  "--allow-root", realFixtureRoot,
  "--bash-mode", "safe"
]);
const guard = new PathGuard(baseConfig);
const workspaces = new WorkspaceManager(baseConfig);
const testWorkspace = workspaces.openWorkspace(realFixtureRoot, { select: true });
const validWorkspaceId = testWorkspace.id;

console.log(`Initialized fixture workspace: ${validWorkspaceId} -> ${realFixtureRoot}`);

let testsRun = 0;
let testsPassed = 0;

async function test(name, fn) {
  testsRun++;
  try {
    await fn();
    testsPassed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}:`, err.message);
    throw err;
  }
}

async function assertRejects(fn, expectedPattern, label) {
  try {
    await fn();
    assert.fail(`Expected rejection for: ${label}`);
  } catch (err) {
    if (err.name === "AssertionError" && err.message.startsWith("Expected rejection")) {
      throw err;
    }
    if (expectedPattern) {
      assert.match(
        err.message,
        expectedPattern,
        `Error message '${err.message}' must match expected pattern ${expectedPattern} for: ${label}`
      );
    }
  }
}

console.log("\n=== Section 1: Required Adversarial Matrix (Items 1-30) ===");

// 1. Missing workspace_id rejected
await test("1. missing workspace_id rejected", async () => {
  await assertRejects(
    () => validatePtyRunInput({ argv: ["git", "status"] }, baseConfig, { guard, workspaces }),
    /workspace_id|Required|validation/i,
    "missing workspace_id"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: "", argv: ["git", "status"] }, baseConfig, { guard, workspaces }),
    /workspace_id/i,
    "empty workspace_id"
  );
});

// 2. Malformed workspace_id rejected
await test("2. malformed workspace_id rejected", async () => {
  const invalidIds = [
    "ws_not_hex_00000000000000000",
    "ws_12345", // too short
    "ws_66892e912609200aa5a4f44b_extra", // too long
    "not_ws_prefix_66892e912609200aa5a4",
    "ws_ 66892e912609200aa5a4f44", // contains space
    "../../../etc/passwd", // traversal
    "default" // ambient attempt
  ];
  for (const id of invalidIds) {
    await assertRejects(
      () => validatePtyRunInput({ workspace_id: id, argv: ["git", "status"] }, baseConfig, { guard, workspaces }),
      /workspace_id/i,
      `malformed workspace_id '${id}'`
    );
  }
});

// 3. argv empty rejected
await test("3. argv empty rejected", async () => {
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: [] }, baseConfig, { guard, workspaces }),
    /argv/i,
    "empty argv array"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["   "] }, baseConfig, { guard, workspaces }),
    /empty|whitespace/i,
    "whitespace executable argv"
  );
});

// 4. argv >64 rejected
await test("4. argv >64 rejected", async () => {
  const bigArgv = ["ls", ...Array.from({ length: 64 }, (_, i) => `arg${i}`)]; // 65 elements total
  assert.equal(bigArgv.length, 65);
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: bigArgv }, baseConfig, { guard, workspaces }),
    /argv must not exceed 64 elements/i,
    "argv with 65 elements"
  );
});

// 5. argv element >1024 bytes rejected
await test("5. argv element >1024 bytes rejected", async () => {
  const overlongElement = "a".repeat(1025);
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["ls", overlongElement] }, baseConfig, { guard, workspaces }),
    /1024.*bytes/i,
    "argv element of 1025 bytes"
  );
  // Multibyte element test: 513 two-byte characters = 1026 bytes
  const multibyteOverlong = "é".repeat(513);
  assert.equal(Buffer.byteLength(multibyteOverlong, "utf8"), 1026);
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["ls", multibyteOverlong] }, baseConfig, { guard, workspaces }),
    /1024.*bytes/i,
    "multibyte argv element of 1026 bytes"
  );
});

// 6. argv total >8192 bytes rejected
await test("6. argv total >8192 bytes rejected", async () => {
  // 9 elements of 1000 bytes = 9000 bytes (> 8192 max total)
  const heavyArgv = ["ls", ...Array.from({ length: 9 }, () => "x".repeat(1000))];
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: heavyArgv }, baseConfig, { guard, workspaces }),
    /Total argv payload exceeds maximum of 8192 bytes/i,
    "argv payload of 9002 bytes"
  );
});

// 7. NUL/CR/LF argv rejected
await test("7. NUL/CR/LF argv rejected", async () => {
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["git", "status\0"] }, baseConfig, { guard, workspaces }),
    /NUL/i,
    "argv with NUL"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["git", "status\r"] }, baseConfig, { guard, workspaces }),
    /CR|newline/i,
    "argv with CR"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["git", "status\n"] }, baseConfig, { guard, workspaces }),
    /LF|newline/i,
    "argv with LF"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["git", "status\r\nevil"] }, baseConfig, { guard, workspaces }),
    /CR|LF|newline/i,
    "argv with CRLF"
  );
});

// 8. No raw command-string field
await test("8. no raw command-string field", async () => {
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, command: "ls -la" }, baseConfig, { guard, workspaces }),
    /Unknown field 'command'/i,
    "command string field"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["ls"], command: "ls -la" }, baseConfig, { guard, workspaces }),
    /Unknown field 'command'/i,
    "command string field with argv"
  );
});

// 9. No caller env
await test("9. no caller env", async () => {
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["ls"], env: { PATH: "/bad" } }, baseConfig, { guard, workspaces }),
    /Unknown field 'env'/i,
    "caller env object"
  );
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["ls"], environment: { FOO: "bar" } }, baseConfig, { guard, workspaces }),
    /Unknown field 'environment'/i,
    "caller environment object"
  );
});

// 10. Valid bounded direct argv accepted under appropriate authority
await test("10. valid bounded direct argv accepted under appropriate authority", async () => {
  const result = await validatePtyRunInput(
    { workspace_id: validWorkspaceId, argv: ["git", "status"] },
    baseConfig,
    { guard, workspaces }
  );
  assert.equal(result.workspaceId, validWorkspaceId);
  assert.deepEqual(result.argv, ["git", "status"]);
  assert.equal(result.timeoutMs, 30_000); // default
  assert.deepEqual(result.steps, []);
});

// 11. Bash off rejected
await test("11. Bash off rejected", async () => {
  const offConfig = { ...baseConfig, bashMode: "off" };
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["git", "status"] }, offConfig, { guard, workspaces }),
    /pty_run is disabled because bash is disabled/i,
    "Bash mode off"
  );
});

// 12. Bash safe allowed case succeeds validation
await test("12. Bash safe allowed case succeeds validation", async () => {
  const safeConfig = { ...baseConfig, bashMode: "safe" };
  const allowedCases = [
    ["pwd"],
    ["ls"],
    ["ls", "-la"],
    ["git", "status"],
    ["git", "diff"],
    ["git", "log", "-n", "5"],
    ["npm", "test"],
    ["npm", "run", "test"],
    ["npm", "run", "typecheck"],
    ["npm", "run", "build:clients"],
    ["pytest"],
    ["python3", "-m", "pytest"],
    ["cargo", "test"]
  ];
  for (const argv of allowedCases) {
    const res = await validatePtyRunInput(
      { workspace_id: validWorkspaceId, argv },
      safeConfig,
      { guard, workspaces }
    );
    assert.deepEqual(res.argv, argv, `Allowed safe case: ${argv.join(" ")}`);
  }
});

// 13. Safe-mode dangerous command families rejected
await test("13. safe-mode dangerous command families rejected", async () => {
  const safeConfig = { ...baseConfig, bashMode: "safe" };
  const dangerousCommands = [
    ["rm", "-rf", "file"],
    ["mv", "a", "b"],
    ["cp", "a", "b"],
    ["dd", "if=/dev/zero", "of=file"],
    ["sudo", "ls"],
    ["chmod", "777", "file"],
    ["chown", "root", "file"],
    ["kill", "-9", "1234"],
    ["pkill", "node"],
    ["curl", "https://example.com"],
    ["wget", "https://example.com"],
    ["ssh", "user@host"],
    ["scp", "a", "b"],
    ["rsync", "a", "b"],
    ["docker", "run", "alpine"],
    ["podman", "run", "alpine"],
    ["git", "push"],
    ["git", "reset", "--hard"],
    ["git", "clean", "-fd"],
    ["git", "checkout", "main"],
    ["git", "switch", "main"],
    ["git", "restore", "file"],
    ["npm", "publish"],
    ["cat", "file"],
    ["grep", "pattern", "file"]
  ];
  for (const argv of dangerousCommands) {
    await assertRejects(
      () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv }, safeConfig, { guard, workspaces }),
      /safe bash allowlist|blocked in CODEXPRO_BASH_MODE=safe/i,
      `dangerous command: ${argv.join(" ")}`
    );
  }
});

// 14. Safe-mode structured argv cannot bypass existing policy with delimiters/quotes/spaces
await test("14. safe-mode structured argv cannot bypass existing policy with delimiters/quotes/spaces", async () => {
  const safeConfig = { ...baseConfig, bashMode: "safe" };
  const bypassAttempts = [
    ["git", "status; rm -rf /"],
    ["git", "status", ";", "rm", "-rf", "/"],
    ["npm", "test && curl evil.com"],
    ["npm", "test | cat"],
    ["git", "diff", "`rm -rf /`"],
    ["git", "log", "$(whoami)"],
    ["ls", ">", "out.txt"],
    ["ls", "<", "in.txt"],
    ["ls", "../.."],
    ["ls", "/etc/passwd"],
    ["ls", "~/.ssh"],
    ["git", "status", ".env"],
    ["git", "status", ".git"],
    ["git", "status", "node_modules"],
    ["git", "status", "--no-index"],
    ["git", "status", "--fix"],
    ["find", ".", "-exec", "sh", "{}"],
    ["find", ".", "-delete"],
    ["git", "status", "--output=evil.txt"]
  ];
  for (const argv of bypassAttempts) {
    await assertRejects(
      () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv }, safeConfig, { guard, workspaces }),
      /safe bash allowlist|blocked in CODEXPRO_BASH_MODE=safe/i,
      `structured bypass attempt: ${JSON.stringify(argv)}`
    );
  }
});

// 15. Bash full permits otherwise legitimate direct argv
await test("15. Bash full permits otherwise legitimate direct argv", async () => {
  const fullConfig = { ...baseConfig, bashMode: "full" };
  const fullModeCases = [
    ["node", "src/index.js"],
    ["node", "-e", "process.stdout.write('test')"],
    ["python3", "setup.py", "build"],
    ["python3", "-c", "print('hello')"],
    ["make", "build"],
    ["gcc", "-o", "bin/prog", "src/main.c"],
    ["git", "commit", "-m", "chore: test"],
    ["git", "push", "origin", "main"]
  ];
  for (const argv of fullModeCases) {
    const res = await validatePtyRunInput(
      { workspace_id: validWorkspaceId, argv },
      fullConfig,
      { guard, workspaces }
    );
    assert.deepEqual(res.argv, argv, `Permitted full mode case: ${argv.join(" ")}`);
  }
});

// 16. Bash full still rejects persistent shell/session/editor/pager surfaces
await test("16. Bash full still rejects persistent shell/session/editor/pager surfaces", async () => {
  const fullConfig = { ...baseConfig, bashMode: "full" };
  const persistentSurfaces = [
    // Shells
    ["bash"],
    ["/bin/bash"],
    ["/usr/bin/bash"],
    ["sh"],
    ["/bin/sh"],
    ["zsh"],
    ["/usr/local/bin/zsh"],
    ["fish"],
    ["dash"],
    ["ksh"],
    ["nu"],
    ["cmd"],
    ["cmd.exe"],
    ["C:\\Windows\\System32\\cmd.exe"],
    ["powershell"],
    ["powershell.exe"],
    ["pwsh"],
    // Multiplexers
    ["tmux"],
    ["/usr/bin/tmux"],
    ["screen"],
    // Remote sessions
    ["ssh", "user@host"],
    ["/usr/bin/ssh", "host"],
    ["mosh", "server"],
    ["telnet", "localhost", "23"],
    // Editors / pagers
    ["vi", "file.txt"],
    ["vim", "file.txt"],
    ["/usr/bin/vim", "file.txt"],
    ["nvim", "file.txt"],
    ["emacs", "file.txt"],
    ["nano", "file.txt"],
    ["less", "file.txt"],
    ["more", "file.txt"],
    ["top"],
    ["htop"]
  ];
  for (const argv of persistentSurfaces) {
    await assertRejects(
      () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv }, fullConfig, { guard, workspaces }),
      /forbidden in pty_run/i,
      `persistent program: ${argv[0]}`
    );
  }
});

// 17. Plain REPL forms rejected while bounded script/module forms are not accidentally rejected without reason
await test("17. plain REPL forms rejected while bounded script/module forms accepted", async () => {
  const fullConfig = { ...baseConfig, bashMode: "full" };

  // Plain REPLs & interactive bypasses -> MUST REJECT
  const replForms = [
    ["node"],
    ["/usr/bin/node"],
    ["node", "-i"],
    ["node", "--interactive"],
    ["node", "-i", "-e", "console.log(1)"],
    ["node", "--interactive", "script.js"],
    ["node", "-i", "script.js"],
    ["node", "--experimental-vm-modules"], // flag-only without script
    ["bun"],
    ["bun", "repl"],
    ["deno"],
    ["deno", "repl"],
    ["python"],
    ["python3"],
    ["/usr/bin/python3"],
    ["python3.12"],
    ["python", "-i"],
    ["python", "--interactive"],
    ["python", "-i", "script.py"], // -i enters REPL after script
    ["python3", "-u"], // flag-only without script
    ["irb"]
  ];
  for (const argv of replForms) {
    await assertRejects(
      () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv }, fullConfig, { guard, workspaces }),
      /Interactive REPL/i,
      `plain/interactive REPL: ${argv.join(" ")}`
    );
  }

  // Bounded script/module forms -> MUST ACCEPT
  const boundedForms = [
    ["node", "src/index.js"],
    ["node", "-e", "console.log(1)"],
    ["node", "--eval", "console.log(1)"],
    ["node", "-p", "process.version"],
    ["node", "--experimental-vm-modules", "test.js"],
    ["python", "script.py"],
    ["python3", "setup.py", "test"],
    ["python", "-c", "print(1)"],
    ["python3", "-m", "pytest", "tests/"],
    ["python3.12", "run.py"]
  ];
  for (const argv of boundedForms) {
    const res = await validatePtyRunInput(
      { workspace_id: validWorkspaceId, argv },
      fullConfig,
      { guard, workspaces }
    );
    assert.deepEqual(res.argv, argv, `bounded form: ${argv.join(" ")}`);
  }
});

// 18. Session guard absent/mismatch/correct behavior matches existing policy
await test("18. session guard absent/mismatch/correct behavior matches existing policy", async () => {
  const sessionConfig = {
    ...baseConfig,
    requireBashSession: true,
    bashSessionId: "session-secret-12345"
  };

  // Absent when required -> rejected
  await assertRejects(
    () => validatePtyRunInput({ workspace_id: validWorkspaceId, argv: ["git", "status"] }, sessionConfig, { guard, workspaces }),
    /bash session id is required/i,
    "missing session_id when required"
  );

  // Mismatch -> rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      session_id: "wrong-session-token"
    }, sessionConfig, { guard, workspaces }),
    /bash session id mismatch/i,
    "mismatched session_id"
  );

  // Matching -> accepted
  const res = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    session_id: "session-secret-12345"
  }, sessionConfig, { guard, workspaces });
  assert.equal(res.sessionId, "session-secret-12345");
});

// 19. cwd PathGuard behavior remains exact and requires workspace-relative syntax
await test("19. cwd PathGuard behavior remains exact and requires workspace-relative syntax", async () => {
  // 1. cwd: "src" -> accepted
  const validRes = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    cwd: "src"
  }, baseConfig, { guard, workspaces });
  assert.equal(validRes.cwd, path.join(realFixtureRoot, "src"));

  // 2. cwd: "." -> accepted
  const validDotRes = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    cwd: "."
  }, baseConfig, { guard, workspaces });
  assert.equal(validDotRes.cwd, realFixtureRoot);

  // 3. Absolute path to an existing directory inside the fixture workspace -> rejected
  const insideAbs = path.join(realFixtureRoot, "src");
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: insideAbs
    }, baseConfig, { guard, workspaces }),
    /cwd must be workspace-relative; absolute and home-expanded paths are forbidden/i,
    "absolute cwd inside workspace"
  );

  // 4. Absolute path outside workspace -> rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: "/tmp"
    }, baseConfig, { guard, workspaces }),
    /cwd must be workspace-relative; absolute and home-expanded paths are forbidden/i,
    "absolute cwd outside workspace"
  );

  // 5. ~ -> rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: "~"
    }, baseConfig, { guard, workspaces }),
    /cwd must be workspace-relative; absolute and home-expanded paths are forbidden/i,
    "home path ~"
  );

  // 6. ~/... value that would resolve to the workspace if expanded -> rejected before PathGuard
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: "~/some/path"
    }, baseConfig, { guard, workspaces }),
    /cwd must be workspace-relative; absolute and home-expanded paths are forbidden/i,
    "home path ~/some/path"
  );

  // 7. ../.. and ../../outside remain rejected by PathGuard
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: "../.."
    }, baseConfig, { guard, workspaces }),
    /Path escapes workspace root/i,
    "cwd traversal escape ../.."
  );

  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: "../../outside"
    }, baseConfig, { guard, workspaces }),
    /Path escapes workspace root/i,
    "cwd traversal escape ../../outside"
  );

  // 8. .git remains rejected by PathGuard
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: ".git"
    }, baseConfig, { guard, workspaces }),
    /blocked|Cannot access/i,
    "cwd targeting .git"
  );

  // 9. Existing valid relative cwd still returns correct absolute resolved cwd
  assert.equal(validRes.cwd, path.join(realFixtureRoot, "src"));
  assert.equal(validDotRes.cwd, realFixtureRoot);
});

// 20. > 16 steps rejected
await test("20. > 16 steps rejected", async () => {
  const seventeenSteps = Array.from({ length: 17 }, (_, i) => ({
    wait_for: `prompt_${i}:`
  }));
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: seventeenSteps
    }, baseConfig, { guard, workspaces }),
    /steps must not exceed 16/i,
    "17 steps array"
  );

  // Exactly 16 steps -> allowed
  const sixteenSteps = Array.from({ length: 16 }, (_, i) => ({
    wait_for: `prompt_${i}:`
  }));
  const res = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: sixteenSteps
  }, baseConfig, { guard, workspaces });
  assert.equal(res.steps.length, 16);
});

// 21. Missing/empty invalid wait_for rejected according to frozen rule
await test("21. missing/empty invalid wait_for rejected according to frozen rule", async () => {
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ send: "admin" }] // missing wait_for
    }, baseConfig, { guard, workspaces }),
    /wait_for/i,
    "step missing wait_for"
  );

  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: "" }] // empty wait_for
    }, baseConfig, { guard, workspaces }),
    /wait_for/i,
    "step empty wait_for"
  );

  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: 1234 }] // non-string wait_for
    }, baseConfig, { guard, workspaces }),
    /wait_for|string/i,
    "step non-string wait_for"
  );
});

// 22. wait_for >512 bytes rejected
await test("22. wait_for >512 bytes rejected", async () => {
  const overlongWaitFor = "P".repeat(513);
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: overlongWaitFor }]
    }, baseConfig, { guard, workspaces }),
    /exceeds maximum length of 512 bytes|512/i,
    "wait_for of 513 bytes"
  );

  // Exactly 512 bytes -> allowed
  const exactWaitFor = "P".repeat(512);
  const res = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: exactWaitFor }]
  }, baseConfig, { guard, workspaces });
  assert.equal(res.steps[0].wait_for, exactWaitFor);
});

// 23. send >2048 bytes rejected
await test("23. send >2048 bytes rejected", async () => {
  const overlongSend = "S".repeat(2049);
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: "prompt:", send: overlongSend }]
    }, baseConfig, { guard, workspaces }),
    /exceeds maximum length of 2048 bytes|2048/i,
    "send of 2049 bytes"
  );

  // Exactly 2048 bytes -> allowed
  const exactSend = "S".repeat(2048);
  const res = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: "prompt:", send: exactSend }]
  }, baseConfig, { guard, workspaces });
  assert.equal(res.steps[0].send, exactSend);
});

// 24. Aggregate send >8192 bytes rejected
await test("24. aggregate send >8192 bytes rejected", async () => {
  // 5 steps with 1800 bytes each = 9000 bytes (> 8192 total limit)
  const heavySteps = Array.from({ length: 5 }, (_, i) => ({
    wait_for: `prompt_${i}:`,
    send: "A".repeat(1800)
  }));
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: heavySteps
    }, baseConfig, { guard, workspaces }),
    /Total caller send payload across all steps exceeds maximum of 8192 bytes/i,
    "aggregate send of 9000 bytes"
  );

  // Exactly 8192 bytes across 4 steps of 2048 bytes -> allowed
  const exactSteps = Array.from({ length: 4 }, (_, i) => ({
    wait_for: `prompt_${i}:`,
    send: "A".repeat(2048)
  }));
  const res = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: exactSteps
  }, baseConfig, { guard, workspaces });
  assert.equal(res.steps.length, 4);
});

// 25. Caller CR/LF/NUL/ESC/control bytes rejected
await test("25. caller CR/LF/NUL/ESC/control bytes rejected in wait_for and send", async () => {
  const hostileBytes = [
    { label: "NUL", byte: "\x00" },
    { label: "SOH (C0)", byte: "\x01" },
    { label: "BEL (C0)", byte: "\x07" },
    { label: "CR", byte: "\r" },
    { label: "LF", byte: "\n" },
    { label: "ESC", byte: "\x1b" },
    { label: "DEL", byte: "\x7f" },
    { label: "ANSI color sequence", byte: "\x1b[31m" },
    { label: "OSC sequence", byte: "\x1b]0;title\x07" }
  ];

  for (const { label, byte } of hostileBytes) {
    // In wait_for
    await assertRejects(
      () => validatePtyRunInput({
        workspace_id: validWorkspaceId,
        argv: ["git", "status"],
        steps: [{ wait_for: `prompt${byte}:` }]
      }, baseConfig, { guard, workspaces }),
      /control characters|escape sequences|forbidden/i,
      `wait_for with ${label}`
    );

    // In send
    await assertRejects(
      () => validatePtyRunInput({
        workspace_id: validWorkspaceId,
        argv: ["git", "status"],
        steps: [{ wait_for: "prompt:", send: `text${byte}` }]
      }, baseConfig, { guard, workspaces }),
      /control characters|escape sequences|forbidden/i,
      `send with ${label}`
    );
  }
});

// 26. submit type/semantics bounded
await test("26. submit type/semantics bounded", async () => {
  // Boolean true accepted
  const resTrue = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: "prompt:", send: "yes", submit: true }]
  }, baseConfig, { guard, workspaces });
  assert.equal(resTrue.steps[0].submit, true);

  // Boolean false accepted
  const resFalse = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: "prompt:", send: "no", submit: false }]
  }, baseConfig, { guard, workspaces });
  assert.equal(resFalse.steps[0].submit, false);

  // Non-boolean submit rejected
  const badSubmits = ["true", 1, {}, []];
  for (const bad of badSubmits) {
    await assertRejects(
      () => validatePtyRunInput({
        workspace_id: validWorkspaceId,
        argv: ["git", "status"],
        steps: [{ wait_for: "prompt:", submit: bad }]
      }, baseConfig, { guard, workspaces }),
      /submit|boolean/i,
      `non-boolean submit '${JSON.stringify(bad)}'`
    );
  }
});

// 27. step timeout positive integer <= 30000ms validated; unaccepted 100ms floor removed
await test("27. step timeout positive integer <= 30000ms validated", async () => {
  // > 30,000 ms rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: "prompt:", timeout_ms: 35_000 }]
    }, baseConfig, { guard, workspaces }),
    /30000/i,
    "step timeout 35000 ms"
  );

  // <= 0 rejected (must be positive integer)
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: "prompt:", timeout_ms: 0 }]
    }, baseConfig, { guard, workspaces }),
    /positive/i,
    "step timeout 0 ms"
  );

  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: "prompt:", timeout_ms: -50 }]
    }, baseConfig, { guard, workspaces }),
    /positive/i,
    "step timeout -50 ms"
  );

  // Positive integer < 100 ms accepted (100 ms floor removed)
  const resSmall = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: "prompt:", timeout_ms: 50 }]
  }, baseConfig, { guard, workspaces });
  assert.equal(resSmall.steps[0].timeout_ms, 50);

  // Valid step timeout accepted
  const res = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: "prompt:", timeout_ms: 15_000 }]
  }, baseConfig, { guard, workspaces });
  assert.equal(res.steps[0].timeout_ms, 15_000);

  // Omitted step timeout defaults to 10,000 ms
  const resDefault = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: "prompt:" }]
  }, baseConfig, { guard, workspaces });
  assert.equal(resDefault.steps[0].timeout_ms, 10_000);
});

// 28. Overall timeout min/default/max exact
await test("28. overall timeout min/default/max exact", async () => {
  // Default is 30,000 ms
  const defaultRes = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"]
  }, baseConfig, { guard, workspaces });
  assert.equal(defaultRes.timeoutMs, 30_000);

  // Minimum is 1,000 ms; < 1,000 rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      timeout_ms: 999
    }, baseConfig, { guard, workspaces }),
    /timeout_ms must be at least 1000|between 1000 ms and 60000 ms/i,
    "overall timeout 999 ms"
  );

  // Exactly 1,000 ms accepted
  const minRes = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    timeout_ms: 1_000
  }, baseConfig, { guard, workspaces });
  assert.equal(minRes.timeoutMs, 1_000);

  // Hard max is 60,000 ms; > 60,000 rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      timeout_ms: 60_001
    }, baseConfig, { guard, workspaces }),
    /timeout_ms must not exceed 60000|between 1000 ms and 60000 ms/i,
    "overall timeout 60001 ms"
  );

  // Exactly 60,000 ms accepted
  const maxRes = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    timeout_ms: 60_000
  }, baseConfig, { guard, workspaces });
  assert.equal(maxRes.timeoutMs, 60_000);

  // Non-integer rejected
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      timeout_ms: 30000.5
    }, baseConfig, { guard, workspaces }),
    /integer/i,
    "non-integer overall timeout"
  );

  // Stricter server maxBashTimeoutMs honored
  const strictConfig = { ...baseConfig, maxBashTimeoutMs: 15_000 };
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      timeout_ms: 20_000
    }, strictConfig, { guard, workspaces }),
    /between 1000 ms and 15000 ms/i,
    "timeout exceeding strict maxBashTimeoutMs"
  );
});

// 29. Unknown fields rejected
await test("29. unknown fields rejected", async () => {
  const hostileKeys = [
    "command",
    "env",
    "environment",
    "shell",
    "stdin",
    "input",
    "pty_id",
    "terminal_id",
    "detach",
    "background",
    "rows",
    "cols",
    "term",
    "TERM",
    "resize",
    "signal",
    "wrapper",
    "wrapper_path",
    "containment_wrapper",
    "executable",
    "pipe"
  ];

  for (const key of hostileKeys) {
    await assertRejects(
      () => validatePtyRunInput({
        workspace_id: validWorkspaceId,
        argv: ["git", "status"],
        [key]: "malicious_payload"
      }, baseConfig, { guard, workspaces }),
      new RegExp(`Unknown field '${key}' is rejected`, "i"),
      `unknown key '${key}'`
    );
  }

  // Unknown key in step object
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{
        wait_for: "prompt:",
        raw_input: "evil"
      }]
    }, baseConfig, { guard, workspaces }),
    /Unrecognized key|contains forbidden unknown field|raw_input/i,
    "unknown step key 'raw_input'"
  );
});

// 30. No public PTY id/attach/detach/background/session surface exists
await test("30. no public PTY id/attach/detach/background/session surface exists", async () => {
  // Verify public Zod schema properties
  const shape = PTY_RUN_ARGUMENTS_SCHEMA.shape;
  const allowedKeys = ["workspace_id", "argv", "steps", "cwd", "timeout_ms", "session_id"];
  assert.deepEqual(Object.keys(shape).sort(), allowedKeys.sort());

  // Confirm absence of session/run/attach properties in the schema
  const forbiddenKeys = ["pty_id", "terminal_id", "attach", "detach", "background", "resume", "job_id"];
  for (const k of forbiddenKeys) {
    assert.equal(shape[k], undefined, `Public schema must not contain '${k}'`);
  }

  // Verify step schema shape
  const stepShape = PTY_STEP_ARGUMENTS_SCHEMA.shape;
  const allowedStepKeys = ["wait_for", "send", "submit", "timeout_ms"];
  assert.deepEqual(Object.keys(stepShape).sort(), allowedStepKeys.sort());
});

console.log("\n=== Section 2: Extended Adversarial Falsifiers (AP-004 & AP-005) ===");

// 31. Direct executable path normalization and basename extraction
await test("31. executable path normalization and basename extraction", () => {
  assert.equal(extractExecutableBasename("bash"), "bash");
  assert.equal(extractExecutableBasename("/bin/bash"), "bash");
  assert.equal(extractExecutableBasename("/usr/bin/bash"), "bash");
  assert.equal(extractExecutableBasename("C:\\Windows\\System32\\cmd.exe"), "cmd");
  assert.equal(extractExecutableBasename("powershell.exe"), "powershell");
  assert.equal(extractExecutableBasename("/usr/local/bin/tmux"), "tmux");
  assert.equal(extractExecutableBasename("/usr/bin/python3"), "python3");
  assert.equal(extractExecutableBasename("node"), "node");
  assert.equal(extractExecutableBasename("SCRIPT.BAT"), "script");
});

// 32. All blocked shell variants rejected regardless of path casing or slashes
await test("32. all blocked shell variants rejected across path variations", () => {
  const shellVariants = [
    "/bin/sh",
    "/usr/bin/sh",
    "/bin/bash",
    "/usr/bin/bash",
    "/usr/local/bin/zsh",
    "fish",
    "/usr/bin/fish",
    "dash",
    "ksh",
    "nu",
    "cmd",
    "cmd.exe",
    "CMD.EXE",
    "C:\\Windows\\System32\\cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "/usr/bin/pwsh",
    "csh",
    "/bin/csh",
    "tcsh",
    "/usr/bin/tcsh"
  ];
  for (const s of shellVariants) {
    assert.throws(
      () => assertNotPersistentProgram([s]),
      /Persistent\/session shell execution is forbidden/i,
      `Shell variant: ${s}`
    );
  }
});

// 33. All blocked multiplexer, remote login, and editor variants rejected
await test("33. all blocked multiplexers, remote login, and editors rejected", () => {
  const apps = [
    ["tmux"], ["/usr/bin/tmux"],
    ["screen"],
    ["zellij"], ["/usr/bin/zellij"],
    ["ssh"], ["/usr/bin/ssh"],
    ["mosh"], ["telnet"],
    ["vi"], ["vim"], ["/usr/bin/vim"],
    ["nvim"], ["emacs"], ["nano"],
    ["less"], ["more"], ["top"], ["htop"]
  ];
  for (const app of apps) {
    assert.throws(
      () => assertNotPersistentProgram(app),
      /forbidden in pty_run/i,
      `App: ${app[0]}`
    );
  }
});

// 34. UTF-8 multi-byte characters in wait_for and send stay within exact byte boundaries
await test("34. UTF-8 multi-byte boundary accounting in steps", async () => {
  // Each emoji 🚀 is 4 bytes. 128 emojis = 512 bytes (exact max)
  const exactEmoji = "🚀".repeat(128);
  assert.equal(Buffer.byteLength(exactEmoji, "utf8"), 512);
  const okRes = await validatePtyRunInput({
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    steps: [{ wait_for: exactEmoji }]
  }, baseConfig, { guard, workspaces });
  assert.equal(okRes.steps[0].wait_for, exactEmoji);

  // 129 emojis = 516 bytes (> 512 max)
  const overEmoji = "🚀".repeat(129);
  assert.equal(Buffer.byteLength(overEmoji, "utf8"), 516);
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      steps: [{ wait_for: overEmoji }]
    }, baseConfig, { guard, workspaces }),
    /512.*bytes/i,
    "wait_for with 516 bytes of UTF-8 emojis"
  );
});

// 35. Pure McpServer Zod schema compilation and validation
await test("35. PTY_RUN_PUBLIC_SCHEMA compiles and strictly validates shapes", () => {
  const validPayload = {
    workspace_id: validWorkspaceId,
    argv: ["git", "status"],
    cwd: ".",
    timeout_ms: 30000
  };
  const parseOk = PTY_RUN_PUBLIC_SCHEMA.safeParse(validPayload);
  assert.equal(parseOk.success, true);

  // Hostile property rejection
  const hostilePayload = {
    ...validPayload,
    pty_id: "pty_12345"
  };
  const parseHostile = PTY_RUN_PUBLIC_SCHEMA.safeParse(hostilePayload);
  assert.equal(parseHostile.success, false);
});

// 36. Mandatory security context (PathGuard and WorkspaceManager) fail-closed enforcement
await test("36. mandatory security context (PathGuard and WorkspaceManager) fail-closed enforcement", async () => {
  const validPayload = {
    workspace_id: validWorkspaceId,
    argv: ["git", "status"]
  };

  // 1. Omitted validation context cannot yield an execution-ready request
  await assertRejects(
    () => validatePtyRunInput(validPayload, baseConfig),
    /Security context with PathGuard and WorkspaceManager is mandatory/i,
    "omitted context"
  );
  await assertRejects(
    () => validatePtyRunInput(validPayload, baseConfig, null),
    /Security context with PathGuard and WorkspaceManager is mandatory/i,
    "null context"
  );
  await assertRejects(
    () => validatePtyRunInput(validPayload, baseConfig, undefined),
    /Security context with PathGuard and WorkspaceManager is mandatory/i,
    "undefined context"
  );

  // 2. Omitted WorkspaceManager fails closed
  await assertRejects(
    () => validatePtyRunInput(validPayload, baseConfig, { guard }),
    /WorkspaceManager is mandatory/i,
    "missing WorkspaceManager"
  );

  // 3. Omitted PathGuard fails closed
  await assertRejects(
    () => validatePtyRunInput(validPayload, baseConfig, { workspaces }),
    /PathGuard is mandatory/i,
    "missing PathGuard"
  );

  // 4. Syntactically valid but unknown ws_<24hex> cannot be mapped onto config.defaultRoot
  const unknownWorkspaceId = "ws_0123456789abcdef01234567";
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: unknownWorkspaceId,
      argv: ["git", "status"]
    }, baseConfig, { guard, workspaces }),
    /Unknown workspace_id/i,
    "syntactically valid but unknown workspace_id"
  );

  // 5. Explicit valid workspace still resolves correctly
  const okRes = await validatePtyRunInput(validPayload, baseConfig, { guard, workspaces });
  assert.equal(okRes.workspaceId, validWorkspaceId);
  assert.equal(okRes.workspaceRoot, realFixtureRoot);
  assert.equal(okRes.cwd, realFixtureRoot);

  // 6. cwd always passes PathGuard
  await assertRejects(
    () => validatePtyRunInput({
      workspace_id: validWorkspaceId,
      argv: ["git", "status"],
      cwd: "../../outside"
    }, baseConfig, { guard, workspaces }),
    /Path escapes workspace root/i,
    "cwd escaping workspace root"
  );
});

// Clean up fixture root
await fs.rm(fixtureRoot, { recursive: true, force: true });

console.log(`\n# All ${testsRun} TASK-002 adversarial tests passed cleanly (${testsPassed}/${testsRun}).`);
console.log("# AP-004 VERDICT: PASS (PTY grants no authority above existing Bash/session policy).");
console.log("# AP-005 VERDICT: PASS (No shell/env/persistent-session/control-input escape exists).");
