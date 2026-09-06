#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-006: Public HTTP MCP Transport Smoke");

function findHostProcessesWithToken(token) {
  const survivors = [];
  try {
    const entries = fsSync.readdirSync("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const cmdline = fsSync.readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (cmdline.includes(token)) {
          survivors.push({ pid, cmdline: cmdline.replace(/\0/g, " ").trim() });
        }
      } catch {}
    }
  } catch {}
  return survivors;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
    server.on("error", reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout waiting for process exit\n${stderr}`));
    }, timeoutMs);
    timer.unref();
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

// Setup 2 isolated fixture workspaces
const fixtureRootA = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-pty-http-wsA-"));
const realFixtureRootA = await fs.realpath(fixtureRootA);
await fs.writeFile(path.join(realFixtureRootA, "package.json"), JSON.stringify({ name: "http-fixture-a" }, null, 2));
await fs.mkdir(path.join(realFixtureRootA, ".git"), { recursive: true });

const fixtureRootB = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-pty-http-wsB-"));
const realFixtureRootB = await fs.realpath(fixtureRootB);
await fs.writeFile(path.join(realFixtureRootB, "package.json"), JSON.stringify({ name: "http-fixture-b" }, null, 2));
await fs.mkdir(path.join(realFixtureRootB, ".git"), { recursive: true });

// Setup interactive CLI script in Workspace A
const promptScriptPath = path.join(realFixtureRootA, "prompt_http_cli.mjs");
await fs.writeFile(
  promptScriptPath,
  `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
process.stdout.write("Enter verification token: ");
rl.question("", (answer) => {
  rl.close();
  if (answer.trim() === "ghp_123456789012345678901234567890123456") {
    console.log("Success: HTTP prompt verification accepted!");
    process.exit(0);
  } else {
    console.error("Failure: invalid token " + answer.trim());
    process.exit(1);
  }
});
`
);

const strongToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const port = await getFreePort();
const httpUrl = `http://127.0.0.1:${port}/mcp`;

const serverEnv = {
  ...process.env,
  CODEXPRO_ROOT: realFixtureRootA,
  CODEXPRO_ALLOWED_ROOTS: [realFixtureRootA, realFixtureRootB].join(path.delimiter),
  CODEXPRO_HOST: "127.0.0.1",
  CODEXPRO_PORT: String(port),
  CODEXPRO_HTTP_TOKEN: strongToken,
  CODEXPRO_BASH_MODE: "full",
  CODEXPRO_WRITE_MODE: "workspace",
  CODEXPRO_TOOL_MODE: "full"
};

let serverChild = null;

async function createHttpClient() {
  const client = new Client({ name: "http-smoke-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(httpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${strongToken}` } }
  });
  await client.connect(transport);
  return { client, transport, close: () => client.close() };
}

try {
  console.log(`Starting real HTTP server on port ${port}...`);
  serverChild = spawn("node", ["dist/http.js"], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForListening(serverChild);
  console.log("  ✓ HTTP server listening");

  // Step 1: Client A prompt/response round-trip + sent sentinel leak prevention
  console.log("Step 1: Session A prompt/answer round-trip over HTTP...");
  let wsIdA;
  let wsIdB;
  {
    const { client, close } = await createHttpClient();
    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      assert.ok(!openResult.isError, "open_current_workspace must succeed");
      wsIdA = openResult.structuredContent?.workspace_id;
      assert.ok(wsIdA, "Workspace A ID must exist");

      const ptyResult = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdA,
          argv: ["node", promptScriptPath],
          steps: [
            {
              wait_for: "Enter verification token: ",
              send: "ghp_123456789012345678901234567890123456",
              submit: true
            }
          ]
        }
      });

      assert.ok(!ptyResult.isError, `pty_run over HTTP must succeed: ${JSON.stringify(ptyResult)}`);
      assert.equal(ptyResult.structuredContent?.state, "succeeded");
      assert.equal(ptyResult.structuredContent?.exit_code, 0);
      assert.ok(
        ptyResult.structuredContent?.transcript?.includes("Success: HTTP prompt verification accepted!"),
        "Transcript must contain success output"
      );

      // Verify raw secret was redacted and replaced with [REDACTED_SECRET]
      assert.ok(
        !ptyResult.structuredContent?.transcript?.includes("ghp_123456789012345678901234567890123456"),
        "Sent raw secret token must not leak in transcript"
      );
      assert.ok(
        ptyResult.structuredContent?.transcript?.includes("[REDACTED_SECRET]"),
        "Transcript must contain [REDACTED_SECRET] redaction marker"
      );
    } finally {
      await close();
    }
    console.log("  ✓ Session A prompt/answer round-trip & sentinel protection verified");
  }

  // Step 2: Session B proves no attach/run IDs and session isolation
  console.log("Step 2: Session B proves no attach/run IDs exist and cross-session isolation...");
  {
    const { client, close } = await createHttpClient();
    try {
      const listResult = await client.listTools();
      const toolNames = listResult.tools.map((t) => t.name);

      assert.ok(toolNames.includes("pty_run"), "Session B sees pty_run");
      const forbiddenNames = ["pty_start", "pty_wait", "pty_cancel", "pty_attach", "pty_resume", "pty_status"];
      for (const fn of forbiddenNames) {
        assert.ok(!toolNames.includes(fn), `Tool catalog must never contain ${fn}`);
      }

      // Open Workspace B in Session B
      const openB = await client.callTool({ name: "open_workspace", arguments: { path: realFixtureRootB } });
      assert.ok(!openB.isError);
      wsIdB = openB.structuredContent?.workspace_id;
      assert.ok(wsIdB && wsIdB !== wsIdA, "Workspace B ID must be distinct from Workspace A");
    } finally {
      await close();
    }
    console.log("  ✓ Session B isolation and absence of attach tools verified");
  }

  // Step 3: Process-shared capacity (maxActive = 2 across sessions)
  console.log("Step 3: Process-shared capacity limit (maxActive=2 across HTTP sessions)...");
  {
    const clientA = await createHttpClient();
    const clientB = await createHttpClient();
    const clientC = await createHttpClient();

    const sentinelA = "HTTP_CAPACITY_RUN_A_TOKEN_888";
    const sentinelB = "HTTP_CAPACITY_RUN_B_TOKEN_999";

    try {
      // Launch run 1 from Session A asynchronously (runs for 800ms)
      const runAPromise = clientA.client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdA,
          argv: ["node", "-e", `console.log("${sentinelA}"); setTimeout(() => {}, 800)`],
          timeout_ms: 10000
        }
      });

      // Launch run 2 from Session B asynchronously (runs for 800ms)
      const runBPromise = clientB.client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdB,
          argv: ["node", "-e", `console.log("${sentinelB}"); setTimeout(() => {}, 800)`],
          timeout_ms: 10000
        }
      });

      // Wait for both to spawn on host
      let attempts = 0;
      while (attempts++ < 30) {
        const foundA = findHostProcessesWithToken(sentinelA);
        const foundB = findHostProcessesWithToken(sentinelB);
        if (foundA.length > 0 && foundB.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Now attempt run 3 from Session C
      const sentinelC = "HTTP_CAPACITY_RUN_C_TOKEN_OVERFLOW";
      const runCResult = await clientC.client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdA,
          argv: ["node", "-e", `console.log("${sentinelC}")`]
        }
      });

      assert.ok(runCResult.isError, "Run C must be rejected when capacity is reached");
      const errText = runCResult.content?.find((c) => c.type === "text")?.text ?? "";
      assert.ok(
        errText.includes("maximum 2 active PTY runs") || errText.includes("concurrency limit reached"),
        `Error must specify concurrency limit reached: ${errText}`
      );

      // Verify 0 child processes spawned for Run C
      const survivorsC = findHostProcessesWithToken(sentinelC);
      assert.equal(survivorsC.length, 0, "No child processes may spawn for rejected run C");

      // Wait for runs A and B to finish so activeCount drops back to 0
      await Promise.all([runAPromise, runBPromise]);
      await Promise.allSettled([clientA.close(), clientB.close(), clientC.close()]);
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
      await clientC.close().catch(() => {});
    }
    console.log("  ✓ Process-shared capacity limit verified across sessions");
  }

  // Step 4: Workspace retarget resistance
  console.log("Step 4: Workspace retarget resistance across concurrent HTTP sessions...");
  {
    const clientA = await createHttpClient();
    const clientB = await createHttpClient();

    try {
      const [resA, resB] = await Promise.all([
        clientA.client.callTool({
          name: "pty_run",
          arguments: {
            workspace_id: wsIdA,
            argv: ["node", "-e", "console.log('CWD:' + process.cwd()); setTimeout(() => {}, 100);"]
          }
        }),
        clientB.client.callTool({
          name: "pty_run",
          arguments: {
            workspace_id: wsIdB,
            argv: ["node", "-e", "console.log('CWD:' + process.cwd()); setTimeout(() => {}, 100);"]
          }
        })
      ]);

      if (resA.isError) console.error("resA error:", JSON.stringify(resA));
      if (resB.isError) console.error("resB error:", JSON.stringify(resB));
      assert.ok(!resA.isError, "Call A must succeed");
      assert.ok(!resB.isError, "Call B must succeed");

      assert.ok(
        resA.structuredContent?.transcript?.includes(realFixtureRootA),
        `Session A must run in Workspace A root: ${resA.structuredContent?.transcript}`
      );
      assert.ok(
        resB.structuredContent?.transcript?.includes(realFixtureRootB),
        `Session B must run in Workspace B root: ${resB.structuredContent?.transcript}`
      );
    } finally {
      await clientA.close();
      await clientB.close();
    }
    console.log("  ✓ Workspace retarget resistance verified");
  }

  // Step 5: Controlled HTTP shutdown with active PTY
  console.log("Step 5: Controlled HTTP server shutdown with active PTY reaps all child processes...");
  {
    const { client, close } = await createHttpClient();
    const shutdownSentinel = "HTTP_SHUTDOWN_ACTIVE_CHILD_PTY_CHECK_777";
    try {
      // Launch active PTY run
      const longRunPromise = client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdA,
          argv: ["node", "-e", `console.log("${shutdownSentinel}"); setInterval(() => {}, 1000)`],
          timeout_ms: 30000
        }
      });

      // Wait until child is running on host
      let activePids = [];
      let attempts = 0;
      while (attempts++ < 30) {
        activePids = findHostProcessesWithToken(shutdownSentinel);
        if (activePids.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(activePids.length > 0, "Active PTY process must be detected on host before shutdown");
      console.log(`    Discovered active PTY child PID: ${activePids[0].pid}`);

      // Now initiate controlled server shutdown via SIGTERM to HTTP server
      console.log("    Sending SIGTERM to HTTP server process...");
      serverChild.kill("SIGTERM");
      await waitForExit(serverChild);
      serverChild = null;

      // Assert that all child PTY processes are completely reaped
      await new Promise((r) => setTimeout(r, 500));
      const survivors = findHostProcessesWithToken(shutdownSentinel);
      assert.equal(survivors.length, 0, `All PTY processes must be reaped on HTTP shutdown. Survivors: ${JSON.stringify(survivors)}`);
      console.log("    Zero surviving PTY child processes on host after HTTP shutdown");

      longRunPromise.catch(() => {});
    } finally {
      await close().catch(() => {});
    }
    console.log("  ✓ Controlled HTTP shutdown cleanly reaped all active PTY processes");
  }

  console.log("\nALL PUBLIC HTTP MCP TESTS PASSED!");
} finally {
  if (serverChild && serverChild.exitCode === null && serverChild.signalCode === null) {
    serverChild.kill("SIGKILL");
    await waitForExit(serverChild).catch(() => {});
  }
  await Promise.allSettled([
    fs.rm(realFixtureRootA, { recursive: true, force: true }),
    fs.rm(realFixtureRootB, { recursive: true, force: true })
  ]);
}
