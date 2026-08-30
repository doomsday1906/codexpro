import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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
  constructor(defaultWorkspaceRoot, allowedTargetRoot, mode, environment = {}) {
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    const allowedRoots = [defaultWorkspaceRoot, path.dirname(allowedTargetRoot), allowedTargetRoot].join(path.delimiter);
    this.child = spawn(process.execPath, [
      "dist/stdio.js",
      "--root", defaultWorkspaceRoot,
      "--allow-root", path.dirname(allowedTargetRoot),
      "--allow-root", allowedTargetRoot,
      "--bash", "off",
      "--write", "off",
      "--tool-mode", mode
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        ...environment,
        CODEXPRO_ROOT: defaultWorkspaceRoot,
        CODEXPRO_ALLOWED_ROOTS: allowedRoots,
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_CODEX_SESSIONS: "off",
        CODEXPRO_BASH_MODE: "off",
        CODEXPRO_WRITE_MODE: "off"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code, signal) => {
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

async function startClient(defaultWorkspaceRoot, mode, environment = {}) {
  const client = new RawStdioClient(defaultWorkspaceRoot, targetRoot, mode, environment);
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
  const defaultRootB = path.join(fixtureRoot, "default-repo-b");
  const historyRoot = path.join(targetParent, "history-target-repo");
  const matrixRoot = path.join(targetParent, "matrix-target-repo");
  const blockedRoot = path.join(targetParent, "blocked-target-repo");
  const budgetRoot = path.join(targetParent, "budget-target-repo");
  const configRoot = path.join(targetParent, "config-target-repo");
  try {
    await initRepo(defaultRoot);
    await initRepo(defaultRootB);
    await initRepo(targetRoot);
    const history = await makeHistoryFixture(historyRoot);
    const matrix = await makePublicMatrixFixture(matrixRoot);
    const blocked = await makePublicBlockedFixture(blockedRoot);
    const budget = await makePublicBudgetFixture(budgetRoot);
    const configFixture = await makePublicConfigFixture(configRoot);

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
    console.log("PREDICATE: TRUE — direct Git producers independently establish all history, record-kind, path, blocked-side, and secret-bearing input predicates before target calls.");

    const helperRoot = path.join(fixtureRoot, "hostile-git-controls");
    await mkdir(helperRoot, { recursive: true });
    const externalHelper = path.join(helperRoot, "external-diff.mjs");
    const textconvHelper = path.join(helperRoot, "textconv.mjs");
    const globalConfig = path.join(helperRoot, "hostile.gitconfig");
    const tracePath = path.join(helperRoot, "trace.log");
    const trace2Path = path.join(helperRoot, "trace2.json");
    const shallowPath = path.join(helperRoot, "shallow");
    await writeFile(externalHelper, "#!/usr/bin/env node\nprocess.stdout.write(" + JSON.stringify(EXTERNAL_DIFF_SENTINEL + "\n") + ");\n", "utf8");
    await writeFile(textconvHelper, "#!/usr/bin/env node\nimport fs from \"node:fs\";\nconst file = process.argv.at(-1);\nprocess.stdout.write(" + JSON.stringify(TEXTCONV_SENTINEL + "\n") + ");\nprocess.stdout.write(fs.readFileSync(file));\n", "utf8");
    await chmod(externalHelper, 0o755);
    await chmod(textconvHelper, 0o755);
    await writeFile(globalConfig, "[diff \"hostile\"]\n\ttextconv = " + textconvHelper + "\n", "utf8");
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
    console.log("RAW_OBSERVATION: ordinary Git under hostile global textconv and GIT_EXTERNAL_DIFF independently emitted their sentinel outputs; hostile predicate is TRUE before RepoConnect target calls.");

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
    assert.equal(directNameBytes.toString("utf8"), "M\0target-range.txt\0", "direct name-status did not yield one exact target record");
    const numstatMatch = /^(\d+)\t(\d+)\ttarget-range\.txt\0$/u.exec(directNumstatText);
    assert.ok(numstatMatch, `direct numstat did not yield one exact target record: ${JSON.stringify(directNumstatText)}`);
    assert.ok(directPatchText.startsWith("diff --git a/target-range.txt b/target-range.txt\n"), "direct patch lacked target header");
    assert.equal(directPatchText.includes(ADD_SECRET), true, "direct raw target patch lacked addition secret");
    assert.equal(directPatchText.includes(DELETE_SECRET), true, "direct raw target patch lacked deletion secret");
    assert.equal(directPatchText.includes(CONTEXT_SECRET), true, "direct raw target patch lacked context secret");
    assert.equal(directPatchText.includes(TARGET_SENTINEL), true, "direct raw target patch lacked target sentinel");
    assert.equal(directPatchText.includes(DEFAULT_SENTINEL), false, "direct raw target patch contained default sentinel");
    const { redactUnifiedDiff } = await import("./redaction-policy.mjs");
    const expectedRedactedPatch = redactUnifiedDiff(directPatchText);
    assert.equal(expectedRedactedPatch.includes(ADD_SECRET), false, "supporting redaction oracle retained addition secret");
    assert.equal(expectedRedactedPatch.includes(DELETE_SECRET), false, "supporting redaction oracle retained deletion secret");
    assert.equal(expectedRedactedPatch.includes(CONTEXT_SECRET), false, "supporting redaction oracle retained context secret");

    // PASS 1: exact authority and raw observable facts precede MCP results.
    console.log("AUTHORITY: MISSION_ANCHOR.md A001 LAW-001/L AW-016/L AW-017 and AC-007/AC-009; MISSION_PLAN.md P001 TASK-006 AP-011/AP-012.");
    console.log("EXPECTED_RESULT_AUTHORITY: the accepted public contract above; scripts/redaction-policy.mjs is SUPPORTING_ORACLE only for deterministic redacted patch bytes.");
    console.log(`TARGET_PRODUCER: direct local Git object database in nested target ${targetCanonicalRoot}; MCP route is disposable stdio only, with no TCP/8787 or production process access.`);
    console.log(`RAW_OBSERVATION: default-B HEAD=${defaultBHeadSha} (base=${defaultBBaseSha}) differs from target HEAD=${targetHeadSha} (base=${targetBaseSha}); target object format=${targetObjectFormat}.`);
    console.log(`RAW_OBSERVATION: direct target name-status=M target-range.txt; numstat additions=${numstatMatch[1]} deletions=${numstatMatch[2]}; raw patch bytes=${directTargetPatch.stdout.byteLength}, with distinct target sentinel and secret-bearing addition/deletion/context lines.`);
    console.log("TARGET_EVIDENCE: direct Git name-status/numstat/patch bytes and commit identities. SUPPORTING_ORACLE: accepted redaction-policy implementation computes expected public patch bytes.");
    console.log("SANITY_VERDICT: MATCH — raw target and default facts provide a direct workspace distinction and a secret-bearing patch whose expected public form is bounded and redacted.");
    console.log("PREDICATE: TRUE — direct target HEAD~1 and HEAD resolve to the recorded target base/head SHAs, and the target patch producer independently contains the required changed-file/sentinel facts.");

    // Session A opens the nested target and then ends. Only its explicit ID is
    // carried into the fresh B session.
    ({ client: firstClient } = await startClient(defaultRoot, "full"));
    const opened = await callTool(firstClient, "open_workspace", { path: targetRoot, include_tree: false });
    const openedResult = successResult(opened, "session A open_workspace");
    const openedData = openedResult.structuredContent;
    const workspaceId = openedData.workspace_id;
    assert.match(workspaceId, /^ws_[a-f0-9]{24}$/u, "open_workspace did not return a deterministic workspace ID");
    assert.equal(openedData.root, targetCanonicalRoot, "session A opened the wrong root");
    await firstClient.close();
    firstClient = undefined;
    console.log(`PASS session A: nested target opened and saved explicit workspace_id ${workspaceId}; client/server ended before fresh session B.`);

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
    secondClient = (await startClient(defaultRootB, "full")).client;
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
    const explicitCall = await callTool(secondClient, "git_diff_range", { workspace_id: workspaceId, base_ref: "HEAD~1", head_ref: "HEAD" });
    const explicitResult = successResult(explicitCall, "fresh-session explicit git_diff_range");
    const structured = explicitResult.structuredContent;
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
    console.log("PASS fresh-session explicit target: B used only saved target workspace_id despite distinct default-B; exact refs/counts/file/patch truth matched direct Git and patch occurred only at structuredContent.patch with redaction.");

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
      GIT_EXTERNAL_DIFF: externalHelper,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
      GIT_DIFF_OPTS: "--stat",
      GIT_TRACE: tracePath,
      GIT_TRACE2_EVENT: trace2Path,
      GIT_SHALLOW_FILE: shallowPath,
      GIT_NO_REPLACE_OBJECTS: "0",
      GIT_NO_LAZY_FETCH: "0",
      GIT_ATTR_SOURCE: globalConfig,
      GIT_TERMINAL_PROMPT: "1"
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
    const configBefore = await repositorySnapshot(configFixture.root, configFixture.relevantPaths);
    const configExpectedRaw = configRaw.records;
    const configTargetRecord = configExpectedRaw.find((record) => record.newPath === "config.hostile");
    assert.ok(configTargetRecord?.binary, "raw config fixture did not establish a binary textconv target");
    const hostileControlsCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: configWorkspace.id,
      base_ref: configFixture.baseSha,
      head_ref: configFixture.headSha,
      path: "config.hostile"
    });
    const hostileControlsResult = successResult(hostileControlsCall, "hostile inherited Git controls");
    assertPublicRange(hostileControlsResult.structuredContent, {
      workspaceId: configWorkspace.id, root: configWorkspace.root, baseRef: configFixture.baseSha, baseSha: configFixture.baseSha, headRef: configFixture.headSha, headSha: configFixture.headSha,
      path: "config.hostile", raw: [configTargetRecord], eligible: [configTargetRecord], returned: [configTargetRecord], blocked: 0, patch: "",
      patchRequested: true, patchLimit: 60_000, patchTruncated: false, patchFilesIncluded: 0,
      omissionCounts: { binary: 1, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 }
    }, "hostile inherited Git controls");
    assertNoResponseLiterals(hostileControlsCall, [EXTERNAL_DIFF_SENTINEL, TEXTCONV_SENTINEL], "hostile inherited Git controls");
    assert.equal(await fileDigest(tracePath).then((value) => value.exists), false, "sealed Git execution honored hostile GIT_TRACE");
    assert.equal(await fileDigest(trace2Path).then((value) => value.exists), false, "sealed Git execution honored hostile GIT_TRACE2_EVENT");
    assert.equal(await fileDigest(shallowPath).then((value) => value.exists), false, "sealed Git execution honored hostile GIT_SHALLOW_FILE");
    const configAfter = await repositorySnapshot(configFixture.root, configFixture.relevantPaths);
    assert.deepEqual(configAfter, configBefore, "hostile Git controls changed target repository state");
    console.log("PASS hostile Git controls: independent ordinary-Git sentinels proved external diff/textconv predicates TRUE; public result ignored inherited GIT_* trace/shallow/replacement/lazy/config/external controls and stayed immutable.");

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
    console.log("RAW_OBSERVATION: target HEAD/branch, refs, reflogs, index, staged/unstaged/untracked state, relevant bytes, local config/remotes, and worktree registrations matched before/after public calls.");
    console.log("SANITY_VERDICT: MATCH — direct target facts remain physically unchanged and the fresh public result retains target identity rather than default-B identity.");
    console.log("EVIDENCE_CONFLICT: none observed between raw Git target evidence and public MCP result.");
    console.log("GIT_DIFF_RANGE_MCP_SMOKE: PASS (TASK-006 public hostile suite; final acceptance remains with Execution Root/Hestia).");
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await main();
