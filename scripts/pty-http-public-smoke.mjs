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
const repoRoot = path.resolve(process.env.CODEXPRO_TEST_PACKAGE_ROOT ?? path.resolve(__dirname, ".."));

console.log("# RepoConnect M010 TASK-006: Public HTTP MCP Transport Smoke");

function syncStdoutWriteCode(expression) {
  return `const fs=require("node:fs");const output=Buffer.from(${expression});let written=0;while(written<output.length){const count=fs.writeSync(1,output,written,output.length-written);if(count<=0)throw new Error("stdout write made no progress");written+=count}`;
}

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

async function waitForListening(child, port) {
  const deadline = Date.now() + 15_000;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`CodexPro exited before HTTP health was ready: ${child.exitCode ?? child.signalCode}\n${stderr}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* startup is still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for HTTP server health\n${stderr}`);
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
const isolatedCodexProHome = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-pty-http-home-"));

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
  CODEXPRO_MAX_OUTPUT_BYTES: "120000",
  CODEXPRO_BASH_MODE: "full",
  CODEXPRO_WRITE_MODE: "workspace",
  CODEXPRO_TOOL_MODE: "full"
};
if (process.env.CODEXPRO_TEST_LAUNCHER) serverEnv.CODEXPRO_HOME = isolatedCodexProHome;

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
  const launchArgs = process.env.CODEXPRO_TEST_LAUNCHER
    ? [process.env.CODEXPRO_TEST_LAUNCHER, "start", "--root", realFixtureRootA, "--allow-root", realFixtureRootB, "--tunnel", "none", "--port", String(port), "--headless", "--no-profile", "--no-auth", "--tool-mode", "full", "--bash", "full", "--write", "workspace"]
    : [path.join(repoRoot, "dist/http.js")];
  serverChild = spawn(process.execPath, launchArgs, {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForListening(serverChild, port);
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
          argv: [process.execPath, promptScriptPath],
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

      const missionControlValue = { mission_control: { response: "x".repeat(13_500) } };
      const missionControlPayload = JSON.stringify(missionControlValue);
      const missionControlCode = syncStdoutWriteCode(`JSON.stringify({mission_control:{response:"x".repeat(13500)}})+"\\n"`);
      const longJsonResult = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdA,
          argv: [process.execPath, "-e", missionControlCode]
        }
      });
      assert.ok(!longJsonResult.isError, `long JSON pty_run over HTTP must succeed: ${JSON.stringify(longJsonResult)}`);
      assert.equal(longJsonResult.structuredContent?.state, "succeeded");
      assert.equal(longJsonResult.structuredContent?.truncated, false);
      const longJsonTranscript = longJsonResult.structuredContent?.transcript ?? "";
      const expectedLongJsonTranscript = `${missionControlPayload}\n`;
      assert.equal(longJsonTranscript.length, expectedLongJsonTranscript.length, `long JSON output length mismatch: raw=${longJsonResult.structuredContent?.raw_observed_bytes}, actual=${longJsonTranscript.length}, expected=${expectedLongJsonTranscript.length}, suffix=${JSON.stringify(longJsonTranscript.slice(-40))}`);
      assert.equal(longJsonTranscript, expectedLongJsonTranscript, "long JSON output must survive intact");
      assert.doesNotMatch(longJsonResult.structuredContent?.transcript ?? "", /\[REDACTED_SECRET\]/);

      const runtimeStatus = await client.callTool({ name: "runtime_status", arguments: {} });
      assert.notEqual(runtimeStatus.isError, true);
      assert.equal(runtimeStatus.structuredContent?.build_identity?.package_version, "0.31.0");
      assert.equal(await fs.realpath(runtimeStatus.structuredContent?.build_identity?.package_root), await fs.realpath(repoRoot));
      if (process.env.CODEXPRO_EXPECTED_SOURCE_COMMIT) {
        assert.equal(runtimeStatus.structuredContent?.build_identity?.source_commit, process.env.CODEXPRO_EXPECTED_SOURCE_COMMIT);
        assert.equal(runtimeStatus.structuredContent?.build_identity?.source_state, "clean");
        assert.equal(runtimeStatus.structuredContent?.build_identity?.identity_status, "exact");
      } else {
        assert.match(runtimeStatus.structuredContent?.build_identity?.source_commit ?? "", /^[0-9a-f]{40}$/u);
        assert.equal(runtimeStatus.structuredContent?.build_identity?.identity_status, "bounded");
      }

      const lineCases = [
        { text: "s".repeat(3_000), label: "below the former boundary" },
        { text: "x".repeat(5_000), label: "above the former boundary" },
        { text: "b".repeat(5_000), label: "repeated benign character line" },
        { text: "L".repeat(100_000), label: "large within-budget line" }
      ];
      for (const { text, label } of lineCases) {
        const result = await client.callTool({
          name: "pty_run",
          arguments: { workspace_id: wsIdA, argv: [process.execPath, "-e", syncStdoutWriteCode(`${JSON.stringify(text[0])}.repeat(${text.length})+"\\n"`)] }
        });
        assert.equal(result.structuredContent?.state, "succeeded", `${label} must complete`);
        assert.equal(result.structuredContent?.truncated, false, `${label} must not be truncated`);
        assert.equal(result.structuredContent?.transcript?.length, text.length + 1, `${label} must preserve the full transcript length`);
        assert.equal(result.structuredContent?.transcript, `${text}\n`, `${label} must be returned intact`);
        assert.doesNotMatch(result.structuredContent?.transcript ?? "", /\[REDACTED_SECRET\]/);
      }

      const multiline = Array.from({ length: 135 }, () => "m".repeat(100)).join("\n") + "\n";
      const multilineCode = `const fs=require("node:fs");let written=0;for(let line=0;line<135;line++){const output=Buffer.from("m".repeat(100)+"\\n");let offset=0;while(offset<output.length){const count=fs.writeSync(1,output,offset,output.length-offset);if(count<=0)throw new Error("stdout write made no progress");offset+=count;written+=count}}fs.writeSync(2,Buffer.from("END:"+written+"\\n"))`;
      const multilineWithCompletion = `${multiline}END:${Buffer.byteLength(multiline)}\n`;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const multilineResult = await client.callTool({
          name: "pty_run",
          arguments: { workspace_id: wsIdA, argv: [process.execPath, "-e", multilineCode] }
        });
        assert.equal(multilineResult.structuredContent?.state, "succeeded", `multiline producer must exit normally: ${JSON.stringify(multilineResult.structuredContent)}`);
        assert.equal(multilineResult.structuredContent?.exit_code, 0, `multiline producer must exit 0: ${JSON.stringify(multilineResult.structuredContent)}`);
        assert.equal(multilineResult.structuredContent?.truncated, false, `multiline output attempt ${attempt + 1} must not be truncated: ${JSON.stringify(multilineResult.structuredContent)}`);
        assert.equal(multilineResult.structuredContent?.output_drain_incomplete, undefined, `multiline output attempt ${attempt + 1} must report a complete drain: ${JSON.stringify(multilineResult.structuredContent)}`);
        assert.equal(multilineResult.structuredContent?.raw_observed_bytes, Buffer.byteLength(multilineWithCompletion) + 136, `multiline output attempt ${attempt + 1} must observe every emitted byte including PTY newline expansion; actual=${multilineResult.structuredContent?.raw_observed_bytes}, text=${multilineResult.structuredContent?.transcript?.length}, suffix=${JSON.stringify(multilineResult.structuredContent?.transcript?.slice(-40))}`);
        assert.equal(multilineResult.structuredContent?.transcript?.length, multilineWithCompletion.length, `multiline output attempt ${attempt + 1} must preserve the full length`);
        assert.equal(multilineResult.structuredContent?.transcript, multilineWithCompletion, `multiline output attempt ${attempt + 1} must survive intact`);
      }

      const splitCredential = "API_TOKEN=chunk-cross-credential-value-9384756102";
      const splitCredentialCode = `const fs=require("node:fs");fs.writeSync(1,${JSON.stringify(splitCredential.slice(0, 13))});setTimeout(()=>{fs.writeSync(1,${JSON.stringify(splitCredential.slice(13) + "\\n")})},100)`;
      const splitCredentialResult = await client.callTool({
        name: "pty_run",
        arguments: { workspace_id: wsIdA, argv: [process.execPath, "-e", splitCredentialCode] }
      });
      assert.doesNotMatch(splitCredentialResult.structuredContent?.transcript ?? "", /chunk-cross-credential-value-9384756102/);
      assert.match(splitCredentialResult.structuredContent?.transcript ?? "", /\[REDACTED_SECRET\]/);

      const overBudgetResult = await client.callTool({
        name: "pty_run",
        arguments: { workspace_id: wsIdA, argv: [process.execPath, "-e", syncStdoutWriteCode(`"z".repeat(125000)+"\\n"`)] }
      });
      assert.equal(overBudgetResult.structuredContent?.truncated, true);
      assert.match(overBudgetResult.structuredContent?.transcript ?? "", /\[OUTPUT_SUPPRESSED: line exceeds configured retention limit\]/);
      assert.doesNotMatch(overBudgetResult.structuredContent?.transcript ?? "", /\[REDACTED_SECRET\]/);
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
          argv: [process.execPath, "-e", `console.log("${sentinelA}"); setTimeout(() => {}, 800)`],
          timeout_ms: 10000
        }
      });

      // Launch run 2 from Session B asynchronously (runs for 800ms)
      const runBPromise = clientB.client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsIdB,
          argv: [process.execPath, "-e", `console.log("${sentinelB}"); setTimeout(() => {}, 800)`],
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
          argv: [process.execPath, "-e", `console.log("${sentinelC}")`]
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
            argv: [process.execPath, "-e", "console.log('CWD:' + process.cwd()); setTimeout(() => {}, 100);"]
          }
        }),
        clientB.client.callTool({
          name: "pty_run",
          arguments: {
            workspace_id: wsIdB,
            argv: [process.execPath, "-e", "console.log('CWD:' + process.cwd()); setTimeout(() => {}, 100);"]
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
          argv: [process.execPath, "-e", `console.log("${shutdownSentinel}"); setInterval(() => {}, 1000)`],
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
    fs.rm(realFixtureRootB, { recursive: true, force: true }),
    fs.rm(isolatedCodexProHome, { recursive: true, force: true })
  ]);
}
