import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, lstat, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile, mkdir } from "node:fs/promises";
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
  gitCommit,
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
  await delay(1_000);
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

// TASK-003 real Git target-producer matrix. Every assertion below is based on
// raw disposable-repository output; implementation result fields are checked
// against independent ref/tree/index/worktree producers.
const matrixRoot = path.join(fixtureRoot, "task003-matrix");
await mkdir(matrixRoot);
initRepo(matrixRoot, "TASK-003 Matrix");
const matrixFiles = {
  trackedUnstaged: "tracked-unstaged.txt",
  trackedStaged: "tracked-staged.txt",
  partial: "partial.txt",
  mode: "mode.txt",
  deleted: "deleted.txt",
  stagedAddition: "staged-addition.txt",
  space: "space name.txt",
  unicode: "ユニコード.txt",
  dash: "-leading.txt",
  oldName: "old-name.txt",
  typeTransition: "type-transition.txt",
  unrelatedStaged: "unrelated-staged.txt",
  unrelatedUnstaged: "unrelated-unstaged.txt",
  unrelatedMode: "unrelated-mode.txt"
};
for (const [name, relativePath] of Object.entries(matrixFiles)) {
  if (name === "oldName") await writeFile(path.join(matrixRoot, relativePath), "old-name base\n");
  else if (name.startsWith("unrelated")) await writeFile(path.join(matrixRoot, relativePath), `${name} base\n`);
  else await writeFile(path.join(matrixRoot, relativePath), `${name} base\n`);
}
const matrixLinkTargetA = path.join(fixtureRoot, "task003-link-a");
const matrixLinkTargetB = path.join(fixtureRoot, "task003-link-b");
await writeFile(matrixLinkTargetA, "link-a\n");
await writeFile(matrixLinkTargetB, "link-b\n");
await symlink(matrixLinkTargetA, path.join(matrixRoot, "selected-link"));
const matrixBase = commitAll(matrixRoot, "task003 matrix base");
mustGit(matrixRoot, ["update-ref", "refs/remotes/origin/main", matrixBase]);
const matrixWorkspace = { id: "ws_task003_matrix", root: matrixRoot, openedAt: new Date().toISOString() };
const matrixGuard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
const matrixRequest = (paths, expected) => ({
  workspace_id: matrixWorkspace.id,
  paths,
  message: `task003 ${paths.join(",")}`,
  expected_head: expected
});

const matrixGitStatus = () => gitText(matrixRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
const matrixRemoteRefs = () => gitText(matrixRoot, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]);
const matrixChangedPaths = (oldHead, newHead) => {
  const fields = mustGit(matrixRoot, ["diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "--no-renames", oldHead, newHead])
    .toString("utf8")
    .split("\u0000");
  if (fields.at(-1) === "") fields.pop();
  assert.equal(fields.length % 2, 0);
  const paths = [];
  for (let index = 0; index < fields.length; index += 2) {
    assert.match(fields[index], /^[A-Z]$/u);
    paths.push(fields[index + 1]);
  }
  return paths;
};
const matrixTreeEntry = (commit, relativePath) => {
  const raw = mustGit(matrixRoot, ["ls-tree", "-z", commit, "--", relativePath]).toString("utf8");
  if (!raw) return undefined;
  const record = raw.slice(0, -1);
  const tab = record.indexOf("\t");
  assert.notEqual(tab, -1);
  const header = record.slice(0, tab).split(" ");
  return { mode: header[0], type: header[1], objectId: header[2], path: record.slice(tab + 1) };
};
const matrixIndexEntry = (relativePath) => mustGit(matrixRoot, ["ls-files", "--stage", "-z", "--", relativePath]).toString("utf8");
const matrixWorktreeState = async (relativePath, root = matrixRoot) => {
  const absPath = path.join(root, relativePath);
  try {
    const stat = await lstat(absPath);
    if (stat.isSymbolicLink()) return { kind: "symlink", mode: stat.mode & 0o7777, target: await readlink(absPath, "utf8") };
    if (stat.isFile()) return { kind: "file", mode: stat.mode & 0o7777, bytes: (await readFile(absPath)).toString("base64") };
    return { kind: stat.isDirectory() ? "directory" : "other", mode: stat.mode & 0o7777 };
  } catch (error) {
    assert.equal(error?.code, "ENOENT");
    return { kind: "missing", mode: null };
  }
};
const matrixUnrelatedBefore = async () => ({
  stagedIndex: matrixIndexEntry(matrixFiles.unrelatedStaged),
  unstaged: await matrixWorktreeState(matrixFiles.unrelatedUnstaged),
  mode: await matrixWorktreeState(matrixFiles.unrelatedMode),
  untracked: (await readFile(path.join(matrixRoot, "unrelated-untracked.txt"))).toString("base64"),
  remoteRefs: matrixRemoteRefs()
});
const assertMatrixUnrelated = async (before) => {
  assert.equal(matrixIndexEntry(matrixFiles.unrelatedStaged), before.stagedIndex);
  assert.deepEqual(await matrixWorktreeState(matrixFiles.unrelatedUnstaged), before.unstaged);
  assert.deepEqual(await matrixWorktreeState(matrixFiles.unrelatedMode), before.mode);
  assert.equal((await readFile(path.join(matrixRoot, "unrelated-untracked.txt"))).toString("base64"), before.untracked);
  assert.equal(matrixRemoteRefs(), before.remoteRefs);
};

await writeFile(path.join(matrixRoot, "unrelated-staged.txt"), "unrelated staged changed\n");
mustGit(matrixRoot, ["add", "--", matrixFiles.unrelatedStaged]);
await writeFile(path.join(matrixRoot, "unrelated-unstaged.txt"), "unrelated unstaged changed\n");
await chmod(path.join(matrixRoot, matrixFiles.unrelatedMode), 0o755);
await writeFile(path.join(matrixRoot, "unrelated-untracked.txt"), "unrelated untracked\n");
const unrelatedBaseline = await matrixUnrelatedBefore();

const runMatrixCommit = async (paths, expectedPaths, verify) => {
  const oldHead = gitTrimmed(matrixRoot, ["rev-parse", "HEAD"]);
  const beforeStatus = matrixGitStatus();
  const beforeRemoteRefs = matrixRemoteRefs();
  console.log(`RAW_OBSERVATION: before selected ${paths.join(",")} native Git HEAD=${oldHead}, status-bytes=${beforeStatus.length}`);
  const result = await gitCommit(config, matrixGuard, matrixWorkspace, matrixRequest(paths, oldHead));
  const newHead = gitTrimmed(matrixRoot, ["rev-parse", "HEAD"]);
  assert.equal(result.old_head, oldHead);
  assert.equal(result.new_head, newHead);
  assert.equal(gitTrimmed(matrixRoot, ["rev-list", "--parents", "--max-count=1", newHead]).split(" ").length, 2);
  assert.deepEqual(new Set(matrixChangedPaths(oldHead, newHead)), new Set(expectedPaths));
  assert.deepEqual(new Set(result.committed_paths), new Set(expectedPaths));
  assert.equal(result.committed_path_count, expectedPaths.length);
  assert.equal(result.requested_path_count, paths.length);
  await assertMatrixUnrelated(unrelatedBaseline);
  assert.equal(matrixRemoteRefs(), beforeRemoteRefs);
  if (verify) await verify(oldHead, newHead, result);
  console.log(`PASS AP-005/AP-006 selected=${paths.join(",")} committed=${result.committed_paths.join(",")}`);
  return result;
};

await writeFile(path.join(matrixRoot, matrixFiles.trackedUnstaged), "tracked unstaged current\n");
await runMatrixCommit([matrixFiles.trackedUnstaged], [matrixFiles.trackedUnstaged], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.trackedUnstaged}`]).toString("utf8"), "tracked unstaged current\n");
});

await writeFile(path.join(matrixRoot, matrixFiles.trackedStaged), "tracked staged current\n");
mustGit(matrixRoot, ["add", "--", matrixFiles.trackedStaged]);
await runMatrixCommit([matrixFiles.trackedStaged], [matrixFiles.trackedStaged], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.trackedStaged}`]).toString("utf8"), "tracked staged current\n");
});

await writeFile(path.join(matrixRoot, matrixFiles.partial), "partial staged\n");
mustGit(matrixRoot, ["add", "--", matrixFiles.partial]);
await writeFile(path.join(matrixRoot, matrixFiles.partial), "partial complete current\n");
await runMatrixCommit([matrixFiles.partial], [matrixFiles.partial], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.partial}`]).toString("utf8"), "partial complete current\n");
});

await chmod(path.join(matrixRoot, matrixFiles.mode), 0o755);
await runMatrixCommit([matrixFiles.mode], [matrixFiles.mode], async (_oldHead, newHead) => {
  assert.equal(matrixTreeEntry(newHead, matrixFiles.mode).mode, "100755");
});

await unlink(path.join(matrixRoot, matrixFiles.deleted));
await runMatrixCommit([matrixFiles.deleted], [matrixFiles.deleted], async (_oldHead, newHead) => {
  assert.equal(matrixTreeEntry(newHead, matrixFiles.deleted), undefined);
});

await writeFile(path.join(matrixRoot, matrixFiles.stagedAddition), "staged addition current\n");
mustGit(matrixRoot, ["add", "--", matrixFiles.stagedAddition]);
await runMatrixCommit([matrixFiles.stagedAddition], [matrixFiles.stagedAddition], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.stagedAddition}`]).toString("utf8"), "staged addition current\n");
});

await writeFile(path.join(matrixRoot, "plain-untracked.txt"), "plain untracked current\n");
await runMatrixCommit(["plain-untracked.txt"], ["plain-untracked.txt"], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:plain-untracked.txt`]).toString("utf8"), "plain untracked current\n");
  assert.match(matrixIndexEntry("plain-untracked.txt"), /plain-untracked\.txt\u0000/u);
});

await unlink(path.join(matrixRoot, "selected-link"));
await symlink(matrixLinkTargetB, path.join(matrixRoot, "selected-link"));
await runMatrixCommit(["selected-link"], ["selected-link"], async (_oldHead, newHead) => {
  const entry = matrixTreeEntry(newHead, "selected-link");
  assert.equal(entry.mode, "120000");
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:selected-link`]).toString("utf8"), matrixLinkTargetB);
});

await writeFile(path.join(matrixRoot, matrixFiles.space), "space current\n");
await writeFile(path.join(matrixRoot, matrixFiles.unicode), "unicode current\n");
await writeFile(path.join(matrixRoot, matrixFiles.dash), "dash current\n");
await runMatrixCommit([matrixFiles.space, matrixFiles.unicode, matrixFiles.dash], [matrixFiles.space, matrixFiles.unicode, matrixFiles.dash], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.space}`]).toString("utf8"), "space current\n");
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.unicode}`]).toString("utf8"), "unicode current\n");
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.dash}`]).toString("utf8"), "dash current\n");
});

// A tracked regular-file -> symlink transition proves that selected type is
// represented by the tree entry and the link target bytes, without
// dereferencing the target into the commit.
const typeTransitionTarget = path.join(fixtureRoot, "task003-type-transition-target");
await writeFile(typeTransitionTarget, "type target\n");
await unlink(path.join(matrixRoot, matrixFiles.typeTransition));
await symlink(typeTransitionTarget, path.join(matrixRoot, matrixFiles.typeTransition));
await runMatrixCommit([matrixFiles.typeTransition], [matrixFiles.typeTransition], async (_oldHead, newHead) => {
  const entry = matrixTreeEntry(newHead, matrixFiles.typeTransition);
  assert.equal(entry.mode, "120000");
  assert.equal(entry.type, "blob");
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${matrixFiles.typeTransition}`]).toString("utf8"), typeTransitionTarget);
  assert.deepEqual(await matrixWorktreeState(matrixFiles.typeTransition), {
    kind: "symlink",
    mode: 0o777,
    target: typeTransitionTarget
  });
});

await unlink(path.join(matrixRoot, matrixFiles.oldName));
await writeFile(path.join(matrixRoot, "new-name.txt"), "renamed content\n");
await runMatrixCommit([matrixFiles.oldName, "new-name.txt"], [matrixFiles.oldName, "new-name.txt"], async (_oldHead, newHead) => {
  assert.equal(matrixTreeEntry(newHead, matrixFiles.oldName), undefined);
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:new-name.txt`]).toString("utf8"), "renamed content\n");
});

await writeFile(path.join(matrixRoot, "mixed-changed.txt"), "mixed current\n");
const mixedResult = await runMatrixCommit(["mixed-changed.txt", matrixFiles.trackedStaged], ["mixed-changed.txt"], async (_oldHead, newHead) => {
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:mixed-changed.txt`]).toString("utf8"), "mixed current\n");
});
assert.deepEqual(mixedResult.committed_paths, ["mixed-changed.txt"]);

// Distinguish a staged empty-file addition from two plain untracked files,
// including the temporary intent-to-add path used for the latter pair.
await writeFile(path.join(matrixRoot, "empty-staged.txt"), Buffer.alloc(0));
mustGit(matrixRoot, ["add", "--", "empty-staged.txt"]);
await runMatrixCommit(["empty-staged.txt"], ["empty-staged.txt"], async (_oldHead, newHead) => {
  const entry = matrixTreeEntry(newHead, "empty-staged.txt");
  assert.equal(entry.mode, "100644");
  assert.equal(entry.type, "blob");
  assert.equal(entry.objectId, gitTrimmed(matrixRoot, ["hash-object", "--stdin"], { input: Buffer.alloc(0) }));
  assert.equal(mustGit(matrixRoot, ["show", `${newHead}:empty-staged.txt`]).length, 0);
});
await writeFile(path.join(matrixRoot, "plain-empty-a.txt"), Buffer.alloc(0));
await writeFile(path.join(matrixRoot, "plain-empty-b.txt"), Buffer.alloc(0));
await runMatrixCommit(["plain-empty-a.txt", "plain-empty-b.txt"], ["plain-empty-a.txt", "plain-empty-b.txt"], async (_oldHead, newHead) => {
  for (const relativePath of ["plain-empty-a.txt", "plain-empty-b.txt"]) {
    const entry = matrixTreeEntry(newHead, relativePath);
    assert.equal(entry.mode, "100644");
    assert.equal(entry.type, "blob");
    assert.equal(mustGit(matrixRoot, ["show", `${newHead}:${relativePath}`]).length, 0);
    assert.match(matrixIndexEntry(relativePath), new RegExp(`${relativePath}\\u0000`, "u"));
  }
});

const unchangedHead = gitTrimmed(matrixRoot, ["rev-parse", "HEAD"]);
const unchangedStatus = matrixGitStatus();
await expectReason(
  () => gitCommit(config, matrixGuard, matrixWorkspace, matrixRequest([matrixFiles.trackedStaged], unchangedHead)),
  "no-changes"
);
assert.equal(gitTrimmed(matrixRoot, ["rev-parse", "HEAD"]), unchangedHead);
assert.equal(matrixGitStatus(), unchangedStatus);
console.log("PASS AP-005 all-unchanged selection rejected without branch/index movement");

// A real pre-advance hook failure must restore only the intent-to-add entries
// owned by this request. The baseline index/status/worktree/ref bytes below
// are captured from native Git before invoking the product operation.
const failureRoot = path.join(fixtureRoot, "task003-hook-failure");
const failureHooks = path.join(fixtureRoot, "task003-hook-failure-hooks");
await mkdir(failureRoot);
await mkdir(failureHooks);
initRepo(failureRoot, "TASK-003 Hook Failure");
await writeFile(path.join(failureRoot, "base.txt"), "base\n");
const failureBase = commitAll(failureRoot, "hook failure base");
mustGit(failureRoot, ["update-ref", "refs/remotes/origin/main", failureBase]);
await writeFile(path.join(failureRoot, "unrelated-staged.txt"), "before\n");
mustGit(failureRoot, ["add", "--", "unrelated-staged.txt"]);
await writeFile(path.join(failureRoot, "unrelated-staged.txt"), "after\n");
await writeFile(path.join(failureRoot, "unrelated-untracked.txt"), "unrelated\n");
await writeFile(path.join(failureRoot, "selected-untracked.txt"), "selected\n");
const failingHook = path.join(failureHooks, "pre-commit");
await writeFile(failingHook, "#!/bin/sh\nexit 1\n");
await chmod(failingHook, 0o755);
mustGit(failureRoot, ["config", "core.hooksPath", failureHooks]);
const failureWorkspace = { id: "ws_task003_hook_failure", root: failureRoot, openedAt: new Date().toISOString() };
const failureRequest = (paths, expected) => ({
  workspace_id: failureWorkspace.id,
  paths,
  message: `task003 hook failure ${paths.join(",")}`,
  expected_head: expected
});
const failureHead = gitTrimmed(failureRoot, ["rev-parse", "HEAD"]);
const failureIndexBefore = mustGit(failureRoot, ["ls-files", "--stage", "-z"]);
const failureStatusBefore = mustGit(failureRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
const failureRemoteBefore = gitText(failureRoot, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]);
const failureSelectedBefore = await matrixWorktreeState("selected-untracked.txt", failureRoot);
console.log(`RAW_OBSERVATION: hook-failure baseline HEAD=${failureHead}, index-bytes=${failureIndexBefore.length}, status-bytes=${failureStatusBefore.length}`);
await expectReason(
  () => gitCommit(config, matrixGuard, failureWorkspace, failureRequest(["selected-untracked.txt"], failureHead)),
  "execution"
);
assert.equal(gitTrimmed(failureRoot, ["rev-parse", "HEAD"]), failureHead);
assert.deepEqual(mustGit(failureRoot, ["ls-files", "--stage", "-z"]), failureIndexBefore);
assert.deepEqual(mustGit(failureRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]), failureStatusBefore);
assert.equal(gitText(failureRoot, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]), failureRemoteBefore);
assert.equal(mustGit(failureRoot, ["ls-files", "--stage", "-z", "--", "selected-untracked.txt"]).length, 0);
assert.deepEqual(await matrixWorktreeState("selected-untracked.txt", failureRoot), failureSelectedBefore);
console.log("PASS AP-005 untracked pre-advance hook failure restored exact index/status/worktree/remote baseline with no owned intent residue");

// A real index-write failure after preflight must leave the plain-untracked
// selected path untouched and produce no partial intent receipt. This uses
// only a disposable fixture index with its mode temporarily made unwritable.
const prepFailureIndex = path.join(failureRoot, ".git", "index");
const prepFailurePath = path.join(failureRoot, "selected-preparation-failure.txt");
await writeFile(prepFailurePath, "selected preparation failure\n");
const prepFailureHead = gitTrimmed(failureRoot, ["rev-parse", "HEAD"]);
const prepFailureIndexBefore = mustGit(failureRoot, ["ls-files", "--stage", "-z"]);
const prepFailureStatusBefore = mustGit(failureRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
const prepFailureSelectedBefore = await matrixWorktreeState("selected-preparation-failure.txt", failureRoot);
await chmod(prepFailureIndex, 0o444);
try {
  await expectReason(
    () => gitCommit(config, matrixGuard, failureWorkspace, failureRequest(["selected-preparation-failure.txt"], prepFailureHead)),
    "execution"
  );
} finally {
  await chmod(prepFailureIndex, 0o644);
}
assert.equal(gitTrimmed(failureRoot, ["rev-parse", "HEAD"]), prepFailureHead);
assert.deepEqual(mustGit(failureRoot, ["ls-files", "--stage", "-z"]), prepFailureIndexBefore);
assert.deepEqual(mustGit(failureRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]), prepFailureStatusBefore);
assert.equal(await exists(path.join(failureRoot, ".git", "index.lock")), false);
assert.deepEqual(await matrixWorktreeState("selected-preparation-failure.txt", failureRoot), prepFailureSelectedBefore);
console.log("PASS AP-005 partial intent preparation failure leaves exact HEAD/index/status/worktree baseline");

// Safe built-in Git attributes normalize CRLF to LF in the committed blob;
// native raw bytes and file mode must remain unchanged in the worktree.
const filterRoot = path.join(fixtureRoot, "task003-filter-normalization");
await mkdir(filterRoot);
initRepo(filterRoot, "TASK-003 Filter Normalization");
await writeFile(path.join(filterRoot, ".gitattributes"), "normalized.txt text eol=lf\n");
await writeFile(path.join(filterRoot, "filter-base.txt"), "base\n");
commitAll(filterRoot, "filter attributes base");
const filterWorkspace = { id: "ws_task003_filter", root: filterRoot, openedAt: new Date().toISOString() };
const filterGuard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
const normalizedBytes = Buffer.from("line one\r\nline two\r\n", "utf8");
const normalizedPath = path.join(filterRoot, "normalized.txt");
await writeFile(normalizedPath, normalizedBytes);
const normalizedBefore = await matrixWorktreeState("normalized.txt", filterRoot);
const normalizedHead = gitTrimmed(filterRoot, ["rev-parse", "HEAD"]);
const nativeCleanBlob = gitTrimmed(filterRoot, ["hash-object", "--path=normalized.txt", "--", "normalized.txt"]);
const nativeRawBlob = gitTrimmed(filterRoot, ["hash-object", "--no-filters", "--", "normalized.txt"]);
assert.notEqual(nativeCleanBlob, nativeRawBlob);
const normalizedResult = await gitCommit(config, filterGuard, filterWorkspace, {
  workspace_id: filterWorkspace.id,
  paths: ["normalized.txt"],
  message: "task003 filter normalization",
  expected_head: normalizedHead
});
const normalizedNewHead = gitTrimmed(filterRoot, ["rev-parse", "HEAD"]);
assert.equal(normalizedResult.old_head, normalizedHead);
assert.equal(normalizedResult.new_head, normalizedNewHead);
assert.deepEqual(await matrixWorktreeState("normalized.txt", filterRoot), normalizedBefore);
assert.equal(gitTrimmed(filterRoot, ["rev-parse", `${normalizedNewHead}:normalized.txt`]), nativeCleanBlob);
assert.deepEqual(mustGit(filterRoot, ["show", `${normalizedNewHead}:normalized.txt`]), Buffer.from("line one\nline two\n", "utf8"));
assert.deepEqual(mustGit(filterRoot, ["diff-tree", "-r", "--no-commit-id", "--name-status", "-z", "--no-renames", normalizedHead, normalizedNewHead]), Buffer.from("A\u0000normalized.txt\u0000", "utf8"));
console.log("PASS AP-005 built-in text/eol clean result matches native Git while raw CRLF worktree bytes/mode remain unchanged");

const commitSource = await readFile(new URL("../src/gitCommit.ts", import.meta.url), "utf8");
for (const forbiddenArg of [
  '"reset"',
  '"checkout"',
  '"stash"',
  '"clean"',
  '"--allow-empty"',
  '"--amend"',
  '"--no-verify"',
  '"--no-gpg-sign"',
  '"--force"',
  '"push"',
  '"fetch"'
]) {
  assert.equal(commitSource.includes(forbiddenArg), false, `production commit argv contains forbidden token ${forbiddenArg}`);
}
assert.match(commitSource, /\["update-index", "--force-remove", "--", \.\.\.receipts/u);
console.log("PASS AP-005 production commit route contains no broad recovery, bypass, force, or remote argv; only narrow owned intent removal is present");

console.log("PASS AP-005/AP-006 TASK-003 real disposable-repository matrix: tracked/staged/partial/mode/deletion/staged-new/plain-untracked/symlink/path-name/rename-like/mixed states and unrelated preservation");

await rm(fixtureRoot, { recursive: true, force: true });
