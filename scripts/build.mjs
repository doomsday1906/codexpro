import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuildIdentity } from "./build-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(resolve(root, "package.json"), "utf8"));
const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const headResult = run(["rev-parse", "--verify", "HEAD"]);
const commit = headResult.status === 0 && /^[0-9a-f]{40}$/u.test(headResult.stdout.trim()) ? headResult.stdout.trim() : null;
const statusResult = commit ? run(["status", "--porcelain", "--untracked-files=normal"]) : null;
const sourceState = !commit || statusResult?.status !== 0 ? "unavailable" : statusResult.stdout.trim() ? "dirty" : "clean";

const tsc = resolve(root, "node_modules/typescript/bin/tsc");
const compiled = spawnSync(process.execPath, [tsc, "-p", resolve(root, "tsconfig.json")], { cwd: root, stdio: "inherit" });
if (compiled.error) throw compiled.error;
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const identity = createBuildIdentity({
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  sourceCommit: commit,
  sourceState
});
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/build-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
console.log(`Built ${identity.package_name}@${identity.package_version}; source commit ${commit ?? "unavailable"} (${sourceState}).`);
