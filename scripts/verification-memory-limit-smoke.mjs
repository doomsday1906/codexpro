import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import { VerificationManager } from "../dist/verificationOps.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-memory-limit-"));
const workspaceRoot = await fs.realpath(fixtureRoot);
const workspace = { id: "ws_memory_limit_fixture", root: workspaceRoot, openedAt: new Date().toISOString() };
const config = {
  ...loadConfig(["--root", workspaceRoot, "--allow-root", workspaceRoot]),
  bashMode: "safe"
};

try {
  if (process.platform !== "linux") {
    console.log("verification-memory-limit-smoke: SKIP (Linux systemd scopes are unavailable)");
  } else {
    const packageJson = {
      name: "memory-limit-fixture",
      scripts: { test: "node parent.mjs" }
    };
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify(packageJson));
    await fs.writeFile(path.join(workspaceRoot, "parent.mjs"), `
import { spawn } from "node:child_process";
const code = String.raw\`import fs from "node:fs"; const requested = 768 * 1024 * 1024; const b = Buffer.alloc(requested); for (let i = 0; i < b.length; i += 4096) b[i] = 1; const cg = fs.readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1]; const dir = cg && "/sys/fs/cgroup" + cg; console.log(JSON.stringify({ requested, cgroup: cg, memoryMax: dir && fs.readFileSync(dir + "/memory.max", "utf8").trim(), memoryPeak: dir && fs.readFileSync(dir + "/memory.peak", "utf8").trim() }));\`;
const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.once("exit", (exitCode, signal) => {
  process.stdout.write(JSON.stringify({ childExitCode: exitCode, childSignal: signal, output }) + "\\n");
  process.exitCode = exitCode === 0 ? 0 : 1;
});
`);

    const manager = new VerificationManager(config, {
      containmentWrapper: [
        "systemd-run", "--user", "--scope", "--collect", "--property=MemoryMax=192M", "--",
        "/usr/bin/env", "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS"
      ]
    });
    try {
      const started = await manager.startVerification(workspace, new PathGuard(config), {
        workspace_id: workspace.id,
        runner: "package_script",
        package_manager: "npm",
        script: "test",
        lifetime_ms: 20_000
      });
      assert.deepEqual(started.containmentWrapper, [
        "systemd-run", "--user", "--scope", "--collect", "--property=MemoryMax=192M", "--",
        "/usr/bin/env", "-u", "XDG_RUNTIME_DIR", "-u", "DBUS_SESSION_BUS_ADDRESS"
      ]);

      let result = started;
      const deadline = Date.now() + 25_000;
      while (result.state === "running" && Date.now() < deadline) {
        result = await manager.waitVerification(started.jobId, 1);
      }
      assert.notEqual(result.state, "running", "OOM-limited nested child must settle within the fixture deadline");
      assert.equal(result.state, "succeeded", `a contained allocation should finish truthfully when reclaim/swap permits: ${JSON.stringify({ state: result.state, exitCode: result.exitCode, signal: result.signal, stderr: result.stderr })}`);
      assert.equal(result.exitCode, 0, "managed result must preserve the real successful root exit");
      const reportLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('{"childExitCode"'));
      assert.ok(reportLine, "managed output must retain the fixture's exit report");
      const report = JSON.parse(reportLine);
      const childReport = JSON.parse(report.output.trim());
      assert.equal(report.childExitCode, 0, "nested child exit must be retained accurately");
      assert.ok(Number(childReport.requested) > Number(childReport.memoryMax), "nested child must request more memory than its scope permits");
      assert.ok(Number(childReport.memoryPeak) <= Number(childReport.memoryMax), "nested child cgroup peak must stay under MemoryMax");
      assert.match(childReport.cgroup, /run-.*\.scope$/u, "nested child must inherit its exact managed transient scope");
      console.log("verification-memory-limit-smoke: PASS (nested child requested 768 MiB; its scope peak stayed within 192 MiB and exit was preserved)");
    } finally {
      await manager.close();
    }
  }
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
