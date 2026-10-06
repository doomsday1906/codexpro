import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commitAll(root, message) {
  spawnSync("git", ["add", "--all"], { cwd: root });
  const r = spawnSync("git", ["commit", "--quiet", "-m", message], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr}`);
  return git(root, ["rev-parse", "HEAD"]);
}

function initRepo(root, name) {
  git(root, ["init", "--quiet", "--initial-branch", "main"]);
  git(root, ["config", "user.name", name]);
  git(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]);
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-commit-onefile-"));
try {
  const { PathGuard } = await import("../dist/guard.js");
  const { gitCommit, GitCommitError } = await import("../dist/gitCommit.js");

  // Exact ordinary one-file commit with hooks enabled (native Git accepts normally).
  const repoRoot0 = path.join(fixture, "onefile");
  await mkdir(repoRoot0, { recursive: true });
  initRepo(repoRoot0, "Onefile");
  await writeFile(path.join(repoRoot0, "one.txt"), "base\n");
  const baseHead = commitAll(repoRoot0, "base");
  // Hooks enabled: trivial pre-commit that exits 0 (like production hooks enabled path).
  const hooksDir = path.join(repoRoot0, ".githooks");
  await mkdir(hooksDir);
  await writeFile(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(hooksDir, "pre-commit"), 0o700);
  git(repoRoot0, ["config", "core.hooksPath", ".githooks"]);
  await writeFile(path.join(repoRoot0, "one.txt"), "changed\n");
  // Native Git accepts normally with hooks enabled.
  {
    const r = spawnSync("git", ["commit", "--only", "--message", "native one-file", "--", "one.txt"], { cwd: repoRoot0, encoding: "utf8" });
    assert.equal(r.status, 0, `native one-file commit failed: ${r.stderr}`);
    const nativeHead = git(repoRoot0, ["rev-parse", "HEAD"]);
    assert.notEqual(nativeHead, baseHead);
    // Reset to base for helper path.
    git(repoRoot0, ["reset", "--quiet", "--hard", baseHead]);
    await writeFile(path.join(repoRoot0, "one.txt"), "changed\n");
  }
  const repoRoot = await realpath(repoRoot0);
  const wsId = `ws_${createHash("sha256").update(repoRoot).digest("hex").slice(0, 24)}`;
  const workspace = { id: wsId, root: repoRoot, openedAt: new Date().toISOString() };
  const guard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
  const config = { maxGitTimeoutMs: 15000, maxOutputBytes: 120000 };
  const result = await gitCommit(config, guard, workspace, {
    workspace_id: wsId,
    paths: ["one.txt"],
    message: "helper one-file with hooks",
    expected_head: baseHead
  });
  assert.equal(result.old_head, baseHead);
  assert.equal(result.requested_path_count, 1);
  assert.deepEqual(result.committed_paths, ["one.txt"]);
  const newHead = git(repoRoot, ["rev-parse", "HEAD"]);
  assert.equal(result.new_head, newHead);
  assert.equal(git(repoRoot, ["show", `${newHead}:one.txt`]).trim(), "changed");
  console.log(`RAW_OBSERVATION: ordinary one-file commit base=${baseHead} helper new=${newHead}; native Git also accepted with hooks enabled.`);
  console.log("SANITY_VERDICT: MATCH — helper one-file path matches native Git outcome.");
  console.log("PASS onefile hooks-enabled commit");

  // Bounded reason is exposed instead of opaque generic error: stale expected_head
  // must report head-mismatch with reason, not generic execution.
  let staleErr;
  try {
    await gitCommit(config, guard, workspace, {
      workspace_id: wsId,
      paths: ["one.txt"],
      message: "stale probe",
      expected_head: baseHead
    });
  } catch (e) {
    staleErr = e;
  }
  assert.ok(staleErr, "expected stale head-mismatch");
  assert.equal(staleErr.name, "GitCommitError");
  assert.equal(staleErr.reason, "head-mismatch");
  assert.match(staleErr.message, /expected_head does not match/iu);
  console.log(`RAW_OBSERVATION: stale expected_head correctly rejected with reason=${staleErr.reason}.`);
  console.log("PASS bounded reason surfaced");

  // Medium repository with many tracked + collapsed ignored entries must still
  // allow an ordinary one-file commit (previous 120 KiB census overflow).
  const medium0 = path.join(fixture, "medium");
  await mkdir(medium0, { recursive: true });
  initRepo(medium0, "Medium");
  // 1200 tracked files (~300 KiB index, above old 120 KiB bound but within 8 MiB census).
  for (let i = 0; i < 1200; i++) {
    await writeFile(path.join(medium0, `tracked-${String(i).padStart(4, "0")}.txt`), `tracked ${i}\n`);
  }
  await writeFile(path.join(medium0, ".gitignore"), "ignored-dir/\n");
  await mkdir(path.join(medium0, "ignored-dir"));
  // 2000 ignored files inside one collapsed directory (expanded would be large, collapsed is one status entry).
  for (let i = 0; i < 2000; i++) {
    await writeFile(path.join(medium0, "ignored-dir", `ignored-${String(i).padStart(4, "0")}.txt`), `ignored ${i}\n`);
  }
  const mediumBase = commitAll(medium0, "medium base");
  const mediumRoot = await realpath(medium0);
  const mediumWsId = `ws_${createHash("sha256").update(mediumRoot).digest("hex").slice(0, 24)}`;
  const mediumWorkspace = { id: mediumWsId, root: mediumRoot, openedAt: new Date().toISOString() };
  await writeFile(path.join(medium0, "tracked-0000.txt"), "tracked 0 changed\n");
  const mediumResult = await gitCommit(config, guard, mediumWorkspace, {
    workspace_id: mediumWsId,
    paths: ["tracked-0000.txt"],
    message: "medium one-file",
    expected_head: mediumBase
  });
  assert.equal(mediumResult.old_head, mediumBase);
  assert.deepEqual(mediumResult.committed_paths, ["tracked-0000.txt"]);
  console.log(`RAW_OBSERVATION: medium repo (1200 tracked + 2000 collapsed ignored) one-file commit ${mediumBase} -> ${mediumResult.new_head} succeeded.`);
  console.log("PASS medium census still proves preservation");

  console.log("ONEFILE: PASS");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
