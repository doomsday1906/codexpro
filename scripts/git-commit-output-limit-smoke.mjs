import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-commit-output-limit-"));
const realGit = spawnSync("which", ["git"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).stdout.trim();
if (!realGit) throw new Error("unable to locate Git for disposable fixtures");
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C", LANG: "C" };

function git(root, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(realGit, args, {
    cwd: root,
    env: gitEnv,
    encoding: null,
    maxBuffer: 16_000_000,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`fixture Git failed: ${args[0]} status=${result.status}`);
  }
  return Buffer.from(result.stdout ?? []);
}

function text(root, args) {
  return git(root, args).toString("utf8").trim();
}

function init(root) {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Output Limit Regression"]);
  git(root, ["config", "user.email", "output-limit@example.test"]);
}

function commitAll(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", message]);
  return text(root, ["rev-parse", "HEAD"]);
}

async function makeCensusFiles(root, count, labelLength) {
  const directory = path.join(root, "census");
  await mkdir(directory);
  const suffix = "x".repeat(labelLength);
  for (let index = 0; index < count; index += 1) {
    const name = `${String(index).padStart(5, "0")}-${suffix}`;
    await writeFile(path.join(directory, name), "census\n");
  }
}

async function makeSnapshotFixtures(root, head) {
  const refCount = 2_500;
  const refInput = Array.from({ length: refCount }, (_, index) =>
    `create refs/heads/output-limit-fixture/${String(index).padStart(4, "0")} ${head}\n`
  ).join("");
  git(root, ["update-ref", "--stdin"], { input: refInput });

  const configPath = path.join(root, ".git", "config");
  const configEntries = Array.from({ length: 4_000 }, (_, index) =>
    `snapshotFixture${String(index).padStart(4, "0")} = ${"x".repeat(32)}\n`
  ).join("");
  await appendFile(configPath, `\n[codexpro-output-limit-fixture]\n${configEntries}`);
  return {
    refBytes: git(root, ["for-each-ref", "--format=%(refname)=%(objectname)"]).length,
    configBytes: git(root, ["config", "--local", "--null", "--list"]).length
  };
}

async function run() {
  const { PathGuard } = await import("../dist/guard.js");
  const { GitCommitError, gitCommit } = await import("../dist/gitCommit.js");
  const { GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES } = await import("../dist/gitOps.js");
  const guard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
  const config = { maxGitTimeoutMs: 30_000, maxOutputBytes: 120_000 };

  const successRoot = path.join(fixtureRoot, "success");
  await mkdir(successRoot);
  init(successRoot);
  await writeFile(path.join(successRoot, "unrelated-staged.txt"), "staged base\n");
  await writeFile(path.join(successRoot, "unrelated-unstaged.txt"), "unstaged base\n");
  await makeCensusFiles(successRoot, 8_000, 220);
  const base = commitAll(successRoot, "large census base");
  const { refBytes, configBytes } = await makeSnapshotFixtures(successRoot, base);
  const censusBytes = git(successRoot, ["ls-files", "--debug", "--stage", "-z"]).length;
  assert.ok(censusBytes > 2_000_000, `fixture census ${censusBytes} did not exceed the rejected 2 MB implementation choice`);
  assert.ok(censusBytes > config.maxOutputBytes, `fixture census ${censusBytes} did not exceed display cap`);
  assert.ok(censusBytes < GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES, `fixture census ${censusBytes} exceeded internal cap ${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}`);
  assert.ok(refBytes > config.maxOutputBytes, `fixture refs ${refBytes} did not exceed display cap`);
  assert.ok(refBytes < GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES, `fixture refs ${refBytes} exceeded internal cap ${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}`);
  assert.ok(configBytes > config.maxOutputBytes, `fixture config ${configBytes} did not exceed display cap`);
  assert.ok(configBytes < GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES, `fixture config ${configBytes} exceeded internal cap ${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}`);

  await writeFile(path.join(successRoot, "unrelated-staged.txt"), "staged index content\n");
  git(successRoot, ["add", "--", "unrelated-staged.txt"]);
  await writeFile(path.join(successRoot, "unrelated-staged.txt"), "distinct unstaged worktree content\n");
  await writeFile(path.join(successRoot, "unrelated-unstaged.txt"), "unstaged change\n");
  await writeFile(path.join(successRoot, "unrelated-untracked.txt"), "untracked state\n");
  await writeFile(path.join(successRoot, "selected-new-a.txt"), "new selected a\n");
  await writeFile(path.join(successRoot, "selected-new-b.txt"), "new selected b\n");

  const fs = await import("node:fs/promises");
  const cachedDiffBefore = git(successRoot, ["diff", "--cached", "--binary", "--", "unrelated-staged.txt"]);
  assert.ok(cachedDiffBefore.length > 0, "unrelated staged fixture must have a nonempty cached diff before the tested commit");
  const unrelatedBefore = {
    stagedIndex: git(successRoot, ["ls-files", "--stage", "-z", "--", "unrelated-staged.txt"]).toString("base64"),
    stagedBlob: git(successRoot, ["show", ":unrelated-staged.txt"]),
    stagedDiff: cachedDiffBefore.toString("base64"),
    stagedWorktree: await fs.readFile(path.join(successRoot, "unrelated-staged.txt")),
    unstagedDiff: git(successRoot, ["diff", "--binary", "--", "unrelated-staged.txt", "unrelated-unstaged.txt"]).toString("base64"),
    unstagedWorktree: await fs.readFile(path.join(successRoot, "unrelated-unstaged.txt")),
    untrackedBytes: await fs.readFile(path.join(successRoot, "unrelated-untracked.txt"))
  };
  const workspace = { id: "output-limit-success", root: successRoot, openedAt: new Date().toISOString() };
  const result = await gitCommit(config, guard, workspace, {
    workspace_id: workspace.id,
    paths: ["selected-new-a.txt", "selected-new-b.txt"],
    message: "commit selected files above display cap",
    expected_head: base
  });
  assert.deepEqual(result.committed_paths, ["selected-new-a.txt", "selected-new-b.txt"]);
  assert.equal(text(successRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", result.new_head]).split("\n").sort().join(","), "selected-new-a.txt,selected-new-b.txt");
  assert.equal(git(successRoot, ["ls-files", "--stage", "-z", "--", "unrelated-staged.txt"]).toString("base64"), unrelatedBefore.stagedIndex);
  assert.deepEqual(git(successRoot, ["show", ":unrelated-staged.txt"]), unrelatedBefore.stagedBlob);
  assert.equal(git(successRoot, ["diff", "--cached", "--binary", "--", "unrelated-staged.txt"]).toString("base64"), unrelatedBefore.stagedDiff);
  assert.deepEqual(await fs.readFile(path.join(successRoot, "unrelated-staged.txt")), unrelatedBefore.stagedWorktree);
  assert.equal(git(successRoot, ["diff", "--binary", "--", "unrelated-staged.txt", "unrelated-unstaged.txt"]).toString("base64"), unrelatedBefore.unstagedDiff);
  assert.deepEqual(await fs.readFile(path.join(successRoot, "unrelated-unstaged.txt")), unrelatedBefore.unstagedWorktree);
  assert.deepEqual(await fs.readFile(path.join(successRoot, "unrelated-untracked.txt")), unrelatedBefore.untrackedBytes);
  assert.equal(text(successRoot, ["status", "--porcelain=v2", "--", "unrelated-untracked.txt"]).startsWith("? "), true);
  console.log(`RAW_SUCCESS: index_census_bytes=${censusBytes}; local_ref_snapshot_bytes=${refBytes}; local_config_snapshot_bytes=${configBytes}; PASS git_commit_succeeded; PASS unrelated_state_preserved`);

  const overflowRoot = path.join(fixtureRoot, "overflow");
  await mkdir(overflowRoot);
  init(overflowRoot);
  await writeFile(path.join(overflowRoot, "selected.txt"), "base\n");
  await makeCensusFiles(overflowRoot, 27_000, 220);
  const overflowBase = commitAll(overflowRoot, "over-budget census base");
  const overBudgetBytes = git(overflowRoot, ["ls-files", "--debug", "--stage", "-z"]).length;
  assert.ok(overBudgetBytes > GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES, `fixture census ${overBudgetBytes} did not exceed internal cap ${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}`);
  const highDisplayConfig = { ...config, maxOutputBytes: 12_000_000 };
  assert.ok(overBudgetBytes < highDisplayConfig.maxOutputBytes, "boundary fixture must fit the display cap that must not raise the internal cap");
  await writeFile(path.join(overflowRoot, "selected.txt"), "changed but must not commit\n");
  const overflowWorkspace = { id: "output-limit-overflow", root: overflowRoot, openedAt: new Date().toISOString() };
  let failure;
  try {
    await gitCommit(highDisplayConfig, guard, overflowWorkspace, {
      workspace_id: overflowWorkspace.id,
      paths: ["selected.txt"],
      message: "reject over-budget census safely",
      expected_head: overflowBase
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof GitCommitError, "over-budget internal census must return bounded GitCommitError");
  assert.equal(failure.reason, "census-overflow");
  assert.equal(failure.stage, "snapshot");
  assert.equal(failure.category, "index-census");
  assert.match(failure.message, new RegExp(`snapshot index-census.*${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}-byte internal census limit`, "u"));
  assert.equal(failure.message.includes("selected.txt"), false, "failure message leaked a caller path");
  assert.deepEqual(failure.toJSON(), {
    name: "GitCommitError",
    message: failure.message,
    reason: "census-overflow",
    stage: "snapshot",
    category: "index-census"
  });
  assert.equal(text(overflowRoot, ["rev-parse", "HEAD"]), overflowBase, "overflow rejection advanced HEAD");
  assert.equal(git(overflowRoot, ["diff", "--cached", "--binary"]).length, 0, "overflow rejection changed the index");
  assert.equal(text(overflowRoot, ["diff", "--name-only"]).trim(), "selected.txt", "overflow rejection changed selected worktree bytes");
  console.log(`RAW_OVERFLOW: index_census_bytes=${overBudgetBytes}; PASS bounded_failure; PASS HEAD_unchanged; PASS index_unchanged`);

  const statusOverflowRoot = path.join(fixtureRoot, "status-overflow");
  await mkdir(statusOverflowRoot);
  init(statusOverflowRoot);
  await writeFile(path.join(statusOverflowRoot, "selected.txt"), "base\n");
  const statusBase = commitAll(statusOverflowRoot, "over-budget status base");
  await writeFile(path.join(statusOverflowRoot, "selected.txt"), "changed but must not commit\n");
  await makeCensusFiles(statusOverflowRoot, 40_000, 220);
  const statusBytes = git(statusOverflowRoot, ["status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=all"]).length;
  assert.ok(statusBytes > GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES, `fixture status census ${statusBytes} did not exceed internal cap ${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}`);
  const statusWorkspace = { id: "output-limit-status-overflow", root: statusOverflowRoot, openedAt: new Date().toISOString() };
  let statusFailure;
  try {
    await gitCommit(highDisplayConfig, guard, statusWorkspace, {
      workspace_id: statusWorkspace.id,
      paths: ["selected.txt"],
      message: "reject over-budget status census safely",
      expected_head: statusBase
    });
  } catch (error) {
    statusFailure = error;
  }
  assert.ok(statusFailure instanceof GitCommitError, "over-budget status census must return bounded GitCommitError");
  assert.equal(statusFailure.reason, "census-overflow");
  assert.equal(statusFailure.stage, "snapshot");
  assert.equal(statusFailure.category, "status-census");
  assert.match(statusFailure.message, new RegExp(`snapshot status-census.*${GIT_MUTATION_MAX_INTERNAL_STDOUT_BYTES}-byte internal census limit`, "u"));
  assert.equal(statusFailure.message.includes("selected.txt"), false, "status overflow failure message leaked a caller path");
  assert.equal(text(statusOverflowRoot, ["rev-parse", "HEAD"]), statusBase, "status overflow rejection advanced HEAD");
  assert.equal(git(statusOverflowRoot, ["diff", "--cached", "--binary"]).length, 0, "status overflow rejection changed the index");
  assert.equal(text(statusOverflowRoot, ["diff", "--name-only"]).trim(), "selected.txt", "status overflow rejection changed selected worktree bytes");
  console.log(`RAW_STATUS_OVERFLOW: status_census_bytes=${statusBytes}; PASS bounded_failure; PASS HEAD_unchanged; PASS index_unchanged`);
}

try {
  await run();
  console.log("PASS git_commit internal snapshot stdout limits and overflow behavior.");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
