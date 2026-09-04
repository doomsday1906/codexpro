import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;
const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "package.json"), "utf8"));

assert.equal(manifest.scripts.prepublishOnly, "node scripts/release-guard.mjs");
assert.equal(manifest.scripts["release:guard"], "node scripts/release-guard.mjs");
assert.equal(manifest.scripts["release:pack"], "node scripts/release-pack.mjs");
assert.equal(manifest.scripts["release:publish"], "node scripts/release-publish.mjs");
assert.equal(manifest.scripts["release:reproducibility"], "node scripts/release-reproducibility.mjs");
assert.equal(manifest.scripts["release:drift-falsifier"], "node scripts/release-content-drift-falsifier.mjs");
assert.equal(manifest.scripts["release:publish-falsifier"], "node scripts/release-publish-falsifier.mjs");

function run(command, args, { cwd, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

const wrongCwd = mkdtempSync(join(tmpdir(), "codexpro-release-guard-"));

try {
  const allowed = run(process.execPath, ["scripts/release-guard.mjs"], { cwd: root });
  assert.equal(allowed.status, 0, allowed.output);
  assert.match(allowed.output, /CodexPro release guard: codexpro@\d+\.\d+\.\d+/);

  const wrongDirectory = run(process.execPath, [join(root, "scripts/release-guard.mjs")], { cwd: wrongCwd });
  assert.notEqual(wrongDirectory.status, 0, wrongDirectory.output);
  assert.match(wrongDirectory.output, /Release commands must run from the CodexPro root/);

  const prefixArgs = ["--prefix", root, "run", "release:guard", "--silent"];
  const prefixInvocation = npmCli
    ? run(process.execPath, [npmCli, ...prefixArgs], { cwd: wrongCwd })
    : run(npm, prefixArgs, { cwd: wrongCwd });
  assert.notEqual(prefixInvocation.status, 0, prefixInvocation.output);
  assert.match(prefixInvocation.output, /Release commands must run from the CodexPro root/);

  const packed = run(process.execPath, ["scripts/release-pack.mjs"], { cwd: root });
  assert.equal(packed.status, 0, packed.output);
  const tarball = JSON.parse(packed.output);
  assert.equal(tarball.name, "codexpro");
  assert.match(tarball.version, /^\d+\.\d+\.\d+$/);
  assert.equal(tarball.filename, `codexpro-${tarball.version}.tgz`);
  assert.equal(typeof tarball.bundledDependenciesCount, "number");
  assert.ok(tarball.bundledDependenciesCount > 0, "expected bundledDependenciesCount > 0");
  assert.equal(typeof tarball.bundledFilesCount, "number");
  assert.ok(tarball.bundledFilesCount > 0, "expected bundledFilesCount > 0");
  assert.equal(tarball.productionClosureNodeCount, 100);

  // Test closure failure mode on incomplete/corrupted dependency tree
  const { assertReleaseDependencyClosure } = await import("./release-guard.mjs");
  const testDir = mkdtempSync(join(tmpdir(), "codexpro-closure-test-"));
  try {
    const fs = await import("node:fs");
    fs.writeFileSync(join(testDir, "package-lock.json"), JSON.stringify({
      name: "test-pkg",
      lockfileVersion: 3,
      packages: {
        "": { name: "test-pkg" },
        "node_modules/fake-dep": { name: "fake-dep", version: "1.0.0" }
      }
    }));
    // Missing node_modules directory
    assert.throws(
      () => assertReleaseDependencyClosure(testDir),
      /Release dependency closure check failed: missing installed package/
    );

    // Mismatched version
    fs.mkdirSync(join(testDir, "node_modules", "fake-dep"), { recursive: true });
    fs.writeFileSync(join(testDir, "node_modules", "fake-dep", "package.json"), JSON.stringify({
      name: "fake-dep",
      version: "0.9.0"
    }));
    assert.throws(
      () => assertReleaseDependencyClosure(testDir),
      /expected version "1.0.0" but found "0.9.0"/
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
} finally {
  rmSync(wrongCwd, { recursive: true, force: true });
}

console.log("✓ release guard smoke test passed");
