import assert from "node:assert/strict";
import { loadConfig } from "../dist/config.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { gitDiffRange } from "../dist/gitDiffRange.js";

// These are the exact frozen real-history witnesses from TASK-001. The
// expected counts come from direct Git metadata captured in the accepted
// evidence package, not from the implementation under test.
const witnesses = [
  ["0207e0b26475973d61daee58b18ecffd5a51cb78", "e245653e98577dcb750025436f2300702f615cd5", 3],
  ["e245653e98577dcb750025436f2300702f615cd5", "71e38e2ef5405b64f6bc95127cbf51a801a47be5", 2],
  ["97cd7b8aac3f42a34205630ec26f6ac900ad176c", "e46038ce056aa76dbfe7e9a735629f8327782d75", 5]
];

const root = process.cwd();
const loaded = loadConfig(["--root", root, "--allow-root", root, "--bash", "off", "--write", "off"]);
const config = { ...loaded, maxGitTimeoutMs: 10_000, maxOutputBytes: 100_000, maxReadBytes: 100_000 };
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).defaultWorkspace();

console.log("AUTHORITY: accepted TASK-005 §8 and TASK-001 frozen historical witnesses.");
console.log("TARGET_PRODUCER: exact local Git object database queried through compiled git_diff_range.");
console.log("TARGET_EVIDENCE: immutable base/head SHAs, changed-file metadata, and complete redacted per-file patch fragments.");

for (const [baseRef, headRef, expectedCount] of witnesses) {
  const result = await gitDiffRange(config, guard, workspace, {
    baseRef,
    headRef,
    includePatch: true,
    maxFiles: 200,
    maxPatchBytes: 100_000
  });
  assert.equal(result.base_commit_sha, baseRef);
  assert.equal(result.head_commit_sha, headRef);
  assert.equal(result.changed_file_count, expectedCount);
  assert.equal(result.returned_file_count, expectedCount);
  assert.equal(result.patch_files.length, expectedCount);
  assert.equal(result.patch_files_included, expectedCount);
  assert.equal(result.patch_files_omitted, 0);
  assert.equal(result.patch_next_index, null);
  assert.deepEqual(result.patch_files.map((file) => file.index), [...Array(expectedCount).keys()]);
  assert.ok(result.patch_files.every((file) => file.omission_reason === null && typeof file.patch === "string"));
  assert.equal(result.patch, result.patch_files.map((file) => file.patch).join(""));
  assert.equal(result.patch_bytes, Buffer.byteLength(result.patch, "utf8"));
  assert.equal(JSON.stringify(result).includes("ACTUAL_LITERAL_SECRET_7X9"), false);
  console.log(`PASS witness ${baseRef.slice(0, 8)}..${headRef.slice(0, 8)}: ${expectedCount} complete per-file fragments, immutable identity, and redacted output.`);
}

const [continuationBase, continuationHead] = witnesses[0];
const firstPage = await gitDiffRange(config, guard, workspace, {
  baseRef: continuationBase,
  headRef: continuationHead,
  includePatch: true,
  maxFiles: 200,
  maxPatchBytes: 4_000
});
assert.equal(firstPage.patch_next_index, 1);
assert.equal(firstPage.patch_files[0].omission_reason, null);
assert.equal(firstPage.patch_files[1].omission_reason, "budget");
assert.equal(firstPage.patch_files[2].omission_reason, "budget");
const resumedPage = await gitDiffRange(config, guard, workspace, {
  baseRef: continuationBase,
  headRef: continuationHead,
  includePatch: true,
  maxFiles: 200,
  maxPatchBytes: 100_000,
  patchStartIndex: firstPage.patch_next_index
});
assert.equal(resumedPage.patch_next_index, null);
assert.equal(resumedPage.patch_files[0].omission_reason, "continuation");
assert.deepEqual(resumedPage.patch_files.slice(1).map((file) => file.index), [1, 2]);
assert.ok(resumedPage.patch_files.slice(1).every((file) => file.omission_reason === null && typeof file.patch === "string"));
assert.equal(resumedPage.patch_omission_counts.continuation, 1);
assert.equal(resumedPage.patch, resumedPage.patch_files.slice(1).map((file) => file.patch).join(""));
console.log("PASS continuation page: bounded prefix exposed patch_next_index and resumed with ordered complete suffix fragments.");

console.log("SANITY_VERDICT: MATCH — all three accepted real historical witnesses returned complete ordered target fragments without malformed poisoning.");
