import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import { GitExecutionError, runGitReadOnly } from "../dist/gitOps.js";
import {
  GitHistoryOperationError,
  gitLogStructured,
  gitMergeBase,
  gitResolveRef,
  gitShowCommit
} from "../dist/gitHistoryOps.js";
import { HistoricalBlobError, readAtRef } from "../dist/gitHistoricalBlob.js";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-review-operations-"));
const repoRoot = path.join(fixtureRoot, "review-repo");
const subrepoRoot = path.join(fixtureRoot, "subrepo");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

function directGitAt(root, args, options = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true"
  };
  // Raw fixture observations must not inherit the review runner's routing
  // controls. The compiled route gets its own controlled environment below.
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_NO_LAZY_FETCH;
  delete env.GIT_CONFIG;
  const result = spawnSync(realGit, args, {
    cwd: root,
    env,
    input: options.input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGitAt(root, args, options = {}) {
  const result = directGitAt(root, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(
      `fixture git failed: ${args.join(" ")} status=${result.status} error=${result.error?.message ?? ""} stderr=${result.stderr.toString("utf8")}`
    );
  }
  return result;
}

function mustGit(args, options = {}) {
  return mustGitAt(repoRoot, args, options);
}

function gitTextAt(root, args) {
  return mustGitAt(root, args).stdout.toString("utf8").trim();
}

function gitText(args) {
  return gitTextAt(repoRoot, args);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function commitTree(root, tree, parents, message) {
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  return mustGitAt(root, args, { input: Buffer.from(message, "utf8") }).stdout.toString("ascii").trim();
}

function commitWorkingTree(subject, body = "") {
  mustGit(["add", "-A"]);
  const message = body ? `${subject}\n\n${body}` : subject;
  mustGit(["commit", "--quiet", "-m", message]);
  return gitText(["rev-parse", "HEAD"]);
}

function parseTreeListing(bytes) {
  const entries = new Map();
  for (const record of bytes.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    assert.ok(tab > 0, `malformed direct tree record: ${record}`);
    const [mode, type, oid, sizeText] = record.slice(0, tab).trim().split(/\s+/u);
    assert.ok(mode && type && oid && sizeText !== undefined, `malformed direct tree metadata: ${record}`);
    entries.set(record.slice(tab + 1), { mode, type, oid, size: sizeText === "-" ? undefined : Number(sizeText) });
  }
  return entries;
}

function treeEntries(sha, pathspec = undefined) {
  const args = ["ls-tree", "-r", "-z", "-l", sha];
  if (pathspec === undefined) args.push("--");
  else args.push("--", pathspec);
  return parseTreeListing(mustGit(args).stdout);
}

function oneTreeEntry(sha, pathspec) {
  const entries = treeEntries(sha, pathspec);
  assert.equal(entries.size, 1, `expected one direct tree entry for ${pathspec}, got ${entries.size}`);
  return [...entries.values()][0];
}

function directCommit(sha) {
  const raw = mustGit(["cat-file", "commit", sha]).stdout;
  const delimiter = raw.indexOf(Buffer.from("\n\n", "utf8"));
  assert.ok(delimiter >= 0, `direct commit ${sha} has no message delimiter`);
  const headers = raw.subarray(0, delimiter).toString("utf8").split("\n");
  const treeSha = headers.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  assert.ok(treeSha);
  const messageBytes = raw.subarray(delimiter + 2);
  const decoded = messageBytes.toString("utf8");
  const newline = decoded.indexOf("\n");
  const subject = newline < 0 ? decoded.replace(/\r$/u, "") : decoded.slice(0, newline).replace(/\r$/u, "");
  let body = newline < 0 ? "" : decoded.slice(newline + 1);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return {
    raw,
    treeSha,
    parents,
    subject,
    body,
    messageBytes: messageBytes.byteLength,
    authorName: gitText(["show", "-s", "--format=%an", sha]),
    authoredAt: gitText(["show", "-s", "--format=%aI", sha]),
    committerName: gitText(["show", "-s", "--format=%cn", sha]),
    committedAt: gitText(["show", "-s", "--format=%cI", sha])
  };
}

function directLogIds(sha, maxCount) {
  return gitText(["rev-list", `--max-count=${maxCount}`, sha]).split("\n").filter(Boolean);
}

function directParents(sha) {
  const parts = gitText(["rev-list", "--parents", "-n", "1", sha]).split(" ");
  return parts.slice(1);
}

function directEntryBlob(entry) {
  return mustGit(["cat-file", "blob", entry.oid]).stdout;
}

function numberLines(raw, startLine = 1) {
  const lines = raw.toString("utf8").replace(/\r\n/gu, "\n").split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n");
}

function processSnapshotOn8787() {
  const result = spawnSync("ss", ["-ltnp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return "unavailable";
  return result.stdout.split("\n").filter((line) => /:8787(?:\s|$)/u.test(line)).join("\n");
}

async function pathSnapshot(root, relativePath) {
  const absolute = path.join(root, relativePath);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(absolute) };
    if (info.isFile()) {
      const bytes = await readFile(absolute);
      return { kind: "file", bytes: bytes.toString("base64"), length: bytes.byteLength, sha256: sha256(bytes) };
    }
    return { kind: info.isDirectory() ? "directory" : "other", mode: info.mode };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

async function repositorySnapshot(root) {
  const tracked = mustGitAt(root, ["ls-files", "-z"]).stdout.toString("utf8").split("\0").filter(Boolean);
  const trackedState = {};
  for (const relativePath of tracked) trackedState[relativePath] = await pathSnapshot(root, relativePath);
  return {
    head: mustGitAt(root, ["rev-parse", "--verify", "HEAD"]).stdout,
    symbolicBranch: mustGitAt(root, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout,
    refs: mustGitAt(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]).stdout,
    reflogs: mustGitAt(root, ["reflog", "show", "--all", "--format=%H%x00%gD%x00%gs%x00"]).stdout,
    index: mustGitAt(root, ["ls-files", "--stage", "-z"]).stdout,
    staged: mustGitAt(root, ["diff", "--cached", "--binary", "--no-ext-diff"]).stdout,
    unstaged: mustGitAt(root, ["diff", "--binary", "--no-ext-diff"]).stdout,
    untracked: mustGitAt(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout,
    status: mustGitAt(root, ["status", "--porcelain=v1", "--branch"]).stdout,
    localConfig: mustGitAt(root, ["config", "--local", "--null", "--list"]).stdout,
    remotes: mustGitAt(root, ["remote", "-v"]).stdout,
    trackedState
  };
}

function assertJsonSafe(value, label) {
  const seen = new WeakSet();
  const walk = (item) => {
    if (Buffer.isBuffer(item)) assert.fail(`${label} contains Buffer`);
    if (!item || typeof item !== "object") return;
    if (seen.has(item)) assert.fail(`${label} is cyclic`);
    seen.add(item);
    if (Array.isArray(item)) for (const child of item) walk(child);
    else for (const child of Object.values(item)) walk(child);
  };
  walk(value);
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string", `${label} did not serialize`);
  assert.deepEqual(JSON.parse(serialized), JSON.parse(serialized), `${label} was not JSON round-trippable`);
}

async function expectFailure(label, operation, expectedError, reason, hostileLiterals = [], options = {}) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof expectedError, `${label}: got ${error?.constructor?.name ?? typeof error}`);
    if (reason !== undefined) assert.equal(error.reason, reason, `${label}: wrong typed reason`);
    assertJsonSafe(error.toJSON ? error.toJSON() : error, `${label} error`);
    const serialized = JSON.stringify(error);
    for (const literal of hostileLiterals) assert.equal(serialized.includes(literal), false, `${label}: leaked ${literal}`);
    if (!options.allowResult) assert.equal("result" in error, false, `${label}: retained raw execution result`);
    assert.equal("stdout" in error, false, `${label}: retained raw stdout`);
    assert.equal("stderr" in error, false, `${label}: retained raw stderr`);
    assert.equal("path" in error, false, `${label}: retained raw path`);
    assert.equal("ref" in error, false, `${label}: retained raw ref`);
    assert.ok(error.message.length < 180, `${label}: unbounded error message`);
    console.log(`RAW_OBSERVATION: ${label} returned bounded typed error reason=${reason ?? "execution"}`);
    return true;
  });
}

const production8787Before = processSnapshotOn8787();

try {
  await mkdir(repoRoot, { recursive: true });
  await mkdir(subrepoRoot, { recursive: true });
  mustGit(["init", "--quiet"]);
  mustGit(["config", "user.name", "Integrated Review Smoke"]);
  mustGit(["config", "user.email", "integrated-review-smoke@example.test"]);
  mustGit(["config", "core.logAllRefUpdates", "true"]);
  mustGit(["config", "remote.origin.url", "https://hostile.invalid/reviewer-secret"]);

  mustGitAt(subrepoRoot, ["init", "--quiet"]);
  mustGitAt(subrepoRoot, ["config", "user.name", "Integrated Review Subrepo"]);
  mustGitAt(subrepoRoot, ["config", "user.email", "integrated-review-subrepo@example.test"]);
  await writeFile(path.join(subrepoRoot, "sub.txt"), "subrepo object\n", "utf8");
  mustGitAt(subrepoRoot, ["add", "sub.txt"]);
  mustGitAt(subrepoRoot, ["commit", "--quiet", "-m", "subrepo root"]);
  const subrepoSha = gitTextAt(subrepoRoot, ["rev-parse", "HEAD"]);

  const deletedText = Buffer.from("deleted historical π content\n", "utf8");
  const renamedText = Buffer.from("renamed historical old content\n", "utf8");
  const unicodeText = Buffer.from("Unicode π and spaces\n", "utf8");
  const privateRaw = Buffer.from([
    "const before = true;",
    "-----BEGIN PRIVATE KEY-----",
    "PRIVATE_SOURCE_SECRET_7X9",
    "-----END PRIVATE KEY-----",
    "const after = true;",
    ""
  ].join("\n"), "utf8");
  const secretTarget = Buffer.from("SECRET_SYMLINK_TARGET_7X9\n", "utf8");
  const binaryBytes = Buffer.from([0x42, 0x49, 0x4e, 0x00, 0xff, 0x00]);
  const oversizedBytes = Buffer.from("O".repeat(4_001), "utf8");
  const rootSubject = "root review subject";
  const rootBody = "ROOT_MESSAGE_SECRET_7X9\nroot body exact\n";
  const mergeSubject = "merge review subject";
  const mergeBody = "merge body exact\n";
  const oldDeletedPath = "deleted old π.txt";
  const oldRenamedPath = "old name.txt";
  const currentRenamedPath = "renamed old.txt";
  const unicodePath = "unicode space π.txt";
  const leadingPath = "-leading.txt";
  const privatePath = "private.txt";
  const symlinkPath = "historical-link";
  const secretTargetPath = "secret-target.txt";

  await writeFile(path.join(repoRoot, oldDeletedPath), deletedText);
  await writeFile(path.join(repoRoot, oldRenamedPath), renamedText);
  await writeFile(path.join(repoRoot, unicodePath), unicodeText);
  await writeFile(path.join(repoRoot, leadingPath), "leading dash historical\n", "utf8");
  await writeFile(path.join(repoRoot, privatePath), privateRaw);
  await writeFile(path.join(repoRoot, secretTargetPath), secretTarget);
  await symlink(secretTargetPath, path.join(repoRoot, symlinkPath));
  await writeFile(path.join(repoRoot, "binary.bin"), binaryBytes);
  await writeFile(path.join(repoRoot, "oversized.txt"), oversizedBytes);
  await mkdir(path.join(repoRoot, "directory"), { recursive: true });
  await writeFile(path.join(repoRoot, "directory", "nested.txt"), "nested historical\n", "utf8");
  await writeFile(path.join(repoRoot, ".env"), "ENV_SECRET_7X9=do-not-return\n", "utf8");
  mustGit(["add", "-A"]);
  mustGit(["update-index", "--add", "--cacheinfo", `160000,${subrepoSha},vendor/subrepo`]);
  mustGit(["commit", "--quiet", "-m", rootSubject, "-m", rootBody]);
  const rootSha = gitText(["rev-parse", "HEAD"]);
  mustGit(["tag", "root-lightweight", rootSha]);
  mustGit(["tag", "--annotate", "root-annotated", "--message", "annotated root", rootSha]);

  mustGit(["rm", "--quiet", "--", oldDeletedPath]);
  mustGit(["mv", "--", oldRenamedPath, currentRenamedPath]);
  await writeFile(path.join(repoRoot, "linear.txt"), "linear history\n", "utf8");
  const linearSha = commitWorkingTree("linear review subject", "linear body\n");
  mustGit(["branch", "linear", linearSha]);
  mustGit(["branch", "moving", rootSha]);

  mustGit(["checkout", "-b", "side"]);
  await writeFile(path.join(repoRoot, "side.txt"), "divergent side\n", "utf8");
  const sideSha = commitWorkingTree("side divergent subject", "side body\n");
  mustGit(["branch", "side-tip", sideSha]);
  mustGit(["checkout", "-b", "main", linearSha]);
  await writeFile(path.join(repoRoot, "main.txt"), "divergent main\n", "utf8");
  const mainSha = commitWorkingTree("main divergent subject", "main body\n");
  mustGit(["branch", "main-tip", mainSha]);
  mustGit(["merge", "--no-ff", "side", "-m", `${mergeSubject}\n\n${mergeBody}`]);
  const mergeSha = gitText(["rev-parse", "HEAD"]);
  mustGit(["branch", "merge-tip", mergeSha]);

  // A criss-cross pair proves that the operation retains every best base.
  const linearTree = gitText(["rev-parse", `${linearSha}^{tree}`]);
  const crissA = commitTree(repoRoot, linearTree, [linearSha], "criss A\n");
  const crissB = commitTree(repoRoot, linearTree, [linearSha], "criss B\n");
  const crissLeft = commitTree(repoRoot, linearTree, [crissA, crissB], "criss left\n");
  const crissRight = commitTree(repoRoot, linearTree, [crissB, crissA], "criss right\n");
  mustGit(["update-ref", "refs/heads/criss-left", crissLeft]);
  mustGit(["update-ref", "refs/heads/criss-right", crissRight]);

  // A large message is a fixture object only; it tests bounded preview while
  // preserving the exact advertised raw message byte count.
  const hugeMessage = `huge review subject\n\n${"H".repeat(7_000)}`;
  const hugeSha = commitTree(repoRoot, gitText(["rev-parse", `${mergeSha}^{tree}`]), [mergeSha], hugeMessage);
  mustGit(["update-ref", "refs/heads/huge-message", hugeSha]);

  // Hostile encoding gives the operation layer a real Git message/stderr
  // failure while its typed error must remain constant and bounded.
  const mergeTree = gitText(["rev-parse", `${mergeSha}^{tree}`]);
  const hostileEncodingRaw = Buffer.from(
    `tree ${mergeTree}\nauthor Integrated Review Smoke <integrated-review-smoke@example.test> 0 +0000\ncommitter Integrated Review Smoke <integrated-review-smoke@example.test> 0 +0000\nencoding x-integrated-hostile-SECRET\n\nhostile encoding subject\n`,
    "utf8"
  );
  const hostileEncodingSha = mustGit(["hash-object", "-t", "commit", "-w", "--stdin"], { input: hostileEncodingRaw }).stdout.toString("ascii").trim();
  mustGit(["update-ref", "refs/heads/hostile-encoding", hostileEncodingSha]);

  // PASS 1 — direct raw Git observations. These values are the independent
  // target evidence and expected-result authority for all later comparisons.
  const rootCommit = directCommit(rootSha);
  const mergeCommit = directCommit(mergeSha);
  const hugeCommit = directCommit(hugeSha);
  const rootEntries = treeEntries(rootSha);
  const mergeEntries = treeEntries(mergeSha);
  const deletedEntry = rootEntries.get(oldDeletedPath);
  const oldRenamedEntry = rootEntries.get(oldRenamedPath);
  const currentRenamedEntry = mergeEntries.get(currentRenamedPath);
  const unicodeEntry = rootEntries.get(unicodePath);
  const leadingEntry = rootEntries.get(leadingPath);
  const privateEntry = rootEntries.get(privatePath);
  const symlinkEntry = rootEntries.get(symlinkPath);
  const binaryEntry = rootEntries.get("binary.bin");
  const oversizedEntry = rootEntries.get("oversized.txt");
  const gitlinkEntry = rootEntries.get("vendor/subrepo");
  assert.ok(deletedEntry && oldRenamedEntry && currentRenamedEntry && unicodeEntry && leadingEntry && privateEntry && symlinkEntry && binaryEntry && oversizedEntry && gitlinkEntry);
  assert.equal(deletedEntry.mode, "100644");
  assert.equal(oldRenamedEntry.mode, "100644");
  assert.equal(currentRenamedEntry.mode, "100644");
  assert.equal(symlinkEntry.mode, "120000");
  assert.equal(symlinkEntry.type, "blob");
  assert.equal(gitlinkEntry.mode, "160000");
  assert.equal(gitlinkEntry.type, "commit");
  assert.equal(rootEntries.has(oldDeletedPath), true);
  assert.equal(rootEntries.has(oldRenamedPath), true);
  assert.equal(mergeEntries.has(oldDeletedPath), false);
  assert.equal(mergeEntries.has(oldRenamedPath), false);
  assert.equal(mergeEntries.has(currentRenamedPath), true);
  assert.deepEqual(directEntryBlob(deletedEntry), deletedText);
  assert.deepEqual(directEntryBlob(oldRenamedEntry), renamedText);
  assert.deepEqual(directEntryBlob(symlinkEntry), Buffer.from(secretTargetPath, "utf8"));
  assert.deepEqual(directEntryBlob(binaryEntry), binaryBytes);
  assert.deepEqual(directEntryBlob(oversizedEntry), oversizedBytes);
  assert.equal(directEntryBlob(privateEntry).includes(Buffer.from("PRIVATE_SOURCE_SECRET_7X9")), true);
  assert.equal(oversizedEntry.size, 4_001);
  const directBases = gitText(["merge-base", "--all", "main-tip", "side-tip"]).split("\n").filter(Boolean);
  const directCrissBases = gitText(["merge-base", "--all", "criss-left", "criss-right"]).split("\n").filter(Boolean).sort();
  const directRootLogIds = directLogIds(rootSha, 2);
  const directHeadLogIds = directLogIds(mergeSha, 2);
  const directLinearAncestor = mustGit(["merge-base", "--is-ancestor", linearSha, mergeSha]);
  assert.equal(directLinearAncestor.status, 0);
  assert.deepEqual(directBases, [linearSha]);
  assert.deepEqual(directCrissBases, [crissA, crissB].sort());
  assert.equal(directRootLogIds[0], rootSha);
  assert.equal(directHeadLogIds[0], mergeSha);
  assert.equal(rootCommit.parents.length, 0);
  assert.equal(mergeCommit.parents.length, 2);
  assert.equal(rootCommit.body, rootBody);
  assert.equal(mergeCommit.subject, mergeSubject);
  assert.equal(mergeCommit.body, mergeBody);
  console.log("TARGET_EVIDENCE: disposable real Git repository and local object database; no production route");
  console.log(`RAW_OBSERVATION: root=${rootSha}, linear=${linearSha}, side=${sideSha}, main=${mainSha}, merge=${mergeSha}; old deleted/renamed paths are only in the root tree`);
  console.log(`RAW_OBSERVATION: root parents=${JSON.stringify(rootCommit.parents)}, merge parents=${JSON.stringify(mergeCommit.parents)}, unique bases=${JSON.stringify(directBases)}, criss-cross bases=${JSON.stringify(directCrissBases)}`);
  console.log(`RAW_OBSERVATION: tree modes/types/sizes deleted=${deletedEntry.mode}/${deletedEntry.type}/${deletedEntry.size}, symlink=${symlinkEntry.mode}/${symlinkEntry.type}/${symlinkEntry.size}, gitlink=${gitlinkEntry.mode}/${gitlinkEntry.type}/${gitlinkEntry.size}, oversized=${oversizedEntry.size}; raw blob bytes verified`);
  console.log(`RAW_OBSERVATION: root messageBytes=${rootCommit.messageBytes}, merge messageBytes=${mergeCommit.messageBytes}, huge messageBytes=${hugeCommit.messageBytes}; raw source contains private marker while symlink blob is target text only`);
  console.log("SANITY_VERDICT: MATCH — direct Git facts establish the accepted root/linear/divergent/merge graph, historical paths, entry predicates, raw bytes, and bounded-message fixture before compiled interpretation");
  console.log("PREDICATE: TRUE — old paths exist only in root tree; symlink mode 120000/type blob; gitlink mode 160000/type commit; oversized blob advertises 4001 bytes");

  const baseConfig = loadConfig(["--root", repoRoot, "--allow-root", repoRoot, "--bash", "off", "--write", "off", "--tool-mode", "full"]);
  const config = { ...baseConfig, maxGitTimeoutMs: 30_000, maxOutputBytes: 4_000, maxReadBytes: 4_000 };
  const guard = new PathGuard(config);
  const workspace = { id: "integrated-review-operations", root: repoRoot, openedAt: new Date().toISOString() };

  // Moving-ref setup is completed before the immutable before/after window:
  // the compiled operation resolves the old branch identity, then fixture
  // construction moves that branch. All calls after `before` use the captured
  // full SHA and are the only activity between snapshots.
  const movingBeforeSha = gitText(["rev-parse", "moving"]);
  const movingResolved = await gitResolveRef(config, workspace, "moving");
  assert.equal(movingResolved.fullSha, movingBeforeSha);
  mustGit(["branch", "--force", "moving", mergeSha]);
  const movingAfterSha = gitText(["rev-parse", "moving"]);
  assert.equal(movingAfterSha, mergeSha);
  assert.notEqual(movingAfterSha, movingResolved.fullSha);
  assert.deepEqual(mustGit(["show", `${movingResolved.fullSha}:${oldDeletedPath}`]).stdout, deletedText);
  console.log(`RAW_OBSERVATION: moving branch changed from ${movingBeforeSha} to ${movingAfterSha}; captured full SHA still identifies old deleted content`);
  console.log("SANITY_VERDICT: MATCH — branch movement is fixture setup; the captured immutable SHA remains the target identity for downstream calls");

  // Dirty/staged/untracked state and local config/remotes are all fixture
  // setup, captured only after setup is complete.
  await writeFile(path.join(repoRoot, currentRenamedPath), "unstaged current mutation\n", "utf8");
  await writeFile(path.join(repoRoot, "staged.txt"), "staged current content\n", "utf8");
  mustGit(["add", "--", "staged.txt"]);
  await writeFile(path.join(repoRoot, "untracked.txt"), "untracked current content\n", "utf8");
  const before = await repositorySnapshot(repoRoot);

  // Between snapshots: reviewer operations only. Expected results come from
  // the direct observations above, never from these operation classifications.
  const resolvedHead = await gitResolveRef(config, workspace, "HEAD");
  assert.equal(resolvedHead.fullSha, mergeSha);
  assert.equal(resolvedHead.shortSha, mergeSha.slice(0, 12));
  const resolvedAnnotated = await gitResolveRef(config, workspace, "root-annotated");
  assert.equal(resolvedAnnotated.fullSha, rootSha);
  const resolvedCaptured = await gitResolveRef(config, workspace, movingResolved.fullSha);
  assert.equal(resolvedCaptured.fullSha, movingResolved.fullSha);
  for (const result of [resolvedHead, resolvedAnnotated, resolvedCaptured]) assertJsonSafe(result, "resolve result");
  console.log("PASS operation A exact HEAD/tag/full-SHA identity and JSON-safe structured result");

  const divergent = await gitMergeBase(config, workspace, "main-tip", "side-tip");
  assert.deepEqual(divergent.mergeBases, directBases);
  assert.equal(divergent.leftIsAncestor, false);
  assert.equal(divergent.rightIsAncestor, false);
  assert.equal(divergent.unrelated, false);
  assert.equal(divergent.historyComplete, true);
  const criss = await gitMergeBase(config, workspace, "criss-left", "criss-right");
  assert.deepEqual(criss.mergeBases, directCrissBases);
  const ancestor = await gitMergeBase(config, workspace, "linear", "HEAD");
  assert.equal(ancestor.leftIsAncestor, true);
  assert.equal(ancestor.rightIsAncestor, false);
  assert.deepEqual(ancestor.mergeBases, [linearSha]);
  for (const result of [divergent, criss, ancestor]) assertJsonSafe(result, "merge-base result");
  console.log("PASS operation B all best merge bases, divergent ancestry, ancestor booleans, and complete-history truth");

  const boundedLog = await gitLogStructured(config, guard, workspace, { startRef: "HEAD", maxCount: 1 });
  assert.equal(boundedLog.maxCount, 1);
  assert.equal(boundedLog.hasMore, true);
  assert.equal(boundedLog.commits.length, 1);
  assert.equal(boundedLog.commits[0].fullSha, directHeadLogIds[0]);
  assert.deepEqual(boundedLog.commits[0].parents, directParents(mergeSha));
  assert.equal(boundedLog.commits[0].subject, mergeCommit.subject);
  const rootLog = await gitLogStructured(config, guard, workspace, { startRef: rootSha, maxCount: 20 });
  assert.deepEqual(rootLog.commits.map((commit) => commit.fullSha), directRootLogIds.slice(0, 20));
  assert.deepEqual(rootLog.commits[0].parents, []);
  const oldPathLog = await gitLogStructured(config, guard, workspace, { startRef: rootSha, path: `./${oldRenamedPath}`, maxCount: 20 });
  assert.equal(oldPathLog.path, oldRenamedPath);
  assert.deepEqual(oldPathLog.commits.map((commit) => commit.fullSha), [rootSha]);
  const unicodePathLog = await gitLogStructured(config, guard, workspace, { startRef: rootSha, path: unicodePath, maxCount: 20 });
  assert.deepEqual(unicodePathLog.commits.map((commit) => commit.fullSha), [rootSha]);
  const leadingPathLog = await gitLogStructured(config, guard, workspace, { startRef: rootSha, path: leadingPath, maxCount: 20 });
  assert.deepEqual(leadingPathLog.commits.map((commit) => commit.fullSha), [rootSha]);
  for (const result of [boundedLog, rootLog, oldPathLog, unicodePathLog, leadingPathLog]) assertJsonSafe(result, "structured log result");
  console.log("PASS operation C NUL-structured log max_count+1/hasMore, root/merge parents, and literal Unicode/space/leading-dash/old-path filters");

  const shownRoot = await gitShowCommit(config, workspace, rootSha);
  assert.equal(shownRoot.treeSha, rootCommit.treeSha);
  assert.deepEqual(shownRoot.parents, rootCommit.parents);
  assert.equal(shownRoot.isRoot, true);
  assert.equal(shownRoot.isMerge, false);
  assert.equal(shownRoot.authorName, rootCommit.authorName);
  assert.equal(shownRoot.authoredAt, rootCommit.authoredAt);
  assert.equal(shownRoot.committerName, rootCommit.committerName);
  assert.equal(shownRoot.committedAt, rootCommit.committedAt);
  assert.equal(shownRoot.subject, rootCommit.subject);
  assert.equal(shownRoot.body, rootCommit.body);
  assert.equal(shownRoot.messageBytes, rootCommit.messageBytes);
  assert.equal(shownRoot.messageTruncated, false);
  assert.equal(shownRoot.body.includes(rootBody), true);
  const shownMerge = await gitShowCommit(config, workspace, mergeSha);
  assert.equal(shownMerge.treeSha, mergeCommit.treeSha);
  assert.deepEqual(shownMerge.parents, mergeCommit.parents);
  assert.equal(shownMerge.isRoot, false);
  assert.equal(shownMerge.isMerge, true);
  assert.equal(shownMerge.subject, mergeCommit.subject);
  assert.equal(shownMerge.body, mergeCommit.body);
  assert.equal(shownMerge.messageBytes, mergeCommit.messageBytes);
  const shownHuge = await gitShowCommit(config, workspace, hugeSha);
  assert.equal(shownHuge.messageBytes, hugeCommit.messageBytes);
  assert.equal(shownHuge.messageTruncated, true);
  assert.ok(Buffer.byteLength(shownHuge.body, "utf8") <= 2_000);
  for (const result of [shownRoot, shownMerge, shownHuge]) assertJsonSafe(result, "show result");
  console.log(`PASS operation D root/merge metadata and exact internal messages; huge message truncates honestly at messageBytes=${shownHuge.messageBytes}`);

  const deleted = await readAtRef(config, guard, workspace, { ref: rootSha, path: oldDeletedPath });
  assert.equal(deleted.commitSha, rootSha);
  assert.equal(deleted.path, oldDeletedPath);
  assert.equal(deleted.gitMode, deletedEntry.mode);
  assert.equal(deleted.entryKind, "file");
  assert.equal(deleted.blobSha, deletedEntry.oid);
  assert.equal(deleted.text, numberLines(deletedText));
  assert.equal(deleted.bytes, deletedText.byteLength);
  assert.equal(deleted.sha256, sha256(deletedText));
  assert.equal(deleted.truncated, false);
  const renamed = await readAtRef(config, guard, workspace, { ref: rootSha, path: oldRenamedPath });
  assert.equal(renamed.text, numberLines(renamedText));
  const unicode = await readAtRef(config, guard, workspace, { ref: rootSha, path: `./${unicodePath}` });
  assert.equal(unicode.path, unicodePath);
  assert.equal(unicode.text, numberLines(unicodeText));
  const leading = await readAtRef(config, guard, workspace, { ref: rootSha, path: leadingPath });
  assert.equal(leading.text, numberLines(Buffer.from("leading dash historical\n", "utf8")));
  const link = await readAtRef(config, guard, workspace, { ref: rootSha, path: symlinkPath });
  assert.equal(link.gitMode, "120000");
  assert.equal(link.entryKind, "symlink");
  assert.equal(link.blobSha, symlinkEntry.oid);
  assert.equal(link.text, numberLines(Buffer.from(secretTargetPath, "utf8")));
  assert.equal(link.text.includes("SECRET_SYMLINK_TARGET_7X9"), false);
  const privateBody = await readAtRef(config, guard, workspace, { ref: rootSha, path: privatePath, startLine: 3, endLine: 3 });
  assert.equal(privateBody.text, "3 | [REDACTED_PRIVATE_KEY]");
  assert.equal(privateBody.totalLines, 6);
  assert.equal(privateBody.bytes, privateRaw.byteLength);
  assert.equal(privateBody.sha256, sha256(privateRaw));
  assert.equal(privateBody.text.includes("PRIVATE_SOURCE_SECRET_7X9"), false);
  for (const result of [deleted, renamed, unicode, leading, link, privateBody]) assertJsonSafe(result, "historical blob result");
  console.log("PASS operation E deleted/renamed/Unicode/space/leading-dash historical files, symlink raw target text, SHA/size metadata, and source redaction");

  // Captured full SHA downstream race proof: branch now points at merge, while
  // log/show/blob continue to read the old root object and old-tree content.
  const capturedLog = await gitLogStructured(config, guard, workspace, { startRef: movingResolved.fullSha, maxCount: 1 });
  const capturedShow = await gitShowCommit(config, workspace, movingResolved.fullSha);
  const capturedBlob = await readAtRef(config, guard, workspace, { ref: movingResolved.fullSha, path: oldDeletedPath });
  assert.equal(capturedLog.start.fullSha, movingResolved.fullSha);
  assert.equal(capturedLog.commits[0].fullSha, rootSha);
  assert.equal(capturedShow.fullSha, rootSha);
  assert.equal(capturedShow.subject, rootCommit.subject);
  assert.equal(capturedBlob.commitSha, rootSha);
  assert.equal(capturedBlob.text, numberLines(deletedText));
  for (const result of [capturedLog, capturedShow, capturedBlob]) assertJsonSafe(result, "captured full-SHA race result");
  console.log("PASS moving-ref integration: captured full SHA preserved original log/show/blob identity after branch moved elsewhere");

  await expectFailure("missing hostile ref", () => gitResolveRef(config, workspace, "missing-ref-HOSTILE_SECRET_7X9"), Error, "unresolvable", ["missing-ref-HOSTILE_SECRET_7X9"]);
  await expectFailure("invalid hostile historical path", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "../HOSTILE_PATH_SECRET_7X9" }), HistoricalBlobError, "invalid-path", ["HOSTILE_PATH_SECRET_7X9"]);
  await expectFailure("missing historical path", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "missing-HOSTILE_PATH_SECRET_7X9.txt" }), HistoricalBlobError, "missing-path", ["missing-HOSTILE_PATH_SECRET_7X9.txt"]);
  await expectFailure("blocked .env path", () => readAtRef(config, guard, workspace, { ref: rootSha, path: ".env" }), HistoricalBlobError, "blocked-path", ["ENV_SECRET_7X9"]);
  await expectFailure("binary historical blob", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "binary.bin" }), HistoricalBlobError, "binary", ["BIN"]);
  await expectFailure("oversized historical blob", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "oversized.txt" }), HistoricalBlobError, "oversized", ["OOOOOOOOOOOO"]);
  await expectFailure("directory historical entry", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "directory" }), HistoricalBlobError, "directory", []);
  await expectFailure("gitlink historical entry", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "vendor/subrepo" }), HistoricalBlobError, "gitlink", []);
  await expectFailure("hostile commit encoding", () => gitShowCommit(config, workspace, hostileEncodingSha), GitHistoryOperationError, "unsupported-encoding", ["x-integrated-hostile-SECRET", "hostile encoding subject"]);
  await expectFailure("runner hostile stderr/ref", () => runGitReadOnly(config, workspace, ["rev-parse", "--verify", "missing-runner-HOSTILE_SECRET_7X9"]), GitExecutionError, undefined, ["missing-runner-HOSTILE_SECRET_7X9"], { allowResult: true });
  console.log("PASS typed-error safety: constant/bounded errors contain no hostile refs, paths, messages, stderr, or raw buffers");

  const after = await repositorySnapshot(repoRoot);
  assert.deepEqual(after, before, "reviewer operations changed repository state");
  console.log("RAW_OBSERVATION: HEAD/symbolic branch, refs/reflogs, index, staged/unstaged/untracked content, tracked files/symlink target, local config, and remotes matched before/after snapshots");
  console.log("SANITY_VERDICT: MATCH — only compiled reviewer operations ran between full snapshots; repository state remained physically identical");
  assert.equal(processSnapshotOn8787(), production8787Before, "production 8787 listener snapshot changed during integrated smoke");
  console.log("PASS no production 127.0.0.1:8787 action; listener/PID observation unchanged");
  console.log("SUPPORTING_ORACLE: final matrix must execute git-review-runner:smoke for fresh runner/promisor no-fetch proof; this integrated suite does not infer network behavior from command names");
  console.log("GIT_REVIEW_OPERATIONS_SMOKE: PASS (AP-007/AP-008 target evidence from one real local Git history)");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
