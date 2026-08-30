import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-commit-"));
const repoRoot = path.join(fixtureRoot, "repo");
const redirectRoot = path.join(fixtureRoot, "redirect");
await mkdir(repoRoot);
await mkdir(redirectRoot);

const realGit = (() => {
  const result = spawnSync("which", ["git"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || !result.stdout?.trim()) throw new Error("unable to locate Git for disposable fixtures");
  return result.stdout.trim();
})();

function bytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value));
}

function directGit(root, args, options = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...options.env
  };
  const result = spawnSync(realGit, args, {
    cwd: root,
    env,
    input: options.input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: bytes(result.stdout),
    stderr: bytes(result.stderr),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(root, args, options = {}) {
  const result = directGit(root, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(`fixture Git failed (${args.join(" ")}) status=${result.status} stderr=${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

function gitText(root, args, options = {}) {
  return mustGit(root, args, options).toString("utf8");
}

function gitTrimmed(root, args, options = {}) {
  return gitText(root, args, options).trim();
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

async function expectReason(operation, reason) {
  try {
    await operation();
    assert.fail(`expected GitCommitError(${reason})`);
  } catch (error) {
    assert.equal(error?.name, "GitCommitError", `expected bounded GitCommitError, got ${error?.constructor?.name ?? typeof error}`);
    assert.equal(error.reason, reason);
    assert.ok(!error.message.includes("HOSTILE"), "failure echoed hostile input");
    return error;
  }
}

function commitAll(root, message) {
  mustGit(root, ["add", "--all"]);
  mustGit(root, ["commit", "--quiet", "-m", message]);
  return gitTrimmed(root, ["rev-parse", "HEAD"]);
}

function initRepo(root, name) {
  mustGit(root, ["init", "--quiet"]);
  mustGit(root, ["config", "user.name", name]);
  mustGit(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.invalid`]);
}

initRepo(repoRoot, "Commit Substrate Smoke");
initRepo(redirectRoot, "Redirect Smoke");
await writeFile(path.join(repoRoot, "tracked.txt"), "base\n");
await writeFile(path.join(repoRoot, "-leading-dash.txt"), "dash\n");
await writeFile(path.join(repoRoot, "space name.txt"), "space\n");
await writeFile(path.join(repoRoot, "ユニコード.txt"), "unicode\n");
await writeFile(path.join(repoRoot, "blocked.txt"), "blocked\n");
await writeFile(path.join(repoRoot, ".gitignore"), "ignored.txt\n");
await writeFile(path.join(repoRoot, "ignored.txt"), "ignored\n");
const outsideTarget = path.join(fixtureRoot, "outside-target");
await writeFile(outsideTarget, "outside\n");
await symlink(outsideTarget, path.join(repoRoot, "link-entry"));
const initialHead = commitAll(repoRoot, "fixture base");
await writeFile(path.join(redirectRoot, "other.txt"), "other\n");
commitAll(redirectRoot, "redirect base");

// Pass 1: raw target-producer observations, before loading the implementation.
const rawStatus = gitText(repoRoot, ["status", "--short", "--branch"]);
const rawBranch = gitTrimmed(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
const rawHead = gitTrimmed(repoRoot, ["rev-parse", "HEAD"]);
assert.match(rawStatus, /## /);
assert.equal(rawBranch.length > 0, true);
assert.equal(rawHead, initialHead);
assert.equal(await exists(path.join(repoRoot, ".git", "HEAD")), true);
console.log(`RAW_OBSERVATION: native Git reports attached branch ${rawBranch}, exact HEAD ${rawHead}, and a real disposable worktree`);
console.log("SANITY_VERDICT: MATCH (raw repository facts satisfy the accepted AP-003/AP-004 fixture preconditions)");

const { PathGuard } = await import("../dist/guard.js");
const {
  GitCommitError,
  preflightGitCommit,
  sameGitCommitPreflight,
  validateGitCommitRequest,
  withGitCommitLocks
} = await import("../dist/gitCommit.js");
const { runGitMutation } = await import("../dist/gitOps.js");

const workspace = { id: "ws_commit_smoke", root: repoRoot, openedAt: new Date().toISOString() };
const config = { maxGitTimeoutMs: 3_000, maxOutputBytes: 120_000 };
const guard = new PathGuard({ blockedGlobs: ["blocked.txt", "blocked.txt/**", ".git", ".git/**"] });
const request = (paths, expected = initialHead) => ({
  workspace_id: workspace.id,
  paths,
  message: "substrate smoke commit",
  expected_head: expected
});

assert.throws(() => validateGitCommitRequest({ paths: ["tracked.txt"], message: "x", expected_head: initialHead }), (error) => {
  assert.equal(error instanceof GitCommitError, true);
  assert.equal(error.reason, "invalid-input");
  return true;
});
assert.throws(() => validateGitCommitRequest({ ...request(["tracked.txt"]), HOSTILE_SECRET: "HOSTILE_VALUE" }), (error) => {
  assert.equal(error instanceof GitCommitError, true);
  assert.equal(error.reason, "invalid-input");
  assert.equal(error.message.includes("HOSTILE"), false);
  return true;
});
const missingWorkspaceId = { ...request(["tracked.txt"]) };
delete missingWorkspaceId.workspace_id;
await expectReason(() => preflightGitCommit(config, guard, workspace, missingWorkspaceId), "invalid-input");
await expectReason(
  () => preflightGitCommit(config, guard, workspace, { ...request(["tracked.txt"]), workspace_id: "wrong-workspace" }),
  "workspace"
);
for (const malformed of ["HEAD", initialHead.slice(0, 12), `${initialHead}^`, "0", "g".repeat(40)]) {
  await expectReason(() => preflightGitCommit(config, guard, workspace, request(["tracked.txt"], malformed)), "invalid-input");
}
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["tracked.txt", "tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["tracked.txt", "./tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["tracked.txt", "tracked.txt/"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["."])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request([":(glob)tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["../tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["nested/../tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["/absolute/tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["C:\\absolute\\tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["\\\\server\\share\\tracked.txt"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["control\u0001name"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["blocked.txt"])), "blocked-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["ignored.txt"])), "ignored");
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["missing.txt"])), "missing-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request([".git"])), "invalid-path");
await expectReason(() => preflightGitCommit(config, guard, workspace, request([".git/HEAD"])), "invalid-path");
await mkdir(path.join(repoRoot, "ordinary-directory"));
await expectReason(() => preflightGitCommit(config, guard, workspace, request(["ordinary-directory"])), "directory");

// The path above is intentionally blocked only to exercise a guard verdict;
// use a permissive guard for lawful names and symlink-entry identity.
const permissiveGuard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
for (const lawfulPath of ["-leading-dash.txt", "space name.txt", "ユニコード.txt", "link-entry"]) {
  const lawful = await preflightGitCommit(config, permissiveGuard, workspace, request([lawfulPath]));
  assert.equal(lawful.selected[0].path, lawfulPath);
  assert.notEqual(lawful.selected[0].worktree.kind, "directory");
}
console.log("PASS AP-003 lawful leading-dash, space, Unicode, and symlink-entry paths remain literal identities");

const detachedBranch = rawBranch;
mustGit(repoRoot, ["checkout", "--detach", "--quiet", "HEAD"]);
await expectReason(() => preflightGitCommit(config, permissiveGuard, workspace, request(["tracked.txt"])), "detached");
mustGit(repoRoot, ["checkout", "--quiet", detachedBranch]);

const currentHead = gitTrimmed(repoRoot, ["rev-parse", "HEAD"]);
for (const marker of [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_HEAD",
  "BISECT_LOG",
  "rebase-merge",
  "rebase-apply",
  "sequencer"
]) {
  const markerTarget = path.resolve(repoRoot, gitTrimmed(repoRoot, ["rev-parse", "--git-path", marker]));
  if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker)) {
    await mkdir(markerTarget);
  } else {
    await writeFile(markerTarget, `${currentHead}\n`);
  }
  await expectReason(() => preflightGitCommit(config, permissiveGuard, workspace, request(["tracked.txt"])), "in-progress");
  if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker)) {
    await rm(markerTarget, { recursive: true, force: true });
  } else {
    await unlink(markerTarget);
  }
}
console.log("PASS AP-003 unborn/detached and every applicable Git history-operation marker reject before mutation");

const unbornRoot = path.join(fixtureRoot, "unborn");
await mkdir(unbornRoot);
initRepo(unbornRoot, "Unborn Smoke");
const unbornWorkspace = { id: "ws_unborn_smoke", root: unbornRoot, openedAt: new Date().toISOString() };
await expectReason(
  () => preflightGitCommit(config, permissiveGuard, unbornWorkspace, {
    workspace_id: unbornWorkspace.id,
    paths: ["new.txt"],
    message: "unborn probe",
    expected_head: "0".repeat(40)
  }),
  "unborn"
);

const aliasRoot = path.join(fixtureRoot, "repo-alias");
await symlink(repoRoot, aliasRoot);
await expectReason(
  () => preflightGitCommit(config, permissiveGuard, { ...workspace, root: aliasRoot }, request(["tracked.txt"])),
  "repository"
);
await unlink(aliasRoot);
console.log("PASS AP-003 unborn and repository-top-level/root identity drift are rejected from raw Git identity");

const sha256Root = path.join(fixtureRoot, "sha256");
await mkdir(sha256Root);
const sha256Init = directGit(sha256Root, ["init", "--quiet", "--object-format=sha256"]);
if (sha256Init.status === 0) {
  mustGit(sha256Root, ["config", "user.name", "SHA-256 Smoke"]);
  mustGit(sha256Root, ["config", "user.email", "sha256@example.invalid"]);
  await writeFile(path.join(sha256Root, "sha256.txt"), "sha256\n");
  const sha256Head = commitAll(sha256Root, "sha256 base");
  const sha256Workspace = { id: "ws_sha256_smoke", root: sha256Root, openedAt: new Date().toISOString() };
  const sha256Preflight = await preflightGitCommit(config, permissiveGuard, sha256Workspace, {
    workspace_id: sha256Workspace.id,
    paths: ["sha256.txt"],
    message: "sha256 probe",
    expected_head: sha256Head
  });
  assert.equal(sha256Preflight.objectFormat, "sha256");
  assert.equal(sha256Head.length, 64);
  console.log("PASS AP-003 exact full SHA-256 object-format identity accepted on host Git");
} else {
  console.log(`UNSUPPORTED AP-003 SHA-256 object format on host Git (status=${sha256Init.status}); no claim made`);
}

// Build real unmerged index entries, then restore the fixture index with a
// narrow test-side reset after the preflight rejection.
await writeFile(path.join(repoRoot, "conflict.txt"), "base-conflict\n");
const conflictBase = commitAll(repoRoot, "conflict base");
mustGit(repoRoot, ["checkout", "-q", "-b", "commit-smoke-side"]);
await writeFile(path.join(repoRoot, "conflict.txt"), "side-conflict\n");
const sideHead = commitAll(repoRoot, "conflict side");
mustGit(repoRoot, ["checkout", "-q", detachedBranch]);
await writeFile(path.join(repoRoot, "conflict.txt"), "main-conflict\n");
const mainConflictHead = commitAll(repoRoot, "conflict main");
const sideBlob = gitTrimmed(repoRoot, ["rev-parse", `${sideHead}:conflict.txt`]);
const mainBlob = gitTrimmed(repoRoot, ["rev-parse", `${mainConflictHead}:conflict.txt`]);
const baseBlob = gitTrimmed(repoRoot, ["rev-parse", `${conflictBase}:conflict.txt`]);
mustGit(repoRoot, ["update-index", "--index-info"], {
  input: Buffer.from(`100644 ${baseBlob} 1\tconflict.txt\n100644 ${mainBlob} 2\tconflict.txt\n100644 ${sideBlob} 3\tconflict.txt\n`)
});
await expectReason(() => preflightGitCommit(config, permissiveGuard, workspace, request(["conflict.txt"], mainConflictHead)), "unmerged");
mustGit(repoRoot, ["reset", "--mixed", "--quiet", "HEAD"]);
mustGit(repoRoot, ["branch", "-D", "commit-smoke-side"]);

// A real gitlink index entry is rejected before directory/path traversal can
// reinterpret the selected identity.
const nestedRoot = path.join(repoRoot, "nested-gitlink");
await mkdir(nestedRoot);
initRepo(nestedRoot, "Nested Smoke");
await writeFile(path.join(nestedRoot, "nested.txt"), "nested\n");
commitAll(nestedRoot, "nested base");
mustGit(repoRoot, ["add", "nested-gitlink"]);
await expectReason(() => preflightGitCommit(config, permissiveGuard, workspace, request(["nested-gitlink"], mainConflictHead)), "gitlink");
mustGit(repoRoot, ["reset", "--mixed", "--quiet", "HEAD"]);

const valid = await preflightGitCommit(config, permissiveGuard, workspace, request(["tracked.txt"], mainConflictHead));
assert.equal(valid.branch, detachedBranch);
assert.equal(valid.head, mainConflictHead);
assert.equal(valid.selected.length, 1);
assert.equal(valid.selected[0].indexEntries.length, 1);
assert.equal(sameGitCommitPreflight(valid, structuredClone(valid)), true);
console.log("PASS AP-003 attached/exact-head/in-progress/unmerged/gitlink/path authority rejects before ref movement");

// Serialization plus post-lock revalidation: the second real preflight waits
// for the first RepoConnect-owned lock, then observes an independently made
// worktree change and refuses to invoke its callback.
let releaseFirst;
let firstEnteredResolve;
const firstEntered = new Promise((resolve) => { firstEnteredResolve = resolve; });
const first = withGitCommitLocks(config, permissiveGuard, workspace, request(["tracked.txt"], mainConflictHead), async () => {
  firstEnteredResolve();
  return new Promise((resolve) => { releaseFirst = resolve; });
});
await firstEntered;
let secondCallbackRan = false;
const second = withGitCommitLocks(config, permissiveGuard, workspace, request(["tracked.txt"], mainConflictHead), async () => {
  secondCallbackRan = true;
});
await delay(100);
await writeFile(path.join(repoRoot, "tracked.txt"), "changed while waiting\n");
releaseFirst();
await first;
await expectReason(() => second, "preflight-changed");
assert.equal(secondCallbackRan, false);
console.log("PASS AP-004 per-workspace Git lock composes with selected-file lock and revalidates path state after waiting");

// A stable pair of same-workspace calls must serialize even when no drift
// occurs. The second callback is observed only after the first releases its
// RepoConnect lock, proving this is a real mutual-exclusion boundary.
let releaseSerial;
let serialFirstEnteredResolve;
const serialFirstEntered = new Promise((resolve) => { serialFirstEnteredResolve = resolve; });
let serialFirstActive = false;
let serialSecondRan = false;
let serialOverlap = false;
const serialFirst = withGitCommitLocks(config, permissiveGuard, workspace, request(["tracked.txt"], mainConflictHead), async () => {
  serialFirstActive = true;
  serialFirstEnteredResolve();
  await new Promise((resolve) => { releaseSerial = resolve; });
  serialFirstActive = false;
});
await serialFirstEntered;
const serialSecond = withGitCommitLocks(config, permissiveGuard, workspace, request(["tracked.txt"], mainConflictHead), async () => {
  serialSecondRan = true;
  serialOverlap = serialFirstActive;
});
await delay(100);
assert.equal(serialSecondRan, false, "same-workspace mutation callbacks overlapped or bypassed the lock");
releaseSerial();
await Promise.all([serialFirst, serialSecond]);
assert.equal(serialSecondRan, true);
assert.equal(serialOverlap, false, "same-workspace callbacks overlapped");
console.log("PASS AP-004 same-workspace mutation calls serialize at callback boundary");

// Independent roots must not contend on one global mutation lock. Both
// callbacks hold their own RepoConnect lock at the same time; a global lock
// would make overlap impossible.
const independentRoot = path.join(fixtureRoot, "independent-repo");
await mkdir(independentRoot);
initRepo(independentRoot, "Independent Smoke");
await writeFile(path.join(independentRoot, "independent.txt"), "independent\n");
const independentHead = commitAll(independentRoot, "independent base");
const independentWorkspace = { id: "ws_independent_smoke", root: independentRoot, openedAt: new Date().toISOString() };
const independentRequest = {
  workspace_id: independentWorkspace.id,
  paths: ["independent.txt"],
  message: "independent lock probe",
  expected_head: independentHead
};
let primaryEnteredResolve;
const primaryEntered = new Promise((resolve) => { primaryEnteredResolve = resolve; });
let lockOverlap = false;
let primaryActive = false;
const primaryLock = withGitCommitLocks(config, permissiveGuard, workspace, request(["tracked.txt"], mainConflictHead), async () => {
  primaryActive = true;
  primaryEnteredResolve();
  await delay(150);
  primaryActive = false;
});
await primaryEntered;
const independentLock = withGitCommitLocks(config, permissiveGuard, independentWorkspace, independentRequest, async () => {
  lockOverlap = primaryActive;
});
await Promise.all([primaryLock, independentLock]);
assert.equal(lockOverlap, true, "independent repository mutation locks were globally serialized");
console.log("PASS AP-004 unrelated repository mutation locks run concurrently");

// Normal local/global config must remain visible to the mutation runner. The
// config files are real disposable Git config producers, not test labels.
const globalHome = path.join(fixtureRoot, "global-home");
await mkdir(globalHome);
await writeFile(path.join(globalHome, ".gitconfig"), "[commit-substrate]\n\tglobal = visible\n");
mustGit(repoRoot, ["config", "core.hooksPath", ".githooks"]);
const savedHome = process.env.HOME;
const savedXdg = process.env.XDG_CONFIG_HOME;
process.env.HOME = globalHome;
delete process.env.XDG_CONFIG_HOME;
let globalConfigResult;
let localPolicyResult;
try {
  globalConfigResult = await runGitMutation(config, workspace, ["config", "--get", "commit-substrate.global"]);
  localPolicyResult = await runGitMutation(config, workspace, ["config", "--get", "core.hooksPath"]);
} finally {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
}
assert.equal(globalConfigResult.stdout.trim(), "visible");
assert.equal(localPolicyResult.stdout.trim(), ".githooks");
console.log("PASS AP-004 ordinary global config and local hook-policy config remain observable through sealed mutation runner");

// Raw hostile control: ordinary Git can be redirected by inherited controls.
const hostileConfig = path.join(fixtureRoot, "hostile.gitconfig");
await writeFile(hostileConfig, "[core]\n\tbare = true\n");
await mkdir(path.join(fixtureRoot, "hostile-objects"));
const directTrace = path.join(fixtureRoot, "direct-trace.log");
const directHostile = {
  GIT_DIR: path.join(redirectRoot, ".git"),
  GIT_WORK_TREE: redirectRoot,
  GIT_INDEX_FILE: path.join(redirectRoot, ".git", "index"),
  GIT_OBJECT_DIRECTORY: path.join(fixtureRoot, "hostile-objects"),
  GIT_COMMON_DIR: path.join(redirectRoot, ".git"),
  GIT_NAMESPACE: "hostile-namespace",
  GIT_CONFIG_GLOBAL: hostileConfig,
  GIT_CONFIG_SYSTEM: hostileConfig,
  GIT_CONFIG_NOSYSTEM: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.bare",
  GIT_CONFIG_VALUE_0: "true",
  GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
  GIT_TRACE: directTrace,
  GIT_TRACE2: directTrace,
  GIT_TRACE_PERFORMANCE: directTrace,
  GIT_TRACE_PACKET: directTrace
};
const directRedirect = directGit(repoRoot, ["rev-parse", "--show-toplevel"], { env: directHostile });
assert.equal(directRedirect.status, 0);
assert.equal(directRedirect.stdout.toString("utf8").trim(), redirectRoot);
assert.equal(await exists(directTrace), true, "direct control did not produce the expected trace artifact");
console.log("RAW_OBSERVATION: ordinary Git followed inherited GIT_DIR/GIT_WORK_TREE and emitted a hostile trace artifact");

const productTrace = path.join(fixtureRoot, "product-trace.log");
const productHostile = { ...directHostile, GIT_TRACE: productTrace, GIT_TRACE2: productTrace, GIT_TRACE_PERFORMANCE: productTrace, GIT_TRACE_PACKET: productTrace };
const beforeProductHead = gitTrimmed(repoRoot, ["rev-parse", "HEAD"]);
mustGit(repoRoot, ["update-ref", "refs/remotes/origin/main", beforeProductHead]);
const remoteRefsBefore = gitText(repoRoot, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]);
mustGit(repoRoot, ["config", "commit-substrate.smoke", "local-value"]);
let mutationResult;
const priorEnvironment = new Map();
for (const [key, value] of Object.entries(productHostile)) {
  priorEnvironment.set(key, process.env[key]);
  process.env[key] = value;
}
try {
  mutationResult = await runGitMutation(config, workspace, ["rev-parse", "--show-toplevel"]);
} finally {
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
assert.equal(mutationResult.stdout.trim(), repoRoot);
assert.equal(await exists(productTrace), false, "sealed mutation runner honored a hostile trace control");
const localConfigResult = await runGitMutation(config, workspace, ["config", "--get", "commit-substrate.smoke"]);
assert.equal(localConfigResult.stdout.trim(), "local-value");
assert.equal(gitTrimmed(repoRoot, ["rev-parse", "HEAD"]), beforeProductHead);
const remoteRefsAfter = gitText(repoRoot, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]);
assert.equal(remoteRefsAfter, remoteRefsBefore);
console.log("PASS AP-004 sealed mutation runner strips inherited GIT_DIR/INDEX/OBJECT/CONFIG/TRACE controls, preserves target cwd/config, and performs no remote/ref mutation");

console.log("AP-003: PASS");
console.log("AP-004: PASS");

await rm(fixtureRoot, { recursive: true, force: true });
