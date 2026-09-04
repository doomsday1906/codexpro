#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  mkdtempSync
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { CODEXPRO_PACKAGE, CODEXPRO_ROOT, assertCodexProReleaseEnvironment } from "./release-guard.mjs";
import { publishCodexProRelease } from "./release-publish.mjs";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

console.log("[release publish falsifier] Starting publish artifact-selection adversarial falsifier...");

const release = assertCodexProReleaseEnvironment({ cwd: CODEXPRO_ROOT });
const expectedTarballName = `${CODEXPRO_PACKAGE}-${release.version}.tgz`;
const rootTarballPath = resolve(CODEXPRO_ROOT, expectedTarballName);

// Ensure clean starting baseline at repository root
if (existsSync(rootTarballPath) || isSymlink(rootTarballPath)) {
  throw new Error(`Repository root already contains ${expectedTarballName}; clean state required before running falsifier.`);
}

const tempWorkDir = mkdtempSync(join(tmpdir(), "codexpro-publish-falsifier-"));

try {
  // =========================================================================
  // Falsifier Part 1: Stale regular tarball file placed at repository root
  // =========================================================================
  console.log("[release publish falsifier] Test 1: Testing stale file contamination at repository root...");

  const staleContent = Buffer.from("STALE_CORRUPTED_TARBALL_ROOT_ESCAPE_PAYLOAD_" + Date.now() + "_" + Math.random());
  writeFileSync(rootTarballPath, staleContent);
  const staleSha256 = sha256(staleContent);

  assert.ok(existsSync(rootTarballPath), "Stale root tarball file must exist for falsification setup");
  assert.equal(sha256File(rootTarballPath), staleSha256);

  let capturedPublishInvocation = null;
  let inFlightArtifactExisted = false;
  let inFlightArtifactSha = null;

  const spyRunNpm = (args, root) => {
    if (args[0] === "publish") {
      const artifactPath = args[1];
      inFlightArtifactExisted = existsSync(artifactPath);
      if (inFlightArtifactExisted) {
        inFlightArtifactSha = sha256File(artifactPath);
      }
      capturedPublishInvocation = {
        args,
        root,
        artifactPath,
        inFlightArtifactExisted,
        inFlightArtifactSha
      };
      // In-flight assertion: published artifact is definitely NOT the stale root file
      assert.notEqual(
        resolve(artifactPath),
        resolve(rootTarballPath),
        "Adversarial violation: publish command was given the stale root tarball path!"
      );
      assert.notEqual(
        inFlightArtifactSha,
        staleSha256,
        "Adversarial violation: publish command artifact SHA matches the stale root file!"
      );
      // Return success without running real npm publish (zero remote mutation)
      return { status: 0 };
    }
    return { status: 0 };
  };

  const publishResult = publishCodexProRelease({
    root: CODEXPRO_ROOT,
    publishArgs: ["--dry-run-intercepted"],
    dryRun: false, // exercises the publish execution seam through spyRunNpm
    skipCheck: true,
    runNpm: spyRunNpm
  });

  // Proof 1: Real publish was intercepted, no remote mutation occurred
  assert.ok(capturedPublishInvocation, "publish command must be invoked via runNpm");
  assert.equal(capturedPublishInvocation.args[0], "publish");

  // Proof 2: Stale root file was NEVER selected as the publication artifact
  const selectedPath = publishResult.selectedArtifactPath;
  assert.notEqual(
    resolve(selectedPath),
    resolve(rootTarballPath),
    "Selected publication artifact path must NOT match stale root path"
  );
  assert.notEqual(
    publishResult.selectedArtifactSha256,
    staleSha256,
    "Selected publication artifact SHA must NOT match stale root file SHA"
  );

  // Proof 3: Fresh lock-derived artifact was generated in private disposable location
  assert.ok(
    selectedPath.includes("codexpro-publish-stage-"),
    `Selected artifact path ${selectedPath} must be inside a codexpro-publish-stage- directory`
  );
  assert.ok(
    !selectedPath.startsWith(CODEXPRO_ROOT),
    `Selected artifact path ${selectedPath} must not be inside repository root`
  );
  assert.equal(inFlightArtifactExisted, true, "Artifact must have physically existed when publish was invoked");
  assert.equal(
    inFlightArtifactSha,
    publishResult.selectedArtifactSha256,
    "In-flight artifact SHA must match reported selectedArtifactSha256"
  );

  // Proof 4: Disposable publication directory/artifact was cleaned up after publish
  assert.equal(
    existsSync(selectedPath),
    false,
    `Publication artifact ${selectedPath} must be cleaned up after publish attempt`
  );
  assert.equal(
    existsSync(publishResult.publishStageDir),
    false,
    `Publication stage directory ${publishResult.publishStageDir} must be cleaned up after publish attempt`
  );

  // Proof 5: Stale root file itself is preserved UNTOUCHED
  assert.ok(existsSync(rootTarballPath), "Stale root file must remain untouched in root");
  assert.equal(
    sha256File(rootTarballPath),
    staleSha256,
    "Stale root file bytes must remain completely unaltered"
  );

  console.log("✓ Test 1 passed: Stale file at repository root was ignored, fresh lock-derived artifact was published, and root file was untouched.");

  // Clean root file before Test 2
  rmSync(rootTarballPath, { force: true });

  // =========================================================================
  // Falsifier Part 2: Symlink placed at repository root
  // =========================================================================
  console.log("[release publish falsifier] Test 2: Testing symlink contamination at repository root...");

  const foreignTarget = join(tempWorkDir, "foreign-symlink-target.tgz");
  const foreignContent = Buffer.from("FOREIGN_SYMLINK_TARGET_PAYLOAD_" + Date.now());
  writeFileSync(foreignTarget, foreignContent);
  const foreignSha256 = sha256(foreignContent);

  // Create symlink at root pointing to foreign target
  symlinkSync(foreignTarget, rootTarballPath);
  assert.ok(isSymlink(rootTarballPath), "Root path must be a symbolic link for Test 2");
  assert.equal(resolve(readlinkSync(rootTarballPath)), resolve(foreignTarget));

  let symlinkPublishInvocation = null;
  let symlinkInFlightSha = null;

  const spySymlinkRunNpm = (args, root) => {
    if (args[0] === "publish") {
      const artifactPath = args[1];
      const exists = existsSync(artifactPath);
      if (exists) {
        symlinkInFlightSha = sha256File(artifactPath);
      }
      symlinkPublishInvocation = { args, artifactPath, exists, inFlightSha: symlinkInFlightSha };
      assert.notEqual(resolve(artifactPath), resolve(rootTarballPath));
      assert.notEqual(symlinkInFlightSha, foreignSha256);
      return { status: 0 };
    }
    return { status: 0 };
  };

  const symlinkResult = publishCodexProRelease({
    root: CODEXPRO_ROOT,
    publishArgs: ["--dry-run-intercepted"],
    dryRun: false,
    skipCheck: true,
    runNpm: spySymlinkRunNpm
  });

  // Proof 1: Symlink was NOT selected
  assert.ok(symlinkPublishInvocation);
  assert.notEqual(resolve(symlinkResult.selectedArtifactPath), resolve(rootTarballPath));
  assert.notEqual(symlinkResult.selectedArtifactSha256, foreignSha256);

  // Proof 2: Fresh lock-derived artifact in private stage was selected
  assert.ok(symlinkResult.selectedArtifactPath.includes("codexpro-publish-stage-"));
  assert.equal(symlinkPublishInvocation.exists, true);
  assert.equal(symlinkInFlightSha, symlinkResult.selectedArtifactSha256);

  // Proof 3: Cleaned up afterwards
  assert.equal(existsSync(symlinkResult.selectedArtifactPath), false);
  assert.equal(existsSync(symlinkResult.publishStageDir), false);

  // Proof 4: Root symlink was preserved UNTOUCHED
  assert.ok(isSymlink(rootTarballPath), "Root symlink must still be a symlink");
  assert.equal(resolve(readlinkSync(rootTarballPath)), resolve(foreignTarget));
  assert.equal(sha256File(foreignTarget), foreignSha256);

  console.log("✓ Test 2 passed: Root symlink was ignored, fresh lock-derived artifact was published, and symlink was untouched.");

  // =========================================================================
  // Falsifier Part 3: Test dryRun parameter seam directly
  // =========================================================================
  console.log("[release publish falsifier] Test 3: Testing dryRun: true seam directly...");

  let dryRunNpmCalled = false;
  const dryRunResult = publishCodexProRelease({
    root: CODEXPRO_ROOT,
    dryRun: true,
    skipCheck: true,
    runNpm: () => {
      dryRunNpmCalled = true;
      return { status: 0 };
    }
  });

  assert.equal(dryRunResult.published, false, "dryRun: true must report published: false");
  assert.equal(dryRunNpmCalled, false, "dryRun: true must not call runNpm for publish");
  assert.ok(dryRunResult.selectedArtifactPath.includes("codexpro-publish-stage-"));
  assert.equal(existsSync(dryRunResult.selectedArtifactPath), false, "Staging directory must be cleaned up even in dryRun");

  console.log("✓ Test 3 passed: dryRun seam successfully packages fresh artifact, skips npm publish, and cleans up.");

} finally {
  // Complete teardown of all test artifacts
  if (existsSync(rootTarballPath) || isSymlink(rootTarballPath)) {
    try {
      rmSync(rootTarballPath, { force: true });
    } catch {}
  }
  if (existsSync(tempWorkDir)) {
    try {
      rmSync(tempWorkDir, { recursive: true, force: true });
    } catch {}
  }
}

console.log("✓ All publish artifact-selection adversarial falsifier tests PASSED.");
