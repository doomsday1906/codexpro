import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile, rm } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
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

function trackedStatus(root) {
  return spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).stdout;
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-commit-onefile-"));
try {
  const { PathGuard } = await import("../dist/guard.js");
  const { gitCommit } = await import("../dist/gitCommit.js");

  // Exact ordinary one-file commit with hooks enabled (native Git accepts normally).
  const repoRoot0 = path.join(fixture, "onefile");
  await mkdir(repoRoot0, { recursive: true });
  initRepo(repoRoot0, "Onefile");
  await writeFile(path.join(repoRoot0, "one.txt"), "base\n");
  const baseHead = commitAll(repoRoot0, "base");
  const hooksDir = path.join(repoRoot0, ".githooks");
  await mkdir(hooksDir);
  await writeFile(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(hooksDir, "pre-commit"), 0o700);
  git(repoRoot0, ["config", "core.hooksPath", ".githooks"]);
  await writeFile(path.join(repoRoot0, "one.txt"), "changed\n");
  {
    const r = spawnSync("git", ["commit", "--only", "--message", "native one-file", "--", "one.txt"], { cwd: repoRoot0, encoding: "utf8" });
    assert.equal(r.status, 0, `native one-file commit failed: ${r.stderr}`);
    const nativeHead = git(repoRoot0, ["rev-parse", "HEAD"]);
    assert.notEqual(nativeHead, baseHead);
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

  // Bounded reason surface: stale expected_head reports head-mismatch.
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
  console.log(`RAW_OBSERVATION: stale expected_head correctly rejected with reason=${staleErr.reason}.`);
  console.log("PASS bounded reason surfaced");

  async function mkRepo(dirName, files, ignoreContent) {
    const r0 = path.join(fixture, dirName);
    await mkdir(r0, { recursive: true });
    initRepo(r0, dirName);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.join(r0, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(r0, rel), content);
    }
    if (ignoreContent !== undefined) await writeFile(path.join(r0, ".gitignore"), ignoreContent);
    const base = commitAll(r0, `${dirName} base`);
    const root = await realpath(r0);
    const id = `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
    return { root, wsId: id, workspace: { id, root, openedAt: new Date().toISOString() }, base };
  }

  async function installHook(repo, script) {
    const hooks = path.join(repo.root, ".githooks");
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, "pre-commit"), script);
    await chmod(path.join(hooks, "pre-commit"), 0o700);
    git(repo.root, ["config", "core.hooksPath", ".githooks"]);
  }

  // P1 — concurrent AgentWorkspace no-change probes. No quiet period: ordinary
  // background agents keep working. Attempts tainted by genuine concurrent
  // TRACKED drift are retried, not counted; any failure WITHOUT tracked drift
  // (in particular snapshot-too-large or recovery-required from ignored noise)
  // is a helper defect and fails immediately.
  {
    const prodRoot = "/home/andrew/AgentWorkspace";
    let present = false;
    try {
      await stat(path.join(prodRoot, ".git"));
      present = true;
    } catch {}
    if (!present) {
      console.log("SKIP P1 live concurrent probe (repository absent)");
    } else {
      const prodReal = await realpath(prodRoot);
      const prodWsId = `ws_${createHash("sha256").update(prodReal).digest("hex").slice(0, 24)}`;
      const prodWs = { id: prodWsId, root: prodReal, openedAt: new Date().toISOString() };
      const prodGuard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
      const head0 = git(prodRoot, ["rev-parse", "HEAD"]);
      let probeFile;
      for (const candidate of ["README.md", "AGENTS.md"]) {
        const tracked = spawnSync("git", ["ls-files", "--error-unmatch", candidate], { cwd: prodRoot, encoding: "utf8" });
        const dirty = spawnSync("git", ["status", "--porcelain", "--", candidate], { cwd: prodRoot, encoding: "utf8" }).stdout.trim();
        if (tracked.status === 0 && dirty === "") {
          probeFile = candidate;
          break;
        }
      }
      assert.ok(probeFile, "P1 needs one clean tracked probe file");
      const cleanMs = [];
      let tainted = 0;
      for (let attempt = 1; attempt <= 8 && cleanMs.length < 3; attempt++) {
        const head = git(prodRoot, ["rev-parse", "HEAD"]);
        const trackedBefore = trackedStatus(prodRoot);
        const t0 = Date.now();
        let err;
        try {
          await gitCommit(config, prodGuard, prodWs, {
            workspace_id: prodWsId, paths: [probeFile], message: "p1 probe", expected_head: head
          });
        } catch (e) {
          err = e;
        }
        const ms = Date.now() - t0;
        assert.ok(err, `P1 attempt ${attempt}: unchanged file must not succeed`);
        if (err.reason === "snapshot-too-large") {
          throw new Error(`P1 attempt ${attempt}: snapshot-too-large on production tree (the old blocker)`);
        }
        if (err.reason === "no-changes") {
          cleanMs.push(ms);
          console.log(`RAW_OBSERVATION: P1 attempt ${attempt} no-changes probeMs=${ms} (background agents active).`);
          continue;
        }
        const drifted = trackedStatus(prodRoot) !== trackedBefore || git(prodRoot, ["rev-parse", "HEAD"]) !== head;
        if (drifted) {
          tainted++;
          console.log(`RAW_OBSERVATION: P1 attempt ${attempt} tainted by genuine concurrent tracked drift (reason=${err.reason}), retrying.`);
          continue;
        }
        throw new Error(`P1 attempt ${attempt}: helper defect without tracked drift: reason=${err.reason} message=${err.message}`);
      }
      assert.ok(cleanMs.length >= 3, `P1 needs 3 clean completions, got ${cleanMs.length} (tainted=${tainted})`);
      console.log(`RAW_OBSERVATION: P1 ${cleanMs.length} consecutive clean no-changes completions ms=[${cleanMs.join(",")}] tainted=${tainted}; HEAD ${head0.slice(0, 8)} (ours never advanced).`);
      console.log("PASS P1 concurrent live no-change (no quiet window, no snapshot-too-large)");
    }
  }

  // Concurrent ignored-cache writer used by P2/P8. Runs during the commit;
  // returns the number of writer files created across the commit window.
  async function commitWithIgnoredWriter(repo, wsId, requestArgs, writerDirRel, writerMs) {
    const writerDir = path.join(repo.root, writerDirRel);
    await mkdir(writerDir, { recursive: true });
    const countFiles = async () => (await readdir(writerDir).catch(() => [])).length;
    const writer = spawn(process.execPath, ["-e", `
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = ${JSON.stringify(writerDir)};
      let i = 0;
      const timer = setInterval(() => {
        try { fs.writeFileSync(path.join(dir, "w-" + process.pid + "-" + (i++) + ".tmp"), "x".repeat(64)); } catch {}
      }, 2);
      setTimeout(() => { clearInterval(timer); process.exit(0); }, ${writerMs});
    `], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const before = await countFiles();
    const t0 = Date.now();
    let outcome;
    try {
      outcome = { ok: true, result: await gitCommit(config, guard, repo.workspace, { workspace_id: wsId, ...requestArgs }) };
    } catch (e) {
      outcome = { ok: false, error: e };
    }
    const ms = Date.now() - t0;
    await new Promise((resolve) => writer.on("exit", resolve));
    const after = await countFiles();
    return { outcome, ms, writerBefore: before, writerAfter: after };
  }

  // P2 — concurrent unrelated ignored writer must not block the commit.
  {
    const repo = await mkRepo("p2-writer", { "selected.txt": "base\n", "other.txt": "other\n" }, "ignored-cache/\n");
    await writeFile(path.join(repo.root, "selected.txt"), "changed\n");
    const base = repo.base;
    const head = git(repo.root, ["rev-parse", "HEAD"]);
    assert.equal(head, base);
    const run = await commitWithIgnoredWriter(repo, repo.wsId,
      { paths: ["selected.txt"], message: "p2", expected_head: base }, "ignored-cache", 4000);
    assert.ok(run.outcome.ok, `P2 commit must succeed despite concurrent ignored writer: ${run.outcome.ok ? "" : run.outcome.error.reason}`);
    assert.ok(run.writerAfter > run.writerBefore, `P2 writer must have run during commit (${run.writerBefore} -> ${run.writerAfter})`);
    assert.equal(git(repo.root, ["show", `HEAD:selected.txt`]).trim(), "changed");
    console.log(`RAW_OBSERVATION: P2 commit succeeded commitMs=${run.ms} while ignored writer created ${run.writerAfter - run.writerBefore} files during the window.`);
    console.log("PASS P2 concurrent unrelated ignored writer does not block");
  }

  // P3 — hook corrupts an unrelated TRACKED file: no clean success.
  for (const keepRel of ["other.txt", "sub/nested-tracked.txt"]) {
    const repo = await mkRepo(`p3-${keepRel.replaceAll("/", "-")}`, {
      "selected.txt": "base\n",
      "other.txt": "other base\n",
      "sub/nested-tracked.txt": "nested base\n"
    });
    await installHook(repo, `#!/bin/sh\nprintf 'CORRUPTED\n' > '${path.join(repo.root, keepRel)}'\nexit 0\n`);
    await writeFile(path.join(repo.root, "selected.txt"), "changed\n");
    let err;
    try {
      await gitCommit(config, guard, repo.workspace, {
        workspace_id: repo.wsId, paths: ["selected.txt"], message: "p3", expected_head: repo.base
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, `P3 ${keepRel} must not succeed`);
    assert.equal(err.reason, "postcondition");
    assert.equal(await readFile(path.join(repo.root, keepRel), "utf8"), "CORRUPTED\n", "tracked corruption survives for inspection");
    console.log(`RAW_OBSERVATION: P3 tracked ${keepRel} hook corruption rejected reason=${err.reason}.`);
  }
  console.log("PASS P3 tracked hook corruption still blocks");

  // P4 — hook mutates unrelated INDEX state (stages another file): detected.
  {
    const repo = await mkRepo("p4-index", { "selected.txt": "base\n", "other.txt": "other base\n" });
    await installHook(repo, `#!/bin/sh\nprintf 'other changed\n' > '${path.join(repo.root, "other.txt")}'\ngit add -- other.txt\nexit 0\n`);
    await writeFile(path.join(repo.root, "selected.txt"), "changed\n");
    let err;
    try {
      await gitCommit(config, guard, repo.workspace, {
        workspace_id: repo.wsId, paths: ["selected.txt"], message: "p4", expected_head: repo.base
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "P4 index mutation must not succeed");
    assert.equal(err.reason, "postcondition");
    console.log(`RAW_OBSERVATION: P4 unrelated index staging rejected reason=${err.reason}.`);
    console.log("PASS P4 index mutation still detected");
  }

  // P5 — hook mutates local config and creates a scratch ref: detected.
  {
    const repo = await mkRepo("p5-refcfg", { "selected.txt": "base\n" });
    await installHook(repo, `#!/bin/sh\ngit config user.probe mutated\ngit update-ref refs/heads/scratch-hook HEAD\nexit 0\n`);
    await writeFile(path.join(repo.root, "selected.txt"), "changed\n");
    let err;
    try {
      await gitCommit(config, guard, repo.workspace, {
        workspace_id: repo.wsId, paths: ["selected.txt"], message: "p5", expected_head: repo.base
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "P5 ref/config mutation must not succeed");
    assert.equal(err.reason, "postcondition");
    assert.equal(git(repo.root, ["config", "user.probe"]), "mutated");
    assert.ok(git(repo.root, ["rev-parse", "--verify", "refs/heads/scratch-hook"]).length > 0);
    git(repo.root, ["update-ref", "-d", "refs/heads/scratch-hook"]);
    git(repo.root, ["config", "--unset", "user.probe"]);
    console.log(`RAW_OBSERVATION: P5 local config+ref mutation rejected reason=${err.reason}; scratch state cleaned.`);
    console.log("PASS P5 ref/config mutation still detected");
  }

  // P6 — retained commit-owned ignored boundary: a hook mutating an
  // individually-reported ignored file (top-level *.ignored) must still be
  // detected; a hook mutating files under a COLLAPSED ignored directory is
  // outside commit ownership and must NOT block the commit (mutation left
  // intact, never hidden or rolled back).
  {
    const repo = await mkRepo("p6-owned", { "selected.txt": "base\n" }, "*.ignored\nignored-dir/\n");
    await writeFile(path.join(repo.root, "owned.ignored"), "ORIGINAL\n");
    await mkdir(path.join(repo.root, "ignored-dir", "sub"), { recursive: true });
    await writeFile(path.join(repo.root, "ignored-dir", "sub", "nested.txt"), "NESTED_ORIGINAL\n");
    const ownedBase = repo.base;
    await installHook(repo, `#!/bin/sh\nprintf 'MUTATED\n' > '${path.join(repo.root, "owned.ignored")}'\nexit 0\n`);
    await writeFile(path.join(repo.root, "selected.txt"), "changed\n");
    let err;
    try {
      await gitCommit(config, guard, repo.workspace, {
        workspace_id: repo.wsId, paths: ["selected.txt"], message: "p6-owned", expected_head: ownedBase
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "P6 owned ignored mutation must not succeed");
    assert.equal(err.reason, "postcondition");
    assert.equal(await readFile(path.join(repo.root, "owned.ignored"), "utf8"), "MUTATED\n");
    console.log(`RAW_OBSERVATION: P6 individually-reported owned.ignored mutation rejected reason=${err.reason}.`);
  }
  {
    const repo = await mkRepo("p6-unowned", { "selected.txt": "base\n" }, "ignored-dir/\n");
    await mkdir(path.join(repo.root, "ignored-dir", "sub"), { recursive: true });
    await writeFile(path.join(repo.root, "ignored-dir", "sub", "nested.txt"), "NESTED_ORIGINAL\n");
    const unownedBase = repo.base;
    await installHook(repo, `#!/bin/sh\nprintf 'NESTED_MUTATED\n' > '${path.join(repo.root, "ignored-dir", "sub", "nested.txt")}'\nexit 0\n`);
    await writeFile(path.join(repo.root, "selected.txt"), "changed\n");
    const t0 = Date.now();
    const res = await gitCommit(config, guard, repo.workspace, {
      workspace_id: repo.wsId, paths: ["selected.txt"], message: "p6-unowned", expected_head: unownedBase
    });
    const ms = Date.now() - t0;
    assert.equal(res.old_head, unownedBase);
    assert.deepEqual(res.committed_paths, ["selected.txt"]);
    assert.equal(await readFile(path.join(repo.root, "ignored-dir", "sub", "nested.txt"), "utf8"), "NESTED_MUTATED\n", "unowned side effect left intact, not hidden");
    console.log(`RAW_OBSERVATION: P6 collapsed-dir hook side effect did not block commit (commitMs=${ms}); mutation physically survives.`);
  }
  console.log("PASS P6 owned ignored boundary enforced, unowned ignored does not block");

  // P7 — ordinary small repo one-file commit with hooks enabled succeeds.
  {
    const repo = await mkRepo("p7-small", { "one.txt": "base\n", "other.txt": "other\n" });
    await installHook(repo, "#!/bin/sh\nexit 0\n");
    await writeFile(path.join(repo.root, "one.txt"), "changed\n");
    const res = await gitCommit(config, guard, repo.workspace, {
      workspace_id: repo.wsId, paths: ["one.txt"], message: "p7", expected_head: repo.base
    });
    assert.deepEqual(res.committed_paths, ["one.txt"]);
    console.log("PASS P7 ordinary small-repo one-file commit");
  }

  // P8 — large production-shaped tree (1500 tracked + 25000 ignored) with an
  // ACTIVE unrelated ignored writer during the commit: must succeed without
  // whole-tree quietness. Reports elapsed time and scanned-entry scale.
  {
    const large0 = path.join(fixture, "large");
    await mkdir(large0, { recursive: true });
    initRepo(large0, "Large");
    for (let i = 0; i < 1500; i++) {
      await writeFile(path.join(large0, `tracked-${String(i).padStart(4, "0")}.txt`), `tracked ${i}\n`);
    }
    await writeFile(path.join(large0, ".gitignore"), "ignored-dir/\nignored-cache/\n");
    await mkdir(path.join(large0, "ignored-dir"));
    for (let i = 0; i < 25000; i++) {
      await writeFile(path.join(large0, "ignored-dir", `ignored-${String(i).padStart(5, "0")}.txt`), `ignored ${i}\n`);
    }
    const largeBase = commitAll(large0, "large base");
    const largeRoot = await realpath(large0);
    const largeWsId = `ws_${createHash("sha256").update(largeRoot).digest("hex").slice(0, 24)}`;
    const largeRepo = { root: largeRoot, wsId: largeWsId, workspace: { id: largeWsId, root: largeRoot, openedAt: new Date().toISOString() } };
    await writeFile(path.join(large0, "tracked-0000.txt"), "tracked 0 changed\n");
    const run = await commitWithIgnoredWriter(largeRepo, largeWsId,
      { paths: ["tracked-0000.txt"], message: "p8", expected_head: largeBase }, "ignored-cache", 8000);
    assert.ok(run.outcome.ok, `P8 must succeed with active ignored writer: ${run.outcome.ok ? "" : run.outcome.error.reason}`);
    assert.deepEqual(run.outcome.result.committed_paths, ["tracked-0000.txt"]);
    assert.ok(run.writerAfter > run.writerBefore, "P8 writer must have run during commit");
    assert.equal(await readFile(path.join(large0, "ignored-dir", "ignored-24999.txt"), "utf8"), "ignored 24999\n");
    console.log(`RAW_OBSERVATION: P8 1500 tracked + 25000 ignored + active writer (${run.writerAfter - run.writerBefore} files during window) commitMs=${run.ms}, ignored tree intact.`);
    console.log("PASS P8 large production-shaped commit with active writer");
  }

  console.log("ONEFILE: PASS");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
