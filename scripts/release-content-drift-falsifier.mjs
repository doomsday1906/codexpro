#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEXPRO_ROOT, assertReleaseDependencyClosure } from "./release-guard.mjs";
import { packLockDerivedRelease } from "./release-pack.mjs";

const CONTAMINATION_MARKER = "/* INJECTED_SAME_VERSION_CONTENT_DRIFT_CONTAMINATION_FOR_FALSIFIER */";

export async function runContentDriftFalsifier() {
  console.log("==> Running controlled same-version content-drift falsifier...");

  const targetRelPath = "node_modules/minimatch/dist/commonjs/index.js";
  const targetFile = resolve(CODEXPRO_ROOT, targetRelPath);
  assert.ok(existsSync(targetFile), `Target production file ${targetFile} must exist`);

  const originalContent = readFileSync(targetFile, "utf8");
  const tempPackDir = mkdtempSync(join(tmpdir(), "codexpro-drift-falsifier-"));

  try {
    // 1. Inject same-version content drift contamination into local node_modules
    console.log(`    Injecting controlled content drift into ${targetRelPath}...`);
    writeFileSync(targetFile, originalContent + "\n" + CONTAMINATION_MARKER + "\n", "utf8");

    // 2. Verify local file contains contamination
    const contaminatedLocal = readFileSync(targetFile, "utf8");
    assert.ok(
      contaminatedLocal.includes(CONTAMINATION_MARKER),
      "Local target file must physically contain the injected contamination"
    );

    // 3. Verify dependency name and version did not change (same-version drift)
    const minimatchPkg = JSON.parse(
      readFileSync(resolve(CODEXPRO_ROOT, "node_modules/minimatch/package.json"), "utf8")
    );
    assert.equal(minimatchPkg.name, "minimatch");
    assert.equal(minimatchPkg.version, "10.2.5");
    console.log("    Verified local node_modules has same-version content drift (minimatch@10.2.5 unchanged in package.json).");

    // 4. Execute canonical lock-derived release packaging
    console.log("    Executing canonical lock-derived release pack...");
    const packResult = packLockDerivedRelease({
      root: CODEXPRO_ROOT,
      outDir: tempPackDir,
      dryRun: false
    });

    assert.ok(packResult.tarballPath && existsSync(packResult.tarballPath), "Candidate tarball must be generated");
    console.log(`    Generated candidate tarball: ${packResult.filename} (${packResult.size} bytes)`);

    // 5. Extract the target file from the packed tarball and inspect its content
    console.log(`    Inspecting ${targetRelPath} inside candidate tarball...`);
    const tarMember = `package/${targetRelPath}`;
    const extractRes = spawnSync("tar", ["-zxOf", packResult.tarballPath, tarMember], {
      encoding: "utf8"
    });
    assert.equal(extractRes.status, 0, `Failed to extract ${tarMember} from tarball: ${extractRes.stderr}`);
    const extractedContent = extractRes.stdout;

    // 6. Prove that the contamination was completely ignored and excluded
    assert.ok(
      !extractedContent.includes(CONTAMINATION_MARKER),
      "FALSIFIER FAILED: Injected contamination was found in the packed tarball! Local node_modules was not isolated."
    );
    assert.equal(
      extractedContent,
      originalContent,
      "FALSIFIER FAILED: Extracted tarball content does not match the clean lock-derived content!"
    );

    console.log("    CONFIRMED: Packed tarball DOES NOT contain local node_modules contamination!");
    console.log("    CONFIRMED: Packed tarball matches exact lock-derived clean dependency bytes!");

    return {
      falsifier: "SAME_VERSION_CONTENT_DRIFT",
      target_dependency: "minimatch",
      target_file: targetRelPath,
      local_contamination_injected: true,
      canonical_pack_mechanism: "CLEAN_LOCK_DERIVED_CI_STAGING",
      tarball_contains_contamination: false,
      tarball_bytes_match_lock_derivation: true,
      status: "PASS"
    };
  } finally {
    // Restore original file and clean up temporary pack directory
    writeFileSync(targetFile, originalContent, "utf8");
    rmSync(tempPackDir, { recursive: true, force: true });
    const restoredContent = readFileSync(targetFile, "utf8");
    assert.equal(restoredContent, originalContent, "Target file must be restored cleanly");
  }
}

const isDirect = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  try {
    const result = await runContentDriftFalsifier();
    console.log(JSON.stringify(result, null, 2));
    console.log("✓ Same-version content-drift falsifier passed: canonical release pack strictly ignores local node_modules contamination.");
  } catch (error) {
    console.error(`[drift falsifier] ${error.message}`);
    process.exitCode = 1;
  }
}
