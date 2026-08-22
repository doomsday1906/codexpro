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
  if ((options.tunnel ?? 'none') === 'none') args.push('--no-auth');
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
const fakeTunnel = await writeExecutable(path.join(tunnelHome, 'fake-cloudflared.mjs'), `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('cloudflared version 2026.7.2'); process.exit(0); }
const noisy = 'apiToken = getToken()\\nAuthorization: Bearer ${bearerSecret}\\nAuthorization: Basic ${basicSecret}\\nAuthorization: Bearer ${shortBearerSecret}\\nAuthorization: Digest ${digestSecret}\\nAuthorization: Basic ${shortBasicSecret}\\nAuthorization: Token ${tokenSchemeSecret}\\nAuthorization: ApiKey ${apiKeySecret}\\nCODEXPRO_HTTP_TOKEN=${shortCodexToken}\\n--token ${shortCliToken}\\n--token=${shortEqualsToken}\\n--auth-token ${shortAuthToken}\\n--api-key ${shortApiKey}\\n?codexpro_token=${shortQueryCodexToken}\\n?token=${shortQueryToken}\\ncloudflared tunnel run --token ${tunnelSecret}\\nngrok config add-authtoken ${ngrokSecret}\\nhttps://${urlSecret}:password@example.invalid/secret\\n' + 'x'.repeat(100000);
process.stderr.write(noisy + '\\n');
process.stdout.write('https://task003-fake.trycloudflare.com\\n');
setTimeout(() => process.exit(23), 700);
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
  shortBearerSecret, digestSecret, shortBasicSecret, tokenSchemeSecret, apiKeySecret,
  shortCodexToken, shortCliToken, shortEqualsToken, shortAuthToken, shortApiKey,
  shortQueryCodexToken, shortQueryToken
];
assertNoSecrets(tunnelFailureRecord, hostileSecrets, 'persisted tunnel failure');
assertNoSecrets(tunnelFailure.output(), hostileSecrets, 'launcher-visible sanitized diagnostics');
assert.equal(tunnelFailure.output().includes('apiToken = getToken()'), true, 'launcher redaction over-redacted harmless source-like assignment');
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
assertNoSecrets(tunnelRestartStatus, [...hostileSecrets, 'task003-http-token-1234567890'], 'returned tunnel diagnostics');
const persistedRuntime = await fs.readFile(tunnelPaths.current, 'utf8');
assertNoSecrets(persistedRuntime, ['task003-http-token-1234567890', bearerSecret, basicSecret, ngrokSecret, tunnelSecret, urlSecret, 'password@example.invalid'], 'persisted current runtime');
await stopLauncher(tunnelRestart);
assert.equal(tunnelRestartRuntime.runtimePid > 0, true);

console.log('✓ runtime diagnostics smoke test passed');
