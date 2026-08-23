import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve('.');
const secrets = ['CALL_LITERAL_7X9', 'ACTUAL_LITERAL'];
const safeStdout = 'TOKEN= [REDACTED_SECRET]';
const safeStderr = 'PASSWORD= [REDACTED_SECRET]';

class McpStdioClient {
  constructor(root, transcript) {
    this.child = spawn(process.execPath, ['dist/stdio.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_BASH_MODE: 'full',
        CODEXPRO_BASH_TRANSCRIPT: transcript,
        CODEXPRO_TOOL_MODE: 'full',
        CODEXPRO_TOOL_CARDS: '0',
        CODEXPRO_WRITE_MODE: 'off'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += String(chunk);
    });
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
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
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
    const request = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
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

function assertNoSecrets(value, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `${label} leaked ${secret}`);
}

async function callBash(root, helperName, transcript) {
  const client = new McpStdioClient(root, transcript);
  const command = `${JSON.stringify(process.execPath)} ${helperName}`;
  try {
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codexpro-diagnostic-output-smoke', version: '0.1.0' }
    });
    client.notify('notifications/initialized');
    const opened = await client.request('tools/call', {
      name: 'open_current_workspace',
      arguments: { include_tree: false }
    });
    assert.notEqual(opened.isError, true, `open_current_workspace failed: ${JSON.stringify(opened)}`);

    const bashArguments = { command, cwd: '.' };
    assertNoSecrets(bashArguments, 'MCP request arguments');
    const result = await client.request('tools/call', { name: 'bash', arguments: bashArguments });
    assert.notEqual(result.isError, true, `${transcript} Bash failed: ${JSON.stringify(result)}`);

    assertNoSecrets(result.content, `${transcript} content`);
    assertNoSecrets(result.structuredContent, `${transcript} structuredContent`);
    assertNoSecrets(result._meta, `${transcript} _meta`);
    assertNoSecrets(result, `${transcript} serialized result`);
    assert.equal(result.structuredContent?.command, command, `${transcript} command field changed unexpectedly`);
    const renderedText = result.content?.find?.((part) => part.type === 'text')?.text ?? '';
    assert.equal(renderedText.includes(command), true, `${transcript} rendered command presentation missing`);
    assert.equal(typeof result.structuredContent?.stdout, 'string', `${transcript} stdout field missing`);
    assert.equal(typeof result.structuredContent?.stderr, 'string', `${transcript} stderr field missing`);
    assert.equal(result.structuredContent.stdout.includes(safeStdout), true, `${transcript} structured stdout lost the safe redacted line`);
    assert.equal(result.structuredContent.stderr.includes(safeStderr), true, `${transcript} structured stderr lost the safe redacted line`);
    if (transcript === 'full') {
      assert.equal(renderedText.includes('## stdout'), true, 'full transcript omitted stdout section');
      assert.equal(renderedText.includes('## stderr'), true, 'full transcript omitted stderr section');
      assert.equal(renderedText.includes(safeStdout), true, 'full transcript omitted the safe stdout line');
      assert.equal(renderedText.includes(safeStderr), true, 'full transcript omitted the safe stderr line');
      assert.equal(renderedText.includes(result.structuredContent.stdout), true, 'full transcript stdout disagrees with structured stdout');
      assert.equal(renderedText.includes(result.structuredContent.stderr), true, 'full transcript stderr disagrees with structured stderr');
    } else {
      assert.equal(renderedText.includes('Raw stdout/stderr are in the structured CodexPro card.'), true, 'compact transcript shape changed');
    }
    return result;
  } finally {
    await client.close();
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-diagnostic-output-'));
const helperName = 'diagnostic-output-helper.mjs';
const fixtureName = 'diagnostic-output-input.txt';
await fs.writeFile(
  path.join(root, fixtureName),
  'TOKEN=getToken(CALL_LITERAL_7X9)\nPASSWORD=readPassword(ACTUAL_LITERAL)\n',
  'utf8'
);
await fs.writeFile(
  path.join(root, helperName),
  [
    "import fs from 'node:fs/promises';",
    `const lines = (await fs.readFile(new URL(${JSON.stringify(fixtureName)}, import.meta.url), 'utf8')).split(/\\r?\\n/).filter(Boolean);`,
    "process.stdout.write(`${lines[0]}\\n`);",
    "process.stderr.write(`${lines[1]}\\n`);"
  ].join('\n'),
  'utf8'
);

await callBash(root, helperName, 'compact');
await callBash(root, helperName, 'full');
console.log('✓ diagnostic Bash output is redacted across compact/full MCP stdio result surfaces');
