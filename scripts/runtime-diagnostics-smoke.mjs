import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const repoRoot = path.resolve('.');
const { hasSecretValue, redactDiagnosticText, redactSensitiveText, truncateUtf8 } = await import('../dist/redact.js');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function runtimeId(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function runtimePaths(home, root) {
  const dir = path.join(home, 'runtime');
  const id = runtimeId(root);
  return {
    dir,
    current: path.join(dir, `${id}.json`),
    failure: path.join(dir, `${id}.last-failure.json`)
  };
}

function waitForClose(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for pid ${child.pid} to exit`)), timeoutMs);
    timer.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForJson(filePath, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (predicate(data)) return data;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? 'predicate not met'}`);
}

async function waitForHttp(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for direct HTTP runtime: ${lastError?.message ?? 'health check failed'}`);
}

async function assertMissing(filePath, label) {
  try {
    await fs.access(filePath);
    throw new Error(`${label} unexpectedly exists: ${filePath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function launch(root, home, port, options = {}) {
  const args = [
    'scripts/codexpro.mjs',
    'start',
    '--root', root,
    '--tunnel', options.tunnel ?? 'none',
    '--port', String(port),
    '--headless',
    '--no-profile'
  ];
  if ((options.tunnel ?? 'none') === 'none' && options.noAuth !== false) args.push('--no-auth');
  if (options.token) args.push('--token', options.token);
  if (options.cloudflared) args.push('--cloudflared', options.cloudflared);
  if (options.logRequests) args.push('--log-requests');
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEXPRO_HOME: home,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_TOOL_MODE: 'minimal',
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'off',
      CODEXPRO_TOOL_CARDS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

function launchDirectHttp(root, home, port) {
  const child = spawn(process.execPath, ['dist/http.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEXPRO_HOME: home,
      CODEXPRO_ROOT: root,
      CODEXPRO_ALLOWED_ROOTS: root,
      CODEXPRO_HOST: '127.0.0.1',
      CODEXPRO_PORT: String(port),
      CODEXPRO_TOOL_MODE: 'minimal',
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'off',
      CODEXPRO_TOOL_CARDS: '0',
      CODEXPRO_TUNNEL_MODE: '0',
      CODEXPRO_RUNTIME_KIND: 'http',
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  return { child, output: () => output };
}

async function writeRuntimeFixture(home, root, runtime, failure = null) {
  const paths = runtimePaths(home, await fs.realpath(root));
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.current, `${JSON.stringify({ version: 1, root: await fs.realpath(root), ...runtime }, null, 2)}\n`);
  if (failure) await fs.writeFile(paths.failure, `${JSON.stringify({ version: 1, root: await fs.realpath(root), ...failure }, null, 2)}\n`);
  return paths;
}

async function stopLauncher(launched) {
  if (launched.child.exitCode === null && launched.child.signalCode === null) launched.child.kill('SIGTERM');
  return waitForClose(launched.child).catch((error) => {
    throw new Error(`${error.message}\nlauncher output:\n${launched.output()}`);
  });
}

async function callRuntimeStatus(port, token = '') {
  const client = new Client({ name: 'codexpro-runtime-diagnostics-smoke', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const runtimeTool = tools.tools.find((tool) => tool.name === 'runtime_status');
    assert.equal(runtimeTool?.annotations?.readOnlyHint, true, 'runtime_status must advertise read-only semantics');
    const result = await client.callTool({ name: 'runtime_status', arguments: {} });
    assert.notEqual(result.isError, true, `runtime_status failed: ${JSON.stringify(result)}`);
    return {
      structured: result.structuredContent,
      text: result.content?.find?.((part) => part.type === 'text')?.text ?? ''
    };
  } finally {
    await client.close();
  }
}

async function writeExecutable(filePath, body) {
  await fs.writeFile(filePath, body, { mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o700);
  return filePath;
}

function assertNoSecrets(payload, secrets, label) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${label} leaked ${secret}`);
}

const redactionParityCases = [
  { input: 'TOKEN=QZ7', secret: 'QZ7' },
  { input: 'PASSWORD=QZ7', secret: 'QZ7' },
  { input: 'SECRET=QZ7', secret: 'QZ7' },
  { input: 'API_KEY=QZ7', secret: 'QZ7' },
  { input: 'PRIVATE_KEY=QZ7', secret: 'QZ7' },
  { input: 'MY_PRIVATE_KEY_VALUE=QZ7', secret: 'QZ7' },
  { input: 'private_key=QZ7', secret: 'QZ7' },
  { input: 'api_token=QZ7', secret: 'QZ7' },
  { input: 'ApiToken=QZ7', secret: 'QZ7' },
  { input: 'service_token=QZ7', secret: 'QZ7' },
  { input: 'CODEXPRO_HTTP_TOKEN=QZ7', secret: 'QZ7' },
  { input: 'API_TOKEN=QZ7', secret: 'QZ7' },
  { input: 'API_TOKEN="QZ7"', secret: 'QZ7' },
  { input: '{"API_TOKEN":"QZ7"}', secret: 'QZ7' },
  { input: '{"TOKEN":"QZ7"}', secret: 'QZ7' },
  { input: '{"PRIVATE_KEY":"QZ7"}', secret: 'QZ7' },
  { input: '{"api_token":"QZ7"}', secret: 'QZ7' },
  { input: '{"service_token":"QZ7"}', secret: 'QZ7' },
  { input: '{"api_key":"QZ7"}', secret: 'QZ7' },
  { input: 'password: QZ7', secret: 'QZ7' },
  { input: 'api_key: QZ7', secret: 'QZ7' },
  { input: 'service_token: QZ7', secret: 'QZ7' },
  { input: 'api_token: QZ7', secret: 'QZ7' },
  { input: 'ApiToken: QZ7', secret: 'QZ7' },
  { input: 'API_TOKEN: QZ7', secret: 'QZ7' },
  { input: 'Authorization: Bearer QZ7', secret: 'QZ7' },
  { input: 'Authorization: Digest QZ7', secret: 'QZ7' },
  { input: '--token QZ7', secret: 'QZ7' },
  { input: '--token=QZ7', secret: 'QZ7' },
  { input: '--auth-token QZ7', secret: 'QZ7' },
  { input: '--api-key QZ7', secret: 'QZ7' },
  { input: '?codexpro_token=QZ7', secret: 'QZ7' },
  { input: '?token=QZ7', secret: 'QZ7' },
  { input: 'https://user:QZ7@example.invalid/', secret: 'QZ7' },
  { input: 'API_TOKEN=sk-ant-abcdefghijklmnopqrstuvwxyz123456', secret: 'sk-ant-abcdefghijklmnopqrstuvwxyz123456' },
  { input: '{"API_TOKEN":"longfieldtokenabcdefghijklmnop"}', secret: 'longfieldtokenabcdefghijklmnop' },
  { input: 'TOKEN=keep-this-codexpro-token-stable', harmless: true },
  { input: 'TOKEN=keep-this-stable-token', harmless: true },
  { input: 'const API_TOKEN = getToken();', harmless: true },
  { input: 'const TOKEN = getToken(user);', harmless: true },
  { input: 'const TOKEN = getToken("user");', harmless: true },
  { input: 'const TOKEN = credentials.getToken(user);', harmless: true },
  { input: 'const TOKEN = credentials.getToken("user");', harmless: true },
  { input: 'const API_TOKEN = config.apiToken;', harmless: true },
  { input: 'const API_TOKEN = credentials.token;', harmless: true },
  { input: 'API_TOKEN = process.env.API_TOKEN;', harmless: true },
  { input: 'TOKEN = process.env.TOKEN;', harmless: true },
  { input: 'PASSWORD = options.password;', harmless: true },
  { input: 'const SECRET = runtime.currentSecret;', harmless: true },
  { input: 'api_key = settings.apiKey;', harmless: true },
  { input: 'service_token = credentials.serviceToken;', harmless: true },
  { input: 'const PASSWORD = readPassword();', harmless: true },
  { input: 'const API_KEY = this.apiKey;', harmless: true },
  { input: 'const PASSWORD = credentials.getPassword();', harmless: true }
];
for (const testCase of redactionParityCases) {
  const redacted = redactSensitiveText(testCase.input);
  if (testCase.secret) {
    assert.equal(redacted.includes(testCase.secret), false, `shared redaction leaked ${testCase.secret}`);
    assert.equal(hasSecretValue(testCase.input), true, `shared redaction did not classify ${testCase.input}`);
  } else if (testCase.harmless) {
    assert.equal(redacted, testCase.input, `shared redaction corrupted harmless expression ${testCase.input}`);
    assert.equal(hasSecretValue(testCase.input), false, `shared redaction classified harmless expression ${testCase.input}`);
    assert.equal(redactDiagnosticText(testCase.input), testCase.input, `diagnostic redaction corrupted harmless source/member expression ${testCase.input}`);
  }
}
const exactPlaceholderCases = [
  'TOKEN=keep-this-codexpro-token-stable',
  'TOKEN="keep-this-codexpro-token-stable"',
  'TOKEN=keep-this-stable-token',
  'TOKEN=process.env.TOKEN'
];
assert.equal(redactSensitiveText(exactPlaceholderCases[0]), exactPlaceholderCases[0]);
assert.equal(redactSensitiveText(exactPlaceholderCases[1]), exactPlaceholderCases[1]);
assert.equal(redactSensitiveText(exactPlaceholderCases[2]), exactPlaceholderCases[2]);
assert.equal(redactSensitiveText(exactPlaceholderCases[3]), exactPlaceholderCases[3]);
const placeholderLikeCredential = 'keep-this-actual-credential-ZXCV1234';
assert.equal(redactSensitiveText(`TOKEN=${placeholderLikeCredential}`).includes(placeholderLikeCredential), false);
assert.equal(hasSecretValue(`TOKEN=${placeholderLikeCredential}`), true);
const ambiguousDiagnosticCall = 'TOKEN=getToken(CALL_LITERAL_7X9)';
assert.equal(redactSensitiveText(ambiguousDiagnosticCall), ambiguousDiagnosticCall);
assert.equal(redactDiagnosticText(ambiguousDiagnosticCall).includes('CALL_LITERAL_7X9'), false);
assert.equal(hasSecretValue(ambiguousDiagnosticCall), false);
assert.equal(hasSecretValue(ambiguousDiagnosticCall, { context: 'diagnostic' }), true);
const declaredCall = 'const TOKEN = getToken(CALL_LITERAL_7X9);';
assert.equal(redactSensitiveText(declaredCall), declaredCall);
assert.equal(hasSecretValue(declaredCall), false);
const ambiguousDiagnosticPassword = 'PASSWORD=readPassword(ACTUAL_LITERAL)';
assert.equal(redactSensitiveText(ambiguousDiagnosticPassword), ambiguousDiagnosticPassword);
assert.equal(redactDiagnosticText(ambiguousDiagnosticPassword).includes('ACTUAL_LITERAL'), false);
assert.equal(hasSecretValue(ambiguousDiagnosticPassword), false);
assert.equal(hasSecretValue(ambiguousDiagnosticPassword, { context: 'diagnostic' }), true);
const crossLanguageSourceCases = [
  'const API_TOKEN = getToken();',
  'const TOKEN = getToken(user);',
  'const PASSWORD = credentials.getPassword();',
  'API_TOKEN = runtime.tokens.current;',
  'TOKEN = os.getenv("TOKEN")',
  'PASSWORD = getpass.getpass()',
  'API_KEY = config.get("api_key")',
  'SECRET = secrets.token_urlsafe(32)',
  'TOKEN = get_token(user)',
  'TOKEN = ENV.fetch("TOKEN")',
  'PASSWORD = credentials.password()',
  'TOKEN = process.env.TOKEN;',
  'API_KEY = settings.apiKey;',
  'PASSWORD = options.password;',
  'SECRET = runtime.currentSecret;'
];
for (const source of crossLanguageSourceCases) {
  assert.equal(redactSensitiveText(source), source, `source redaction corrupted ${source}`);
  assert.equal(hasSecretValue(source), false, `source redaction classified ${source}`);
}
for (const diagnostic of [ambiguousDiagnosticCall, ambiguousDiagnosticPassword]) {
  assert.equal(hasSecretValue(diagnostic, { context: 'diagnostic' }), true, `diagnostic call was not classified: ${diagnostic}`);
  assert.equal(redactDiagnosticText(diagnostic).includes(diagnostic.slice(diagnostic.indexOf('(') + 1, -1)), false, `diagnostic call literal leaked: ${diagnostic}`);
}
for (const privateLabel of ['PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'DSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
  const complete = `-----BEGIN ${privateLabel}-----\nTASK003_PRIVATE_BODY_${privateLabel.replaceAll(' ', '_')}\n-----END ${privateLabel}-----`;
  const incomplete = `-----BEGIN ${privateLabel}-----\nTASK003_INCOMPLETE_BODY_${privateLabel.replaceAll(' ', '_')}`;
  assert.equal(hasSecretValue(complete), true, `private-key BEGIN not classified: ${privateLabel}`);
  assert.equal(hasSecretValue(incomplete), true, `incomplete private-key BEGIN not classified: ${privateLabel}`);
  assert.equal(redactSensitiveText(complete).includes('TASK003_PRIVATE_BODY'), false, `private-key body leaked: ${privateLabel}`);
  assert.equal(redactSensitiveText(incomplete).includes('TASK003_INCOMPLETE_BODY'), false, `incomplete private-key body leaked: ${privateLabel}`);
}
const mismatchedPrivateEnd = '-----BEGIN RSA PRIVATE KEY-----\nTASK003_MISMATCHED_PRIVATE_BODY\n-----END PRIVATE KEY-----\nTASK003_MISMATCHED_TAIL';
assert.equal(redactSensitiveText(mismatchedPrivateEnd).includes('TASK003_MISMATCHED'), false, 'mismatched private-key END boundary leaked body');
const publicCertificate = `-----BEGIN CERTIFICATE-----\nTASK003_PUBLIC_CERTIFICATE\n-----END CERTIFICATE-----`;
const publicKey = `-----BEGIN PUBLIC KEY-----\nTASK003_PUBLIC_KEY\n-----END PUBLIC KEY-----`;
assert.equal(redactSensitiveText(publicCertificate), publicCertificate);
assert.equal(redactSensitiveText(publicKey), publicKey);
assert.equal(hasSecretValue(publicCertificate), false);
assert.equal(hasSecretValue(publicKey), false);
for (const [sample, width] of [['é', 2], ['界', 3], ['😀', 4]]) {
  const bounded = truncateUtf8(sample.repeat(5000), 8_192, '\n...[byte-cap]');
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 8_192, 'UTF-8 ' + width + '-byte sample exceeded cap');
  assert.equal(bounded.includes('\uFFFD'), false, 'UTF-8 ' + width + '-byte sample split a code point');
  const aroundBoundary = truncateUtf8('a'.repeat(8_192 - width + 1) + sample + 'tail', 8_192);
  assert.ok(Buffer.byteLength(aroundBoundary, 'utf8') <= 8_192, 'UTF-8 boundary sample exceeded cap');
  assert.equal(aroundBoundary.includes('\uFFFD'), false, 'UTF-8 boundary sample split a code point');
}
const cleanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-clean-root-'));
const cleanHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-clean-home-'));
const cleanPort = await getFreePort();
const cleanPaths = runtimePaths(cleanHome, await fs.realpath(cleanRoot));
const clean = launch(cleanRoot, cleanHome, cleanPort);
const cleanRuntime = await waitForJson(cleanPaths.current, (value) => Number.isInteger(value.runtimePid), 'healthy runtime state');
const healthy = await callRuntimeStatus(cleanPort);
assert.equal(healthy.structured.health, 'healthy');
assert.equal(healthy.structured.http_child.status, 'running');
assert.equal(healthy.structured.tunnel.status, 'disabled');
assert.equal(healthy.structured.last_failure, null);
assert.equal(healthy.structured.endpoint, `http://127.0.0.1:${cleanPort}/mcp`);
assert.equal(typeof healthy.structured.startup_timestamp, 'string');
assert.equal(typeof healthy.structured.uptime_seconds, 'number');
assert.equal(healthy.structured.process.pid, cleanRuntime.runtimePid);
assertNoSecrets(healthy, ['task003-clean-secret'], 'healthy runtime status');
await stopLauncher(clean);
await assertMissing(cleanPaths.current, 'clean-shutdown current runtime state');
await assertMissing(cleanPaths.failure, 'clean-shutdown failure state');

const displayRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-display-root-'));
const displayHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-display-home-'));
const displayPort = await getFreePort();
const displayToken = 'task003-display-token-1234567890';
const displayPaths = runtimePaths(displayHome, await fs.realpath(displayRoot));
const display = launch(displayRoot, displayHome, displayPort, { token: displayToken, noAuth: false });
await waitForJson(displayPaths.current, (value) => Number.isInteger(value.runtimePid), 'redacted display runtime state');
const displayOutput = display.output();
const readyLine = displayOutput.split(/\r?\n/).find((line) => line.startsWith('CODEXPRO_READY')) ?? '';
assert.equal(displayOutput.includes(displayToken), false, 'launcher display output leaked the HTTP token');
assert.match(readyLine, /codexpro_token=\[REDACTED_SECRET\]/, 'launcher display URL lost its redacted query value');
assert.equal(readyLine.includes('codexpro_token= [REDACTED_SECRET]'), false, 'launcher display URL gained whitespace after query equals');
await stopLauncher(display);
await assertMissing(displayPaths.current, 'redacted display shutdown current runtime state');

const failureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-http-root-'));
const failureHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-http-home-'));
const failurePort = await getFreePort();
const failureRealRoot = await fs.realpath(failureRoot);
const failurePaths = runtimePaths(failureHome, failureRealRoot);
const httpFailure = launch(failureRoot, failureHome, failurePort);
const httpRuntime = await waitForJson(failurePaths.current, (value) => Number.isInteger(value.runtimePid), 'HTTP-child runtime state');
const httpHealthy = await callRuntimeStatus(failurePort);
assert.equal(httpHealthy.structured.health, 'healthy');
assert.equal(httpHealthy.structured.last_failure, null);
process.kill(httpRuntime.runtimePid, 'SIGKILL');
const httpExit = await waitForClose(httpFailure.child);
assert.notEqual(httpExit.code, 0, `HTTP-child failure unexpectedly exited cleanly: ${JSON.stringify(httpExit)}`);
const httpFailureRecord = await waitForJson(failurePaths.failure, (value) => value.component === 'http_child', 'HTTP-child failure record');
assert.equal(httpFailureRecord.event, 'unexpected_exit');
assert.equal(httpFailureRecord.httpPid, httpRuntime.runtimePid);
assert.equal(httpFailureRecord.signal, 'SIGKILL');
assert.ok(Buffer.byteLength(JSON.stringify(httpFailureRecord), 'utf8') <= 16_384);
await assertMissing(failurePaths.current, 'HTTP-child current runtime state');

const restartPort = await getFreePort();
const restarted = launch(failureRoot, failureHome, restartPort);
const restartedRuntime = await waitForJson(failurePaths.current, (value) => Number.isInteger(value.runtimePid), 'restart runtime state');
const restartedStatus = await callRuntimeStatus(restartPort);
assert.equal(restartedStatus.structured.health, 'healthy');
assert.equal(restartedStatus.structured.last_failure.component, 'http_child');
assert.equal(restartedStatus.structured.last_failure_relation, 'previous');
assert.notEqual(restartedStatus.structured.run_id, httpFailureRecord.runId);
assert.equal(restartedStatus.structured.http_child.pid, restartedRuntime.runtimePid);
assertNoSecrets(restartedStatus, ['task003-http-secret'], 'restart runtime status');
const persistedRestartRecord = JSON.parse(await fs.readFile(failurePaths.failure, 'utf8'));
assert.deepEqual(persistedRestartRecord, httpFailureRecord);
await stopLauncher(restarted);
await assertMissing(failurePaths.current, 'restart current runtime state');
assert.ok((await fs.stat(failurePaths.failure)).isFile());

const tunnelRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-tunnel-root-'));
const tunnelHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-tunnel-home-'));
const tunnelPort = await getFreePort();
const tunnelRealRoot = await fs.realpath(tunnelRoot);
const tunnelPaths = runtimePaths(tunnelHome, tunnelRealRoot);
const bearerSecret = 'task003-bearer-secret-1234567890';
const basicSecret = 'task003-basic-secret-1234567890';
const ngrokSecret = '2task003NGROKsecretABCDEFGHIJ1234567890';
const tunnelSecret = 'eyJhbGciOiJIUzI1NiJ9.eyJ0YXNrIjoiMDAzIn0.signature1234567890';
const urlSecret = 'task003-url-secret-1234567890';
const launcherTokenSecret = 'task003-http-token-1234567890';
const shortBearerSecret = 'QZ7';
const digestSecret = 'DZ8';
const shortBasicSecret = 'BZ9';
const tokenSchemeSecret = 'TZ7';
const apiKeySecret = 'AZ8';
const shortCodexToken = 'CZ9';
const shortCliToken = 'LZ7';
const shortEqualsToken = 'EZ8';
const shortAuthToken = 'HZ9';
const shortApiKey = 'KZ7';
const shortQueryCodexToken = 'UZ8';
const shortQueryToken = 'VZ9';
const shortJsonToken = 'JZ7';
const shortJsonHttpToken = 'HZ8';
const shortYamlToken = 'YZ7';
const longFieldSecret = 'longfieldtokenabcdefghijklmnop';
const oversizedBeginningSecret = 'task003-oversized-begin-secret-1234567890';
const oversizedEndingSecret = 'task003-oversized-end-secret-1234567890';
const oversizedIncompleteSecret = 'task003-oversized-incomplete-secret-1234567890';
const postBoundaryDiagnostic = 'task003-post-boundary-safe-diagnostic';
const ambiguousDiagnosticSecret = 'CALL_LITERAL_7X9';
const completePrivateBodySecret = 'task003-complete-private-body-1234567890';
const fragmentedPrivateBodySecret = 'task003-fragmented-private-body-1234567890';
const multibytePrivateBodySecret = 'task003-multibyte-private-body-1234567890';
const incompletePrivateBodySecret = 'task003-incomplete-private-body-1234567890';
const boundaryPrivateBodySecret = 'task003-boundary-private-body-1234567890';
const ambiguousPasswordSecret = 'ACTUAL_LITERAL';
const launcherPrivateBlockParityCorpus = [
  `-----BEGIN RSA PRIVATE KEY-----\n${completePrivateBodySecret}\n-----END RSA PRIVATE KEY-----`,
  `-----BEGIN OPENSSH PRIVATE KEY-----\n${fragmentedPrivateBodySecret}\n-----END OPENSSH PRIVATE KEY-----`,
  `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${incompletePrivateBodySecret}`
];
const launcherParityCorpus = [
  ...redactionParityCases.map((testCase) => testCase.input),
  ...launcherPrivateBlockParityCorpus
];
const splitCredentialChunks = [
  'const API_TOKEN = getToken()\n',
  `TOKEN=getToken(${ambiguousDiagnosticSecret})\n`,
  `PASSWORD=readPassword(${ambiguousPasswordSecret})\n`,
  `TOKEN=${placeholderLikeCredential}\n`,
  `Authorization: Bearer ${shortBearerSecret}`,
  '\n',
  `{"API_TO`,
  `KEN":"${shortJsonToken}"}\n`,
  `{"CODEXPRO_HTTP_TOKEN":"${shortJsonHttpToken}"}\n`,
  `API_TOKEN=QZ7\n`,
  `API_TOKEN=sk-ant-abcdefghijklmnopqrstuvwxyz123456\n`,
  `{"API_TOKEN":"${longFieldSecret}"}\n`,
  `API_TOKEN: ${shortYamlToken}\n`,
  `Authorization: Digest ${digestSecret}\n`,
  `Authorization: Basic ${shortBasicSecret}\n`,
  `Authorization: Token ${tokenSchemeSecret}\n`,
  `Authorization: ApiKey ${apiKeySecret}\n`,
  `CODEXPRO_HTTP_TOKEN=${shortCodexToken}\n`,
  `codexpro_token=${shortCodexToken}\n`,
  `--token ${shortCliToken}\n`,
  `--token=${shortEqualsToken}\n`,
  `--auth-token ${shortAuthToken}\n`,
  `--api-key ${shortApiKey}\n`,
  `?codexpro_token=${shortQueryCodexToken}\n`,
  `?token=${shortQueryToken}\n`,
  `https://${urlSecret}:password@example.invalid/secret\n`,
  `cloudflared tunnel run --token ${tunnelSecret}\n`,
  `ngrok config add-authtoken ${ngrokSecret}\n`,
  `-----BEGIN RSA PRIVATE KEY-----\n${completePrivateBodySecret}\n-----END RSA PRIVATE KEY-----\n`,
  '-----BEGIN OP',
  'ENSSH PRIVATE KEY-----\n',
  `${fragmentedPrivateBodySecret}\n${multibytePrivateBodySecret}\n${'界'.repeat(3000)}\n`,
  '-----END OP',
  'ENSSH PRIVATE KEY-----\n',
  `${'q'.repeat(8_180)}-----BEGIN PRIVATE KEY-----\n${boundaryPrivateBodySecret}\n-----END PRIVATE KEY-----\n`,
  'const API_TOKEN = config.apiToken;\n',
  'API_TOKEN = process.env.API_TOKEN;\n',
  ...launcherParityCorpus.map((input) => `${input}\n`)
];
const fakeTunnel = await writeExecutable(path.join(tunnelHome, 'fake-cloudflared.mjs'), `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('cloudflared version 2026.7.2'); process.exit(0); }
const chunks = ${JSON.stringify(splitCredentialChunks)};
let index = 0;
const writeNext = () => {
  if (index >= chunks.length) {
    process.stderr.write('TOKEN=task003-oversized-begin-secret-1234567890' + 'x'.repeat(100000) + '\\n');
    process.stdout.write('TOKEN=QZ7\\n');
    process.stdout.write('y'.repeat(5000));
    setImmediate(() => {
      process.stdout.write('y'.repeat(5000) + 'TOKEN=task003-oversized-end-secret-1234567890\\n');
      process.stdout.write('界'.repeat(3000) + '\\n');
      process.stderr.write('z'.repeat(100000) + 'TOKEN=task003-oversized-incomplete-secret-1234567890' + '\\n-----BEGIN PGP PRIVATE KEY BLOCK-----\\n' + ${JSON.stringify(incompletePrivateBodySecret)} + '界'.repeat(3000) + 'x'.repeat(100000));
      process.stdout.write(${JSON.stringify(postBoundaryDiagnostic)} + '\\n');
      process.stdout.write('https://task003-fake.trycloudflare.com\\n');
      setTimeout(() => process.exit(23), 500);
    });
    return;
  }
  const chunk = chunks[index++];
  process.stderr.write(chunk);
  setImmediate(writeNext);
};
writeNext();
`);
const tunnelFailure = launch(tunnelRoot, tunnelHome, tunnelPort, {
  tunnel: 'cloudflare',
  token: 'task003-http-token-1234567890',
  cloudflared: fakeTunnel,
  logRequests: true
});
await waitForClose(tunnelFailure.child);
const tunnelFailureRecord = await waitForJson(tunnelPaths.failure, (value) => value.component === 'tunnel', 'tunnel failure record');
assert.equal(tunnelFailureRecord.event, 'unexpected_exit');
assert.equal(tunnelFailureRecord.exitCode, 23);
assert.ok(Buffer.byteLength(tunnelFailureRecord.detail ?? '', 'utf8') <= 2048);
assert.ok((await fs.stat(tunnelPaths.failure)).size <= 16_384);
const hostileSecrets = [
  bearerSecret, basicSecret, ngrokSecret, tunnelSecret, urlSecret, 'password@example.invalid',
  launcherTokenSecret,
  shortBearerSecret, digestSecret, shortBasicSecret, tokenSchemeSecret, apiKeySecret,
  shortCodexToken, shortCliToken, shortEqualsToken, shortAuthToken, shortApiKey,
  shortQueryCodexToken, shortQueryToken, shortJsonToken, shortJsonHttpToken, shortYamlToken,
  'sk-ant-abcdefghijklmnopqrstuvwxyz123456', longFieldSecret,
  oversizedBeginningSecret, oversizedEndingSecret, oversizedIncompleteSecret,
  ambiguousDiagnosticSecret, ambiguousPasswordSecret, placeholderLikeCredential, completePrivateBodySecret, fragmentedPrivateBodySecret, multibytePrivateBodySecret, incompletePrivateBodySecret, boundaryPrivateBodySecret
];
assertNoSecrets(tunnelFailureRecord, hostileSecrets, 'persisted tunnel failure');
assertNoSecrets(tunnelFailure.output(), hostileSecrets, 'launcher-visible sanitized diagnostics');
assert.equal(tunnelFailure.output().includes(postBoundaryDiagnostic), true, 'launcher output missed post-boundary stream record');
for (const harmless of redactionParityCases.filter((testCase) => testCase.harmless).map((testCase) => testCase.input)) {
  assert.equal(tunnelFailure.output().includes(harmless), true, `launcher redaction over-redacted harmless expression: ${harmless}`);
}
const emittedDiagnosticRecordBytes = tunnelFailure.output().split(/\r?\n/)
  .filter((line) => line.includes('[cloudflared]'))
  .map((line) => Buffer.byteLength(line, 'utf8'));
for (const bytes of emittedDiagnosticRecordBytes) assert.ok(bytes <= 8_192, `launcher diagnostic record exceeded 8192 bytes: ${bytes}`);
for (const line of tunnelFailure.output().split(/\r?\n/).filter((line) => line.includes('[cloudflared]'))) {
  assert.equal(line.includes('\uFFFD'), false, 'launcher diagnostic record contains a UTF-8 replacement character');
}
const maxObservedDiagnosticRecordBytes = Math.max(0, ...emittedDiagnosticRecordBytes);
console.log(`✓ max observed launcher diagnostic record: ${maxObservedDiagnosticRecordBytes} bytes`);
assert.match(tunnelFailure.output(), /\[cloudflared\].*\[cloudflared diagnostic stream record truncated\]/);
assert.ok(Buffer.byteLength(tunnelFailureRecord.detail ?? '', 'utf8') <= 8_192);
for (const input of launcherParityCorpus) {
  assert.equal(tunnelFailure.output().includes(redactDiagnosticText(input)), true, `launcher/shared redaction parity mismatch for ${input}`);
}
const runtimeEntries = await fs.readdir(tunnelPaths.dir);
assert.equal(runtimeEntries.some((entry) => entry.endsWith('.tmp')), false, `atomic runtime temp file remained: ${runtimeEntries.join(', ')}`);
await assertMissing(tunnelPaths.current, 'tunnel current runtime state');

const tunnelRestartPort = await getFreePort();
const tunnelRestart = launch(tunnelRoot, tunnelHome, tunnelRestartPort, { tunnel: 'none' });
const tunnelRestartRuntime = await waitForJson(tunnelPaths.current, (value) => Number.isInteger(value.runtimePid), 'tunnel restart runtime state');
const tunnelRestartStatus = await callRuntimeStatus(tunnelRestartPort);
assert.equal(tunnelRestartStatus.structured.health, 'healthy');
assert.equal(tunnelRestartStatus.structured.last_failure.component, 'tunnel');
assert.equal(tunnelRestartStatus.structured.last_failure_relation, 'previous');
assert.equal(tunnelRestartStatus.structured.tunnel.type, 'none');
assert.ok(Buffer.byteLength(JSON.stringify(tunnelRestartStatus.structured), 'utf8') <= 16_384);
assert.ok(Buffer.byteLength(tunnelRestartStatus.text, 'utf8') <= 16_384);
assert.ok(Buffer.byteLength(tunnelRestartStatus.structured.last_failure?.detail ?? '', 'utf8') <= 8_192);
assertNoSecrets(tunnelRestartStatus, [...hostileSecrets, 'task003-http-token-1234567890'], 'returned tunnel diagnostics');
const persistedRuntime = await fs.readFile(tunnelPaths.current, 'utf8');
assertNoSecrets(persistedRuntime, ['task003-http-token-1234567890', bearerSecret, basicSecret, ngrokSecret, tunnelSecret, urlSecret, 'password@example.invalid'], 'persisted current runtime');
await stopLauncher(tunnelRestart);
assert.equal(tunnelRestartRuntime.runtimePid > 0, true);

const ownershipValidRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-valid-root-'));
const ownershipValidHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-valid-home-'));
const ownershipValidPort = await getFreePort();
const ownershipValid = launchDirectHttp(ownershipValidRoot, ownershipValidHome, ownershipValidPort);
const ownershipValidRunId = 'task003-valid-current-run';
const ownershipValidStartedAt = new Date(Date.now() - 5_000).toISOString();
const historicalFailureSecret = 'task003-historical-failure-secret-1234567890';
const historicalFailureBody = 'task003-historical-private-body-1234567890';
await waitForHttp(ownershipValidPort);
await writeRuntimeFixture(ownershipValidHome, ownershipValidRoot, {
  pid: process.pid,
  runtimePid: ownershipValid.child.pid,
  runId: ownershipValidRunId,
  startedAt: ownershipValidStartedAt,
  tunnel: 'none',
  tunnelStatus: 'disabled'
}, {
  runId: ownershipValidRunId,
  component: 'launcher',
  event: 'startup_failure',
  failedAt: new Date().toISOString(),
  detail: 'TOKEN=' + historicalFailureSecret + '\n-----BEGIN PRIVATE KEY-----\n' + historicalFailureBody + '\n-----END PRIVATE KEY-----\n' + 'x'.repeat(5000)
});
const ownershipValidStatus = await callRuntimeStatus(ownershipValidPort);
assert.equal(ownershipValidStatus.structured.run_id, ownershipValidRunId);
assert.equal(ownershipValidStatus.structured.startup_timestamp, ownershipValidStartedAt);
assert.ok(ownershipValidStatus.structured.uptime_seconds >= 4);
assert.equal(ownershipValidStatus.structured.launcher.status, 'running');
assert.equal(ownershipValidStatus.structured.last_failure_relation, 'current');
assertNoSecrets(ownershipValidStatus, [historicalFailureSecret, historicalFailureBody], 'historical runtime status');
assert.ok(Buffer.byteLength(ownershipValidStatus.structured.last_failure.detail ?? '', 'utf8') <= 2_048);
const historicalFailureFile = await fs.readFile(runtimePaths(ownershipValidHome, await fs.realpath(ownershipValidRoot)).failure, 'utf8');
assert.equal(historicalFailureFile.includes(historicalFailureSecret), true, 'runtime_status rewrote historical failure unexpectedly');
await stopLauncher(ownershipValid);

const ownershipDeadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-dead-root-'));
const ownershipDeadHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-dead-home-'));
const ownershipDeadPort = await getFreePort();
const ownershipDead = launchDirectHttp(ownershipDeadRoot, ownershipDeadHome, ownershipDeadPort);
await waitForHttp(ownershipDeadPort);
await writeRuntimeFixture(ownershipDeadHome, ownershipDeadRoot, {
  pid: 2_147_483_647,
  runtimePid: ownershipDead.child.pid,
  runId: 'task003-dead-launcher-run',
  startedAt: '2000-01-01T00:00:00.000Z',
  tunnel: 'none',
  tunnelStatus: 'disabled'
}, {
  runId: 'task003-dead-launcher-run',
  component: 'http_child',
  event: 'unexpected_exit',
  failedAt: new Date().toISOString()
});
const ownershipDeadStatus = await callRuntimeStatus(ownershipDeadPort);
assert.equal(ownershipDeadStatus.structured.run_id, null);
assert.equal(ownershipDeadStatus.structured.startup_timestamp, null);
assert.notEqual(ownershipDeadStatus.structured.last_failure_relation, 'current');
await stopLauncher(ownershipDead);

const ownershipUnrelatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-unrelated-root-'));
const ownershipUnrelatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-unrelated-home-'));
const ownershipUnrelatedPort = await getFreePort();
const unrelatedLive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });
const ownershipUnrelated = launchDirectHttp(ownershipUnrelatedRoot, ownershipUnrelatedHome, ownershipUnrelatedPort);
await waitForHttp(ownershipUnrelatedPort);
await writeRuntimeFixture(ownershipUnrelatedHome, ownershipUnrelatedRoot, {
  pid: unrelatedLive.pid,
  runtimePid: ownershipUnrelated.child.pid,
  runId: 'task003-unrelated-live-run',
  startedAt: '2000-01-01T00:00:00.000Z',
  tunnel: 'none',
  tunnelStatus: 'disabled'
}, {
  runId: 'task003-unrelated-live-run',
  component: 'tunnel',
  event: 'unexpected_exit',
  failedAt: new Date().toISOString()
});
const ownershipUnrelatedStatus = await callRuntimeStatus(ownershipUnrelatedPort);
assert.equal(ownershipUnrelatedStatus.structured.run_id, null);
assert.equal(ownershipUnrelatedStatus.structured.startup_timestamp, null);
assert.ok(ownershipUnrelatedStatus.structured.uptime_seconds < 60);
assert.equal(ownershipUnrelatedStatus.structured.launcher.status, 'unknown');
assert.notEqual(ownershipUnrelatedStatus.structured.last_failure_relation, 'current');
await stopLauncher(ownershipUnrelated);
unrelatedLive.kill('SIGTERM');
await waitForClose(unrelatedLive);

const ownershipMismatchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-mismatch-root-'));
const ownershipMismatchHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-task003-owner-mismatch-home-'));
const ownershipMismatchPort = await getFreePort();
const mismatchLive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });
const ownershipMismatch = launchDirectHttp(ownershipMismatchRoot, ownershipMismatchHome, ownershipMismatchPort);
await waitForHttp(ownershipMismatchPort);
await writeRuntimeFixture(ownershipMismatchHome, ownershipMismatchRoot, {
  pid: process.pid,
  runtimePid: mismatchLive.pid,
  runId: 'task003-pid-reuse-run',
  startedAt: '2000-01-01T00:00:00.000Z',
  tunnel: 'none',
  tunnelStatus: 'disabled'
}, {
  runId: 'task003-pid-reuse-run',
  component: 'http_child',
  event: 'unexpected_exit',
  failedAt: new Date().toISOString()
});
const ownershipMismatchStatus = await callRuntimeStatus(ownershipMismatchPort);
assert.equal(ownershipMismatchStatus.structured.run_id, null);
assert.equal(ownershipMismatchStatus.structured.startup_timestamp, null);
assert.ok(ownershipMismatchStatus.structured.uptime_seconds < 60);
assert.notEqual(ownershipMismatchStatus.structured.last_failure_relation, 'current');
await stopLauncher(ownershipMismatch);
mismatchLive.kill('SIGTERM');
await waitForClose(mismatchLive);

console.log('✓ runtime diagnostics smoke test passed');
