import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// This smoke owns test fixtures and test-side falsifiers only. The expected
// metadata is derived from direct Git producers below; the compiled target is
// loaded only after the raw-observation sanity pass.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-diff-range-"));
const systemPath = process.env.PATH ?? "";
const realGit = (() => {
  const result = spawnSync("which", ["git"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || !result.stdout?.trim()) throw new Error("unable to locate Git for disposable fixtures");
  return result.stdout.trim();
})();

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(value);
}

function directGit(repoRoot, args, options = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true"
  };
  delete env.GIT_CONFIG;
  delete env.GIT_CONFIG_GLOBAL;
  const result = spawnSync(realGit, args, {
    cwd: repoRoot,
    env,
    input: options.input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: asBuffer(result.stdout),
    stderr: asBuffer(result.stderr),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(repoRoot, args, options = {}) {
  const result = directGit(repoRoot, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(`fixture Git failed: ${args.join(" ")} status=${result.status} stderr=${result.stderr.toString("utf8")}`);
  }
  return result.stdout;
}

function directText(repoRoot, args) {
  return mustGit(repoRoot, args).toString("utf8");
}

function directTrimmed(repoRoot, args) {
  return directText(repoRoot, args).trim();
}

async function writeFixture(repoRoot, relativePath, value, mode) {
  const absolutePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, value);
  if (mode !== undefined) await chmod(absolutePath, mode);
}

async function commitAll(repoRoot, message, allowEmpty = false) {
  mustGit(repoRoot, ["add", "--all"]);
  const commitArgs = ["commit", "--quiet"];
  if (allowEmpty) commitArgs.push("--allow-empty");
  commitArgs.push("-m", message);
  mustGit(repoRoot, commitArgs);
  return directTrimmed(repoRoot, ["rev-parse", "HEAD"]);
}

async function initRepo(repoRoot) {
  await mkdir(repoRoot, { recursive: true });
  mustGit(repoRoot, ["init", "--quiet"]);
  mustGit(repoRoot, ["config", "user.name", "Git Diff Range Smoke"]);
  mustGit(repoRoot, ["config", "user.email", "git-diff-range-smoke@example.invalid"]);
  mustGit(repoRoot, ["config", "core.quotePath", "true"]);
}

function splitNul(bytes) {
  if (bytes.length === 0) return [];
  assert.equal(bytes.at(-1), 0, "direct Git producer did not terminate NUL stream");
  const fields = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(Buffer.from(bytes.subarray(start, index)));
    start = index + 1;
  }
  assert.equal(start, bytes.length, "direct Git producer left an unterminated field");
  return fields;
}

function decodePath(bytes) {
  return bytes.toString("utf8");
}

function parseRawNameStatus(bytes) {
  const fields = splitNul(bytes);
  const records = [];
  let index = 0;
  while (index < fields.length) {
    const statusText = decodePath(fields[index++]);
    const match = /^([ACDMRTUXB])(\d{0,3})$/u.exec(statusText);
    assert.ok(match, `unexpected direct Git name-status record ${JSON.stringify(statusText)}`);
    const status = match[1];
    const score = match[2] ? Number(match[2]) : null;
    if (status === "R" || status === "C") {
      assert.ok(index + 1 < fields.length, "direct Git rename/copy record missing path side");
      records.push({ status, oldPath: decodePath(fields[index++]), newPath: decodePath(fields[index++]), similarity: score });
    } else {
      assert.ok(index < fields.length, "direct Git name-status record missing path");
      const pathValue = decodePath(fields[index++]);
      records.push({
        status,
        oldPath: status === "A" ? null : pathValue,
        newPath: status === "D" ? null : pathValue,
        similarity: null
      });
    }
  }
  return records;
}

function parseRawNumstat(bytes) {
  const fields = splitNul(bytes);
  const records = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index++];
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
    assert.ok(firstTab > 0 && secondTab > firstTab + 1, "malformed direct Git numstat record");
    const additionsText = record.subarray(0, firstTab).toString("ascii");
    const deletionsText = record.subarray(firstTab + 1, secondTab).toString("ascii");
    const additions = additionsText === "-" ? null : Number(additionsText);
    const deletions = deletionsText === "-" ? null : Number(deletionsText);
    assert.ok(additions === null || Number.isSafeInteger(additions), "direct Git additions was not numeric");
    assert.ok(deletions === null || Number.isSafeInteger(deletions), "direct Git deletions was not numeric");
    const pathField = record.subarray(secondTab + 1);
    if (pathField.length > 0) {
      records.push({
        path: decodePath(pathField),
        oldPath: null,
        newPath: null,
        additions,
        deletions,
        binary: additions === null && deletions === null
      });
      continue;
    }
    assert.ok(index + 1 < fields.length, "direct Git rename/copy numstat record missing path sides");
    records.push({
      path: null,
      oldPath: decodePath(fields[index++]),
      newPath: decodePath(fields[index++]),
      additions,
      deletions,
      binary: additions === null && deletions === null
    });
  }
  return records;
}

function directMetadata(repoRoot, base, head, pathFilter) {
  const suffix = pathFilter === undefined ? [] : ["--", `:(literal)${pathFilter}`];
  const common = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--find-copies=50%",
    "-z"
  ];
  const name = directGit(repoRoot, [...common, "--name-status", base, head, ...suffix]);
  const numstat = directGit(repoRoot, [...common, "--numstat", base, head, ...suffix]);
  assert.equal(name.status, 0, `direct name-status failed: ${name.stderr.toString("utf8")}`);
  assert.equal(numstat.status, 0, `direct numstat failed: ${numstat.stderr.toString("utf8")}`);
  const names = parseRawNameStatus(name.stdout);
  const stats = parseRawNumstat(numstat.stdout);
  assert.equal(names.length, stats.length, "direct Git producer streams disagreed");
  const records = names.map((entry, index) => {
    const stat = stats[index];
    const renameOrCopy = entry.status === "R" || entry.status === "C";
    const expectedPath = entry.status === "D" ? entry.oldPath : entry.newPath;
    if (renameOrCopy) {
      assert.equal(stat.path, null);
      assert.equal(stat.oldPath, entry.oldPath);
      assert.equal(stat.newPath, entry.newPath);
    } else {
      assert.equal(stat.path, expectedPath);
      assert.equal(stat.oldPath, null);
      assert.equal(stat.newPath, null);
    }
    return {
      status: entry.status,
      oldPath: entry.oldPath,
      newPath: entry.newPath,
      similarity: entry.similarity,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary
    };
  });
  return { nameBytes: name.stdout, numstatBytes: numstat.stdout, nameStderr: name.stderr, numstatStderr: numstat.stderr, records };
}

async function fileDigest(filePath) {
  try {
    const bytes = await readFile(filePath);
    return { exists: true, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function repositoryState(repoRoot, relevantPaths = []) {
  const commandFacts = {};
  for (const [name, args] of [
    ["head", ["rev-parse", "--verify", "HEAD"]],
    ["branch", ["symbolic-ref", "--short", "-q", "HEAD"]],
    ["refs", ["for-each-ref", "--format=%(refname)%00%(objectname)"]],
    ["reflogs", ["reflog", "--all", "--format=%H%x00%gs"]],
    ["index", ["diff", "--cached", "--binary"]],
    ["unstaged", ["diff", "--binary"]],
    ["status", ["status", "--porcelain=v1", "-z"]],
    ["config", ["config", "--local", "--null", "--list"]],
    ["remotes", ["remote", "-v"]]
  ]) {
    const result = directGit(repoRoot, args);
    commandFacts[name] = {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout.toString("base64"),
      stderr: result.stderr.toString("base64")
    };
  }
  const files = {};
  for (const relativePath of relevantPaths) files[relativePath] = await fileDigest(path.join(repoRoot, relativePath));
  files[".git/index"] = await fileDigest(path.join(repoRoot, ".git", "index"));
  return { commandFacts, files };
}

async function makeMatrixFixture() {
  const repoRoot = path.join(fixtureRoot, "matrix");
  await initRepo(repoRoot);
  await writeFixture(repoRoot, "ordinary.txt", "before\nunchanged line\n");
  await writeFixture(repoRoot, "mode-only.sh", "mode-only\n", 0o644);
  await symlink("symlink-target", path.join(repoRoot, "type-entry"));
  await writeFixture(repoRoot, "rename100-old.txt", "unchanged rename payload\n");
  await writeFixture(repoRoot, "rename-mod-old.txt", Array.from({ length: 20 }, (_, i) => `line-${i}\n`).join(""));
  await writeFixture(repoRoot, "copy-source.txt", "copy-before\nline-2\nline-3\n");
  await writeFixture(repoRoot, "binary-mod.bin", Buffer.from([0, 1, 2, 3, 4, 0xff]));
  await writeFixture(repoRoot, "binary-delete.bin", Buffer.from([0, 9, 8, 7, 0]));
  await writeFixture(repoRoot, "delete-me.txt", "deleted from head\n");
  await writeFixture(repoRoot, "filter-delete.txt", "old filter-side path\n");
  await writeFixture(repoRoot, "filter-stable.txt", "stable filter path\n");
  const baseSha = await commitAll(repoRoot, "matrix base");

  await writeFixture(repoRoot, "ordinary.txt", "before\nchanged line\nadded line\n");
  await chmod(path.join(repoRoot, "mode-only.sh"), 0o755);
  await unlink(path.join(repoRoot, "type-entry"));
  await writeFixture(repoRoot, "type-entry", "regular target now\n");
  await mustGit(repoRoot, ["mv", "rename100-old.txt", "rename100-new.txt"]);
  await mustGit(repoRoot, ["mv", "rename-mod-old.txt", "rename-mod-new.txt"]);
  await writeFixture(repoRoot, "rename-mod-new.txt", Array.from({ length: 20 }, (_, i) => `line-${i === 18 ? "changed" : i}\n`).join(""));
  await writeFixture(repoRoot, "copy-source.txt", "copy-after\nline-2\nline-3\n");
  await writeFixture(repoRoot, "copy-dest.txt", "copy-after\nline-2\nline-3\n");
  await unlink(path.join(repoRoot, "delete-me.txt"));
  await unlink(path.join(repoRoot, "binary-delete.bin"));
  await writeFixture(repoRoot, "binary-mod.bin", Buffer.from([0, 1, 2, 3, 5, 0xfe]));
  await unlink(path.join(repoRoot, "filter-delete.txt"));
  await writeFixture(repoRoot, "filter-add.txt", "new filter-side path\n");
  await writeFixture(repoRoot, "space dir/space name.txt", "space path\n");
  await writeFixture(repoRoot, "café/é name.txt", "unicode path\n");
  await writeFixture(repoRoot, "-leading-dash.txt", "leading dash path\n");
  await writeFixture(repoRoot, "tab\tname.txt", "tab path\n");
  await writeFixture(repoRoot, "line\nname.txt", "newline path\n");
  await writeFixture(repoRoot, "binary-add.bin", Buffer.from([0, 10, 20, 0xff]));
  const headSha = await commitAll(repoRoot, "matrix metadata changes");
  await writeFixture(repoRoot, "review-state-sentinel.txt", "must remain untracked and unchanged\n");
  const relevantPaths = [
    "ordinary.txt",
    "mode-only.sh",
    "type-entry",
    "rename100-old.txt",
    "rename100-new.txt",
    "rename-mod-old.txt",
    "rename-mod-new.txt",
    "copy-source.txt",
    "copy-dest.txt",
    "delete-me.txt",
    "binary-delete.bin",
    "binary-mod.bin",
    "binary-add.bin",
    "filter-delete.txt",
    "filter-add.txt",
    "space dir/space name.txt",
    "café/é name.txt",
    "-leading-dash.txt",
    "tab\tname.txt",
    "line\nname.txt",
    "review-state-sentinel.txt"
  ];
  return { repoRoot, baseSha, headSha, relevantPaths };
}

async function makeBlockedFixture() {
  const repoRoot = path.join(fixtureRoot, "blocked");
  await initRepo(repoRoot);
  await writeFixture(repoRoot, "allowed-source.txt", "allowed source\n");
  const baseSha = await commitAll(repoRoot, "blocked base");

  await writeFixture(repoRoot, ".env.added", "blocked add secret\n");
  const blockedAddSha = await commitAll(repoRoot, "blocked add");
  await unlink(path.join(repoRoot, ".env.added"));
  const blockedDeleteSha = await commitAll(repoRoot, "blocked delete");

  await mustGit(repoRoot, ["mv", "allowed-source.txt", ".env.renamed"]);
  const allowedToBlockedSha = await commitAll(repoRoot, "allowed to blocked rename");
  await mustGit(repoRoot, ["mv", ".env.renamed", "allowed-renamed.txt"]);
  const blockedToAllowedSha = await commitAll(repoRoot, "blocked to allowed rename");

  await writeFixture(repoRoot, "allowed-copy-source.txt", "copy old\nline two\nline three\n");
  const blockedCopyBaseSha = await commitAll(repoRoot, "allowed copy source");
  await writeFixture(repoRoot, "allowed-copy-source.txt", "copy changed\nline two\nline three\n");
  await writeFixture(repoRoot, ".env.copy-dest", "copy changed\nline two\nline three\n");
  const blockedCopySha = await commitAll(repoRoot, "blocked-side copy");
  const blockedSourceOriginal = Array.from({ length: 20 }, (_, index) => `blocked-copy-${index}\n`).join("");
  const blockedSourceChanged = Array.from({ length: 20 }, (_, index) => `blocked-copy-${index === 18 ? "changed" : index}\n`).join("");
  await writeFixture(repoRoot, ".env.copy-source", blockedSourceOriginal);
  await writeFixture(repoRoot, "independent-allowed.txt", "independent before\n");
  const blockedSourceCopyBaseSha = await commitAll(repoRoot, "blocked copy source");
  await writeFixture(repoRoot, ".env.copy-source", blockedSourceChanged);
  await writeFixture(repoRoot, "allowed-copy-from-blocked.txt", blockedSourceChanged);
  await writeFixture(repoRoot, "independent-allowed.txt", "independent after\n");
  const blockedSourceCopySha = await commitAll(repoRoot, "blocked old-side copy");
  return {
    repoRoot,
    cases: [
      ["blocked add", baseSha, blockedAddSha, ".env.added"],
      ["blocked delete", blockedAddSha, blockedDeleteSha, ".env.added"],
      ["allowed to blocked rename", blockedDeleteSha, allowedToBlockedSha, ".env.renamed"],
      ["blocked to allowed rename", allowedToBlockedSha, blockedToAllowedSha, ".env.renamed"],
      ["copy with blocked new side", blockedCopyBaseSha, blockedCopySha, ".env.copy-dest"],
      ["copy with blocked old side", blockedSourceCopyBaseSha, blockedSourceCopySha, ".env.copy-source"]
    ]
  };
}

async function makeInvalidUtf8Fixture() {
  const repoRoot = path.join(fixtureRoot, "invalid-utf8");
  await initRepo(repoRoot);
  const baseSha = await commitAll(repoRoot, "invalid UTF-8 empty base", true);
  const badName = Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x2d, 0x80, 0x2e, 0x74, 0x78, 0x74]);
  const badAbsolute = Buffer.concat([Buffer.from(repoRoot), Buffer.from(path.sep), badName]);
  await writeFile(badAbsolute, Buffer.from("invalid path bytes\n"));
  const headSha = await commitAll(repoRoot, "invalid UTF-8 filename");
  return { repoRoot, baseSha, headSha, badName };
}

async function makeDivergentFixture() {
  const repoRoot = path.join(fixtureRoot, "divergent");
  await initRepo(repoRoot);
  await writeFixture(repoRoot, "common.txt", "common\n");
  const commonSha = await commitAll(repoRoot, "common base");
  mustGit(repoRoot, ["switch", "-c", "left"]);
  await writeFixture(repoRoot, "left-only.txt", "left\n");
  const leftSha = await commitAll(repoRoot, "left branch");
  mustGit(repoRoot, ["switch", "--detach", commonSha]);
  mustGit(repoRoot, ["switch", "-c", "right"]);
  await writeFixture(repoRoot, "right-only.txt", "right\n");
  const rightSha = await commitAll(repoRoot, "right branch");
  const mergeBase = directTrimmed(repoRoot, ["merge-base", leftSha, rightSha]);
  return { repoRoot, commonSha, leftSha, rightSha, mergeBase };
}

function rawRecordKey(record) {
  return JSON.stringify(record);
}

function assertRawContains(records, predicate, description) {
  assert.ok(records.some(predicate), `direct Git evidence missing ${description}`);
}

function recordByPath(records, pathValue) {
  return records.find((record) => record.oldPath === pathValue || record.newPath === pathValue);
}

const matrix = await makeMatrixFixture();
const blocked = await makeBlockedFixture();
const invalidUtf8 = await makeInvalidUtf8Fixture();
const divergent = await makeDivergentFixture();
const matrixRaw = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.headSha);
const matrixRawSameSha = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.baseSha);
const matrixRawAddFilter = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.headSha, "filter-add.txt");
const matrixRawDeleteFilter = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.headSha, "filter-delete.txt");
const directDivergent = directMetadata(divergent.repoRoot, divergent.leftSha, divergent.rightSha);
const directMergeBase = directMetadata(divergent.repoRoot, divergent.mergeBase, divergent.rightSha);
const invalidRawName = directGit(invalidUtf8.repoRoot, [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames=50%",
  "--find-copies=50%",
  "-z",
  "--name-status",
  invalidUtf8.baseSha,
  invalidUtf8.headSha
]);
assert.equal(invalidRawName.status, 0);
assert.ok(invalidRawName.stdout.includes(0x80), "direct Git did not preserve invalid filename byte in NUL producer");

console.log("AUTHORITY: MISSION_ANCHOR.md A001 LAW-001..LAW-010 and AC-001..AC-004; MISSION_PLAN.md P001 TASK-002 and AP-003/AP-004.");
console.log("TARGET_PRODUCER: disposable local repositories queried by direct Git diff --name-status -z and --numstat -z producers.");
console.log("TARGET_EVIDENCE: raw NUL-delimited Git bytes and independently decoded record facts. SUPPORTING_ORACLE: PathGuard blocked-glob predicate only; the target parser is not the oracle.");
console.log(`RAW_OBSERVATION: direct base ${matrix.baseSha} to head ${matrix.headSha} yielded ${matrixRaw.records.length} complete records; statuses=${matrixRaw.records.map((record) => record.status).join(",")}; odd paths were preserved as ${["space dir/space name.txt", "café/é name.txt", "-leading-dash.txt", "tab\tname.txt", "line\nname.txt"].map((value) => JSON.stringify(value)).join(", ")}.`);
console.log(`RAW_OBSERVATION: direct same-SHA comparison yielded ${matrixRawSameSha.records.length} records; direct divergent comparison left ${divergent.leftSha} to right ${divergent.rightSha} yielded ${directDivergent.records.length}, while merge-base ${divergent.mergeBase} to right yielded ${directMergeBase.records.length}.`);
console.log(`RAW_OBSERVATION: direct binary records have null additions/deletions and binary=true; invalid UTF-8 fixture contains raw byte 0x80 in the name-status producer.`);
console.log("SANITY_VERDICT: MATCH (direct Git facts establish the accepted metadata invariants before target diagnostics or test verdicts are consulted).");

const [{ loadConfig }, { CodexProError, PathGuard, WorkspaceManager }, target] = await Promise.all([
  import("../dist/config.js"),
  import("../dist/guard.js"),
  import("../dist/gitDiffRange.js")
]);
const { collectGitDiffRangeMetadata, GitDiffRangeError } = target;

function targetContext(repoRoot, overrides = {}) {
  const loaded = loadConfig(["--root", repoRoot, "--allow-root", repoRoot, "--bash", "off", "--write", "off"]);
  const config = { ...loaded, maxGitTimeoutMs: 5_000, maxOutputBytes: 64_000, maxReadBytes: 64_000, ...overrides };
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  return { config, guard, workspace };
}

function assertMetadataResult(result, expected, label) {
  assert.deepEqual(result.eligibleChangedFiles, expected, `${label}: eligible metadata diverged from direct Git`);
  assert.deepEqual(result.changedFiles, expected, `${label}: default returned metadata diverged from direct Git`);
  assert.equal(result.changedFileCount, expected.length, `${label}: raw count mismatch`);
  assert.equal(result.eligibleChangedFileCount, expected.length, `${label}: eligible count mismatch`);
  assert.equal(result.returnedFileCount, expected.length, `${label}: returned count mismatch`);
  assert.equal(result.changedFilesTruncated, false, `${label}: unexpected truncation`);
  assert.equal(result.blockedFilesOmitted, 0, `${label}: unexpected blocked omission`);
}

function assertTargetFailure(error, reason, label) {
  assert.ok(error instanceof GitDiffRangeError, `${label}: expected GitDiffRangeError, got ${error?.constructor?.name ?? typeof error}`);
  assert.equal(error.reason, reason, `${label}: wrong failure reason`);
  assert.ok(error.message.length < 180, `${label}: failure message is not bounded`);
  assert.equal(Object.hasOwn(error, "stdout"), false, `${label}: raw stdout escaped failure`);
  assert.equal(Object.hasOwn(error, "stderr"), false, `${label}: raw stderr escaped failure`);
  assert.equal(error.message.includes(".env"), false, `${label}: blocked path leaked in failure`);
  return error;
}

async function expectTargetFailure(operation, reason, label) {
  try {
    await operation();
    assert.fail(`${label}: expected ${reason}`);
  } catch (error) {
    return assertTargetFailure(error, reason, label);
  }
}

const matrixContext = targetContext(matrix.repoRoot);
const matrixBefore = await repositoryState(matrix.repoRoot, matrix.relevantPaths);
const matrixResult = await collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
  baseRef: matrix.baseSha,
  headRef: matrix.headSha,
  maxFiles: 200
});
const matrixAfter = await repositoryState(matrix.repoRoot, matrix.relevantPaths);
assert.deepEqual(matrixAfter, matrixBefore, "metadata operation changed Git/worktree/config state");
assertMetadataResult(matrixResult, matrixRaw.records, "A/M/D/R/C/T/binary matrix");
assert.equal(matrixResult.identity.base.fullSha, matrix.baseSha);
assert.equal(matrixResult.identity.head.fullSha, matrix.headSha);
assert.equal(matrixResult.identity.objectFormat, "sha1");
console.log("PASS AP-003 metadata records, counts, exact paths, binary truth, and physical read-only state match direct Git");

const modeRecord = recordByPath(matrixRaw.records, "mode-only.sh");
assert.ok(modeRecord);
assert.equal(modeRecord.status, "M");
assert.equal(modeRecord.additions, 0);
assert.equal(modeRecord.deletions, 0);
assertRawContains(matrixRaw.records, (record) => record.status === "T" && record.newPath === "type-entry", "type-change record");
assertRawContains(matrixRaw.records, (record) => record.status === "R" && record.similarity === 100, "100% rename");
assertRawContains(matrixRaw.records, (record) => record.status === "R" && record.similarity < 100, "modified rename");
assertRawContains(matrixRaw.records, (record) => record.status === "C", "ordinary copy without --find-copies-harder");
assertRawContains(matrixRaw.records, (record) => record.binary && record.status === "A", "binary add");
assertRawContains(matrixRaw.records, (record) => record.binary && record.status === "M", "binary modify");
assertRawContains(matrixRaw.records, (record) => record.binary && record.status === "D", "binary delete");
assert.equal(matrixRawSameSha.records.length, 0, "direct same-SHA evidence was not empty");
const sameShaResult = await collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
  baseRef: matrix.baseSha,
  headRef: matrix.baseSha
});
assertMetadataResult(sameShaResult, [], "same-SHA comparison");
console.log("PASS same-SHA zero records; mode-only/type-change, rename 100%/modified, ordinary copy, and binary A/M/D are covered");

const limitedResult = await collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
  baseRef: matrix.baseSha,
  headRef: matrix.headSha,
  maxFiles: 3
});
assert.deepEqual(limitedResult.changedFiles, matrixRaw.records.slice(0, 3));
assert.equal(limitedResult.changedFileCount, matrixRaw.records.length);
assert.equal(limitedResult.eligibleChangedFileCount, matrixRaw.records.length);
assert.equal(limitedResult.returnedFileCount, 3);
assert.equal(limitedResult.changedFilesTruncated, true);
const filterAddResult = await collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
  baseRef: matrix.baseSha,
  headRef: matrix.headSha,
  path: "filter-add.txt"
});
assertMetadataResult(filterAddResult, matrixRawAddFilter.records, "historical path filter new ordinary path");
const filterDeleteResult = await collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
  baseRef: matrix.baseSha,
  headRef: matrix.headSha,
  path: "filter-delete.txt"
});
assertMetadataResult(filterDeleteResult, matrixRawDeleteFilter.records, "historical path filter old ordinary path");
console.log("PASS AP-004 exact max_files prefix/truncation and literal historical old/new path filters");

const blockedContext = targetContext(blocked.repoRoot);
for (const [label, baseRef, headRef, blockedLiteral] of blocked.cases) {
  const raw = directMetadata(blocked.repoRoot, baseRef, headRef).records;
  assert.ok(raw.length > 0, `${label}: direct Git produced no changed record`);
  const result = await collectGitDiffRangeMetadata(blockedContext.config, blockedContext.guard, blockedContext.workspace, {
    baseRef,
    headRef,
    maxFiles: 200
  });
  const expectedBlocked = raw.filter((record) => record.oldPath === blockedLiteral || record.newPath === blockedLiteral).length;
  const expectedEligible = raw.filter((record) => record.oldPath !== blockedLiteral && record.newPath !== blockedLiteral);
  assert.ok(expectedBlocked > 0, `${label}: fixture did not produce a blocked-side record`);
  if (label.startsWith("copy with blocked")) {
    const copy = raw.find((record) => record.status === "C");
    assert.ok(copy, `${label}: direct Git did not produce a C record`);
    if (label.includes("old side")) {
      assert.equal(copy.oldPath, blockedLiteral, `${label}: C old/source side was not blocked`);
      assert.notEqual(copy.newPath, blockedLiteral, `${label}: C new/destination side was unexpectedly blocked`);
    } else {
      assert.notEqual(copy.oldPath, blockedLiteral, `${label}: C old/source side was unexpectedly blocked`);
      assert.equal(copy.newPath, blockedLiteral, `${label}: C new/destination side was not blocked`);
    }
    assert.ok(expectedEligible.length > 0, `${label}: no independent allowed record remained to verify retention`);
  }
  assert.equal(result.changedFileCount, raw.length, `${label}: raw count changed by filtering`);
  assert.equal(result.eligibleChangedFileCount, expectedEligible.length, `${label}: blocked record was retained`);
  assert.equal(result.returnedFileCount, expectedEligible.length, `${label}: blocked record was returned`);
  assert.equal(result.blockedFilesOmitted, expectedBlocked, `${label}: blocked count mismatch`);
  assert.deepEqual(result.eligibleChangedFiles, expectedEligible, `${label}: allowed record set changed while filtering`);
  assert.deepEqual(result.changedFiles, expectedEligible, `${label}: blocked record leaked into changed_files`);
  assert.equal(JSON.stringify(result).includes(blockedLiteral), false, `${label}: blocked path literal leaked in public facts`);
  console.log(`PASS blocked whole-record filtering ${label}; raw=${raw.length} eligible=${expectedEligible.length} omitted=${expectedBlocked}`);
}

const invalidContext = targetContext(invalidUtf8.repoRoot);
await expectTargetFailure(
  () => collectGitDiffRangeMetadata(invalidContext.config, invalidContext.guard, invalidContext.workspace, {
    baseRef: invalidUtf8.baseSha,
    headRef: invalidUtf8.headSha
  }),
  "path-encoding",
  "invalid UTF-8 filename"
);
console.log("PASS invalid UTF-8 filename fails closed with bounded path-encoding error");

await expectTargetFailure(
  () => collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
    baseRef: matrix.baseSha,
    headRef: matrix.headSha,
    metadataMaxBytes: 64
  }),
  "metadata-overflow",
  "metadata capture overflow"
);
console.log("PASS metadata capture overflow fails closed without a fabricated exact count");

const divergentContext = targetContext(divergent.repoRoot);
const directResult = await collectGitDiffRangeMetadata(divergentContext.config, divergentContext.guard, divergentContext.workspace, {
  baseRef: divergent.leftSha,
  headRef: divergent.rightSha
});
assertMetadataResult(directResult, directDivergent.records, "direct divergent comparison");
assert.notDeepEqual(directDivergent.records, directMergeBase.records, "direct and merge-base raw fixtures unexpectedly matched");
console.log("PASS AC-002 direct two-tree metadata differs from merge-base-to-head metadata in divergent history");

const wrapperDir = path.join(fixtureRoot, "armed-wrapper");
await mkdir(wrapperDir, { recursive: true });
const wrapperPath = path.join(wrapperDir, "git");
await writeFile(
  wrapperPath,
  `#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const logPath = process.env.CODEXPRO_GIT_ARG_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + "\\n");
const child = spawnSync(process.env.CODEXPRO_REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let stdout = child.stdout ?? Buffer.alloc(0);
if (process.env.CODEXPRO_TAMPER === "malformed-name-status" && args.includes("--name-status") && stdout.length > 0) stdout = stdout.subarray(0, stdout.length - 1);
if (process.env.CODEXPRO_TAMPER === "cardinality" && args.includes("--numstat")) stdout = Buffer.alloc(0);
if (process.env.CODEXPRO_TAMPER === "path-order" && args.includes("--numstat")) {
  const nul = stdout.indexOf(0);
  if (nul > 0) {
    const record = Buffer.from(stdout.subarray(0, nul));
    const firstTab = record.indexOf(9);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(9, firstTab + 1);
    if (secondTab > firstTab) {
      stdout = Buffer.concat([record.subarray(0, secondTab + 1), Buffer.from("wrapper-path-mismatch"), stdout.subarray(nul)]);
    }
  }
}
process.stdout.write(stdout);
process.stderr.write(child.stderr ?? Buffer.alloc(0));
process.exit(child.status ?? 1);
`,
  "utf8"
);
await chmod(wrapperPath, 0o755);

async function wrappedMetadata(tamper, label) {
  const logPath = path.join(wrapperDir, `${label}.jsonl`);
  await writeFile(logPath, "", "utf8");
  const previousPath = process.env.PATH;
  const previousLog = process.env.CODEXPRO_GIT_ARG_LOG;
  const previousReal = process.env.CODEXPRO_REAL_GIT;
  const previousTamper = process.env.CODEXPRO_TAMPER;
  process.env.PATH = `${wrapperDir}${path.delimiter}${systemPath}`;
  process.env.CODEXPRO_GIT_ARG_LOG = logPath;
  process.env.CODEXPRO_REAL_GIT = realGit;
  process.env.CODEXPRO_TAMPER = tamper;
  try {
    return await expectTargetFailure(
      () => collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
        baseRef: matrix.baseSha,
        headRef: matrix.headSha
      }),
      tamper === "malformed-name-status" ? "malformed-name-status" : "metadata-mismatch",
      label
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.CODEXPRO_GIT_ARG_LOG;
    else process.env.CODEXPRO_GIT_ARG_LOG = previousLog;
    if (previousReal === undefined) delete process.env.CODEXPRO_REAL_GIT;
    else process.env.CODEXPRO_REAL_GIT = previousReal;
    if (previousTamper === undefined) delete process.env.CODEXPRO_TAMPER;
    else process.env.CODEXPRO_TAMPER = previousTamper;
  }
}

await wrappedMetadata("malformed-name-status", "malformed");
await wrappedMetadata("cardinality", "cardinality");
await wrappedMetadata("path-order", "path-order");
console.log("PASS malformed/cardinality/path-order producer mismatch falsifiers fail closed with bounded typed errors");

const argvLog = path.join(wrapperDir, "argv.jsonl");
await writeFile(argvLog, "", "utf8");
const oldPath = process.env.PATH;
const oldLog = process.env.CODEXPRO_GIT_ARG_LOG;
const oldReal = process.env.CODEXPRO_REAL_GIT;
const oldTamper = process.env.CODEXPRO_TAMPER;
process.env.PATH = `${wrapperDir}${path.delimiter}${systemPath}`;
process.env.CODEXPRO_GIT_ARG_LOG = argvLog;
process.env.CODEXPRO_REAL_GIT = realGit;
delete process.env.CODEXPRO_TAMPER;
try {
  const wrappedResult = await collectGitDiffRangeMetadata(matrixContext.config, matrixContext.guard, matrixContext.workspace, {
    baseRef: matrix.baseSha,
    headRef: matrix.headSha
  });
  assertMetadataResult(wrappedResult, matrixRaw.records, "armed real Git producer");
} finally {
  if (oldPath === undefined) delete process.env.PATH;
  else process.env.PATH = oldPath;
  if (oldLog === undefined) delete process.env.CODEXPRO_GIT_ARG_LOG;
  else process.env.CODEXPRO_GIT_ARG_LOG = oldLog;
  if (oldReal === undefined) delete process.env.CODEXPRO_REAL_GIT;
  else process.env.CODEXPRO_REAL_GIT = oldReal;
  if (oldTamper === undefined) delete process.env.CODEXPRO_TAMPER;
  else process.env.CODEXPRO_TAMPER = oldTamper;
}
const argvLines = (await readFile(argvLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const diffArgv = argvLines.filter((args) => args.includes("diff"));
assert.equal(diffArgv.length, 2, "expected one name-status and one numstat diff producer");
for (const args of diffArgv) {
  assert.ok(args.includes("--no-ext-diff"));
  assert.ok(args.includes("--no-textconv"));
  assert.ok(args.includes("--find-renames=50%"));
  assert.ok(args.includes("--find-copies=50%"));
  assert.equal(args.includes("--find-copies-harder"), false);
  assert.ok(args.includes("--no-color"));
  assert.ok(args.includes("-z"));
  assert.ok(args.includes(matrix.baseSha), `producer did not receive captured base SHA: ${JSON.stringify(args)}`);
  assert.ok(args.includes(matrix.headSha), `producer did not receive captured head SHA: ${JSON.stringify(args)}`);
  assert.equal(args.includes("metadata-head"), false);
  assert.equal(args.includes("base-ref"), false);
  assert.equal(args.includes("bash"), false);
  assert.equal(args.includes("legacy"), false);
}
console.log("PASS producer argv evidence: captured full SHAs, fixed -M50%/-C50%, no --find-copies-harder, no shell/legacy route");

console.log("RAW_PRODUCER_FACTS: malformed stream, cardinality, and path-order falsifiers were armed around the real Git executable; target output matched raw records only when both producer streams were intact.");
console.log("EVIDENCE_CONFLICT: none; no direct raw artifact contradicted the accepted metadata outcomes.");
console.log("CONCERNS: invalid UTF-8 coverage is host-dependent in general; this Linux host preserved 0x80 and exercised the fatal path-encoding branch.");
console.log("PASS TASK-002 focused proof complete (task proof only; final mission acceptance remains with Execution Root).");

await rm(fixtureRoot, { recursive: true, force: true });
