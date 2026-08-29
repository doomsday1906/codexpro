import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { readPublicTextFile } from "../dist/fsOps.js";
import { HistoricalBlobError, readAtRef } from "../dist/gitHistoricalBlob.js";
import { PathGuard } from "../dist/guard.js";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-historical-blob-"));
const repoRoot = path.join(fixtureRoot, "repo");
const subrepoRoot = path.join(fixtureRoot, "subrepo");
const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const config = {
  maxGitTimeoutMs: 30_000,
  maxOutputBytes: 120_000,
  maxReadBytes: 180_000
};
const guard = {
  isBlockedRelativePath: (relPath) =>
    relPath === ".env" || relPath.endsWith("/.env") || relPath.endsWith(".pem") || relPath.endsWith(".key")
};

function git(cwd, args, options = {}) {
  return execFileSync(realGit, args, {
    cwd,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"]
  });
}

function gitText(cwd, args) {
  return String(git(cwd, args)).trim();
}

function commit(cwd, subject, stage = true) {
  if (stage) git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "--quiet", "-m", subject]);
  return gitText(cwd, ["rev-parse", "HEAD"]);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function expectHistoricalFailure(label, operation, reason) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof HistoricalBlobError, `${label}: expected HistoricalBlobError`);
    assert.equal(error.reason, reason, `${label}: wrong reason`);
    const serialized = JSON.stringify(error);
    assert.equal(serialized.includes("TARGET_SECRET_7X9"), false, `${label}: leaked fixture secret`);
    assert.equal(serialized.includes("PRIVATE_BODY_7X9"), false, `${label}: leaked private body`);
    assert.equal("path" in error, false, `${label}: retained raw path`);
    assert.equal("ref" in error, false, `${label}: retained raw ref`);
    assert.equal("stdout" in error, false, `${label}: retained raw stdout`);
    assert.equal("stderr" in error, false, `${label}: retained raw stderr`);
    assert.equal("body" in error, false, `${label}: retained raw body`);
    assert.equal("cause" in error, false, `${label}: retained cause`);
    return true;
  });
  console.log(`RAW_OBSERVATION: ${label} produced typed reason=${reason} without raw source/ref fields`);
}

function snapshot(cwd) {
  const raw = (args) => Buffer.from(git(cwd, args, { encoding: null }));
  return {
    head: gitText(cwd, ["rev-parse", "HEAD"]),
    branch: gitText(cwd, ["symbolic-ref", "--short", "HEAD"]),
    refs: raw(["for-each-ref", "--format=%(refname)%00%(objectname)%00"]),
    reflogs: raw(["reflog", "show", "--all", "--format=%H%x00%gD%x00%gs%x00"]),
    index: raw(["ls-files", "--stage", "-z"]),
    staged: raw(["diff", "--cached", "--binary", "--no-ext-diff"]),
    unstaged: raw(["diff", "--binary", "--no-ext-diff"]),
    untracked: raw(["ls-files", "--others", "--exclude-standard", "-z"]),
    status: raw(["status", "--porcelain=v1", "--branch"]),
    config: raw(["config", "--local", "--null", "--list"])
  };
}

try {
  await mkdir(repoRoot, { recursive: true });
  await mkdir(subrepoRoot, { recursive: true });
  git(repoRoot, ["init", "--quiet"]);
  git(repoRoot, ["config", "user.name", "Historical Blob Smoke"]);
  git(repoRoot, ["config", "user.email", "historical-blob-smoke@example.test"]);
  git(subrepoRoot, ["init", "--quiet"]);
  git(subrepoRoot, ["config", "user.name", "Historical Blob Subrepo"]);
  git(subrepoRoot, ["config", "user.email", "historical-blob-subrepo@example.test"]);
  await writeFile(path.join(subrepoRoot, "sub.txt"), "subrepo\n", "utf8");
  const subrepoCommit = commit(subrepoRoot, "subrepo root");

  const deletedText = "deleted historical content\n";
  const renamedText = "renamed historical content\n";
  const unicodeText = "Unicode π and spaces\n";
  const privateRaw = [
    "const before = true;",
    "-----BEGIN PRIVATE KEY-----",
    "PRIVATE_BODY_7X9",
    "-----END PRIVATE KEY-----",
    "const after = true;",
    ""
  ].join("\n");
  const largeBytes = Buffer.from("L".repeat(150 * 1024), "utf8");
  const tooLargeBytes = Buffer.from("O".repeat(config.maxReadBytes + 1), "utf8");
  const rangeRaw = Array.from({ length: 12_000 }, (_, index) => `line-${String(index).padStart(5, "0")}`).join("\n") + "\n";

  await writeFile(path.join(repoRoot, "deleted.txt"), deletedText, "utf8");
  await writeFile(path.join(repoRoot, "old-name.txt"), renamedText, "utf8");
  await writeFile(path.join(repoRoot, "unicode space π.txt"), unicodeText, "utf8");
  await writeFile(path.join(repoRoot, "-leading.txt"), "leading dash\n", "utf8");
  await writeFile(path.join(repoRoot, ".hidden.txt"), "hidden historical\n", "utf8");
  await writeFile(path.join(repoRoot, "empty.txt"), "", "utf8");
  await writeFile(path.join(repoRoot, "exec.sh"), "#!/bin/sh\necho executable\n", "utf8");
  await chmod(path.join(repoRoot, "exec.sh"), 0o755);
  await writeFile(path.join(repoRoot, "target-secret.txt"), "TARGET_SECRET_7X9\n", "utf8");
  await writeFile(path.join(repoRoot, "binary.bin"), Buffer.from([0x42, 0x49, 0x00, 0x4e]), null);
  await writeFile(path.join(repoRoot, "large.txt"), largeBytes);
  await writeFile(path.join(repoRoot, "too-large.txt"), tooLargeBytes);
  await writeFile(path.join(repoRoot, "range-budget.txt"), rangeRaw, "utf8");
  await writeFile(path.join(repoRoot, "private.txt"), privateRaw, "utf8");
  await writeFile(path.join(repoRoot, ".env"), "SECRET_ENV=do-not-return\n", "utf8");
  await mkdir(path.join(repoRoot, "dir"), { recursive: true });
  await writeFile(path.join(repoRoot, "dir", "nested.txt"), "nested\n", "utf8");
  await writeFile(path.join(repoRoot, "link-target.txt"), "link target is not secret\n", "utf8");
  await symlink("target-secret.txt", path.join(repoRoot, "historical-link"));

  // The index cache entry is a real gitlink in the produced commit tree.
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["update-index", "--add", "--cacheinfo", `160000,${subrepoCommit},gitlink-entry`]);
  const rootSha = commit(repoRoot, "historical blob root", false);
  git(repoRoot, ["rm", "--quiet", "deleted.txt"]);
  git(repoRoot, ["mv", "old-name.txt", "renamed.txt"]);
  const afterSha = commit(repoRoot, "delete and rename current paths");
  assert.notEqual(rootSha, afterSha);
  await writeFile(path.join(repoRoot, "renamed.txt"), "unstaged current content\n", "utf8");
  await writeFile(path.join(repoRoot, "staged.txt"), "staged current content\n", "utf8");
  git(repoRoot, ["add", "staged.txt"]);
  await writeFile(path.join(repoRoot, "untracked.txt"), "untracked current content\n", "utf8");

  // PASS 1 — raw sanity from the real Git producer, before relying on the
  // operation's implementation labels or test assertions.
  assert.equal(gitText(repoRoot, ["cat-file", "-e", `${rootSha}^{commit}`]), "");
  assert.equal(gitText(repoRoot, ["ls-tree", "-r", "--name-only", rootSha, "--", "deleted.txt"]), "deleted.txt");
  assert.equal(gitText(repoRoot, ["ls-tree", "-r", "--name-only", afterSha, "--", "deleted.txt"]), "");
  assert.equal(gitText(repoRoot, ["ls-tree", "-r", "--name-only", afterSha, "--", "renamed.txt"]), "renamed.txt");
  console.log("TARGET_EVIDENCE: disposable real local Git repository and local object database");
  console.log("RAW_OBSERVATION: root tree contains deleted.txt while current tree does not; current tree contains renamed.txt");
  console.log("SANITY_VERDICT: MATCH — accepted historical read target is directly present in the real root tree");
  console.log("PREDICATE: TRUE — independent ls-tree observations establish old-path presence before operation evaluation");

  const workspace = { id: "historical-blob-smoke", root: repoRoot, openedAt: new Date().toISOString() };
  const filesystemGuard = new PathGuard({ blockedGlobs: [] });
  const before = snapshot(repoRoot);

  const deleted = await readAtRef(config, guard, workspace, { ref: rootSha, path: "deleted.txt" });
  assert.equal(deleted.ref.fullSha, rootSha);
  assert.equal(deleted.commitSha, rootSha);
  assert.equal(deleted.path, "deleted.txt");
  assert.equal(deleted.gitMode, "100644");
  assert.equal(deleted.entryKind, "file");
  assert.equal(deleted.text, "1 | deleted historical content\n2 | ");
  assert.equal(deleted.bytes, Buffer.byteLength(deletedText, "utf8"));
  assert.equal(deleted.sha256, sha256Bytes(Buffer.from(deletedText, "utf8")));
  assert.equal(deleted.truncated, false);

  const renamed = await readAtRef(config, guard, workspace, { ref: rootSha, path: "old-name.txt" });
  assert.equal(renamed.text, "1 | renamed historical content\n2 | ");
  const unicode = await readAtRef(config, guard, workspace, { ref: rootSha, path: "./unicode space π.txt" });
  assert.equal(unicode.path, "unicode space π.txt");
  assert.equal(unicode.text, "1 | Unicode π and spaces\n2 | ");
  const leading = await readAtRef(config, guard, workspace, { ref: rootSha, path: "-leading.txt" });
  assert.equal(leading.text, "1 | leading dash\n2 | ");
  const hidden = await readAtRef(config, guard, workspace, { ref: rootSha, path: ".hidden.txt" });
  assert.equal(hidden.text, "1 | hidden historical\n2 | ");
  const empty = await readAtRef(config, guard, workspace, { ref: rootSha, path: "empty.txt" });
  assert.equal(empty.text, "1 | ");
  assert.equal(empty.bytes, 0);
  assert.equal(empty.sha256, sha256Bytes(Buffer.alloc(0)));
  const executable = await readAtRef(config, guard, workspace, { ref: rootSha, path: "exec.sh" });
  assert.equal(executable.gitMode, "100755");

  const link = await readAtRef(config, guard, workspace, { ref: rootSha, path: "historical-link" });
  assert.equal(link.gitMode, "120000");
  assert.equal(link.entryKind, "symlink");
  assert.equal(link.text, "1 | target-secret.txt");
  assert.equal(link.text.includes("TARGET_SECRET_7X9"), false);
  console.log("RAW_OBSERVATION: real Git returned deleted/renamed/Unicode/space/leading-dash/hidden/empty/file-mode and symlink blobs with exact bytes");
  console.log("PASS historical old-tree path, symlink target-text-only, metadata, and raw SHA behavior");

  const privateBody = await readAtRef(config, guard, workspace, { ref: rootSha, path: "private.txt", startLine: 3, endLine: 3 });
  assert.equal(privateBody.text, "3 | [REDACTED_PRIVATE_KEY]");
  assert.equal(privateBody.text.includes("PRIVATE_BODY_7X9"), false);
  assert.equal(privateBody.totalLines, 6);
  assert.equal(privateBody.truncated, true);
  console.log("RAW_OBSERVATION: complete real blob contains private declaration/body/delimiter; selected line is body-only");
  console.log("SANITY_VERDICT: MATCH — selected public projection hides the body after full-snapshot policy evaluation");

  const range = await readAtRef(config, guard, workspace, { ref: rootSha, path: "private.txt", startLine: 1, endLine: 1 });
  assert.equal(range.text, "1 | const before = true;");
  assert.equal(range.bytes, Buffer.byteLength(privateRaw, "utf8"));
  assert.equal(range.sha256, sha256Bytes(Buffer.from(privateRaw, "utf8")));
  await expectHistoricalFailure("directory", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "dir" }), "directory");
  await expectHistoricalFailure("gitlink", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "gitlink-entry" }), "gitlink");
  await expectHistoricalFailure("binary", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "binary.bin" }), "binary");
  await expectHistoricalFailure("blocked path", () => readAtRef(config, guard, workspace, { ref: rootSha, path: ".env" }), "blocked-path");
  await expectHistoricalFailure("missing historical path", () => readAtRef(config, guard, workspace, { ref: afterSha, path: "deleted.txt" }), "missing-path");
  await expectHistoricalFailure("oversized blob", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "too-large.txt" }), "oversized");
  await expectHistoricalFailure("invalid max_bytes", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "empty.txt", maxBytes: 0 }), "invalid-max-bytes");

  const large = await readAtRef({ ...config, maxOutputBytes: 120_000, maxReadBytes: 180_000 }, guard, workspace, {
    ref: rootSha,
    path: "large.txt"
  });
  assert.equal(large.bytes, largeBytes.byteLength);
  assert.equal(large.sha256, sha256Bytes(largeBytes));
  assert.equal(large.text.length, largeBytes.byteLength + "1 | ".length);
  console.log(`RAW_OBSERVATION: real ${large.bytes}-byte blob succeeded with maxOutputBytes=120000 and maxReadBytes=180000`);

  const rangedLine = await readAtRef(config, guard, workspace, {
    ref: rootSha,
    path: "range-budget.txt",
    startLine: 12_000,
    endLine: 12_000,
    maxBytes: config.maxReadBytes
  });
  assert.equal(rangedLine.text, "12000 | line-11999");
  assert.equal(rangedLine.totalLines, 12_001);
  assert.equal(rangedLine.truncated, true);

  const advertisedRangeBytes = Number(gitText(repoRoot, ["cat-file", "-s", `${rootSha}:range-budget.txt`]));
  assert.ok(advertisedRangeBytes > 20);
  const narrowRangedLine = await readAtRef(config, guard, workspace, {
    ref: rootSha,
    path: "range-budget.txt",
    startLine: 12_000,
    endLine: 12_000,
    maxBytes: 20
  });
  const currentNarrowRangedLine = await readPublicTextFile(config, filesystemGuard, workspace, "range-budget.txt", {
    startLine: 12_000,
    endLine: 12_000,
    maxBytes: 20
  });
  assert.equal(narrowRangedLine.text, "12000 | line-11999");
  assert.deepEqual(
    {
      path: narrowRangedLine.path,
      text: narrowRangedLine.text,
      startLine: narrowRangedLine.startLine,
      endLine: narrowRangedLine.endLine,
      totalLines: narrowRangedLine.totalLines,
      bytes: narrowRangedLine.bytes,
      sha256: narrowRangedLine.sha256,
      truncated: narrowRangedLine.truncated
    },
    currentNarrowRangedLine,
    "historical selected-range projection diverged from current filesystem semantics"
  );
  await expectHistoricalFailure(
    "selected range over requested budget",
    () => readAtRef(config, guard, workspace, { ref: rootSha, path: "range-budget.txt", startLine: 1, endLine: 1, maxBytes: 5 }),
    "range-too-large"
  );
  await assert.rejects(
    () => readPublicTextFile(config, filesystemGuard, workspace, "range-budget.txt", { startLine: 1, endLine: 1, maxBytes: 5 }),
    /Selected line range is too large/u
  );
  await expectHistoricalFailure(
    "raw numbered range budget",
    () => readAtRef(config, guard, workspace, { ref: rootSha, path: "range-budget.txt", startLine: 1, endLine: 12_000, maxBytes: config.maxReadBytes }),
    "range-too-large"
  );
  console.log(`RAW_OBSERVATION: real ${advertisedRangeBytes}-byte blob exceeded requested 20-byte budget while selected line was 18 bytes`);
  console.log("RAW_OBSERVATION: historical and current filesystem selected-range projections matched; inverse 5-byte budget rejected both");
  console.log("RAW_OBSERVATION: range-budget blob stayed below acquisition cap while numbered full-range projection exceeded max_bytes");
  console.log("PASS raw range-byte admission and truthful line/truncation metadata");

  const binDir = path.join(fixtureRoot, "armed-git");
  await mkdir(binDir, { recursive: true });
  const sentinel = path.join(fixtureRoot, "cat-file-sentinel");
  const wrapper = [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if [ "$arg" = "cat-file" ]; then',
    '    : > "$HISTORICAL_BLOB_SENTINEL"',
    "    exit 91",
    "  fi",
    "done",
    `exec ${realGit.replaceAll("'", "'\\''")} "$@"`
  ].join("\n") + "\n";
  const wrappedGit = path.join(binDir, "git");
  await writeFile(wrappedGit, wrapper, "utf8");
  await chmod(wrappedGit, 0o755);
  const previousPath = process.env.PATH;
  const previousSentinel = process.env.HISTORICAL_BLOB_SENTINEL;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  process.env.HISTORICAL_BLOB_SENTINEL = sentinel;
  try {
    await expectHistoricalFailure(
      "oversized pre-read rejection",
      () => readAtRef(config, guard, workspace, { ref: rootSha, path: "too-large.txt" }),
      "oversized"
    );
    await assert.rejects(access(sentinel, fsConstants.F_OK));
    console.log("RAW_OBSERVATION: armed real-git wrapper saw no cat-file invocation for advertised oversized blob");
    console.log("PASS oversized blob rejected before content acquisition");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousSentinel === undefined) delete process.env.HISTORICAL_BLOB_SENTINEL;
    else process.env.HISTORICAL_BLOB_SENTINEL = previousSentinel;
  }

  const after = snapshot(repoRoot);
  assert.deepEqual(after, before, "historical blob operations changed Git/worktree/config state");
  console.log("RAW_OBSERVATION: HEAD, branch, refs, reflogs, index, staged/unstaged/untracked state, status, and local config matched before/after snapshots");
  console.log("SANITY_VERDICT: MATCH — reviewer calls were physically read-only against the real repository");
  console.log("GIT_HISTORICAL_BLOB_SMOKE: PASS (real local Git producer; no remote/helper/production route)");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
