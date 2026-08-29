import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { GitExecutionError, runGitReadOnly } from "../dist/gitOps.js";
import { GitRefResolutionError, resolveGitRef } from "../dist/gitReviewRef.js";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-review-ref-"));
const config = { maxGitTimeoutMs: 3_000, maxOutputBytes: 16_384 };

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.from(String(value));
}

function directGit(repoRoot, args, options = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_CONFIG;
  const result = spawnSync("git", args, {
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
    throw new Error(
      `fixture git failed: ${args.join(" ")} status=${result.status} error=${result.error?.message ?? ""} stderr=${result.stderr.toString("utf8")}`
    );
  }
  return result;
}

function directText(repoRoot, args) {
  return mustGit(repoRoot, args).stdout.toString("utf8");
}

function directTrimmed(repoRoot, args) {
  return directText(repoRoot, args).trim();
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function fileDigest(filePath) {
  try {
    const bytes = await readFile(filePath);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return null;
  }
}

function processSnapshotOn8787() {
  const result = spawnSync("ss", ["-ltnp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return "unavailable";
  return result.stdout
    .split("\n")
    .filter((line) => /:8787(?:\s|$)/u.test(line))
    .join("\n");
}

async function gitState(repoRoot) {
  const observations = {};
  for (const [name, args] of [
    ["head", ["rev-parse", "--verify", "HEAD"]],
    ["branch", ["symbolic-ref", "--short", "-q", "HEAD"]],
    ["refs", ["show-ref"]],
    ["reflogs", ["reflog", "--all", "--format=%H%x00%gs"]],
    ["indexEntries", ["ls-files", "--stage"]],
    ["status", ["status", "--porcelain=v1", "--branch"]],
    ["unstagedDiff", ["diff", "--raw"]],
    ["stagedDiff", ["diff", "--cached", "--raw"]],
    ["remotes", ["remote"]],
    ["localConfig", ["config", "--local", "--null", "--list"]]
  ]) {
    const result = directGit(repoRoot, args);
    observations[name] = {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8")
    };
  }
  observations.indexDigest = await fileDigest(path.join(repoRoot, ".git", "index"));
  observations.identityFile = await fileDigest(path.join(repoRoot, "identity.txt"));
  observations.untrackedFile = await fileDigest(path.join(repoRoot, "reviewer-state-sentinel.txt"));
  return observations;
}

function assertBoundedError(error, hostileInput = "") {
  assert.ok(error instanceof GitRefResolutionError, `expected GitRefResolutionError, got ${error?.constructor?.name ?? typeof error}`);
  assert.equal(error.name, "GitRefResolutionError");
  assert.equal(Object.hasOwn(error, "result"), false);
  assert.equal(Object.hasOwn(error, "stderr"), false);
  assert.equal(String(error).includes(hostileInput), false);
  assert.equal(error.message.includes(hostileInput), false);
  assert.ok(error.message.length < 160);
}

async function expectRefFailure(repoRoot, workspace, rawRef, reason) {
  let caught;
  try {
    await resolveGitRef(config, workspace, rawRef);
    assert.fail(`expected ${reason} for ${JSON.stringify(rawRef)}`);
  } catch (error) {
    caught = error;
  }
  assertBoundedError(caught, rawRef);
  assert.equal(caught.reason, reason);
  return caught;
}

async function setupRepository(root, objectFormat) {
  const repoRoot = path.join(root, objectFormat);
  await mkdir(repoRoot);
  const initArgs = ["init", "--quiet"];
  if (objectFormat === "sha256") initArgs.push("--object-format=sha256");
  mustGit(repoRoot, initArgs);
  mustGit(repoRoot, ["config", "user.name", "Ref Smoke"]);
  mustGit(repoRoot, ["config", "user.email", "ref-smoke@example.test"]);
  await writeFile(path.join(repoRoot, "identity.txt"), "original identity\n");
  mustGit(repoRoot, ["add", "identity.txt"]);
  mustGit(repoRoot, ["commit", "--quiet", "-m", "original identity commit"]);
  const baseSha = directTrimmed(repoRoot, ["rev-parse", "HEAD"]);
  const baseTreeSha = directTrimmed(repoRoot, ["rev-parse", "HEAD^{tree}"]);

  await writeFile(path.join(repoRoot, "identity.txt"), "moved branch identity\n");
  await writeFile(path.join(repoRoot, "second.txt"), "second commit\n");
  mustGit(repoRoot, ["add", "identity.txt", "second.txt"]);
  mustGit(repoRoot, ["commit", "--quiet", "-m", "moved branch commit"]);
  const headSha = directTrimmed(repoRoot, ["rev-parse", "HEAD"]);
  mustGit(repoRoot, ["branch", "move-target", baseSha]);
  mustGit(repoRoot, ["tag", "lightweight-tag", baseSha]);
  mustGit(repoRoot, ["tag", "--annotate", "annotated-tag", "--message", "annotated identity", baseSha]);

  await writeFile(path.join(repoRoot, "identity.txt"), "uncommitted worktree identity\n");
  await writeFile(path.join(repoRoot, "reviewer-state-sentinel.txt"), "must remain untouched\n");
  const objectFormatOutput = directText(repoRoot, ["rev-parse", "--show-object-format=storage"]);
  assert.equal(objectFormatOutput.trim(), objectFormat);
  console.log(
    `RAW_OBSERVATION: direct Git ${objectFormat} repository has base commit ${baseSha}, current HEAD ${headSha}, branch move-target at base, and dirty worktree/index state preserved for immutability checks`
  );
  return { repoRoot, baseSha, baseTreeSha, headSha, objectFormat };
}

const production8787Before = processSnapshotOn8787();
const sha1 = await setupRepository(fixtureRoot, "sha1");
const sha256 = await setupRepository(fixtureRoot, "sha256");
console.log("SANITY_VERDICT: MATCH (direct local Git facts establish both accepted object formats and the controlled ref/race fixture)");

for (const fixture of [sha1, sha256]) {
  const workspace = { id: `ref-smoke-${fixture.objectFormat}`, root: fixture.repoRoot, openedAt: new Date().toISOString() };
  const expectedLength = fixture.objectFormat === "sha1" ? 40 : 64;
  const refs = [
    ["HEAD", fixture.headSha],
    [fixture.headSha, fixture.headSha],
    ["HEAD~1", fixture.baseSha],
    ["lightweight-tag", fixture.baseSha],
    ["annotated-tag", fixture.baseSha]
  ];

  for (const [rawRef, expectedSha] of refs) {
    const directResolution = directTrimmed(fixture.repoRoot, ["rev-parse", "--verify", "--end-of-options", `${rawRef}^{commit}`]);
    assert.equal(directResolution, expectedSha, `direct expected resolution for ${rawRef}`);
    const before = await gitState(fixture.repoRoot);
    const resolved = await resolveGitRef(config, workspace, rawRef);
    const after = await gitState(fixture.repoRoot);
    assert.equal(resolved.input, rawRef);
    assert.equal(resolved.objectFormat, fixture.objectFormat);
    assert.equal(resolved.fullSha, expectedSha);
    assert.equal(resolved.fullSha.length, expectedLength);
    assert.match(resolved.fullSha, /^[0-9a-f]+$/u);
    assert.equal(resolved.shortSha, expectedSha.slice(0, 12));
    assert.deepEqual(after, before, `${fixture.objectFormat} state changed while resolving ${rawRef}`);
    console.log(`PASS ${fixture.objectFormat} ${rawRef} -> immutable ${resolved.fullSha}`);
  }

  const beforeNegative = await gitState(fixture.repoRoot);
  await expectRefFailure(fixture.repoRoot, workspace, "ref-does-not-exist", "unresolvable");
  await expectRefFailure(fixture.repoRoot, workspace, directTrimmed(fixture.repoRoot, ["rev-parse", "HEAD^{tree}"]), "unresolvable");
  const afterNegative = await gitState(fixture.repoRoot);
  assert.deepEqual(afterNegative, beforeNegative, `${fixture.objectFormat} negative resolution changed repository state`);
  console.log(`PASS ${fixture.objectFormat} nonexistent and non-commit refs fail typed/bounded without state change`);

  const hostileRefs = [
    "--help",
    "-C",
    "HEAD\u0000",
    "HEAD\n",
    "HEAD\u0001",
    "HEAD\u007f",
    " HEAD",
    "HEAD ",
    "x".repeat(513)
  ];
  for (const hostileRef of hostileRefs) {
    const before = await gitState(fixture.repoRoot);
    const expectedReason = hostileRef.startsWith("-") || hostileRef.trim() !== hostileRef || /[\u0000-\u001f\u007f]/u.test(hostileRef) || Buffer.byteLength(hostileRef, "utf8") > 512
      ? "invalid-input"
      : "unresolvable";
    await expectRefFailure(fixture.repoRoot, workspace, hostileRef, expectedReason);
    const after = await gitState(fixture.repoRoot);
    assert.deepEqual(after, before, `${fixture.objectFormat} hostile input changed repository state`);
  }
  console.log(`PASS ${fixture.objectFormat} option-like, NUL/newline/control, whitespace, and oversized refs rejected before Git resolution`);
}

// Replacement-ref target evidence comes from ordinary Git first. The candidate
// must preserve the original object identity despite the configured replacement.
const replacementTree = sha1.baseTreeSha;
const replacementSha = directTrimmed(sha1.repoRoot, ["commit-tree", replacementTree, "-m", "replacement ref commit"]);
mustGit(sha1.repoRoot, ["replace", sha1.baseSha, replacementSha]);
const ordinaryReplacementSubject = directTrimmed(sha1.repoRoot, ["show", "-s", "--format=%s", sha1.baseSha]);
assert.equal(ordinaryReplacementSubject, "replacement ref commit");
console.log(`RAW_OBSERVATION: ordinary Git with replace ref maps ${sha1.baseSha.slice(0, 12)} to replacement subject '${ordinaryReplacementSubject}'`);
console.log("SANITY_VERDICT: CONTRADICTION if reviewer follows ordinary replacement; accepted immutable truth requires original commit identity");
const replacementWorkspace = { id: "ref-smoke-sha1-replacement", root: sha1.repoRoot, openedAt: new Date().toISOString() };
const replacementBefore = await gitState(sha1.repoRoot);
const replacementResolved = await resolveGitRef(config, replacementWorkspace, sha1.baseSha);
const replacementSubject = await runGitReadOnly(config, replacementWorkspace, ["show", "-s", "--format=%s", replacementResolved.fullSha]);
const replacementAfter = await gitState(sha1.repoRoot);
assert.equal(replacementResolved.fullSha, sha1.baseSha);
assert.equal(replacementSubject.stdout.trim(), "original identity commit");
assert.deepEqual(replacementAfter, replacementBefore, "replacement-ref resolution changed repository state");
console.log("PASS replacement refs are suppressed: resolution and downstream runner read original commit subject");

// Moving-ref proof: direct Git establishes the branch moved and the two commit
// identities/content values before the compiled path is exercised.
mustGit(sha1.repoRoot, ["replace", "-d", sha1.baseSha]);
assert.equal(directTrimmed(sha1.repoRoot, ["show", "-s", "--format=%s", sha1.baseSha]), "original identity commit");
const raceWorkspace = { id: "ref-smoke-sha1-race", root: sha1.repoRoot, openedAt: new Date().toISOString() };
const raceResolved = await resolveGitRef(config, raceWorkspace, "move-target");
assert.equal(raceResolved.fullSha, sha1.baseSha);
mustGit(sha1.repoRoot, ["branch", "--force", "move-target", sha1.headSha]);
const directMovedSha = directTrimmed(sha1.repoRoot, ["rev-parse", "move-target"]);
const directOriginalSubject = directTrimmed(sha1.repoRoot, ["show", "-s", "--format=%s", raceResolved.fullSha]);
const directMovedSubject = directTrimmed(sha1.repoRoot, ["show", "-s", "--format=%s", directMovedSha]);
const directOriginalContent = directText(sha1.repoRoot, ["show", `${raceResolved.fullSha}:identity.txt`]);
assert.equal(directMovedSha, sha1.headSha);
assert.notEqual(directMovedSha, raceResolved.fullSha);
assert.equal(directOriginalSubject, "original identity commit");
assert.equal(directMovedSubject, "moved branch commit");
assert.equal(directOriginalContent, "original identity\n");
console.log(
  `RAW_OBSERVATION: direct Git moved branch move-target to ${directMovedSha}; original commit ${raceResolved.fullSha} still has subject '${directOriginalSubject}' and content '${directOriginalContent.trim()}'`
);
console.log("SANITY_VERDICT: MATCH (branch now identifies a different commit while the captured full SHA identifies the original content)");
const raceBeforeRunner = await gitState(sha1.repoRoot);
const movedBranchRead = await runGitReadOnly(config, raceWorkspace, ["show", "-s", "--format=%H%x00%s", "move-target"]);
const originalIdentityRead = await runGitReadOnly(config, raceWorkspace, ["show", "-s", "--format=%H%x00%s", raceResolved.fullSha]);
const originalContentRead = await runGitReadOnly(config, raceWorkspace, ["show", `${raceResolved.fullSha}:identity.txt`]);
const raceAfterRunner = await gitState(sha1.repoRoot);
assert.equal(movedBranchRead.stdout.trim(), `${directMovedSha}\0moved branch commit`);
assert.equal(originalIdentityRead.stdout.trim(), `${raceResolved.fullSha}\0original identity commit`);
assert.equal(originalContentRead.stdout, directOriginalContent);
assert.deepEqual(raceAfterRunner, raceBeforeRunner, "moving-ref downstream reads changed repository state");
console.log("PASS moving-ref race: returned full SHA reads original identity/content while branch reads moved commit");

assert.equal(processSnapshotOn8787(), production8787Before, "production 8787 listener snapshot changed during local ref smoke");
console.log("PASS repository review smoke used disposable local Git only; no remote, checkout, index/worktree mutation, or production 8787 action observed");

await rm(fixtureRoot, { recursive: true, force: true });
