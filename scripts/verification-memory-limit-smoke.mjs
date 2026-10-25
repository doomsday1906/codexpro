import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import { VerificationManager } from "../dist/verificationOps.js";

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
    await fs.writeFile(path.join(workspaceRoot, "allocator.mjs"), `
import fs from "node:fs";
fs.writeFileSync("/proc/self/oom_score_adj", "1000");
const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1];
const dir = cgroup && "/sys/fs/cgroup" + cgroup;
const memoryMax = dir && fs.readFileSync(dir + "/memory.max", "utf8").trim();
fs.writeSync(1, JSON.stringify({ cgroup, memoryMax, requested: 1024 ** 3 }) + "\\nCHILD_STARTED\\n");
if (memoryMax !== "536870912") process.exit(2);
const allocation = Buffer.allocUnsafe(1024 ** 3);
for (let i = 0; i < allocation.length; i += 4096) allocation[i] = 1;
`);
    await fs.writeFile(path.join(workspaceRoot, "parent.mjs"), `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, [new URL("./allocator.mjs", import.meta.url).pathname], { stdio: ["ignore", "pipe", "inherit"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
child.once("exit", (exitCode, signal) => {
  const cgroup = fs.readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1];
  const dir = cgroup && "/sys/fs/cgroup" + cgroup;
  const events = Object.fromEntries(fs.readFileSync(dir + "/memory.events.local", "utf8").trim().split(/\\n/).map((line) => line.split(" ")));
  const report = { childExitCode: exitCode, childSignal: signal, cgroup, memoryMax: fs.readFileSync(dir + "/memory.max", "utf8").trim(), memoryPeak: fs.readFileSync(dir + "/memory.peak", "utf8").trim(), oomKills: Number(events.oom_kill) };
  process.stdout.write(JSON.stringify(report) + "\\n");
  process.exitCode = signal === "SIGKILL" && report.oomKills > 0 ? 137 : 1;
});
`);
    const wrapperPath = path.join(workspaceRoot, "memory-oom-wrapper.py");
    await fs.writeFile(wrapperPath, `
import os, subprocess, sys, time
from pathlib import Path
command = sys.argv[1:]
if command[:1] == ["--"]:
    command = command[1:]
parts = [part for part in Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1].split("/") if part]
slice_name = next(part for part in parts if part.startswith("aw-background-memory") and part.endswith(".slice"))
unit = f"codexpro-memory-limit-{os.getpid()}-{time.time_ns()}.scope"
raise SystemExit(subprocess.run([
    "systemd-run", "--user", "--scope", f"--unit={unit}", f"--slice={slice_name}",
    "--property=MemoryMax=512M", "--property=MemorySwapMax=0", "--property=OOMPolicy=continue",
    "--", *command,
], env=os.environ).returncode)
`);

    const manager = new VerificationManager(config, { containmentWrapper: ["/usr/bin/python3", wrapperPath] });
    try {
      const started = await manager.startVerification(workspace, new PathGuard(config), {
        workspace_id: workspace.id,
        runner: "package_script",
        package_manager: "npm",
        script: "test",
        lifetime_ms: 60_000
      });

      let result = started;
      const deadline = Date.now() + 70_000;
      while (result.state === "running" && Date.now() < deadline) {
        result = await manager.waitVerification(started.jobId, 1);
      }
      assert.notEqual(result.state, "running", "OOM-limited nested child must settle within the fixture deadline");
      assert.equal(result.state, "failed", `the contained OOM must fail the owned task: ${JSON.stringify({ state: result.state, exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr })}`);
      assert.equal(result.exitCode, 137, `the task must preserve the conventional SIGKILL exit status: ${JSON.stringify({ exitCode: result.exitCode, signal: result.signal, stdout: result.stdout, stderr: result.stderr })}`);
      const reportLine = result.stdout.split(/\r?\n/u).find((line) => line.startsWith('{"childExitCode"'));
      assert.ok(reportLine, "the parent must retain the nested cgroup result");
      const oom = JSON.parse(reportLine);
      assert.equal(oom.childSignal, "SIGKILL");
      assert.ok(oom.oomKills > 0, `the nested cgroup must record an actual OOM kill: ${JSON.stringify(oom)}`);
      assert.equal(Number(oom.memoryMax), 512 * 1024 ** 2);
      assert.ok(Number(oom.memoryPeak) <= Number(oom.memoryMax));
      assert.match(oom.cgroup, /codexpro-memory-limit-[0-9]+-[0-9]+\.scope$/u);
      assert.match(result.stdout, /"memoryMax":"536870912"/u, "the child must read back its hard cgroup limit");
      assert.match(result.stdout, /CHILD_STARTED/u, "the allocation must start before it is killed");
      console.log(`verification-memory-limit-smoke: PASS (1 GiB nested request OOM-killed in a 512 MiB task cgroup; peak=${oom.memoryPeak})`);

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
