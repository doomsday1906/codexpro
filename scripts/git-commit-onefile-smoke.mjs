import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const NUL = String.fromCharCode(0);

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
  const { gitCommit } = await import("../dist/gitCommit.js");
  const {
    scanIgnoredWindowWithMarker,
    createIgnoredWindowMarker,
    removeIgnoredWindowMarker
  } = await import("../dist/gitCommit.js");

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

  // Window-scan regression matrix P1--P5. Each case commits an unrelated
  // tracked file while a synchronous pre-commit hook mutates ignored content.
  // The helper must NOT report clean success; preservation fails as
  // postcondition (successful hook advanced HEAD) per existing contract.
  // Every case runs on BOTH scan engines (find acceleration + portable Node)
  // to prove engine equivalence.
  async function mkHookRepo(dirName, keepRel, keepOriginal, hookScriptFor) {
    const r0 = path.join(fixture, dirName);
    await mkdir(r0, { recursive: true });
    initRepo(r0, dirName);
    await writeFile(path.join(r0, "selected.txt"), "selected base\n");
    await writeFile(path.join(r0, ".gitignore"), "ignored-dir/\n");
    await mkdir(path.join(r0, path.dirname(keepRel)), { recursive: true });
    await writeFile(path.join(r0, keepRel), keepOriginal);
    const base = commitAll(r0, `${dirName} base`);
    const root = await realpath(r0);
    const hooks = path.join(root, ".githooks");
    await mkdir(hooks);
    await writeFile(path.join(hooks, "pre-commit"), hookScriptFor(path.join(root, keepRel)));
    await chmod(path.join(hooks, "pre-commit"), 0o700);
    git(root, ["config", "core.hooksPath", ".githooks"]);
    await writeFile(path.join(root, "selected.txt"), "selected changed\n");
    const id = `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
    return { root, wsId: id, workspace: { id, root, openedAt: new Date().toISOString() }, base };
  }

  async function withScanner(engine, fn) {
    const prev = process.env.CODEXPRO_GIT_COMMIT_IGNORED_SCANNER;
    process.env.CODEXPRO_GIT_COMMIT_IGNORED_SCANNER = engine;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.CODEXPRO_GIT_COMMIT_IGNORED_SCANNER;
      else process.env.CODEXPRO_GIT_COMMIT_IGNORED_SCANNER = prev;
    }
  }

  async function expectHookRejection(label, keepRel, keepOriginal, hookScriptFor, engine, extraChecks) {
    return withScanner(engine, async () => {
      const repo = await mkHookRepo(`${label}-${engine}`, keepRel, keepOriginal, hookScriptFor);
      const t0 = Date.now();
      let err;
      try {
        await gitCommit(config, guard, repo.workspace, {
          workspace_id: repo.wsId,
          paths: ["selected.txt"],
          message: `${label} ${engine}`,
          expected_head: repo.base
        });
      } catch (e) {
        err = e;
      }
      const ms = Date.now() - t0;
      assert.ok(err, `${label}/${engine}: hook mutation must not succeed`);
      assert.equal(err.name, "GitCommitError");
      assert.equal(err.reason, "postcondition");
      assert.notEqual(git(repo.root, ["rev-parse", "HEAD"]), repo.base);
      if (extraChecks) await extraChecks(repo);
      console.log(`RAW_OBSERVATION: ${label} engine=${engine} rejected reason=${err.reason} commitMs=${ms}; HEAD advanced but no clean success.`);
    });
  }

  // P1 — exact Hestia reproduction: keep.txt ORIGINAL -> MUTATED.
  for (const engine of ["find", "node"]) {
    await expectHookRejection("p1-top", "ignored-dir/keep.txt", "ORIGINAL\n",
      (absKeep) => `#!/bin/sh\nprintf 'MUTATED\n' > '${absKeep}'\nexit 0\n`,
      engine, async (repo) => {
        assert.equal(await readFile(path.join(repo.root, "ignored-dir/keep.txt"), "utf8"), "MUTATED\n");
      });
  }
  console.log("PASS P1 exact ignored hook mutation (both engines)");

  // P2 — nested ignored file.
  for (const engine of ["find", "node"]) {
    await expectHookRejection("p2-nested", "ignored-dir/sub/nested.txt", "NESTED_ORIGINAL\n",
      (absKeep) => `#!/bin/sh\nprintf 'NESTED_MUTATED\n' > '${absKeep}'\nexit 0\n`,
      engine, async (repo) => {
        assert.equal(await readFile(path.join(repo.root, "ignored-dir/sub/nested.txt"), "utf8"), "NESTED_MUTATED\n");
      });
  }
  console.log("PASS P2 nested ignored mutation (both engines)");

  // P3 — same-size rewrite (9 bytes -> 9 different bytes).
  for (const engine of ["find", "node"]) {
    await expectHookRejection("p3-samesize", "ignored-dir/keep.txt", "ORIGINAL\n",
      (absKeep) => `#!/bin/sh\nprintf 'MUTATED!\n' > '${absKeep}'\nexit 0\n`,
      engine, async (repo) => {
        const content = await readFile(path.join(repo.root, "ignored-dir/keep.txt"), "utf8");
        assert.equal(content, "MUTATED!\n");
        assert.equal(Buffer.byteLength(content), Buffer.byteLength("ORIGINAL\n"), "same byte length");
      });
  }
  console.log("PASS P3 same-size rewrite detected (both engines)");

  // P4 — same-path replacement with a new inode, similar size/mode.
  for (const engine of ["find", "node"]) {
    await withScanner(engine, async () => {
      const repo = await mkHookRepo(`p4-replace-${engine}`, "ignored-dir/keep.txt", "ORIGINAL\n", () => "#!/bin/sh\nexit 0\n");
      const before = await lstat(path.join(repo.root, "ignored-dir/keep.txt"));
      await writeFile(path.join(repo.root, ".githooks/pre-commit"),
        `#!/bin/sh\nrm '${path.join(repo.root, "ignored-dir/keep.txt")}'\nprintf 'REPLACED\n' > '${path.join(repo.root, "ignored-dir/keep.txt")}'\nexit 0\n`);
      let err;
      try {
        await gitCommit(config, guard, repo.workspace, {
          workspace_id: repo.wsId, paths: ["selected.txt"], message: `p4 ${engine}`, expected_head: repo.base
        });
      } catch (e) {
        err = e;
      }
      assert.ok(err, `p4/${engine} must not succeed`);
      assert.equal(err.reason, "postcondition");
      const afterStat = await lstat(path.join(repo.root, "ignored-dir/keep.txt"));
      assert.equal(await readFile(path.join(repo.root, "ignored-dir/keep.txt"), "utf8"), "REPLACED\n");
      assert.equal(afterStat.size, before.size, "similar size preserved");
      // Freed inodes may be immediately reused, so replacement is proven by
      // new identity OR advanced ctime (a fresh create always sets ctime=now).
      assert.ok(afterStat.ino !== before.ino || afterStat.ctimeMs > before.ctimeMs, "replacement must change identity or ctime");
      console.log(`RAW_OBSERVATION: p4 engine=${engine} rejected; ino ${before.ino} -> ${afterStat.ino} same size ${afterStat.size} ctime advanced=${afterStat.ctimeMs > before.ctimeMs}.`);
    });
  }
  console.log("PASS P4 same-path replacement detected (both engines)");

  // P5 — timestamp-resistant: hook restores mtime after modifying. Detection
  // must come from ctime (utimens updates ctime); demonstrate explicitly.
  for (const engine of ["find", "node"]) {
    await expectHookRejection("p5-mtime", "ignored-dir/keep.txt", "ORIGINAL\n",
      (absKeep) => `#!/bin/sh\nprintf 'MUTATED\n' > '${absKeep}'\ntouch -m -d '2001-01-01 00:00:00' '${absKeep}'\nexit 0\n`,
      engine, async (r) => {
        const s = await lstat(path.join(r.root, "ignored-dir/keep.txt"));
        assert.equal(await readFile(path.join(r.root, "ignored-dir/keep.txt"), "utf8"), "MUTATED\n");
        assert.ok(s.mtimeMs < Date.now() - 30 * 86400 * 1000, `mtime must look restored/old (got ${new Date(s.mtimeMs).toISOString()})`);
        assert.ok(s.ctimeMs > s.mtimeMs, `ctime (${new Date(s.ctimeMs).toISOString()}) must be newer than restored mtime`);
        console.log(`RAW_OBSERVATION: p5 engine=${engine} mtime=${new Date(s.mtimeMs).toISOString()} ctime=${new Date(s.ctimeMs).toISOString()} -> ctime is the detecting field.`);
      });
  }
  console.log("PASS P5 mtime-reset still detected via ctime (both engines)");

  // P6 — large-tree positive fixture: same algorithm class as production
  // (one collapsed ignored dir), 25000 ignored files (exceeds the old 20000
  // full-census bound), 1500 tracked files, one tracked file changed, hooks
  // clean. Must succeed with byte-identical ignored tree, bounded runtime.
  for (const engine of ["find", "node"]) {
    await withScanner(engine, async () => {
      const large0 = path.join(fixture, `large-${engine}`);
      await mkdir(large0, { recursive: true });
      initRepo(large0, `Large ${engine}`);
      for (let i = 0; i < 1500; i++) {
        await writeFile(path.join(large0, `tracked-${String(i).padStart(4, "0")}.txt`), `tracked ${i}\n`);
      }
      await writeFile(path.join(large0, ".gitignore"), "ignored-dir/\n");
      await mkdir(path.join(large0, "ignored-dir"));
      for (let i = 0; i < 25000; i++) {
        await writeFile(path.join(large0, "ignored-dir", `ignored-${String(i).padStart(5, "0")}.txt`), `ignored ${i}\n`);
      }
      const largeBase = commitAll(large0, `large base ${engine}`);
      const largeRoot = await realpath(large0);
      const largeWsId = `ws_${createHash("sha256").update(largeRoot).digest("hex").slice(0, 24)}`;
      const largeWorkspace = { id: largeWsId, root: largeRoot, openedAt: new Date().toISOString() };
      await writeFile(path.join(large0, "tracked-0000.txt"), "tracked 0 changed\n");
      const t0 = Date.now();
      const largeResult = await gitCommit(config, guard, largeWorkspace, {
        workspace_id: largeWsId, paths: ["tracked-0000.txt"], message: `large one-file ${engine}`, expected_head: largeBase
      });
      const ms = Date.now() - t0;
      assert.equal(largeResult.old_head, largeBase);
      assert.deepEqual(largeResult.committed_paths, ["tracked-0000.txt"]);
      assert.equal(await readFile(path.join(large0, "ignored-dir", "ignored-00000.txt"), "utf8"), "ignored 0\n");
      assert.equal(await readFile(path.join(large0, "ignored-dir", "ignored-24999.txt"), "utf8"), "ignored 24999\n");
      console.log(`RAW_OBSERVATION: P6 engine=${engine} 1500 tracked + 25000 ignored one-file commit ${largeBase} -> ${largeResult.new_head} commitMs=${ms}, ignored tree byte-identical.`);
    });
  }
  console.log("PASS P6 large-tree positive (both engines)");

  // P7 — real AgentWorkspace non-mutating probe. Read-only apart from
  // task-owned temp marker/locks: no commit is created; the helper no-change
  // path plus a direct window scan prove the preservation snapshot completes
  // on production scale (must NOT return snapshot-too-large). Retried: the
  // live workstation has concurrent writers, so a single attempt may observe
  // genuine mid-operation drift; the probe passes when a quiescent attempt
  // completes with no-changes and HEAD unchanged.
  {
    const prodRoot = "/home/andrew/AgentWorkspace";
    let prodPresent = false;
    try {
      await stat(path.join(prodRoot, ".git"));
      prodPresent = true;
    } catch {
      prodPresent = false;
    }
    if (!prodPresent) {
      console.log("SKIP P7 real AgentWorkspace probe (repository absent)");
    } else {
      const prodReal = await realpath(prodRoot);
      const prodWsId = `ws_${createHash("sha256").update(prodReal).digest("hex").slice(0, 24)}`;
      const prodWorkspace = { id: prodWsId, root: prodReal, openedAt: new Date().toISOString() };
      const prodGuard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
      const prodHead0 = git(prodRoot, ["rev-parse", "HEAD"]);
      const candidates = ["README.md", "AGENTS.md"];
      let probeFile;
      for (const candidate of candidates) {
        const tracked = spawnSync("git", ["ls-files", "--error-unmatch", candidate], { cwd: prodRoot, encoding: "utf8" });
        const dirty = spawnSync("git", ["status", "--porcelain", "--", candidate], { cwd: prodRoot, encoding: "utf8" }).stdout.trim();
        if (tracked.status === 0 && dirty === "") {
          probeFile = candidate;
          break;
        }
      }
      assert.ok(probeFile, "P7 needs one clean tracked probe file");
      let probeErr;
      let probeMs = 0;
      let attempts = 0;
      for (let attempt = 1; attempt <= 5; attempt++) {
        attempts = attempt;
        const head = git(prodRoot, ["rev-parse", "HEAD"]);
        const t0 = Date.now();
        try {
          await gitCommit(config, prodGuard, prodWorkspace, {
            workspace_id: prodWsId, paths: [probeFile], message: "p7 non-mutating probe", expected_head: head
          });
        } catch (e) {
          probeErr = e;
        }
        probeMs = Date.now() - t0;
        if (probeErr && probeErr.reason === "no-changes") break;
        console.log(`RAW_OBSERVATION: P7 probe attempt ${attempt} -> ${probeErr ? probeErr.reason : "SUCCESS?!" } (live-workstation drift, retrying quiescent window).`);
        probeErr = probeErr && probeErr.reason === "no-changes" ? probeErr : undefined;
        await new Promise((r) => setTimeout(r, 2000));
      }
      assert.ok(probeErr, "P7 probe must fail (no changes)");
      assert.equal(probeErr.reason, "no-changes", `P7 snapshot must complete, got ${probeErr.reason} after ${attempts} attempts`);
      assert.equal(git(prodRoot, ["rev-parse", "HEAD"]), prodHead0, "P7 must not advance HEAD");
      console.log(`RAW_OBSERVATION: P7 no-change helper probe on real AgentWorkspace -> reason=${probeErr.reason} probeMs=${probeMs} attempts=${attempts}, HEAD unchanged ${prodHead0}.`);

      // Direct window scan on the real ignored roots, both engines.
      const statusOut = spawnSync("git", ["-c", "core.fsmonitor=false", "--no-pager", "status", "--porcelain=v2", "-z", "--ignored=matching", "--untracked-files=all"], { cwd: prodRoot, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      assert.equal(statusOut.status, 0);
      const statuses = new Map();
      for (const entry of statusOut.stdout.toString("utf8").split(NUL)) {
        if (entry.startsWith("! ")) statuses.set(entry.slice(2), "! ignored");
        else if (entry.startsWith("? ")) statuses.set(entry.slice(2), "? untracked");
        else if (entry) statuses.set(entry, entry.slice(0, 1));
      }
      for (const engine of ["find", "node"]) {
        const marker = await createIgnoredWindowMarker();
        try {
          const s0 = Date.now();
          const scan = await scanIgnoredWindowWithMarker(prodWorkspace, statuses, marker.markerPath, marker.ctimeMs, { scanner: engine });
          const scanMs = Date.now() - s0;
          assert.equal(scan.scanned, true);
          assert.equal(scan.engine, engine);
          console.log(`RAW_OBSERVATION: P7 direct window scan engine=${scan.engine} entries=${scan.entries} hitCount=${scan.hitCount} scanMs=${scanMs}${scan.hitCount > 0 ? ` firstHits=${JSON.stringify(scan.hits.slice(0, 3))} (background activity, completion still proven)` : ""}.`);
        } finally {
          await removeIgnoredWindowMarker(marker.markerPath);
        }
      }
      console.log("PASS P7 real AgentWorkspace non-mutating probe (no snapshot-too-large)");
    }
  }

  // P8 — genuinely pathological bound: injected tiny entry bound on a 300-file
  // fixture must return snapshot-too-large (node engine enforces entry bound;
  // find engine is timeout/streaming-bounded). Proves fail-closed, not silent
  // reduced coverage.
  {
    const bound0 = path.join(fixture, "bound");
    await mkdir(bound0, { recursive: true });
    initRepo(bound0, "Bound");
    await writeFile(path.join(bound0, "selected.txt"), "selected base\n");
    await writeFile(path.join(bound0, ".gitignore"), "ignored-dir/\n");
    await mkdir(path.join(bound0, "ignored-dir"));
    for (let i = 0; i < 300; i++) {
      await writeFile(path.join(bound0, "ignored-dir", `f-${String(i).padStart(3, "0")}.txt`), "x\n");
    }
    commitAll(bound0, "bound base");
    const boundRoot = await realpath(bound0);
    const boundWs = { id: `ws_${createHash("sha256").update(boundRoot).digest("hex").slice(0, 24)}`, root: boundRoot, openedAt: new Date().toISOString() };
    const statuses = new Map([["ignored-dir/", "! ignored"]]);
    const marker = await createIgnoredWindowMarker();
    try {
      let boundErr;
      try {
        await scanIgnoredWindowWithMarker(boundWs, statuses, marker.markerPath, marker.ctimeMs, { scanner: "node", maxEntries: 50 });
      } catch (e) {
        boundErr = e;
      }
      assert.ok(boundErr, "pathological bound must fail");
      assert.equal(boundErr.reason, "snapshot-too-large");
      console.log(`RAW_OBSERVATION: P8 node maxEntries=50 on 300-file tree -> reason=${boundErr.reason}.`);
      const okScan = await scanIgnoredWindowWithMarker(boundWs, statuses, marker.markerPath, marker.ctimeMs, { scanner: "node" });
      assert.equal(okScan.hitCount, 0, "same tree within production bound must be clean");
      console.log(`RAW_OBSERVATION: P8 same tree production bound entries=${okScan.entries} hits=0.`);
    } finally {
      await removeIgnoredWindowMarker(marker.markerPath);
    }
    console.log("PASS P8 pathological bound fail-closed");
  }

  console.log("ONEFILE: PASS");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
