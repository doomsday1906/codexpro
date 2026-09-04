import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  mkdtempSync,
  cpSync,
  rmSync,
  mkdirSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEXPRO_PACKAGE,
  CODEXPRO_ROOT,
  assertCodexProReleaseEnvironment,
  assertReleaseDependencyClosure
} from "./release-guard.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function fail(message) {
  throw new Error(message);
}

function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export function packLockDerivedRelease({
  root = CODEXPRO_ROOT,
  outDir = root,
  dryRun = false
} = {}) {
  const release = assertCodexProReleaseEnvironment({ cwd: root });
  const stage = mkdtempSync(join(tmpdir(), "codexpro-release-stage-"));

  try {
    const packageJsonPath = resolve(root, "package.json");
    const packageLockPath = resolve(root, "package-lock.json");
    const pj = JSON.parse(readFileSync(packageJsonPath, "utf8"));

    cpSync(packageJsonPath, resolve(stage, "package.json"));
    cpSync(packageLockPath, resolve(stage, "package-lock.json"));

    for (const item of pj.files ?? []) {
      const src = resolve(root, item);
      const dest = resolve(stage, item);
      if (existsSync(src)) {
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(src, dest, { recursive: true });
      }
    }

    const npmCmd = npmCli ? [process.execPath, npmCli] : [npm];
    const ciRes = spawnSync(npmCmd[0], [...npmCmd.slice(1), "ci", "--omit=dev", "--ignore-scripts"], {
      cwd: stage,
      encoding: "utf8",
      env: { ...process.env, INIT_CWD: stage }
    });
    if (ciRes.error) fail(`Clean staging npm ci could not start: ${ciRes.error.message}`);
    if (ciRes.status !== 0) fail(`Clean staging npm ci failed: ${(ciRes.stderr || ciRes.stdout).trim()}`);

    const stagedClosure = assertReleaseDependencyClosure(stage);
    if (stagedClosure.packageCount !== 100) {
      fail(`Clean staged closure expected 100 packages; found ${stagedClosure.packageCount}`);
    }

    const packArgs = ["pack", "--ignore-scripts", "--json"];
    if (dryRun) {
      packArgs.push("--dry-run");
    } else {
      packArgs.push(`--pack-destination=${outDir}`);
    }

    const packed = spawnSync(npmCmd[0], [...npmCmd.slice(1), ...packArgs], {
      cwd: stage,
      encoding: "utf8",
      env: { ...process.env, INIT_CWD: stage }
    });

    if (packed.error) fail(`npm pack could not start: ${packed.error.message}`);
    if (packed.status !== 0) fail(`npm pack failed: ${(packed.stderr || packed.stdout).trim()}`);

    let packages;
    try {
      packages = JSON.parse(packed.stdout);
    } catch {
      fail("npm pack did not return a JSON package manifest.");
    }
    const tarball = Array.isArray(packages) ? packages[0] : null;
    if (!tarball || tarball.name !== CODEXPRO_PACKAGE || tarball.version !== release.version) {
      fail(`Expected ${CODEXPRO_PACKAGE}@${release.version}; npm pack selected ${tarball?.name ?? "(missing)"}@${tarball?.version ?? "(missing)"}.`);
    }
    if (tarball.filename !== `${CODEXPRO_PACKAGE}-${release.version}.tgz`) {
      fail(`Unexpected tarball filename: ${tarball.filename ?? "(missing)"}.`);
    }
    const forbiddenInternal = (tarball.files ?? [])
      .map((entry) => entry.path)
      .filter((file) => file.startsWith("docs/superpowers/"));
    if (forbiddenInternal.length) {
      fail(`Internal planning files entered the public tarball: ${forbiddenInternal.join(", ")}.`);
    }

    if (!Array.isArray(tarball.bundled) || tarball.bundled.length === 0) {
      fail("npm pack did not include bundled dependencies. Ensure bundleDependencies: true is set and package-lock.json is valid.");
    }
    const bundledFiles = (tarball.files ?? []).filter((entry) => entry.path.startsWith("node_modules/"));
    if (bundledFiles.length === 0) {
      fail("npm pack did not include bundled dependency files in the package archive.");
    }

    const tarballPath = dryRun ? null : resolve(outDir, tarball.filename);
    const tarballSha256 = tarballPath && existsSync(tarballPath) ? sha256File(tarballPath) : null;

    return {
      name: tarball.name,
      version: tarball.version,
      filename: tarball.filename,
      tarballPath,
      tarballSha256,
      size: tarball.size,
      unpackedSize: tarball.unpackedSize,
      entryCount: tarball.entryCount,
      bundledDependenciesCount: tarball.bundled.length,
      bundledFilesCount: bundledFiles.length,
      productionClosureNodeCount: stagedClosure.packageCount,
      tarball
    };
  } finally {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      // ignore stage cleanup failure
    }
  }
}

const isDirect = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  try {
    const packDestArg = process.argv.find((a) => a.startsWith("--pack-destination="));
    const dest = packDestArg ? packDestArg.split("=")[1] : null;
    const isDryRun = process.argv.includes("--dry-run") || (!dest && !process.argv.includes("--pack"));
    const outDir = dest ? resolve(dest) : CODEXPRO_ROOT;

    const result = packLockDerivedRelease({
      root: CODEXPRO_ROOT,
      outDir,
      dryRun: isDryRun
    });

    console.log(JSON.stringify({
      name: result.name,
      version: result.version,
      filename: result.filename,
      size: result.size,
      unpackedSize: result.unpackedSize,
      entryCount: result.entryCount,
      bundledDependenciesCount: result.bundledDependenciesCount,
      bundledFilesCount: result.bundledFilesCount,
      productionClosureNodeCount: result.productionClosureNodeCount
    }, null, 2));
  } catch (error) {
    console.error(`[release pack] ${error.message}`);
    process.exitCode = 1;
  }
}
