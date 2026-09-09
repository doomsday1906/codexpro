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
  // Multi-line blob just above the configured read budget: the historical route
  // pages it (snapshot envelope) instead of rejecting the total size.
  const tooLargeLines = Array.from({ length: 3000 }, (_, index) => `oversized line ${String(index).padStart(5, "0")} ${"O".repeat(40)}`);
  const tooLargeBytes = Buffer.from(`${tooLargeLines.join("\n")}\n`, "utf8");
  assert.ok(tooLargeBytes.byteLength > config.maxReadBytes);
  const rangeRaw = Array.from({ length: 12_000 }, (_, index) => `line-${String(index).padStart(5, "0")}`).join("\n") + "\n";
  const unrangedRaw = [
    "historical first line",
    "historical second line",
    `historical third line ${"u".repeat(13)}`
  ].join("\n") + "\n";
  assert.equal(Buffer.byteLength(unrangedRaw, "utf8"), 81);

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
  await writeFile(path.join(repoRoot, "unranged-budget.txt"), unrangedRaw, "utf8");
  await writeFile(path.join(repoRoot, "private.txt"), privateRaw, "utf8");
  await writeFile(path.join(repoRoot, ".env"), "SECRET_ENV=do-not-return\n", "utf8");
  await mkdir(path.join(repoRoot, "dir"), { recursive: true });
  await writeFile(path.join(repoRoot, "dir", "nested.txt"), "nested\n", "utf8");
  await writeFile(path.join(repoRoot, "link-target.txt"), "link target is not secret\n", "utf8");
  await symlink("target-secret.txt", path.join(repoRoot, "historical-link"));

  // TASK-005 large-blob fixtures (deterministic; hashes asserted at read time).
  const big20mLines = [];
  big20mLines.push("// twenty megabyte historical seed");
  big20mLines.push("-----BEGIN RSA PRIVATE KEY-----");
  big20mLines.push("MIIEpHISTORICALBODYLINEONE7X9");
  big20mLines.push("HISTORICALBODYLINETWO7X9");
  big20mLines.push("-----END RSA PRIVATE KEY-----");
  big20mLines.push("class CampaignRepo {}");
  let big20mBytes = Buffer.byteLength(`${big20mLines.join("\n")}\n`, "utf8");
  let big20mIndex = 0;
  const big20mChunks = [`${big20mLines.join("\n")}\n`];
  while (big20mBytes < 20 * 1024 * 1024) {
    const line = `historical body line ${String(big20mIndex).padStart(9, "0")} ${"y".repeat(60)}\n`;
    big20mChunks.push(line);
    big20mBytes += Buffer.byteLength(line, "utf8");
    big20mIndex += 1;
  }
  await writeFile(path.join(repoRoot, "big20m.txt"), big20mChunks.join(""), "utf8");
  const big20mTotalLines = big20mIndex + big20mLines.length + 1;
  const binaryAfterChunks = ["first selected line here\n", "second line\n"];
  while (Buffer.byteLength(binaryAfterChunks.join(""), "utf8") < 3 * 1024 * 1024) {
    binaryAfterChunks.push(`padding ${binaryAfterChunks.length} ${"q".repeat(70)}\n`);
  }
  binaryAfterChunks.push("late\x00nul byte\n");
  await writeFile(path.join(repoRoot, "binary-after.txt"), binaryAfterChunks.join(""), "utf8");
  await writeFile(path.join(repoRoot, "huge.bin"), Buffer.alloc(100 * 1024 * 1024, 0x61));

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
  // TASK-005: the just-over-budget multi-line blob is no longer "oversized" — it
  // pages through the snapshot route with continuation metadata and byte-exact identity.
  const tooLargePaged = await readAtRef(config, guard, workspace, { ref: rootSha, path: "too-large.txt" });
  assert.equal(tooLargePaged.bytes, tooLargeBytes.byteLength);
  assert.equal(tooLargePaged.startLine, 1);
  assert.equal(tooLargePaged.budgetTruncated, true);
  assert.ok(typeof tooLargePaged.nextStartLine === "number");
  assert.equal(tooLargePaged.sha256, sha256Bytes(tooLargeBytes));
  const tooLargeContinued = await readAtRef(config, guard, workspace, {
    ref: rootSha,
    path: "too-large.txt",
    startLine: tooLargePaged.nextStartLine
  });
  assert.equal(tooLargeContinued.startLine, tooLargePaged.nextStartLine);
  console.log(`RAW_OBSERVATION: ${tooLargeBytes.byteLength}-byte blob pages (1-${tooLargePaged.endLine} then ${tooLargeContinued.startLine}-) with exact sha ${tooLargePaged.sha256.slice(0, 12)}`);
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
    {
      path: currentNarrowRangedLine.path,
      text: currentNarrowRangedLine.text,
      startLine: currentNarrowRangedLine.startLine,
      endLine: currentNarrowRangedLine.endLine,
      totalLines: currentNarrowRangedLine.totalLines,
      bytes: currentNarrowRangedLine.bytes,
      sha256: currentNarrowRangedLine.sha256,
      truncated: currentNarrowRangedLine.truncated
    },
    "historical selected-range projection diverged from current filesystem semantics"
  );
  await expectHistoricalFailure(
    "selected range over requested budget",
    () => readAtRef(config, guard, workspace, { ref: rootSha, path: "range-budget.txt", startLine: 1, endLine: 1, maxBytes: 5 }),
    "range-too-large"
  );
  await assert.rejects(
    () => readPublicTextFile(config, filesystemGuard, workspace, "range-budget.txt", { startLine: 1, endLine: 1, maxBytes: 5 }),
    /Selected line 1 is too large/u
  );
  // TASK-005: an over-budget bounded historical range pages (largest fitting
  // complete-line prefix + continuation) instead of failing range-too-large.
  const fullRangePaged = await readAtRef(config, guard, workspace, { ref: rootSha, path: "range-budget.txt", startLine: 1, endLine: 12_000, maxBytes: config.maxReadBytes });
  assert.equal(fullRangePaged.startLine, 1);
  assert.ok(fullRangePaged.endLine < 12_000);
  assert.equal(fullRangePaged.budgetTruncated, true);
  assert.equal(fullRangePaged.nextStartLine, fullRangePaged.endLine + 1);
  const fullRangeWorking = await readPublicTextFile(config, filesystemGuard, workspace, "range-budget.txt", { startLine: 1, endLine: 12_000, maxBytes: config.maxReadBytes });
  assert.equal(fullRangePaged.text, fullRangeWorking.text, "historical first page diverged from working-tree first page");
  assert.equal(fullRangePaged.nextStartLine, fullRangeWorking.nextStartLine);
  const fullRangeContinued = await readAtRef(config, guard, workspace, { ref: rootSha, path: "range-budget.txt", startLine: fullRangePaged.nextStartLine, endLine: 12_000, maxBytes: config.maxReadBytes });
  assert.equal(fullRangeContinued.startLine, fullRangePaged.nextStartLine);
  console.log(`RAW_OBSERVATION: historical full-range pages 1-${fullRangePaged.endLine} then ${fullRangeContinued.startLine}-, byte-identical to the working-tree first page`);
  console.log(`RAW_OBSERVATION: real ${advertisedRangeBytes}-byte blob exceeded requested 20-byte budget while selected line was 18 bytes`);
  console.log("RAW_OBSERVATION: historical and current filesystem selected-range projections matched; inverse 5-byte budget is a bounded selected-line error on both");
  console.log("RAW_OBSERVATION: range-budget blob stayed below acquisition cap; numbered full-range projection pages identically on both routes");
  console.log("PASS raw range-byte admission and truthful line/truncation metadata");

  const advertisedUnrangedBytes = Number(gitText(repoRoot, ["cat-file", "-s", `${rootSha}:unranged-budget.txt`]));
  assert.equal(advertisedUnrangedBytes, 81);
  await expectHistoricalFailure(
    "unranged requested max_bytes",
    () => readAtRef(config, guard, workspace, { ref: rootSha, path: "unranged-budget.txt", maxBytes: 12 }),
    "range-too-large"
  );
  await assert.rejects(
    () => readPublicTextFile(config, filesystemGuard, workspace, "unranged-budget.txt", { maxBytes: 12 }),
    /Selected line 1 is too large/u
  );
  // TASK-005: at 81 the 93-byte numbered body pages identically on both routes.
  for (const maxBytes of [81, 100]) {
    const historicalUnranged = await readAtRef(config, guard, workspace, {
      ref: rootSha,
      path: "unranged-budget.txt",
      maxBytes
    });
    const currentUnranged = await readPublicTextFile(config, filesystemGuard, workspace, "unranged-budget.txt", { maxBytes });
    assert.deepEqual(
      {
        path: historicalUnranged.path,
        text: historicalUnranged.text,
        startLine: historicalUnranged.startLine,
        endLine: historicalUnranged.endLine,
        totalLines: historicalUnranged.totalLines,
        bytes: historicalUnranged.bytes,
        sha256: historicalUnranged.sha256,
        truncated: historicalUnranged.truncated
      },
      {
        path: currentUnranged.path,
        text: currentUnranged.text,
        startLine: currentUnranged.startLine,
        endLine: currentUnranged.endLine,
        totalLines: currentUnranged.totalLines,
        bytes: currentUnranged.bytes,
        sha256: currentUnranged.sha256,
        truncated: currentUnranged.truncated
      },
      `historical un-ranged projection diverged from current filesystem semantics at max_bytes=${maxBytes}`
    );
    assert.equal(historicalUnranged.bytes, advertisedUnrangedBytes);
    // New-contract pagination metadata agrees on both routes (page at 81, whole at 100).
    assert.equal(historicalUnranged.budgetTruncated, currentUnranged.budgetTruncated);
    assert.equal(historicalUnranged.nextStartLine ?? null, currentUnranged.nextStartLine ?? null);
    if (maxBytes === 81) {
      assert.equal(historicalUnranged.endLine, 2);
      assert.equal(historicalUnranged.nextStartLine, 3);
    }
  }
  console.log("RAW_OBSERVATION: real 81-byte un-ranged blob takes bounded selected-line errors at max_bytes=12 and succeeds at within budgets");
  console.log("RAW_OBSERVATION: historical and current filesystem un-ranged max_bytes behavior matched");

  // AP-013: 20MiB historical blob — deep range, unbounded page, bounded retention.
  const big20mOid = gitText(repoRoot, ["rev-parse", `${rootSha}:big20m.txt`]);
  const big20mAdvertised = Number(gitText(repoRoot, ["cat-file", "-s", big20mOid]));
  assert.ok(big20mAdvertised > 20 * 1024 * 1024);
  const big20mRange = await readAtRef(config, guard, workspace, { ref: rootSha, path: "big20m.txt", startLine: 100000, endLine: 100029 });
  assert.equal(big20mRange.startLine, 100000);
  assert.equal(big20mRange.endLine, 100029);
  assert.equal(big20mRange.bytes, big20mAdvertised);
  assert.equal(big20mRange.totalLines, big20mTotalLines);
  assert.equal(big20mRange.truncated, true);
  assert.equal(big20mRange.budgetTruncated, false);
  assert.equal(big20mRange.blobSha, big20mOid);
  const big20mOracleSha = execFileSync("sh", ["-c", `git -C ${JSON.stringify(repoRoot)} cat-file blob ${big20mOid} | sha256sum`], { encoding: "utf8" }).split(/\s+/)[0];
  assert.equal(big20mRange.sha256, big20mOracleSha);
  const big20mPage = await readAtRef(config, guard, workspace, { ref: rootSha, path: "big20m.txt" });
  assert.equal(big20mPage.startLine, 1);
  assert.equal(big20mPage.budgetTruncated, true);
  assert.ok(typeof big20mPage.nextStartLine === "number");
  assert.ok(big20mPage.returnedBytes <= config.maxReadBytes);
  const big20mContinued = await readAtRef(config, guard, workspace, { ref: rootSha, path: "big20m.txt", startLine: big20mPage.nextStartLine });
  assert.equal(big20mContinued.startLine, big20mPage.nextStartLine);
  // Private-key block far before the window stays redacted through the historical route.
  const big20mKeyWindow = await readAtRef(config, guard, workspace, { ref: rootSha, path: "big20m.txt", startLine: 2, endLine: 5 });
  assert.equal(big20mKeyWindow.text.includes("MIIEpHISTORICALBODYLINEONE7X9"), false);
  assert.ok(big20mKeyWindow.text.includes("[REDACTED_PRIVATE_KEY]"));
  const big20mWitness = await readAtRef(config, guard, workspace, { ref: rootSha, path: "big20m.txt", startLine: 6, endLine: 6 });
  assert.ok(big20mWitness.text.includes("class CampaignRepo {}"), "benign historical witness hidden");
  // Bounded retention measured directly at the streaming consumer.
  const { streamGitBlobToScan } = await import("../dist/gitHistoricalBlob.js");
  const streamed = await streamGitBlobToScan(workspace, {
    oid: big20mOid,
    advertised: big20mAdvertised,
    timeoutMs: 60_000,
    stderrMaxBytes: 120_000,
    startLine: 100000,
    endLine: 100029,
    selectMaxBytes: 256 * 1024,
    retainUpToBytes: 0
  });
  assert.equal(streamed.scan.bytes, big20mAdvertised);
  assert.ok(streamed.scan.maxRetainedBytes <= 2 * 1024 * 1024, `historical retention ${streamed.scan.maxRetainedBytes}`);
  console.log(`RAW_OBSERVATION: 20MiB historical range+page stream with retention ${streamed.scan.maxRetainedBytes}; key-before-range redacted; benign witness visible`);
  console.log("PASS historical 20MiB bounded streaming with exact immutable metadata");

  // AP-014: binary after the window, timeout, and surviving fail-closed laws.
  await expectHistoricalFailure("binary after window", () => readAtRef(config, guard, workspace, { ref: rootSha, path: "binary-after.txt", startLine: 1, endLine: 1 }), "binary");
  // A 1ms streaming timeout cannot beat a 20MiB pipe: deterministic timeout proof
  // at the streaming consumer (readAtRef threads config.maxGitTimeoutMs through).
  await assert.rejects(
    streamGitBlobToScan(workspace, {
      oid: big20mOid,
      advertised: big20mAdvertised,
      timeoutMs: 1,
      stderrMaxBytes: 120_000,
      startLine: 100000,
      endLine: 100029,
      selectMaxBytes: 256 * 1024,
      retainUpToBytes: 0
    }),
    (error) => error instanceof HistoricalBlobError && error.reason === "timeout"
  );
  console.log("RAW_OBSERVATION: 20MiB stream with a 1ms ceiling fails timeout with bounded facts");
  // Reviewer F2 regression: a deterministic stream failure (advertised size lie)
  // must reach the caller with NO process-level unhandled rejection.
  {
    let unhandled = 0;
    const counter = () => {
      unhandled += 1;
    };
    process.on("unhandledRejection", counter);
    try {
      await assert.rejects(
        streamGitBlobToScan(workspace, {
          oid: big20mOid,
          advertised: big20mAdvertised - 1,
          timeoutMs: 60_000,
          stderrMaxBytes: 120_000,
          startLine: 1,
          endLine: 2,
          selectMaxBytes: 256 * 1024,
          retainUpToBytes: 0
        }),
        (error) => error instanceof HistoricalBlobError && error.reason === "blob-size-mismatch"
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(unhandled, 0, "stream failure emitted an unhandled rejection");
    } finally {
      process.removeListener("unhandledRejection", counter);
    }
    console.log("RAW_OBSERVATION: blob-size-mismatch reaches the caller with zero unhandled rejections");
  }
  console.log("PASS historical binary-after-window and timeout fail-closed");

  // In-policy blobs stream through cat-file (already proven above: the 20MiB
  // range, pages, and continuation all succeeded); the armed wrapper below
  // proves pre-acquisition rejection never invokes cat-file at all.
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
    // Beyond the independent scan policy, tree metadata alone rejects the blob:
    // cat-file never runs (the wrapper would exit 91 and drop the sentinel).
    await expectHistoricalFailure(
      "scan-limit pre-acquisition rejection",
      () => readAtRef(config, guard, workspace, { ref: rootSha, path: "huge.bin" }),
      "oversized"
    );
    await assert.rejects(access(sentinel, fsConstants.F_OK));
    // A window that would fail its budget still acquires first: through the
    // sabotaged wrapper, acquisition itself fails (execution) AND the sentinel
    // proves cat-file ran before any window decision could reject the request.
    await rm(sentinel, { force: true });
    await expectHistoricalFailure(
      "window decision happens after acquisition",
      () => readAtRef(config, guard, workspace, { ref: rootSha, path: "unranged-budget.txt", maxBytes: 12 }),
      "execution"
    );
    await access(sentinel, fsConstants.F_OK);
    console.log("RAW_OBSERVATION: armed real-git wrapper saw no cat-file invocation for a blob beyond the scan policy");
    console.log("RAW_OBSERVATION: the same wrapper saw cat-file attempted for an in-policy blob before any window decision");
    console.log("PASS scan-limit blobs rejected from tree metadata; window decisions happen after acquisition");
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
