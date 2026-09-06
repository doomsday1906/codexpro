#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-006: Public Stdio MCP Transport Smoke");

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

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-pty-stdio-smoke-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "stdio-fixture" }, null, 2));
await fs.mkdir(path.join(realFixtureRoot, ".git"), { recursive: true });

// Setup interactive CLI script
const promptScriptPath = path.join(realFixtureRoot, "prompt_stdio_cli.mjs");
await fs.writeFile(
  promptScriptPath,
  `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
process.stdout.write("Enter verification token: ");
rl.question("", (answer) => {
  rl.close();
  if (answer.trim() === "ghp_123456789012345678901234567890123456") {
    console.log("Success: stdio prompt accepted!");
    process.exit(0);
  } else {
    console.error("Failure: invalid token " + answer.trim());
    process.exit(1);
  }
});
`
);

async function createStdioClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(repoRoot, "dist", "stdio.js"),
      "--root", realFixtureRoot,
      "--bash", "full",
      "--write", "workspace",
      "--tool-mode", "full"
    ]
  });
  const client = new Client({ name: "stdio-smoke-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, close: () => client.close() };
}

try {
  // Step 1: Prompt/answer round-trip over real stdio transport
  console.log("Step 1: Interactive prompt/answer round-trip over real stdio transport...");
  {
    const { client, close } = await createStdioClient();
    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      assert.ok(!openResult.isError, "open_current_workspace must succeed");
      const wsId = openResult.structuredContent?.workspace_id;
      assert.ok(wsId, "workspace_id must exist");

      const ptyResult = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
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

      assert.ok(!ptyResult.isError, `pty_run over stdio must succeed: ${JSON.stringify(ptyResult)}`);
      assert.equal(ptyResult.structuredContent?.state, "succeeded");
      assert.equal(ptyResult.structuredContent?.exit_code, 0);
      assert.ok(
        ptyResult.structuredContent?.transcript?.includes("Success: stdio prompt accepted!"),
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
    console.log("  ✓ Stdio prompt/answer round-trip & secret redaction verified");
  }

  // Step 2: Controlled SIGTERM shutdown cleans up active PTY descendant processes
  console.log("Step 2: Controlled stdio SIGTERM shutdown cleanly kills PTY processes on host...");
  {
    const { client, transport, close } = await createStdioClient();
    const shutdownSentinel = "STDIO_SHUTDOWN_ACTIVE_CHILD_PTY_CHECK_666";

    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      const wsId = openResult.structuredContent?.workspace_id;

      // Start long-running PTY
      const longRunPromise = client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          argv: ["node", "-e", `console.log("${shutdownSentinel}"); setInterval(() => {}, 1000)`],
          timeout_ms: 30000
        }
      }).catch(() => {});

      // Poll until process is discovered on host
      let activePids = [];
      let attempts = 0;
      while (attempts++ < 30) {
        activePids = findHostProcessesWithToken(shutdownSentinel);
        if (activePids.length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(activePids.length > 0, "Active PTY process must be detected on host before shutdown");
      console.log(`    Discovered active PTY child PID: ${activePids[0].pid}`);

      // Wait for exit promise on stdio process
      const stdioProcess = transport._process;
      assert.ok(stdioProcess?.pid, "Stdio server process must have an active PID");

      const exitPromise = new Promise((resolve) => {
        stdioProcess.on("exit", (code, signal) => resolve({ code, signal }));
      });

      // Send SIGTERM to the stdio process
      console.log(`    Sending SIGTERM to stdio server PID ${stdioProcess.pid}...`);
      stdioProcess.kill("SIGTERM");

      const exitResult = await Promise.race([
        exitPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout waiting for stdio process to exit")), 5000))
      ]);
      console.log(`    Stdio process exited with code ${exitResult.code} (signal ${exitResult.signal})`);

      // Verify zero surviving PTY child processes on host
      await new Promise((r) => setTimeout(r, 500));
      const survivors = findHostProcessesWithToken(shutdownSentinel);
      assert.equal(
        survivors.length,
        0,
        `All child PTY processes must be reaped on stdio shutdown. Survivors: ${JSON.stringify(survivors)}`
      );
      console.log("    Zero surviving PTY child processes on host after stdio shutdown");

      longRunPromise.catch(() => {});
    } finally {
      await close().catch(() => {});
    }
    console.log("  ✓ Controlled stdio SIGTERM shutdown cleanly reaped all PTY processes");
  }

  // Step 3: Fresh process has no continuity / state retention
  console.log("Step 3: Fresh stdio process has no continuity / state retention...");
  {
    const { client, close } = await createStdioClient();
    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      const wsId = openResult.structuredContent?.workspace_id;

      const ptyResult = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          argv: ["node", "-e", "console.log('FRESH_STDIO_CONTINUITY_FREE_OK'); setTimeout(() => {}, 100);"]
        }
      });

      assert.ok(!ptyResult.isError, "Fresh stdio execution must succeed");
      assert.equal(ptyResult.structuredContent?.state, "succeeded");
      assert.ok(
        ptyResult.structuredContent?.transcript?.includes("FRESH_STDIO_CONTINUITY_FREE_OK"),
        "Transcript must contain output from fresh process"
      );
    } finally {
      await close();
    }
    console.log("  ✓ Fresh stdio process continuity freedom verified");
  }

  console.log("\nALL PUBLIC STDIO MCP TESTS PASSED!");
} finally {
  await fs.rm(realFixtureRoot, { recursive: true, force: true }).catch(() => {});
}
