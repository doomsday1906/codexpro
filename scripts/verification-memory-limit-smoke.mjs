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
      scripts: { test: "node parent.mjs", governed: "node governed.mjs" }
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
        "/usr/bin/python3", path.join(repoRoot, "scripts", "verification-governed-runner.py"),
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

      const probe = `import fs from "node:fs"; const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1]; const parts = cgroup?.split("/").filter(Boolean) ?? []; const slice = parts.find((part) => /^aw-background-memory[0-9a-f]{32}\\.slice$/.test(part)); const slicePath = slice && "/sys/fs/cgroup/" + parts.slice(0, parts.indexOf(slice) + 1).join("/"); console.log(JSON.stringify({ cgroup, slice, memoryMax: slicePath && fs.readFileSync(slicePath + "/memory.max", "utf8").trim(), memoryMin: slicePath && fs.readFileSync(slicePath + "/memory.min", "utf8").trim(), memoryLow: slicePath && fs.readFileSync(slicePath + "/memory.low", "utf8").trim() }));`;
      await fs.writeFile(path.join(workspaceRoot, "governed.mjs"), `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", ${JSON.stringify(probe)}], { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.once("exit", (code) => {
  if (code !== 0) process.exitCode = code ?? 1;
  else {
    const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1];
    const parts = cgroup?.split("/").filter(Boolean) ?? [];
    const slice = parts.find((part) => /^aw-background-memory[0-9a-f]{32}\\.slice$/.test(part));
    const slicePath = slice && "/sys/fs/cgroup/" + parts.slice(0, parts.indexOf(slice) + 1).join("/");
    const scopePath = cgroup && "/sys/fs/cgroup" + cgroup;
    console.log(JSON.stringify({ parent: { cgroup, memoryMax: slicePath && fs.readFileSync(slicePath + "/memory.max", "utf8").trim(), memoryMin: slicePath && fs.readFileSync(slicePath + "/memory.min", "utf8").trim(), memoryLow: slicePath && fs.readFileSync(slicePath + "/memory.low", "utf8").trim(), memoryPeak: scopePath && fs.readFileSync(scopePath + "/memory.peak", "utf8").trim() }, child: JSON.parse(output.trim()) }));
  }
});
`);
      const governedManager = new VerificationManager(config);
      try {
        const governedStart = await governedManager.startVerification(workspace, new PathGuard(config), {
          workspace_id: workspace.id,
          runner: "package_script",
          package_manager: "npm",
          script: "governed",
          lifetime_ms: 30_000
        });
        let governedResult = governedStart;
        const governedDeadline = Date.now() + 35_000;
        while (governedResult.state === "running" && Date.now() < governedDeadline) {
          governedResult = await governedManager.waitVerification(governedStart.jobId, 1);
        }
        assert.equal(governedResult.state, "succeeded", `shared governor route must succeed: ${JSON.stringify({ state: governedResult.state, exitCode: governedResult.exitCode, stderr: governedResult.stderr })}`);
        assert.equal(governedResult.exitCode, 0, "shared governor route must preserve the command exit status");
        const routeLine = governedResult.stdout.split(/\r?\n/u).find((line) => line.startsWith('{"parent"'));
        assert.ok(routeLine, "default governed verification must preserve its command output on stdout");
        const route = JSON.parse(routeLine);
        const parent = route.parent;
        const child = route.child;
        assert.equal(parent.cgroup, child.cgroup, "parent and nested child must stay in the same exact task scope");
        assert.match(parent.cgroup, /aw-background-memory[0-9a-f]{32}\.slice\/codexpro-verify-[0-9a-f]{32}\.scope$/u);
        const memoryMax = Number(parent.memoryMax);
        const memoryPeak = Number(parent.memoryPeak);
        assert.ok(memoryMax > 0 && memoryMax <= 2 * 1024 ** 3,
          `the current safe_test default profile must cap the owned task subtree at or below 2 GiB; got ${parent.memoryMax}`);
        assert.ok(memoryPeak > 0 && memoryPeak <= memoryMax, `measured job peak ${memoryPeak} must stay within ${memoryMax}`);
        assert.equal(child.memoryMax, parent.memoryMax, "nested child must observe the same admitted hard limit");
        assert.equal(parent.memoryMin, "0", "governor must not reserve RAM through MemoryMin");
        assert.equal(parent.memoryLow, "0", "governor must not reserve RAM through MemoryLow");
        console.log(`verification-governor smoke: PASS (owned scope MemoryMax=${memoryMax}; observed peak=${memoryPeak}; stdout and exit 0 preserved)`);
      } finally {
        await governedManager.close();
      }
    } finally {
      await manager.close();
    }
  }
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
