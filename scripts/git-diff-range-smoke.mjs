import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

// This smoke owns test fixtures and test-side falsifiers only. The expected
// metadata is derived from direct Git producers below; the compiled target is
// loaded only after the raw-observation sanity pass.
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-diff-range-"));
const systemPath = process.env.PATH ?? "";
const FORBIDDEN_PATCH_LITERALS = [
  "ACTUAL_LITERAL_SECRET_7X9",
  "DELETED_LITERAL_SECRET_8Y4",
  "CONTEXT_LITERAL_SECRET_9Z5",
  "RENAMED_LITERAL_SECRET_6Q2",
  "COPIED_LITERAL_SECRET_5P1",
  "BLOCKED_LITERAL_SECRET_4N8",
  "BINARY_LITERAL_SECRET_3M7"
];
const OBSERVATION_UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
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

function directPatch(repoRoot, base, head, record, contextLines = 3) {
  const pathValues = [...new Set([record.oldPath, record.newPath].filter((value) => value !== null))];
  assert.ok(pathValues.length > 0, "raw patch producer received a pathless metadata record");
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    `-U${contextLines}`,
    "--find-renames=50%",
    "--find-copies=50%",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    base,
    head,
    "--",
    ...pathValues.map((value) => `:(literal)${value}`)
  ];
  const result = directGit(repoRoot, args);
  assert.equal(result.status, 0, `direct patch producer failed: ${result.stderr.toString("utf8")}`);
  return { bytes: result.stdout, args };
}

function splitRawPatchFragments(bytes, label) {
  let text;
  try {
    text = OBSERVATION_UTF8_FATAL.decode(bytes);
  } catch {
    assert.fail(`${label}: direct raw patch was not valid UTF-8`);
  }
  const starts = [];
  const headerPattern = /^diff --git /gmu;
  let match;
  while ((match = headerPattern.exec(text)) !== null) starts.push(match.index);
  assert.ok(starts.length > 0, `${label}: direct Git emitted no complete patch fragment`);
  assert.equal(starts[0], 0, `${label}: direct Git emitted bytes before the first patch header`);
  const fragments = starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
  for (const fragment of fragments) {
    assert.ok(fragment.startsWith("diff --git "), `${label}: fragment did not start at a diff header`);
    assert.ok(fragment.endsWith("\n"), `${label}: direct fragment did not end on a complete line`);
    assert.equal(/^(?:GIT binary patch|Binary files )/mu.test(fragment), false, `${label}: text record emitted binary payload`);
  }
  assert.equal(Buffer.byteLength(fragments.join(""), "utf8"), bytes.length, `${label}: raw fragments lost bytes`);
  return fragments;
}

function rawFragmentHeaderMatchesRecord(fragment, record) {
  const firstLine = fragment.slice(0, fragment.indexOf("\n")).replace(/\r$/u, "");
  const oldPath = record.oldPath ?? record.newPath;
  const newPath = record.newPath ?? record.oldPath;
  return firstLine === `diff --git a/${oldPath} b/${newPath}`;
}

function rawPatchFragmentForRecord(bytes, record, label) {
  const fragments = splitRawPatchFragments(bytes, label);
  const matching = fragments.filter((fragment) => rawFragmentHeaderMatchesRecord(fragment, record));
  assert.equal(matching.length, 1, `${label}: direct Git did not isolate exactly one requested record fragment`);
  return { fragment: matching[0], fragments };
}

function directBlob(repoRoot, revision, relativePath) {
  const result = directGit(repoRoot, ["show", `${revision}:${relativePath}`]);
  assert.equal(result.status, 0, `direct blob producer failed for ${relativePath}: ${result.stderr.toString("utf8")}`);
  return result.stdout;
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
    ["remotes", ["remote", "-v"]],
    ["worktrees", ["worktree", "list", "--porcelain"]]
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
  // The moving-ref falsifier needs a symbolic branch ref whose deliberate
  // test-side update does not create a reflog entry. Disable automatic ref
  // logs before creating that branch, then restore the exact SHA after the
  // operation. The target must never see this mutation as product state.
  mustGit(repoRoot, ["config", "core.logAllRefUpdates", "false"]);
  const movingHeadRef = "refs/heads/moving-head";
  mustGit(repoRoot, ["update-ref", movingHeadRef, rightSha]);
  await writeFixture(repoRoot, "common.txt", "common dirty in worktree\n");
  await writeFixture(repoRoot, "right-only.txt", "right\nstaged dirty in worktree\n");
  mustGit(repoRoot, ["add", "right-only.txt"]);
  await writeFixture(repoRoot, "moving-ref-untracked.txt", "must remain untracked\n");
  return {
    repoRoot,
    commonSha,
    leftSha,
    rightSha,
    mergeBase,
    movingHeadRef,
    relevantPaths: ["common.txt", "left-only.txt", "right-only.txt", "moving-ref-untracked.txt"]
  };
}

async function makePatchFixture() {
  const repoRoot = path.join(fixtureRoot, "patch");
  await initRepo(repoRoot);
  await writeFixture(repoRoot, "context.py", [
    "context line 0",
    "context line 1",
    "context line 2",
    "context line 4",
    "context line 5",
    "context line 6",
    "context line 7",
    "context line 8",
    "context line 9",
    "context line 10",
    "context line 11",
    "context line 12",
    "context line 13",
    "password = \"CONTEXT_LITERAL_SECRET_9Z5\"",
    "context line 14",
    "old context target",
    ...Array.from({ length: 14 }, (_, index) => `tail context ${index}`),
    "context line final"
  ].join("\n") + "\n");
  await writeFixture(repoRoot, "delete.py", "token = \"DELETED_LITERAL_SECRET_8Y4\"\nkeep = True\n");
  await writeFixture(repoRoot, "rename-source.py", [
    ...Array.from({ length: 10 }, (_, index) => `rename line ${index}`),
    "rename_token = \"RENAMED_LITERAL_SECRET_6Q2\"",
    ...Array.from({ length: 10 }, (_, index) => `rename tail ${index}`)
  ].join("\n") + "\n");
  await writeFixture(repoRoot, "copy-source.py", [
    ...Array.from({ length: 10 }, (_, index) => `copy line ${index}`),
    "copy_token = \"COPIED_LITERAL_SECRET_5P1\"",
    ...Array.from({ length: 10 }, (_, index) => `copy tail ${index}`)
  ].join("\n") + "\n");
  await writeFixture(repoRoot, "binary-secret.bin", Buffer.concat([
    Buffer.from([0, 1, 2, 3]),
    Buffer.from("BINARY_LITERAL_SECRET_3M7", "utf8"),
    Buffer.from([0, 255, 8])
  ]));
  await writeFixture(repoRoot, "type-target", "type target bytes\n");
  await symlink("type-target", path.join(repoRoot, "type-entry"));
  const baseSha = await commitAll(repoRoot, "patch base");

  await writeFixture(repoRoot, "added.py", [
    "def added():",
    "    token = \"ACTUAL_LITERAL_SECRET_7X9\"",
    "    return token",
    ""
  ].join("\n"));
  await unlink(path.join(repoRoot, "delete.py"));
  await writeFixture(repoRoot, "context.py", [
    "context line 0",
    "context line 1",
    "context line 2",
    "context line 4",
    "context line 5",
    "context line 6",
    "context line 7",
    "context line 8",
    "context line 9",
    "context line 10",
    "context line 11",
    "context line 12",
    "context line 13",
    "password = \"CONTEXT_LITERAL_SECRET_9Z5\"",
    "context line 14",
    "new context target",
    ...Array.from({ length: 14 }, (_, index) => `tail context ${index}`),
    "context line final"
  ].join("\n") + "\n");
  await mustGit(repoRoot, ["mv", "rename-source.py", "rename-dest.py"]);
  const renameLines = [
    ...Array.from({ length: 10 }, (_, index) => `rename line ${index}`),
    "rename_token = \"RENAMED_LITERAL_SECRET_6Q2\"",
    "rename changed line",
    ...Array.from({ length: 9 }, (_, index) => `rename tail ${index}`)
  ];
  await writeFixture(repoRoot, "rename-dest.py", renameLines.join("\n") + "\n");
  await writeFixture(repoRoot, "copy-source.py", [
    ...Array.from({ length: 10 }, (_, index) => `copy line ${index}`),
    "copy_token = \"COPIED_LITERAL_SECRET_5P1\"",
    "copy changed line",
    ...Array.from({ length: 9 }, (_, index) => `copy tail ${index}`)
  ].join("\n") + "\n");
  await writeFixture(repoRoot, "copy-dest.py", [
    ...Array.from({ length: 10 }, (_, index) => `copy line ${index}`),
    "copy_token = \"COPIED_LITERAL_SECRET_5P1\"",
    "copy changed line",
    ...Array.from({ length: 9 }, (_, index) => `copy tail ${index}`)
  ].join("\n") + "\n");
  await writeFixture(repoRoot, "binary-secret.bin", Buffer.concat([
    Buffer.from([0, 1, 2, 4]),
    Buffer.from("BINARY_LITERAL_SECRET_3M7", "utf8"),
    Buffer.from([0, 254, 9])
  ]));
  await unlink(path.join(repoRoot, "type-entry"));
  await writeFixture(repoRoot, "type-entry", "type entry is regular now\n");
  await writeFixture(repoRoot, ".env.patch", "blocked = \"BLOCKED_LITERAL_SECRET_4N8\"\n");
  await writeFixture(repoRoot, "odd path/line\nname.py", "odd = harmless\n");
  await writeFixture(repoRoot, "odd path/space name.py", "odd = harmless space\n");
  const headSha = await commitAll(repoRoot, "patch changes");
  await writeFixture(repoRoot, "untracked-patch-sentinel.txt", "must remain untracked\n");
  return {
    repoRoot,
    baseSha,
    headSha,
    blockedPath: ".env.patch",
    binaryPath: "binary-secret.bin",
    relevantPaths: [
      "context.py",
      "delete.py",
      "added.py",
      "rename-source.py",
      "rename-dest.py",
      "copy-source.py",
      "copy-dest.py",
      "binary-secret.bin",
      "type-entry",
      "type-target",
      ".env.patch",
      "odd path/line\nname.py",
      "odd path/space name.py",
      "untracked-patch-sentinel.txt"
    ]
  };
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
const patchFixture = await makePatchFixture();
const matrixRaw = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.headSha);
const matrixRawSameSha = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.baseSha);
const matrixRawAddFilter = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.headSha, "filter-add.txt");
const matrixRawDeleteFilter = directMetadata(matrix.repoRoot, matrix.baseSha, matrix.headSha, "filter-delete.txt");
const directDivergent = directMetadata(divergent.repoRoot, divergent.leftSha, divergent.rightSha);
const directMergeBase = directMetadata(divergent.repoRoot, divergent.mergeBase, divergent.rightSha);
const patchRaw = directMetadata(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.headSha);
const rawPatchFacts = new Map();
for (const record of patchRaw.records.filter((entry) => !entry.binary && entry.status !== "T"
  && !(entry.oldPath ?? entry.newPath ?? "").includes("\n"))) {
  const raw = directPatch(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.headSha, record, 3);
  const selected = rawPatchFragmentForRecord(raw.bytes, record, `raw patch ${record.status}:${record.newPath ?? record.oldPath}`);
  rawPatchFacts.set(rawRecordKey(record), {
    rawBytes: raw.bytes,
    rawText: OBSERVATION_UTF8_FATAL.decode(raw.bytes),
    fragment: selected.fragment,
    fragments: selected.fragments,
    args: raw.args
  });
}
const typeRecord = patchRaw.records.find((record) => record.status === "T");
assert.ok(typeRecord, "direct patch fixture did not produce a type-change record");
const rawTypePatch = directPatch(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.headSha, typeRecord, 3);
const rawTypeFragments = splitRawPatchFragments(rawTypePatch.bytes, "raw type-change patch");
assert.ok(rawTypeFragments.length >= 1, "direct type-change patch did not produce a block");
assert.ok(rawTypeFragments.every((fragment) => fragment.includes("type-entry")), "type-change blocks lost their path identity");
assert.ok(rawTypeFragments.length >= 2, "direct type-change fixture did not produce adjacent delete/add blocks");
assert.ok([...rawPatchFacts.values()].some((fact) => fact.fragments.length > 1), "direct Git did not produce an adjacent/extra block case");
rawPatchFacts.set(rawRecordKey(typeRecord), {
  rawBytes: rawTypePatch.bytes,
  rawText: OBSERVATION_UTF8_FATAL.decode(rawTypePatch.bytes),
  fragment: OBSERVATION_UTF8_FATAL.decode(rawTypePatch.bytes),
  fragments: rawTypeFragments,
  args: rawTypePatch.args
});
const blockedRawPatchRecord = patchRaw.records.find((record) => record.newPath === patchFixture.blockedPath);
assert.ok(blockedRawPatchRecord, "direct patch fixture did not produce a blocked record");
assert.ok(directBlob(patchFixture.repoRoot, patchFixture.headSha, patchFixture.blockedPath).toString("utf8").includes("BLOCKED_LITERAL_SECRET_4N8"));
assert.ok(directBlob(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.binaryPath).includes(Buffer.from("BINARY_LITERAL_SECRET_3M7")));
const patchRawSecretChecks = [
  ["addition", "added.py", "ACTUAL_LITERAL_SECRET_7X9"],
  ["deletion", "delete.py", "DELETED_LITERAL_SECRET_8Y4"],
  ["context", "context.py", "CONTEXT_LITERAL_SECRET_9Z5"],
  ["rename", "rename-dest.py", "RENAMED_LITERAL_SECRET_6Q2"],
  ["copy", "copy-dest.py", "COPIED_LITERAL_SECRET_5P1"]
];
for (const [kind, pathValue, literal] of patchRawSecretChecks) {
  const record = patchRaw.records.find((entry) => entry.oldPath === pathValue || entry.newPath === pathValue);
  assert.ok(record && !record.binary, `direct ${kind} metadata record missing`);
  const fact = rawPatchFacts.get(rawRecordKey(record));
  assert.ok(fact, `direct ${kind} patch fragment was not captured`);
  assert.ok(fact.rawText.includes(literal), `direct ${kind} raw patch did not contain its secret-looking literal`);
}
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
console.log(`RAW_OBSERVATION: direct patch producer yielded ${rawPatchFacts.size} complete target fragments; raw additions/deletions/context/rename/copy fragments contain their secret-looking literals, while blocked and binary source blobs independently contain secrets.`);
console.log("SANITY_VERDICT: MATCH (direct Git facts establish the accepted metadata invariants before target diagnostics or test verdicts are consulted).");

const [{ loadConfig }, { CodexProError, PathGuard, WorkspaceManager }, target, policy] = await Promise.all([
  import("../dist/config.js"),
  import("../dist/guard.js"),
  import("../dist/gitDiffRange.js"),
  import("../scripts/redaction-policy.mjs")
]);
const {
  collectGitDiffRangeMetadata,
  collectGitDiffRangePatch,
  gitDiffRange,
  GitDiffRangeError
} = target;
const { redactUnifiedDiff: policyRedactUnifiedDiff } = policy;

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

const STRUCTURED_RESULT_KEYS = [
  "base_commit_sha",
  "base_ref_input",
  "changed_file_count",
  "changed_files",
  "changed_files_truncated",
  "comparison_mode",
  "eligible_changed_file_count",
  "head_commit_sha",
  "head_ref_input",
  "object_format",
  "patch",
  "patch_bytes",
  "patch_files_included",
  "patch_files_omitted",
  "patch_included",
  "patch_limit",
  "patch_omission_counts",
  "patch_requested",
  "patch_truncated",
  "root",
  "schema_version",
  "warnings",
  "workspace_id",
  "blocked_files_omitted",
  "returned_file_count"
];
const STRUCTURED_CHANGED_FILE_KEYS = ["additions", "binary", "deletions", "new_path", "old_path", "similarity", "status"];
const STRUCTURED_OMISSION_KEYS = ["binary", "blocked", "budget", "disabled", "file_limit", "too_large"];

function publicChangedFile(record) {
  return {
    status: record.status,
    old_path: record.oldPath,
    new_path: record.newPath,
    similarity: record.similarity,
    additions: record.additions,
    deletions: record.deletions,
    binary: record.binary
  };
}

function directRedactedPatch(repoRoot, base, head, records, contextLines = 3) {
  return records.filter((record) => !record.binary).map((record) => {
    const raw = directPatch(repoRoot, base, head, record, contextLines);
    const source = record.status === "T" || (record.oldPath ?? record.newPath ?? "").includes("\n")
      ? OBSERVATION_UTF8_FATAL.decode(raw.bytes)
      : rawPatchFragmentForRecord(raw.bytes, record, `integrated expected ${record.status}:${record.newPath ?? record.oldPath}`).fragment;
    return policyRedactUnifiedDiff(source);
  }).join("");
}

function assertStructuredContract(result, expected, label) {
  const expectedStructuredKeys = expected.path === undefined ? STRUCTURED_RESULT_KEYS : [...STRUCTURED_RESULT_KEYS, "path"];
  assert.deepEqual(Object.keys(result).sort(), [...expectedStructuredKeys].sort(), `${label}: structured key set drifted`);
  assert.equal(result.schema_version, 1, `${label}: schema version drifted`);
  assert.equal(result.workspace_id, expected.workspace.id, `${label}: workspace id drifted`);
  assert.equal(result.root, expected.workspace.root, `${label}: canonical root drifted`);
  assert.equal(result.comparison_mode, "direct-two-tree", `${label}: comparison mode drifted`);
  assert.equal(result.object_format, "sha1", `${label}: object format drifted`);
  assert.equal(result.base_ref_input, expected.baseInput, `${label}: base input was not preserved`);
  assert.equal(result.base_commit_sha, expected.baseSha, `${label}: base SHA was not captured`);
  assert.equal(result.head_ref_input, expected.headInput, `${label}: head input was not preserved`);
  assert.equal(result.head_commit_sha, expected.headSha, `${label}: head SHA was not captured`);
  if (expected.path === undefined) assert.equal(Object.hasOwn(result, "path"), false, `${label}: unexpected path key`);
  else assert.equal(result.path, expected.path, `${label}: historical path was not canonicalized`);

  assert.equal(result.changed_file_count, expected.rawRecords.length, `${label}: raw changed count drifted`);
  assert.equal(result.eligible_changed_file_count, expected.eligibleRecords.length, `${label}: eligible count drifted`);
  assert.equal(result.returned_file_count, expected.returnedRecords.length, `${label}: returned count drifted`);
  assert.deepEqual(result.changed_files, expected.returnedRecords.map(publicChangedFile), `${label}: changed file projection drifted`);
  assert.equal(result.changed_files_truncated, expected.returnedRecords.length < expected.eligibleRecords.length, `${label}: metadata truncation truth drifted`);
  assert.equal(result.blocked_files_omitted, expected.omissionCounts.blocked, `${label}: blocked count drifted`);

  assert.equal(result.patch, expected.patch, `${label}: patch bytes/content drifted from direct raw producer`);
  assert.equal(result.patch_requested, expected.patchRequested, `${label}: patch request truth drifted`);
  assert.equal(result.patch_included, expected.patch.length > 0, `${label}: patch inclusion truth drifted`);
  assert.equal(result.patch_truncated, expected.patchTruncated, `${label}: patch truncation truth drifted`);
  assert.equal(result.patch_bytes, Buffer.byteLength(expected.patch, "utf8"), `${label}: public patch byte count drifted`);
  assert.equal(result.patch_limit, expected.patchLimit, `${label}: patch limit drifted`);
  assert.equal(result.patch_files_included, expected.patchFilesIncluded, `${label}: patch included count drifted`);
  assert.equal(result.patch_files_omitted, Object.values(expected.omissionCounts).reduce((sum, count) => sum + count, 0), `${label}: patch omitted count drifted`);
  assert.deepEqual(Object.keys(result.patch_omission_counts).sort(), [...STRUCTURED_OMISSION_KEYS].sort(), `${label}: omission key set drifted`);
  assert.deepEqual(result.patch_omission_counts, expected.omissionCounts, `${label}: omission classifications drifted`);
  assert.deepEqual(result.warnings, expected.warnings, `${label}: warning set drifted`);
  assert.equal(Object.hasOwn(result, "eligibleChangedFiles"), false, `${label}: internal eligibleChangedFiles leaked`);
  assert.equal(Object.hasOwn(result, "identity"), false, `${label}: internal identity leaked`);
  assert.equal(Object.hasOwn(result, "renameCopyDetectionComplete"), false, `${label}: internal completeness leaked`);
  for (const record of result.changed_files) {
    assert.deepEqual(Object.keys(record).sort(), [...STRUCTURED_CHANGED_FILE_KEYS].sort(), `${label}: changed-file key set drifted`);
  }
  assertNoForbiddenPatchLiterals(result, label);
}

function assertWarningSafety(result, label, forbiddenValues = []) {
  assert.ok(Array.isArray(result.warnings), `${label}: warnings was not an array`);
  const serializedWarnings = JSON.stringify(result.warnings);
  for (const value of [".env.patch", ...forbiddenValues, ...FORBIDDEN_PATCH_LITERALS]) {
    assert.equal(serializedWarnings.includes(value), false, `${label}: warning leaked ${JSON.stringify(value)}`);
  }
}

function assertTargetFailure(error, reason, label) {
  assert.ok(error instanceof GitDiffRangeError, `${label}: expected GitDiffRangeError, got ${error?.constructor?.name ?? typeof error}`);
  assert.equal(error.reason, reason, `${label}: wrong failure reason`);
  assert.ok(error.message.length < 180, `${label}: failure message is not bounded`);
  assert.equal(Object.hasOwn(error, "stdout"), false, `${label}: raw stdout escaped failure`);
  assert.equal(Object.hasOwn(error, "stderr"), false, `${label}: raw stderr escaped failure`);
  assert.equal(error.message.includes(".env"), false, `${label}: blocked path leaked in failure`);
  const serialized = JSON.stringify(error);
  for (const literal of FORBIDDEN_PATCH_LITERALS) {
    assert.equal(serialized.includes(literal), false, `${label}: forbidden literal leaked in typed error`);
  }
  return error;
}

function assertNoForbiddenPatchLiterals(value, label) {
  const serialized = JSON.stringify(value);
  for (const literal of FORBIDDEN_PATCH_LITERALS) {
    assert.equal(serialized.includes(literal), false, `${label}: forbidden literal ${literal} leaked`);
  }
}

async function expectTargetFailure(operation, reason, label) {
  try {
    await operation();
    assert.fail(`${label}: expected ${reason}`);
  } catch (error) {
    return assertTargetFailure(error, reason, label);
  }
}

const integratedDivergentContext = targetContext(divergent.repoRoot);
const integratedDivergentBefore = await repositoryState(divergent.repoRoot, divergent.relevantPaths);
const integratedDirectExpectedPatch = directRedactedPatch(
  divergent.repoRoot,
  divergent.leftSha,
  divergent.rightSha,
  directDivergent.records
);
const integratedDirectResult = await gitDiffRange(
  integratedDivergentContext.config,
  integratedDivergentContext.guard,
  integratedDivergentContext.workspace,
  { baseRef: "left", headRef: "right", includePatch: true }
);
const integratedDivergentAfter = await repositoryState(divergent.repoRoot, divergent.relevantPaths);
assert.deepEqual(integratedDivergentAfter, integratedDivergentBefore, "integrated direct operation changed repository state");
assertStructuredContract(integratedDirectResult, {
  workspace: integratedDivergentContext.workspace,
  baseInput: "left",
  baseSha: divergent.leftSha,
  headInput: "right",
  headSha: divergent.rightSha,
  rawRecords: directDivergent.records,
  eligibleRecords: directDivergent.records,
  returnedRecords: directDivergent.records,
  patch: integratedDirectExpectedPatch,
  patchRequested: true,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: directDivergent.records.filter((record) => !record.binary).length,
  omissionCounts: { blocked: 0, binary: 0, budget: 0, too_large: 0, file_limit: 0, disabled: 0 },
  warnings: []
}, "integrated direct divergent result");
assert.notDeepEqual(integratedDirectResult.changed_files, directMergeBase.records.map(publicChangedFile), "integrated operation silently used merge-base semantics");
console.log("PASS AP-007 integrated exported operation returns direct base-tip to head-tip metadata/patch, not implicit merge-base semantics");

const integratedMergeResult = await gitDiffRange(
  integratedDivergentContext.config,
  integratedDivergentContext.guard,
  integratedDivergentContext.workspace,
  { baseRef: divergent.mergeBase, headRef: divergent.rightSha, includePatch: false }
);
assertStructuredContract(integratedMergeResult, {
  workspace: integratedDivergentContext.workspace,
  baseInput: divergent.mergeBase,
  baseSha: divergent.mergeBase,
  headInput: divergent.rightSha,
  headSha: divergent.rightSha,
  rawRecords: directMergeBase.records,
  eligibleRecords: directMergeBase.records,
  returnedRecords: directMergeBase.records,
  patch: "",
  patchRequested: false,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: 0,
  omissionCounts: { blocked: 0, binary: 0, budget: 0, too_large: 0, file_limit: 0, disabled: directMergeBase.records.filter((record) => !record.binary).length },
  warnings: ["Patch generation was disabled by request."]
}, "explicit merge-base composition result");
console.log("PASS explicit merge-base SHA composition produces the PR-style result with truthful disabled-patch warning");

const integratedSameShaContext = targetContext(matrix.repoRoot);
const integratedSameSha = await gitDiffRange(
  integratedSameShaContext.config,
  integratedSameShaContext.guard,
  integratedSameShaContext.workspace,
  { baseRef: matrix.baseSha, headRef: matrix.baseSha, includePatch: false }
);
assertStructuredContract(integratedSameSha, {
  workspace: integratedSameShaContext.workspace,
  baseInput: matrix.baseSha,
  baseSha: matrix.baseSha,
  headInput: matrix.baseSha,
  headSha: matrix.baseSha,
  rawRecords: [],
  eligibleRecords: [],
  returnedRecords: [],
  patch: "",
  patchRequested: false,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: 0,
  omissionCounts: { blocked: 0, binary: 0, budget: 0, too_large: 0, file_limit: 0, disabled: 0 },
  warnings: []
}, "integrated same-SHA result");
const integratedFilterRaw = matrixRawAddFilter.records;
const integratedFilter = await gitDiffRange(
  integratedSameShaContext.config,
  integratedSameShaContext.guard,
  integratedSameShaContext.workspace,
  { baseRef: matrix.baseSha, headRef: matrix.headSha, path: "filter-add.txt", includePatch: false }
);
assertStructuredContract(integratedFilter, {
  workspace: integratedSameShaContext.workspace,
  baseInput: matrix.baseSha,
  baseSha: matrix.baseSha,
  headInput: matrix.headSha,
  headSha: matrix.headSha,
  path: "filter-add.txt",
  rawRecords: integratedFilterRaw,
  eligibleRecords: integratedFilterRaw,
  returnedRecords: integratedFilterRaw,
  patch: "",
  patchRequested: false,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: 0,
  omissionCounts: { blocked: 0, binary: 0, budget: 0, too_large: 0, file_limit: 0, disabled: integratedFilterRaw.filter((record) => !record.binary).length },
  warnings: integratedFilterRaw.some((record) => !record.binary) ? ["Patch generation was disabled by request."] : []
}, "integrated historical path-filter result");
console.log("PASS integrated same-SHA zero result and historical old/new path-filter contract");

const integratedPatchContext = targetContext(patchFixture.repoRoot);
const integratedPatchEligible = patchRaw.records.filter((record) => record.oldPath !== patchFixture.blockedPath && record.newPath !== patchFixture.blockedPath);
const integratedPatchText = directRedactedPatch(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.headSha, integratedPatchEligible);
const integratedPatchResult = await gitDiffRange(
  integratedPatchContext.config,
  integratedPatchContext.guard,
  integratedPatchContext.workspace,
  { baseRef: patchFixture.baseSha, headRef: patchFixture.headSha, includePatch: true, maxFiles: 200 }
);
assertStructuredContract(integratedPatchResult, {
  workspace: integratedPatchContext.workspace,
  baseInput: patchFixture.baseSha,
  baseSha: patchFixture.baseSha,
  headInput: patchFixture.headSha,
  headSha: patchFixture.headSha,
  rawRecords: patchRaw.records,
  eligibleRecords: integratedPatchEligible,
  returnedRecords: integratedPatchEligible,
  patch: integratedPatchText,
  patchRequested: true,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: integratedPatchEligible.filter((record) => !record.binary).length,
  omissionCounts: {
    blocked: patchRaw.records.length - integratedPatchEligible.length,
    binary: integratedPatchEligible.filter((record) => record.binary).length,
    budget: 0,
    too_large: 0,
    file_limit: 0,
    disabled: 0
  },
  warnings: ["Blocked changed records were omitted from patch evidence.", "Binary changed records were omitted from patch payload."]
}, "integrated blocked/binary warning result");
assertWarningSafety(integratedPatchResult, "integrated blocked/binary warnings", [patchFixture.blockedPath, patchFixture.binaryPath]);
console.log("PASS integrated blocked/binary omissions and warning truth contain no blocked path/source leakage");

const integratedLimitedRecords = integratedPatchEligible.slice(0, 2);
const integratedLimitedResult = await gitDiffRange(
  integratedPatchContext.config,
  integratedPatchContext.guard,
  integratedPatchContext.workspace,
  { baseRef: patchFixture.baseSha, headRef: patchFixture.headSha, includePatch: false, maxFiles: 2 }
);
const integratedLimitedWarnings = [
  "Blocked changed records were omitted from patch evidence.",
  "Patch evidence omits records beyond the max_files prefix.",
  ...(integratedLimitedRecords.some((record) => record.binary) ? ["Binary changed records were omitted from patch payload."] : []),
  ...(integratedLimitedRecords.some((record) => !record.binary) ? ["Patch generation was disabled by request."] : []),
  "Changed-file metadata was truncated to the max_files prefix."
];
assertStructuredContract(integratedLimitedResult, {
  workspace: integratedPatchContext.workspace,
  baseInput: patchFixture.baseSha,
  baseSha: patchFixture.baseSha,
  headInput: patchFixture.headSha,
  headSha: patchFixture.headSha,
  rawRecords: patchRaw.records,
  eligibleRecords: integratedPatchEligible,
  returnedRecords: integratedLimitedRecords,
  patch: "",
  patchRequested: false,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: 0,
  omissionCounts: {
    blocked: patchRaw.records.length - integratedPatchEligible.length,
    binary: integratedLimitedRecords.filter((record) => record.binary).length,
    budget: 0,
    too_large: 0,
    file_limit: integratedPatchEligible.length - integratedLimitedRecords.length,
    disabled: integratedLimitedRecords.filter((record) => !record.binary).length
  },
  warnings: integratedLimitedWarnings
}, "integrated max_files warning result");
assertWarningSafety(integratedLimitedResult, "integrated max_files warnings", [patchFixture.blockedPath, patchFixture.binaryPath]);
console.log("PASS integrated max_files truncation, disabled, binary, blocked warning counts and metadata prefix truth");

const integratedAddedRecord = patchRaw.records.find((record) => record.newPath === "added.py");
assert.ok(integratedAddedRecord, "integrated budget fixture missing added.py record");
const integratedAddedPatch = directRedactedPatch(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.headSha, [integratedAddedRecord]);
const integratedBudgetResult = await gitDiffRange(
  integratedPatchContext.config,
  integratedPatchContext.guard,
  integratedPatchContext.workspace,
  {
    baseRef: patchFixture.baseSha,
    headRef: patchFixture.headSha,
    path: "added.py",
    maxPatchBytes: Buffer.byteLength(integratedAddedPatch, "utf8") - 1
  }
);
assertStructuredContract(integratedBudgetResult, {
  workspace: integratedPatchContext.workspace,
  baseInput: patchFixture.baseSha,
  baseSha: patchFixture.baseSha,
  headInput: patchFixture.headSha,
  headSha: patchFixture.headSha,
  path: "added.py",
  rawRecords: [integratedAddedRecord],
  eligibleRecords: [integratedAddedRecord],
  returnedRecords: [integratedAddedRecord],
  patch: "",
  patchRequested: true,
  patchTruncated: true,
  patchLimit: Buffer.byteLength(integratedAddedPatch, "utf8") - 1,
  patchFilesIncluded: 0,
  omissionCounts: { blocked: 0, binary: 0, budget: 1, too_large: 0, file_limit: 0, disabled: 0 },
  warnings: ["Patch evidence stopped before the next complete fragment at the public byte limit."]
}, "integrated budget warning result");
assertWarningSafety(integratedBudgetResult, "integrated budget warning", ["added.py", patchFixture.baseSha, patchFixture.headSha]);

const integratedTooLargeResult = await gitDiffRange(
  integratedPatchContext.config,
  integratedPatchContext.guard,
  integratedPatchContext.workspace,
  { baseRef: patchFixture.baseSha, headRef: patchFixture.headSha, path: "added.py", patchFragmentMaxBytes: 1 }
);
assertStructuredContract(integratedTooLargeResult, {
  workspace: integratedPatchContext.workspace,
  baseInput: patchFixture.baseSha,
  baseSha: patchFixture.baseSha,
  headInput: patchFixture.headSha,
  headSha: patchFixture.headSha,
  path: "added.py",
  rawRecords: [integratedAddedRecord],
  eligibleRecords: [integratedAddedRecord],
  returnedRecords: [integratedAddedRecord],
  patch: "",
  patchRequested: true,
  patchTruncated: true,
  patchLimit: 60_000,
  patchFilesIncluded: 0,
  omissionCounts: { blocked: 0, binary: 0, budget: 0, too_large: 1, file_limit: 0, disabled: 0 },
  warnings: ["Patch evidence stopped at a fragment beyond the bounded acquisition limit."]
}, "integrated too-large warning result");
assertWarningSafety(integratedTooLargeResult, "integrated too-large warning", ["added.py", patchFixture.baseSha, patchFixture.headSha]);
console.log("PASS integrated budget and too_large warnings are truthful, bounded, and source/ref-literal free");

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
if (process.env.CODEXPRO_TAMPER === "patch-header" && args.includes("--patch") && stdout.length > 0) {
  const text = stdout.toString("utf8");
  stdout = Buffer.from(text.replace(/^diff --git [^\\n]*$/mu, "diff --git a/wrong-target b/wrong-target"), "utf8");
}
process.stdout.write(stdout);
process.stderr.write(child.stderr ?? Buffer.alloc(0));
const movingRef = process.env.CODEXPRO_MOVE_REF;
const movingTarget = process.env.CODEXPRO_MOVE_TO;
const resolutionMarker = process.env.CODEXPRO_MOVE_RESOLUTION_MARKER;
const resolutionArg = movingRef === undefined ? undefined : movingRef + "^{commit}";
const endpointResolution = child.status === 0 && args.includes("--verify") && args.some((arg) => arg.endsWith("^{commit}"));
if (endpointResolution && movingRef && movingTarget && resolutionArg !== undefined && args.includes(resolutionArg)) {
  if (resolutionMarker) {
    const waitStarted = Date.now();
    while (!fs.existsSync(resolutionMarker) && Date.now() - waitStarted < 10_000) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    if (!fs.existsSync(resolutionMarker)) process.exit(1);
  }
  const move = spawnSync(process.env.CODEXPRO_REAL_GIT, ["update-ref", movingRef, movingTarget], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (move.status !== 0) process.exit(move.status ?? 1);
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(["__deliberate_ref_move__", movingRef, movingTarget]) + "\\n");
} else if (endpointResolution && resolutionMarker) {
  fs.writeFileSync(resolutionMarker, "resolved\\n");
}
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

async function withArmedGit(tamper, label, operation) {
  const logPath = path.join(wrapperDir, `${label}.jsonl`);
  await writeFile(logPath, "", "utf8");
  const previousPath = process.env.PATH;
  const previousLog = process.env.CODEXPRO_GIT_ARG_LOG;
  const previousReal = process.env.CODEXPRO_REAL_GIT;
  const previousTamper = process.env.CODEXPRO_TAMPER;
  process.env.PATH = `${wrapperDir}${path.delimiter}${systemPath}`;
  process.env.CODEXPRO_GIT_ARG_LOG = logPath;
  process.env.CODEXPRO_REAL_GIT = realGit;
  if (tamper === undefined) delete process.env.CODEXPRO_TAMPER;
  else process.env.CODEXPRO_TAMPER = tamper;
  try {
    return await operation(logPath);
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

async function readLoggedArgs(logPath) {
  return (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function withMovingRef(label, operation) {
  const logPath = path.join(wrapperDir, `${label}.jsonl`);
  const resolutionMarker = path.join(wrapperDir, `${label}-resolutions.marker`);
  await writeFile(logPath, "", "utf8");
  try {
    await unlink(resolutionMarker);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const previousPath = process.env.PATH;
  const previousLog = process.env.CODEXPRO_GIT_ARG_LOG;
  const previousReal = process.env.CODEXPRO_REAL_GIT;
  const previousTamper = process.env.CODEXPRO_TAMPER;
  const previousMoveRef = process.env.CODEXPRO_MOVE_REF;
  const previousMoveTo = process.env.CODEXPRO_MOVE_TO;
  const previousMarker = process.env.CODEXPRO_MOVE_RESOLUTION_MARKER;
  process.env.PATH = `${wrapperDir}${path.delimiter}${systemPath}`;
  process.env.CODEXPRO_GIT_ARG_LOG = logPath;
  process.env.CODEXPRO_REAL_GIT = realGit;
  delete process.env.CODEXPRO_TAMPER;
  process.env.CODEXPRO_MOVE_REF = divergent.movingHeadRef;
  process.env.CODEXPRO_MOVE_TO = divergent.commonSha;
  process.env.CODEXPRO_MOVE_RESOLUTION_MARKER = resolutionMarker;
  try {
    return await operation(logPath, resolutionMarker);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.CODEXPRO_GIT_ARG_LOG;
    else process.env.CODEXPRO_GIT_ARG_LOG = previousLog;
    if (previousReal === undefined) delete process.env.CODEXPRO_REAL_GIT;
    else process.env.CODEXPRO_REAL_GIT = previousReal;
    if (previousTamper === undefined) delete process.env.CODEXPRO_TAMPER;
    else process.env.CODEXPRO_TAMPER = previousTamper;
    if (previousMoveRef === undefined) delete process.env.CODEXPRO_MOVE_REF;
    else process.env.CODEXPRO_MOVE_REF = previousMoveRef;
    if (previousMoveTo === undefined) delete process.env.CODEXPRO_MOVE_TO;
    else process.env.CODEXPRO_MOVE_TO = previousMoveTo;
    if (previousMarker === undefined) delete process.env.CODEXPRO_MOVE_RESOLUTION_MARKER;
    else process.env.CODEXPRO_MOVE_RESOLUTION_MARKER = previousMarker;
  }
}

const movingBefore = await repositoryState(divergent.repoRoot, divergent.relevantPaths);
let movingRun;
try {
  movingRun = await withMovingRef("moving-ref", async (logPath) => {
    const result = await gitDiffRange(
      integratedDivergentContext.config,
      integratedDivergentContext.guard,
      integratedDivergentContext.workspace,
      { baseRef: "left", headRef: divergent.movingHeadRef, includePatch: true }
    );
    const stateWhileMoved = await repositoryState(divergent.repoRoot, divergent.relevantPaths);
    return { result, stateWhileMoved, entries: await readLoggedArgs(logPath) };
  });
} finally {
  // This is deliberate fixture cleanup, not a product write. The ref was
  // created with reflogs disabled, so restoring it must return every snapshot
  // dimension exactly to its pre-test value.
  mustGit(divergent.repoRoot, ["update-ref", divergent.movingHeadRef, divergent.rightSha]);
}
const movingAfter = await repositoryState(divergent.repoRoot, divergent.relevantPaths);
assert.deepEqual(movingAfter, movingBefore, "moving-ref operation changed repository state after deliberate ref restoration");
const refsBeforeMove = Buffer.from(movingBefore.commandFacts.refs.stdout, "base64").toString("utf8");
const refsWhileMoved = Buffer.from(movingRun.stateWhileMoved.commandFacts.refs.stdout, "base64").toString("utf8");
assert.ok(refsBeforeMove.includes(`${divergent.movingHeadRef}\u0000${divergent.rightSha}`), "moving-ref baseline did not contain its original SHA");
assert.ok(refsWhileMoved.includes(`${divergent.movingHeadRef}\u0000${divergent.commonSha}`), "moving-ref harness did not physically move the branch ref");
assert.notEqual(refsWhileMoved, refsBeforeMove, "moving-ref harness state did not differ while the deliberate move was armed");
for (const [name, facts] of Object.entries(movingBefore.commandFacts)) {
  if (name === "refs") continue;
  assert.deepEqual(movingRun.stateWhileMoved.commandFacts[name], facts, `moving-ref operation changed ${name} beyond deliberate ref mutation`);
}
assert.deepEqual(movingRun.stateWhileMoved.files, movingBefore.files, "moving-ref operation changed tracked/untracked file bytes");
const moveIndex = movingRun.entries.findIndex((entry) => Array.isArray(entry) && entry[0] === "__deliberate_ref_move__");
assert.ok(moveIndex >= 0, "moving-ref harness did not physically move its symbolic ref");
const resolutionIndices = movingRun.entries
  .map((entry, index) => [entry, index])
  .filter(([entry]) => Array.isArray(entry) && entry.includes("--verify"))
  .map(([, index]) => index);
assert.equal(resolutionIndices.length, 2, "moving-ref harness did not observe exactly one resolution per endpoint");
assert.ok(resolutionIndices.every((index) => index < moveIndex), "moving-ref harness moved the ref before both endpoint resolutions completed");
const downstreamDiffIndices = movingRun.entries
  .map((entry, index) => [entry, index])
  .filter(([entry]) => Array.isArray(entry) && entry.includes("diff"))
  .map(([, index]) => index);
assert.ok(downstreamDiffIndices.length >= 2, "moving-ref harness did not observe metadata diff producers");
assert.ok(downstreamDiffIndices.every((index) => index > moveIndex), "moving-ref harness moved the ref after downstream diff started");
const movingDiffArgs = movingRun.entries.filter((entry) => Array.isArray(entry) && entry.includes("diff"));
for (const args of movingDiffArgs) {
  assert.ok(args.includes(divergent.leftSha), `moving-ref metadata producer lost captured base SHA: ${JSON.stringify(args)}`);
  assert.ok(args.includes(divergent.rightSha), `moving-ref metadata producer lost captured head SHA: ${JSON.stringify(args)}`);
  assert.equal(args.includes(divergent.movingHeadRef), false, "moving-ref metadata producer received symbolic head ref");
  assert.equal(args.includes(divergent.commonSha), false, "moving-ref metadata producer followed moved ref");
}
assertStructuredContract(movingRun.result, {
  workspace: integratedDivergentContext.workspace,
  baseInput: "left",
  baseSha: divergent.leftSha,
  headInput: divergent.movingHeadRef,
  headSha: divergent.rightSha,
  rawRecords: directDivergent.records,
  eligibleRecords: directDivergent.records,
  returnedRecords: directDivergent.records,
  patch: integratedDirectExpectedPatch,
  patchRequested: true,
  patchTruncated: false,
  patchLimit: 60_000,
  patchFilesIncluded: directDivergent.records.filter((record) => !record.binary).length,
  omissionCounts: { blocked: 0, binary: 0, budget: 0, too_large: 0, file_limit: 0, disabled: 0 },
  warnings: []
}, "moving-ref pinned result");
console.log("PASS AP-007 moving-ref falsifier: two endpoint resolutions precede deliberate branch move, downstream args use captured full SHAs, output remains original comparison");

function expectedRedactedRecord(record, contextLines = 3) {
  const raw = directPatch(patchFixture.repoRoot, patchFixture.baseSha, patchFixture.headSha, record, contextLines);
  const source = record.status === "T" || (record.oldPath ?? record.newPath ?? "").includes("\n")
    ? OBSERVATION_UTF8_FATAL.decode(raw.bytes)
    : rawPatchFragmentForRecord(raw.bytes, record, `expected redaction ${record.status}:${record.newPath ?? record.oldPath}`).fragment;
  return {
    rawBytes: raw.bytes.length,
    redacted: policyRedactUnifiedDiff(source),
    source
  };
}

const patchContext = targetContext(patchFixture.repoRoot);
const patchBefore = await repositoryState(patchFixture.repoRoot, patchFixture.relevantPaths);
const patchMetadata = await collectGitDiffRangeMetadata(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  maxFiles: 200
});
const patchAfterMetadata = await repositoryState(patchFixture.repoRoot, patchFixture.relevantPaths);
const patchRawEligible = patchRaw.records.filter((record) => record.oldPath !== patchFixture.blockedPath && record.newPath !== patchFixture.blockedPath);
assert.deepEqual(patchMetadata.eligibleChangedFiles, patchRawEligible, "patch metadata diverged from direct raw producer");
assert.equal(patchMetadata.changedFileCount, patchRaw.records.length);
assert.equal(patchMetadata.eligibleChangedFileCount, patchRawEligible.length);
assert.equal(patchMetadata.blockedFilesOmitted, patchRaw.records.length - patchRawEligible.length);
assert.deepEqual(patchAfterMetadata, patchBefore, "metadata phase changed patch fixture state");

const patchExpectedByKey = new Map();
for (const record of patchRawEligible.filter((entry) => !entry.binary)) {
  patchExpectedByKey.set(rawRecordKey(record), expectedRedactedRecord(record));
}
const patchExpectedTextRecords = patchMetadata.changedFiles.filter((record) => !record.binary);
const patchExpectedText = patchExpectedTextRecords.map((record) => patchExpectedByKey.get(rawRecordKey(record)).redacted).join("");
const patchResult = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  maxFiles: 200,
  includePatch: true
});
assert.equal(patchResult.patch, patchExpectedText, "target patch did not preserve the direct complete-fragment prefix");
assert.equal(patchResult.patchBytes, Buffer.byteLength(patchExpectedText, "utf8"));
assert.equal(patchResult.patchFilesIncluded, patchExpectedTextRecords.length);
assert.equal(patchResult.patchFilesOmitted, patchRaw.records.length - patchExpectedTextRecords.length);
assert.deepEqual(patchResult.patchOmissionCounts, {
  blocked: patchRaw.records.length - patchRawEligible.length,
  binary: patchRawEligible.filter((record) => record.binary).length,
  budget: 0,
  tooLarge: 0,
  fileLimit: 0,
  disabled: 0
});
assert.equal(patchResult.patchFilesIncluded + patchResult.patchFilesOmitted, patchResult.changedFileCount);
assertNoForbiddenPatchLiterals(patchResult, "complete redacted patch result");
assert.equal(JSON.stringify(patchResult).includes(patchFixture.blockedPath), false, "blocked path leaked from patch result");
const patchAfter = await repositoryState(patchFixture.repoRoot, patchFixture.relevantPaths);
assert.deepEqual(patchAfter, patchBefore, "patch operation changed HEAD/refs/index/worktree/config state");
console.log("PASS AP-005 raw complete-fragment acquisition, redaction, deterministic order, binary/blocked omissions, and read-only state");

const contextRecord = patchMetadata.changedFiles.find((record) => record.newPath === "context.py");
assert.ok(contextRecord, "context fixture metadata record missing");
const expectedContext0 = expectedRedactedRecord(contextRecord, 0);
const expectedContext3 = expectedRedactedRecord(contextRecord, 3);
const expectedContext20 = expectedRedactedRecord(contextRecord, 20);
assert.notEqual(expectedContext0.redacted, expectedContext3.redacted, "context_lines 0 and 3 did not change direct raw evidence");
assert.notEqual(expectedContext3.redacted, expectedContext20.redacted, "context_lines 3 and 20 did not change direct raw evidence");
const context0 = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  path: "context.py",
  contextLines: 0
});
const contextDefault = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  path: "context.py"
});
const context20 = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  path: "context.py",
  contextLines: 20
});
assert.equal(context0.patch, expectedContext0.redacted);
assert.equal(contextDefault.patch, expectedContext3.redacted);
assert.equal(context20.patch, expectedContext20.redacted);
assert.equal(context0.patch.includes("CONTEXT_LITERAL_SECRET_9Z5"), false);
assert.equal(contextDefault.patch.includes("CONTEXT_LITERAL_SECRET_9Z5"), false);
assert.equal(context20.patch.includes("CONTEXT_LITERAL_SECRET_9Z5"), false);
console.log("PASS context_lines 0/default 3/max 20 use explicit direct-Git context and preserve redaction");

const addedRecord = patchMetadata.changedFiles.find((record) => record.newPath === "added.py");
assert.ok(addedRecord, "added fixture metadata record missing");
const addedExpected = expectedRedactedRecord(addedRecord);
assert.notEqual(addedExpected.rawBytes, Buffer.byteLength(addedExpected.redacted, "utf8"), "redaction did not change fragment byte length");
const exactFit = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  path: "added.py",
  maxPatchBytes: Buffer.byteLength(addedExpected.redacted, "utf8")
});
assert.equal(exactFit.patch, addedExpected.redacted);
assert.equal(exactFit.patchBytes, Buffer.byteLength(addedExpected.redacted, "utf8"));
assert.equal(exactFit.patchTruncated, false);
const oneByteUnder = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  path: "added.py",
  maxPatchBytes: Math.max(0, Buffer.byteLength(addedExpected.redacted, "utf8") - 1)
});
assert.equal(oneByteUnder.patch, "");
assert.equal(oneByteUnder.patchBytes, 0);
assert.equal(oneByteUnder.patchTruncated, true);
assert.equal(oneByteUnder.patchOmissionCounts.budget, 1);
assert.equal(oneByteUnder.patchFilesIncluded, 0);
assert.equal(oneByteUnder.patchFilesOmitted, 1);
console.log("PASS exact whole-redacted-fragment fit, one-byte-under no partial emission, and final-redacted-byte budgeting");

const firstTwoText = patchExpectedTextRecords.slice(0, 2);
assert.equal(firstTwoText.length, 2, "patch fixture did not provide two text records for prefix budget proof");
const firstTwoExpected = firstTwoText.map((record) => patchExpectedByKey.get(rawRecordKey(record)).redacted);
const twoFilePrefix = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  maxPatchBytes: Buffer.byteLength(firstTwoExpected[0], "utf8")
});
assert.equal(twoFilePrefix.patch, firstTwoExpected[0]);
assert.equal(twoFilePrefix.patchFilesIncluded, 1);
assert.equal(twoFilePrefix.patchOmissionCounts.budget, patchExpectedTextRecords.length - 1);
assert.equal(twoFilePrefix.patchTruncated, true);
assert.equal(twoFilePrefix.patchFilesIncluded + twoFilePrefix.patchFilesOmitted, twoFilePrefix.changedFileCount);
console.log("PASS two-file budget returns exactly the first complete fragment and truthful budget suffix count");

const limitedPatch = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  maxFiles: 2
});
assert.equal(limitedPatch.changedFiles.length, 2);
assert.equal(limitedPatch.changedFilesTruncated, true);
assert.equal(limitedPatch.patchOmissionCounts.fileLimit, patchMetadata.eligibleChangedFileCount - 2);
assert.equal(limitedPatch.patchFilesIncluded + limitedPatch.patchFilesOmitted, limitedPatch.changedFileCount);
console.log("PASS max_files file-limit omission is mutually exhaustive with binary/blocked patch classifications");

const disabledArmed = await withArmedGit(undefined, "patch-disabled", async (logPath) => {
  const result = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
    baseRef: patchFixture.baseSha,
    headRef: patchFixture.headSha,
    includePatch: false
  });
  return { result, args: await readLoggedArgs(logPath) };
});
const disabledDiffArgs = disabledArmed.args.filter((args) => args.includes("diff"));
assert.equal(disabledDiffArgs.some((args) => args.includes("--patch")), false, "include_patch=false armed a patch producer");
assert.equal(disabledDiffArgs.length, 2, "include_patch=false did not run exactly the two metadata producers");
assert.equal(disabledArmed.result.patch, "");
assert.equal(disabledArmed.result.patchRequested, false);
assert.equal(disabledArmed.result.patchIncluded, false);
assert.equal(disabledArmed.result.patchOmissionCounts.disabled, patchExpectedTextRecords.length);
assert.equal(disabledArmed.result.patchOmissionCounts.binary, patchRawEligible.filter((record) => record.binary).length);
assert.equal(disabledArmed.result.patchOmissionCounts.blocked, patchRaw.records.length - patchRawEligible.length);
assert.equal(disabledArmed.result.patchFilesOmitted, disabledArmed.result.changedFileCount);
assertNoForbiddenPatchLiterals(disabledArmed.result, "disabled patch result");
console.log("PASS AP-006 include_patch=false runs metadata producers only and truthfully classifies disabled/binary/blocked records");

const tooLargeArmed = await withArmedGit(undefined, "patch-too-large", async (logPath) => {
  const result = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
    baseRef: patchFixture.baseSha,
    headRef: patchFixture.headSha,
    patchFragmentMaxBytes: 1
  });
  return { result, args: await readLoggedArgs(logPath) };
});
const tooLargePatchArgs = tooLargeArmed.args.filter((args) => args.includes("--patch"));
const tooLargeTextCount = patchExpectedTextRecords.length;
assert.equal(tooLargePatchArgs.length, 1, "fragment acquisition overflow did not stop at the first text record");
assert.equal(tooLargeArmed.result.patch, "");
assert.equal(tooLargeArmed.result.patchBytes, 0);
assert.equal(tooLargeArmed.result.patchTruncated, true);
assert.equal(tooLargeArmed.result.patchOmissionCounts.tooLarge, tooLargeTextCount);
assert.equal(tooLargeArmed.result.patchOmissionCounts.budget, 0);
assert.equal(tooLargeArmed.result.patchFilesIncluded, 0);
assert.equal(tooLargeArmed.result.patchFilesIncluded + tooLargeArmed.result.patchFilesOmitted, tooLargeArmed.result.changedFileCount);
assertNoForbiddenPatchLiterals(tooLargeArmed.result, "too-large patch result");
console.log("PASS fragment acquisition overflow emits no partial raw bytes and reports deterministic too_large suffix counts");

const invalidPatchCases = [
  ["invalid include_patch", "invalid-input", { includePatch: "yes" }],
  ["invalid max_patch_bytes", "invalid-limit", { maxPatchBytes: 100_001 }],
  ["invalid context_lines", "invalid-limit", { contextLines: 21 }],
  ["invalid internal fragment ceiling", "invalid-limit", { patchFragmentMaxBytes: 64_001 }]
];
for (const [label, reason, options] of invalidPatchCases) {
  const armed = await withArmedGit(undefined, `patch-${label.replaceAll(/[^a-z0-9]+/giu, "-")}`, async (logPath) => {
    const error = await expectTargetFailure(
      () => collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
        baseRef: patchFixture.baseSha,
        headRef: patchFixture.headSha,
        ...options
      }),
      reason,
      label
    );
    return { error, args: await readLoggedArgs(logPath) };
  });
  assert.equal(armed.args.length, 0, `${label}: invalid patch options reached a Git producer`);
  assertNoForbiddenPatchLiterals(armed.error, label);
}
console.log("PASS invalid include_patch/max_patch_bytes/context_lines/internal ceiling fail before any Git command");

const mismatchError = await withArmedGit("patch-header", "patch-header-mismatch", async () => expectTargetFailure(
  () => collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
    baseRef: patchFixture.baseSha,
    headRef: patchFixture.headSha,
    path: "added.py"
  }),
  "patch-fragment-mismatch",
  "patch fragment header mismatch"
));
assertNoForbiddenPatchLiterals(mismatchError, "patch fragment header mismatch");
console.log("PASS malformed requested-fragment header falsifier fails closed without raw diagnostics");

const oddRecord = patchRaw.records.find((record) => {
  const value = record.oldPath ?? record.newPath ?? "";
  return value.includes(" ") && !value.includes("\n");
});
assert.ok(oddRecord, "odd path patch record missing");
const oddExpected = expectedRedactedRecord(oddRecord);
const oddResult = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
  baseRef: patchFixture.baseSha,
  headRef: patchFixture.headSha,
  path: oddRecord.newPath
});
assert.equal(oddResult.patch, oddExpected.redacted, "odd path fragment selection diverged from direct raw patch");
assert.equal(oddResult.patchFilesIncluded, 1);
assertNoForbiddenPatchLiterals(oddResult, "odd path patch result");
console.log("PASS odd path fragment selection remains correlated with direct raw Git evidence");

const armedFull = await withArmedGit(undefined, "patch-argv", async (logPath) => {
  const result = await collectGitDiffRangePatch(patchContext.config, patchContext.guard, patchContext.workspace, {
    baseRef: patchFixture.baseSha,
    headRef: patchFixture.headSha,
    includePatch: true
  });
  return { result, args: await readLoggedArgs(logPath) };
});
const allDiffArgs = armedFull.args.filter((args) => args.includes("diff"));
const allPatchArgs = allDiffArgs.filter((args) => args.includes("--patch"));
assert.equal(allPatchArgs.length, patchExpectedTextRecords.length, "binary/blocked records triggered patch-content acquisition");
for (const args of allDiffArgs) {
  assert.ok(args.includes(patchFixture.baseSha), `diff producer did not use captured base SHA: ${JSON.stringify(args)}`);
  assert.ok(args.includes(patchFixture.headSha), `diff producer did not use captured head SHA: ${JSON.stringify(args)}`);
  assert.equal(args.includes("base-ref"), false);
  assert.equal(args.includes("head-ref"), false);
  assert.equal(args.includes(patchFixture.blockedPath), false, "blocked path was passed to a diff producer");
  assert.equal(args.includes(patchFixture.binaryPath), false, "binary path was passed to a patch producer");
  assert.ok(args.includes("--no-ext-diff"));
  assert.ok(args.includes("--no-textconv"));
  if (args.includes("--patch")) {
    assert.ok(args.includes("--diff-algorithm=myers"));
    assert.ok(args.includes("--no-indent-heuristic"));
    assert.equal(args.includes("--binary"), false);
  }
}
assertNoForbiddenPatchLiterals(armedFull.result, "armed full patch result");
console.log("PASS deterministic metadata order, immutable SHA argv, and zero blocked/binary patch-content commands");

console.log("TARGET_EVIDENCE: direct Git raw patch bytes/blob bytes from disposable repositories; SUPPORTING_ORACLE: accepted redaction policy computes expected public bytes, while target fragment extraction is independently challenged by raw header/fragment assertions.");
console.log("SANITY_VERDICT: MATCH (raw complete fragments and secret-bearing source bytes were observed before target results; no target diagnostic was used as raw evidence).");
console.log("PREDICATE: TRUE for blocked/binary non-generation; direct metadata and blob facts independently establish blocked/binary eligibility before checking zero patch commands.");
console.log("EVIDENCE_CONFLICT: none.");
console.log("DEFERRED_PUBLIC_ENVELOPE: MCP content/_meta/protocol error data are not physically produced by this internal engine leaf; full-envelope proof remains TASK-005/TASK-006.");
console.log("PASS TASK-003 focused AP-005/AP-006 patch-engine proof complete (task proof only; final mission acceptance remains with Execution Root).");

await rm(fixtureRoot, { recursive: true, force: true });
