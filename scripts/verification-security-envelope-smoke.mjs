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
import { redactJsonText } from "../dist/redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M009 TASK-006 Security Envelope & Redaction Smoke");

// Create temporary fixture workspace
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m009-sec-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);
const realWsId = `ws_${createHash("sha256").update(realFixtureRoot).digest("hex").slice(0, 24)}`;

const previousBashTimeout = process.env.CODEXPRO_MAX_BASH_TIMEOUT_MS;
process.env.CODEXPRO_MAX_BASH_TIMEOUT_MS = "900000";
assert.equal(
  loadConfig(["--root", realFixtureRoot, "--allow-root", realFixtureRoot]).maxBashTimeoutMs,
  600_000,
  "native bash timeout must never exceed 600000 ms"
);
if (previousBashTimeout === undefined) delete process.env.CODEXPRO_MAX_BASH_TIMEOUT_MS;
else process.env.CODEXPRO_MAX_BASH_TIMEOUT_MS = previousBashTimeout;

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
      "quick": "node -e 'process.exit(0);'",
      "long": "node -e 'require(\"fs\").writeFileSync(\"cancel-started\",\"yes\"); setTimeout(() => {}, 60000);'"
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
  if (process.platform === "linux") {
    assert.ok(startedJob.containmentWrapper?.some((part) => part.endsWith("/scripts/verification-governed-runner.py")), "Linux verification must acquire through the shared safe_test capacity governor");
    assert.ok(startedJob.commandSummary.includes("--lifetime-ms=1800000"), "default verification lifetime must reach the governor adapter");
    assert.doesNotMatch(startedJob.commandSummary, /MemoryMax=8G(?:\s|$)/u, "Linux verification must not impose an unmeasured 8 GiB demand");
    assert.ok(startedJob.commandSummary.includes("-u DBUS_SESSION_BUS_ADDRESS"), "verification commands must not inherit the user bus");
  }

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
  assert.equal(waitMatchRes.structuredContent.state, "succeeded", "public wait must observe the quick command's real successful exit");
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

  // cancel_verification matching session_id must stop a command proven to have started.
  const longJobRes = await clientSession.callTool({
    name: "start_verification",
    arguments: { workspace_id: realWsId, runner: "package_script", package_manager: "npm", script: "long", session_id: validSessionId }
  });
  assert.ok(!longJobRes.isError, "Long command must start through the public route");
  const startDeadline = Date.now() + 10 * 60_000;
  let commandStarted = false;
  while (Date.now() < startDeadline) {
    try { await fs.access(path.join(realFixtureRoot, "cancel-started")); commandStarted = true; break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(commandStarted, "Cancellation fixture must prove the governed command actually started");
  await fs.rm(path.join(realFixtureRoot, "cancel-started"), { force: true });
  let cancelMatchRes = await clientSession.callTool({
    name: "cancel_verification",
    arguments: {
      job_id: longJobRes.structuredContent.jobId,
      session_id: validSessionId
    }
  });
  assert.ok(!cancelMatchRes.isError, "cancel_verification matching session_id must succeed");
  assert.equal(cancelMatchRes.structuredContent.state, "cancelled", "Public cancel must truthfully report cancellation of the running command");
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

  // Test 5: Multiline JSON stdout remains parseable after redaction.
  console.log("\n[Test 5] Public bash JSON stdout remains parseable and reports redaction coverage...");
  const multilineJson = JSON.stringify({
    project: "agentworkspace-self",
    access_token: "never-expose-this-token",
    secretKey: "opaque-a",
    mySecret: "opaque-b",
    passwordHash: "opaque-c",
    tokenValue: "opaque-d",
    apiToken: 987654321,
    authToken: 987654322,
    accessToken: 987654323,
    refreshToken: 987654324,
    apiTokens: 987654325,
    sessionTokens: 123456,
    clientTokens: 222333,
    tokenValues: 888999,
    proxyAuthorization: "Basic dXNlcjpwYXNz",
    secrets: { value: "opaque-e" },
    Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    nested: { private_key: "-----BEGIN PRIVATE KEY-----\\nnever-expose-this-key\\n-----END PRIVATE KEY-----" },
    before: { tokens: 8 },
    after: { tokens: 13 },
    token_count: 21,
    issued_tokens: ["opaque-token-value"],
    key_samples: {
      ["ghp_1234567890abcdef1234567890abcdef1234"]: { note: "safe payload" },
      nested: { ["sk-abc1234567890123456789012345678901234567890"]: "safe payload" }
    },
    ordinary: "kept"
  }, null, 2);
  const directJson = redactJsonText(multilineJson, "diagnostic");
  assert.ok(directJson, "multiline JSON must be recognized");
  const safeJson = JSON.parse(directJson.text);
  assert.equal(safeJson.access_token, "[REDACTED_SECRET]");
  for (const key of ["secretKey", "mySecret", "passwordHash", "tokenValue", "apiToken", "authToken", "accessToken", "refreshToken", "apiTokens", "sessionTokens", "clientTokens", "tokenValues", "proxyAuthorization", "Authorization", "secrets"]) {
    assert.equal(safeJson[key], "[REDACTED_SECRET]", `multiline JSON ${key} field must be redacted`);
  }
  assert.equal(safeJson.nested.private_key, "[REDACTED_SECRET]");
  assert.equal(safeJson.before.tokens, 8, "numeric token counts must remain numbers");
  assert.equal(safeJson.after.tokens, 13, "numeric token counts must remain numbers");
  assert.equal(safeJson.token_count, 21, "numeric token_count metrics must remain numbers");
  assert.equal(safeJson.issued_tokens, "[REDACTED_SECRET]", "opaque token collections must be masked by their credential field name");
  assert.ok(!JSON.stringify(safeJson).includes("ghp_1234567890abcdef1234567890abcdef1234"), "secret-shaped object keys must be redacted");
  assert.ok(!JSON.stringify(safeJson).includes("sk-abc1234567890123456789012345678901234567890"), "nested secret-shaped object keys must be redacted");
  assert.equal(safeJson.key_samples["[REDACTED_SECRET]"].note, "safe payload");
  assert.equal(safeJson.key_samples.nested["[REDACTED_SECRET]"], "safe payload");
  assert.equal(safeJson.project, "agentworkspace-self");
  assert.equal(directJson.changed, true);
  const opaqueKeyedValue = redactJsonText('{"token":"opaque-value"}', "diagnostic");
  assert.equal(opaqueKeyedValue.changed, true, "masking an opaque credential-named value must be reported");
  const secretFieldNames = redactJsonText(JSON.stringify({
    secretKey: "opaque-a", mySecret: "opaque-b", passwordHash: "opaque-c",
    tokenValue: "opaque-d", apiToken: 987654321, authToken: 987654322,
    accessToken: 987654323, refreshToken: 987654324, apiTokens: 987654325,
    sessionTokens: 123456, clientTokens: 222333, tokenValues: 888999,
    proxyAuthorization: "Basic dXNlcjpwYXNz", secrets: { value: "opaque-e" },
    Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    token: 17, tokens: 21, token_count: 34
  }), "diagnostic");
  assert.ok(secretFieldNames);
  const secretFields = JSON.parse(secretFieldNames.text);
  for (const key of ["secretKey", "mySecret", "passwordHash", "tokenValue", "apiToken", "authToken", "accessToken", "refreshToken", "apiTokens", "sessionTokens", "clientTokens", "tokenValues", "proxyAuthorization", "Authorization", "secrets"]) {
    assert.equal(secretFields[key], "[REDACTED_SECRET]", `${key} must be redacted by its field name`);
  }
  assert.equal(secretFields.token, "[REDACTED_SECRET]", "a numeric singular token field is a credential, not a usage metric");
  assert.equal(secretFields.tokens, 21, "numeric token metrics remain numeric");
  assert.equal(secretFields.token_count, 34, "numeric token_count remains numeric");
  const reformattedJson = redactJsonText('{\n  "answer": 1\n}', "diagnostic");
  assert.equal(reformattedJson.changed, true, "JSON normalization that changes bytes must be reported");

  await fs.writeFile(path.join(realFixtureRoot, "board.json"), multilineJson, "utf8");
  const { client: clientBash } = await createClientServer({ bashMode: "full", toolMode: "full" });
  const jsonOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat board.json" } });
  assert.ok(!jsonOutput.isError, `full bash must return fixture JSON through its normal route: ${JSON.stringify(jsonOutput.structuredContent)}`);
  const safeStdout = jsonOutput.structuredContent.stdout;
  assert.doesNotThrow(() => JSON.parse(safeStdout), "safe structured stdout must remain valid JSON");
  const publicSafeJson = JSON.parse(safeStdout);
  assert.equal(publicSafeJson.access_token, "[REDACTED_SECRET]");
  for (const key of ["secretKey", "mySecret", "passwordHash", "tokenValue", "apiToken", "authToken", "accessToken", "refreshToken", "Authorization", "secrets"]) {
    assert.equal(publicSafeJson[key], "[REDACTED_SECRET]", `public JSON ${key} field must be redacted`);
  }
  assert.equal(publicSafeJson.nested.private_key, "[REDACTED_SECRET]");
  assert.equal(publicSafeJson.before.tokens, 8);
  assert.equal(publicSafeJson.after.tokens, 13);
  assert.equal(publicSafeJson.token_count, 21);
  assert.equal(publicSafeJson.issued_tokens, "[REDACTED_SECRET]");
  assert.ok(!safeStdout.includes("ghp_1234567890abcdef1234567890abcdef1234"));
  assert.ok(!safeStdout.includes("sk-abc1234567890123456789012345678901234567890"));
  assert.deepEqual(jsonOutput.structuredContent.stdout_redaction, {
    format: "json",
    parseable: true,
    changed: true,
    coverage: "credential-named fields (including camelCase), secret-shaped keys, authorization fields, and diagnostic secret patterns",
    nested_values_omitted: false,
    truncated: false
  });
  assert.equal(jsonOutput.content[0].text.includes("never-expose-this-token"), false);

  await fs.writeFile(path.join(realFixtureRoot, "opaque-token.json"), '{"token":"opaque-value"}', "utf8");
  const opaqueJsonOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat opaque-token.json" } });
  assert.equal(JSON.parse(opaqueJsonOutput.structuredContent.stdout).token, "[REDACTED_SECRET]");
  assert.equal(opaqueJsonOutput.structuredContent.stdout_redaction.changed, true,
    "public redaction metadata must report opaque credential-field masking");

  await fs.writeFile(path.join(realFixtureRoot, "secret-source.ts"), "export const api_token = 'source-secret-that-must-not-leak';\n", "utf8");
  const sourceSnippet = await clientBash.callTool({
    name: "read_many",
    arguments: { workspace_id: realWsId, items: [{ path: "secret-source.ts" }] }
  });
  assert.ok(!sourceSnippet.isError, "read_many must return the fixture source through its normal paged route");
  assert.equal(sourceSnippet.structuredContent.results[0].result.redacted, true, "read_many must mark masked source snippets");
  assert.equal(sourceSnippet.structuredContent.results[0].result.text.includes("source-secret-that-must-not-leak"), false);
  assert.match(sourceSnippet.content[0].text, /source redacted: true/u, "read_many text must report that the snippet was masked");
  console.log("  PASS: JSON stdout stays parseable and source snippets truthfully mark whole-file redaction");

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
