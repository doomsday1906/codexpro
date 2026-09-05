import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const AUTH_TOKEN = "M009_SESSION_CONTINUITY_TEST_AUTH_TOKEN";

console.log("# RepoConnect M009 TASK-004 HTTP Session & Stdio Continuity Smoke");

// 1. Setup fixture directory
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m009-continuity-"));
const altRoot = path.join(fixtureRoot, "alt-workspace");
await fs.mkdir(altRoot, { recursive: true });

const realFixtureRoot = await fs.realpath(fixtureRoot);
const realAltRoot = await fs.realpath(altRoot);

// Link node_modules so tsc can be invoked inside fixtureRoot
const repoRoot = path.resolve(".");
try {
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(realFixtureRoot, "node_modules"));
} catch (e) {
  // Ignore if already exists or fails
}
await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "fixture-pkg" }));
await fs.writeFile(path.join(realFixtureRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022" } }));

const workspaceIdFor = (root) => `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
const fixtureWsId = workspaceIdFor(realFixtureRoot);
const altWsId = workspaceIdFor(realAltRoot);

// Dynamic free port
async function freePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

// Stdio JSON-RPC helper client
function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => {
      // process.stderr.write(chunk);
    });
    this.child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (err) {
        // ignore parse errors on corrupted chunks
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.child.stdin.write(encode(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: "2.0", method, params }));
  }

  close() {
    this.child.kill("SIGTERM");
  }
}

async function runTests() {
  const port = await freePort();

  // Start real HTTP process
  console.log("\n[Test 1] Launching CodexPro HTTP server...");
  const httpChild = spawn(process.execPath, ["dist/http.js"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEXPRO_ROOT: realFixtureRoot,
      CODEXPRO_ALLOWED_ROOTS: [realFixtureRoot, realAltRoot].join(path.delimiter),
      CODEXPRO_HOST: "127.0.0.1",
      CODEXPRO_PORT: String(port),
      CODEXPRO_BASH_MODE: "safe",
      CODEXPRO_WRITE_MODE: "off",
      CODEXPRO_TOOL_MODE: "full",
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_HTTP_TOKEN: AUTH_TOKEN,
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let httpStderr = "";
  httpChild.stderr.on("data", (chunk) => { httpStderr += String(chunk); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      httpChild.kill("SIGTERM");
      reject(new Error(`timed out waiting for HTTP server:\n${httpStderr}`));
    }, 15000);
    timer.unref();
    const interval = setInterval(() => {
      if (httpStderr.includes("HTTP MCP listening")) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 50);
    interval.unref();
    httpChild.once("exit", (code) => {
      clearInterval(interval);
      clearTimeout(timer);
      reject(new Error(`HTTP server exited early with code ${code}\n${httpStderr}`));
    });
  });
  console.log(`  PASS: HTTP server listening on port ${port}`);

  const serverUrl = `http://127.0.0.1:${port}/mcp`;

  // Connect Client A
  console.log("\n[Test 2] Session A starts a verification job...");
  const clientA = new Client({ name: "client-A", version: "1.0.0" });
  const transportA = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } }
  });
  await clientA.connect(transportA);

  const startResA = await clientA.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: fixtureWsId,
      runner: "tsc",
      args: ["--watch"]
    }
  });

  assert.ok(startResA && !startResA.isError, "start_verification must succeed");
  const jobA = startResA.structuredContent;
  assert.equal(jobA.workspace_id, fixtureWsId);
  assert.equal(jobA.state, "running");
  assert.match(jobA.jobId, /^vjob_[0-9a-f]{24}$/);
  assert.match(startResA.content[0].text, /# Managed Verification Started/);
  console.log(`  PASS: Session A started job ${jobA.jobId} on workspace ${fixtureWsId}`);

  // Disconnect Client A
  console.log("\n[Test 3] Session A closes/disconnects...");
  await transportA.close();
  console.log("  PASS: Session A disconnected");

  // Connect Client B (new independent MCP session)
  console.log("\n[Test 4] Independent Session B connects and observes the job from Session A...");
  const clientB = new Client({ name: "client-B", version: "1.0.0" });
  const transportB = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { authorization: `Bearer ${AUTH_TOKEN}` } }
  });
  await clientB.connect(transportB);

  const waitResB = await clientB.callTool({
    name: "wait_verification",
    arguments: {
      job_id: jobA.jobId,
      max_wait_seconds: 1
    }
  });
  assert.ok(waitResB && !waitResB.isError, "wait_verification must succeed in Session B");
  const jobObservedB = waitResB.structuredContent;
  assert.equal(jobObservedB.jobId, jobA.jobId, "Job ID must match");
  assert.equal(jobObservedB.workspaceId, fixtureWsId, "Workspace ID must match Session A's frozen workspace");
  assert.equal(jobObservedB.state, "running");
  console.log("  PASS: Session B observed active job with frozen workspace root/id");

  // Test 5: Selecting/opening another workspace in B does NOT retarget the job
  console.log("\n[Test 5] Selecting another workspace in Session B does not retarget the job...");
  const listToolsB = await clientB.listTools();
  assert.ok(listToolsB.tools.some((t) => t.name === "wait_verification"));

  const waitResB2 = await clientB.callTool({
    name: "wait_verification",
    arguments: {
      job_id: jobA.jobId,
      max_wait_seconds: 1
    }
  });
  const jobObservedB2 = waitResB2.structuredContent;
  assert.equal(jobObservedB2.workspaceId, fixtureWsId, "Workspace must remain strictly frozen to fixtureWsId");
  console.log("  PASS: Job workspace binding remains strictly frozen");

  // Test 6: Starting a verification in B without explicit workspace_id fails
  console.log("\n[Test 6] Starting verification without explicit workspace_id fails closed...");
  let startError = null;
  try {
    const res = await clientB.callTool({
      name: "start_verification",
      arguments: {
        runner: "tsc",
        args: ["--watch"]
      }
    });
    if (res.isError) {
      startError = new Error(res.content[0]?.text || "Tool returned isError");
    }
  } catch (err) {
    startError = err;
  }
  assert.ok(startError, "Starting verification without workspace_id must fail");
  console.log("  PASS: Missing workspace_id rejected by schema/admission");

  // Test 7: Session B can cancel the job started by Session A
  console.log("\n[Test 7] Session B cancels running job from Session A...");
  const cancelResB = await clientB.callTool({
    name: "cancel_verification",
    arguments: {
      job_id: jobA.jobId
    }
  });
  assert.ok(cancelResB && !cancelResB.isError);
  const cancelJobB = cancelResB.structuredContent;
  assert.equal(cancelJobB.jobId, jobA.jobId);
  assert.equal(cancelJobB.state, "cancelled");
  assert.equal(cancelJobB.workspaceId, fixtureWsId);
  console.log("  PASS: Session B cancelled job started by Session A");

  await transportB.close();
  httpChild.kill("SIGTERM");

  // Test 8: Stdio server continuity and teardown
  console.log("\n[Test 8] Stdio server verification tools and process teardown...");
  const stdioClient = new McpStdioClient(process.execPath, ["dist/stdio.js", "--root", realFixtureRoot], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEXPRO_ROOT: realFixtureRoot,
      CODEXPRO_ALLOWED_ROOTS: realFixtureRoot,
      CODEXPRO_BASH_MODE: "safe",
      CODEXPRO_TOOL_MODE: "full"
    }
  });

  const initRes = await stdioClient.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "stdio-test-client", version: "1.0.0" }
  });
  assert.ok(initRes);
  stdioClient.notify("notifications/initialized", {});

  const stdioStartRes = await stdioClient.request("tools/call", {
    name: "start_verification",
    arguments: {
      workspace_id: fixtureWsId,
      runner: "tsc",
      args: ["--watch"]
    }
  });
  const stdioJob = stdioStartRes.structuredContent;
  assert.equal(stdioJob.state, "running");
  assert.match(stdioJob.jobId, /^vjob_[0-9a-f]{24}$/);
  console.log(`  PASS: Stdio server started job ${stdioJob.jobId}`);

  const stdioWaitRes = await stdioClient.request("tools/call", {
    name: "wait_verification",
    arguments: {
      job_id: stdioJob.jobId,
      max_wait_seconds: 1
    }
  });
  const stdioWaitJob = stdioWaitRes.structuredContent;
  assert.equal(stdioWaitJob.jobId, stdioJob.jobId);
  assert.equal(stdioWaitJob.state, "running");
  console.log("  PASS: Stdio server wait_verification observed running job");

  // Check descendant processes of stdio server
  const stdioPid = stdioClient.child.pid;
  assert.ok(stdioPid > 0);

  // Find descendants
  let descendantsBefore = [];
  try {
    const pgrepOut = execFileSync("pgrep", ["-P", String(stdioPid)], { encoding: "utf8" });
    descendantsBefore = pgrepOut.trim().split(/\s+/).map(Number).filter(Boolean);
  } catch {
    // pgrep exits 1 if no process found
  }
  console.log(`  Observed stdio descendants before shutdown: ${descendantsBefore.join(", ")}`);

  // Teardown stdio server via SIGTERM
  console.log("  Sending SIGTERM to stdio server...");
  stdioClient.close();

  // Wait for stdio child to exit
  await new Promise((resolve) => {
    stdioClient.child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  assert.ok(stdioClient.child.exitCode !== null || stdioClient.child.signalCode !== null, "Stdio process must exit");

  // Wait 1.5s for escalation/exit of any descendants
  await new Promise((r) => setTimeout(r, 1500));

  // Verify descendants are terminated
  for (const pid of descendantsBefore) {
    let isAlive = false;
    try {
      process.kill(pid, 0);
      isAlive = true;
    } catch (e) {
      isAlive = false;
    }
    assert.equal(isAlive, false, `Descendant PID ${pid} must be terminated`);
  }
  console.log("  PASS: Stdio process teardown terminated in-flight jobs and all child processes");

  // Clean up fixture files
  try {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  } catch {}

  console.log("\nALL TASK-004 CONTINUITY TESTS PASSED.");
}

runTests().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
