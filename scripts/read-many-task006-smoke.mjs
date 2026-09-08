import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited code=${code} signal=${signal ?? 'none'}`));
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
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
}

function assertToolSuccess(result, label) {
  assert.notEqual(result.isError, true, `${label} failed: ${JSON.stringify(result)}`);
  return result;
}

function resultText(result) {
  return result?.content?.[0]?.text ?? '';
}

function expectNoSecret(value, secret, label) {
  assert.equal(JSON.stringify(value).includes(secret), false, `${label} leaked credential-shaped source`);
}

const ordinaryA = 'ordinary page one A\n';
const ordinaryB = 'ordinary page one B\n';
const credentialSource = [
  'class CredentialSource:',
  '    payload = {"token": ACTUAL_LITERAL_SECRET_7X9}',
  '    call_payload = make_call(password=client.getSecret())',
  ...Array.from({ length: 10 }, (_, index) => `    detail_${String(index).padStart(2, '0')} = "bounded ordinary context ${index}"`),
  ''
].join('\n');
const secretLiterals = ['ACTUAL_LITERAL_SECRET_7X9', 'client.getSecret()'];
const maxTotalBytes = 4_000;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-read-many-task006-'));
let client;
try {
  await fs.writeFile(path.join(tmp, 'ordinary-a.txt'), ordinaryA, 'utf8');
  await fs.writeFile(path.join(tmp, 'ordinary-b.txt'), ordinaryB, 'utf8');
  await fs.writeFile(path.join(tmp, 'credential-source.py'), credentialSource, 'utf8');

  client = new McpStdioClient(process.execPath, [
    'dist/stdio.js', '--root', tmp, '--allow-root', tmp,
    '--bash', 'off', '--write', 'off', '--tool-mode', 'full'
  ], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'off',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0'
    }
  });
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-read-many-task006-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const opened = assertToolSuccess(await client.request('tools/call', {
    name: 'open_current_workspace',
    arguments: { include_tree: false }
  }), 'open_current_workspace');
  const workspaceId = opened.structuredContent.workspace_id;

  const ordinaryRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'credential-source.py' }
  }), 'ordinary credential-source read');
  const ordinaryStructuredText = ordinaryRead.structuredContent.text;
  assert.equal(typeof ordinaryStructuredText, 'string', 'ordinary read omitted structured source text');
  assert.equal(ordinaryStructuredText.includes('[REDACTED_SECRET]'), true, 'credential-shaped Python source was not redacted by ordinary read');
  expectNoSecret(ordinaryRead, secretLiterals[0], 'ordinary credential-source read');
  expectNoSecret(ordinaryRead, secretLiterals[1], 'ordinary credential-source read');

  const items = [
    { path: 'ordinary-a.txt' },
    { path: 'ordinary-b.txt' },
    { path: 'credential-source.py' }
  ];
  const pageOne = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, max_total_bytes: maxTotalBytes, items }
  }), 'read_many page one');
  const pageOneResults = pageOne.structuredContent.results ?? [];
  assert.equal(pageOneResults.length, 2, 'read_many page one did not contain both ordinary items');
  assert.deepEqual(pageOneResults.map((item) => ({ index: item.index, path: item.path, ok: item.ok })), [
    { index: 0, path: 'ordinary-a.txt', ok: true },
    { index: 1, path: 'ordinary-b.txt', ok: true }
  ], 'read_many page one changed ordinary global indexes or order');
  assert.equal(pageOne.structuredContent.next_index, 2, 'read_many page one did not point at the credential source global index');
  assert.equal(typeof pageOne.structuredContent.cursor, 'string', 'read_many page one omitted continuation cursor');
  assert.ok(Buffer.byteLength(JSON.stringify(pageOne), 'utf8') <= maxTotalBytes, 'read_many page one exceeded bounded output');
  expectNoSecret(pageOne, secretLiterals[0], 'read_many page one');
  expectNoSecret(pageOne, secretLiterals[1], 'read_many page one');

  const pageTwo = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      max_total_bytes: maxTotalBytes,
      items,
      cursor: pageOne.structuredContent.cursor
    }
  }), 'read_many continued page two');
  const pageTwoResults = pageTwo.structuredContent.results ?? [];
  assert.equal(pageTwoResults.length, 1, 'read_many page two did not contain exactly the remaining item');
  assert.deepEqual(
    { index: pageTwoResults[0].index, path: pageTwoResults[0].path, ok: pageTwoResults[0].ok },
    { index: 2, path: 'credential-source.py', ok: true },
    'read_many page two changed the public global continuation identity'
  );
  assert.equal(pageTwoResults[0].result.text, ordinaryStructuredText, 'continued read_many structured source text diverged from ordinary read');
  assert.equal(pageTwo.structuredContent.next_index, null, 'read_many page two retained an unexpected continuation');
  assert.equal(pageTwo.structuredContent.cursor, null, 'read_many page two retained an unexpected cursor');
  assert.ok(Buffer.byteLength(JSON.stringify(pageTwo), 'utf8') <= maxTotalBytes, 'read_many page two exceeded bounded output');
  expectNoSecret(pageTwo, secretLiterals[0], 'read_many page two');
  expectNoSecret(pageTwo, secretLiterals[1], 'read_many page two');

  console.log('RAW_OBSERVATION: page one contains two ordinary items at global indexes 0 and 1; page two contains the credential-shaped Python source at global index 2.');
  console.log('RAW_OBSERVATION: continued page-two structured result.text is byte-identical to ordinary read structured text; raw credential literals are absent; both serialized pages fit the 4000-byte bound.');
  console.log('PREDICATE: TRUE — page-one response independently exposes next_index=2 and an opaque cursor before continuation evaluation.');
  console.log('SANITY_VERDICT: MATCH — compiled public MCP continuation preserves local source-field projection and global item identity.');
  console.log('read-many-task006-smoke: PASS');
} finally {
  client?.close();
}
