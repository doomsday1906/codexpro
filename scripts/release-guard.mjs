import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CODEXPRO_PACKAGE = "codexpro";
export const CODEXPRO_REPOSITORY = "git+https://github.com/rebel0789/codexpro.git";
export const CODEXPRO_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

function releaseRootError(actualPath) {
  return new Error(
    `Release commands must run from the CodexPro root (${CODEXPRO_ROOT}). ` +
    `Current directory is ${actualPath}. Change directory first; do not use npm --prefix for npm pack or npm publish.`
  );
}

export function assertReleaseDependencyClosure(root = CODEXPRO_ROOT) {
  const lockPath = resolve(root, "package-lock.json");
  let lockData;
  try {
    lockData = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (err) {
    throw new Error(`Release dependency closure check failed: cannot read package-lock.json at ${lockPath}: ${err.message}`);
  }

  const packages = lockData.packages ?? {};
  const expectedPackages = [];
  for (const [key, meta] of Object.entries(packages)) {
    if (key === "" || meta.dev) continue;
    const name = meta.name || key.split("node_modules/").pop();
    expectedPackages.push({
      path: key,
      name,
      version: meta.version
    });
  }

  if (expectedPackages.length === 0) {
    throw new Error("Release dependency closure check failed: no production dependencies found in package-lock.json.");
  }

  for (const pkg of expectedPackages) {
    const pkgJsonPath = resolve(root, pkg.path, "package.json");
    let installedPkg;
    try {
      installedPkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    } catch {
      throw new Error(
        `Release dependency closure check failed: missing installed package "${pkg.name}" at "${pkg.path}". ` +
        `Stale or incomplete node_modules detected; run "npm ci" before release packaging.`
      );
    }
    if (installedPkg.name !== pkg.name || installedPkg.version !== pkg.version) {
      throw new Error(
        `Release dependency closure check failed: package "${pkg.name}" at "${pkg.path}" ` +
        `expected version "${pkg.version}" but found "${installedPkg.version}". ` +
        `Stale node_modules detected; run "npm ci" before release packaging.`
      );
    }
  }

  return {
    packageCount: expectedPackages.length,
    packages: expectedPackages
  };
}

export function assertCodexProReleaseEnvironment({ cwd = process.cwd(), env = process.env, verifyClosure = true } = {}) {
  const actualCwd = canonicalPath(cwd);
  if (actualCwd !== CODEXPRO_ROOT) throw releaseRootError(actualCwd);

  if (env.INIT_CWD && canonicalPath(env.INIT_CWD) !== CODEXPRO_ROOT) {
    throw releaseRootError(canonicalPath(env.INIT_CWD));
  }

  const expectedPackageJson = resolve(CODEXPRO_ROOT, "package.json");
  if (env.npm_package_json && canonicalPath(env.npm_package_json) !== canonicalPath(expectedPackageJson)) {
    throw new Error("npm is bound to a different package.json; stop before packing or publishing.");
  }

  const packageJson = JSON.parse(readFileSync(expectedPackageJson, "utf8"));
  if (packageJson.name !== CODEXPRO_PACKAGE) {
    throw new Error(`Expected package name ${CODEXPRO_PACKAGE}; found ${packageJson.name ?? "(missing)"}.`);
  }
  if (packageJson.repository?.url !== CODEXPRO_REPOSITORY) {
    throw new Error("CodexPro repository metadata does not match the canonical release repository.");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version ?? "")) {
    throw new Error("CodexPro package.json has an invalid release version.");
  }
  if (packageJson.bundleDependencies !== true && packageJson.bundledDependencies !== true) {
    throw new Error("CodexPro release packaging requires bundleDependencies: true in package.json.");
  }

  let productionClosure = null;
  if (verifyClosure) {
    productionClosure = assertReleaseDependencyClosure(CODEXPRO_ROOT);
  }

  return {
    root: CODEXPRO_ROOT,
    name: packageJson.name,
    version: packageJson.version,
    productionClosure
  };
}

function isDirectInvocation() {
  return Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isDirectInvocation()) {
  try {
    const release = assertCodexProReleaseEnvironment();
    console.log(`CodexPro release guard: ${release.name}@${release.version} (production closure: ${release.productionClosure.packageCount} packages verified)`);
  } catch (error) {
    console.error(`[release guard] ${error.message}`);
    process.exitCode = 1;
  }
}
