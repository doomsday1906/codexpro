import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBuildIdentity } from "./build-identity.mjs";
import { assertExactCleanSource, buildIdentityMatches, restorePriorPackage } from "./deploy-transaction.mjs";
import { deployExactCommit, discoverOrdinaryTarget, pathExecutables } from "./deploy-local.mjs";
import { pathToFileURL } from "node:url";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-deploy-smoke-"));
try {
  const globalModules = path.join(temp, "lib", "node_modules");
  const packageRoot = path.join(globalModules, "codexpro");
  const binDir = path.join(temp, "bin");
  const packageBin = path.join(packageRoot, "scripts", "codexpro.mjs");
  await fs.mkdir(path.dirname(packageBin), { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "codexpro", version: "0.31.0", bin: { codexpro: "scripts/codexpro.mjs" } }));
  await fs.writeFile(packageBin, "#!/usr/bin/env node\n");
  await fs.chmod(packageBin, 0o755);
  await fs.symlink(packageBin, path.join(binDir, "codexpro"));

  const target = discoverOrdinaryTarget({ pathValue: binDir, globalModulesRoot: globalModules });
  assert.equal(target.packageRoot, packageRoot);
  assert.equal(target.executable, packageBin);
  assert.deepEqual(pathExecutables(binDir), [path.join(binDir, "codexpro")]);
  const nonExecutableBin = path.join(temp, "non-executable-bin");
  await fs.mkdir(nonExecutableBin, { recursive: true });
  await fs.writeFile(path.join(nonExecutableBin, "codexpro"), "not executable\n", { mode: 0o600 });
  assert.deepEqual(pathExecutables(nonExecutableBin), []);

  const conflictingRoot = path.join(temp, "other", "node_modules", "codexpro");
  const otherBin = path.join(temp, "other-bin");
  const otherPackageBin = path.join(conflictingRoot, "scripts", "codexpro.mjs");
  await fs.mkdir(path.dirname(otherPackageBin), { recursive: true });
  await fs.mkdir(otherBin, { recursive: true });
  await fs.writeFile(path.join(conflictingRoot, "package.json"), JSON.stringify({ name: "codexpro", version: "0.30.0", bin: { codexpro: "scripts/codexpro.mjs" } }));
  await fs.writeFile(otherPackageBin, "#!/usr/bin/env node\n");
  await fs.chmod(otherPackageBin, 0o755);
  await fs.symlink(otherPackageBin, path.join(otherBin, "codexpro"));
  assert.throws(
    () => discoverOrdinaryTarget({ pathValue: [binDir, otherBin].join(path.delimiter) }),
    /conflicting codexpro installations/u
  );
  assert.throws(
    () => discoverOrdinaryTarget({ pathValue: binDir, globalModulesRoot: path.join(temp, "wrong", "node_modules") }),
    /npm's global package root/u
  );
  await assert.rejects(() => deployExactCommit("0".repeat(40)), /Source HEAD is .* refusing to deploy/u);
  assert.throws(() => assertExactCleanSource({ requestedCommit: "1".repeat(40), headCommit: "1".repeat(40), dirtyStatus: " M src/server.ts" }), /checkout is dirty/u);
  const sameVersionA = createBuildIdentity({ packageName: "codexpro", packageVersion: "0.31.0", sourceCommit: "1".repeat(40), sourceState: "clean" });
  const sameVersionB = createBuildIdentity({ packageName: "codexpro", packageVersion: "0.31.0", sourceCommit: "2".repeat(40), sourceState: "clean" });
  const unavailableIdentity = createBuildIdentity({ packageName: "codexpro", packageVersion: "0.31.0", sourceCommit: null, sourceState: "clean" });
  assert.equal(sameVersionA.package_version, sameVersionB.package_version);
  assert.notEqual(sameVersionA.source_commit, sameVersionB.source_commit);
  assert.equal(unavailableIdentity.source_commit, null);
  assert.equal(unavailableIdentity.source_state, "unavailable");
  assert.equal(buildIdentityMatches(sameVersionA, { commit: "1".repeat(40), version: "0.31.0" }), true);
  assert.equal(buildIdentityMatches(sameVersionB, { commit: "1".repeat(40), version: "0.31.0" }), false);
  let rollbackCalls = 0;
  await assert.rejects(() => restorePriorPackage({
    reason: "Injected package update failure.",
    packageRoot,
    installPrevious: async () => { rollbackCalls += 1; return true; },
    verifyPrevious: async () => true
  }), /Previous package was restored and verified; no success was reported/u);
  assert.equal(rollbackCalls, 1);
  await assert.rejects(() => restorePriorPackage({
    reason: "Injected package update failure.", packageRoot,
    installPrevious: async () => false,
    verifyPrevious: async () => false
  }), /rollback could not be proven/u);

  const identityFixture = path.join(temp, "head-change-fixture");
  const identityDist = path.join(identityFixture, "dist");
  await fs.mkdir(identityDist, { recursive: true });
  await fs.writeFile(path.join(identityFixture, "package.json"), '{"name":"identity-fixture","type":"module"}\n');
  await fs.copyFile(new URL("../dist/buildIdentity.js", import.meta.url), path.join(identityDist, "buildIdentity.js"));
  const missingIdentity = await import(`${pathToFileURL(path.join(identityDist, "buildIdentity.js"))}?missing`);
  assert.equal(missingIdentity.CODEXPRO_BUILD_IDENTITY.source_commit, null);
  assert.equal(missingIdentity.CODEXPRO_BUILD_IDENTITY.source_state, "unavailable");
  git(identityFixture, ["init", "-q"]);
  git(identityFixture, ["config", "user.name", "CodexPro smoke"]);
  git(identityFixture, ["config", "user.email", "codexpro-smoke@invalid"]);
  await fs.writeFile(path.join(identityFixture, "source.txt"), "first source\n");
  git(identityFixture, ["add", "."]);
  git(identityFixture, ["commit", "-qm", "first source"]);
  const firstHead = git(identityFixture, ["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(identityDist, "build-identity.json"), `${JSON.stringify(createBuildIdentity({ packageName: "codexpro", packageVersion: "0.31.0", sourceCommit: firstHead, sourceState: "clean" }))}\n`);
  const firstLoadedIdentity = await import(`${pathToFileURL(path.join(identityDist, "buildIdentity.js"))}?head=first`);
  await fs.writeFile(path.join(identityFixture, "source.txt"), "second source\n");
  git(identityFixture, ["add", "."]);
  git(identityFixture, ["commit", "-qm", "second source"]);
  assert.notEqual(git(identityFixture, ["rev-parse", "HEAD"]), firstHead);
  const secondLoadedIdentity = await import(`${pathToFileURL(path.join(identityDist, "buildIdentity.js"))}?head=second`);
  assert.equal(firstLoadedIdentity.CODEXPRO_BUILD_IDENTITY.source_commit, firstHead);
  assert.equal(secondLoadedIdentity.CODEXPRO_BUILD_IDENTITY.source_commit, firstHead);
  console.log("PASS: local deployment resolves the ordinary PATH package and refuses conflicting/global-root ambiguity.");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
