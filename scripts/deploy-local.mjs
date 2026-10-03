#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assertExactCleanSource, buildIdentityMatches, restorePriorPackage } from "./deploy-transaction.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "codexpro";
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath;
let interruptedBy = null;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interruptedBy = signal; });

function fail(message) { throw new Error(message); }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) fail(`Could not run ${command}: ${result.error.message}`);
  return result;
}

function npm(args, options = {}) {
  const command = npmExecPath ? process.execPath : npmExecutable;
  const npmArgs = npmExecPath ? [npmExecPath, ...args] : args;
  return run(command, npmArgs, options);
}

function realpath(filePath) {
  try { return fs.realpathSync(filePath); }
  catch { return path.resolve(filePath); }
}

function packageRootForExecutable(executable) {
  const resolved = realpath(executable);
  let cursor = path.dirname(resolved);
  while (true) {
    const manifestPath = path.join(cursor, "package.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === PACKAGE_NAME && manifest.bin?.codexpro) return { packageRoot: realpath(cursor), executable: resolved, version: manifest.version };
    } catch { /* continue walking toward the install root */ }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

export function pathExecutables(pathValue = process.env.PATH ?? "") {
  const matches = [];
  const names = process.platform === "win32" ? ["codexpro", "codexpro.cmd", "codexpro.exe"] : ["codexpro"];
  for (const pathEntry of pathValue.split(path.delimiter)) {
    const directory = pathEntry || process.cwd();
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) {
          if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
          matches.push(candidate);
        }
      } catch { /* absent PATH entry */ }
    }
  }
  return matches;
}

export function discoverOrdinaryTarget({ pathValue = process.env.PATH ?? "", globalModulesRoot } = {}) {
  const commands = pathExecutables(pathValue);
  if (!commands.length) fail("No codexpro executable is present on PATH.");
  const targets = commands.map((executable) => {
    const target = packageRootForExecutable(executable);
    if (!target) fail(`Cannot resolve codexpro package metadata for PATH executable ${executable}.`);
    return { ...target, pathEntry: executable };
  });
  const roots = new Set(targets.map((target) => target.packageRoot));
  if (roots.size !== 1) fail(`PATH contains conflicting codexpro installations: ${[...roots].join(", ")}`);
  const target = targets[0];
  if (globalModulesRoot && realpath(path.dirname(target.packageRoot)) !== realpath(globalModulesRoot)) {
    fail(`The ordinary codexpro executable resolves to ${target.packageRoot}, but npm's global package root is ${globalModulesRoot}.`);
  }
  if (target.packageRoot === realpath(SOURCE_ROOT)) fail("The installed codexpro executable points into the active source checkout; local deployment refuses live npm-link coupling.");
  return { ...target, commands: targets.map((entry) => entry.pathEntry) };
}

function git(args) {
  const result = run("git", args, { cwd: SOURCE_ROOT });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function treeDigest(root) {
  const entries = [];
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const rel = path.posix.join(relative.split(path.sep).join("/"), entry.name);
      if (entry.isDirectory()) visit(absolute, rel);
      else if (entry.isSymbolicLink()) entries.push(`${rel}\0link\0${fs.readlinkSync(absolute)}`);
      else if (entry.isFile()) entries.push(`${rel}\0file\0${sha256(absolute)}`);
      else fail(`Unsupported package entry while verifying installation: ${absolute}`);
    }
  };
  visit(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function checkedNpm(args, options = {}) {
  const result = npm(args, options);
  if (result.status !== 0) fail(`npm ${args.join(" ")} failed (${result.status ?? result.signal}): ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function pack(cwd, destination) {
  const output = checkedNpm(["pack", "--ignore-scripts", "--json", `--pack-destination=${destination}`], { cwd });
  let metadata;
  try { metadata = JSON.parse(output)[0]; }
  catch { fail("npm pack did not return its JSON package manifest."); }
  if (metadata?.name !== PACKAGE_NAME || !metadata.filename) fail(`Unexpected npm pack result for ${cwd}.`);
  const archive = path.join(destination, metadata.filename);
  if (!fs.existsSync(archive)) fail(`npm pack did not create ${archive}.`);
  return { archive, metadata, archiveSha256: sha256(archive) };
}

function readBuildIdentity(packageRoot) {
  const identityPath = path.join(packageRoot, "dist", "build-identity.json");
  try { return JSON.parse(fs.readFileSync(identityPath, "utf8")); }
  catch { fail(`Missing or invalid package build identity: ${identityPath}`); }
}

function install(archive, prefix) {
  return npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", archive], { cwd: SOURCE_ROOT });
}

export async function deployExactCommit(commit) {
  const head = git(["rev-parse", "--verify", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=normal"]);
  assertExactCleanSource({ requestedCommit: commit, headCommit: head, dirtyStatus: dirty });

  const globalRootText = checkedNpm(["root", "-g"]);
  const globalModulesRoot = realpath(globalRootText);
  const target = discoverOrdinaryTarget({ globalModulesRoot });
  const prefix = checkedNpm(["prefix", "-g"]);
  const npmRootFromPrefix = realpath(checkedNpm(["root", "-g", "--prefix", prefix]));
  if (npmRootFromPrefix !== globalModulesRoot) fail(`npm global prefix discovery was inconsistent (${globalModulesRoot} vs ${npmRootFromPrefix}).`);

  const packageJson = JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"));
  const build = run(process.execPath, [path.join(SOURCE_ROOT, "scripts/build.mjs")], { cwd: SOURCE_ROOT });
  if (build.status !== 0) fail(`Build failed (${build.status ?? build.signal}).`);
  const builtIdentity = readBuildIdentity(SOURCE_ROOT);
  if (!buildIdentityMatches(builtIdentity, { commit, version: packageJson.version })) {
    fail(`Build identity did not bind to the requested clean source commit: ${JSON.stringify(builtIdentity)}.`);
  }
  if (git(["status", "--porcelain", "--untracked-files=normal"])) fail("Build changed tracked or untracked source state; refusing to package an ambiguous result.");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codexpro-local-deploy-"));
  const oldArchiveDir = path.join(workspace, "previous");
  const candidateArchiveDir = path.join(workspace, "candidate");
  const stagingPrefix = path.join(workspace, "staging");
  fs.mkdirSync(oldArchiveDir);
  fs.mkdirSync(candidateArchiveDir);
  try {
    const candidate = pack(SOURCE_ROOT, candidateArchiveDir);
    const candidateStageInstall = npm(["install", "--prefix", stagingPrefix, "--ignore-scripts", candidate.archive], { cwd: SOURCE_ROOT });
    if (candidateStageInstall.status !== 0) fail(`Candidate staging install failed: ${(candidateStageInstall.stderr || candidateStageInstall.stdout).trim()}`);
    const stagedPackageRoot = path.join(stagingPrefix, "node_modules", PACKAGE_NAME);
    const stagedIdentity = readBuildIdentity(stagedPackageRoot);
    if (JSON.stringify(stagedIdentity) !== JSON.stringify(builtIdentity)) fail("npm package staging changed the embedded build identity.");

    const before = pack(target.packageRoot, oldArchiveDir);
    const update = install(candidate.archive, prefix);
    let updateFailure = interruptedBy
      ? `Deployment was interrupted by ${interruptedBy}.`
      : update.status === 0 ? null : `npm global install failed (${update.status ?? update.signal}): ${(update.stderr || update.stdout).trim()}`;

    const installedRoot = path.join(globalModulesRoot, PACKAGE_NAME);
    let finalTarget;
    let finalIdentity;
    try {
      finalTarget = discoverOrdinaryTarget({ globalModulesRoot });
      if (finalTarget.packageRoot !== installedRoot) fail("The ordinary codexpro PATH target changed during deployment.");
      const installedIdentity = readBuildIdentity(finalTarget.packageRoot);
      const stagedDigest = treeDigest(stagedPackageRoot);
      const installedDigest = treeDigest(finalTarget.packageRoot);
      if (update.status !== 0 || JSON.stringify(installedIdentity) !== JSON.stringify(builtIdentity) || stagedDigest !== installedDigest) {
        updateFailure ??= "Installed package did not match the exact staged candidate.";
      }
      finalIdentity = installedIdentity;
    } catch (error) {
      updateFailure ??= error instanceof Error ? error.message : String(error);
    }

    if (updateFailure) {
      const previousStage = path.join(workspace, "previous-stage");
      fs.mkdirSync(previousStage);
      await restorePriorPackage({
        reason: updateFailure,
        packageRoot: target.packageRoot,
        installPrevious: () => install(before.archive, prefix).status === 0,
        verifyPrevious: () => {
          const stagedRollback = npm(["install", "--prefix", previousStage, "--ignore-scripts", before.archive], { cwd: SOURCE_ROOT });
          const previousPackage = path.join(previousStage, "node_modules", PACKAGE_NAME);
          return stagedRollback.status === 0
            && treeDigest(target.packageRoot) === treeDigest(previousPackage);
        }
      });
    }

    if (!finalTarget || !finalIdentity || finalIdentity.source_commit !== commit || finalIdentity.source_state !== "clean") fail("Final installed package readback does not match the requested exact build.");
    return {
      source_commit: commit,
      source_package_root: SOURCE_ROOT,
      installed_package_root: finalTarget.packageRoot,
      resolved_codexpro_executable: finalTarget.executable,
      normal_codexpro_path_entry: finalTarget.pathEntry,
      installed_version: finalIdentity.package_version,
      installed_build_identity: finalIdentity,
      package_content_matches_candidate: true,
      candidate_archive_sha256: candidate.archiveSha256,
      previous_archive_sha256: before.archiveSha256,
      restart_required: true,
      runtime_restarted: false
    };
  } finally {
    // This temporary directory is one exact task-owned child under the OS temp root.
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    const result = await deployExactCommit(process.argv[2]);
    console.log("DEPLOYED / READY FOR RESTART");
    console.log(JSON.stringify(result, null, 2));
    console.log("The installed package is prepared. Restart CodexPro manually with your normal `codexpro start` command.");
  } catch (error) {
    console.error(`[local deploy] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
