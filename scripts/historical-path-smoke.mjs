import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../dist/config.js";
import { CodexProError, PathGuard } from "../dist/guard.js";
import { validateHistoricalPath } from "../dist/historicalPath.js";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-historical-path-"));
const repoRoot = path.join(fixtureRoot, "history-repo");
await mkdir(repoRoot);

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_EDITOR: "true"
};

function directGit(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(args) {
  const result = directGit(args);
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git failed: ${args.join(" ")} status=${result.status} stderr=${result.stderr}`);
  }
  return result.stdout;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertGenericError(error, label, rawPath) {
  assert.ok(error instanceof CodexProError, `${label}: expected CodexProError`);
  assert.ok(error.message.length <= 256, `${label}: error message was not bounded`);
  if (typeof rawPath === "string" && rawPath.length > 1 && !/^[./\\]+$/u.test(rawPath)) {
    assert.equal(error.message.includes(rawPath), false, `${label}: raw path was echoed in the error`);
  }
}

function thrownBy(operation, label, rawPath) {
  try {
    operation();
    assert.fail(`${label}: expected rejection`);
  } catch (error) {
    assertGenericError(error, label, rawPath);
    return error;
  }
}

function expectInvalid(guard, rawPath, label = JSON.stringify(rawPath)) {
  thrownBy(() => validateHistoricalPath(guard, rawPath), label, rawPath);
}

function expectBlocked(guard, rawPath, label = JSON.stringify(rawPath)) {
  const error = thrownBy(() => validateHistoricalPath(guard, rawPath), label, rawPath);
  assert.match(error.message, /blocked/i, `${label}: blocked input was not classified as blocked`);
}

function expectAccepted(guard, rawPath, expected, label = JSON.stringify(rawPath)) {
  const result = validateHistoricalPath(guard, rawPath);
  assert.equal(result, expected, `${label}: canonical path mismatch`);
  return result;
}

// Build a real disposable history first. The old paths are removed from the
// checkout by an ordinary Git delete/rename, while their original commit keeps
// the tree entries and content available.
mustGit(["init", "--quiet"]);
mustGit(["config", "user.name", "Historical Path Smoke"]);
mustGit(["config", "user.email", "historical-path-smoke@example.test"]);
await mkdir(path.join(repoRoot, "deleted"), { recursive: true });
await mkdir(path.join(repoRoot, "renamed"), { recursive: true });
await mkdir(path.join(repoRoot, "café"), { recursive: true });
await mkdir(path.join(repoRoot, "space dir"), { recursive: true });
await mkdir(path.join(repoRoot, ".hidden"), { recursive: true });
await writeFile(path.join(repoRoot, "deleted", "old legacy.txt"), "deleted historical content\n");
await writeFile(path.join(repoRoot, "renamed", "original file.txt"), "renamed historical content\n");
await writeFile(path.join(repoRoot, "-legacy.txt"), "leading dash historical content\n");
await writeFile(path.join(repoRoot, "café", "old name.txt"), "unicode historical content\n");
await writeFile(path.join(repoRoot, "space dir", "file name.txt"), "space historical content\n");
await writeFile(path.join(repoRoot, ".hidden", "visible.txt"), "hidden lawful content\n");
await writeFile(path.join(repoRoot, "current.txt"), "current content\n");
mustGit(["add", "--all"]);
mustGit(["commit", "--quiet", "-m", "historical path baseline"]);
const initialSha = mustGit(["rev-parse", "HEAD"]).trim();

mustGit(["mv", "renamed/original file.txt", "renamed/current file.txt"]);
mustGit(["rm", "--", "deleted/old legacy.txt", "-legacy.txt", "café/old name.txt"]);
mustGit(["commit", "--quiet", "-m", "delete and rename historical paths"]);
const currentSha = mustGit(["rev-parse", "HEAD"]).trim();
const initialTree = mustGit(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", initialSha]).trim().split("\n").filter(Boolean);
const currentTree = mustGit(["-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", currentSha]).trim().split("\n").filter(Boolean);
const oldPaths = ["deleted/old legacy.txt", "renamed/original file.txt", "-legacy.txt", "café/old name.txt"];
const oldCheckoutFacts = await Promise.all(oldPaths.map(async (relativePath) => ({
  path: relativePath,
  existsInInitialTree: initialTree.includes(relativePath),
  existsInCurrentTree: currentTree.includes(relativePath),
  existsInCheckout: await exists(path.join(repoRoot, ...relativePath.split("/")))
})));

console.log(`RAW_OBSERVATION: real Git initial commit ${initialSha} lists ${oldPaths.join(", ")}; current commit ${currentSha} lists renamed/current file.txt and omits every old path.`);
console.log(`RAW_OBSERVATION: checkout existence for old paths = ${oldCheckoutFacts.map((fact) => `${fact.path}:${fact.existsInCheckout}`).join(", ")}; initial-tree membership = ${oldCheckoutFacts.map((fact) => `${fact.path}:${fact.existsInInitialTree}`).join(", ")}.`);

// Use only the compiled target producer and a real history-independent guard
// surface for the first observations. This guard has no resolve method and no
// filesystem API, so a current-checkout existence oracle cannot be consulted.
const blockedCalls = [];
const noFilesystemGuard = Object.freeze({
  isBlockedRelativePath(relativePath) {
    blockedCalls.push(relativePath);
    return false;
  }
});
assert.equal("resolve" in noFilesystemGuard, false, "minimal guard unexpectedly exposes resolve");
const historicalValidatorObservations = oldPaths.map((relativePath) => ({
  path: relativePath,
  canonical: validateHistoricalPath(noFilesystemGuard, relativePath)
}));
console.log(`RAW_OBSERVATION: compiled validateHistoricalPath returned ${historicalValidatorObservations.map((item) => `${item.path}->${item.canonical}`).join(", ")} for old paths absent from the checkout.`);
console.log("SANITY_VERDICT: MATCH (lawful deleted/renamed old paths are absent now, remain in the real old Git tree, and are admitted by the compiled validator without a filesystem-capable guard).");
console.log("AUTHORITY: MISSION_PLAN.md P002 TASK-003 PATH REQUIREMENTS and AP-005/A002; expected results were derived from that accepted path law independently of implementation names and test outcomes.");
console.log("TARGET_PRODUCER: compiled dist/historicalPath.js validateHistoricalPath; TARGET_EVIDENCE: direct validator returns plus direct Git tree/checkout observations. PathGuard policy is supporting blocked-path oracle only.");

for (const fact of oldCheckoutFacts) {
  assert.equal(fact.existsInInitialTree, true, `${fact.path}: absent from old Git tree`);
  assert.equal(fact.existsInCurrentTree, false, `${fact.path}: still present in current Git tree`);
  assert.equal(fact.existsInCheckout, false, `${fact.path}: unexpectedly exists in current checkout`);
}
assert.deepEqual(
  historicalValidatorObservations.map((item) => item.canonical),
  oldPaths,
  "historical validator changed lawful old path spelling"
);
assert.deepEqual(blockedCalls, oldPaths, "validator did not consult only the blocked-path predicate for accepted paths");
console.log("PASS real deleted/renamed historical names are admitted despite no current-filesystem existence");

// Config is loaded from the compiled PathGuard implementation, including its
// default blocked globs plus an explicit custom policy for this smoke.
const config = await withEnvironment({
  CODEXPRO_ROOT: repoRoot,
  CODEXPRO_ALLOWED_ROOTS: repoRoot,
  CODEXPRO_BLOCKED_GLOBS: "review-blocked/**,private-*",
  CODEXPRO_HOST: "127.0.0.1",
  CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
  CODEXPRO_HTTP_TOKEN: undefined,
  CODEBASE_BRIDGE_HTTP_TOKEN: undefined,
  CODEXPRO_CONTEXT_DIR: ".ai-bridge"
}, () => loadConfig([]));
const defaultAndCustomGuard = new PathGuard(config);

// Positive canonicalization and lawful names, including backslashes that are
// separators rather than a way to bypass the blocked-path policy.
const canonicalCases = [
  ["ordinary/file.txt", "ordinary/file.txt"],
  ["ordinary\\file.txt", "ordinary/file.txt"],
  ["ordinary//nested///file.txt", "ordinary/nested/file.txt"],
  ["./ordinary/./nested/./file.txt/", "ordinary/nested/file.txt"],
  [".hidden\\visible.txt", ".hidden/visible.txt"],
  ["space dir\\file name.txt", "space dir/file name.txt"],
  ["café\\naïve.txt", "café/naïve.txt"],
  ["-leading\\--file.txt", "-leading/--file.txt"],
  ["foo/…-lawful.txt", "foo/…-lawful.txt"]
];
for (const [rawPath, expected] of canonicalCases) {
  expectAccepted(noFilesystemGuard, rawPath, expected);
}
console.log(`PASS slash canonicalization, duplicate/dot/trailing segments, and lawful Unicode/space/leading-dash/hidden names (${canonicalCases.length} cases)`);

// Default blocked policy and custom additions must apply after slash
// canonicalization, so a backslash spelling cannot evade either policy.
const defaultBlockedCases = [
  ".env",
  ".env\\nested.txt",
  "config/.env",
  ".git\\config",
  "nested/.git/objects/item",
  "node_modules\\dependency/index.js",
  "dist\\bundle.js",
  "keys/private.pem",
  "keys/private.key",
  "ssh/id_rsa"
];
for (const rawPath of defaultBlockedCases) {
  expectBlocked(defaultAndCustomGuard, rawPath);
}
const customBlockedCases = ["review-blocked/file.txt", "review-blocked\\file.txt", "archive/private-note.txt", "private-root.txt"];
for (const rawPath of customBlockedCases) {
  expectBlocked(defaultAndCustomGuard, rawPath);
}
console.log(`PASS default blocked globs and custom blocked globs reject canonical and backslash spellings (${defaultBlockedCases.length + customBlockedCases.length} cases)`);

// Nearby negative/falsifier coverage: path normalization must never turn an
// escape, absolute path, control payload, or option-like absolute spelling into
// a lawful tree path. Leading-dash *relative* names above remain lawful.
const emptyOrDotOnly = ["", ".", "./", ".\\.", "././", "\\./\\."];
for (const rawPath of emptyOrDotOnly) {
  expectInvalid(noFilesystemGuard, rawPath);
}
const absoluteAndDevice = [
  "/etc/passwd",
  "\\etc\\passwd",
  "C:/Windows/System32",
  "C:\\Windows\\System32",
  "C:relative.txt",
  "\\\\server\\share\\file.txt",
  "//server/share/file.txt",
  "\\\\?\\C:\\file.txt",
  "\\\\.\\COM1",
  "\\\\.\\pipe\\name"
];
for (const rawPath of absoluteAndDevice) {
  expectInvalid(noFilesystemGuard, rawPath);
}
const parentEscapes = ["..", "../file.txt", "folder/../file.txt", "folder\\..\\file.txt", "./folder/../../file.txt"];
for (const rawPath of parentEscapes) {
  expectInvalid(noFilesystemGuard, rawPath);
}
const controlCases = [
  ["C0", "safe\u0001name.txt"],
  ["NUL", "safe\u0000name.txt"],
  ["tab", "safe\tname.txt"],
  ["newline", "safe\nname.txt"],
  ["DEL", "safe\u007fname.txt"]
];
for (const [label, rawPath] of controlCases) {
  expectInvalid(noFilesystemGuard, rawPath, label);
}
const exactly4096Bytes = "a".repeat(4096);
expectAccepted(noFilesystemGuard, exactly4096Bytes, exactly4096Bytes, "4096 UTF-8 byte boundary");
const over4096Bytes = "é".repeat(2049); // 4098 UTF-8 bytes, despite 2049 code points.
expectInvalid(noFilesystemGuard, over4096Bytes, ">4096 UTF-8 bytes");
console.log(`PASS empty/dot-only, POSIX/drive/UNC/extended/device absolute, drive-relative, parent/control, and UTF-8 byte-boundary rejection (${emptyOrDotOnly.length + absoluteAndDevice.length + parentEscapes.length + controlCases.length + 2} cases)`);

// A blocked path with an attempted separator bypass and a parent escape are
// explicit nearby falsifiers for the two common implementation mistakes.
expectInvalid(noFilesystemGuard, "review-blocked\\..\\secret.txt", "blocked path with parent-looking segment");
expectInvalid(noFilesystemGuard, "lawful\\..\\current.txt", "nearby parent escape falsifier");
console.log("PASS nearby falsifiers: blocked backslash bypass remains blocked; parent escape remains rejected");

await rm(fixtureRoot, { recursive: true, force: true });
console.log("HISTORICAL_PATH_SMOKE: PASS AP-005 focused matrix");
