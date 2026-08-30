import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { createCodexProServer } from "../dist/server.js";

// This proof owns only disposable test fixtures and public-behavior assertions.
// The accepted outcome is MISSION_ANCHOR A001 LAW-001/LAW-016/LAW-017 and
// MISSION_PLAN P001 TASK-006 AP-011/AP-012. The raw Git producer is consulted
// before any MCP result is interpreted; the redaction-policy module is a
// supporting oracle for expected public patch bytes, not target evidence.
const DEFAULT_SENTINEL = "DEFAULT_MCP_RANGE_SENTINEL_7X9";
const TARGET_SENTINEL = "TARGET_MCP_RANGE_SENTINEL_7X9";
const ADD_SECRET = "ACTUAL_LITERAL_SECRET_7X9";
const DELETE_SECRET = "DELETED_LITERAL_SECRET_8Y4";
const CONTEXT_SECRET = "CONTEXT_LITERAL_SECRET_9Z5";
const HOSTILE_KEY = "OPENAI_API_KEY_UNKNOWN_PROPERTY_7X9";
const HOSTILE_VALUE = "sk-hostile-mcp-envelope-secret-7X9";
const HOSTILE_REF_LITERAL = "HOSTILE_REF_SOURCE_LITERAL_8K2";
const HOSTILE_PATH_LITERAL = "HOSTILE_PATH_SOURCE_LITERAL_4Q6";
const EXTERNAL_DIFF_SENTINEL = "EXTERNAL_DIFF_SHOULD_NOT_RUN_5P8";
const TEXTCONV_SENTINEL = "TEXTCONV_SHOULD_NOT_RUN_6R3";
const BLOCKED_SECRET = "BLOCKED_PUBLIC_SECRET_4N8";
const BINARY_SECRET = "BINARY_PUBLIC_SECRET_3M7";
const matrixSecrets = [
  "ACTUAL_LITERAL_SECRET_7X9",
  "DELETED_LITERAL_SECRET_8Y4",
  "CONTEXT_LITERAL_SECRET_9Z5",
  "RENAMED_LITERAL_SECRET_6Q2",
  "COPIED_LITERAL_SECRET_5P1",
  BLOCKED_SECRET,
  BINARY_SECRET
];

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-diff-range-mcp-"));
// Raw child sessions intentionally share this one disposable CODEXPRO_HOME so
// the process-death falsifier can prove that no disk identity registry exists.
// It is never the ambient developer ~/.codexpro home.
const profileHome = path.join(fixtureRoot, "codexpro-home");
const defaultRoot = path.join(fixtureRoot, "default-repo");
const targetParent = path.join(fixtureRoot, "allowed-parent");
const targetRoot = path.join(targetParent, "nested-target-repo");

function gitEnv() {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true"
  };
  for (const key of [
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_ATTR_SOURCE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_NO_LAZY_FETCH"
  ]) delete env[key];
  return env;
}

function directGit(root, args, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: gitEnv(),
    input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function directGitWithGlobalArgs(root, globalArgs, args, input) {
  const result = spawnSync("git", [...globalArgs, ...args], {
    cwd: root,
    env: gitEnv(),
    input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function ordinaryGit(root, args, environment = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", ...environment },
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(root, args, input) {
  const result = directGit(root, args, input);
  assert.equal(result.error, undefined, `fixture Git failed to start: git ${args.join(" ")}`);
  assert.equal(result.status, 0, `fixture Git failed: git ${args.join(" ")}\n${result.stderr.toString("utf8")}`);
  return result.stdout;
}

function gitText(root, args) {
  return mustGit(root, args).toString("utf8").trim();
}

function splitNul(bytes) {
  if (bytes.length === 0) return [];
  assert.equal(bytes.at(-1), 0, "direct Git producer did not terminate its NUL stream");
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

function parseRawNameStatus(bytes) {
  const fields = splitNul(bytes);
  const records = [];
  let index = 0;
  while (index < fields.length) {
    const statusText = fields[index++].toString("utf8");
    const match = /^([ACDMRTUXB])(\d{0,3})$/u.exec(statusText);
    assert.ok(match, `unexpected direct name-status record ${JSON.stringify(statusText)}`);
    const status = match[1];
    const similarity = match[2] ? Number(match[2]) : null;
    if (status === "R" || status === "C") {
      assert.ok(index + 1 < fields.length, "direct rename/copy record missing path side");
      records.push({ status, oldPath: fields[index++].toString("utf8"), newPath: fields[index++].toString("utf8"), similarity });
    } else {
      assert.ok(index < fields.length, "direct name-status record missing path");
      const pathValue = fields[index++].toString("utf8");
      records.push({ status, oldPath: status === "A" ? null : pathValue, newPath: status === "D" ? null : pathValue, similarity });
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
    assert.ok(firstTab > 0 && secondTab > firstTab + 1, "malformed direct numstat record");
    const additionsText = record.subarray(0, firstTab).toString("ascii");
    const deletionsText = record.subarray(firstTab + 1, secondTab).toString("ascii");
    const additions = additionsText === "-" ? null : Number(additionsText);
    const deletions = deletionsText === "-" ? null : Number(deletionsText);
    const pathField = record.subarray(secondTab + 1);
    if (pathField.length > 0) {
      records.push({ path: pathField.toString("utf8"), oldPath: null, newPath: null, additions, deletions, binary: additions === null && deletions === null });
    } else {
      assert.ok(index + 1 < fields.length, "direct rename/copy numstat record missing path side");
      records.push({ path: null, oldPath: fields[index++].toString("utf8"), newPath: fields[index++].toString("utf8"), additions, deletions, binary: additions === null && deletions === null });
    }
  }
  return records;
}

function directMetadata(root, baseRef, headRef, pathFilter) {
  const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--find-copies=50%", "-z"];
  const suffix = pathFilter === undefined ? [] : ["--", `:(literal)${pathFilter}`];
  const name = directGit(root, [...common, "--name-status", baseRef, headRef, ...suffix]);
  const numstat = directGit(root, [...common, "--numstat", baseRef, headRef, ...suffix]);
  assert.equal(name.status, 0, `direct name-status failed: ${name.stderr.toString("utf8")}`);
  assert.equal(numstat.status, 0, `direct numstat failed: ${numstat.stderr.toString("utf8")}`);
  const names = parseRawNameStatus(name.stdout);
  const stats = parseRawNumstat(numstat.stdout);
  assert.equal(names.length, stats.length, "direct metadata producers disagreed");
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
    return { status: entry.status, oldPath: entry.oldPath, newPath: entry.newPath, similarity: entry.similarity, additions: stat.additions, deletions: stat.deletions, binary: stat.binary };
  });
  return { records, nameBytes: name.stdout, numstatBytes: numstat.stdout };
}

function publicRecord(record) {
  return { status: record.status, old_path: record.oldPath, new_path: record.newPath, similarity: record.similarity, additions: record.additions, deletions: record.deletions, binary: record.binary };
}

function acceptedBlockedPath(pathValue) {
  return pathValue === ".env" || pathValue.startsWith(".env.") || pathValue.startsWith(".env/") || pathValue.includes("/.env.") || pathValue.includes("/.env/");
}

function blockedRecord(record) {
  return (record.oldPath !== null && acceptedBlockedPath(record.oldPath)) || (record.newPath !== null && acceptedBlockedPath(record.newPath));
}

function directPatch(root, baseRef, headRef, records, contextLines = 3) {
  const pathValues = [...new Set(records.flatMap((record) => [record.oldPath, record.newPath]).filter((value) => value !== null))];
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--patch", `-U${contextLines}`, "--find-renames=50%", "--find-copies=50%", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", baseRef, headRef, "--", ...pathValues.map((value) => `:(literal)${value}`)];
  const result = directGit(root, args);
  assert.equal(result.status, 0, `direct patch failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8");
}

function oracleGlobalArgs(attrSource, attributesFile, orderFile) {
  return [
    "--no-replace-objects",
    "--no-pager",
    "-c", "color.ui=false",
    `--attr-source=${attrSource}`,
    "-c", "core.quotePath=true",
    "-c", `core.attributesFile=${attributesFile}`,
    "-c", "core.autocrlf=false",
    "-c", "diff.algorithm=myers",
    "-c", "diff.indentHeuristic=false",
    "-c", "diff.renames=true",
    "-c", "diff.renameLimit=1000",
    "-c", "diff.external=",
    "-c", "diff.trustExitCode=false",
    "-c", "diff.relative=false",
    "-c", "diff.submodule=short"
  ];
}

function directMetadataWithOracle(root, baseRef, headRef, attrSource, attributesFile, orderFile, pathFilter) {
  const common = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--find-copies=50%", "-l1000", `-O${orderFile}`, "-z"];
  const suffix = pathFilter === undefined ? [] : ["--", `:(literal)${pathFilter}`];
  const name = directGitWithGlobalArgs(root, oracleGlobalArgs(attrSource, attributesFile, orderFile), [...common, "--name-status", baseRef, headRef, ...suffix]);
  const numstat = directGitWithGlobalArgs(root, oracleGlobalArgs(attrSource, attributesFile, orderFile), [...common, "--numstat", baseRef, headRef, ...suffix]);
  assert.equal(name.status, 0, `oracle name-status failed: ${name.stderr.toString("utf8")}`);
  assert.equal(numstat.status, 0, `oracle numstat failed: ${numstat.stderr.toString("utf8")}`);
  const names = parseRawNameStatus(name.stdout);
  const stats = parseRawNumstat(numstat.stdout);
  assert.equal(names.length, stats.length, "oracle metadata producers disagreed");
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
    return { status: entry.status, oldPath: entry.oldPath, newPath: entry.newPath, similarity: entry.similarity, additions: stat.additions, deletions: stat.deletions, binary: stat.binary };
  });
  return { records, nameBytes: name.stdout, numstatBytes: numstat.stdout };
}

function directPatchWithOracle(root, baseRef, headRef, records, attrSource, attributesFile, orderFile, contextLines = 3) {
  return records.map((record) => {
    const pathValues = [...new Set([record.oldPath, record.newPath].filter((value) => value !== null))];
    const args = [
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--patch", `-U${contextLines}`,
      "--find-renames=50%", "--find-copies=50%", "-l1000", `-O${orderFile}`, "--diff-algorithm=myers", "--no-indent-heuristic",
      "--src-prefix=a/", "--dst-prefix=b/", baseRef, headRef, "--", ...pathValues.map((value) => `:(literal)${value}`)
    ];
    const result = directGitWithGlobalArgs(root, oracleGlobalArgs(attrSource, attributesFile, orderFile), args);
    assert.equal(result.status, 0, `oracle patch failed: ${result.stderr.toString("utf8")}`);
    return result.stdout.toString("utf8");
  }).join("");
}

function publicChangedFileKeys(result, label) {
  assert.ok(Array.isArray(result.changed_files), `${label}: changed_files missing`);
  for (const record of result.changed_files) assert.deepEqual(Object.keys(record).sort(), ["additions", "binary", "deletions", "new_path", "old_path", "similarity", "status"], `${label}: changed-file schema drifted`);
}

async function initRepo(root) {
  await mkdir(root, { recursive: true });
  mustGit(root, ["init", "--quiet"]);
  mustGit(root, ["config", "user.name", "MCP Historical Range Smoke"]);
  mustGit(root, ["config", "user.email", "mcp-historical-range-smoke@example.invalid"]);
  mustGit(root, ["config", "core.logAllRefUpdates", "true"]);
}

async function commitAll(root, subject) {
  mustGit(root, ["add", "--all"]);
  mustGit(root, ["commit", "--quiet", "-m", subject]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

async function writeFixture(root, relativePath, value, mode) {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, value);
  if (mode !== undefined) await chmod(absolute, mode);
}

async function makeHistoryFixture(root) {
  await initRepo(root);
  await writeFixture(root, "root.txt", "root\n");
  const rootSha = await commitAll(root, "history root");
  await writeFixture(root, "linear.txt", "linear\n");
  const linearSha = await commitAll(root, "history linear");

  mustGit(root, ["switch", "-c", "left", rootSha]);
  await writeFixture(root, "left.txt", "left branch\n");
  const leftSha = await commitAll(root, "history left");
  mustGit(root, ["switch", "--detach", rootSha]);
  mustGit(root, ["switch", "-c", "right"]);
  await writeFixture(root, "right.txt", "right branch\n");
  const rightSha = await commitAll(root, "history right");
  const mergeBaseSha = gitText(root, ["merge-base", leftSha, rightSha]);

  mustGit(root, ["switch", "--detach", rootSha]);
  mustGit(root, ["switch", "-c", "merge-main"]);
  await writeFixture(root, "main.txt", "main side\n");
  const mergeMainSha = await commitAll(root, "history merge main");
  mustGit(root, ["switch", "--detach", rootSha]);
  mustGit(root, ["switch", "-c", "merge-feature"]);
  await writeFixture(root, "feature.txt", "feature side\n");
  const mergeFeatureSha = await commitAll(root, "history merge feature");
  mustGit(root, ["switch", "merge-main"]);
  mustGit(root, ["merge", "--no-ff", "--quiet", "-m", "history merge", mergeFeatureSha]);
  const mergeSha = gitText(root, ["rev-parse", "HEAD"]);
  assert.equal(gitText(root, ["rev-parse", `${mergeSha}^1`]), mergeMainSha);
  assert.equal(gitText(root, ["rev-parse", `${mergeSha}^2`]), mergeFeatureSha);
  return { root, rootSha, linearSha, leftSha, rightSha, mergeBaseSha, mergeSha, relevantPaths: ["root.txt", "linear.txt", "left.txt", "right.txt", "main.txt", "feature.txt"] };
}

async function makePublicMatrixFixture(root) {
  await initRepo(root);
  await writeFixture(root, "ordinary.txt", "before\nunchanged\n");
  await writeFixture(root, "mode-only.sh", "mode only\n", 0o644);
  await writeFixture(root, "type-target", "type target\n");
  await symlink("type-target", path.join(root, "type-entry"));
  await writeFixture(root, "rename-old.txt", `rename token ${matrixSecrets[3]}\n`);
  await writeFixture(root, "copy-source.txt", `copy token ${matrixSecrets[4]}\n`);
  await writeFixture(root, "delete.txt", `delete token ${matrixSecrets[1]}\n`);
  await writeFixture(root, "binary.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(BINARY_SECRET), Buffer.from([0xff])]));
  const baseSha = await commitAll(root, "public matrix base");

  await writeFixture(root, "ordinary.txt", `before\nchanged ${matrixSecrets[0]}\n`);
  await chmod(path.join(root, "mode-only.sh"), 0o755);
  await unlink(path.join(root, "type-entry"));
  await writeFixture(root, "type-entry", "type regular now\n");
  await mustGit(root, ["mv", "rename-old.txt", "rename-new.txt"]);
  await writeFixture(root, "rename-new.txt", `rename token ${matrixSecrets[3]}\nrename changed\n`);
  await writeFixture(root, "copy-source.txt", `copy token ${matrixSecrets[4]}\ncopy changed\n`);
  await writeFixture(root, "copy-dest.txt", `copy token ${matrixSecrets[4]}\ncopy changed\n`);
  await unlink(path.join(root, "delete.txt"));
  await writeFixture(root, "binary.bin", Buffer.concat([Buffer.from([0, 1, 3]), Buffer.from(BINARY_SECRET), Buffer.from([0xfe])]));
  await writeFixture(root, "space dir/space name.txt", "space path\n");
  await writeFixture(root, "café/é name.txt", "unicode path\n");
  await writeFixture(root, "-leading-dash.txt", "leading dash path\n");
  await writeFixture(root, "tab\tname.txt", "tab path\n");
  await writeFixture(root, "line\nname.txt", "newline path\n");
  await writeFixture(root, ".env.public", `blocked ${BLOCKED_SECRET}\n`);
  const headSha = await commitAll(root, "public matrix head");
  await writeFixture(root, "dirty-staged.txt", "staged target dirt\n");
  mustGit(root, ["add", "dirty-staged.txt"]);
  await writeFixture(root, "dirty-unstaged.txt", "unstaged target dirt\n");
  await writeFixture(root, "dirty-untracked.txt", "untracked target dirt\n");
  const relevantPaths = ["ordinary.txt", "mode-only.sh", "type-entry", "type-target", "rename-old.txt", "rename-new.txt", "copy-source.txt", "copy-dest.txt", "delete.txt", "binary.bin", "space dir/space name.txt", "café/é name.txt", "-leading-dash.txt", "tab\tname.txt", "line\nname.txt", ".env.public", "dirty-staged.txt", "dirty-unstaged.txt", "dirty-untracked.txt"];
  return { root, baseSha, headSha, relevantPaths };
}

async function makePublicBlockedFixture(root) {
  await initRepo(root);
  await writeFixture(root, "allowed-source.txt", "allowed source\n");
  const baseSha = await commitAll(root, "public blocked base");
  await writeFixture(root, ".env.added", `blocked add ${BLOCKED_SECRET}\n`);
  const addSha = await commitAll(root, "public blocked add");
  await unlink(path.join(root, ".env.added"));
  const deleteSha = await commitAll(root, "public blocked delete");
  await mustGit(root, ["mv", "allowed-source.txt", ".env.renamed"]);
  const allowedToBlockedSha = await commitAll(root, "public allowed to blocked rename");
  await mustGit(root, ["mv", ".env.renamed", "allowed-renamed.txt"]);
  const blockedToAllowedSha = await commitAll(root, "public blocked to allowed rename");
  const copyOriginal = Array.from({ length: 20 }, (_, index) => "copy source " + index + "\n").join("");
  const copyChanged = Array.from({ length: 20 }, (_, index) => "copy source " + (index === 18 ? "changed" : index) + "\n").join("");
  await writeFixture(root, "copy-source.txt", copyOriginal);
  const copyBaseSha = await commitAll(root, "public copy source");
  await writeFixture(root, "copy-source.txt", copyChanged);
  await writeFixture(root, ".env.copy-dest", copyChanged);
  const copyNewBlockedSha = await commitAll(root, "public copy blocked destination");
  await unlink(path.join(root, ".env.copy-dest"));
  await writeFixture(root, ".env.copy-source", copyOriginal);
  const copyOldBaseSha = await commitAll(root, "public blocked copy source");
  await writeFixture(root, ".env.copy-source", copyChanged);
  await writeFixture(root, "allowed-copy-from-blocked.txt", copyChanged);
  const copyOldBlockedSha = await commitAll(root, "public copy blocked source");
  return {
    root,
    cases: [
      ["blocked add", baseSha, addSha, ".env.added", "add"],
      ["blocked delete", addSha, deleteSha, ".env.added", "delete"],
      ["allowed to blocked rename", deleteSha, allowedToBlockedSha, ".env.renamed", "rename-new"],
      ["blocked to allowed rename", allowedToBlockedSha, blockedToAllowedSha, ".env.renamed", "rename-old"],
      ["copy with blocked new side", copyBaseSha, copyNewBlockedSha, ".env.copy-dest", "copy-new"],
      ["copy with blocked old side", copyOldBaseSha, copyOldBlockedSha, ".env.copy-source", "copy-old"]
    ]
  };
}

async function makePublicBudgetFixture(root) {
  await initRepo(root);
  await writeFixture(root, "a.txt", "a before\n");
  await writeFixture(root, "b.txt", "b before\n");
  const baseSha = await commitAll(root, "public budget base");
  await writeFixture(root, "a.txt", "a before\ntoken = \"ACTUAL_LITERAL_SECRET_7X9\"\n");
  await writeFixture(root, "b.txt", "b before\nafter second fragment\n");
  const headSha = await commitAll(root, "public budget head");
  return { root, baseSha, headSha, relevantPaths: ["a.txt", "b.txt"] };
}

async function makePublicConfigFixture(root) {
  await initRepo(root);
  await writeFixture(root, ".gitattributes", "*.hostile diff=hostile\n");
  await writeFixture(root, "ordinary.txt", "ordinary before\n");
  await writeFixture(root, "config.hostile", Buffer.from([0, 1, 2, 3, 4]));
  const baseSha = await commitAll(root, "public config base");
  await writeFixture(root, "ordinary.txt", "ordinary after\n");
  await writeFixture(root, "config.hostile", Buffer.from([0, 1, 2, 4, 5]));
  const headSha = await commitAll(root, "public config head");
  return { root, baseSha, headSha, relevantPaths: [".gitattributes", "ordinary.txt", "config.hostile"] };
}

async function makeAttributeDirectionFixture(root) {
  await initRepo(root);
  await writeFixture(root, ".gitattributes", "direction.txt -diff\nreverse.txt diff\n");
  await writeFixture(root, "direction.txt", "direction before\n");
  await writeFixture(root, "reverse.txt", "reverse before\n");
  const baseSha = await commitAll(root, "attribute direction base");
  // The head tree deliberately reverses both attributes. The public operation
  // is required to use committed head-tree attributes, not dirty checkout or
  // base-tree attributes, so this pair proves both directions in one range.
  await writeFixture(root, ".gitattributes", "direction.txt diff\nreverse.txt -diff\n");
  await writeFixture(root, "direction.txt", "direction after\n");
  await writeFixture(root, "reverse.txt", "reverse after\n");
  const headSha = await commitAll(root, "attribute direction head");
  return { root, baseSha, headSha, relevantPaths: [".gitattributes", "direction.txt", "reverse.txt"] };
}

async function makeOverflowFixture(root, fileCount = 320) {
  await initRepo(root);
  await writeFixture(root, "anchor.txt", "anchor\n");
  const baseSha = await commitAll(root, "metadata overflow base");
  for (let index = 0; index < fileCount; index += 1) {
    await writeFixture(root, `overflow-${String(index).padStart(4, "0")}.txt`, `overflow ${index}\n`);
  }
  const headSha = await commitAll(root, "metadata overflow head");
  return { root, baseSha, headSha, fileCount };
}

async function makeFragmentOverflowFixture(root) {
  await initRepo(root);
  await writeFixture(root, "large-fragment.txt", "before\n");
  const baseSha = await commitAll(root, "fragment overflow base");
  await writeFixture(root, "large-fragment.txt", `before\n${"large fragment line ".repeat(500)}\n`);
  const headSha = await commitAll(root, "fragment overflow head");
  return { root, baseSha, headSha };
}

function directRangePatch(root, baseRef, headRef) {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    "-U3",
    "--find-renames=50%",
    "--find-copies=50%",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseRef,
    headRef,
    "--",
    ":(literal)target-range.txt"
  ];
  return directGit(root, args);
}

async function fileDigest(filePath) {
  try {
    const bytes = await readFile(filePath);
    return { exists: true, bytes: bytes.length, sha256: await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function directorySnapshot(root) {
  const snapshot = { exists: false, entries: [] };
  const walk = async (directory, relativeDirectory = ".") => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" && relativeDirectory === ".") return;
      throw error;
    }
    snapshot.exists = true;
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.entries.push({ path: relativePath, type: "directory" });
        await walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot.entries.push({ path: relativePath, type: "file", digest: await fileDigest(absolutePath) });
      } else if (entry.isSymbolicLink()) {
        snapshot.entries.push({ path: relativePath, type: "symlink", target: await readlink(absolutePath) });
      } else {
        snapshot.entries.push({ path: relativePath, type: "other" });
      }
    }
  };
  await walk(root);
  return snapshot;
}

function assertNoWorkspaceIdentityRegistry(snapshot, label) {
  const registryPath = /(^|[\\/])(?:workspace[-_]?bindings?|workspace[-_]?identity|workspace[-_]?registry)(?:[\\/]|$)/iu;
  assert.equal(snapshot.entries.some((entry) => registryPath.test(entry.path)), false, `${label} created a workspace identity registry`);
}

function assertProfileHomeUnchanged(before, after, label) {
  assert.deepEqual(after, before, `${label} changed CODEXPRO_HOME/profile/runtime state`);
  assertNoWorkspaceIdentityRegistry(after, label);
}

function bytesDigest(bytes) {
  const buffer = Buffer.from(bytes);
  return {
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    base64: buffer.toString("base64")
  };
}

function emitRawNulEvidence(label, bytes, decodedRecords) {
  const evidence = bytesDigest(bytes);
  // The fixtures used for this evidence contain no blocked paths or source
  // secrets. Base64 preserves exact NUL-stream bytes while remaining safe in
  // line-oriented verifier logs; decoded records expose the human-checkable
  // interpretation independently.
  console.log(`RAW_NUL_STREAM: ${serialized({ label, ...evidence })}`);
  console.log(`RAW_DECODED_RECORDS: ${serialized({ label, records: decodedRecords })}`);
}

function emitSnapshotEvidence(label, snapshot) {
  const encoded = serialized(snapshot);
  console.log(`RAW_SNAPSHOT: ${serialized({
    label,
    bytes: Buffer.byteLength(encoded, "utf8"),
    sha256: createHash("sha256").update(encoded).digest("hex"),
    snapshot
  })}`);
}

async function repositorySnapshot(root, relevantPaths = []) {
  const commandArgs = {
    head: ["rev-parse", "--verify", "HEAD"],
    branch: ["symbolic-ref", "--short", "-q", "HEAD"],
    refs: ["for-each-ref", "--format=%(refname)%00%(objectname)%00"],
    reflogs: ["reflog", "show", "--all", "--format=%H%x00%gD%x00%gs%x00"],
    index: ["ls-files", "--stage", "-z"],
    staged: ["diff", "--cached", "--binary", "--no-ext-diff"],
    unstaged: ["diff", "--binary", "--no-ext-diff"],
    untracked: ["ls-files", "--others", "--exclude-standard", "-z"],
    status: ["status", "--porcelain=v1", "-z"],
    config: ["config", "--local", "--null", "--list"],
    remotes: ["remote", "-v"],
    worktrees: ["worktree", "list", "--porcelain"]
  };
  const commands = {};
  for (const [name, args] of Object.entries(commandArgs)) {
    const result = directGit(root, args);
    assert.equal(result.error, undefined, `snapshot Git failed to start for ${name}`);
    assert.equal(result.status, 0, `snapshot Git failed for ${name}`);
    commands[name] = { stdout: result.stdout.toString("base64"), stderr: result.stderr.toString("base64") };
  }
  const fileEntries = await Promise.all([
    ...new Set(["target-range.txt", ...relevantPaths]),
    ".git/index",
    ".git/HEAD"
  ].map(async (relativePath) => [relativePath, await fileDigest(path.join(root, relativePath))]));
  return { commands, files: Object.fromEntries(fileEntries) };
}

function resolveSchema(root, schema) {
  let current = schema;
  const seen = new Set();
  while (current?.$ref) {
    assert.equal(typeof current.$ref, "string");
    assert.ok(current.$ref.startsWith("#/"), `unsupported schema reference ${current.$ref}`);
    assert.equal(seen.has(current.$ref), false, `cyclic schema reference ${current.$ref}`);
    seen.add(current.$ref);
    current = current.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  return current;
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function valuesAtPaths(value, wanted, pathParts = []) {
  const found = [];
  if (wanted(value, pathParts)) found.push({ path: pathParts, value });
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => found.push(...valuesAtPaths(item, wanted, [...pathParts, index])));
    } else {
      for (const [key, item] of Object.entries(value)) found.push(...valuesAtPaths(item, wanted, [...pathParts, key]));
    }
  }
  return found;
}

function assertNoLiterals(value, literals, label) {
  const text = serialized(value);
  for (const literal of literals) assert.equal(text.includes(literal), false, `${label} leaked ${literal}`);
}

function assertNoHostileResponse(call, label) {
  const response = call.response;
  assert.equal(call.raw.includes(HOSTILE_KEY), false, `${label} response JSON echoed hostile property name`);
  assert.equal(call.raw.includes(HOSTILE_VALUE), false, `${label} response JSON echoed hostile property value`);
  assertNoLiterals(response?.result?.content, [HOSTILE_KEY, HOSTILE_VALUE], `${label} content`);
  assertNoLiterals(response?.result?.structuredContent, [HOSTILE_KEY, HOSTILE_VALUE], `${label} structuredContent`);
  assertNoLiterals(response?.result?._meta, [HOSTILE_KEY, HOSTILE_VALUE], `${label} _meta`);
  assertNoLiterals(response?.error?.message, [HOSTILE_KEY, HOSTILE_VALUE], `${label} protocol error.message`);
  assertNoLiterals(response?.error?.data, [HOSTILE_KEY, HOSTILE_VALUE], `${label} protocol error.data`);
}

function assertNoResponseLiterals(call, literals, label) {
  const raw = call.raw ?? serialized(call.response);
  for (const literal of literals) {
    assert.equal(raw.includes(literal), false, `${label} complete response leaked ${literal}`);
    assert.equal(serialized(call.response?.result?.content).includes(literal), false, `${label} content leaked ${literal}`);
    assert.equal(serialized(call.response?.result?.structuredContent).includes(literal), false, `${label} structuredContent leaked ${literal}`);
    assert.equal(serialized(call.response?.result?._meta).includes(literal), false, `${label} _meta leaked ${literal}`);
    assert.equal(serialized(call.response?.error?.message).includes(literal), false, `${label} error.message leaked ${literal}`);
    assert.equal(serialized(call.response?.error?.data).includes(literal), false, `${label} error.data leaked ${literal}`);
  }
}

function assertPublicRange(result, expected, label) {
  assert.equal(result.schema_version, 1, `${label}: schema_version drifted`);
  assert.equal(result.workspace_id, expected.workspaceId, `${label}: workspace ID drifted`);
  assert.equal(result.root, expected.root, `${label}: root drifted`);
  assert.equal(result.comparison_mode, "direct-two-tree", `${label}: comparison mode drifted`);
  assert.equal(result.base_ref_input, expected.baseRef, `${label}: base ref input drifted`);
  assert.equal(result.base_commit_sha, expected.baseSha, `${label}: base SHA drifted`);
  assert.equal(result.head_ref_input, expected.headRef, `${label}: head ref input drifted`);
  assert.equal(result.head_commit_sha, expected.headSha, `${label}: head SHA drifted`);
  if (expected.path === undefined) assert.equal(Object.hasOwn(result, "path"), false, `${label}: unexpected path key`);
  else assert.equal(result.path, expected.path, `${label}: historical path filter drifted`);
  assert.equal(result.changed_file_count, expected.raw.length, `${label}: changed-file total drifted`);
  assert.equal(result.eligible_changed_file_count, expected.eligible.length, `${label}: eligible total drifted`);
  assert.equal(result.returned_file_count, expected.returned.length, `${label}: returned total drifted`);
  assert.deepEqual(result.changed_files, expected.returned.map(publicRecord), `${label}: changed-file records drifted from raw Git`);
  assert.equal(result.changed_files_truncated, expected.returned.length < expected.eligible.length, `${label}: max_files truncation drifted`);
  assert.equal(result.blocked_files_omitted, expected.blocked, `${label}: blocked count drifted`);
  assert.equal(result.patch, expected.patch ?? "", `${label}: patch bytes drifted`);
  assert.equal(result.patch_requested, expected.patchRequested, `${label}: patch_requested drifted`);
  assert.equal(result.patch_included, (expected.patch ?? "").length > 0, `${label}: patch_included drifted`);
  assert.equal(result.patch_bytes, Buffer.byteLength(expected.patch ?? "", "utf8"), `${label}: patch byte count drifted`);
  assert.equal(result.patch_limit, expected.patchLimit, `${label}: patch limit drifted`);
  assert.equal(result.patch_truncated, expected.patchTruncated ?? false, `${label}: patch truncation drifted`);
  assert.equal(result.patch_files_included, expected.patchFilesIncluded ?? 0, `${label}: patch included count drifted`);
  assert.equal(result.patch_files_omitted, Object.values(expected.omissionCounts).reduce((sum, count) => sum + count, 0), `${label}: patch omission total drifted`);
  assert.deepEqual(result.patch_omission_counts, expected.omissionCounts, `${label}: patch omission counts drifted`);
  publicChangedFileKeys(result, label);
}

class RawStdioClient {
  constructor(defaultWorkspaceRoot, allowedRoots, mode, environment = {}) {
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    const explicitAllowedRoots = [...new Set(allowedRoots.map((root) => path.resolve(root)))];
    const launchArgs = [
      "dist/stdio.js",
      "--root", defaultWorkspaceRoot,
      "--bash", "off",
      "--write", "off",
      "--tool-mode", mode
    ];
    for (const root of explicitAllowedRoots) launchArgs.splice(3, 0, "--allow-root", root);
    const childEnvironment = {
      ...process.env,
      ...environment,
      CODEXPRO_HOME: profileHome,
      CODEXPRO_ROOT: defaultWorkspaceRoot,
      CODEXPRO_ALLOWED_ROOTS: [defaultWorkspaceRoot, ...explicitAllowedRoots].join(path.delimiter),
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_CODEX_SESSIONS: "off",
      CODEXPRO_BASH_MODE: "off",
      CODEXPRO_WRITE_MODE: "off"
    };
    this.launch = {
      defaultRoot: path.resolve(defaultWorkspaceRoot),
      allowedRoots: explicitAllowedRoots,
      profileHome,
      args: launchArgs,
      environment: {
        CODEXPRO_HOME: profileHome,
        CODEXPRO_ROOT: defaultWorkspaceRoot,
        CODEXPRO_ALLOWED_ROOTS: [defaultWorkspaceRoot, ...explicitAllowedRoots].join(path.delimiter),
        targetRootPresent: Object.values(childEnvironment).some((value) => typeof value === "string" && value.includes(targetRoot))
      }
    };
    this.startedAt = Date.now();
    this.child = spawn(process.execPath, launchArgs, {
      cwd: path.resolve("."),
      env: childEnvironment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.pid = this.child.pid;
    assert.ok(Number.isInteger(this.pid) && this.pid > 0, "stdio child did not expose a process ID");
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code, signal) => {
      this.exitedAt = Date.now();
      this.exit = { code, signal };
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited code=${code} signal=${signal}; stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      let response;
      try {
        response = JSON.parse(raw);
      } catch (error) {
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error(`invalid JSON-RPC response: ${error instanceof Error ? error.message : String(error)}`));
        }
        this.pending.clear();
        continue;
      }
      if (!response.id || !this.pending.has(response.id)) continue;
      const { resolve, timer } = this.pending.get(response.id);
      clearTimeout(timer);
      this.pending.delete(response.id);
      resolve({ response, raw });
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}

function fixtureConfig(defaultWorkspaceRoot, mode) {
  const isolatedKeys = [
    "CODEXPRO_ROOT",
    "CODEBASE_BRIDGE_REPO_ROOT",
    "CODEXPRO_ALLOWED_ROOTS",
    "CODEBASE_BRIDGE_ALLOWED_ROOTS",
    "CODEXPRO_ALLOW_HOME",
    "CODEXPRO_TOOL_CARDS",
    "CODEXPRO_BASH_MODE",
    "CODEXPRO_WRITE_MODE",
    "CODEXPRO_TOOL_MODE",
    "CODEXPRO_CODEX_SESSIONS",
    "CODEXPRO_CONNECTION_TEST",
    "CODEXPRO_ANALYSIS"
  ];
  const saved = new Map(isolatedKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of isolatedKeys) delete process.env[key];
    return loadConfig([
      "--root", path.resolve(defaultWorkspaceRoot),
      "--allow-root", path.resolve(targetParent),
      "--bash", "off",
      "--write", "off",
      "--tool-mode", mode
    ]);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

class InMemoryMcpSession {
  constructor(label, config, server, client, clientTransport, serverTransport) {
    this.label = label;
    this.config = config;
    this.server = server;
    this.client = client;
    this.clientTransport = clientTransport;
    this.serverTransport = serverTransport;
    this.processId = process.pid;
    this.serverObject = server;
    this.sessionObject = client;
    this.nextId = 1;
    this.closed = false;
    this.launch = {
      defaultRoot: config.defaultRoot,
      allowedRoots: [...config.allowedRoots],
      profileHome,
      args: ["in-memory-server", "--root", config.defaultRoot, "--allow-root", targetParent, "--bash", "off", "--write", "off", "--tool-mode", config.toolMode],
      environment: {
        CODEXPRO_HOME: profileHome,
        CODEXPRO_ROOT: config.defaultRoot,
        CODEXPRO_ALLOWED_ROOTS: config.allowedRoots.join(path.delimiter),
        targetRootPresent: Object.values(process.env).some((value) => typeof value === "string" && value.includes(targetRoot))
      }
    };
  }

  async request(method, params) {
    const id = this.nextId++;
    try {
      let result;
      if (method === "tools/list") result = await this.client.listTools(params ?? {});
      else if (method === "tools/call") result = await this.client.callTool(params ?? {});
      else result = await this.client.request({ method, params });
      const response = { jsonrpc: "2.0", id, result };
      return { response, raw: serialized(response) };
    } catch (error) {
      const response = {
        jsonrpc: "2.0",
        id,
        error: {
          code: Number.isSafeInteger(error?.code) ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      };
      if (error && typeof error === "object" && error.data !== undefined) response.error.data = error.data;
      return { response, raw: serialized(response) };
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
    await this.server.close();
    this.exitedAt = Date.now();
  }
}

async function startInMemorySession(defaultWorkspaceRoot, mode, label) {
  const config = fixtureConfig(defaultWorkspaceRoot, mode);
  const server = createCodexProServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "git-diff-range-mcp-smoke", version: "1.0.0" });
  await client.connect(clientTransport);
  return new InMemoryMcpSession(label, config, server, client, clientTransport, serverTransport);
}

async function startClient(defaultWorkspaceRoot, mode, environment = {}) {
  const client = new RawStdioClient(defaultWorkspaceRoot, [targetParent], mode, environment);
  const initialize = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "git-diff-range-mcp-smoke", version: "1.0.0" }
  });
  client.notify("notifications/initialized");
  return { client, initialize };
}

async function callTool(client, name, args) {
  return client.request("tools/call", { name, arguments: args });
}

function successResult(call, label) {
  assert.equal(call.response?.error, undefined, `${label} returned protocol error: ${serialized(call.response?.error)}`);
  assert.ok(call.response?.result, `${label} omitted JSON-RPC result`);
  assert.notEqual(call.response.result.isError, true, `${label} returned tool error: ${serialized(call.response.result)}`);
  assert.ok(Array.isArray(call.response.result.content), `${label} omitted content`);
  assert.ok(call.response.result.structuredContent && typeof call.response.result.structuredContent === "object", `${label} omitted structuredContent`);
  return call.response.result;
}

function errorResult(call, label) {
  assert.equal(call.response?.error, undefined, `${label} unexpectedly returned protocol error: ${serialized(call.response?.error)}`);
  assert.ok(call.response?.result, `${label} omitted JSON-RPC result`);
  assert.equal(call.response.result.isError, true, `${label} unexpectedly succeeded: ${serialized(call.response.result)}`);
  return call.response.result;
}

async function main() {
  let firstClient;
  let secondClient;
  const { redactUnifiedDiff } = await import("./redaction-policy.mjs");
  const defaultRootB = path.join(fixtureRoot, "default-repo-b");
  const historyRoot = path.join(targetParent, "history-target-repo");
  const matrixRoot = path.join(targetParent, "matrix-target-repo");
  const blockedRoot = path.join(targetParent, "blocked-target-repo");
  const budgetRoot = path.join(targetParent, "budget-target-repo");
  const configRoot = path.join(targetParent, "config-target-repo");
  const attributeRoot = path.join(targetParent, "attribute-direction-target-repo");
  const overflowRoot = path.join(targetParent, "metadata-overflow-target-repo");
  const fragmentOverflowRoot = path.join(targetParent, "fragment-overflow-target-repo");
  const previousCodexProHome = process.env.CODEXPRO_HOME;
  process.env.CODEXPRO_HOME = profileHome;
  try {
    await mkdir(path.join(profileHome, "profiles"), { recursive: true });
    await writeFile(path.join(profileHome, "profiles", "fixture-keep.json"), '{"fixture":"keep"}\n', "utf8");
    await initRepo(defaultRoot);
    await initRepo(defaultRootB);
    await initRepo(targetRoot);
    const history = await makeHistoryFixture(historyRoot);
    const matrix = await makePublicMatrixFixture(matrixRoot);
    const blocked = await makePublicBlockedFixture(blockedRoot);
    const budget = await makePublicBudgetFixture(budgetRoot);
    const configFixture = await makePublicConfigFixture(configRoot);
    const attributeFixture = await makeAttributeDirectionFixture(attributeRoot);
    const overflowFixture = await makeOverflowFixture(overflowRoot);
    const fragmentOverflowFixture = await makeFragmentOverflowFixture(fragmentOverflowRoot);

    await writeFile(path.join(defaultRoot, "default.txt"), `${DEFAULT_SENTINEL} base\n`, "utf8");
    const defaultBaseSha = await commitAll(defaultRoot, "default range base");
    await writeFile(path.join(defaultRoot, "default.txt"), `${DEFAULT_SENTINEL} head\n`, "utf8");
    const defaultHeadSha = await commitAll(defaultRoot, "default range head");

    await writeFile(path.join(defaultRootB, "default-b.txt"), `${DEFAULT_SENTINEL} B base\n`, "utf8");
    const defaultBBaseSha = await commitAll(defaultRootB, "default B range base");
    await writeFile(path.join(defaultRootB, "default-b.txt"), `${DEFAULT_SENTINEL} B head\n`, "utf8");
    const defaultBHeadSha = await commitAll(defaultRootB, "default B range head");

    const baseText = [
      "target anchor line",
      `DELETE_TOKEN = "${DELETE_SECRET}"`,
      `password = "${CONTEXT_SECRET}"`,
      "target trailing line",
      ""
    ].join("\n");
    const headText = [
      "target anchor line",
      `ADD_TOKEN = "${ADD_SECRET}"`,
      `password = "${CONTEXT_SECRET}"`,
      `target sentinel = "${TARGET_SENTINEL}"`,
      "target trailing line",
      ""
    ].join("\n");
    await writeFile(path.join(targetRoot, "target-range.txt"), baseText, "utf8");
    const targetBaseSha = await commitAll(targetRoot, "target range base");
    await writeFile(path.join(targetRoot, "target-range.txt"), headText, "utf8");
    const targetHeadSha = await commitAll(targetRoot, "target range head");

    // PASS 1 for the complete hostile matrix: establish only direct Git facts
    // and fixture bytes before opening any MCP session or consulting target
    // classifications. These producers are TARGET_EVIDENCE; no target result
    // is used as its own oracle.
    const historySameRaw = directMetadata(history.root, history.rootSha, history.rootSha);
    const historyLinearRaw = directMetadata(history.root, history.rootSha, history.linearSha);
    const historyDivergentRaw = directMetadata(history.root, history.leftSha, history.rightSha);
    const historyMergeBaseRaw = directMetadata(history.root, history.mergeBaseSha, history.rightSha);
    const historyMergeRaw = directMetadata(history.root, history.rootSha, history.mergeSha);
    const matrixRaw = directMetadata(matrix.root, matrix.baseSha, matrix.headSha);
    const budgetRaw = directMetadata(budget.root, budget.baseSha, budget.headSha);
    const configRaw = directMetadata(configFixture.root, configFixture.baseSha, configFixture.headSha);
    // Independent oracle: a no-hardlink clone has its own checkout/config and
    // object database. It is captured before any target-local hostile state is
    // introduced and is the sole expected-result source for the fixed-SHA
    // isolation proof below.
    const configOracleRoot = path.join(fixtureRoot, "config-isolated-oracle");
    mustGit(fixtureRoot, ["clone", "--quiet", "--no-local", "--no-hardlinks", configFixture.root, configOracleRoot]);
    const oracleAttributesFile = path.join(fixtureRoot, "oracle-empty.attributes");
    const oracleOrderFile = path.join(fixtureRoot, "oracle-empty.order");
    await writeFile(oracleAttributesFile, "", "utf8");
    await writeFile(oracleOrderFile, "", "utf8");
    const configOracleRaw = directMetadataWithOracle(
      configOracleRoot,
      configFixture.baseSha,
      configFixture.headSha,
      configFixture.headSha,
      oracleAttributesFile,
      oracleOrderFile
    );
    const configOracleTextRecords = configOracleRaw.records.filter((record) => !record.binary);
    const configOraclePatch = directPatchWithOracle(
      configOracleRoot,
      configFixture.baseSha,
      configFixture.headSha,
      configOracleTextRecords,
      configFixture.headSha,
      oracleAttributesFile,
      oracleOrderFile
    );
    const attributeOracleRoot = path.join(fixtureRoot, "attribute-isolated-oracle");
    mustGit(fixtureRoot, ["clone", "--quiet", "--no-local", "--no-hardlinks", attributeFixture.root, attributeOracleRoot]);
    const attributeOracleRaw = directMetadataWithOracle(
      attributeOracleRoot,
      attributeFixture.baseSha,
      attributeFixture.headSha,
      attributeFixture.headSha,
      oracleAttributesFile,
      oracleOrderFile
    );
    const attributeOracleTextRecords = attributeOracleRaw.records.filter((record) => !record.binary);
    const attributeOraclePatch = redactUnifiedDiff(directPatchWithOracle(
      attributeOracleRoot,
      attributeFixture.baseSha,
      attributeFixture.headSha,
      attributeOracleTextRecords,
      attributeFixture.headSha,
      oracleAttributesFile,
      oracleOrderFile
    ));
    assert.equal(historySameRaw.records.length, 0, "raw root/same history was not empty");
    assert.ok(historyLinearRaw.records.length > 0, "raw linear history did not change");
    assert.notDeepEqual(historyDivergentRaw.records, historyMergeBaseRaw.records, "raw divergent and merge-base cases unexpectedly matched");
    assert.ok(historyMergeRaw.records.length >= 2, "raw merge history did not include both merged sides");
    assert.ok(matrixRaw.records.some((record) => record.status === "R"), "raw matrix lacked rename record");
    assert.ok(matrixRaw.records.some((record) => record.status === "C"), "raw matrix lacked copy record");
    assert.ok(matrixRaw.records.some((record) => record.binary), "raw matrix lacked binary record");
    assert.ok(matrixRaw.records.some((record) => record.status === "T" || (record.oldPath === "type-entry" && record.newPath === "type-entry")), "raw matrix lacked type-change record");
    assert.ok(matrixRaw.records.some((record) => (record.oldPath ?? record.newPath) === "mode-only.sh"), "raw matrix lacked mode record");
    for (const expectedPath of ["space dir/space name.txt", "café/é name.txt", "-leading-dash.txt", "tab\tname.txt", "line\nname.txt"]) {
      assert.ok(matrixRaw.records.some((record) => record.oldPath === expectedPath || record.newPath === expectedPath), "raw matrix lacked hostile path " + JSON.stringify(expectedPath));
    }
    const blockedRaw = blocked.cases.map(([label, baseSha, headSha, blockedPath]) => ({ label, blockedPath, raw: directMetadata(blocked.root, baseSha, headSha).records }));
    for (const entry of blockedRaw) assert.ok(entry.raw.some((record) => record.oldPath === entry.blockedPath || record.newPath === entry.blockedPath), "raw blocked case lacked its blocked side: " + entry.label);
    const ordinaryRecord = matrixRaw.records.find((record) => record.oldPath === "ordinary.txt" || record.newPath === "ordinary.txt");
    assert.ok(ordinaryRecord, "raw public matrix lacked ordinary modified record");
    const ordinaryRawPatch = directPatch(matrix.root, matrix.baseSha, matrix.headSha, [ordinaryRecord]);
    assert.ok(ordinaryRawPatch.includes(matrixSecrets[0]), "raw public matrix patch lacked its secret-bearing changed line");
    assert.equal(budgetRaw.records.length, 2, "raw budget fixture did not contain two changed fragments");
    assert.equal(configRaw.records.length, 2, "raw config fixture did not contain two changed files");
    console.log("RAW_OBSERVATION: root/same=" + historySameRaw.records.length + ", linear=" + historyLinearRaw.records.length + ", divergent=" + historyDivergentRaw.records.length + ", merge-base-to-right=" + historyMergeBaseRaw.records.length + ", merge=" + historyMergeRaw.records.length + "; direct divergent differs from merge-base.");
    console.log("RAW_OBSERVATION: public matrix direct Git records=" + matrixRaw.records.length + ", statuses=" + matrixRaw.records.map((record) => record.status).join(",") + "; rename/copy/binary/type/mode and five odd path identities were independently decoded from NUL producers.");
    console.log("RAW_OBSERVATION: blocked direct Git records independently contain blocked add/delete/rename/copy sides in " + blockedRaw.length + " cases; ordinary patch bytes contain a secret-bearing changed line.");
    emitRawNulEvidence("config-isolated-oracle.name-status", configOracleRaw.nameBytes, configOracleRaw.records.map(publicRecord));
    emitRawNulEvidence("config-isolated-oracle.numstat", configOracleRaw.numstatBytes, configOracleRaw.records.map(publicRecord));
    emitRawNulEvidence("attribute-isolated-oracle.name-status", attributeOracleRaw.nameBytes, attributeOracleRaw.records.map(publicRecord));
    emitRawNulEvidence("attribute-isolated-oracle.numstat", attributeOracleRaw.numstatBytes, attributeOracleRaw.records.map(publicRecord));
    console.log("PREDICATE: TRUE — direct Git producers independently establish all history, record-kind, path, blocked-side, and secret-bearing input predicates before target calls.");

    const helperRoot = path.join(fixtureRoot, "hostile-git-controls");
    await mkdir(helperRoot, { recursive: true });
    const externalHelper = path.join(helperRoot, "external-diff.mjs");
    const textconvHelper = path.join(helperRoot, "textconv.mjs");
    const globalConfig = path.join(helperRoot, "hostile.gitconfig");
    const systemConfig = path.join(helperRoot, "hostile-system.gitconfig");
    const homeRoot = path.join(helperRoot, "hostile-home");
    const xdgConfigHome = path.join(helperRoot, "hostile-xdg");
    const localInclude = path.join(helperRoot, "hostile-include.gitconfig");
    const globalAttributes = path.join(helperRoot, "hostile-global.attributes");
    const systemAttributes = path.join(helperRoot, "hostile-system.attributes");
    const hostileOrderFile = path.join(helperRoot, "hostile-order.txt");
    const tracePath = path.join(helperRoot, "trace.log");
    const trace2Path = path.join(helperRoot, "trace2.json");
    const shallowPath = path.join(helperRoot, "shallow");
    await writeFile(externalHelper, "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(EXTERNAL_DIFF_SENTINEL + "\n") + ");\n", "utf8");
    await writeFile(textconvHelper, "#!/usr/bin/env node\nimport fs from \"node:fs\";\nconst file = process.argv.at(-1);\nprocess.stdout.write(" + JSON.stringify(TEXTCONV_SENTINEL + "\n") + ");\nprocess.stdout.write(fs.readFileSync(file));\n", "utf8");
    await chmod(externalHelper, 0o755);
    await chmod(textconvHelper, 0o755);
    await mkdir(path.join(homeRoot, ".config", "git"), { recursive: true });
    await mkdir(xdgConfigHome, { recursive: true });
    const xdgEmptyHome = path.join(helperRoot, "hostile-xdg-empty");
    await mkdir(xdgEmptyHome, { recursive: true });
    await writeFile(globalConfig, `[diff]\n\torderFile = ${hostileOrderFile}\n\trenameLimit = 1\n\n[diff "hostile"]\n\ttextconv = ${textconvHelper}\n\texternal = ${externalHelper}\n`, "utf8");
    await writeFile(systemConfig, `[diff]\n\texternal = ${externalHelper}\n\torderFile = ${hostileOrderFile}\n`, "utf8");
    await writeFile(path.join(homeRoot, ".gitconfig"), `[diff]\n\texternal = ${externalHelper}\n`, "utf8");
    await writeFile(path.join(homeRoot, ".config", "git", "config"), `[diff]\n\texternal = ${externalHelper}\n`, "utf8");
    await writeFile(path.join(xdgConfigHome, "config"), `[diff]\n\texternal = ${externalHelper}\n\torderFile = ${hostileOrderFile}\n`, "utf8");
    await writeFile(localInclude, `[diff]\n\texternal = ${externalHelper}\n\torderFile = ${hostileOrderFile}\n\trenameLimit = 1\n`, "utf8");
    await writeFile(globalAttributes, "*.hostile -diff\n*.txt -diff\n", "utf8");
    await writeFile(systemAttributes, "*.hostile -diff\n*.txt -diff\n", "utf8");
    await writeFile(hostileOrderFile, "ordinary.txt\n", "utf8");
    const ordinaryTextconv = ordinaryGit(configFixture.root, ["diff", "--no-color", "--textconv", configFixture.baseSha, configFixture.headSha, "--", "config.hostile"], {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig
    });
    const ordinaryExternal = ordinaryGit(configFixture.root, ["diff", "--no-color", configFixture.baseSha, configFixture.headSha, "--", "ordinary.txt"], {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_EXTERNAL_DIFF: externalHelper
    });
    assert.equal(ordinaryTextconv.status, 0, "ordinary hostile textconv probe failed");
    assert.equal(ordinaryTextconv.stdout.toString("utf8").includes(TEXTCONV_SENTINEL), true, "ordinary Git did not invoke hostile textconv helper stdout=" + ordinaryTextconv.stdout.toString("utf8") + " stderr=" + ordinaryTextconv.stderr.toString("utf8"));
    assert.equal(ordinaryExternal.status, 0, "ordinary hostile external-diff probe failed");
    assert.equal(ordinaryExternal.stdout.toString("utf8").includes(EXTERNAL_DIFF_SENTINEL), true, "ordinary Git did not invoke hostile external diff helper stdout=" + ordinaryExternal.stdout.toString("utf8") + " stderr=" + ordinaryExternal.stderr.toString("utf8"));
    const ordinaryConfig = ordinaryGit(configFixture.root, ["config", "--get", "diff.orderFile"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig
    });
    assert.equal(ordinaryConfig.status, 0, "ordinary hostile global config probe failed");
    assert.equal(ordinaryConfig.stdout.toString("utf8").trim(), hostileOrderFile, "ordinary Git did not observe hostile global orderFile");
    const ordinaryHomeConfig = ordinaryGit(configFixture.root, ["config", "--global", "--get", "diff.external"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgEmptyHome,
      GIT_CONFIG_NOSYSTEM: "1"
    });
    const ordinaryXdgConfig = ordinaryGit(configFixture.root, ["config", "--global", "--get", "diff.external"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_CONFIG_NOSYSTEM: "1"
    });
    const ordinarySystemConfig = ordinaryGit(configFixture.root, ["config", "--system", "--get", "diff.external"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgEmptyHome,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_CONFIG_SYSTEM: systemConfig
    });
    assert.equal(ordinaryHomeConfig.status, 0, "ordinary HOME Git config probe failed");
    assert.equal(ordinaryHomeConfig.stdout.toString("utf8").trim(), externalHelper, "ordinary Git did not observe HOME .gitconfig");
    assert.equal(ordinaryXdgConfig.status, 0, "ordinary XDG Git config probe failed");
    assert.equal(ordinaryXdgConfig.stdout.toString("utf8").trim(), externalHelper, "ordinary Git did not observe XDG Git config");
    assert.equal(ordinarySystemConfig.status, 0, "ordinary system Git config probe failed");
    assert.equal(ordinarySystemConfig.stdout.toString("utf8").trim(), externalHelper, "ordinary Git did not observe system Git config");
    // Install conflicting local config/include/info/dirty attributes only
    // after the independent baseline was captured. These must not affect the
    // fixed-SHA public range operation.
    mustGit(configFixture.root, ["config", "diff.hostile.textconv", textconvHelper]);
    mustGit(configFixture.root, ["config", "diff.external", externalHelper]);
    mustGit(configFixture.root, ["config", "diff.orderFile", hostileOrderFile]);
    mustGit(configFixture.root, ["config", "diff.renameLimit", "1"]);
    mustGit(configFixture.root, ["config", "include.path", localInclude]);
    await mkdir(path.join(configFixture.root, ".git", "info"), { recursive: true });
    await writeFile(path.join(configFixture.root, ".git", "info", "attributes"), "*.hostile -diff\n*.txt -diff\n", "utf8");
    await writeFile(path.join(configFixture.root, ".gitattributes"), "*.txt -diff\n", "utf8");
    const ordinaryInfoAttribute = ordinaryGit(configFixture.root, ["check-attr", "diff", "--", "config.hostile"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_GLOBAL: globalAttributes,
      GIT_ATTR_SYSTEM: systemAttributes
    });
    const ordinaryGlobalAttribute = ordinaryGit(configFixture.root, ["check-attr", "diff", "--", "global-only.txt"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ATTR_GLOBAL: globalAttributes,
      GIT_ATTR_SYSTEM: "/dev/null"
    });
    const ordinarySystemAttribute = ordinaryGit(configFixture.root, ["check-attr", "diff", "--", "global-only.system"], {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_ATTR_GLOBAL: "/dev/null",
      GIT_ATTR_SYSTEM: systemAttributes,
      GIT_ATTR_NOSYSTEM: "0"
    });
    assert.equal(ordinaryInfoAttribute.status, 0, "ordinary local info attributes probe failed");
    assert.match(ordinaryInfoAttribute.stdout.toString("utf8"), /config\.hostile: diff: unset/iu, "ordinary Git did not observe local info/attributes override");
    assert.equal(ordinaryGlobalAttribute.status, 0, "ordinary global attributes probe failed");
    assert.match(ordinaryGlobalAttribute.stdout.toString("utf8"), /global-only\.txt: diff: unset/iu, "ordinary Git did not observe global attributes");
    assert.equal(ordinarySystemAttribute.status, 0, "ordinary system attributes probe failed");
    assert.match(ordinarySystemAttribute.stdout.toString("utf8"), /global-only\.system: diff: (?:unset|unspecified)/iu, "ordinary system attributes probe returned an unbounded result");
    console.log(`RAW_OBSERVATION: ordinary Git under hostile global/system/HOME/XDG/local/include config and GIT_EXTERNAL_DIFF emitted sentinels; global orderFile, HOME/XDG/system config, local/global attributes, and the system-attribute probe (${ordinarySystemAttribute.stdout.toString("utf8").trim()}) were independently observed; conflicting local/info/dirty attributes are now physically present for the fixed-SHA falsifier.`);

    const targetCanonicalRoot = await realpath(targetRoot);
    const defaultBCanonicalRoot = await realpath(defaultRootB);
    const targetObjectFormat = gitText(targetRoot, ["rev-parse", "--show-object-format"]);
    const directTargetName = directGit(targetRoot, [
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--find-copies=50%", "-z", "--name-status", "HEAD~1", "HEAD", "--", ":(literal)target-range.txt"
    ]);
    const directTargetNumstat = directGit(targetRoot, [
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--find-copies=50%", "-z", "--numstat", "HEAD~1", "HEAD", "--", ":(literal)target-range.txt"
    ]);
    const directTargetPatch = directRangePatch(targetRoot, "HEAD~1", "HEAD");
    assert.equal(directTargetName.status, 0, "direct target name-status producer failed");
    assert.equal(directTargetNumstat.status, 0, "direct target numstat producer failed");
    assert.equal(directTargetPatch.status, 0, "direct target patch producer failed");
    const directNameBytes = directTargetName.stdout;
    const directNumstatText = directTargetNumstat.stdout.toString("utf8");
    const directPatchText = directTargetPatch.stdout.toString("utf8");
    emitRawNulEvidence("target.name-status", directNameBytes, parseRawNameStatus(directNameBytes));
    emitRawNulEvidence("target.numstat", directTargetNumstat.stdout, parseRawNumstat(directTargetNumstat.stdout));
    assert.equal(directNameBytes.toString("utf8"), "M\0target-range.txt\0", "direct name-status did not yield one exact target record");
    const numstatMatch = /^(\d+)\t(\d+)\ttarget-range\.txt\0$/u.exec(directNumstatText);
    assert.ok(numstatMatch, `direct numstat did not yield one exact target record: ${JSON.stringify(directNumstatText)}`);
    assert.ok(directPatchText.startsWith("diff --git a/target-range.txt b/target-range.txt\n"), "direct patch lacked target header");
    assert.equal(directPatchText.includes(ADD_SECRET), true, "direct raw target patch lacked addition secret");
    assert.equal(directPatchText.includes(DELETE_SECRET), true, "direct raw target patch lacked deletion secret");
    assert.equal(directPatchText.includes(CONTEXT_SECRET), true, "direct raw target patch lacked context secret");
    assert.equal(directPatchText.includes(TARGET_SENTINEL), true, "direct raw target patch lacked target sentinel");
    assert.equal(directPatchText.includes(DEFAULT_SENTINEL), false, "direct raw target patch contained default sentinel");
    const expectedRedactedPatch = redactUnifiedDiff(directPatchText);
    assert.equal(expectedRedactedPatch.includes(ADD_SECRET), false, "supporting redaction oracle retained addition secret");
    assert.equal(expectedRedactedPatch.includes(DELETE_SECRET), false, "supporting redaction oracle retained deletion secret");
    assert.equal(expectedRedactedPatch.includes(CONTEXT_SECRET), false, "supporting redaction oracle retained context secret");

    // PASS 1: exact authority and raw observable facts precede MCP results.
    console.log("AUTHORITY: MISSION_LEDGER.md L011 TASK-007R1 HIGH-001 repair, MISSION_ANCHOR.md A001, and MISSION_PLAN.md P001 TASK-006 AP-011/AP-012.");
    console.log("EXPECTED_RESULT_AUTHORITY: MISSION_ANCHOR.md A001 M002 public contract LAW-001/L AW-016/L AW-017 and MISSION_LEDGER.md L011 TASK-007R1; scripts/redaction-policy.mjs is SUPPORTING_ORACLE only for deterministic redacted patch bytes.");
    console.log(`TARGET_PRODUCER: direct local Git object database in nested target ${targetCanonicalRoot}; A/B target route is same-process createCodexProServer + InMemoryTransport MCP, while stdio is used only for process-death C and adjacent hostile/public routes.`);
    console.log(`RAW_OBSERVATION: default-B HEAD=${defaultBHeadSha} (base=${defaultBBaseSha}) differs from target HEAD=${targetHeadSha} (base=${targetBaseSha}); target object format=${targetObjectFormat}.`);
    console.log(`RAW_OBSERVATION: direct target name-status=M target-range.txt; numstat additions=${numstatMatch[1]} deletions=${numstatMatch[2]}; raw patch bytes=${directTargetPatch.stdout.byteLength}, with distinct target sentinel and secret-bearing addition/deletion/context lines.`);
    console.log("TARGET_EVIDENCE: direct Git name-status/numstat/patch bytes and commit identities. SUPPORTING_ORACLE: accepted redaction-policy implementation computes expected public patch bytes.");
    console.log("SANITY_VERDICT: MATCH — raw target and default facts provide a direct workspace distinction and a secret-bearing patch whose expected public form is bounded and redacted.");
    console.log("PREDICATE: TRUE — direct target HEAD~1 and HEAD resolve to the recorded target base/head SHAs, and the target patch producer independently contains the required changed-file/sentinel facts.");

    // AP-010 identity proof: two fresh MCP server/session objects are created
    // in this one Node process. A opens the nested target; B has a distinct
    // WorkspaceManager/config and starts with only its own default selected.
    // The process-scoped root map is the only route by which B can reconstruct
    // the saved ID; CODEXPRO_HOME is snapshotted to prove it stays untouched.
    const profileHomeBeforeSessions = await directorySnapshot(profileHome);
    assertNoWorkspaceIdentityRegistry(profileHomeBeforeSessions, "initial CODEXPRO_HOME");
    emitSnapshotEvidence("codexpro-home-before-process-scoped-identity", profileHomeBeforeSessions);

    firstClient = await startInMemorySession(defaultRoot, "full", "A");
    const sessionA = firstClient;
    assert.equal(sessionA.processId, process.pid, "session A was not created in this Node process");
    const aCurrentBefore = await directorySnapshot(profileHome);
    const aCurrentCall = await callTool(sessionA, "open_current_workspace", { include_tree: false });
    const aCurrentResult = successResult(aCurrentCall, "session A open_current_workspace");
    assert.equal(aCurrentResult.structuredContent.root, await realpath(defaultRoot), "session A current workspace was not its configured default");
    const aCurrentAfter = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(aCurrentBefore, aCurrentAfter, "session A open_current_workspace");
    emitSnapshotEvidence("codexpro-home-after-session-a-open-current", aCurrentAfter);

    const aOpenBefore = await directorySnapshot(profileHome);
    const opened = await callTool(sessionA, "open_workspace", { path: targetRoot, include_tree: false });
    const openedResult = successResult(opened, "session A open_workspace");
    const openedData = openedResult.structuredContent;
    const workspaceId = openedData.workspace_id;
    assert.match(workspaceId, /^ws_[a-f0-9]{24}$/u, "open_workspace did not return a deterministic workspace ID");
    assert.equal(openedData.root, targetCanonicalRoot, "session A opened the wrong root");
    assert.deepEqual(sessionA.launch.allowedRoots, [await realpath(defaultRoot), await realpath(targetParent)], "session A config allowed roots drifted");
    assert.equal(sessionA.launch.args.includes(targetRoot), false, "session A in-memory launch args contained the exact nested target");
    const aOpenAfter = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(aOpenBefore, aOpenAfter, "session A open_workspace");
    emitSnapshotEvidence("codexpro-home-after-session-a-open", aOpenAfter);
    await sessionA.close();
    assert.ok(sessionA.exitedAt !== undefined, "session A did not record a server/session lifetime");
    firstClient = undefined;

    secondClient = await startInMemorySession(defaultRootB, "full", "B");
    const sessionB = secondClient;
    assert.equal(sessionB.processId, process.pid, "session B was not created in this Node process");
    assert.notEqual(sessionA.serverObject, sessionB.serverObject, "session A and B reused one MCP server object");
    assert.notEqual(sessionA.sessionObject, sessionB.sessionObject, "session A and B reused one MCP client/session object");
    assert.equal(sessionB.config.defaultRoot, defaultBCanonicalRoot, "session B config default root drifted");
    assert.equal(sessionB.launch.profileHome, profileHome, "session B did not share the unique disposable CODEXPRO_HOME");
    assert.equal(serialized(sessionB.launch.args).includes(targetRoot), false, "session B launch args contained the exact nested target");
    assert.equal(serialized(sessionB.launch.environment).includes(targetRoot), false, "session B launch environment contained the exact nested target");
    assert.equal(sessionB.launch.environment.targetRootPresent, false, "session B process environment contained the exact nested target");

    const bCurrentBefore = await directorySnapshot(profileHome);
    const bCurrentCall = await callTool(sessionB, "open_current_workspace", { include_tree: false });
    const bCurrentResult = successResult(bCurrentCall, "session B open_current_workspace");
    assert.equal(bCurrentResult.structuredContent.root, defaultBCanonicalRoot, "session B ambient root was not default-B");
    assert.equal(serialized(bCurrentResult).includes(targetRoot), false, "session B ambient open exposed the nested target");
    const bCurrentAfter = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(bCurrentBefore, bCurrentAfter, "session B open_current_workspace");
    emitSnapshotEvidence("codexpro-home-after-session-b-open-current", bCurrentAfter);

    const bListBefore = await directorySnapshot(profileHome);
    const bListCall = await callTool(sessionB, "list_workspaces", {});
    const bListResult = successResult(bListCall, "session B list_workspaces before explicit lookup");
    const bList = bListResult.structuredContent;
    assert.equal(bList.selected_workspace_id, bCurrentResult.structuredContent.workspace_id, "session B list selected a non-default workspace");
    assert.equal(bList.workspaces.some((workspace) => workspace.root === targetCanonicalRoot), false, "session B local list contained nested target before explicit lookup");
    assert.equal(bList.workspaces.some((workspace) => workspace.root === defaultBCanonicalRoot), true, "session B local list omitted default-B");
    const bListAfter = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(bListBefore, bListAfter, "session B list_workspaces before explicit lookup");
    emitSnapshotEvidence("codexpro-home-after-session-b-list", bListAfter);
    console.log(`RAW_OBSERVATION: same Node process pid=${process.pid}; distinct server objects A=${sessionA.serverObject !== sessionB.serverObject}, client/session objects A!=B=${sessionA.sessionObject !== sessionB.sessionObject}; B ambient root=${defaultBCanonicalRoot}; B pre-lookup local list excludes nested target.`);

    // AP-009: full publication and standard/minimal omission.
    for (const mode of ["standard", "minimal"]) {
      const session = await startClient(defaultRootB, mode);
      try {
        const listing = await session.client.request("tools/list", {});
        const names = (listing.response.result?.tools ?? []).map((tool) => tool.name);
        assert.equal(names.includes("git_diff_range"), false, `${mode} tools/list exposed full-only git_diff_range`);
      } finally {
        await session.client.close();
      }
    }
    assert.equal(sessionB.launch.allowedRoots.includes(path.resolve(targetRoot)), false, "session B config allowed exact nested target");
    console.log(`RAW_OBSERVATION: same-process A/B server/session objects are closed/reconstructed independently; shared CODEXPRO_HOME=${profileHome}; B default=${defaultBCanonicalRoot} and args/env/allowed roots exclude nested target.`);
    const fullListingCall = await secondClient.request("tools/list", {});
    const fullTools = fullListingCall.response.result?.tools ?? [];
    const rangeTools = fullTools.filter((tool) => tool.name === "git_diff_range");
    assert.equal(rangeTools.length, 1, `full tools/list exposed git_diff_range ${rangeTools.length} times`);
    const rangeTool = rangeTools[0];
    const schema = resolveSchema(rangeTool.inputSchema, rangeTool.inputSchema);
    assert.equal(schema.type, "object", "git_diff_range schema is not an object");
    assert.equal(schema.additionalProperties, false, "git_diff_range schema allows unknown properties");
    assert.deepEqual([...schema.required].sort(), ["base_ref", "head_ref", "workspace_id"], "git_diff_range required fields drifted");
    assert.deepEqual(Object.keys(schema.properties).sort(), ["base_ref", "context_lines", "head_ref", "include_patch", "max_files", "max_patch_bytes", "path", "workspace_id"], "git_diff_range property set drifted");
    const property = (name) => resolveSchema(schema, schema.properties[name]);
    assert.equal(property("workspace_id").type, "string");
    assert.equal(property("base_ref").type, "string");
    assert.equal(property("head_ref").type, "string");
    assert.equal(property("path").type, "string");
    assert.equal(property("include_patch").type, "boolean");
    assert.equal(property("include_patch").default, true);
    assert.equal(property("max_files").type, "integer");
    assert.equal(property("max_files").minimum, 1);
    assert.equal(property("max_files").maximum, 200);
    assert.equal(property("max_files").default, 100);
    assert.equal(property("max_patch_bytes").type, "integer");
    assert.equal(property("max_patch_bytes").minimum, 0);
    assert.equal(property("max_patch_bytes").maximum, 100_000);
    assert.equal(property("max_patch_bytes").default, 60_000);
    assert.equal(property("context_lines").type, "integer");
    assert.equal(property("context_lines").minimum, 0);
    assert.equal(property("context_lines").maximum, 20);
    assert.equal(property("context_lines").default, 3);
    assert.equal(rangeTool.annotations?.readOnlyHint, true);
    assert.equal(rangeTool.annotations?.destructiveHint, false);
    assert.equal(rangeTool.annotations?.openWorldHint, false);
    assert.equal(rangeTool._meta?.ui, undefined, "git_diff_range published tool card ui metadata");
    assert.equal(rangeTool._meta?.["openai/outputTemplate"], undefined, "git_diff_range published output template");
    console.log("PASS AP-009: full tools/list exposes exactly one git_diff_range; strict schema bounds/defaults, annotations, and no-card metadata match the accepted contract; standard/minimal omit it.");

    // The snapshot starts after session selection and before any target calls.
    const before = await repositorySnapshot(targetRoot);
    emitSnapshotEvidence("nested-target-before-public-calls", before);
    const profileHomeBeforeExplicitReconstruction = await directorySnapshot(profileHome);
    const explicitCall = await callTool(secondClient, "git_diff_range", { workspace_id: workspaceId, base_ref: "HEAD~1", head_ref: "HEAD" });
    const explicitResult = successResult(explicitCall, "fresh-session explicit git_diff_range");
    const profileHomeAfterExplicitReconstruction = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(profileHomeBeforeExplicitReconstruction, profileHomeAfterExplicitReconstruction, "same-process explicit workspace reconstruction");
    emitSnapshotEvidence("codexpro-home-after-same-process-reconstruction", profileHomeAfterExplicitReconstruction);
    const structured = explicitResult.structuredContent;
    const profileHomeBeforePostLookupList = await directorySnapshot(profileHome);
    const postLookupListCall = await callTool(secondClient, "list_workspaces", {});
    const postLookupListResult = successResult(postLookupListCall, "session B list_workspaces after explicit lookup");
    const postLookupList = postLookupListResult.structuredContent;
    const postLookupDefault = postLookupList.workspaces.find((workspace) => workspace.id === bCurrentResult.structuredContent.workspace_id);
    const postLookupTarget = postLookupList.workspaces.find((workspace) => workspace.id === workspaceId);
    assert.equal(postLookupList.selected_workspace_id, bCurrentResult.structuredContent.workspace_id, "session B explicit lookup changed ambient selection from default-B");
    assert.ok(postLookupDefault, "session B post-lookup list omitted default-B");
    assert.equal(postLookupDefault.root, defaultBCanonicalRoot, "session B post-lookup selected workspace root was not default-B");
    assert.ok(postLookupTarget, "session B post-lookup list omitted explicitly reconstructed target");
    assert.equal(postLookupTarget.id, workspaceId, "session B post-lookup target workspace ID drifted");
    assert.equal(postLookupTarget.root, targetCanonicalRoot, "session B post-lookup target root drifted");
    assert.notEqual(postLookupList.selected_workspace_id, workspaceId, "session B explicit lookup selected the target workspace");
    assert.equal(postLookupList.workspaces.filter((workspace) => workspace.root === targetCanonicalRoot).length, 1, "session B post-lookup list duplicated the target workspace");
    const profileHomeAfterPostLookupList = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(profileHomeBeforePostLookupList, profileHomeAfterPostLookupList, "same-process post-lookup list_workspaces");
    emitSnapshotEvidence("codexpro-home-after-post-lookup-list", profileHomeAfterPostLookupList);
    console.log(`RAW_OBSERVATION: B post-lookup list selected=${postLookupList.selected_workspace_id} default-B=${bCurrentResult.structuredContent.workspace_id}; target id=${postLookupTarget.id} root=${postLookupTarget.root} is present only as a non-selected local workspace.`);
    console.log("PASS same-process post-lookup selection: explicit target reconstruction returned target truth while B list_workspaces retained default-B as selected and exposed the target only as a non-selected local entry.");
    const businessKeys = [
      "base_commit_sha", "base_ref_input", "blocked_files_omitted", "changed_file_count", "changed_files", "changed_files_truncated", "comparison_mode", "eligible_changed_file_count", "head_commit_sha", "head_ref_input", "object_format", "patch", "patch_bytes", "patch_files_included", "patch_files_omitted", "patch_included", "patch_limit", "patch_omission_counts", "patch_requested", "patch_truncated", "returned_file_count", "root", "schema_version", "warnings", "workspace_id"
    ];
    assert.deepEqual(Object.keys(structured).sort(), ["codexpro_title", "codexpro_tool", ...businessKeys].sort(), "git_diff_range structured contract key set drifted");
    assert.equal(structured.codexpro_tool, "git_diff_range");
    assert.equal(structured.schema_version, 1);
    assert.equal(structured.workspace_id, workspaceId);
    assert.equal(structured.root, targetCanonicalRoot);
    assert.equal(structured.comparison_mode, "direct-two-tree");
    assert.equal(structured.object_format, targetObjectFormat);
    assert.equal(structured.base_ref_input, "HEAD~1");
    assert.equal(structured.base_commit_sha, targetBaseSha);
    assert.equal(structured.head_ref_input, "HEAD");
    assert.equal(structured.head_commit_sha, targetHeadSha);
    assert.equal(structured.changed_file_count, 1);
    assert.equal(structured.eligible_changed_file_count, 1);
    assert.equal(structured.returned_file_count, 1);
    assert.equal(structured.changed_files_truncated, false);
    assert.equal(structured.blocked_files_omitted, 0);
    assert.deepEqual(structured.changed_files, [{ status: "M", old_path: "target-range.txt", new_path: "target-range.txt", similarity: null, additions: Number(numstatMatch[1]), deletions: Number(numstatMatch[2]), binary: false }]);
    assert.equal(structured.patch, expectedRedactedPatch);
    assert.equal(structured.patch_requested, true);
    assert.equal(structured.patch_included, true);
    assert.equal(structured.patch_truncated, false);
    assert.equal(structured.patch_bytes, Buffer.byteLength(expectedRedactedPatch, "utf8"));
    assert.equal(structured.patch_limit, 60_000);
    assert.equal(structured.patch_files_included, 1);
    assert.equal(structured.patch_files_omitted, 0);
    assert.deepEqual(structured.patch_omission_counts, { binary: 0, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 });
    assert.deepEqual(structured.warnings, []);
    assert.equal(Object.hasOwn(structured, "path"), false);
    assert.equal(explicitResult._meta?.ui, undefined);
    assert.equal(explicitResult._meta?.["openai/outputTemplate"], undefined);

    // Patch identity is checked by exact object path, not by naive substring
    // counting of repeated diff fragments.
    const patchLocations = valuesAtPaths(explicitResult, (value, pathParts) => value === expectedRedactedPatch).map(({ path: pathParts }) => pathParts.join("."));
    assert.deepEqual(patchLocations, ["structuredContent.patch"], "patch appeared at an unexpected envelope location or more than once");
    assert.equal((explicitCall.raw.match(/"patch":/gu) ?? []).length, 1, "complete response contained more than one exact patch field");
    assert.equal(serialized(explicitResult.content).includes(expectedRedactedPatch), false, "human content duplicated the full patch");
    assert.equal(serialized(explicitResult._meta).includes(expectedRedactedPatch), false, "_meta duplicated the full patch");
    assert.equal(serialized(explicitResult.content).includes(ADD_SECRET), false, "human content leaked addition secret");
    assert.equal(serialized(explicitResult._meta).includes(ADD_SECRET), false, "_meta leaked addition secret");
    assertNoLiterals(explicitCall.response, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET, DEFAULT_SENTINEL], "complete explicit response");
    assert.equal(serialized(explicitResult.content).includes(TARGET_SENTINEL), false, "human content duplicated the target patch sentinel");
    assert.equal(explicitResult.content.some((part) => typeof part?.text === "string" && part.text.includes(TARGET_SENTINEL)), false, "human content exposed patch sentinel");
    assert.equal(structured.patch.includes(TARGET_SENTINEL), true, "structured patch omitted target sentinel");
    assert.equal(structured.patch.includes(DEFAULT_SENTINEL), false, "structured patch used default-workspace sentinel");
    assertNoResponseLiterals(explicitCall, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET, DEFAULT_SENTINEL], "complete explicit response envelope");
    console.log(`RAW_ENVELOPE: fresh-session success=${serialized(explicitCall.response)}`);
    console.log("PASS fresh-session explicit target: B used only saved target workspace_id despite distinct default-B; exact refs/counts/file/patch truth matched direct Git and patch occurred only at structuredContent.patch with redaction.");

    const profileHomeBeforeReviewers = await directorySnapshot(profileHome);
    const reviewerSnapshotCall = await callTool(secondClient, "workspace_snapshot", { workspace_id: workspaceId, max_depth: 1, max_files: 20 });
    const reviewerSnapshotResult = successResult(reviewerSnapshotCall, "explicit workspace_snapshot reviewer call");
    assert.equal(reviewerSnapshotResult.structuredContent.root, targetCanonicalRoot, "workspace_snapshot reviewer call used the wrong root");
    assertNoResponseLiterals(reviewerSnapshotCall, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET], "explicit workspace_snapshot reviewer call");
    const reviewerChangesCall = await callTool(secondClient, "show_changes", { workspace_id: workspaceId, include_diff: false, mark_reviewed: true });
    const reviewerChangesResult = successResult(reviewerChangesCall, "explicit show_changes reviewer call");
    assert.equal(reviewerChangesResult.structuredContent.root, targetCanonicalRoot, "show_changes reviewer call used the wrong root");
    assertNoResponseLiterals(reviewerChangesCall, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET], "explicit show_changes reviewer call");
    const profileHomeAfterReviewers = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(profileHomeBeforeReviewers, profileHomeAfterReviewers, "explicit reviewer calls");
    emitSnapshotEvidence("codexpro-home-after-explicit-reviewer-calls", profileHomeAfterReviewers);
    console.log("PASS no-persistence reviewer calls: explicit workspace_snapshot and show_changes used the reconstructed target and left CODEXPRO_HOME/profile/runtime entries unchanged.");

    // Nearby process-scoped falsifiers run against the live B manager before
    // crossing the process boundary. They exercise root revalidation rather
    // than any disk identity registry or synthetic stand-in.
    const processFalsifier = async (label, mutate, restore, expectedPattern = /workspace|canonical|allowed|stale|invalid/iu) => {
      await mutate();
      try {
        const call = await callTool(secondClient, "git_diff_range", { workspace_id: workspaceId, base_ref: targetBaseSha, head_ref: targetHeadSha, include_patch: false });
        const result = errorResult(call, label);
        assertNoResponseLiterals(call, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET, TARGET_SENTINEL, DEFAULT_SENTINEL], label);
        assert.match(serialized(result), expectedPattern, `${label} was not a bounded root revalidation rejection`);
        console.log(`RAW_ENVELOPE: ${label}=${serialized(call.response)}`);
        return call;
      } finally {
        await restore();
      }
    };
    const staleId = "ws_000000000000000000000000";
    const staleCall = await callTool(secondClient, "git_diff_range", { workspace_id: staleId, base_ref: "HEAD~1", head_ref: "HEAD", include_patch: false });
    const staleResult = errorResult(staleCall, "unknown workspace id in process");
    assertNoResponseLiterals(staleCall, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET, TARGET_SENTINEL, DEFAULT_SENTINEL], "unknown workspace id in process");
    assert.match(serialized(staleResult), /unknown|workspace/iu, "unknown workspace id was not bounded");
    console.log(`RAW_ENVELOPE: unknown-process-id=${serialized(staleCall.response)}`);
    const movedTargetRoot = path.join(targetParent, "nested-target-moved");
    await processFalsifier("symlink/path drift", async () => {
      await rename(targetRoot, movedTargetRoot);
      await symlink(movedTargetRoot, targetRoot);
      assert.equal(await realpath(targetRoot), await realpath(movedTargetRoot), "fixture symlink drift target was not established");
    }, async () => {
      await unlink(targetRoot);
      await rename(movedTargetRoot, targetRoot);
    });
    await processFalsifier("deleted canonical root", async () => {
      await rename(targetRoot, movedTargetRoot);
    }, async () => {
      await rename(movedTargetRoot, targetRoot);
    });
    const allowedRootsBeforeRevocation = [...sessionB.config.allowedRoots];
    await processFalsifier("revoked allowed root", async () => {
      sessionB.config.allowedRoots = [defaultBCanonicalRoot];
    }, async () => {
      sessionB.config.allowedRoots = allowedRootsBeforeRevocation;
    });
    console.log("PASS process-scoped revalidation falsifiers: unknown ID, symlink/path drift, deleted canonical root, and allowed-root revocation fail closed without disk identity registry or target/default leakage.");

    // End both in-memory sessions before starting the child-process falsifier.
    // Its fresh process has no module-level root map and must not reconstruct
    // the nested ID from CODEXPRO_HOME or from setup arguments/environment.
    const profileHomeBeforeProcessDeath = await directorySnapshot(profileHome);
    await sessionB.close();
    secondClient = undefined;
    const sessionC = (await startClient(defaultRootB, "full")).client;
    try {
      assert.equal(serialized(sessionC.launch.args).includes(targetRoot), false, "process-death C launch args contained the exact nested target");
      assert.equal(serialized(sessionC.launch.environment).includes(targetRoot), false, "process-death C launch environment contained the exact nested target");
      assert.equal(sessionC.launch.environment.targetRootPresent, false, "process-death C effective environment contained the exact nested target");
      const processDeathCall = await callTool(sessionC, "git_diff_range", {
        workspace_id: workspaceId,
        base_ref: targetBaseSha,
        head_ref: targetHeadSha,
        include_patch: false
      });
      const processDeathResult = errorResult(processDeathCall, "process-death unknown workspace id");
      assertNoResponseLiterals(processDeathCall, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET, TARGET_SENTINEL, DEFAULT_SENTINEL], "process-death unknown workspace id");
      assert.match(serialized(processDeathResult), /unknown|workspace|open_workspace|reconstruct|unavailable/iu, "process-death call was not a bounded unknown/reconstruction failure");
      assert.equal(serialized(processDeathResult).includes(targetCanonicalRoot), false, "process-death error exposed target root");
      console.log(`RAW_OBSERVATION: process-death C pid=${sessionC.pid}; C had no prior open, default=${sessionC.launch.defaultRoot}, allowed=${sessionC.launch.allowedRoots.join(",")}, targetRootInArgs=false, targetRootInEnvironment=false; saved ID did not reconstruct.`);
      console.log(`RAW_ENVELOPE: process-death unknown=${serialized(processDeathCall.response)}`);
      console.log("PASS process-death falsifier: a fresh OS child with shared CODEXPRO_HOME and only default-B/allowed-parent setup rejected saved nested ID without target data.");
    } finally {
      await sessionC.close();
    }
    const profileHomeAfterProcessDeath = await directorySnapshot(profileHome);
    assertProfileHomeUnchanged(profileHomeBeforeProcessDeath, profileHomeAfterProcessDeath, "process-death falsifier");
    secondClient = (await startClient(defaultRootB, "full")).client;

    // Missing workspace_id must reject even though default-B has valid HEAD~1
    // and HEAD refs. This is the fallback falsifier and error-envelope proof.
    const missingBefore = await repositorySnapshot(targetRoot);
    const missingCall = await callTool(secondClient, "git_diff_range", { base_ref: "HEAD~1", head_ref: "HEAD" });
    const missingResult = errorResult(missingCall, "missing workspace_id");
    const missingText = serialized(missingResult);
    assert.match(missingText, /workspace_id/iu, "missing-ID error did not identify workspace_id");
    assert.equal(missingText.includes(DEFAULT_SENTINEL), false, "missing-ID call fell back to default-B workspace");
    assert.equal(missingText.includes(TARGET_SENTINEL), false, "missing-ID call returned target content");
    assert.equal(missingResult.structuredContent?.error?.includes?.(DEFAULT_SENTINEL) ?? false, false);
    assert.equal(missingResult.structuredContent?.error?.includes?.(TARGET_SENTINEL) ?? false, false);
    const missingAfter = await repositorySnapshot(targetRoot);
    assert.deepEqual(missingAfter, missingBefore, "missing-ID validation changed target repository state");
    console.log("PASS missing workspace_id: validation returned an error before fallback could use valid default-B refs; target snapshot stayed unchanged and no target/default sentinel appeared.");

    // A hostile unknown key is supplied through the real MCP transport. Its
    // name and value must be absent from every returned/result/protocol field.
    const hostileCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: workspaceId,
      base_ref: "HEAD~1",
      head_ref: "HEAD",
      [HOSTILE_KEY]: HOSTILE_VALUE
    });
    const hostileResult = errorResult(hostileCall, "hostile unknown property");
    assert.match(serialized(hostileResult), /unknown|unrecognized|invalid arguments/iu, "hostile unknown-property error was not a bounded schema rejection");
    assertNoHostileResponse(hostileCall, "hostile unknown property");
    console.log(`RAW_ENVELOPE: hostile unknown-key response keys=${Object.keys(hostileCall.response).sort().join(",")}; result keys=${Object.keys(hostileCall.response.result).sort().join(",")}; serialized=${hostileCall.raw}`);
    console.log("PASS hostile unknown property: runtime rejection returned no hostile key/value in content, structuredContent, _meta, protocol error.message, error.data, or complete response JSON.");

    const openFixture = async (root, label) => {
      const call = await callTool(secondClient, "open_workspace", { path: root, include_tree: false });
      const result = successResult(call, label + " open_workspace");
      assert.equal(result.structuredContent.root, await realpath(root), label + " opened wrong root");
      return { id: result.structuredContent.workspace_id, root: result.structuredContent.root };
    };
    const disabledCounts = (records) => ({
      binary: records.filter((record) => record.binary).length,
      blocked: 0,
      budget: 0,
      disabled: records.filter((record) => !record.binary).length,
      file_limit: 0,
      too_large: 0
    });
    const historyWorkspace = await openFixture(history.root, "history matrix");
    const historyCases = [
      ["root/same", history.rootSha, history.rootSha, historySameRaw.records],
      ["linear", history.rootSha, history.linearSha, historyLinearRaw.records],
      ["divergent direct", history.leftSha, history.rightSha, historyDivergentRaw.records],
      ["merge-base comparison", history.mergeBaseSha, history.rightSha, historyMergeBaseRaw.records],
      ["merge history", history.rootSha, history.mergeSha, historyMergeRaw.records]
    ];
    for (const [label, baseRef, headRef, raw] of historyCases) {
      const call = await callTool(secondClient, "git_diff_range", { workspace_id: historyWorkspace.id, base_ref: baseRef, head_ref: headRef, include_patch: false });
      const result = successResult(call, label);
      assertPublicRange(result.structuredContent, {
        workspaceId: historyWorkspace.id,
        root: historyWorkspace.root,
        baseRef,
        baseSha: baseRef,
        headRef,
        headSha: headRef,
        raw,
        eligible: raw,
        returned: raw,
        blocked: 0,
        patchRequested: false,
        patchLimit: 60_000,
        omissionCounts: disabledCounts(raw)
      }, label);
      assertNoResponseLiterals(call, matrixSecrets, label);
    }
    const divergentPublic = await callTool(secondClient, "git_diff_range", { workspace_id: historyWorkspace.id, base_ref: history.leftSha, head_ref: history.rightSha, include_patch: false });
    const divergentResult = successResult(divergentPublic, "public divergent direct");
    assert.notDeepEqual(divergentResult.structuredContent.changed_files, historyMergeBaseRaw.records.map(publicRecord), "public direct comparison silently used merge-base semantics");
    console.log("PASS public history matrix: root/same, linear, divergent direct, explicit merge-base composition, and merge history match independent direct Git metadata; direct remains distinct from merge-base.");

    const matrixWorkspace = await openFixture(matrix.root, "record-kind/path matrix");
    const matrixBefore = await repositorySnapshot(matrix.root, matrix.relevantPaths);
    const matrixEligible = matrixRaw.records.filter((record) => !blockedRecord(record));
    const matrixCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: matrixWorkspace.id,
      base_ref: matrix.baseSha,
      head_ref: matrix.headSha,
      include_patch: false,
      max_files: 200
    });
    const matrixResult = successResult(matrixCall, "public record-kind/path matrix");
    assertPublicRange(matrixResult.structuredContent, {
      workspaceId: matrixWorkspace.id,
      root: matrixWorkspace.root,
      baseRef: matrix.baseSha,
      baseSha: matrix.baseSha,
      headRef: matrix.headSha,
      headSha: matrix.headSha,
      raw: matrixRaw.records,
      eligible: matrixEligible,
      returned: matrixEligible,
      blocked: matrixRaw.records.length - matrixEligible.length,
      patchRequested: false,
      patchLimit: 60_000,
      omissionCounts: {
        ...disabledCounts(matrixEligible),
        blocked: matrixRaw.records.filter(blockedRecord).length
      }
    }, "public record-kind/path matrix");
    assertNoResponseLiterals(matrixCall, matrixSecrets, "public record-kind/path matrix");
    assert.equal(JSON.stringify(matrixResult.structuredContent).includes(".env.public"), false, "blocked path leaked in public matrix result");
    const matrixLimitCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: matrixWorkspace.id,
      base_ref: matrix.baseSha,
      head_ref: matrix.headSha,
      include_patch: false,
      max_files: 3
    });
    const matrixLimitResult = successResult(matrixLimitCall, "public max_files exact total");
    assertPublicRange(matrixLimitResult.structuredContent, {
      workspaceId: matrixWorkspace.id,
      root: matrixWorkspace.root,
      baseRef: matrix.baseSha,
      baseSha: matrix.baseSha,
      headRef: matrix.headSha,
      headSha: matrix.headSha,
      raw: matrixRaw.records,
      eligible: matrixEligible,
      returned: matrixEligible.slice(0, 3),
      blocked: matrixRaw.records.length - matrixEligible.length,
      patchRequested: false,
      patchLimit: 60_000,
      omissionCounts: {
        binary: matrixEligible.slice(0, 3).filter((record) => record.binary).length,
        blocked: matrixRaw.records.filter(blockedRecord).length,
        budget: 0,
        disabled: matrixEligible.slice(0, 3).filter((record) => !record.binary).length,
        file_limit: matrixEligible.length - 3,
        too_large: 0
      }
    }, "public max_files exact total");
    assertNoResponseLiterals(matrixLimitCall, matrixSecrets, "public max_files exact total");
    const matrixAfter = await repositorySnapshot(matrix.root, matrix.relevantPaths);
    assert.deepEqual(matrixAfter, matrixBefore, "public metadata/path calls changed dirty target state");
    console.log("PASS public metadata matrix: rename/copy/binary/type/mode, spaces/Unicode/leading-dash/tab/newline paths, whole blocked omission, exact total, and max_files prefix are direct-producer matched.");

    const blockedWorkspace = await openFixture(blocked.root, "blocked orientation matrix");
    const blockedBefore = await repositorySnapshot(blocked.root);
    for (const entry of blockedRaw) {
      const raw = entry.raw;
      const blockedCase = blocked.cases.find((item) => item[0] === entry.label);
      const blockedBaseSha = blockedCase[1];
      const blockedHeadSha = blockedCase[2];
      const blockedOrientation = blockedCase[4];
      const eligible = raw.filter((record) => !blockedRecord(record));
      const textEligible = eligible.filter((record) => !record.binary);
      const expectedPatch = textEligible.map((record) => redactUnifiedDiff(directPatch(blocked.root, blockedBaseSha, blockedHeadSha, [record]))).join("");
      const call = await callTool(secondClient, "git_diff_range", {
        workspace_id: blockedWorkspace.id,
        base_ref: blockedBaseSha,
        head_ref: blockedHeadSha,
        include_patch: true
      });
      const result = successResult(call, entry.label + " public blocked filtering");
      assertPublicRange(result.structuredContent, {
        workspaceId: blockedWorkspace.id,
        root: blockedWorkspace.root,
        baseRef: blockedBaseSha,
        baseSha: blockedBaseSha,
        headRef: blockedHeadSha,
        headSha: blockedHeadSha,
        raw,
        eligible,
        returned: eligible,
        blocked: raw.length - eligible.length,
        patch: expectedPatch,
        patchRequested: true,
        patchLimit: 60_000,
        patchTruncated: false,
        patchFilesIncluded: textEligible.length,
        omissionCounts: {
          binary: eligible.filter((record) => record.binary).length,
          blocked: raw.length - eligible.length,
          budget: 0,
          disabled: 0,
          file_limit: 0,
          too_large: 0
        }
      }, entry.label + " public blocked filtering");
      assertNoResponseLiterals(call, [entry.blockedPath, BLOCKED_SECRET], entry.label + " public blocked filtering");
      if (blockedOrientation.startsWith("rename") || blockedOrientation.startsWith("copy")) {
        const oriented = raw.find((record) => record.status === "R" || record.status === "C");
        assert.ok(oriented, entry.label + " raw direct producer lacked rename/copy orientation");
        assert.equal(oriented.oldPath === entry.blockedPath || oriented.newPath === entry.blockedPath, true, entry.label + " blocked side was not represented in raw evidence");
      }
      console.log("PASS public blocked whole-record filtering: " + entry.label + " (" + blockedOrientation + "), raw=" + raw.length + ", eligible=" + eligible.length + ", omitted=" + (raw.length - eligible.length));
    }
    const blockedAfter = await repositorySnapshot(blocked.root);
    assert.deepEqual(blockedAfter, blockedBefore, "public blocked calls changed blocked fixture state");

    const blockedPathCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: blockedWorkspace.id,
      base_ref: blocked.cases[0][1],
      head_ref: blocked.cases[0][2],
      path: blocked.cases[0][3],
      include_patch: true
    });
    const blockedPathResult = errorResult(blockedPathCall, "blocked historical path filter");
    assert.match(serialized(blockedPathResult), /blocked|safety|path/iu, "blocked historical path filter error was not bounded");
    assertNoResponseLiterals(blockedPathCall, [blocked.cases[0][3], BLOCKED_SECRET], "blocked historical path filter");
    console.log("PASS public blocked historical path filter: blocked source literal and secret absent from complete envelope.");

    const budgetWorkspace = await openFixture(budget.root, "patch budget matrix");
    const budgetBefore = await repositorySnapshot(budget.root, budget.relevantPaths);
    const budgetA = budgetRaw.records.find((record) => record.newPath === "a.txt");
    const budgetB = budgetRaw.records.find((record) => record.newPath === "b.txt");
    assert.ok(budgetA && budgetB, "raw budget fixture records were not independently established");
    const budgetAPatch = redactUnifiedDiff(directPatch(budget.root, budget.baseSha, budget.headSha, [budgetA]));
    const budgetBPatch = redactUnifiedDiff(directPatch(budget.root, budget.baseSha, budget.headSha, [budgetB]));
    const budgetExactCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: budgetWorkspace.id,
      base_ref: budget.baseSha,
      head_ref: budget.headSha,
      path: "a.txt",
      max_patch_bytes: Buffer.byteLength(budgetAPatch, "utf8")
    });
    const budgetExactResult = successResult(budgetExactCall, "public exact-fit patch");
    assertPublicRange(budgetExactResult.structuredContent, {
      workspaceId: budgetWorkspace.id, root: budgetWorkspace.root, baseRef: budget.baseSha, baseSha: budget.baseSha, headRef: budget.headSha, headSha: budget.headSha,
      path: "a.txt", raw: [budgetA], eligible: [budgetA], returned: [budgetA], blocked: 0, patch: budgetAPatch, patchRequested: true,
      patchLimit: Buffer.byteLength(budgetAPatch, "utf8"), patchTruncated: false, patchFilesIncluded: 1,
      omissionCounts: { binary: 0, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 }
    }, "public exact-fit patch");
    assertNoResponseLiterals(budgetExactCall, [matrixSecrets[0]], "public exact-fit patch");
    const budgetUnderLimit = Buffer.byteLength(budgetAPatch, "utf8") - 1;
    const budgetUnderCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: budgetWorkspace.id,
      base_ref: budget.baseSha,
      head_ref: budget.headSha,
      path: "a.txt",
      max_patch_bytes: budgetUnderLimit
    });
    const budgetUnderResult = successResult(budgetUnderCall, "public one-byte-under patch");
    assertPublicRange(budgetUnderResult.structuredContent, {
      workspaceId: budgetWorkspace.id, root: budgetWorkspace.root, baseRef: budget.baseSha, baseSha: budget.baseSha, headRef: budget.headSha, headSha: budget.headSha,
      path: "a.txt", raw: [budgetA], eligible: [budgetA], returned: [budgetA], blocked: 0, patch: "", patchRequested: true,
      patchLimit: budgetUnderLimit, patchTruncated: true, patchFilesIncluded: 0,
      omissionCounts: { binary: 0, blocked: 0, budget: 1, disabled: 0, file_limit: 0, too_large: 0 }
    }, "public one-byte-under patch");
    assertNoResponseLiterals(budgetUnderCall, [matrixSecrets[0]], "public one-byte-under patch");
    const budgetMultiCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: budgetWorkspace.id,
      base_ref: budget.baseSha,
      head_ref: budget.headSha,
      max_patch_bytes: Buffer.byteLength(budgetAPatch, "utf8")
    });
    const budgetMultiResult = successResult(budgetMultiCall, "public multi-fragment prefix");
    assertPublicRange(budgetMultiResult.structuredContent, {
      workspaceId: budgetWorkspace.id, root: budgetWorkspace.root, baseRef: budget.baseSha, baseSha: budget.baseSha, headRef: budget.headSha, headSha: budget.headSha,
      raw: budgetRaw.records, eligible: budgetRaw.records, returned: budgetRaw.records, blocked: 0, patch: budgetAPatch, patchRequested: true,
      patchLimit: Buffer.byteLength(budgetAPatch, "utf8"), patchTruncated: true, patchFilesIncluded: 1,
      omissionCounts: { binary: 0, blocked: 0, budget: 1, disabled: 0, file_limit: 0, too_large: 0 }
    }, "public multi-fragment prefix");
    assertNoResponseLiterals(budgetMultiCall, [matrixSecrets[0]], "public multi-fragment prefix");
    const budgetDisabledCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: budgetWorkspace.id,
      base_ref: budget.baseSha,
      head_ref: budget.headSha,
      include_patch: false
    });
    const budgetDisabledResult = successResult(budgetDisabledCall, "public include_patch=false");
    assert.equal(budgetDisabledResult.structuredContent.patch, "", "public include_patch=false emitted patch bytes");
    assert.equal(budgetDisabledResult.structuredContent.patch_requested, false, "public include_patch=false request flag drifted");
    assert.equal(budgetDisabledResult.structuredContent.patch_files_included, 0, "public include_patch=false included a fragment");
    assert.equal(budgetDisabledResult.structuredContent.patch_omission_counts.disabled, 2, "public include_patch=false disabled count drifted");
    assertNoResponseLiterals(budgetDisabledCall, [matrixSecrets[0]], "public include_patch=false");
    const budgetAfter = await repositorySnapshot(budget.root, budget.relevantPaths);
    assert.deepEqual(budgetAfter, budgetBefore, "public patch budget calls changed repository state");
    console.log("PASS public patch matrix: exact-fit, one-byte-under, multi-fragment complete-prefix, include_patch=false non-emission, and secret redaction match direct raw Git plus bounded policy support.");

    const hostileEnvironment = {
      PATH: helperRoot + path.delimiter + (process.env.PATH ?? ""),
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgConfigHome,
      GIT_EXTERNAL_DIFF: externalHelper,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: "0",
      GIT_ATTR_GLOBAL: globalAttributes,
      GIT_ATTR_SYSTEM: systemAttributes,
      GIT_DIFF_OPTS: "--stat",
      GIT_TRACE: tracePath,
      GIT_TRACE2_EVENT: trace2Path,
      GIT_SHALLOW_FILE: shallowPath,
      GIT_NO_REPLACE_OBJECTS: "0",
      GIT_NO_LAZY_FETCH: "0",
      GIT_ATTR_SOURCE: globalConfig,
      GIT_TERMINAL_PROMPT: "1",
      CODEXPRO_MAX_READ_BYTES: "4000"
    };
    await secondClient.close();
    secondClient = (await startClient(defaultRootB, "full", hostileEnvironment)).client;
    const configWorkspace = await openFixture(configFixture.root, "hostile Git controls");
    // Opening a workspace is setup, not the target operation, and its broad
    // repository probe may itself honor inherited trace routing. Establish a
    // clean hostile-artifact baseline after setup so the assertion below
    // isolates git_diff_range's sealed Git producers.
    for (const artifact of [tracePath, trace2Path, shallowPath]) {
      try {
        await unlink(artifact);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    // Arm a replacement ref whose ordinary Git subject is observably hostile;
    // the target operation must continue to use the captured original SHA.
    const replacementTree = gitText(configFixture.root, ["rev-parse", `${configFixture.baseSha}^{tree}`]);
    const replacementCommit = mustGit(configFixture.root, ["commit-tree", replacementTree, "-m", "HOSTILE_REPLACEMENT_SUBJECT_5C8"]).toString("utf8").trim();
    mustGit(configFixture.root, ["replace", configFixture.baseSha, replacementCommit]);
    const ordinaryReplacement = ordinaryGit(configFixture.root, ["show", "-s", "--format=%s", configFixture.baseSha], {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig
    });
    assert.equal(ordinaryReplacement.status, 0, "ordinary replacement-ref probe failed");
    assert.equal(ordinaryReplacement.stdout.toString("utf8").trim(), "HOSTILE_REPLACEMENT_SUBJECT_5C8", "ordinary Git did not observe replacement ref");
    console.log("RAW_OBSERVATION: ordinary Git with replacement ref returned HOSTILE_REPLACEMENT_SUBJECT_5C8; replacement predicate is TRUE before sealed fixed-SHA target call.");

    const configBefore = await repositorySnapshot(configFixture.root, configFixture.relevantPaths);
    emitSnapshotEvidence("config-before-hostile-fixed-sha", configBefore);
    const configExpectedRaw = configOracleRaw.records;
    assert.deepEqual(configExpectedRaw, configRaw.records, "clean target and independent oracle metadata differed before hostile mutation");
    const configExpectedTextRecords = configOracleTextRecords;
    const configExpectedPatch = configOraclePatch;
    const configTargetRecord = configExpectedRaw.find((record) => record.newPath === "config.hostile");
    assert.ok(configTargetRecord?.binary, "raw config fixture did not establish a binary textconv target");
    const hostileControlsCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: configWorkspace.id,
      base_ref: configFixture.baseSha,
      head_ref: configFixture.headSha
    });
    const hostileControlsResult = successResult(hostileControlsCall, "hostile inherited Git controls");
    assertPublicRange(hostileControlsResult.structuredContent, {
      workspaceId: configWorkspace.id, root: configWorkspace.root, baseRef: configFixture.baseSha, baseSha: configFixture.baseSha, headRef: configFixture.headSha, headSha: configFixture.headSha,
      raw: configExpectedRaw, eligible: configExpectedRaw, returned: configExpectedRaw, blocked: 0, patch: configExpectedPatch,
      patchRequested: true, patchLimit: 60_000, patchTruncated: false, patchFilesIncluded: configExpectedTextRecords.length,
      omissionCounts: { binary: configExpectedRaw.filter((record) => record.binary).length, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 }
    }, "hostile inherited Git controls");
    assertNoResponseLiterals(hostileControlsCall, [EXTERNAL_DIFF_SENTINEL, TEXTCONV_SENTINEL, "HOSTILE_REPLACEMENT_SUBJECT_5C8"], "hostile inherited Git controls");
    console.log(`RAW_ENVELOPE: fixed-sha hostile success=${serialized(hostileControlsCall.response)}`);
    assert.equal(await fileDigest(tracePath).then((value) => value.exists), false, "sealed Git execution honored hostile GIT_TRACE");
    assert.equal(await fileDigest(trace2Path).then((value) => value.exists), false, "sealed Git execution honored hostile GIT_TRACE2_EVENT");
    assert.equal(await fileDigest(shallowPath).then((value) => value.exists), false, "sealed Git execution honored hostile GIT_SHALLOW_FILE");
    const configAfter = await repositorySnapshot(configFixture.root, configFixture.relevantPaths);
    assert.deepEqual(configAfter, configBefore, "hostile Git controls changed target repository state");
    emitSnapshotEvidence("config-after-hostile-fixed-sha", configAfter);
    console.log("PASS fixed-SHA hostile Git controls: independent isolated-tree oracle matched public metadata/patch despite dirty .gitattributes, local include/config/info attributes, HOME/XDG/global/system config/attributes, external diff/textconv/order/rename-limit, replacement/shallow/lazy controls; target snapshot stayed immutable.");

    const binaryPathCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: configWorkspace.id,
      base_ref: configFixture.baseSha,
      head_ref: configFixture.headSha,
      path: "config.hostile"
    });
    const binaryPathResult = successResult(binaryPathCall, "fixed-SHA binary path");
    assertPublicRange(binaryPathResult.structuredContent, {
      workspaceId: configWorkspace.id, root: configWorkspace.root, baseRef: configFixture.baseSha, baseSha: configFixture.baseSha, headRef: configFixture.headSha, headSha: configFixture.headSha,
      path: "config.hostile", raw: [configTargetRecord], eligible: [configTargetRecord], returned: [configTargetRecord], blocked: 0, patch: "",
      patchRequested: true, patchLimit: 60_000, patchTruncated: false, patchFilesIncluded: 0,
      omissionCounts: { binary: 1, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 }
    }, "fixed-SHA binary path");
    assertNoResponseLiterals(binaryPathCall, [EXTERNAL_DIFF_SENTINEL, TEXTCONV_SENTINEL], "fixed-SHA binary path");

    const attributeWorkspace = await openFixture(attributeFixture.root, "committed head-attribute direction");
    const attributeBefore = await repositorySnapshot(attributeFixture.root, attributeFixture.relevantPaths);
    const directionRecord = attributeOracleRaw.records.find((record) => record.newPath === "direction.txt");
    const reverseRecord = attributeOracleRaw.records.find((record) => record.newPath === "reverse.txt");
    assert.ok(directionRecord && reverseRecord, "attribute oracle omitted directional records");
    assert.equal(directionRecord.binary, false, "head-tree diff attribute did not make direction.txt textual");
    assert.equal(reverseRecord.binary, true, "head-tree -diff attribute did not make reverse.txt binary");
    console.log("PREDICATE: TRUE — independent head-tree oracle establishes direction.txt as textual and reverse.txt as binary before the public attribute-route call; the reverse-direction predicate is not inferred from the returned effect.");
    const attributeCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: attributeWorkspace.id,
      base_ref: attributeFixture.baseSha,
      head_ref: attributeFixture.headSha
    });
    const attributeResult = successResult(attributeCall, "committed head-attribute direction");
    assertPublicRange(attributeResult.structuredContent, {
      workspaceId: attributeWorkspace.id, root: attributeWorkspace.root, baseRef: attributeFixture.baseSha, baseSha: attributeFixture.baseSha,
      headRef: attributeFixture.headSha, headSha: attributeFixture.headSha, raw: attributeOracleRaw.records, eligible: attributeOracleRaw.records,
      returned: attributeOracleRaw.records, blocked: 0, patch: attributeOraclePatch, patchRequested: true, patchLimit: 60_000,
      patchTruncated: false, patchFilesIncluded: attributeOracleTextRecords.length,
      omissionCounts: { binary: attributeOracleRaw.records.filter((record) => record.binary).length, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 }
    }, "committed head-attribute direction");
    assertNoResponseLiterals(attributeCall, [EXTERNAL_DIFF_SENTINEL, TEXTCONV_SENTINEL], "committed head-attribute direction");
    const attributeAfter = await repositorySnapshot(attributeFixture.root, attributeFixture.relevantPaths);
    assert.deepEqual(attributeAfter, attributeBefore, "head-attribute target changed during read-only call");
    console.log(`RAW_OBSERVATION: independent head-attribute oracle direction.txt binary=${directionRecord.binary}, reverse.txt binary=${reverseRecord.binary}; reverse-direction facts were established before public interpretation.`);
    console.log("PASS committed head-attribute directional rule: fixed SHAs use head-tree attributes in both directions, independent oracle and public metadata/patch agree, and target state remains unchanged.");

    const overflowWorkspace = await openFixture(overflowFixture.root, "metadata producer overflow");
    const overflowBefore = await repositorySnapshot(overflowFixture.root);
    const overflowCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: overflowWorkspace.id,
      base_ref: overflowFixture.baseSha,
      head_ref: overflowFixture.headSha,
      include_patch: false
    });
    const overflowResult = errorResult(overflowCall, "metadata producer overflow");
    assert.match(serialized(overflowResult), /metadata|capture|limit|overflow/iu, "metadata producer overflow was not truthful");
    assertNoResponseLiterals(overflowCall, ["overflow-0000.txt", DEFAULT_SENTINEL, TARGET_SENTINEL], "metadata producer overflow");
    console.log(`RAW_ENVELOPE: metadata-overflow=${serialized(overflowCall.response)}`);
    const overflowAfter = await repositorySnapshot(overflowFixture.root);
    assert.deepEqual(overflowAfter, overflowBefore, "metadata overflow changed target repository state");
    console.log("PASS metadata producer overflow: bounded 4 KiB capture failed closed without partial records, source path leakage, or target mutation.");

    const fragmentWorkspace = await openFixture(fragmentOverflowFixture.root, "patch fragment overflow");
    const fragmentRaw = directMetadata(fragmentOverflowFixture.root, fragmentOverflowFixture.baseSha, fragmentOverflowFixture.headSha);
    assert.equal(fragmentRaw.records.length, 1, "fragment overflow raw oracle did not establish one changed record");
    const fragmentBefore = await repositorySnapshot(fragmentOverflowFixture.root);
    const fragmentCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: fragmentWorkspace.id,
      base_ref: fragmentOverflowFixture.baseSha,
      head_ref: fragmentOverflowFixture.headSha
    });
    const fragmentResult = successResult(fragmentCall, "patch fragment overflow");
    assertPublicRange(fragmentResult.structuredContent, {
      workspaceId: fragmentWorkspace.id, root: fragmentWorkspace.root, baseRef: fragmentOverflowFixture.baseSha, baseSha: fragmentOverflowFixture.baseSha,
      headRef: fragmentOverflowFixture.headSha, headSha: fragmentOverflowFixture.headSha, raw: fragmentRaw.records, eligible: fragmentRaw.records,
      returned: fragmentRaw.records, blocked: 0, patch: "", patchRequested: true, patchLimit: 60_000, patchTruncated: true,
      patchFilesIncluded: 0, omissionCounts: { binary: 0, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 1 }
    }, "patch fragment overflow");
    assertNoResponseLiterals(fragmentCall, ["large fragment line"], "patch fragment overflow");
    const fragmentAfter = await repositorySnapshot(fragmentOverflowFixture.root);
    assert.deepEqual(fragmentAfter, fragmentBefore, "patch fragment overflow changed target repository state");
    console.log("PASS patch-fragment overflow: complete fragment acquisition exceeded the bounded ceiling, was omitted truthfully, and did not expose partial patch bytes.");

    const movingRef = "refs/heads/public-moving-head";
    const movingRefInput = "public-moving-head";
    mustGit(history.root, ["config", "core.logAllRefUpdates", "false"]);
    mustGit(history.root, ["update-ref", movingRef, history.rightSha]);
    // The Git producer is invoked by executable name, so place the wrapper at
    // a literal PATH entry named `git`; a descriptive filename would never be
    // selected by spawn({shell:false}).
    const movingWrapper = path.join(helperRoot, "git");
    const movingLog = path.join(helperRoot, "moving-git.jsonl");
    const movingMarker = path.join(helperRoot, "moving-git.marker");
    await writeFile(movingWrapper, [
      "#!/usr/bin/env node",
      "import fs from \"node:fs\";",
      "import { spawnSync } from \"node:child_process\";",
      "const args = process.argv.slice(2);",
      "if (process.env.MCP_MOVE_LOG) fs.appendFileSync(process.env.MCP_MOVE_LOG, JSON.stringify(args) + \"\\n\");",
      "const resolution = process.env.MCP_MOVE_REF + \"^{commit}\";",
      "const isResolution = process.env.MCP_MOVE_REF && args.some((arg) => arg === resolution);",
      "const result = spawnSync(process.env.MCP_REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: [\"ignore\", \"pipe\", \"pipe\"] });",
      "if (isResolution && result.status === 0 && !fs.existsSync(process.env.MCP_MOVE_MARKER)) {",
      "  fs.writeFileSync(process.env.MCP_MOVE_MARKER, \"moved\\n\");",
      "  const move = spawnSync(process.env.MCP_REAL_GIT, [\"update-ref\", \"refs/heads/\" + process.env.MCP_MOVE_REF, process.env.MCP_MOVE_TO], { cwd: process.cwd(), env: { ...process.env, GIT_CONFIG_NOSYSTEM: \"1\", GIT_TERMINAL_PROMPT: \"0\" }, stdio: \"ignore\" });",
      "  if (move.status !== 0) process.exit(move.status ?? 1);",
      "}",
      "if (result.stdout) process.stdout.write(result.stdout);",
      "if (result.stderr) process.stderr.write(result.stderr);",
      "process.exit(result.status ?? 1);"
    ].join("\n"), "utf8");
    await chmod(movingWrapper, 0o755);
    const movingBefore = await repositorySnapshot(history.root, history.relevantPaths);
    await secondClient.close();
    secondClient = (await startClient(defaultRootB, "full", {
      PATH: helperRoot + path.delimiter + (process.env.PATH ?? ""),
      MCP_MOVE_REF: movingRefInput,
      MCP_MOVE_TO: history.mergeBaseSha,
      MCP_MOVE_LOG: movingLog,
      MCP_MOVE_MARKER: movingMarker,
      MCP_REAL_GIT: spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
    })).client;
    const movingWorkspace = await openFixture(history.root, "public moving-ref fresh session");
    const movingCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: movingWorkspace.id,
      base_ref: history.leftSha,
      head_ref: movingRefInput,
      include_patch: false
    });
    const movingResult = successResult(movingCall, "public moving-ref pinning");
    assertPublicRange(movingResult.structuredContent, {
      workspaceId: movingWorkspace.id, root: movingWorkspace.root, baseRef: history.leftSha, baseSha: history.leftSha, headRef: movingRefInput, headSha: history.rightSha,
      raw: historyDivergentRaw.records, eligible: historyDivergentRaw.records, returned: historyDivergentRaw.records, blocked: 0,
      patchRequested: false, patchLimit: 60_000, omissionCounts: disabledCounts(historyDivergentRaw.records)
    }, "public moving-ref pinning");
    const historyWhileMoved = await repositorySnapshot(history.root, history.relevantPaths);
    const historyRefsWhileMoved = Buffer.from(historyWhileMoved.commands.refs.stdout, "base64").toString("utf8");
    assert.equal(historyRefsWhileMoved.includes(movingRef + "\u0000" + history.mergeBaseSha), true, "moving-ref wrapper did not physically move the branch after endpoint resolution");
    assert.equal(await fileDigest(movingMarker).then((value) => value.exists), true, "moving-ref wrapper did not arm");
    const movingEntries = (await readFile(movingLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const resolutionIndex = movingEntries.findIndex((args) => args.includes(movingRefInput + "^{commit}"));
    const diffIndices = movingEntries.map((args, index) => args.includes("diff") ? index : -1).filter((index) => index >= 0);
    assert.ok(resolutionIndex >= 0 && diffIndices.length >= 2 && diffIndices.every((index) => index > resolutionIndex), "moving-ref wrapper did not observe resolution before downstream diff producers");
    const downstreamEntries = movingEntries.filter((args, index) => index >= resolutionIndex && (index === resolutionIndex || args.includes("diff")));
    console.log(`RAW_DOWNSTREAM_ARGV: ${serialized({ resolution_index: resolutionIndex, entries: downstreamEntries })}`);
    mustGit(history.root, ["update-ref", movingRef, history.rightSha]);
    const movingAfter = await repositorySnapshot(history.root, history.relevantPaths);
    assert.deepEqual(movingAfter, movingBefore, "public moving-ref call changed history state after restoring deliberate ref mutation");
    console.log("PASS public moving-ref falsifier: independent wrapper evidence moved the symbolic ref only after endpoint resolution; result retained the original full SHA and downstream state was restored exactly.");

    const currentMatrixWorkspace = await openFixture(matrix.root, "current session hostile error matrix");
    const hostileRefCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: currentMatrixWorkspace.id,
      base_ref: HOSTILE_REF_LITERAL,
      head_ref: matrix.headSha
    });
    const hostileRefResult = errorResult(hostileRefCall, "hostile ref error");
    assertNoResponseLiterals(hostileRefCall, [HOSTILE_REF_LITERAL, ...matrixSecrets], "hostile ref error");
    assert.match(serialized(hostileRefResult), /ref|revision|invalid|failed/iu, "hostile ref error was not bounded");
    const hostilePathCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: currentMatrixWorkspace.id,
      base_ref: matrix.baseSha,
      head_ref: matrix.headSha,
      path: HOSTILE_PATH_LITERAL + "\n"
    });
    const hostilePathResult = errorResult(hostilePathCall, "hostile path error");
    assertNoResponseLiterals(hostilePathCall, [HOSTILE_PATH_LITERAL, ...matrixSecrets], "hostile path error");
    assert.match(serialized(hostilePathResult), /path|historical|invalid|failed/iu, "hostile path error was not bounded");
    const protocolCall = await secondClient.request(HOSTILE_KEY, { [HOSTILE_KEY]: HOSTILE_VALUE });
    assert.ok(protocolCall.response?.error, "unknown method did not return a JSON-RPC protocol error");
    assertNoResponseLiterals(protocolCall, [HOSTILE_KEY, HOSTILE_VALUE], "unknown-method protocol envelope");
    console.log("PASS public error-envelope matrix: hostile ref/path source literals, secret content, unknown keys, and complete JSON-RPC error.data remain absent.");

    const invalidBoundCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: currentMatrixWorkspace.id,
      base_ref: matrix.baseSha,
      head_ref: matrix.headSha,
      max_files: 0
    });
    const invalidBoundResult = errorResult(invalidBoundCall, "invalid max_files bound");
    assertNoResponseLiterals(invalidBoundCall, matrixSecrets, "invalid max_files bound");
    assert.match(serialized(invalidBoundResult), /max_files|invalid arguments|bounds/iu, "invalid max_files did not fail at the public boundary");
    console.log("PASS public strict runtime boundary: invalid max_files rejected without Git/source/error leakage.");

    const matrixFinal = await repositorySnapshot(matrix.root, matrix.relevantPaths);
    assert.deepEqual(matrixFinal, matrixBefore, "public error/boundary calls changed dirty target state");
    const after = await repositorySnapshot(targetRoot);
    assert.deepEqual(after, before, "fresh-session public calls changed target repository state");
    emitSnapshotEvidence("nested-target-after-public-calls", after);
    console.log("RAW_OBSERVATION: target HEAD/branch, refs, reflogs, index, staged/unstaged/untracked state, relevant bytes, local config/remotes, and worktree registrations matched before/after public calls.");
    console.log("SANITY_VERDICT: MATCH — direct target facts remain physically unchanged and the fresh public result retains target identity rather than default-B identity.");
    console.log("EVIDENCE_CONFLICT: none observed between raw Git target evidence and public MCP result.");
    console.log("GIT_DIFF_RANGE_MCP_SMOKE: PASS (TASK-006 public hostile suite; final acceptance remains with Execution Root/Hestia).");
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    if (previousCodexProHome === undefined) delete process.env.CODEXPRO_HOME;
    else process.env.CODEXPRO_HOME = previousCodexProHome;
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await main();
