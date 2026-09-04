#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEXPRO_ROOT, assertCodexProReleaseEnvironment, assertReleaseDependencyClosure } from "./release-guard.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.npm_execpath;

function sha256File(filePath) {
  const data = readFileSync(filePath);
  return createHash("sha256").update(data).digest("hex");
}

function normalizeLockfileGraph(lockPath) {
  const lockData = JSON.parse(readFileSync(lockPath, "utf8"));
  const packages = lockData.packages ?? {};
  const nodes = [];

  for (const [key, meta] of Object.entries(packages)) {
    if (key === "" || meta.dev) continue;
    const name = meta.name || key.split("node_modules/").pop();
    nodes.push({
      path: key,
      name,
      version: meta.version ?? "",
      resolved: meta.resolved ?? "",
      integrity: meta.integrity ?? "",
      optional: Boolean(meta.optional),
      dependencies: meta.dependencies ?? {}
    });
  }

  nodes.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.version.localeCompare(b.version);
  });

  const serialized = JSON.stringify(nodes, Object.keys(nodes[0] ?? {}).sort(), 2);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");

  return {
    node_count: nodes.length,
    graph_sha256: digest,
    nodes
  };
}

function inspectInstalledTopology(baseDir) {
  const nmRoot = resolve(baseDir, "node_modules");
  if (!existsSync(nmRoot)) return [];
  const nodes = [];

  function checkPkg(dir) {
    const pFile = join(dir, "package.json");
    if (existsSync(pFile)) {
      try {
        const pj = JSON.parse(readFileSync(pFile, "utf8"));
        nodes.push({
          path: "node_modules/" + relative(nmRoot, dir).replace(/\\/g, "/"),
          name: pj.name,
          version: pj.version,
          dependencies: pj.dependencies ?? {}
        });
      } catch {
        // ignore
      }
    }
  }

  function walk(currentDir) {
    if (!existsSync(currentDir)) return;
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = join(currentDir, entry.name);
        const scopedEntries = readdirSync(scopeDir, { withFileTypes: true });
        for (const sub of scopedEntries) {
          if (!sub.isDirectory() || sub.name.startsWith(".")) continue;
          const subDir = join(scopeDir, sub.name);
          checkPkg(subDir);
          const nestedNm = join(subDir, "node_modules");
          if (existsSync(nestedNm)) walk(nestedNm);
        }
      } else {
        const pkgDir = join(currentDir, entry.name);
        checkPkg(pkgDir);
        const nestedNm = join(pkgDir, "node_modules");
        if (existsSync(nestedNm)) walk(nestedNm);
      }
    }
  }

  walk(nmRoot);
  nodes.sort((a, b) => a.path.localeCompare(b.path));
  return nodes;
}

function buildByteManifest(dir) {
  const entries = [];

  function walk(current) {
    if (!existsSync(current)) return;
    const names = readdirSync(current);
    names.sort();
    for (const name of names) {
      const full = join(current, name);
      const rel = relative(dir, full).replace(/\\/g, "/");
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push({
          path: rel,
          target: readlinkSync(full),
          type: "symlink"
        });
      } else if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        entries.push({
          path: rel,
          sha256: sha256File(full),
          size: stat.size,
          type: "file"
        });
      }
    }
  }

  walk(dir);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const serialized = JSON.stringify(entries, null, 2);
  const digest = createHash("sha256").update(serialized, "utf8").digest("hex");

  return {
    entry_count: entries.length,
    manifest_sha256: digest,
    entries
  };
}

async function main() {
  const args = process.argv.slice(2);
  let evidenceDir = null;
  const evidenceIdx = args.indexOf("--evidence-dir");
  if (evidenceIdx !== -1 && args[evidenceIdx + 1]) {
    evidenceDir = resolve(args[evidenceIdx + 1]);
  }

  console.log("==> Step 1: Asserting release environment and lock-derived dependency closure...");
  const release = assertCodexProReleaseEnvironment();
  assert.equal(release.productionClosure.packageCount, 100, `Expected exactly 100 production packages; found ${release.productionClosure.packageCount}`);
  console.log(`    Release environment valid: ${release.name}@${release.version}`);
  console.log(`    Verified ${release.productionClosure.packageCount} production runtime packages in node_modules against package-lock.json.`);

  console.log("==> Step 2: Computing canonical lockfile graph identity...");
  const lockGraph = normalizeLockfileGraph(resolve(CODEXPRO_ROOT, "package-lock.json"));
  console.log(`    Lockfile graph nodes: ${lockGraph.node_count}`);
  console.log(`    Lockfile graph SHA-256: ${lockGraph.graph_sha256}`);
  assert.equal(lockGraph.node_count, 100, `Expected 100 lockfile nodes; found ${lockGraph.node_count}`);

  const workDir = mkdtempSync(join(tmpdir(), "codexpro-repro-"));
  const packDir = join(workDir, "pack");
  const prefixA = join(workDir, "prefix-a");
  const prefixB = join(workDir, "prefix-b");
  const cacheA = join(workDir, "cache-a");
  const cacheB = join(workDir, "cache-b");

  mkdirSync(packDir, { recursive: true });
  mkdirSync(prefixA, { recursive: true });
  mkdirSync(prefixB, { recursive: true });
  mkdirSync(cacheA, { recursive: true });
  mkdirSync(cacheB, { recursive: true });

  try {
    console.log("==> Step 3: Packing bundled candidate artifact...");
    const packCmd = npmCli ? [process.execPath, npmCli] : [npm];
    const packArgs = ["pack", "--ignore-scripts", "--json", `--pack-destination=${packDir}`];
    const packRes = spawnSync(packCmd[0], [...packCmd.slice(1), ...packArgs], {
      cwd: CODEXPRO_ROOT,
      encoding: "utf8",
      env: { ...process.env, INIT_CWD: CODEXPRO_ROOT }
    });
    assert.equal(packRes.status, 0, `npm pack failed: ${packRes.stderr}`);
    const packData = JSON.parse(packRes.stdout)[0];
    const tarballPath = join(packDir, packData.filename);
    const tarballSha256 = sha256File(tarballPath);

    console.log(`    Candidate tarball: ${packData.filename}`);
    console.log(`    Tarball SHA-256:   ${tarballSha256}`);
    console.log(`    Compressed size:   ${packData.size} bytes`);
    console.log(`    Unpacked size:     ${packData.unpackedSize} bytes`);
    console.log(`    Entry count:       ${packData.entryCount}`);
    console.log(`    Bundled count:     ${packData.bundled?.length ?? 0}`);

    assert.ok(Array.isArray(packData.bundled) && packData.bundled.length > 0, "No bundled packages reported by npm pack");

    console.log("==> Step 4: Executing offline global Install A into empty cache...");
    const installACmd = [
      npmCli ? process.execPath : npm,
      ...(npmCli ? [npmCli] : []),
      "install", "-g",
      "--prefix", prefixA,
      "--cache", cacheA,
      "--offline",
      "--omit=dev",
      tarballPath
    ];
    const installARes = spawnSync(installACmd[0], installACmd.slice(1), {
      encoding: "utf8",
      env: { ...process.env, HOME: prefixA }
    });
    assert.equal(installARes.status, 0, `Install A failed: ${installARes.stderr}`);
    console.log(`    Install A succeeded (exit 0).`);

    console.log("==> Step 5: Executing offline global Install B into empty cache...");
    const installBCmd = [
      npmCli ? process.execPath : npm,
      ...(npmCli ? [npmCli] : []),
      "install", "-g",
      "--prefix", prefixB,
      "--cache", cacheB,
      "--offline",
      "--omit=dev",
      tarballPath
    ];
    const installBRes = spawnSync(installBCmd[0], installBCmd.slice(1), {
      encoding: "utf8",
      env: { ...process.env, HOME: prefixB }
    });
    assert.equal(installBRes.status, 0, `Install B failed: ${installBRes.stderr}`);
    console.log(`    Install B succeeded (exit 0).`);

    console.log("==> Step 6: Verifying installed topologies match intended 100-node closure...");
    const installedPkgA = join(prefixA, "lib/node_modules/codexpro");
    const installedPkgB = join(prefixB, "lib/node_modules/codexpro");

    const nodesA = inspectInstalledTopology(installedPkgA);
    const nodesB = inspectInstalledTopology(installedPkgB);

    console.log(`    Installed A node count: ${nodesA.length}`);
    console.log(`    Installed B node count: ${nodesB.length}`);

    assert.equal(nodesA.length, 100, `Expected 100 nodes in A, found ${nodesA.length}`);
    assert.equal(nodesB.length, 100, `Expected 100 nodes in B, found ${nodesB.length}`);

    const intendedByPath = new Map(lockGraph.nodes.map((n) => [n.path, n]));
    const nodesAByPath = new Map(nodesA.map((n) => [n.path, n]));
    const nodesBByPath = new Map(nodesB.map((n) => [n.path, n]));

    for (const [p, intendedNode] of intendedByPath.entries()) {
      const nodeA = nodesAByPath.get(p);
      const nodeB = nodesBByPath.get(p);
      assert.ok(nodeA, `Package ${p} missing in Install A`);
      assert.ok(nodeB, `Package ${p} missing in Install B`);
      assert.equal(nodeA.version, intendedNode.version, `Version mismatch in A for ${p}`);
      assert.equal(nodeB.version, intendedNode.version, `Version mismatch in B for ${p}`);
    }
    console.log("    CONFIRMED: Topology A == Topology B == Intended 100-node topology (0 missing, 0 extra, 0 mismatches)!");

    console.log("==> Step 7: Generating and comparing installed runtime byte manifests...");
    const manifestA = buildByteManifest(join(installedPkgA, "node_modules"));
    const manifestB = buildByteManifest(join(installedPkgB, "node_modules"));

    console.log(`    Manifest A: ${manifestA.entry_count} entries, SHA-256: ${manifestA.manifest_sha256}`);
    console.log(`    Manifest B: ${manifestB.entry_count} entries, SHA-256: ${manifestB.manifest_sha256}`);

    assert.equal(manifestA.entry_count, manifestB.entry_count, "Byte manifest entry count mismatch!");
    assert.equal(manifestA.manifest_sha256, manifestB.manifest_sha256, "Byte manifest digest mismatch between A and B!");
    console.log("    CONFIRMED: Installed runtime byte manifests are 100% IDENTICAL!");

    console.log("==> Step 8: Verifying MCP SDK and Zod versions in installed runtime...");
    const sdkA = JSON.parse(readFileSync(join(installedPkgA, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
    const zodA = JSON.parse(readFileSync(join(installedPkgA, "node_modules/zod/package.json"), "utf8"));
    assert.equal(sdkA.version, "1.30.0", `Installed MCP SDK version mismatch: ${sdkA.version}`);
    assert.equal(zodA.version, "3.25.76", `Installed Zod version mismatch: ${zodA.version}`);
    console.log(`    @modelcontextprotocol/sdk: ${sdkA.version}`);
    console.log(`    zod:                      ${zodA.version}`);

    console.log("==> Step 9: Running CLI checks from isolated global prefixes...");
    const binA = join(prefixA, "bin/codexpro");
    const binB = join(prefixB, "bin/codexpro");

    const runA = spawnSync(process.execPath, [binA, "--version"], { encoding: "utf8" });
    assert.equal(runA.status, 0, `CLI A failed: ${runA.stderr}`);
    assert.equal(runA.stdout.trim(), release.version, `CLI A version mismatch: ${runA.stdout.trim()}`);

    const runB = spawnSync(process.execPath, [binB, "--version"], { encoding: "utf8" });
    assert.equal(runB.status, 0, `CLI B failed: ${runB.stderr}`);
    assert.equal(runB.stdout.trim(), release.version, `CLI B version mismatch: ${runB.stdout.trim()}`);
    console.log(`    CLI --version verified in both prefixes: ${runA.stdout.trim()}`);

    const summaryData = {
      task: "TASK-005",
      status: "PASS",
      tarball: {
        filename: packData.filename,
        sha256: tarballSha256,
        compressed_size: packData.size,
        unpacked_size: packData.unpackedSize,
        entry_count: packData.entryCount,
        bundled_dependencies_count: packData.bundled?.length ?? 0
      },
      intended_graph: {
        node_count: lockGraph.node_count,
        graph_sha256: lockGraph.graph_sha256
      },
      install_a: {
        prefix: prefixA,
        cache: cacheA,
        offline: true,
        node_count: nodesA.length,
        byte_manifest_entry_count: manifestA.entry_count,
        byte_manifest_sha256: manifestA.manifest_sha256
      },
      install_b: {
        prefix: prefixB,
        cache: cacheB,
        offline: true,
        node_count: nodesB.length,
        byte_manifest_entry_count: manifestB.entry_count,
        byte_manifest_sha256: manifestB.manifest_sha256
      },
      verifications: {
        offline_install_succeeded: true,
        topology_matches_intended: true,
        topology_a_equals_topology_b: true,
        byte_manifest_identical: true,
        mcp_sdk_preserved: sdkA.version === "1.30.0",
        zod_preserved: zodA.version === "3.25.76",
        cli_version_matched: true
      },
      gates: {
        "AP-009": "PASS",
        "AP-010": "PASS"
      }
    };

    if (evidenceDir) {
      console.log(`==> Step 10: Writing evidence to ${evidenceDir}...`);
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, "AP-009-AP-010-CANDIDATE-REPRODUCIBILITY.json"), JSON.stringify(summaryData, null, 2));
      writeFileSync(join(evidenceDir, "installed-topology-a.json"), JSON.stringify(nodesA, null, 2));
      writeFileSync(join(evidenceDir, "installed-topology-b.json"), JSON.stringify(nodesB, null, 2));
      writeFileSync(join(evidenceDir, "installed-byte-manifest-a.json"), JSON.stringify(manifestA, null, 2));
      writeFileSync(join(evidenceDir, "installed-byte-manifest-b.json"), JSON.stringify(manifestB, null, 2));
      writeFileSync(join(evidenceDir, "install-a.log"), `COMMAND: ${installACmd.join(" ")}\nEXIT_CODE: ${installARes.status}\nSTDOUT:\n${installARes.stdout}\nSTDERR:\n${installARes.stderr}\n`);
      writeFileSync(join(evidenceDir, "install-b.log"), `COMMAND: ${installBCmd.join(" ")}\nEXIT_CODE: ${installBRes.status}\nSTDOUT:\n${installBRes.stdout}\nSTDERR:\n${installBRes.stderr}\n`);

      const summaryMd = `# TASK-005 Evidence Summary — Candidate Bundled-Artifact Reproducibility

Status: **ACCEPTED — AP-009 PASS / AP-010 PASS**
Execution Authority: A002 / P002 / L006 / TR-006
Execution Owner: \`repoconnect-m007-root\` (ACTIVE)

## Pass 1 (Direct Physical Observation)

1. **Candidate Packed Tarball**:
   - Tarball: \`${packData.filename}\`
   - SHA-256: \`${tarballSha256}\`
   - Compressed size: ${packData.size} bytes (~6.0 MB)
   - Unpacked size: ${packData.unpackedSize} bytes (~21.7 MB)
   - Entry count: ${packData.entryCount}
   - Bundled dependency count: ${packData.bundled?.length ?? 0}
2. **Two Independent Offline Global Installs**:
   - Empty caches, \`--offline --omit=dev\`
   - Install A exit code: 0
   - Install B exit code: 0
3. **Topology Comparison**:
   - Declared intended lockfile closure: 100 nodes (SHA-256 \`${lockGraph.graph_sha256}\`)
   - Install A topology: 100 nodes (0 missing, 0 extra, 0 mismatches)
   - Install B topology: 100 nodes (0 missing, 0 extra, 0 mismatches)
   - Topology A == Topology B == Intended 100-node closure: **MATCH**
4. **Installed Byte Manifest**:
   - Install A byte manifest: ${manifestA.entry_count} entries, SHA-256 \`${manifestA.manifest_sha256}\`
   - Install B byte manifest: ${manifestB.entry_count} entries, SHA-256 \`${manifestB.manifest_sha256}\`
   - Byte-manifest equality: **100% IDENTICAL**
5. **Preserved Baseline Versions**:
   - \`@modelcontextprotocol/sdk\`: \`${sdkA.version}\`
   - \`zod\`: \`${zodA.version}\`
6. **CLI Sanity Check**:
   - \`codexpro --version\` in prefix A: \`${runA.stdout.trim()}\`
   - \`codexpro --version\` in prefix B: \`${runB.stdout.trim()}\`

Direct Physical Verdict: **MATCH**.

## Pass 2 (Technical Evaluation)

1. The candidate bundled tarball was generated directly from the candidate worktree, where \`node_modules\` was verified against \`package-lock.json\`.
2. Both offline global installations succeeded without accessing external networks or registry endpoints.
3. The installed runtime environment in both prefixes exactly reproduces the 100-node production closure with zero drift and bit-identical file contents.

## Acceptance Gates

- **AP-009**: Candidate bundled artifact reproducibly installs globally offline to one intended runtime graph and identical runtime bytes. **PASS**.
- **AP-010**: Proof is independent of source/global installs, cache reuse, and registry dependency resolution. **PASS**.
`;
      writeFileSync(join(evidenceDir, "TASK-005-SUMMARY.md"), summaryMd);

      // Generate MANIFEST.sha256
      const manifestLines = [];
      for (const item of readdirSync(evidenceDir).sort()) {
        if (item === "MANIFEST.sha256") continue;
        const itemPath = join(evidenceDir, item);
        if (lstatSync(itemPath).isFile()) {
          manifestLines.push(`${sha256File(itemPath)}  ${item}`);
        }
      }
      writeFileSync(join(evidenceDir, "MANIFEST.sha256"), manifestLines.join("\n") + "\n");
      console.log(`    Evidence written and manifest hashed.`);
    }

    console.log(JSON.stringify({
      status: "PASS",
      tarball: packData.filename,
      tarball_sha256: tarballSha256,
      installed_topology_match: true,
      byte_manifest_identical: true,
      manifest_sha256: manifestA.manifest_sha256,
      gates: {
        "AP-009": "PASS",
        "AP-010": "PASS"
      }
    }, null, 2));
    console.log("✓ Release reproducibility verification passed (AP-009 PASS / AP-010 PASS)");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[release reproducibility] ERROR: ${err.message}\n${err.stack}`);
  process.exitCode = 1;
});
