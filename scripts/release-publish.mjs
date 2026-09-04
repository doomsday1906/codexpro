import { rmSync, mkdtempSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODEXPRO_PACKAGE, CODEXPRO_ROOT, assertCodexProReleaseEnvironment } from "./release-guard.mjs";
import { packLockDerivedRelease } from "./release-pack.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

export function defaultRunNpm(args, root) {
  const result = spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...args] : args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, INIT_CWD: root }
  });
  if (result.error) throw new Error(`npm ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const error = new Error(`npm ${args[0]} exited with code ${result.status}`);
    error.status = result.status;
    throw error;
  }
  return result;
}

export function publishCodexProRelease({
  root = CODEXPRO_ROOT,
  publishArgs = [],
  dryRun = false,
  skipCheck = false,
  runNpm = defaultRunNpm,
  packRelease = packLockDerivedRelease
} = {}) {
  const release = assertCodexProReleaseEnvironment({ cwd: root });

  if (publishArgs.some((arg) => arg === "--ignore-scripts" || arg.startsWith("--ignore-scripts="))) {
    throw new Error("--ignore-scripts is not allowed for CodexPro releases.");
  }

  // 1. Run canonical release checks (including release:reproducibility)
  if (!skipCheck) {
    console.log("[release publish] Running release checks...");
    runNpm(["run", "release:check"], release.root);
  }

  // 2. Create a private/disposable publication directory
  const publishStageDir = mkdtempSync(join(tmpdir(), "codexpro-publish-stage-"));
  let selectedArtifactPath = null;
  let selectedArtifactSha256 = null;
  let packResult = null;

  try {
    // 3. Always invoke packLockDerivedRelease() into that private directory
    console.log(`[release publish] Packaging clean lock-derived release artifact into private staging: ${publishStageDir}...`);
    packResult = packRelease({
      root: release.root,
      outDir: publishStageDir,
      dryRun: false
    });

    selectedArtifactPath = packResult.tarballPath;
    selectedArtifactSha256 = packResult.tarballSha256;

    if (!selectedArtifactPath || !existsSync(selectedArtifactPath)) {
      throw new Error(`Generated publish artifact not found at ${selectedArtifactPath}`);
    }

    // Verify artifact is strictly contained inside the private publication directory, never in root
    const rel = relative(publishStageDir, selectedArtifactPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Selected publication artifact ${selectedArtifactPath} is outside private stage ${publishStageDir}`);
    }

    // 4. Publish that exact returned artifact path directly
    console.log(`[release publish] Publishing lock-derived artifact: ${selectedArtifactPath} (sha256: ${selectedArtifactSha256})`);

    if (dryRun) {
      console.log(`[release publish] Dry run active; skipping npm publish.`);
    } else {
      runNpm(["publish", selectedArtifactPath, "--tag", "latest", ...publishArgs], release.root);
    }

    return {
      success: true,
      published: !dryRun,
      selectedArtifactPath,
      selectedArtifactSha256,
      publishStageDir,
      packResult
    };
  } finally {
    // 5. Clean the disposable publication artifact/directory after publish attempt
    if (publishStageDir && existsSync(publishStageDir)) {
      try {
        rmSync(publishStageDir, { recursive: true, force: true });
      } catch {
        // ignore stage cleanup failure
      }
    }
  }
}

const isDirect = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  try {
    const rawArgs = process.argv.slice(2);
    const isDryRun = rawArgs.includes("--dry-run");
    const publishArgs = rawArgs.filter((arg) => arg !== "--dry-run");

    publishCodexProRelease({
      root: CODEXPRO_ROOT,
      publishArgs,
      dryRun: isDryRun
    });
  } catch (error) {
    console.error(`[release publish] ${error.message}`);
    process.exitCode = error.status ?? 1;
  }
}
