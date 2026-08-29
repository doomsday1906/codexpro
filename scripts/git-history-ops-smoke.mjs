import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GitHistoryOperationError,
  gitLogStructured,
  gitMergeBase,
  gitResolveRef,
  gitShowCommit
} from "../dist/gitHistoryOps.js";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-history-ops-"));
const repoRoot = path.join(fixtureRoot, "repo");
const shallowRoot = path.join(fixtureRoot, "shallow");

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
  });
}

function gitText(cwd, args) {
  return String(git(cwd, args)).trim();
}

function gitCommit(cwd, subject, body = "") {
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", subject + (body ? `\n\n${body}` : "")]);
  return gitText(cwd, ["rev-parse", "HEAD"]);
}

function commitTreeSha(cwd, tree, parents, message) {
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  return String(execFileSync("git", args, { cwd, input: message, encoding: "utf8" })).trim();
}

function writeRawCommit(cwd, raw) {
  const object = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd,
    input: raw,
    encoding: null
  });
  return object.toString("ascii").trim();
}

function workspace(root) {
  return { id: "history-smoke", root, openedAt: new Date().toISOString() };
}

const config = {
  maxGitTimeoutMs: 30_000,
  maxOutputBytes: 120_000,
  maxReadBytes: 180_000
};
const guard = { isBlockedRelativePath: () => false };

try {
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, ["init", "--quiet"]);
  git(repoRoot, ["config", "user.name", "History Smoke"]);
  git(repoRoot, ["config", "user.email", "history-smoke@example.test"]);

  await writeFile(path.join(repoRoot, "tracked.txt"), "root\n", "utf8");
  await writeFile(path.join(repoRoot, "-leading.txt"), "dash\n", "utf8");
  await writeFile(path.join(repoRoot, "unicode space.txt"), "unicode\n", "utf8");
  const rootSha = gitCommit(repoRoot, "root subject", "root body\n");
  await writeFile(path.join(repoRoot, "tracked.txt"), "linear\n", "utf8");
  const linearSha = gitCommit(repoRoot, "linear subject", "line body\n\n");
  const headSha = linearSha;
  const treeSha = gitText(repoRoot, ["rev-parse", `${rootSha}^{tree}`]);
  const mergeOneSha = commitTreeSha(repoRoot, treeSha, [rootSha], "first side\n\nside body\n");
  const mergeTwoSha = commitTreeSha(repoRoot, treeSha, [rootSha], "second side\n\nside body\n");
  const crissCrossLeft = commitTreeSha(repoRoot, treeSha, [mergeOneSha, mergeTwoSha], "criss left\n");
  const crissCrossRight = commitTreeSha(repoRoot, treeSha, [mergeTwoSha, mergeOneSha], "criss right\n");
  git(repoRoot, ["update-ref", "refs/heads/criss-left", crissCrossLeft]);
  git(repoRoot, ["update-ref", "refs/heads/criss-right", crissCrossRight]);

  const otherRoot = path.join(fixtureRoot, "other");
  await mkdir(otherRoot, { recursive: true });
  git(otherRoot, ["init", "--quiet"]);
  git(otherRoot, ["config", "user.name", "Other Root"]);
  git(otherRoot, ["config", "user.email", "other@example.test"]);
  await writeFile(path.join(otherRoot, "other.txt"), "other\n", "utf8");
  const unrelatedSha = gitCommit(otherRoot, "unrelated root");
  // Import a genuinely unrelated root object into the target object database
  // without creating a ref or mutating the target repository's history.
  const unrelatedRaw = git(otherRoot, ["cat-file", "commit", unrelatedSha], { encoding: null });
  const importedUnrelated = writeRawCommit(repoRoot, unrelatedRaw);

  const ws = workspace(repoRoot);
  const resolved = await gitResolveRef(config, ws, "HEAD");
  assert.equal(resolved.fullSha, headSha);
  assert.equal(resolved.shortSha, headSha.slice(0, 12));
  console.log(`RAW_OBSERVATION: real Git resolve returned HEAD ${resolved.fullSha}`);
  console.log("PASS operation A resolves exact full/short identity");

  const linearBases = await gitMergeBase(config, ws, "HEAD", rootSha);
  assert.deepEqual(linearBases.mergeBases, [rootSha]);
  assert.equal(linearBases.leftIsAncestor, false);
  assert.equal(linearBases.rightIsAncestor, true);
  assert.equal(linearBases.unrelated, false);
  assert.equal(linearBases.historyComplete, true);

  const criss = await gitMergeBase(config, ws, "criss-left", "criss-right");
  assert.deepEqual(criss.mergeBases, [mergeOneSha, mergeTwoSha].sort());
  assert.equal(criss.unrelated, false);
  assert.equal(criss.leftIsAncestor, false);
  assert.equal(criss.rightIsAncestor, false);

  const unrelated = await gitMergeBase(config, ws, headSha, importedUnrelated);
  assert.deepEqual(unrelated.mergeBases, []);
  assert.equal(unrelated.unrelated, true);
  git(repoRoot, ["clone", "--quiet", "--depth=1", "--no-single-branch", `file://${repoRoot}`, shallowRoot]);
  const shallowWs = workspace(shallowRoot);
  console.log(`RAW_OBSERVATION: direct Git reports shallow fixture=${gitText(shallowRoot, ["rev-parse", "--is-shallow-repository"])}; both criss-cross tips resolve locally`);
  const shallowBases = await gitMergeBase(config, shallowWs, "origin/criss-left", "origin/criss-right");
  assert.equal(shallowBases.historyComplete, false);
  assert.deepEqual(shallowBases.mergeBases, []);
  assert.equal(shallowBases.unrelated, null);
  assert.equal(shallowBases.leftIsAncestor, null);
  assert.equal(shallowBases.rightIsAncestor, null);
  console.log(`RAW_OBSERVATION: real merge-base returned two criss-cross bases ${criss.mergeBases.join(",")}; unrelated returned empty`);
  console.log("PASS operation B merge-base, ancestry, unrelated, criss-cross, and shallow tri-state truth");

  const log = await gitLogStructured(config, guard, ws, { maxCount: 1 });
  assert.equal(log.commits.length, 1);
  assert.equal(log.hasMore, true);
  assert.deepEqual(log.commits[0].parents, [rootSha]);
  assert.equal(log.commits[0].subject, "linear subject");
  const rootLog = await gitLogStructured(config, guard, ws, { startRef: rootSha, maxCount: 20 });
  assert.deepEqual(rootLog.commits[0].parents, []);
  const mergeLog = await gitLogStructured(config, guard, ws, { startRef: crissCrossLeft, maxCount: 1 });
  assert.deepEqual(mergeLog.commits[0].parents, [mergeOneSha, mergeTwoSha]);
  const pathLog = await gitLogStructured(config, guard, ws, { path: "./unicode space.txt", maxCount: 20 });
  assert.equal(pathLog.path, "unicode space.txt");
  assert.equal(pathLog.commits.length, 1);
  const dashLog = await gitLogStructured(config, guard, ws, { path: "-leading.txt", maxCount: 20 });
  assert.equal(dashLog.commits.length, 1);
  const emptyLog = await gitLogStructured(config, guard, ws, { path: "never-present.txt", maxCount: 20 });
  assert.deepEqual(emptyLog.commits, []);
  console.log(`RAW_OBSERVATION: real NUL log returned ${log.commits.length} record with hasMore=${log.hasMore}; path filters handled space and leading dash`);
  console.log("PASS operation C bounded structured log and literal path routing");

  const shownRoot = await gitShowCommit(config, ws, rootSha);
  assert.equal(shownRoot.isRoot, true);
  assert.equal(shownRoot.isMerge, false);
  assert.deepEqual(shownRoot.parents, []);
  assert.equal(shownRoot.treeSha, treeSha);
  assert.equal(shownRoot.subject, "root subject");
  assert.equal(shownRoot.body, "root body\n");
  assert.equal(shownRoot.messageBytes, Buffer.byteLength("root subject\n\nroot body\n", "utf8"));

  const shownMerge = await gitShowCommit(config, ws, crissCrossLeft);
  assert.equal(shownMerge.isRoot, false);
  assert.equal(shownMerge.isMerge, true);
  assert.deepEqual(shownMerge.parents, [mergeOneSha, mergeTwoSha]);
  console.log(`RAW_OBSERVATION: real show returned root/merge flags ${shownRoot.isRoot}/${shownMerge.isMerge}, exact root messageBytes=${shownRoot.messageBytes}`);
  console.log("PASS operation D fixed metadata, parent arrays, subject/body, and exact message bytes");

  const hostileSubject = "hostile\tTAB";
  const hostileTree = gitText(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  const hostileRaw = `tree ${hostileTree}\nauthor History Smoke <history-smoke@example.test> 0 +0000\ncommitter History Smoke <history-smoke@example.test> 0 +0000\n\n${hostileSubject}\n\nsecret-looking=should-stay-internal\n`;
  const hostileSha = writeRawCommit(repoRoot, hostileRaw);
  git(repoRoot, ["update-ref", "refs/heads/hostile", hostileSha]);
  const hostileLog = await gitLogStructured(config, guard, ws, { startRef: hostileSha, maxCount: 1 });
  assert.equal(hostileLog.commits[0].subject, hostileSubject);
  assert.equal(hostileLog.commits[0].authorName, "History Smoke");

  const signedLikeRaw = `tree ${hostileTree}\nauthor History Smoke <history-smoke@example.test> 0 +0000\ncommitter History Smoke <history-smoke@example.test> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n continuation line\nmergetag object ${rootSha}\n tag v0\n\nSigned-like subject\n\nSigned-like body\n`;
  const signedLikeSha = writeRawCommit(repoRoot, signedLikeRaw);
  git(repoRoot, ["update-ref", "refs/heads/signed-like", signedLikeSha]);
  const signedLike = await gitShowCommit(config, ws, signedLikeSha);
  assert.equal(signedLike.subject, "Signed-like subject");
  assert.equal(signedLike.body, "Signed-like body\n");
  assert.equal(signedLike.messageBytes, Buffer.byteLength("Signed-like subject\n\nSigned-like body\n", "utf8"));
  console.log("PASS hostile subject bytes and signed-like continuation headers stay out of message framing");

  const hugeMessage = "x".repeat(61_000);
  const hugeMessageRaw = `tree ${hostileTree}\nauthor History Smoke <history-smoke@example.test> 0 +0000\ncommitter History Smoke <history-smoke@example.test> 0 +0000\n\nLarge subject\n\n${hugeMessage}`;
  const hugeMessageSha = writeRawCommit(repoRoot, hugeMessageRaw);
  git(repoRoot, ["update-ref", "refs/heads/huge-message", hugeMessageSha]);
  const hugeMessageShown = await gitShowCommit(config, ws, hugeMessageSha);
  assert.equal(hugeMessageShown.messageTruncated, true);
  assert.equal(hugeMessageShown.messageBytes, Buffer.byteLength("Large subject\n\n" + hugeMessage, "utf8"));
  assert.ok(Buffer.byteLength(hugeMessageShown.body, "utf8") <= 60_000);
  const boundedHugeMessageShown = await gitShowCommit({ ...config, maxReadBytes: 8_000, maxOutputBytes: 4_000 }, ws, hugeMessageSha);
  assert.equal(boundedHugeMessageShown.messageTruncated, true);
  assert.equal(boundedHugeMessageShown.messageBytes, hugeMessageShown.messageBytes);
  assert.ok(Buffer.byteLength(boundedHugeMessageShown.body, "utf8") <= 4_000);
  console.log(`PASS >60KB message is bounded without an artificial marker (messageBytes=${hugeMessageShown.messageBytes})`);

  const unsupportedEncodingRaw = `tree ${hostileTree}\nauthor History Smoke <history-smoke@example.test> 0 +0000\ncommitter History Smoke <history-smoke@example.test> 0 +0000\nencoding x-codex-unsupported\n\nencoding subject\n`;
  const unsupportedSha = writeRawCommit(repoRoot, unsupportedEncodingRaw);
  git(repoRoot, ["update-ref", "refs/heads/unsupported-encoding", unsupportedSha]);
  await assert.rejects(
    () => gitShowCommit(config, ws, unsupportedSha),
    (error) => {
      assert.ok(error instanceof GitHistoryOperationError);
      assert.equal(error.reason, "unsupported-encoding");
      assert.equal(JSON.stringify(error).includes("x-codex-unsupported"), false);
      return true;
    }
  );
  console.log("PASS unsupported encoding fails typed with constant safe JSON");

  const oversizedHeaderRaw = `tree ${hostileTree}\nauthor History Smoke <history-smoke@example.test> 0 +0000\ncommitter History Smoke <history-smoke@example.test> 0 +0000\ngpgsig -----BEGIN ${"H".repeat(7_000)}\n continuation\n\nheader subject\n`;
  const oversizedHeaderSha = writeRawCommit(repoRoot, oversizedHeaderRaw);
  git(repoRoot, ["update-ref", "refs/heads/oversized-header", oversizedHeaderSha]);
  await assert.rejects(
    () => gitShowCommit({ ...config, maxReadBytes: 8_000, maxOutputBytes: 4_000 }, ws, oversizedHeaderSha),
    (error) => {
      assert.ok(error instanceof GitHistoryOperationError);
      assert.equal(error.reason, "commit-headers-too-large");
      assert.equal(JSON.stringify(error).includes("H".repeat(32)), false);
      return true;
    }
  );
  console.log("PASS oversized commit headers fail bounded without exposing raw header bytes");

  const beforeHead = gitText(repoRoot, ["rev-parse", "HEAD"]);
  const beforeStatus = git(repoRoot, ["status", "--porcelain=v1", "--branch"]);
  await gitResolveRef(config, ws, "hostile");
  await gitMergeBase(config, ws, "HEAD", rootSha);
  await gitLogStructured(config, guard, ws, { maxCount: 2 });
  await gitShowCommit(config, ws, rootSha);
  assert.equal(gitText(repoRoot, ["rev-parse", "HEAD"]), beforeHead);
  assert.deepEqual(git(repoRoot, ["status", "--porcelain=v1", "--branch"]), beforeStatus);
  console.log("PASS operations leave HEAD/index/worktree status unchanged");

  const sha256Root = path.join(fixtureRoot, "sha256");
  await mkdir(sha256Root, { recursive: true });
  git(sha256Root, ["init", "--quiet", "--object-format=sha256"]);
  git(sha256Root, ["config", "user.name", "SHA256 Smoke"]);
  git(sha256Root, ["config", "user.email", "sha256-smoke@example.test"]);
  await writeFile(path.join(sha256Root, "sha256.txt"), "sha256\n", "utf8");
  const sha256Head = gitCommit(sha256Root, "sha256 subject");
  const sha256Shown = await gitShowCommit(config, workspace(sha256Root), sha256Head);
  assert.equal(sha256Shown.objectFormat, "sha256");
  assert.equal(sha256Shown.fullSha.length, 64);
  assert.equal(sha256Shown.subject, "sha256 subject");
  console.log("PASS SHA-256 operation A/D identity and metadata validation");
  console.log("GIT_HISTORY_OPS_SMOKE: PASS (real local Git producer; no remote/helper/production route)");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
