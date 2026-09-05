import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../dist/config.js";
import { PathGuard } from "../dist/guard.js";
import { createCodexProServer } from "../dist/server.js";
import { VerificationManager } from "../dist/verificationOps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M009 TASK-006 Security Envelope & Redaction Smoke");

// Create temporary fixture workspace
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m009-sec-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);
const realWsId = `ws_${createHash("sha256").update(realFixtureRoot).digest("hex").slice(0, 24)}`;

// Link node_modules into fixtureRoot
try {
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(realFixtureRoot, "node_modules"));
} catch {}

// Write package.json with secret-leaking test script
const secretScript = "console.log('API_KEY=sk-abc1234567890123456789012345678901234567890'); console.error('GH_TOKEN=ghp_1234567890abcdef1234567890abcdef1234');";
await fs.writeFile(
  path.join(realFixtureRoot, "package.json"),
  JSON.stringify({
    name: "sec-fixture",
    scripts: {
      "leak-secret": `node -e "${secretScript}"`,
      "quick": "node -e 'process.exit(0);'"
    }
  }, null, 2)
);

async function createClientServer(configOverrides = {}) {
  const config = {
    ...loadConfig(["--root", realFixtureRoot, "--allow-root", realFixtureRoot]),
    ...configOverrides
  };
  const verificationManager = new VerificationManager(config);
  const server = createCodexProServer(config, { verificationManager });
  const client = new Client({ name: "sec-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server, verificationManager, config };
}

async function runTests() {
  // Test 1: Tools list with bashMode=safe
  console.log("\n[Test 1] Verification tools present in tools/list when bashMode=safe...");
  const { client: clientSafe } = await createClientServer({ bashMode: "safe", toolMode: "full" });
  const listResSafe = await clientSafe.listTools();
  const toolNames = listResSafe.tools.map((t) => t.name);

  assert.ok(toolNames.includes("start_verification"), "start_verification must be listed");
  assert.ok(toolNames.includes("wait_verification"), "wait_verification must be listed");
  assert.ok(toolNames.includes("cancel_verification"), "cancel_verification must be listed");
  console.log("  PASS: All 3 verification tools listed under bashMode=safe");

  // Test 2: Input schemas match frozen contract exactly
  console.log("\n[Test 2] Input schema adherence to frozen contracts...");
  const startTool = listResSafe.tools.find((t) => t.name === "start_verification");
  const waitTool = listResSafe.tools.find((t) => t.name === "wait_verification");
  const cancelTool = listResSafe.tools.find((t) => t.name === "cancel_verification");

  // start_verification schema
  const startSchema = startTool.inputSchema;
  assert.deepEqual(startSchema.required, ["workspace_id", "runner"]);
  assert.equal(startSchema.properties.workspace_id.pattern, "^ws_[0-9a-f]{24}$");
  assert.deepEqual(startSchema.properties.runner.enum, [
    "package_script",
    "pytest",
    "go_test",
    "cargo",
    "tsc",
    "eslint",
    "biome_check"
  ]);
  assert.deepEqual(startSchema.properties.package_manager.enum, ["npm", "pnpm", "yarn", "bun"]);
  // session_id field in start_verification schema
  assert.equal(startSchema.properties.session_id.type, "string");
  assert.equal(startSchema.properties.session_id.maxLength, 64);
  // Strict non-existence of arbitrary command or caller wrapper override
  assert.equal(startSchema.properties.command, undefined, "Strictly NO raw command field");
  assert.equal(startSchema.properties.cmd, undefined, "Strictly NO cmd field");
  assert.equal(startSchema.properties.sh, undefined, "Strictly NO sh field");
  assert.equal(startSchema.properties.containment_wrapper, undefined, "Strictly NO caller wrapper field");
  assert.equal(startSchema.properties.wrapper, undefined, "Strictly NO wrapper field");
  console.log("  PASS: start_verification schema strictly conforms to frozen specification");

  // wait_verification schema
  const waitSchema = waitTool.inputSchema;
  assert.deepEqual(waitSchema.required, ["job_id"]);
  assert.equal(waitSchema.properties.job_id.pattern, "^vjob_[0-9a-f]{24}$");
  assert.equal(waitSchema.properties.max_wait_seconds.type, "integer");
  assert.equal(waitSchema.properties.session_id.type, "string");
  assert.equal(waitSchema.properties.session_id.maxLength, 64);
  console.log("  PASS: wait_verification schema strictly conforms to frozen specification");

  // cancel_verification schema
  const cancelSchema = cancelTool.inputSchema;
  assert.deepEqual(cancelSchema.required, ["job_id"]);
  assert.equal(cancelSchema.properties.job_id.pattern, "^vjob_[0-9a-f]{24}$");
  assert.equal(cancelSchema.properties.session_id.type, "string");
  assert.equal(cancelSchema.properties.session_id.maxLength, 64);
  console.log("  PASS: cancel_verification schema strictly conforms to frozen specification");

  // Test 2b: session_id enforcement under requireBashSession=true
  console.log("\n[Test 2b] session_id enforcement under requireBashSession=true...");
  const validSessionId = "test-session-1234567890";
  const { client: clientSession } = await createClientServer({
    bashMode: "safe",
    toolMode: "full",
    requireBashSession: true,
    bashSessionId: validSessionId
  });

  // Missing session_id must fail on start_verification
  let missingRes = await clientSession.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "quick"
    }
  });
  assert.ok(missingRes.isError, "Missing session_id must fail when requireBashSession=true");
  assert.match(missingRes.content[0]?.text, /bash session id is required/i);

  // Mismatched session_id must fail on start_verification
  let mismatchRes = await clientSession.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "quick",
      session_id: "wrong-session-id"
    }
  });
  assert.ok(mismatchRes.isError, "Mismatched session_id must fail when requireBashSession=true");
  assert.match(mismatchRes.content[0]?.text, /bash session id mismatch/i);

  // Matching session_id must succeed on start_verification
  let matchRes = await clientSession.callTool({
    name: "start_verification",
    arguments: {
      workspace_id: realWsId,
      runner: "package_script",
      package_manager: "npm",
      script: "quick",
      session_id: validSessionId
    }
  });
  assert.ok(!matchRes.isError, "Matching session_id must succeed on start_verification");
  const startedJob = matchRes.structuredContent;

  // wait_verification missing session_id must fail
  let waitMissingRes = await clientSession.callTool({
    name: "wait_verification",
    arguments: {
      job_id: startedJob.jobId
    }
  });
  assert.ok(waitMissingRes.isError, "wait_verification missing session_id must fail");

  // wait_verification mismatched session_id must fail
  let waitMismatchRes = await clientSession.callTool({
    name: "wait_verification",
    arguments: {
      job_id: startedJob.jobId,
      session_id: "wrong-session-id"
    }
  });
  assert.ok(waitMismatchRes.isError, "wait_verification mismatched session_id must fail");

  // wait_verification matching session_id must succeed
  let waitMatchRes = await clientSession.callTool({
    name: "wait_verification",
    arguments: {
      job_id: startedJob.jobId,
      session_id: validSessionId
    }
  });
  assert.ok(!waitMatchRes.isError, "wait_verification matching session_id must succeed");

  // cancel_verification missing session_id must fail
  let cancelMissingRes = await clientSession.callTool({
    name: "cancel_verification",
    arguments: {
      job_id: startedJob.jobId
    }
  });
  assert.ok(cancelMissingRes.isError, "cancel_verification missing session_id must fail");

  // cancel_verification mismatched session_id must fail
  let cancelMismatchRes = await clientSession.callTool({
    name: "cancel_verification",
    arguments: {
      job_id: startedJob.jobId,
      session_id: "wrong-session-id"
    }
  });
  assert.ok(cancelMismatchRes.isError, "cancel_verification mismatched session_id must fail");

  // cancel_verification matching session_id must succeed
  let cancelMatchRes = await clientSession.callTool({
    name: "cancel_verification",
    arguments: {
      job_id: startedJob.jobId,
      session_id: validSessionId
    }
  });
  assert.ok(!cancelMatchRes.isError, "cancel_verification matching session_id must succeed");
  console.log("  PASS: session_id required/mismatch/match behavior verified across start/wait/cancel");

  // Test 3: bashMode=off disables verification tools
  console.log("\n[Test 3] bashMode=off hides verification tools from tools/list and fails closed...");
  const { client: clientOff } = await createClientServer({ bashMode: "off", toolMode: "full" });
  const listResOff = await clientOff.listTools();
  const toolNamesOff = listResOff.tools.map((t) => t.name);

  assert.equal(toolNamesOff.includes("start_verification"), false, "start_verification must NOT be listed when bashMode=off");
  assert.equal(toolNamesOff.includes("wait_verification"), false, "wait_verification must NOT be listed when bashMode=off");
  assert.equal(toolNamesOff.includes("cancel_verification"), false, "cancel_verification must NOT be listed when bashMode=off");

  // Attempting to invoke start_verification fails closed
  let callError = null;
  try {
    const res = await clientOff.callTool({
      name: "start_verification",
      arguments: {
        workspace_id: `ws_${"0".repeat(24)}`,
        runner: "package_script",
        package_manager: "npm",
        script: "test"
      }
    });
    if (res.isError) {
      callError = new Error(res.content[0]?.text);
    }
  } catch (err) {
    callError = err;
  }
  assert.ok(callError, "Direct tool call must fail when bashMode=off");
  console.log("  PASS: Verification tools completely hidden and disabled when bashMode=off");

  // Test 4: Secret and token redaction in verification stdout/stderr
  console.log("\n[Test 4] Redaction filters secrets/tokens from verification stdout and stderr...");
  const { verificationManager: mgrRedact, config: configSafeRedact } = await createClientServer({ bashMode: "safe" });
  const fakeWorkspace = {
    id: "ws_sec_test_000000000000",
    root: realFixtureRoot,
    openedAt: new Date().toISOString()
  };
  const guardSafe = new PathGuard(configSafeRedact);

  const leakJob = await mgrRedact.startVerification(fakeWorkspace, guardSafe, {
    workspace_id: fakeWorkspace.id,
    runner: "package_script",
    package_manager: "npm",
    script: "leak-secret"
  });

  const leakResult = await mgrRedact.waitVerification(leakJob.jobId, 5);
  assert.equal(leakResult.state, "succeeded");

  // Verify that secrets are redacted
  assert.ok(!leakResult.stdout.includes("sk-abc1234567890123456789012345678901234567890"), "OpenAI secret must not appear in stdout");
  assert.match(leakResult.stdout, /\[REDACTED_SECRET\]/, "OpenAI key must be redacted in stdout");

  assert.ok(!leakResult.stderr.includes("ghp_1234567890abcdef1234567890abcdef1234"), "GitHub token must not appear in stderr");
  assert.match(leakResult.stderr, /\[REDACTED_SECRET\]/, "GitHub token must be redacted in stderr");
  console.log("  PASS: High-entropy tokens and API keys are redacted in verification job records");

  // Cleanup
  try {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  } catch {}

  console.log("\nALL TASK-006 SECURITY ENVELOPE TESTS PASSED.");
}

runTests().catch((err) => {
  console.error("SECURITY ENVELOPE TEST FAILED:", err);
  process.exit(1);
});
