import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-task004-"));

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForMarker(markerPath) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await exists(markerPath)) return;
    await delay(10);
  }
  throw new Error(`hook marker did not appear: ${markerPath}`);
}

async function expectReason(operation, reason) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    console.log(
      `RAW_OPERATION_ERROR: name=${failure?.name ?? "none"} reason=${failure?.reason ?? "none"} message=${JSON.stringify(failure?.message ?? "none")}`
    );
  }
  assert.ok(failure, `expected GitCommitError(${reason})`);
  assert.equal(
    failure?.name,
    "GitCommitError",
    `expected bounded GitCommitError, got ${failure?.constructor?.name ?? typeof failure}`
  );
  assert.equal(failure.reason, reason);
  assert.ok(!failure.message.includes("HOSTILE"), "failure echoed hostile input");
  return failure;
}

async function expectConcurrencyFailure(operation) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  console.log(
    `RAW_OPERATION_ERROR: name=${failure?.name ?? "none"} reason=${failure?.reason ?? "none"} message=${JSON.stringify(failure?.message ?? "none")}`
  );
  assert.ok(failure, "expected the moved-head operation to fail");
  assert.equal(failure?.name, "GitCommitError");
  assert.ok(
    ["head-mismatch", "preflight-changed", "postcondition", "recovery-required"].includes(failure.reason),
    `expected a bounded concurrency/postcondition reason, got ${failure.reason}`
  );
  assert.ok(!failure.message.includes("HOSTILE"), "failure echoed hostile input");
  return failure;
}

async function initRepo(root, name) {
  await mkdir(root);
  mustGit(root, ["init", "--quiet"]);
  mustGit(root, ["config", "user.name", name]);
  mustGit(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.invalid`]);
}

function commitAll(root, message) {
  mustGit(root, ["add", "--all"]);
  mustGit(root, ["commit", "--quiet", "-m", message]);
  return gitTrimmed(root, ["rev-parse", "HEAD"]);
}

function branchRef(root) {
  return gitTrimmed(root, ["symbolic-ref", "--quiet", "HEAD"]);
}

function branchName(root) {
  return branchRef(root).slice("refs/heads/".length);
}

function parentLine(root, head = gitTrimmed(root, ["rev-parse", "HEAD"])) {
  return gitTrimmed(root, ["rev-list", "--parents", "--max-count=1", head]);
}

function indexBytes(root) {
  return mustGit(root, ["ls-files", "--stage", "-z"]);
}

function statusBytes(root) {
  return mustGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
}

function remoteRefs(root) {
  return gitText(root, ["for-each-ref", "--format=%(refname)=%(objectname)", "refs/remotes"]);
}

function worktreeBytes(root, relativePath) {
  return readFile(path.join(root, relativePath));
}

async function writeHook(root, name, body) {
  const hooksRoot = path.join(fixtureRoot, `${path.basename(root)}-hooks`);
  await mkdir(hooksRoot);
  const hookPath = path.join(hooksRoot, name);
  await writeFile(hookPath, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(hookPath, 0o755);
  mustGit(root, ["config", "core.hooksPath", hooksRoot]);
  return { hooksRoot, hookPath };
}

async function workspaceFor(root, id) {
  return { id, root, openedAt: new Date().toISOString() };
}

function request(workspace, paths, expectedHead, message = "task004 smoke commit") {
  return {
    workspace_id: workspace.id,
    paths,
    message,
    expected_head: expectedHead
  };
}

async function prepareRaceCommit(root, expectedHead, racePath) {
  await writeFile(path.join(root, racePath), "race moved current\n");
  const temporaryIndex = path.join(root, ".git", "task004-race-index");
  const env = { GIT_INDEX_FILE: temporaryIndex };
  try {
    const readTree = directGit(root, ["read-tree", expectedHead], { env });
    assert.equal(readTree.status, 0, readTree.stderr.toString("utf8"));
    mustGit(root, ["add", "--", racePath], { env });
    const tree = gitTrimmed(root, ["write-tree"], { env });
    const movedHead = gitTrimmed(root, ["commit-tree", tree, "-p", expectedHead, "-m", "race moved"], { env });
    assert.notEqual(movedHead, expectedHead);
    assert.equal(parentLine(root, movedHead), `${movedHead} ${expectedHead}`);
    return movedHead;
  } finally {
    if (await exists(temporaryIndex)) await unlink(temporaryIndex);
  }
}

async function raceCase({ label, hookName }) {
  const root = path.join(fixtureRoot, label);
  await initRepo(root, `TASK-004 ${label}`);
  await writeFile(path.join(root, "selected.txt"), "selected base\n");
  await writeFile(path.join(root, "race.txt"), "race base\n");
  const expectedHead = commitAll(root, `${label} base`);
  const workspace = await workspaceFor(root, `ws_${label}`);
  const branch = branchRef(root);
  const movedHead = await prepareRaceCommit(root, expectedHead, "race.txt");
  await writeFile(path.join(root, "selected.txt"), "selected current\n");
  const entered = path.join(fixtureRoot, `${label}-entered`);
  const release = path.join(fixtureRoot, `${label}-release`);
  await writeHook(
    root,
    hookName,
    `printf 'entered\\n' > '${entered}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done`
  );

  const config = { maxGitTimeoutMs: 10_000, maxOutputBytes: 120_000 };
  const guard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });
  const beforeRef = gitTrimmed(root, ["rev-parse", branch]);
  assert.equal(beforeRef, expectedHead);
  assert.equal(await exists(entered), false);
  const operation = gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], expectedHead, `${label} operation`));
  await waitForMarker(entered);

  // This is the independent predicate evidence: the marker is physically
  // present, and a separate child Git process atomically moves the branch.
  const move = directGit(root, ["update-ref", branch, movedHead, expectedHead]);
  assert.equal(move.status, 0, move.stderr.toString("utf8"));
  const refAfterMove = gitTrimmed(root, ["rev-parse", branch]);
  assert.equal(refAfterMove, movedHead);
  const movedParent = parentLine(root, movedHead);
  console.log(`RAW_RACE_PREDICATE: ${label} marker=present external_update_ref_exit=${move.status} branch_before=${expectedHead} branch_after_external_move=${refAfterMove}`);
  console.log(`PREDICATE: TRUE (${label} hook pause and independent ref movement are directly observed)`);

  await writeFile(release, "release\n");
  const failure = await expectConcurrencyFailure(() => operation);
  const finalRef = gitTrimmed(root, ["rev-parse", branch]);
  const finalParents = parentLine(root, finalRef);
  console.log(`RAW_RACE_RESULT: ${label} error_reason=${failure.reason} final_ref=${finalRef} final_parents=${finalParents}`);
  // A correct CAS result leaves the second process's exact moved ref in place.
  assert.equal(finalRef, movedHead, `${label} overwrote or committed on top of the moved branch`);
  assert.equal(finalParents, movedParent);
  console.log(`SANITY_VERDICT: MATCH (${label} stayed at the independently moved ref and did not create a child commit)`);
}

async function successfulHookCase(config, guard) {
  const root = path.join(fixtureRoot, "hook-success");
  await initRepo(root, "TASK-004 Hook Success");
  await writeFile(path.join(root, "selected.txt"), "base\n");
  const base = commitAll(root, "hook success base");
  const workspace = await workspaceFor(root, "ws_hook_success");
  const marker = path.join(fixtureRoot, "hook-success-pre-commit-seen");
  await writeHook(root, "pre-commit", `printf 'seen\\n' > '${marker}'`);
  await writeFile(path.join(root, "selected.txt"), "current\n");
  console.log(`RAW_HOOK_SUCCESS_BEFORE: HEAD=${gitTrimmed(root, ["rev-parse", "HEAD"])} marker_present=${await exists(marker)}`);
  const result = await gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "hook success"));
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  const parents = parentLine(root, after);
  assert.equal(await exists(marker), true);
  assert.equal(result.old_head, base);
  assert.equal(result.new_head, after);
  assert.equal(parents, `${after} ${base}`);
  assert.equal(mustGit(root, ["show", `${after}:selected.txt`]).toString("utf8"), "current\n");
  console.log(`RAW_HOOK_SUCCESS_AFTER: marker=present HEAD=${after} parents=${parents}`);
  console.log("SANITY_VERDICT: MATCH (configured pre-commit marker observed and ordinary commit advanced one parent)");
}

async function failingPreCommitCase(config, guard) {
  const root = path.join(fixtureRoot, "hook-failing-pre");
  await initRepo(root, "TASK-004 Failing Pre Commit");
  await writeFile(path.join(root, "selected.txt"), "base\n");
  const base = commitAll(root, "failing pre base");
  const workspace = await workspaceFor(root, "ws_hook_failing_pre");
  const marker = path.join(fixtureRoot, "hook-failing-pre-seen");
  await writeHook(root, "pre-commit", `printf 'failed\\n' > '${marker}'\nexit 7`);
  await writeFile(path.join(root, "selected.txt"), "current\n");
  const beforeIndex = indexBytes(root);
  const beforeStatus = statusBytes(root);
  const beforeRemote = remoteRefs(root);
  const failure = await expectReason(
    () => gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "failing pre")),
    "execution"
  );
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  console.log(`RAW_FAILING_PRE: marker=${await exists(marker)} error_reason=${failure.reason} HEAD=${after}`);
  assert.equal(await exists(marker), true);
  assert.equal(after, base);
  assert.equal(parentLine(root, after), after);
  assert.deepEqual(indexBytes(root), beforeIndex);
  assert.deepEqual(statusBytes(root), beforeStatus);
  assert.equal(remoteRefs(root), beforeRemote);
  console.log("SANITY_VERDICT: MATCH (pre-commit rejection left raw ref/index/status unchanged)");
}

async function prepareCommitMessageCase(config, guard) {
  const root = path.join(fixtureRoot, "prepare-commit-msg");
  await initRepo(root, "TASK-004 Prepare Message");
  await writeFile(path.join(root, "selected.txt"), "base\n");
  const base = commitAll(root, "prepare base");
  const workspace = await workspaceFor(root, "ws_prepare_message");
  const marker = path.join(fixtureRoot, "prepare-commit-msg-seen");
  await writeHook(root, "prepare-commit-msg", `printf 'seen\\n' > '${marker}'`);
  await writeFile(path.join(root, "selected.txt"), "current\n");
  const result = await gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "prepare message"));
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  assert.equal(await exists(marker), true);
  assert.equal(result.new_head, after);
  assert.equal(parentLine(root, after), `${after} ${base}`);
  console.log(`RAW_PREPARE_COMMIT_MSG: marker=present HEAD=${after} parents=${parentLine(root, after)}`);
  console.log("SANITY_VERDICT: MATCH (prepare-commit-msg hook was observed on the ordinary -m commit path)");
}

async function failingCommitMessageCase(config, guard) {
  const root = path.join(fixtureRoot, "hook-failing-msg");
  await initRepo(root, "TASK-004 Failing Commit Message");
  await writeFile(path.join(root, "selected.txt"), "base\n");
  const base = commitAll(root, "failing msg base");
  const workspace = await workspaceFor(root, "ws_hook_failing_msg");
  const marker = path.join(fixtureRoot, "hook-failing-msg-seen");
  await writeHook(root, "commit-msg", `printf 'failed\\n' > '${marker}'\nexit 9`);
  await writeFile(path.join(root, "selected.txt"), "current\n");
  const beforeIndex = indexBytes(root);
  const beforeStatus = statusBytes(root);
  const failure = await expectReason(
    () => gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "failing message")),
    "execution"
  );
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  assert.equal(await exists(marker), true);
  assert.equal(after, base);
  assert.deepEqual(indexBytes(root), beforeIndex);
  assert.deepEqual(statusBytes(root), beforeStatus);
  console.log(`RAW_FAILING_COMMIT_MSG: marker=present error_reason=${failure.reason} HEAD=${after}`);
  console.log("SANITY_VERDICT: MATCH (commit-msg rejection left raw ref/index/status unchanged)");
}

async function missingIdentityCase(config, guard) {
  const root = path.join(fixtureRoot, "empty-identity");
  const emptyHome = path.join(root, "empty-home");
  await initRepo(root, "TASK-004 Empty Identity");
  await writeFile(path.join(root, "selected.txt"), "base\n");
  const base = commitAll(root, "identity base");
  const workspace = await workspaceFor(root, "ws_empty_identity");
  await writeFile(path.join(root, "selected.txt"), "current\n");
  mustGit(root, ["config", "user.name", ""]);
  mustGit(root, ["config", "user.email", ""]);
  await mkdir(emptyHome);
  const savedHome = process.env.HOME;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = emptyHome;
  process.env.XDG_CONFIG_HOME = path.join(emptyHome, "xdg");
  let failure;
  try {
    failure = await expectReason(
      () => gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "empty identity")),
      "execution"
    );
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
  }
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  assert.equal(after, base);
  assert.equal(parentLine(root, after), after);
  console.log(`RAW_EMPTY_IDENTITY: error_reason=${failure.reason} HEAD=${after} local_name='' local_email=''`);
  console.log("SANITY_VERDICT: MATCH (empty local identity remained ordinary Git policy failure with no ref movement)");
}

async function signingFailureCase(config, guard) {
  const root = path.join(fixtureRoot, "signing-failure");
  const signer = path.join(root, "failing-signer");
  await initRepo(root, "TASK-004 Signing Failure");
  await writeFile(path.join(root, "selected.txt"), "base\n");
  const base = commitAll(root, "signing base");
  const workspace = await workspaceFor(root, "ws_signing_failure");
  await writeFile(signer, "#!/bin/sh\nexit 1\n");
  await chmod(signer, 0o755);
  mustGit(root, ["config", "gpg.program", signer]);
  mustGit(root, ["config", "commit.gpgSign", "true"]);
  await writeFile(path.join(root, "selected.txt"), "current\n");
  const failure = await expectReason(
    () => gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "signing failure")),
    "execution"
  );
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  assert.equal(after, base);
  console.log(`RAW_SIGNING_FAILURE: configured_signer=${signer} error_reason=${failure.reason} HEAD=${after}`);
  console.log("SANITY_VERDICT: MATCH (configured signing failure remained visible and did not advance the branch)");
}

async function plainUntrackedFailureCase(config, guard) {
  const root = path.join(fixtureRoot, "plain-untracked-failure");
  await initRepo(root, "TASK-004 Plain Untracked Failure");
  await writeFile(path.join(root, "base.txt"), "base\n");
  const base = commitAll(root, "plain untracked base");
  const workspace = await workspaceFor(root, "ws_plain_untracked_failure");
  await writeFile(path.join(root, "selected-untracked.txt"), "selected\n");
  await writeFile(path.join(root, "unrelated-staged.txt"), "before\n");
  mustGit(root, ["add", "--", "unrelated-staged.txt"]);
  await writeFile(path.join(root, "unrelated-staged.txt"), "after\n");
  await writeFile(path.join(root, "unrelated-untracked.txt"), "unrelated\n");
  const marker = path.join(fixtureRoot, "plain-untracked-rejected");
  await writeHook(root, "pre-commit", `printf 'rejected\\n' > '${marker}'\nexit 1`);
  const beforeHead = gitTrimmed(root, ["rev-parse", "HEAD"]);
  const beforeIndex = indexBytes(root);
  const beforeStatus = statusBytes(root);
  const beforeRemote = remoteRefs(root);
  const beforeSelected = await worktreeBytes(root, "selected-untracked.txt");
  const beforeStaged = await worktreeBytes(root, "unrelated-staged.txt");
  const beforeUntracked = await worktreeBytes(root, "unrelated-untracked.txt");
  const failure = await expectReason(
    () => gitCommit(config, guard, workspace, request(workspace, ["selected-untracked.txt"], base, "plain untracked failure")),
    "execution"
  );
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  assert.equal(await exists(marker), true);
  assert.equal(after, beforeHead);
  assert.deepEqual(indexBytes(root), beforeIndex);
  assert.deepEqual(statusBytes(root), beforeStatus);
  assert.equal(remoteRefs(root), beforeRemote);
  assert.deepEqual(await worktreeBytes(root, "selected-untracked.txt"), beforeSelected);
  assert.deepEqual(await worktreeBytes(root, "unrelated-staged.txt"), beforeStaged);
  assert.deepEqual(await worktreeBytes(root, "unrelated-untracked.txt"), beforeUntracked);
  assert.equal(mustGit(root, ["ls-files", "--stage", "-z", "--", "selected-untracked.txt"]).length, 0);
  console.log(`RAW_PLAIN_UNTRACKED_FAILURE: marker=present error_reason=${failure.reason} HEAD=${after} index_bytes=${beforeIndex.length} status_bytes=${beforeStatus.length}`);
  console.log("SANITY_VERDICT: MATCH (plain-untracked intent preparation and all unrelated raw state were exactly restored)");
}

async function intentReplacementCase(config, guard) {
  const root = path.join(fixtureRoot, "intent-replaced");
  await initRepo(root, "TASK-004 Intent Replacement");
  await writeFile(path.join(root, "base.txt"), "base\n");
  const base = commitAll(root, "intent replacement base");
  const workspace = await workspaceFor(root, "ws_intent_replaced");
  const selected = "selected-untracked.txt";
  await writeFile(path.join(root, selected), "selected\n");
  const marker = path.join(fixtureRoot, "intent-replaced-rejected");
  const mainIndex = path.join(root, ".git", "index");
  await writeHook(
    root,
    "pre-commit",
    `rm -f '${mainIndex}.lock'\nGIT_INDEX_FILE='${mainIndex}' git add -- '${selected}'\nprintf 'replaced\\n' > '${marker}'\nexit 1`
  );
  const beforeIndex = indexBytes(root);
  const beforeStatus = statusBytes(root);
  const failure = await expectReason(
    () => gitCommit(config, guard, workspace, request(workspace, [selected], base, "intent replacement")),
    "recovery-required"
  );
  const afterIndex = indexBytes(root);
  const afterStatus = statusBytes(root);
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  assert.equal(await exists(marker), true);
  assert.equal(after, base);
  assert.equal(beforeIndex.includes(Buffer.from(selected)), false);
  assert.equal(afterIndex.includes(Buffer.from(selected)), true);
  assert.notDeepEqual(afterIndex, beforeIndex);
  assert.notDeepEqual(afterStatus, beforeStatus);
  console.log(`RAW_INTENT_REPLACEMENT: marker=present error_reason=${failure.reason} HEAD=${after} index_bytes_before=${beforeIndex.length} index_bytes_after=${afterIndex.length}`);
  console.log("SANITY_VERDICT: MATCH (conflicting hook-owned index replacement was preserved and surfaced as recovery-required)");
}

async function unrelatedMutationCase(config, guard, shouldSucceed) {
  const label = shouldSucceed ? "unrelated-mutation-success" : "unrelated-mutation-reject";
  const root = path.join(fixtureRoot, label);
  await initRepo(root, `TASK-004 ${label}`);
  await writeFile(path.join(root, "selected.txt"), "base\n");
  await writeFile(path.join(root, "unrelated.txt"), "unrelated base\n");
  const base = commitAll(root, `${label} base`);
  const workspace = await workspaceFor(root, `ws_${label}`);
  const mainIndex = path.join(root, ".git", "index");
  const marker = path.join(fixtureRoot, `${label}-seen`);
  const hookTail = shouldSucceed ? "exit 0" : "exit 1";
  await writeHook(
    root,
    "pre-commit",
    `printf 'hook mutation\\n' > 'unrelated.txt'\nrm -f '${mainIndex}.lock'\nGIT_INDEX_FILE='${mainIndex}' git add -- unrelated.txt\nprintf 'seen\\n' > '${marker}'\n${hookTail}`
  );
  await writeFile(path.join(root, "selected.txt"), "selected current\n");
  const beforeIndex = indexBytes(root);
  const beforeStatus = statusBytes(root);
  const operation = gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, label));
  let result;
  let failure;
  try {
    result = await operation;
  } catch (error) {
    failure = error;
  }
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  const afterParents = parentLine(root, after);
  const afterIndex = indexBytes(root);
  const afterStatus = statusBytes(root);
  const unrelated = (await worktreeBytes(root, "unrelated.txt")).toString("utf8");
  assert.equal(await exists(marker), true);
  assert.equal(unrelated, "hook mutation\n");
  assert.notDeepEqual(afterIndex, beforeIndex);
  assert.notDeepEqual(afterStatus, beforeStatus);
  if (shouldSucceed) {
    assert.ok(failure, "hook mutation on an unrelated path must not produce false success");
    assert.ok(["postcondition", "recovery-required"].includes(failure.reason));
    assert.equal(afterParents, `${after} ${base}`);
  } else {
    assert.ok(failure, "failing hook with unrelated mutation must not produce success");
    assert.equal(failure.name, "GitCommitError");
    assert.equal(failure.reason, "recovery-required");
    assert.equal(after, base);
  }
  console.log(`RAW_UNRELATED_MUTATION: mode=${shouldSucceed ? "success-hook" : "rejecting-hook"} marker=present error_reason=${failure?.reason ?? "none"} HEAD=${after} parents=${afterParents} index_changed=true worktree_changed=true`);
  console.log(`SANITY_VERDICT: MATCH (${shouldSucceed ? "successful hook mutation was reported as a postcondition/recovery failure" : "rejecting hook mutation was preserved as recovery-required"}; no broad restore observed)`);
  assert.equal(result === undefined, true, "unrelated hook mutation was reported as success");
}

async function selectedMutationCase(config, guard) {
  const root = path.join(fixtureRoot, "selected-mutation");
  await initRepo(root, "TASK-004 Selected Mutation");
  await writeFile(path.join(root, "selected.txt"), "selected base\n");
  const base = commitAll(root, "selected mutation base");
  const workspace = await workspaceFor(root, "ws_selected_mutation");
  const marker = path.join(fixtureRoot, "selected-mutated");
  await writeHook(root, "pre-commit", `printf 'selected hook mutation\\n' > 'selected.txt'\nprintf 'seen\\n' > '${marker}'`);
  await writeFile(path.join(root, "selected.txt"), "selected current\n");
  const beforeWorktree = await worktreeBytes(root, "selected.txt");
  const operation = gitCommit(config, guard, workspace, request(workspace, ["selected.txt"], base, "selected mutation"));
  let result;
  let failure;
  try {
    result = await operation;
  } catch (error) {
    failure = error;
  }
  const after = gitTrimmed(root, ["rev-parse", "HEAD"]);
  const afterParents = parentLine(root, after);
  const afterWorktree = await worktreeBytes(root, "selected.txt");
  const committedBytes = mustGit(root, ["show", `${after}:selected.txt`]);
  assert.equal(await exists(marker), true);
  assert.deepEqual(afterWorktree, Buffer.from("selected hook mutation\n"));
  assert.deepEqual(committedBytes, beforeWorktree);
  // The hook changed the selected worktree after the locked preflight. A
  // success result cannot honestly claim the post-hook selected state was
  // committed, so the operation must surface a bounded state conflict.
  assert.ok(failure, "selected-path hook mutation was reported as success");
  assert.equal(failure.name, "GitCommitError");
  assert.ok(["postcondition", "recovery-required"].includes(failure.reason));
  console.log(`RAW_SELECTED_MUTATION: marker=present error_reason=${failure.reason} HEAD=${after} parents=${afterParents} worktree_bytes=${afterWorktree.length} committed_bytes=${committedBytes.length}`);
  console.log("SANITY_VERDICT: MATCH (hook changed selected worktree; committed pre-hook bytes remained independently observable and success was not reported)");
  assert.equal(result === undefined, true, "selected-path hook mutation was reported as success");
}

const { PathGuard } = await import("../dist/guard.js");
const { gitCommit } = await import("../dist/gitCommit.js");
const config = { maxGitTimeoutMs: 10_000, maxOutputBytes: 120_000 };
const guard = new PathGuard({ blockedGlobs: [".git", ".git/**"] });

try {
  const baseRoot = path.join(fixtureRoot, "baseline");
  await initRepo(baseRoot, "TASK-004 Baseline");
  await writeFile(path.join(baseRoot, "base.txt"), "base\n");
  const base = commitAll(baseRoot, "baseline");
  assert.equal(gitTrimmed(baseRoot, ["rev-parse", "HEAD"]), base);
  console.log(`RAW_OBSERVATION: real disposable task004 baseline attached branch=${branchRef(baseRoot)} HEAD=${base} parents=${parentLine(baseRoot)}`);
  console.log("SANITY_VERDICT: MATCH (raw baseline is a real attached non-bare repository with one existing commit)");

  const cases = [
    ["race-pre-commit", () => raceCase({ label: "race-pre-commit", hookName: "pre-commit" })],
    ["race-commit-msg", () => raceCase({ label: "race-commit-msg", hookName: "commit-msg" })],
    ["hook-success", () => successfulHookCase(config, guard)],
    ["hook-failing-pre", () => failingPreCommitCase(config, guard)],
    ["prepare-commit-msg", () => prepareCommitMessageCase(config, guard)],
    ["hook-failing-msg", () => failingCommitMessageCase(config, guard)],
    ["empty-identity", () => missingIdentityCase(config, guard)],
    ["signing-failure", () => signingFailureCase(config, guard)],
    ["plain-untracked-failure", () => plainUntrackedFailureCase(config, guard)],
    ["intent-replaced", () => intentReplacementCase(config, guard)],
    ["unrelated-mutation-reject", () => unrelatedMutationCase(config, guard, false)],
    ["unrelated-mutation-success", () => unrelatedMutationCase(config, guard, true)],
    ["selected-mutation", () => selectedMutationCase(config, guard)]
  ];
  const failures = [];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (error) {
      failures.push({ name, error });
      console.error(`CASE_FAILURE: ${name} ${error?.name ?? typeof error}: ${error?.message ?? error}`);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `TASK-004 focused smoke failures: ${failures.map(({ name }) => name).join(", ")}`
    );
  }
  console.log("PASS TASK-004 focused real-local hook/policy/failure-restoration matrix");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
