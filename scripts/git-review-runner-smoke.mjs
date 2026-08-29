import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import {
  GitExecutionError,
  gitDiff,
  gitDiffStatus,
  gitLog,
  gitStatus,
  runGitReadOnly
} from "../dist/gitOps.js";
import { PathGuard } from "../dist/guard.js";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-review-runner-"));
const repoRoot = path.join(fixtureRoot, "repo");
await mkdir(repoRoot);
const workspace = { id: "runner-smoke", root: repoRoot, openedAt: new Date().toISOString() };

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value));
}

function directGit(args, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_CONFIG;
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    env,
    input: options.input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: asBuffer(result.stdout),
    stderr: asBuffer(result.stderr),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(args, options = {}) {
  const result = directGit(args, options);
  if (result.error || result.status !== 0) {
    throw new Error(
      `fixture git failed: ${args.join(" ")} status=${result.status} error=${result.error?.message ?? ""} stderr=${result.stderr.toString("utf8")}`
    );
  }
  return result;
}

function text(buffer) {
  return buffer.toString("utf8");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, maxMs = 800) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await exists(filePath)) return true;
    await delay(25);
  }
  return exists(filePath);
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const state = stat.match(/^\d+ \(.+\) ([A-Z]) /)?.[1];
      return Boolean(state && state !== "Z");
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function configEnvironment(maxGitTimeoutMs) {
  return {
    CODEXPRO_ROOT: repoRoot,
    CODEBASE_BRIDGE_REPO_ROOT: undefined,
    CODEXPRO_ALLOWED_ROOTS: undefined,
    CODEBASE_BRIDGE_ALLOWED_ROOTS: undefined,
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
    CODEXPRO_HTTP_TOKEN: undefined,
    CODEBASE_BRIDGE_HTTP_TOKEN: undefined,
    CODEXPRO_CONTEXT_DIR: ".ai-bridge",
    CODEXPRO_MAX_OUTPUT_BYTES: "120000",
    CODEXPRO_MAX_GIT_TIMEOUT_MS: maxGitTimeoutMs
  };
}

async function configFor(maxGitTimeoutMs = "60000") {
  return withEnvironment(configEnvironment(maxGitTimeoutMs), () => loadConfig([]));
}

async function expectFailure(operation, expectedFailure) {
  try {
    await operation();
    assert.fail(`expected typed ${expectedFailure} failure`);
  } catch (error) {
    assert.ok(error instanceof GitExecutionError, `expected GitExecutionError, got ${error?.constructor?.name ?? typeof error}`);
    assert.equal(error.failure, expectedFailure);
    return error;
  }
}

function assertBoundedResult(result, cap) {
  assert.ok(result && typeof result.stdout === "string");
  assert.ok(result && typeof result.stderr === "string");
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= cap);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= cap);
  assert.ok(result.exitCode === null || Number.isInteger(result.exitCode));
}

function aliasCommand(pidFile, body) {
  return `!sh -c 'printf "%s" "$$" > "${pidFile}"; ${body}'`;
}

const baseConfig = await configFor();
const guard = new PathGuard(baseConfig);
const runnerConfig = { maxGitTimeoutMs: 3_000, maxOutputBytes: 120_000 };

// Build a disposable real repository and capture direct Git observations before
// interpreting the compiled runner's classifications.
mustGit(["init", "--quiet"]);
mustGit(["config", "user.name", "Runner Smoke"]);
mustGit(["config", "user.email", "runner-smoke@example.test"]);
await writeFile(path.join(repoRoot, "tracked.txt"), "base line\n");
mustGit(["add", "tracked.txt"]);
mustGit(["commit", "--quiet", "-m", "runner base commit"]);
const initialSha = text(mustGit(["rev-parse", "HEAD"]).stdout).trim();

await writeFile(path.join(repoRoot, "tracked.txt"), "base line\nchanged line\n");
await writeFile(path.join(repoRoot, "untracked.txt"), "untracked\n");
const rawStatus = text(directGit(["status", "--short", "--branch"]).stdout);
const rawDiff = text(directGit(["diff"]).stdout);
assert.match(rawStatus, /## /);
assert.match(rawStatus, /tracked\.txt/);
assert.match(rawStatus, /untracked\.txt/);
assert.match(rawDiff, /changed line/);
console.log(`RAW_OBSERVATION: disposable repository status exposes tracked modification and untracked file; diff exposes changed line; HEAD=${initialSha}`);
console.log("SANITY_VERDICT: MATCH (direct local-Git facts satisfy the accepted runner test preconditions)");

// Config boundary is independently read from loadConfig, not inferred from the runner.
assert.equal((await configFor(undefined)).maxGitTimeoutMs, 60_000);
assert.equal((await configFor("0")).maxGitTimeoutMs, 1_000);
assert.equal((await configFor("999999")).maxGitTimeoutMs, 300_000);
console.log("PASS config default=60000ms min=1000ms max=300000ms");

// Existing string-oriented wrappers remain on their ordinary current-worktree path.
const wrapperStatus = gitStatus(baseConfig, workspace);
const wrapperDiff = gitDiff(baseConfig, guard, workspace);
const wrapperDiffStatus = gitDiffStatus(baseConfig, guard, workspace);
const wrapperLog = gitLog(baseConfig, workspace, 8);
assert.match(wrapperStatus, /## /);
assert.match(wrapperStatus, /tracked\.txt/);
assert.match(wrapperDiff, /changed line/);
assert.match(wrapperDiffStatus, /tracked\.txt/);
assert.match(wrapperDiffStatus, /untracked\.txt/);
assert.match(wrapperLog, /runner base commit/);
console.log("PASS legacy gitStatus/gitDiff/gitDiffStatus/gitLog ordinary wrapper behavior");

const success = await runGitReadOnly(runnerConfig, workspace, ["rev-parse", "--verify", "HEAD"]);
assert.equal(success.exitCode, 0);
assert.equal(success.signal, null);
assert.equal(success.timedOut, false);
assert.equal(success.stdout.trim(), initialSha);
assert.equal(success.stderr, "");
assert.equal(success.stdoutOverflow, false);
assert.equal(success.stderrOverflow, false);
console.log("PASS success captures stdout separately, empty stderr, numeric exit=0, and no timeout/overflow");

const missing = await expectFailure(
  () => runGitReadOnly(runnerConfig, workspace, ["cat-file", "-p", "0000000000000000000000000000000000000000"]),
  "exit"
);
assert.equal(missing.result.timedOut, false);
assert.equal(missing.result.signal, null);
assert.equal(missing.result.stdout, "");
assert.ok(missing.result.stderr.length > 0);
assert.equal(Number.isInteger(missing.result.exitCode), true);
assertBoundedResult(missing.result, runnerConfig.maxOutputBytes);
console.log(`PASS nonexistent object is typed exit failure with separate streams and numeric exit=${missing.result.exitCode}`);

const unavailableGitPath = path.join(fixtureRoot, "no-git-bin");
await mkdir(unavailableGitPath);
const spawnFailure = await withEnvironment({ PATH: unavailableGitPath }, () =>
  expectFailure(() => runGitReadOnly(runnerConfig, workspace, ["--version"]), "spawn")
);
assert.equal(spawnFailure.spawnErrorCode, "ENOENT");
assert.equal(spawnFailure.result.exitCode, null);
assert.equal(spawnFailure.result.signal, null);
assert.equal(spawnFailure.result.stdout, "");
assert.equal(spawnFailure.result.stderr, "");
assertBoundedResult(spawnFailure.result, runnerConfig.maxOutputBytes);
console.log("PASS unavailable fixed git executable is typed spawn failure with bounded empty streams");

const timeoutPidFile = path.join(fixtureRoot, "timeout.pid");
const timeoutSurvivor = path.join(fixtureRoot, "timeout-survivor");
mustGit(["config", "alias.runner-timeout", aliasCommand(timeoutPidFile, `sleep 30; touch "${timeoutSurvivor}"`)]);
const timeoutError = await expectFailure(
  () => runGitReadOnly({ maxGitTimeoutMs: 1_000, maxOutputBytes: 120_000 }, workspace, ["runner-timeout"]),
  "timeout"
);
assert.equal(timeoutError.result.timedOut, true);
assertBoundedResult(timeoutError.result, 120_000);
assert.equal(await waitForFile(timeoutPidFile), true);
await delay(650);
const timeoutPid = Number.parseInt(text(await readFile(timeoutPidFile)), 10);
assert.equal(await processIsAlive(timeoutPid), false);
assert.equal(await exists(timeoutSurvivor), false);
console.log(`PASS timeout timedOut=true, producer pid=${timeoutPid} terminated, no survivor marker after grace`);

const outputCap = 64;
const stdoutPidFile = path.join(fixtureRoot, "stdout-overflow.pid");
const stdoutSurvivor = path.join(fixtureRoot, "stdout-overflow-survivor");
const stdoutPayload = "A".repeat(512);
mustGit([
  "config",
  "alias.runner-stdout-overflow",
  aliasCommand(stdoutPidFile, `printf "${stdoutPayload}"; sleep 30; touch "${stdoutSurvivor}"`)
]);
const stdoutOverflow = await expectFailure(
  () => runGitReadOnly({ maxGitTimeoutMs: 3_000, maxOutputBytes: outputCap }, workspace, ["runner-stdout-overflow"]),
  "stdout-overflow"
);
assert.equal(stdoutOverflow.result.stdoutOverflow, true);
assert.equal(stdoutOverflow.result.stderrOverflow, false);
assert.equal(Buffer.byteLength(stdoutOverflow.result.stdout, "utf8"), outputCap);
assertBoundedResult(stdoutOverflow.result, outputCap);
assert.equal(await waitForFile(stdoutPidFile), true);
await delay(650);
const stdoutPid = Number.parseInt(text(await readFile(stdoutPidFile)), 10);
assert.equal(await processIsAlive(stdoutPid), false);
assert.equal(await exists(stdoutSurvivor), false);
console.log(`PASS stdout overflow classification exact cap=${outputCap}, producer pid=${stdoutPid} terminated`);

const stderrPidFile = path.join(fixtureRoot, "stderr-overflow.pid");
const stderrSurvivor = path.join(fixtureRoot, "stderr-overflow-survivor");
const stderrPayload = "B".repeat(512);
mustGit([
  "config",
  "alias.runner-stderr-overflow",
  aliasCommand(stderrPidFile, `printf "${stderrPayload}" >&2; sleep 30; touch "${stderrSurvivor}"`)
]);
const stderrOverflow = await expectFailure(
  () => runGitReadOnly({ maxGitTimeoutMs: 3_000, maxOutputBytes: outputCap }, workspace, ["runner-stderr-overflow"]),
  "stderr-overflow"
);
assert.equal(stderrOverflow.result.stdoutOverflow, false);
assert.equal(stderrOverflow.result.stderrOverflow, true);
assert.equal(Buffer.byteLength(stderrOverflow.result.stderr, "utf8"), outputCap);
assertBoundedResult(stderrOverflow.result, outputCap);
assert.equal(await waitForFile(stderrPidFile), true);
await delay(650);
const stderrPid = Number.parseInt(text(await readFile(stderrPidFile)), 10);
assert.equal(await processIsAlive(stderrPid), false);
assert.equal(await exists(stderrSurvivor), false);
console.log(`PASS stderr overflow classification exact cap=${outputCap}, producer pid=${stderrPid} terminated`);

const shellSentinel = path.join(fixtureRoot, "shell-created");
const hostileArg = `HEAD; touch ${shellSentinel}`;
const noShell = await expectFailure(
  () => runGitReadOnly(runnerConfig, workspace, ["rev-parse", "--verify", hostileArg]),
  "exit"
);
assert.equal(noShell.result.timedOut, false);
assert.equal(await exists(shellSentinel), false);
console.log("PASS fixed executable and shell=false: metacharacter argv did not create a file");

// Replacement-ref target evidence is collected by ordinary Git before checking
// the runner's immutable-review result.
const treeSha = text(mustGit(["rev-parse", "HEAD^{tree}"]).stdout).trim();
const replacementSha = text(mustGit(["commit-tree", treeSha, "-m", "replacement commit"]).stdout).trim();
mustGit(["replace", initialSha, replacementSha]);
const replaceRefs = text(mustGit(["replace", "-l"]).stdout);
const normalReplacedSubject = text(mustGit(["show", "-s", "--format=%s", initialSha]).stdout).trim();
assert.match(replaceRefs, new RegExp(initialSha));
assert.equal(normalReplacedSubject, "replacement commit");
console.log(`RAW_OBSERVATION: ordinary Git with actual replace ref resolves ${initialSha.slice(0, 12)} to subject '${normalReplacedSubject}'`);
const immutableSubject = await runGitReadOnly(runnerConfig, workspace, ["show", "-s", "--format=%s", initialSha]);
assert.equal(immutableSubject.stdout.trim(), "runner base commit");
console.log("PASS runner suppresses replacement refs and returns original commit subject");

const pagerSentinel = path.join(fixtureRoot, "pager-invoked");
mustGit(["config", "core.pager", `sh -c 'touch ${pagerSentinel}; cat'`]);
const pagerResult = await runGitReadOnly(runnerConfig, workspace, ["--paginate", "log", "--oneline", "--max-count=1"]);
assert.equal(pagerResult.exitCode, 0);
assert.equal(pagerResult.timedOut, false);
assert.equal(await exists(pagerSentinel), false);
console.log("PASS offline log operation completed without invoking configured pager");

const promptResult = await expectFailure(
  () => runGitReadOnly({ maxGitTimeoutMs: 1_000, maxOutputBytes: 4_000 }, workspace, ["credential", "fill"]),
  "exit"
);
assert.equal(promptResult.result.timedOut, false);
assert.ok(promptResult.result.stderr.length > 0);
console.log("PASS offline credential operation returned bounded failure without waiting for terminal prompt");

const finalHead = text(mustGit(["rev-parse", "HEAD"]).stdout).trim();
assert.equal(finalHead, initialSha);
console.log(`PASS runner smoke complete: HEAD unchanged at ${finalHead}; no network or production 8787 path used`);

await rm(fixtureRoot, { recursive: true, force: true });
