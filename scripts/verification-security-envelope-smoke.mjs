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
import { redactDiagnosticText, redactJsonText } from "../dist/redact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M009 TASK-006 Security Envelope & Redaction Smoke");

// Create temporary fixture workspace
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-m009-sec-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);
const realWsId = `ws_${createHash("sha256").update(realFixtureRoot).digest("hex").slice(0, 24)}`;
const mixedEscapedLog = String.raw`log: {"data":"{\"payload\":\"{\\\"apiToken":"LEAK-mixed-api\\\",\\\"authToken\\\":"LEAK-mixed-auth\\\",\\\"user.cookie\\\":"LEAK-mixed-cookie\\\",\\\"tokens\\\":21,\\\"token_count\\\":34}\"}"}`;

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
      "leak-json": `node -e "console.log(JSON.stringify({apiToken:'LEAK-api',cookie:'LEAK-cookie',Authorization:'Bearer LEAK-auth',sessionId:123456,passphrase:'LEAK-pass',signature:'LEAK-signature',otp:654321,pwd:'LEAK-pwd',pass:'LEAK-pass-field',jwt:'LEAK-jwt',mfa:'LEAK-mfa',accessKey:'LEAK-access-key',note:'Bearer LEAK-note',tokens:21,token_count:34}))"`,
      "leak-escaped-json": "node -e 'console.log(\"log:\", JSON.stringify({data: JSON.stringify({apiToken:\"LEAK-verif-escaped\", \"user.cookie\":\"LEAK-verif-dotted\", \"session.id\":\"LEAK-verif-session\", payload: JSON.stringify({apiToken:\"LEAK-verif-deep-api\", authToken:\"LEAK-verif-deep-auth\", \"user.cookie\":\"LEAK-verif-deep-cookie\", tokens:21, token_count:34})})}))'",
      "leak-mixed-escaped-json": `node -e "process.stdout.write(Buffer.from('${Buffer.from(mixedEscapedLog).toString("base64")}', 'base64').toString())"`,
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
  const { client: clientRedact, verificationManager: mgrRedact, config: configSafeRedact } = await createClientServer({ bashMode: "safe" });
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
  const jsonJobStart = await clientRedact.callTool({ name: "start_verification", arguments: {
    workspace_id: realWsId, runner: "package_script", package_manager: "npm", script: "leak-json"
  } });
  assert.ok(!jsonJobStart.isError, "JSON fixture must start through public start_verification");
  const jsonJobWait = await clientRedact.callTool({ name: "wait_verification", arguments: {
    job_id: jsonJobStart.structuredContent.jobId, max_wait_seconds: 10
  } });
  assert.equal(jsonJobWait.structuredContent.state, "succeeded");
  const verificationJson = jsonJobWait.structuredContent.stdout;
  for (const secret of ["LEAK-api", "LEAK-cookie", "LEAK-auth", "LEAK-pass", "LEAK-signature", "LEAK-note", "LEAK-pwd", "LEAK-pass-field", "LEAK-jwt", "LEAK-mfa", "LEAK-access-key"]) {
    assert.ok(!verificationJson.includes(secret), `verification stdout must mask ${secret}`);
  }
  assert.match(verificationJson, /"tokens":21/u, "verification JSON must preserve numeric tokens usage");
  assert.match(verificationJson, /"token_count":34/u, "verification JSON must preserve numeric token_count usage");
  assert.equal(jsonJobWait.structuredContent.stdout_redaction.changed, true,
    "verification redaction metadata must report masked stdout credentials");
  assert.equal(jsonJobWait.structuredContent.stdout_redaction.truncated, false,
    "complete verification stdout must report no truncation");
  const escapedJobStart = await clientRedact.callTool({ name: "start_verification", arguments: {
    workspace_id: realWsId, runner: "package_script", package_manager: "npm", script: "leak-escaped-json"
  } });
  const escapedJobWait = await clientRedact.callTool({ name: "wait_verification", arguments: {
    job_id: escapedJobStart.structuredContent.jobId, max_wait_seconds: 10
  } });
  assert.ok(!escapedJobWait.structuredContent.stdout.includes("LEAK-verif-escaped"),
    "verification text fallback must redact credentials in escaped JSON log fields");
  for (const secret of ["LEAK-verif-dotted", "LEAK-verif-session"]) {
    assert.ok(!escapedJobWait.structuredContent.stdout.includes(secret), `verification text fallback must redact ${secret}`);
  }
  for (const secret of ["LEAK-verif-deep-api", "LEAK-verif-deep-auth", "LEAK-verif-deep-cookie"]) {
    assert.ok(!escapedJobWait.structuredContent.stdout.includes(secret), `verification text fallback must redact deeply escaped ${secret}`);
  }
  assert.match(escapedJobWait.structuredContent.stdout, /\\\\\\"tokens\\\\\\":21/u,
    "deeply escaped verification JSON must preserve numeric tokens usage");
  assert.match(escapedJobWait.structuredContent.stdout, /\\\\\\"token_count\\\\\\":34/u,
    "deeply escaped verification JSON must preserve numeric token_count usage");
  const mixedVerificationStart = await clientRedact.callTool({ name: "start_verification", arguments: {
    workspace_id: realWsId, runner: "package_script", package_manager: "npm", script: "leak-mixed-escaped-json"
  } });
  const mixedVerificationWait = await clientRedact.callTool({ name: "wait_verification", arguments: {
    job_id: mixedVerificationStart.structuredContent.jobId, max_wait_seconds: 10
  } });
  assert.equal(mixedVerificationWait.structuredContent.state, "succeeded");
  for (const secret of ["LEAK-mixed-api", "LEAK-mixed-auth", "LEAK-mixed-cookie"]) {
    assert.ok(!mixedVerificationWait.structuredContent.stdout.includes(secret), `malformed mixed-depth verification stdout must mask ${secret}`);
  }
  assert.match(mixedVerificationWait.structuredContent.stdout, /tokens.{0,10}:21/u,
    "malformed mixed-depth verification stdout must preserve numeric tokens usage");
  assert.match(mixedVerificationWait.structuredContent.stdout, /token_count.{0,10}:34/u,
    "malformed mixed-depth verification stdout must preserve numeric token_count usage");
  assert.equal(mixedVerificationWait.structuredContent.stdout_redaction.changed, true,
    "malformed verification output metadata must report actual masking");
  console.log("  PASS: Verification stdout JSON fields are masked and numeric usage metrics stay numeric");

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
    token_counts: "opaque-plural-credential",
    tokenCounts: { value: "opaque-camel-plural" },
    tokens_count: "opaque-suffix-credential",
    token_counts_value: 777666,
    "user.cookie": "opaque-dotted-cookie", "session.id": "opaque-dotted-session",
    accessKey: "opaque-access-key", pwd: "opaque-pwd", pass: "opaque-pass", jwt: "opaque-jwt", mfa: "opaque-mfa",
    cookie: "session=abcdef1234567890",
    setCookie: ["session=another-secret-value"],
    sessionId: 987654321,
    auth: "Basic dXNlcjpwYXNz",
    passphrase: { value: "opaque-passphrase" },
    signature: null,
    otp: true,
    proxyAuthorization: "Basic dXNlcjpwYXNz",
    note: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    quotedMessage: 'Bearer "quoted-secret-token"',
    nested: { message: "prefix Bearer nested-token-1234567890 suffix", private_key: "-----BEGIN PRIVATE KEY-----\\nnever-expose-this-key\\n-----END PRIVATE KEY-----" },
    messages: ["Bearer array-token-1234567890", { message: "Bearer nested-array-token-1234567890" }],
    non_numeric_metrics: [
      { token_count: "opaque-credential" }, { token_count: false }, { token_count: null },
      { token_count: ["opaque-credential"] }, { token_count: { value: "opaque-credential" } }
    ],
    secrets: { value: "opaque-e" },
    Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
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
  for (const key of ["secretKey", "mySecret", "passwordHash", "tokenValue", "apiToken", "authToken", "accessToken", "refreshToken", "apiTokens", "sessionTokens", "clientTokens", "tokenValues", "token_counts", "tokenCounts", "tokens_count", "token_counts_value", "cookie", "setCookie", "sessionId", "auth", "passphrase", "signature", "otp", "accessKey", "pwd", "pass", "jwt", "mfa", "user.cookie", "session.id", "proxyAuthorization", "Authorization", "secrets"]) {
    assert.equal(safeJson[key], "[REDACTED_SECRET]", `multiline JSON ${key} field must be redacted`);
  }
  assert.equal(safeJson.note, "Bearer [REDACTED_SECRET]");
  assert.equal(safeJson.quotedMessage, "Bearer [REDACTED_SECRET]");
  assert.equal(safeJson.nested.message, "prefix Bearer [REDACTED_SECRET] suffix");
  assert.equal(safeJson.messages[0], "Bearer [REDACTED_SECRET]");
  assert.equal(safeJson.messages[1].message, "Bearer [REDACTED_SECRET]");
  for (const item of safeJson.non_numeric_metrics) {
    assert.equal(item.token_count, "[REDACTED_SECRET]", "only numeric token_count usage metrics may be preserved");
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
  assert.equal(redactJsonText('{"token_count":"opaque-credential"}', "diagnostic").changed, true,
    "masking nonnumeric token_count credentials must be reported");
  assert.equal(JSON.parse(redactJsonText('{"note":"Bearer standalone-token-1234567890"}', "diagnostic").text).note,
    "Bearer [REDACTED_SECRET]", "standalone Bearer values must be masked");
  assert.match(redactDiagnosticText('{"Authorization": Bearer leaked-credential-value'), /\[REDACTED_SECRET\]/u,
    "malformed or truncated unquoted credential values must be masked through their full value");
  const mixedDiagnostic = redactDiagnosticText('npm test output: {"note":"Bearer opaque-value","tokens":21,"token_count":34}');
  assert.match(mixedDiagnostic, /"tokens":21/u, "text fallback must preserve numeric tokens usage");
  assert.match(mixedDiagnostic, /"token_count":34/u, "text fallback must preserve numeric token_count usage");
  assert.ok(!mixedDiagnostic.includes("opaque-value"), "text fallback must still redact Bearer values");
  assert.equal(JSON.parse(redactJsonText('{"note":"Bearer \\\"quoted-secret\\\""}', "diagnostic").text).note,
    "Bearer [REDACTED_SECRET]", "quoted Bearer values must be masked");
  const malformedNested = redactJsonText(JSON.stringify({ data: '{"cookie":"LEAK-malformed-inner","tokens":21,"token_count":34' }), "diagnostic");
  const malformedNestedValue = JSON.parse(malformedNested.text).data;
  assert.ok(!malformedNestedValue.includes("LEAK-malformed-inner"), "malformed nested JSON strings must still redact credential fields");
  assert.match(malformedNestedValue, /"tokens":21/u, "malformed nested JSON strings must preserve numeric tokens usage");
  assert.match(malformedNestedValue, /"token_count":34/u, "malformed nested JSON strings must preserve numeric token_count usage");
  const opaqueKeyedValue = redactJsonText('{"token":"opaque-value"}', "diagnostic");
  assert.equal(opaqueKeyedValue.changed, true, "masking an opaque credential-named value must be reported");
  const secretFieldNames = redactJsonText(JSON.stringify({
    secretKey: "opaque-a", mySecret: "opaque-b", passwordHash: "opaque-c",
    tokenValue: "opaque-d", apiToken: 987654321, authToken: 987654322,
    accessToken: 987654323, refreshToken: 987654324, apiTokens: 987654325,
    sessionTokens: 123456, clientTokens: 222333, tokenValues: 888999,
    token_counts: "opaque-plural", tokenCounts: { value: "opaque" },
    tokens_count: "opaque", token_counts_value: 123,
    cookie: "session=opaque", setCookie: ["opaque"], sessionId: 123,
    auth: "Basic opaque", passphrase: { value: "opaque" }, signature: null, otp: true,
    accessKey: "opaque", pwd: "opaque", pass: "opaque", jwt: "opaque", mfa: "opaque",
    proxyAuthorization: "Basic dXNlcjpwYXNz", secrets: { value: "opaque-e" },
    Authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    token: 17, tokens: 21, token_count: 34
  }), "diagnostic");
  assert.ok(secretFieldNames);
  const secretFields = JSON.parse(secretFieldNames.text);
  for (const key of ["secretKey", "mySecret", "passwordHash", "tokenValue", "apiToken", "authToken", "accessToken", "refreshToken", "apiTokens", "sessionTokens", "clientTokens", "tokenValues", "token_counts", "tokenCounts", "tokens_count", "token_counts_value", "cookie", "setCookie", "sessionId", "auth", "passphrase", "signature", "otp", "accessKey", "pwd", "pass", "jwt", "mfa", "proxyAuthorization", "Authorization", "secrets"]) {
    assert.equal(secretFields[key], "[REDACTED_SECRET]", `${key} must be redacted by its field name`);
  }
  assert.equal(secretFields.token, "[REDACTED_SECRET]", "a numeric singular token field is a credential, not a usage metric");
  assert.equal(secretFields.tokens, 21, "numeric token metrics remain numeric");
  assert.equal(secretFields.token_count, 34, "numeric token_count remains numeric");
  const reformattedJson = redactJsonText('{\n  "answer": 1\n}', "diagnostic");
  assert.equal(reformattedJson.changed, false, "lawful JSON spacing with no credentials must not report a credential change");
  assert.equal(reformattedJson.text, '{\n  "answer": 1\n}', "lawful JSON spacing with no credentials must be preserved byte-identical");
  // Tester W-01ca24 D1-D3 lawful-preservation regressions (candidate ccfb): lawful descriptors/metrics/tails stay readable.
  assert.equal(redactDiagnosticText('{"secretName": "build"}'), '{"secretName": "build"}', 'D1 lawful secretName descriptor must stay readable with spacing');
  assert.equal(redactDiagnosticText('tokens:21 token_count:34 max_tokens = 4096'), 'tokens:21 token_count:34 max_tokens = 4096', 'D2 ordinary metrics line must stay readable');
  const d3Sk = 'sk-aB3xK9mQ2pL7vN4zR8tY6wS1uV5wX7';
  const d3Input = `log prefix {"password":"${d3Sk}"}, trailing, {"token":"${d3Sk}"} end`;
  const d3Out = redactDiagnosticText(d3Input);
  assert.ok(!d3Out.includes(d3Sk), 'D3 both credential values must be masked');
  assert.ok(d3Out.includes(', trailing, '), 'D3 trailing text after first secret must be preserved');
  assert.ok(d3Out.endsWith(' end'), 'D3 tail after second secret must be preserved');
  // Secret-shaped secretName values must still be masked (name/path exemption must not leak real credentials).
  assert.ok(!redactDiagnosticText('{"secretName": "aB3xK9mQ2pL7vN4zR8tY6wS1"}').includes('aB3xK9mQ2pL7vN4zR8tY6wS1'), 'secret-shaped secretName value must stay masked');
  // Malformed nested escaped quoted comma: escaped quotes plus comma must not split fields, leak, or eat numerics.
  const escCommaOut = redactDiagnosticText('log prefix {"note":"Bearer \\"quoted, comma-secret-XYZ123\\"","tokens":21} trailing');
  assert.ok(!escCommaOut.includes('comma-secret-XYZ123'), 'escaped quoted comma credential must be masked');
  assert.ok(escCommaOut.includes('"tokens":21'), 'escaped quoted comma must preserve numeric tokens value');

  await fs.writeFile(path.join(realFixtureRoot, "board.json"), multilineJson, "utf8");
  const { client: clientBash } = await createClientServer({ bashMode: "full", toolMode: "full" });
  const jsonOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat board.json" } });
  assert.ok(!jsonOutput.isError, `full bash must return fixture JSON through its normal route: ${JSON.stringify(jsonOutput.structuredContent)}`);
  const safeStdout = jsonOutput.structuredContent.stdout;
  assert.doesNotThrow(() => JSON.parse(safeStdout), "safe structured stdout must remain valid JSON");
  const publicSafeJson = JSON.parse(safeStdout);
  assert.equal(publicSafeJson.access_token, "[REDACTED_SECRET]");
  for (const key of ["secretKey", "mySecret", "passwordHash", "tokenValue", "apiToken", "authToken", "accessToken", "refreshToken", "apiTokens", "sessionTokens", "clientTokens", "tokenValues", "token_counts", "tokenCounts", "tokens_count", "token_counts_value", "cookie", "setCookie", "sessionId", "auth", "passphrase", "signature", "otp", "proxyAuthorization", "Authorization", "secrets"]) {
    assert.equal(publicSafeJson[key], "[REDACTED_SECRET]", `public JSON ${key} field must be redacted`);
  }
  assert.equal(publicSafeJson.note, "Bearer [REDACTED_SECRET]");
  assert.equal(publicSafeJson.quotedMessage, "Bearer [REDACTED_SECRET]");
  assert.equal(publicSafeJson.nested.message, "prefix Bearer [REDACTED_SECRET] suffix");
  assert.equal(publicSafeJson.messages[0], "Bearer [REDACTED_SECRET]");
  assert.equal(publicSafeJson.messages[1].message, "Bearer [REDACTED_SECRET]");
  for (const item of publicSafeJson.non_numeric_metrics) {
    assert.equal(item.token_count, "[REDACTED_SECRET]", "public route must preserve only numeric token_count metrics");
  }
  assert.equal(publicSafeJson.nested.private_key, "[REDACTED_SECRET]");
  assert.equal(publicSafeJson.before.tokens, 8);
  assert.equal(publicSafeJson.after.tokens, 13);
  assert.equal(publicSafeJson.token_count, 21);
  assert.equal(publicSafeJson.issued_tokens, "[REDACTED_SECRET]");
  assert.ok(!safeStdout.includes("ghp_1234567890abcdef1234567890abcdef1234"));
  assert.ok(!safeStdout.includes("sk-abc1234567890123456789012345678901234567890"));

  const wrappedJsonText = JSON.stringify({ data: JSON.stringify({
    cookie: "LEAK-nested-cookie", sessionId: "LEAK-nested-session", passphrase: "LEAK-nested-passphrase",
    signature: "LEAK-nested-signature", otp: "LEAK-nested-otp", accessKey: "LEAK-nested-access-key",
    Authorization: "Basic LEAK-nested-auth", tokens: 21, token_count: 34
  }) });
  await fs.writeFile(path.join(realFixtureRoot, "wrapped-board.json"), wrappedJsonText, "utf8");
  const wrappedOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat wrapped-board.json" } });
  const wrappedOuter = JSON.parse(wrappedOutput.structuredContent.stdout);
  const wrappedInner = JSON.parse(wrappedOuter.data);
  for (const secret of ["LEAK-nested-cookie", "LEAK-nested-session", "LEAK-nested-passphrase", "LEAK-nested-signature", "LEAK-nested-otp", "LEAK-nested-access-key", "LEAK-nested-auth"]) {
    assert.ok(!wrappedOutput.structuredContent.stdout.includes(secret), `JSON-string credential ${secret} must be masked`);
  }
  assert.equal(wrappedInner.tokens, 21, "JSON-string payload must preserve numeric tokens usage");
  assert.equal(wrappedInner.token_count, 34, "JSON-string payload must preserve numeric token_count usage");

  const malformedWrappedText = JSON.stringify({ data: '{"cookie":"LEAK-malformed-public","tokens":21,"token_count":34' });
  await fs.writeFile(path.join(realFixtureRoot, "malformed-wrapped-board.json"), malformedWrappedText, "utf8");
  const malformedWrappedOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat malformed-wrapped-board.json" } });
  const malformedWrappedOuter = JSON.parse(malformedWrappedOutput.structuredContent.stdout);
  assert.ok(!malformedWrappedOuter.data.includes("LEAK-malformed-public"), "public JSON string fallback must mask malformed nested credentials");
  assert.match(malformedWrappedOuter.data, /"tokens":21/u, "public malformed nested JSON must preserve numeric tokens usage");
  assert.match(malformedWrappedOuter.data, /"token_count":34/u, "public malformed nested JSON must preserve numeric token_count usage");

  const deeplyWrappedJson = `log: ${JSON.stringify({ data: JSON.stringify({ payload: JSON.stringify({
    apiToken: "LEAK-deep-api", authToken: "LEAK-deep-auth", "user.cookie": "LEAK-deep-cookie", tokens: 21, token_count: 34
  }) }) })}`;
  await fs.writeFile(path.join(realFixtureRoot, "deeply-wrapped-board.log"), deeplyWrappedJson, "utf8");
  const deeplyWrappedOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat deeply-wrapped-board.log" } });
  for (const secret of ["LEAK-deep-api", "LEAK-deep-auth", "LEAK-deep-cookie"]) {
    assert.ok(!deeplyWrappedOutput.structuredContent.stdout.includes(secret), `deeply escaped public JSON must mask ${secret}`);
  }
  assert.ok(deeplyWrappedOutput.structuredContent.stdout.startsWith("log: "), "deeply escaped public JSON wrapper must remain available");
  const deeplyWrappedOuter = JSON.parse(deeplyWrappedOutput.structuredContent.stdout.slice("log: ".length));
  const deeplyWrappedInner = JSON.parse(JSON.parse(deeplyWrappedOuter.data).payload);
  assert.equal(deeplyWrappedInner.tokens, 21, "deeply escaped JSON must preserve numeric tokens usage");
  assert.equal(deeplyWrappedInner.token_count, 34, "deeply escaped JSON must preserve numeric token_count usage");
  await fs.writeFile(path.join(realFixtureRoot, "mixed-escaped-board.log"), mixedEscapedLog, "utf8");
  const mixedEscapedOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat mixed-escaped-board.log" } });
  for (const secret of ["LEAK-mixed-api", "LEAK-mixed-auth", "LEAK-mixed-cookie"]) {
    assert.ok(!mixedEscapedOutput.structuredContent.stdout.includes(secret), `malformed mixed-depth public stdout must mask ${secret}`);
  }
  assert.match(mixedEscapedOutput.structuredContent.stdout, /tokens.{0,10}:21/u,
    "malformed mixed-depth public stdout must preserve numeric tokens usage");
  assert.match(mixedEscapedOutput.structuredContent.stdout, /token_count.{0,10}:34/u,
    "malformed mixed-depth public stdout must preserve numeric token_count usage");
  assert.equal(mixedEscapedOutput.structuredContent.stdout_redaction.changed, true,
    "malformed mixed-depth public stdout metadata must report credential masking");
  await fs.writeFile(path.join(realFixtureRoot, "mixed-escaped-large.log"), `${mixedEscapedLog}\n${"x".repeat(300_000)}`, "utf8");
  const truncatedMixedEscaped = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat mixed-escaped-large.log" } });
  assert.equal(truncatedMixedEscaped.structuredContent.stdout_redaction.truncated, true,
    "malformed mixed-depth truncated output must report source truncation");
  for (const secret of ["LEAK-mixed-api", "LEAK-mixed-auth", "LEAK-mixed-cookie"]) {
    assert.ok(!truncatedMixedEscaped.structuredContent.stdout.includes(secret), `malformed mixed-depth truncated output must not leak ${secret}`);
  }
  assert.match(truncatedMixedEscaped.structuredContent.stdout, /tokens.{0,10}:21/u,
    "malformed mixed-depth truncated output must preserve numeric tokens usage");
  assert.match(truncatedMixedEscaped.structuredContent.stdout, /token_count.{0,10}:34/u,
    "malformed mixed-depth truncated output must preserve numeric token_count usage");
  const singleEscapedDiagnostic = redactDiagnosticText(`log: ${JSON.stringify({ data: JSON.stringify({ apiToken: "LEAK-single", tokens: 21, token_count: 34 }) })}`);
  const singleEscapedOuter = JSON.parse(singleEscapedDiagnostic.slice("log: ".length));
  const singleEscapedInner = JSON.parse(singleEscapedOuter.data);
  assert.equal(singleEscapedInner.apiToken, "[REDACTED_SECRET]");
  assert.equal(singleEscapedInner.tokens, 21, "single-escaped redaction must not consume the next field");
  assert.equal(singleEscapedInner.token_count, 34, "single-escaped redaction must preserve adjacent numeric metrics");

  assert.deepEqual(jsonOutput.structuredContent.stdout_redaction, {
    format: "json",
    parseable: true,
    changed: true,
    coverage: "credential-named fields (including camelCase), secret-shaped keys, authorization fields, Bearer token values, and diagnostic secret patterns",
    nested_values_omitted: false,
    truncated: false
  });
  assert.equal(jsonOutput.content[0].text.includes("never-expose-this-token"), false);

  await fs.writeFile(path.join(realFixtureRoot, "escaped-board.log"),
    `log: ${JSON.stringify({ data: JSON.stringify({ apiToken: "LEAK-bash-escaped" }) })}`, "utf8");
  const escapedBashOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat escaped-board.log" } });
  assert.ok(!escapedBashOutput.structuredContent.stdout.includes("LEAK-bash-escaped"),
    "bash text fallback must redact credentials in escaped JSON log fields");

  const largeJson = JSON.stringify({
    Authorization: "Bearer LEAK-large-auth", proxyAuthorization: "Basic LEAK-large-proxy",
    cookie: "LEAK-large-cookie", "user.cookie": "LEAK-large-dotted", "session.id": "LEAK-large-dotted-session",
    sessionId: 998877, auth: "Basic LEAK-large-auth-field",
    passphrase: "LEAK-large-passphrase", signature: "LEAK-large-signature", otp: 776655,
    note: "Bearer LEAK-large-note", tokens: 21, token_count: 34,
    escapedLog: JSON.stringify({ apiToken: "LEAK-large-escaped" }),
    deeplyEscapedLog: JSON.stringify({ payload: JSON.stringify({ apiToken: "LEAK-large-deep-escaped", tokens: 21, token_count: 34 }) }),
    data: "x".repeat(300_000)
  }).replace('"cookie":', String.raw`"\u0063ookie":`);
  await fs.writeFile(path.join(realFixtureRoot, "large-board.json"), largeJson, "utf8");
  const largeCallStartedAt = Date.now();
  const largeOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat large-board.json" } });
  assert.ok(Date.now() - largeCallStartedAt < 10_000, "large truncated JSON redaction must stay comfortably below the SDK request timeout");
  const largeStdout = largeOutput.structuredContent.stdout;
  for (const secret of ["LEAK-large-auth", "LEAK-large-proxy", "LEAK-large-cookie", "LEAK-large-dotted", "LEAK-large-dotted-session", "LEAK-large-auth-field", "LEAK-large-passphrase", "LEAK-large-signature", "LEAK-large-note", "LEAK-large-escaped", "LEAK-large-deep-escaped"]) {
    assert.ok(!largeStdout.includes(secret), `truncated JSON stdout must mask ${secret}`);
  }
  assert.match(largeStdout, /"tokens":21/u, "truncated JSON text must preserve numeric tokens usage");
  assert.match(largeStdout, /"token_count":34/u, "truncated JSON text must preserve numeric token_count usage");
  assert.equal(largeOutput.structuredContent.stdout_redaction.truncated, true, "raw capture truncation must remain visible in metadata");
  assert.equal(largeOutput.structuredContent.stdout_redaction.parseable, false, "truncated JSON must not claim parseability");
  assert.equal(largeOutput.structuredContent.truncated, true, "public result must report output truncation");

  await fs.writeFile(path.join(realFixtureRoot, "opaque-token.json"), '{"token":"opaque-value"}', "utf8");
  const opaqueJsonOutput = await clientBash.callTool({ name: "bash", arguments: { workspace_id: realWsId, command: "cat opaque-token.json" } });
  assert.equal(JSON.parse(opaqueJsonOutput.structuredContent.stdout).token, "[REDACTED_SECRET]");
  assert.equal(opaqueJsonOutput.structuredContent.stdout_redaction.changed, true,
    "public redaction metadata must report opaque credential-field masking");

  await fs.writeFile(path.join(realFixtureRoot, "secret-source.ts"), "export const api_token = 'sk-aB3xK9mQ2pL7vN4zR8tY6wS1uV5wX7';\n", "utf8");
  const sourceSnippet = await clientBash.callTool({
    name: "read_many",
    arguments: { workspace_id: realWsId, items: [{ path: "secret-source.ts" }] }
  });
  assert.ok(!sourceSnippet.isError, "read_many must return the fixture source through its normal paged route");
  assert.equal(sourceSnippet.structuredContent.results[0].result.redacted, true, "read_many must mark masked source snippets");
  assert.equal(sourceSnippet.structuredContent.results[0].result.text.includes("sk-aB3xK9mQ2pL7vN4zR8tY6wS1uV5wX7"), false);
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
