import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { CODEXPRO_PACKAGE, assertCodexProReleaseEnvironment } from "./release-guard.mjs";
import { packLockDerivedRelease } from "./release-pack.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function runNpm(args, root) {
  const result = spawnSync(npmCli ? process.execPath : npm, npmCli ? [npmCli, ...args] : args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, INIT_CWD: root }
  });
  if (result.error) throw new Error(`npm ${args[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

let temporaryTarballPath = null;

try {
  const release = assertCodexProReleaseEnvironment();
  const publishArgs = process.argv.slice(2);
  if (publishArgs.some((arg) => arg === "--ignore-scripts" || arg.startsWith("--ignore-scripts="))) {
    throw new Error("--ignore-scripts is not allowed for CodexPro releases.");
  }

  // 1. Run canonical release checks (including release:reproducibility)
  runNpm(["run", "release:check"], release.root);

  // 2. Locate or produce the clean lock-derived tarball artifact
  const expectedTarball = `${CODEXPRO_PACKAGE}-${release.version}.tgz`;
  let tarballPath = resolve(release.root, expectedTarball);

  if (!existsSync(tarballPath)) {
    console.log(`[release publish] Packaging clean lock-derived release artifact ${expectedTarball}...`);
    const packResult = packLockDerivedRelease({
      root: release.root,
      outDir: release.root,
      dryRun: false
    });
    tarballPath = packResult.tarballPath;
    temporaryTarballPath = tarballPath;
  }

  // 3. Publish the reviewed lock-derived artifact directly
  console.log(`[release publish] Publishing lock-derived artifact: ${tarballPath}`);
  runNpm(["publish", tarballPath, "--tag", "latest", ...publishArgs], release.root);
} catch (error) {
  console.error(`[release publish] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temporaryTarballPath && existsSync(temporaryTarballPath)) {
    try {
      rmSync(temporaryTarballPath, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
}
