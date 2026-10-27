import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  hasSecretValue,
  scanSecretValues,
  redactSensitiveText,
  redactSensitiveTextPreservingLines,
  redactDiagnosticText,
  redactSearchQuery,
  redactUnifiedDiff
} = await import('../dist/redact.js');

const SK = 'sk-' + 'aB3xK9mQ2pL7vN4zR8tY6wS1';
const SK_ANT = 'sk-ant-' + 'Z9yX8wV7uT6sR5qP4oN3m';
const GHP = 'ghp_' + 'C4mPaIgN9sToRaGe7pIpElInE2xY8';
const GHO = 'gho_' + 'C4mPaIgN9sToRaGe7pIpElInE2xY8';
const GHS = 'ghs_' + 'C4mPaIgN9sToRaGe7pIpElInE2xY8';
const GHR = 'ghr_' + 'C4mPaIgN9sToRaGe7pIpElInE2xY8';
const GHU = 'ghu_' + 'C4mPaIgN9sToRaGe7pIpElInE2xY8';
const GITHUB_PAT = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5';
const NPM = 'npm_' + 'pQ7rS8tU9vW0xY1zA2bC3dE4f';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.' + 'c2lnbmF0dXJlMTIzNDU2Nzg5MA';
const HIGH_ENTROPY = 'aB3xK9mQ2pL7vN4zR8tY6wS1';
const PEM_BODY = 'MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA';
const PEM_END_BODY = 'Q2FtcGFpZ25TdG9yYWdlVG9wb2xvZ3k=';

function numbered(text, startLine = 1) {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`).join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stripLineNumbers(text) {
  return text.split('\n').map((line) => line.replace(/^\s*\d+\s\|\s?/u, '')).join('\n');
}

function assertSuccess(result, label) {
  assert.notEqual(result.isError, true, `${label} failed: ${result.content?.[0]?.text ?? JSON.stringify(result)}`);
  return result;
}

function assertFailure(result, label) {
  assert.equal(result.isError, true, `${label} unexpectedly succeeded: ${result.content?.[0]?.text ?? JSON.stringify(result)}`);
  return result;
}

function resultText(result) {
  return result.content?.find((part) => part.type === 'text')?.text ?? '';
}

function assertReadMetadata(result, source, startLine, endLine, label) {
  const lines = source.split('\n');
  const start = startLine;
  const end = endLine ?? lines.length;
  assert.equal(result.structuredContent.startLine, start, `${label} changed first line`);
  assert.equal(result.structuredContent.endLine, end, `${label} changed last line`);
  assert.equal(result.structuredContent.totalLines, lines.length, `${label} changed total line count`);
  assert.equal(result.structuredContent.bytes, Buffer.byteLength(source, 'utf8'), `${label} changed byte metadata`);
  assert.equal(result.structuredContent.sha256, sha256(source), `${label} changed SHA-256 metadata`);
  assert.equal(result.structuredContent.truncated, start > 1 || end < lines.length, `${label} changed truncation invariant`);
}

class McpStdioClient {
  constructor(root) {
    this.child = spawn(process.execPath, ['dist/stdio.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_BASH_MODE: 'off',
        CODEXPRO_WRITE_MODE: 'workspace',
        CODEXPRO_TOOL_MODE: 'full',
        CODEXPRO_TOOL_CARDS: '0',
        CODEXPRO_ANALYSIS: '0'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk); });
    this.child.on('exit', (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}\n${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      this.child.once('close', resolve);
      this.child.kill('SIGTERM');
    });
  }
}

// --- Shape detector: known secret values and exact spans -------------------
const positiveCases = [
  ['sk', `const API_KEY = "${SK}";`, SK],
  ['sk-ant', `token: ${SK_ANT}`, SK_ANT],
  ['ghp', `GH_TOKEN=${GHP}`, GHP],
  ['gho', `AUTH=${GHO}`, GHO],
  ['ghs', `AUTH=${GHS}`, GHS],
  ['ghr', `AUTH=${GHR}`, GHR],
  ['ghu', `AUTH=${GHU}`, GHU],
  ['github_pat', `GITHUB_TOKEN=${GITHUB_PAT}`, GITHUB_PAT],
  ['npm', `NPM_TOKEN=${NPM}`, NPM],
  ['jwt', `const session = "${JWT}";`, JWT],
  ['url password', 'https://user:supersecret123@example.com/path', 'supersecret123'],
  ['empty-user URL password', 'redis://:supersecret123@example.com:6379/0', 'supersecret123'],
  ['symbol password', 'const password = "aB3xK9!mQ2pL7@vN4zR8#tY6wS1$";', 'aB3xK9!mQ2pL7@vN4zR8#tY6wS1$'],
  ['hex API key', 'const API_KEY = "9f4c1e7a2b8d3c6f0a5e8b1d4c7f2a9e";', '9f4c1e7a2b8d3c6f0a5e8b1d4c7f2a9e'],
  ['UUID API key', 'const API_KEY = "550e8400-e29b-41d4-a716-446655440000";', '550e8400-e29b-41d4-a716-446655440000'],
  ['unquoted YAML password', `password: ${HIGH_ENTROPY}`, HIGH_ENTROPY],
  ['unquoted env API key', `API_KEY=${HIGH_ENTROPY}`, HIGH_ENTROPY],
  ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345', 'abcdefghijklmnopqrstuvwxyz012345'],
  ['json credential name', `{"secretName": "${HIGH_ENTROPY}"}`, HIGH_ENTROPY],
  ['typed credential name', `const apiKey: string = "${HIGH_ENTROPY}";`, HIGH_ENTROPY],
  ['yaml credential name', `password: "${HIGH_ENTROPY}"`, HIGH_ENTROPY],
  ['env-style credential name', `API_KEY="${HIGH_ENTROPY}"`, HIGH_ENTROPY]
];
for (const [label, source, secret] of positiveCases) {
  const scan = scanSecretValues(source);
  const span = scan.spans.find((entry) => source.slice(entry.start, entry.end) === secret);
  assert.ok(span, `${label} value was not classified`);
  assert.equal(redactSensitiveText(source).includes(secret), false, `${label} value leaked`);
  assert.equal(redactSensitiveText(source).includes('[REDACTED_SECRET]'), true, `${label} omitted its marker`);
  const redacted = redactSensitiveText(source);
  assert.equal(redacted.replace('[REDACTED_SECRET]', secret), source, `${label} changed text outside the matched span`);
}

const privateKeyCases = [
  'PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'DSA PRIVATE KEY',
  'OPENSSH PRIVATE KEY',
  'PGP PRIVATE KEY BLOCK'
];
for (const label of privateKeyCases) {
  const complete = `before\n-----BEGIN ${label}-----\n${PEM_BODY}\n${PEM_END_BODY}\n-----END ${label}-----\nafter\n`;
  const incomplete = `before\n-----BEGIN ${label}-----\n${PEM_BODY}`;
  assert.equal(hasSecretValue(complete), true, `${label} block was not classified`);
  assert.equal(hasSecretValue(incomplete), true, `${label} incomplete block was not classified`);
  assert.equal(redactSensitiveText(complete).includes(PEM_BODY), false, `${label} body leaked`);
  assert.equal(redactSensitiveText(incomplete).includes(PEM_BODY), false, `${label} incomplete body leaked`);
  assert.equal(redactSensitiveText(complete).startsWith('before\n[REDACTED_PRIVATE_KEY]\nafter\n'), true, `${label} hid surrounding text`);
}
assert.equal(redactSensitiveText('-----BEGIN PUBLIC KEY-----\nPUBLIC_BODY\n-----END PUBLIC KEY-----'), '-----BEGIN PUBLIC KEY-----\nPUBLIC_BODY\n-----END PUBLIC KEY-----');
assert.equal(hasSecretValue('-----BEGIN CERTIFICATE-----\nCERT_BODY\n-----END CERTIFICATE-----'), false);

const harmlessCases = [
  ['tokens metric', 'tokens: 21'],
  ['token_count metric', 'token_count: 34'],
  ['max_tokens metric', 'max_tokens = 4096'],
  ['json secretName build', '{"secretName": "build"}'],
  ['boolean', 'const token = true;'],
  ['short word', 'const apiKey = "primary";'],
  ['identifier', 'const BUILD_TOKEN = CAMPAIGN_STORAGE_TOPOLOGY_PIPELINE_V2;'],
  ['declared identifier value', 'const API_KEY = someLongCamelCaseIdentifierName123;'],
  ['call', 'const TOKEN = getToken(CALL_LITERAL_7X9);'],
  ['member call', 'PASSWORD = credentials.getPassword();'],
  ['env lookup', 'const API_KEY = process.env.API_KEY;'],
  ['long env lookup', 'API_TOKEN = process.env.CAMPAIGN_STORAGE_TOPOLOGY_PIPELINE;'],
  ['annotation', 'const token: Token<string> = getToken();'],
  ['typed annotation', 'def run(token: Token[str]) -> Token[str]: return token'],
  ['generic annotation index', 'token: Token[ACTUAL_LITERAL_SECRET_7X9]'],
  ['generic annotation angle', 'const token: Token<ACTUAL_LITERAL_SECRET_7X9> = getToken();'],
  ['placeholder', 'API_KEY = "replace-with-long-random-token";'],
  ['placeholder sk', 'API_KEY = "sk-your-api-key-here";'],
  ['prose', 'the token count was 34 and the secret name was build'],
  ['prose punctuation', 'const note = "tokens: 21, token_count: 34, max_tokens = 4096!";'],
  ['non-credential entropy', `const checksum = "${HIGH_ENTROPY}";`],
  ['private key path', 'const PRIVATE_KEY_PATH = "/home/andrew/.ssh/id_rsa";'],
  ['digest auth', 'Authorization: Digest abcdefghijklmnopqrstuvwxyz012345'],
  ['invalid python', 'def incomplete(:\n    pass\n']
];
for (const [label, source] of harmlessCases) {
  assert.equal(hasSecretValue(source), false, `${label} was incorrectly classified as a secret`);
  assert.equal(redactSensitiveText(source), source, `${label} was incorrectly redacted`);
  if (label === 'digest auth') {
    // W-135: source stays readable for Digest, but diagnostics must mask Authorization values.
    const masked = redactDiagnosticText(source);
    assert.equal(masked.includes('abcdefghijklmnopqrstuvwxyz012345'), false, `${label} diagnostic leaked its credential`);
    assert.equal(masked.includes('[REDACTED_SECRET]'), true, `${label} diagnostic omitted its marker`);
  } else {
    assert.equal(redactDiagnosticText(source), source, `${label} diagnostic text was incorrectly redacted`);
  }
}
// W-135: typed JSON credential must mask in diagnostics even when source preserves a short ordinary value.
assert.equal(hasSecretValue('{"API_TOKEN":"QZ7"}'), false, 'short JSON credential was incorrectly classified as a source secret');
assert.equal(redactSensitiveText('{"API_TOKEN":"QZ7"}'), '{"API_TOKEN":"QZ7"}', 'short JSON credential source was incorrectly redacted');
{
  const maskedJson = redactDiagnosticText('{"API_TOKEN":"QZ7"}');
  assert.equal(maskedJson.includes('QZ7'), false, 'short JSON credential leaked in diagnostics');
  assert.equal(maskedJson.includes('[REDACTED_SECRET]'), true, 'short JSON credential diagnostic omitted its marker');
  assert.deepEqual(JSON.parse(maskedJson), { API_TOKEN: '[REDACTED_SECRET]' }, 'short JSON credential diagnostic is not parseable honest metadata');
}
assert.equal(redactSearchQuery('tokens: 21'), 'tokens: 21');
assert.equal(redactSearchQuery('token_count: 34'), 'token_count: 34');
assert.equal(redactSearchQuery(SK), '[REDACTED_SECRET]');

const exactLine = `const API_KEY = "${SK}"; const tokenCount = 21;`;
assert.equal(redactSensitiveText(exactLine), 'const API_KEY = "[REDACTED_SECRET]"; const tokenCount = 21;');
assert.equal(redactSensitiveText('https://user:supersecret123@example.com/path'), 'https://user:[REDACTED_SECRET]@example.com/path');
assert.equal(redactSensitiveText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'), 'Authorization: Bearer [REDACTED_SECRET]');
assert.equal(redactDiagnosticText('plain log Authorization: Bearer abc.def.ghi and done'),
  'plain log Authorization: [REDACTED_SECRET] and done');
const lawfulDiagnostic = { usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, tokens: 9,
  inputTokenCount: 120, token_usage: 150 }, bashSessionId: 'bs_123', sessionId: 'abc', session_count: 3 };
assert.deepEqual(JSON.parse(redactDiagnosticText(JSON.stringify(lawfulDiagnostic))), lawfulDiagnostic);
for (const key of ['input_tokens', 'inputTokenCount', 'token_usage', 'api_key', 'password', 'sessionId']) {
  const value = key === 'sessionId' ? SK : 'opaque-credential';
  assert.ok(!redactDiagnosticText(JSON.stringify({ [key]: value })).includes(value), `${key} secret must stay masked`);
}

assert.equal(redactSensitiveTextPreservingLines(`a\nconst API_KEY = "${SK}";\nb\n`), 'a\nconst API_KEY = "[REDACTED_SECRET]";\nb\n');
const diffSource = [
  'diff --git a/app.js b/app.js',
  '--- a/app.js',
  '+++ b/app.js',
  '@@ -1,2 +1,2 @@',
  '-const tokens = 21;',
  `-const API_KEY = "${SK}";`,
  '+const tokens = 34;',
  ''
].join('\n');
const redactedDiff = redactUnifiedDiff(diffSource);
assert.equal(redactedDiff.includes(SK), false, 'unified diff leaked the secret');
assert.equal(redactedDiff.includes('+const tokens = 34;'), true, 'unified diff hid an ordinary metric line');
assert.equal(redactedDiff.includes('[REDACTED_SECRET]'), true, 'unified diff omitted the marker');

// --- Normal MCP route: read, write, edit, apply_patch, search, git diff ----
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-source-shapes-'));
let client;
try {
  const metricsSource = [
    'tokens: 21',
    'token_count: 34',
    'max_tokens = 4096',
    'secretName: build',
    'const token: Token<string> = getToken();',
    'const token: Token<ACTUAL_LITERAL_SECRET_7X9> = getToken();',
    'const token = values[ACTUAL_LITERAL_SECRET_7X9];',
    'const BUILD_TOKEN = CAMPAIGN_STORAGE_TOPOLOGY_PIPELINE_V2;',
    ''
  ].join('\n');
  const secretSource = [
    'const before = 1;',
    `const API_KEY = "${SK}";`,
    'const URL = "https://user:supersecret123@example.com/path";',
    'const AUTH = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345";',
    'const after = 2;',
    ''
  ].join('\n');
  const pemSource = ['before', '-----BEGIN RSA PRIVATE KEY-----', PEM_BODY, PEM_END_BODY, '-----END RSA PRIVATE KEY-----', 'after', ''].join('\n');
  const pythonSource = ['class Generic:', '    token: Token[ACTUAL_LITERAL_SECRET_7X9]', '    value: str', '', 'token = values[ACTUAL_LITERAL_SECRET_7X9]', ''].join('\n');
  const identText = 'const API_KEY = someLongCamelCaseIdentifierName123;\n';
  const envText = `API_KEY=${HIGH_ENTROPY}\n`;
  const ymlText = `password: ${HIGH_ENTROPY}\n`;
  const envSemicolonText = `API_KEY=${HIGH_ENTROPY};\n`;
  const ymlSemicolonText = `password: ${HIGH_ENTROPY};\n`;
  const bareText = `API_KEY=${HIGH_ENTROPY}\n`;
  const jsonSource = '{"secretName":"build","token_count":34,"max_tokens":4096}\n';
  await fs.writeFile(path.join(tmp, 'metrics.ts'), metricsSource);
  await fs.writeFile(path.join(tmp, 'secret.ts'), secretSource);
  await fs.writeFile(path.join(tmp, 'private-key.txt'), pemSource);
  await fs.writeFile(path.join(tmp, 'generic.py'), pythonSource);
  await fs.writeFile(path.join(tmp, 'ident.txt'), identText);
  await fs.writeFile(path.join(tmp, 'config.env'), envText);
  await fs.writeFile(path.join(tmp, 'config.yml'), ymlText);
  await fs.writeFile(path.join(tmp, 'config-semicolon.env'), envSemicolonText);
  await fs.writeFile(path.join(tmp, 'config-semicolon.yml'), ymlSemicolonText);
  await fs.writeFile(path.join(tmp, 'bare.txt'), bareText);
  await fs.writeFile(path.join(tmp, 'obj.json'), jsonSource);
  await fs.writeFile(path.join(tmp, 'edit.ts'), 'const API_KEY = process.env.API_KEY;\nconst marker = 1;\n');
  await fs.writeFile(path.join(tmp, 'git-target.ts'), 'const tokens = 21;\nconst API_KEY = process.env.API_KEY;\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'source-shapes@example.com'],
    ['config', 'user.name', 'Source Shapes'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'fixture']
  ]) {
    const git = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
    assert.equal(git.status, 0, `git ${args.join(' ')} failed: ${git.stderr}`);
  }

  client = new McpStdioClient(tmp);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-source-shapes-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  const opened = assertSuccess(await client.request('tools/call', {
    name: 'open_current_workspace', arguments: { include_tree: false }
  }), 'open_current_workspace');
  const workspaceId = opened.structuredContent.workspace_id;
  const call = (name, args) => client.request('tools/call', { name, arguments: { workspace_id: workspaceId, ...args } });

  const metricsRead = assertSuccess(await call('read', { path: 'metrics.ts' }), 'metrics read');
  assertReadMetadata(metricsRead, metricsSource, 1, undefined, 'metrics read');
  assert.equal(metricsRead.structuredContent.text, numbered(metricsSource), 'metrics read changed exact source');
  assert.equal(JSON.stringify(metricsRead).includes('[REDACTED_SECRET]'), false, 'metrics read redacted ordinary values');
  for (const marker of ['tokens: 21', 'token_count: 34', 'max_tokens = 4096', 'secretName: build', 'Token<string>', 'getToken()', 'CAMPAIGN_STORAGE_TOPOLOGY_PIPELINE_V2']) {
    assert.equal(resultText(metricsRead).includes(marker), true, `metrics read hid ${marker}`);
  }

  const metricsRange = assertSuccess(await call('read', { path: 'metrics.ts', start_line: 2, end_line: 4 }), 'metrics range');
  assertReadMetadata(metricsRange, metricsSource, 2, 4, 'metrics range');
  assert.equal(metricsRange.structuredContent.text, numbered(metricsSource.split('\n').slice(1, 4).join('\n'), 2), 'metrics range changed exact projection');

  const secretRead = assertSuccess(await call('read', { path: 'secret.ts' }), 'secret read');
  assertReadMetadata(secretRead, secretSource, 1, undefined, 'secret read');
  assert.equal(JSON.stringify(secretRead).includes(SK), false, 'secret read leaked a known token');
  assert.equal(JSON.stringify(secretRead).includes('supersecret123'), false, 'secret read leaked a URL password');
  assert.equal(JSON.stringify(secretRead).includes('abcdefghijklmnopqrstuvwxyz012345'), false, 'secret read leaked a Bearer value');
  assert.equal(secretRead.structuredContent.text, numbered([
    'const before = 1;',
    'const API_KEY = "[REDACTED_SECRET]";',
    'const URL = "https://user:[REDACTED_SECRET]@example.com/path";',
    'const AUTH = "Authorization: Bearer [REDACTED_SECRET]";',
    'const after = 2;',
    ''
  ].join('\n')), 'secret read did not mask exactly the matched spans');

  const pemRead = assertSuccess(await call('read', { path: 'private-key.txt' }), 'private-key read');
  assert.equal(JSON.stringify(pemRead).includes(PEM_BODY), false, 'private-key read leaked its body');
  assert.equal(JSON.stringify(pemRead).includes(PEM_END_BODY), false, 'private-key read leaked its tail body');
  assert.equal(resultText(pemRead).includes('[REDACTED_PRIVATE_KEY]'), true, 'private-key read omitted its marker');
  assert.equal(resultText(pemRead).includes('before'), true, 'private-key read hid surrounding text');

  const pyRead = assertSuccess(await call('read', { path: 'generic.py' }), 'python generic read');
  assert.equal(JSON.stringify(pyRead).includes('[REDACTED_SECRET]'), false, 'python generic annotation was redacted');
  assert.equal(pyRead.structuredContent.text, numbered(pythonSource), 'python generic annotation read changed source');
  assert.equal(resultText(pyRead).includes('token: Token[ACTUAL_LITERAL_SECRET_7X9]'), true, 'python generic annotation hidden');

  const identRead = assertSuccess(await call('read', { path: 'ident.txt' }), 'declared identifier text read');
  assert.equal(identRead.structuredContent.text, numbered(identText), 'declared identifier text read changed source');
  assert.equal(JSON.stringify(identRead).includes('someLongCamelCaseIdentifierName123'), true, 'declared identifier value was redacted');
  assert.equal(JSON.stringify(identRead).includes('[REDACTED_SECRET]'), false, 'declared identifier text read masked an ordinary value');

  const envRead = assertSuccess(await call('read', { path: 'config.env' }), 'env scalar read');
  assert.equal(JSON.stringify(envRead).includes(HIGH_ENTROPY), false, 'env bare high-entropy scalar leaked');
  assert.equal(resultText(envRead).includes('[REDACTED_SECRET]'), true, 'env bare high-entropy scalar was not masked');

  const envSemicolonRead = assertSuccess(await call('read', { path: 'config-semicolon.env' }), 'env semicolon scalar read');
  assert.equal(JSON.stringify(envSemicolonRead).includes(HIGH_ENTROPY), false, 'env bare high-entropy scalar with semicolon leaked');
  assert.equal(resultText(envSemicolonRead).includes('[REDACTED_SECRET];'), true, 'env bare high-entropy scalar with semicolon was not masked');

  const ymlRead = assertSuccess(await call('read', { path: 'config.yml' }), 'YAML scalar read');
  assert.equal(JSON.stringify(ymlRead).includes(HIGH_ENTROPY), false, 'YAML bare high-entropy scalar leaked');
  assert.equal(resultText(ymlRead).includes('[REDACTED_SECRET]'), true, 'YAML bare high-entropy scalar was not masked');

  const ymlSemicolonRead = assertSuccess(await call('read', { path: 'config-semicolon.yml' }), 'YAML semicolon scalar read');
  assert.equal(JSON.stringify(ymlSemicolonRead).includes(HIGH_ENTROPY), false, 'YAML bare high-entropy scalar with semicolon leaked');
  assert.equal(resultText(ymlSemicolonRead).includes('[REDACTED_SECRET];'), true, 'YAML bare high-entropy scalar with semicolon was not masked');

  const bareRead = assertSuccess(await call('read', { path: 'bare.txt' }), 'unknown bare scalar read');
  assert.equal(JSON.stringify(bareRead).includes(HIGH_ENTROPY), false, 'unknown bare high-entropy scalar leaked');
  assert.equal(resultText(bareRead).includes('[REDACTED_SECRET]'), true, 'unknown bare high-entropy scalar was not masked');

  const many = assertSuccess(await call('read_many', { items: [{ path: 'metrics.ts' }, { path: 'secret.ts' }] }), 'read_many');
  assert.deepEqual(many.structuredContent.results.map((item) => item.path), ['metrics.ts', 'secret.ts'], 'read_many changed item order');
  assert.equal(many.structuredContent.results[0].result.text, numbered(metricsSource), 'read_many changed metrics projection');
  assert.equal(many.structuredContent.results[1].result.text, secretRead.structuredContent.text, 'read_many changed masked projection');
  assert.equal(JSON.stringify(many).includes(SK), false, 'read_many leaked a known token');

  const metricSearch = assertSuccess(await call('search', { query: 'token_count: 34' }), 'metrics search');
  assert.equal(metricSearch.structuredContent.matches.length, 1, 'metrics search lost its match');
  assert.equal(metricSearch.structuredContent.matches[0].text, 'token_count: 34', 'metrics search changed match text');
  assert.equal(metricSearch.structuredContent.analysis?.query ?? 'token_count: 34', 'token_count: 34', 'metrics search redacted its query');

  const secretSearch = assertSuccess(await call('search', { query: SK }), 'secret search');
  assert.equal(JSON.stringify(secretSearch).includes(SK), false, 'secret search echoed its query or match');
  const secretLineSearch = assertSuccess(await call('search', { query: 'API_KEY' }), 'secret line search');
  assert.equal(JSON.stringify(secretLineSearch).includes(SK), false, 'secret line search leaked the matching value');
  assert.equal(secretLineSearch.structuredContent.matches.some((match) => match.text === 'const API_KEY = "[REDACTED_SECRET]";'), true, 'secret line search did not mask only the matched span');

  for (const [index, [label, source, secret]] of positiveCases.entries()) {
    const target = `shaped-${index}.txt`;
    const refusal = assertFailure(await call('write', { path: target, content: source }), `${label} write`);
    assert.equal(await fs.access(path.join(tmp, target)).then(() => true).catch(() => false), false, `${label} created a file`);
    assert.equal(JSON.stringify(refusal).includes(secret), false, `${label} refusal echoed its literal`);
    await fs.writeFile(path.join(tmp, target), source);
    const projected = assertSuccess(await call('read', { path: target }), `${label} read`);
    assert.equal(JSON.stringify(projected).includes(secret), false, `${label} read leaked its literal`);
  }

  const metricsWrite = assertSuccess(await call('write', { path: 'written-metrics.ts', content: metricsSource }), 'metrics write');
  assert.equal(metricsWrite.structuredContent.bytes, Buffer.byteLength(metricsSource, 'utf8'), 'metrics write changed byte count');
  assert.equal(await fs.readFile(path.join(tmp, 'written-metrics.ts'), 'utf8'), metricsSource, 'metrics write changed bytes on disk');
  assert.equal(JSON.stringify(metricsWrite).includes('[REDACTED_SECRET]'), false, 'metrics write redacted ordinary values');

  const jsonWrite = assertSuccess(await call('write', { path: 'written.json', content: jsonSource }), 'JSON secretName build write');
  assert.equal(await fs.readFile(path.join(tmp, 'written.json'), 'utf8'), jsonSource, 'JSON secretName build changed bytes');

  const benignWrite = await call('write', {
    path: 'benign.ts',
    content: 'const TOKEN = getToken();\nconst token: Token<string> = getToken();\nconst API_KEY = process.env.API_KEY;\n'
  });
  assert.notEqual(benignWrite.isError, true, 'ordinary call/annotation/env write was refused');

  const pySecretWrite = assertFailure(await call('write', {
    path: 'py-secret.py',
    content: `token = "${SK}"\n`
  }), 'python quoted secret write');
  assert.match(resultText(pySecretWrite), /Replace the literal with an env lookup/, 'python quoted secret write omitted next action');

  const pyWrite = assertSuccess(await call('write', { path: 'generic-written.py', content: pythonSource }), 'python generic write');
  assert.equal(JSON.stringify(pyWrite).includes('[REDACTED_SECRET]'), false, 'python generic write redacted annotation');
  assert.equal(await fs.readFile(path.join(tmp, 'generic-written.py'), 'utf8'), pythonSource, 'python generic write changed bytes');

  const envWrite = assertFailure(await call('write', { path: 'written.env', content: envText }), 'env bare high-entropy write');
  assert.match(resultText(envWrite), /Replace the literal with an env lookup/, 'env bare high-entropy write omitted next action');

  const ymlWrite = assertFailure(await call('write', { path: 'written.yml', content: ymlText }), 'YAML bare high-entropy write');
  assert.match(resultText(ymlWrite), /Replace the literal with an env lookup/, 'YAML bare high-entropy write omitted next action');

  const envSemicolonWrite = assertFailure(await call('write', { path: 'written-semicolon.env', content: envSemicolonText }), 'env bare high-entropy semicolon write');
  assert.match(resultText(envSemicolonWrite), /Replace the literal with an env lookup/, 'env bare high-entropy semicolon write omitted next action');

  const ymlSemicolonWrite = assertFailure(await call('write', { path: 'written-semicolon.yml', content: ymlSemicolonText }), 'YAML bare high-entropy semicolon write');
  assert.match(resultText(ymlSemicolonWrite), /Replace the literal with an env lookup/, 'YAML bare high-entropy semicolon write omitted next action');

  const secretWrite = assertFailure(await call('write', {
    path: 'written-secret.ts',
    content: `const x = 1;\nconst API_KEY = "${SK}";\n`
  }), 'secret write');
  const writeMessage = resultText(secretWrite);
  const writeCol = 'const API_KEY = "'.length + 1;
  const writeEndCol = writeCol + SK.length;
  assert.match(writeMessage, new RegExp(`written-secret\\.ts: source line 2, column ${writeCol} to source line 2, column ${writeEndCol} \\(end exclusive\\)`), 'secret write omitted exact line/position');
  assert.match(writeMessage, /write was not applied/, 'secret write omitted the fact');
  assert.match(writeMessage, /Replace the literal with an env lookup/, 'secret write omitted the next action');
  assert.doesNotMatch(writeMessage, /blocked|forbidden|denied|bypass|violation/iu, 'secret write used an alarm word');
  assert.equal(JSON.stringify(secretWrite).includes(SK), false, 'secret write echoed the secret');
  assert.equal(await fs.access(path.join(tmp, 'written-secret.ts')).then(() => true).catch(() => false), false, 'refused write created the file');

  const pemWrite = assertFailure(await call('write', { path: 'written-key.txt', content: pemSource }), 'private-key write');
  assert.equal(JSON.stringify(pemWrite).includes(PEM_BODY), false, 'private-key write echoed its body');
  assert.match(resultText(pemWrite), /Replace the literal with an env lookup/, 'private-key write omitted the next action');

  const editRemove = assertSuccess(await call('edit', {
    path: 'edit.ts',
    old_text: 'const API_KEY = process.env.API_KEY;',
    new_text: 'const API_KEY = process.env.OTHER_KEY;'
  }), 'env replacement edit');
  assert.equal(await fs.readFile(path.join(tmp, 'edit.ts'), 'utf8'), 'const API_KEY = process.env.OTHER_KEY;\nconst marker = 1;\n', 'env replacement edit changed unexpected bytes');
  assert.equal(editRemove.structuredContent.diff.includes('[REDACTED_SECRET]'), false, 'benign env edit changed its diff');

  const editSecret = assertFailure(await call('edit', {
    path: 'edit.ts',
    old_text: 'const marker = 1;',
    new_text: `const marker = 1;\nconst TOKEN = "${SK}";`
  }), 'secret add edit');
  assert.match(resultText(editSecret), /edit was not applied/, 'secret edit omitted the fact');
  assert.match(resultText(editSecret), /Replace the literal with an env lookup/, 'secret edit omitted the next action');
  assert.equal(await fs.readFile(path.join(tmp, 'edit.ts'), 'utf8'), 'const API_KEY = process.env.OTHER_KEY;\nconst marker = 1;\n', 'refused edit changed bytes');
  assert.equal(JSON.stringify(editSecret).includes(SK), false, 'secret edit echoed the secret');

  const patchRemove = [
    'diff --git a/edit.ts b/edit.ts',
    '--- a/edit.ts',
    '+++ b/edit.ts',
    '@@ -1,2 +1,2 @@',
    '-const API_KEY = process.env.OTHER_KEY;',
    `+const API_KEY = "${SK}";`,
    ' const marker = 1;',
    ''
  ].join('\n');
  const patchRefusal = assertFailure(await call('apply_patch', { patch: patchRemove }), 'secret apply_patch');
  assert.match(resultText(patchRefusal), /source line 1, column 18/, 'secret apply_patch omitted exact line/position');
  assert.match(resultText(patchRefusal), /apply_patch was not applied/, 'secret apply_patch omitted the fact');
  assert.match(resultText(patchRefusal), /Replace the literal with an env lookup/, 'secret apply_patch omitted the next action');
  assert.equal(await fs.readFile(path.join(tmp, 'edit.ts'), 'utf8'), 'const API_KEY = process.env.OTHER_KEY;\nconst marker = 1;\n', 'refused apply_patch changed bytes');
  assert.equal(JSON.stringify(patchRefusal).includes(SK), false, 'secret apply_patch echoed the secret');

  const patchBenign = [
    'diff --git a/edit.ts b/edit.ts',
    '--- a/edit.ts',
    '+++ b/edit.ts',
    '@@ -1,2 +1,2 @@',
    '-const API_KEY = process.env.OTHER_KEY;',
    '+const API_KEY = process.env.THIRD_KEY;',
    ' const marker = 1;',
    ''
  ].join('\n');
  assertSuccess(await call('apply_patch', { patch: patchBenign }), 'benign env apply_patch');
  assert.equal(await fs.readFile(path.join(tmp, 'edit.ts'), 'utf8'), 'const API_KEY = process.env.THIRD_KEY;\nconst marker = 1;\n', 'benign apply_patch changed unexpected bytes');

  await fs.writeFile(path.join(tmp, 'patch-generic.py'), 'class Generic:\n    value: str\n');
  const genericPatch = [
    'diff --git a/patch-generic.py b/patch-generic.py',
    '--- a/patch-generic.py',
    '+++ b/patch-generic.py',
    '@@ -1,2 +1,3 @@',
    ' class Generic:',
    '     value: str',
    '+    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
    ''
  ].join('\n');
  const genericPatchResult = assertSuccess(await call('apply_patch', { patch: genericPatch }), 'generic annotation apply_patch');
  assert.equal(JSON.stringify(genericPatchResult).includes('[REDACTED_SECRET]'), false, 'generic annotation apply_patch redacted');
  assert.equal(await fs.readFile(path.join(tmp, 'patch-generic.py'), 'utf8'), 'class Generic:\n    value: str\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n', 'generic annotation apply_patch changed bytes');

  // Git diff is also a public output surface: only the matched value span is masked.
  await fs.writeFile(path.join(tmp, 'git-target.ts'), `const tokens = 34;\nconst API_KEY = "${SK}";\n`);
  const gitDiff = assertSuccess(await call('git_diff', { path: 'git-target.ts' }), 'git diff');
  assert.equal(gitDiff.structuredContent.diff.includes(SK), false, 'git diff leaked a secret value');
  assert.equal(gitDiff.structuredContent.diff.includes('tokens = 21'), true, 'git diff hid ordinary metrics');
  assert.equal(gitDiff.structuredContent.diff.includes('[REDACTED_SECRET]'), true, 'git diff omitted its marker');

  console.log('SOURCE_REDACTION_SHAPES PASS: ordinary metrics/calls/annotations visible; known values and high-entropy credential literals refused or masked with exact spans and actionable text.');
} finally {
  if (client) await client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
