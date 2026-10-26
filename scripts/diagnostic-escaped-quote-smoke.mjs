import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fakeSk = 'sk-' + 'aB3xK9mQ2pL7vN4zR8tY6wS1uV5wX7';
const metrics = 'tokens:21 token_count:34 max_tokens = 4096';
const escaped = `escaped: \\"${fakeSk}\\"`;

class McpStdioClient {
  constructor(root) {
    this.child = spawn(process.execPath, ['dist/stdio.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_BASH_MODE: 'full',
        CODEXPRO_BASH_TRANSCRIPT: 'full',
        CODEXPRO_TOOL_MODE: 'full',
        CODEXPRO_TOOL_CARDS: '0',
        CODEXPRO_WRITE_MODE: 'workspace'
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

const textOf = (result) => result.content?.find((part) => part.type === 'text')?.text ?? '';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-diagnostic-escaped-'));
const helper = 'diagnostic-escaped-helper.mjs';
await fs.writeFile(path.join(root, helper), [
  `process.stdout.write(${JSON.stringify(`${metrics}\\n${escaped}\\n`)});`,
  `process.stderr.write(${JSON.stringify(`API_KEY="${fakeSk}"\\n`)});`
].join('\n'), 'utf8');

let client;
try {
  client = new McpStdioClient(root);
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'diagnostic-escaped-quote-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
  assert.notEqual(opened.isError, true, `open_current_workspace failed: ${JSON.stringify(opened)}`);
  const workspaceId = opened.structuredContent.workspace_id;

  const diagnostic = await client.request('tools/call', {
    name: 'bash',
    arguments: { workspace_id: workspaceId, command: `${JSON.stringify(process.execPath)} ${helper}`, cwd: '.' }
  });
  assert.notEqual(diagnostic.isError, true, `diagnostic helper failed: ${textOf(diagnostic)}`);
  const payload = JSON.stringify(diagnostic);
  assert.equal(payload.includes(fakeSk), false, 'diagnostic output leaked the fake sk- value');
  const stdout = diagnostic.structuredContent?.stdout ?? '';
  assert.equal(stdout.includes(metrics), true, 'diagnostic output redacted ordinary metrics');
  assert.equal(stdout.includes(`escaped: \\"[REDACTED_SECRET]\\"`), true, 'escaped-quote span was not masked exactly');
  assert.equal(stdout.replace('[REDACTED_SECRET]', fakeSk).includes(metrics), true, 'masking changed the ordinary metric text');
  assert.equal(diagnostic.structuredContent?.stderr.includes('API_KEY="[REDACTED_SECRET]"'), true, 'stderr value span was not masked exactly');

  const writeRefusal = await client.request('tools/call', {
    name: 'write',
    arguments: { workspace_id: workspaceId, path: 'refused.txt', content: `const x = 1;\nconst API_KEY = "${fakeSk}";\n` }
  });
  assert.equal(writeRefusal.isError, true, 'fake sk- write was not refused');
  const message = textOf(writeRefusal);
  assert.match(message, /refused\.txt: source line 2, column 18 to source line 2, column 51 \(end exclusive\)/);
  assert.match(message, /Replace the literal with an env lookup/);
  assert.doesNotMatch(message, /blocked|forbidden|denied|bypass|violation/iu);
  assert.equal(JSON.stringify(writeRefusal).includes(fakeSk), false, 'refusal leaked the fake sk- value');
  assert.equal(await fs.access(path.join(root, 'refused.txt')).then(() => true).catch(() => false), false, 'refused write created its file');

  const metricsWrite = await client.request('tools/call', {
    name: 'write',
    arguments: { workspace_id: workspaceId, path: 'metrics.txt', content: 'tokens: 21\ntoken_count: 34\nmax_tokens = 4096\nsecretName: build\n' }
  });
  assert.notEqual(metricsWrite.isError, true, `ordinary metrics write was refused: ${textOf(metricsWrite)}`);
  console.log('DIAGNOSTIC_ESCAPED_QUOTE PASS: metrics stay visible; fake sk- masked/refused with exact span and next step.');
} finally {
  if (client) await client.close();
  await fs.rm(root, { recursive: true, force: true });
}
