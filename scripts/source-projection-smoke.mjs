import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function rawLines(text) {
  return text.replace(/\r\n/gu, '\n').split('\n');
}

function numbered(lines, startLine = 1) {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`).join('\n');
}

function expectedProjection({ logicalPath, raw, safe, bytes, digest, startLine, endLine }) {
  const sourceLines = rawLines(raw);
  const safeLines = rawLines(safe);
  const start = Math.max(1, Math.floor(startLine ?? 1));
  const end = Math.min(sourceLines.length, Math.floor(endLine ?? sourceLines.length));
  assert.ok(end >= start, 'fixture expected range must be valid');
  return {
    path: logicalPath,
    text: numbered(safeLines.slice(start - 1, end), start),
    startLine: start,
    endLine: end,
    totalLines: sourceLines.length,
    bytes,
    sha256: digest,
    truncated: start > 1 || end < sourceLines.length
  };
}

function projectionFields(value) {
  return {
    path: value.path,
    text: value.text,
    startLine: value.startLine,
    endLine: value.endLine,
    totalLines: value.totalLines,
    bytes: value.bytes,
    sha256: value.sha256,
    truncated: value.truncated
  };
}

function assertProjection(actual, expected, label) {
  assert.deepEqual(projectionFields(actual), expected, `${label} changed projection or metadata`);
}

function expectSafe(value, rawLiterals, label) {
  const serialized = JSON.stringify(value) ?? '';
  for (const literal of rawLiterals) {
    assert.equal(serialized.includes(literal), false, `${label} leaked ${literal}`);
  }
}

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

const privateRaw = [
  'const before = true;',
  '-----BEGIN PRIVATE KEY-----',
  'PRIVATE_BODY_7X9',
  '-----END PRIVATE KEY-----',
  'const after = "π";',
  ''
].join('\n');
const privateSafe = [
  'const before = true;',
  '[REDACTED_PRIVATE_KEY]',
  '[REDACTED_PRIVATE_KEY]',
  '[REDACTED_PRIVATE_KEY]',
  'const after = "π";',
  ''
].join('\n');
const privatePath = 'private-fixture.txt';
const privateBytes = Buffer.byteLength(privateRaw, 'utf8');
const privateDigest = sha256(privateRaw);
const privateLiterals = ['PRIVATE_BODY_7X9', 'PRIVATE KEY'];

// PASS 1 — raw sanity. The complete raw fixture physically contains the
// declaration, body, and closing delimiter. The body-only range does not.
// This predicate is established from raw bytes and is not imported from the
// projector or any implementation-generated classification.
const privateRawParts = rawLines(privateRaw);
assert.equal(privateRawParts[1], '-----BEGIN PRIVATE KEY-----', 'raw fixture lost private-key declaration');
assert.equal(privateRawParts[2], 'PRIVATE_BODY_7X9', 'raw fixture lost private-key body');
assert.equal(privateRawParts[3], '-----END PRIVATE KEY-----', 'raw fixture lost private-key delimiter');
const privateRawPredicate = privateRawParts[1].startsWith('-----BEGIN')
  && privateRawParts[2].includes('PRIVATE_BODY_7X9')
  && privateRawParts[3].startsWith('-----END');
assert.equal(privateRawPredicate, true, 'raw complete snapshot did not independently establish hostile private-key predicate');
console.log('SANITY_VERDICT: MATCH — complete raw snapshot contains declaration/body/delimiter; selected body range excludes declaration and delimiter');
console.log('PREDICATE: TRUE — established from raw fixture lines before projector evaluation');

const { loadConfig } = await import('../dist/config.js');
const { PathGuard, WorkspaceManager } = await import('../dist/guard.js');
const { projectPublicSourceText, readPublicTextFile, readTextFile } = await import('../dist/fsOps.js');

// Direct target evidence: the compiled exported pure projector receives one
// complete snapshot and returns the full and ranged source projections.
assert.equal(typeof projectPublicSourceText, 'function', 'compiled projector is not exported');
const privateFullExpected = expectedProjection({
  logicalPath: privatePath,
  raw: privateRaw,
  safe: privateSafe,
  bytes: privateBytes,
  digest: privateDigest
});
const privateFull = projectPublicSourceText({
  logicalPath: privatePath,
  text: privateRaw,
  bytes: privateBytes,
  sha256: privateDigest
});
assertProjection(privateFull, privateFullExpected, 'direct private full projection');
expectSafe(privateFull, privateLiterals, 'direct private full projection');

const privateBodyExpected = expectedProjection({
  logicalPath: privatePath,
  raw: privateRaw,
  safe: privateSafe,
  bytes: privateBytes,
  digest: privateDigest,
  startLine: 3,
  endLine: 3
});
const privateBody = projectPublicSourceText({
  logicalPath: privatePath,
  text: privateRaw,
  bytes: privateBytes,
  sha256: privateDigest,
  startLine: 3,
  endLine: 3
});
assertProjection(privateBody, privateBodyExpected, 'direct private body-only range');
assert.equal(privateBody.text, '3 | [REDACTED_PRIVATE_KEY]', 'body-only range was not protected by complete-snapshot policy');
expectSafe(privateBody, privateLiterals, 'direct private body-only range');

const privateWindowExpected = expectedProjection({
  logicalPath: privatePath,
  raw: privateRaw,
  safe: privateSafe,
  bytes: privateBytes,
  digest: privateDigest,
  startLine: 2,
  endLine: 4
});
const privateWindow = projectPublicSourceText({
  logicalPath: privatePath,
  text: privateRaw,
  bytes: privateBytes,
  sha256: privateDigest,
  startLine: 2,
  endLine: 4
});
assertProjection(privateWindow, privateWindowExpected, 'direct private delimiter window');
assert.equal(privateWindow.truncated, true, 'ranged projection lost truncation metadata');

// Metadata is acquisition-owned. Deliberately non-derived values prove that
// the pure projector passes exact supplied full-file bytes/SHA through.
const suppliedBytes = 987654;
const suppliedDigest = 'supplied-full-snapshot-sha';
const suppliedMetadataProjection = projectPublicSourceText({
  logicalPath: privatePath,
  text: privateRaw,
  bytes: suppliedBytes,
  sha256: suppliedDigest,
  startLine: 3,
  endLine: 3
});
assert.equal(suppliedMetadataProjection.bytes, suppliedBytes, 'projector recomputed supplied byte metadata');
assert.equal(suppliedMetadataProjection.sha256, suppliedDigest, 'projector recomputed supplied SHA metadata');
assert.equal(suppliedMetadataProjection.totalLines, 6, 'projector changed raw physical line count');

// Raw numbered-range admission must remain raw even when the sanitized text
// expands beyond the same budget. This budget is exactly the raw numbered
// line, while the marker makes the projected line longer.
const budgetRaw = 'TOKEN=QZ7\nSAFE=runtimeToken\n';
const budgetSafe = 'TOKEN= [REDACTED_SECRET]\nSAFE=runtimeToken\n';
const rawBudgetBytes = Buffer.byteLength('1 | TOKEN=QZ7', 'utf8');
const expandedBudgetProjection = projectPublicSourceText({
  logicalPath: 'budget.txt',
  text: budgetRaw,
  bytes: Buffer.byteLength(budgetRaw, 'utf8'),
  sha256: sha256(budgetRaw),
  startLine: 1,
  endLine: 1,
  maxBytes: rawBudgetBytes
});
const expandedExpected = expectedProjection({
  logicalPath: 'budget.txt',
  raw: budgetRaw,
  safe: budgetSafe,
  bytes: Buffer.byteLength(budgetRaw, 'utf8'),
  digest: sha256(budgetRaw),
  startLine: 1,
  endLine: 1
});
assertProjection(expandedBudgetProjection, expandedExpected, 'raw-budget expansion projection');
assert.ok(Buffer.byteLength(expandedBudgetProjection.text, 'utf8') > rawBudgetBytes, 'fixture did not make redaction expand beyond raw numbered budget');

// The private-key marker contracts a long raw body under the same raw-budget
// rule; admission is still based on the raw physical lines.
const contractionBudget = Buffer.byteLength(numbered(privateRawParts.slice(1, 4), 2), 'utf8');
const contractedBudgetProjection = projectPublicSourceText({
  logicalPath: privatePath,
  text: privateRaw,
  bytes: privateBytes,
  sha256: privateDigest,
  startLine: 2,
  endLine: 4,
  maxBytes: contractionBudget
});
assertProjection(contractedBudgetProjection, privateWindowExpected, 'raw-budget contraction projection');
assert.ok(Buffer.byteLength(contractedBudgetProjection.text, 'utf8') < contractionBudget, 'fixture did not make redaction contract beneath raw numbered budget');

// Same raw bytes under two logical paths prove path-aware source policy. The
// .py path has lawful direct Python annotation ownership; the .txt falsifier
// must not inherit Python provenance merely from text resemblance.
const looksPythonRaw = [
  'class R:',
  '    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  ''
].join('\n');
const looksPythonSafeForText = [
  'class R:',
  '    token: [REDACTED_SECRET]',
  ''
].join('\n');
const looksPythonBytes = Buffer.byteLength(looksPythonRaw, 'utf8');
const looksPythonDigest = sha256(looksPythonRaw);
const looksPythonTextExpected = expectedProjection({
  logicalPath: 'looks-python.txt',
  raw: looksPythonRaw,
  safe: looksPythonSafeForText,
  bytes: looksPythonBytes,
  digest: looksPythonDigest
});
const looksPythonPyExpected = expectedProjection({
  logicalPath: 'looks-python.py',
  raw: looksPythonRaw,
  safe: looksPythonRaw,
  bytes: looksPythonBytes,
  digest: looksPythonDigest
});
assert.equal(looksPythonRaw.includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'language falsifier lost its raw secret-looking token');
const looksPythonText = projectPublicSourceText({
  logicalPath: 'looks-python.txt',
  text: looksPythonRaw,
  bytes: looksPythonBytes,
  sha256: looksPythonDigest
});
const looksPythonPy = projectPublicSourceText({
  logicalPath: 'looks-python.py',
  text: looksPythonRaw,
  bytes: looksPythonBytes,
  sha256: looksPythonDigest
});
assertProjection(looksPythonText, looksPythonTextExpected, 'looks-Python .txt falsifier');
assertProjection(looksPythonPy, looksPythonPyExpected, 'looks-Python .py logical path');
expectSafe(looksPythonText, ['ACTUAL_LITERAL_SECRET_7X9'], 'looks-Python .txt falsifier');
assert.equal(looksPythonPy.text.includes('ACTUAL_LITERAL_SECRET_7X9'), true, '.py lawful source lost path-aware source bytes');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-source-projection-'));
let client;
try {
  await fs.writeFile(path.join(tmp, privatePath), privateRaw, 'utf8');
  await fs.writeFile(path.join(tmp, 'looks-python.txt'), looksPythonRaw, 'utf8');
  await fs.writeFile(path.join(tmp, 'looks-python.py'), looksPythonRaw, 'utf8');

  const config = loadConfig(['--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'off', '--tool-mode', 'full']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).openWorkspace(tmp);

  // TARGET_EVIDENCE: current filesystem readPublicTextFile and internal
  // readTextFile on ordinary file acquisition. Supporting oracle: the pure
  // expected fixture above.
  const filesystemPublic = await readPublicTextFile(config, guard, workspace, privatePath, { startLine: 3, endLine: 3 });
  assertProjection(filesystemPublic, privateBodyExpected, 'filesystem readPublicTextFile');
  const filesystemPure = projectPublicSourceText({
    logicalPath: privatePath,
    text: privateRaw,
    bytes: privateBytes,
    sha256: privateDigest,
    startLine: 3,
    endLine: 3,
    maxBytes: Math.min(config.maxReadBytes, config.maxReadBytes)
  });
  assert.deepEqual(filesystemPublic, filesystemPure, 'current filesystem public read diverged from pure projector');
  expectSafe(filesystemPublic, privateLiterals, 'filesystem readPublicTextFile');

  const internalRaw = await readTextFile(config, guard, workspace, privatePath, { startLine: 3, endLine: 3 });
  assert.equal(internalRaw.text, '3 | PRIVATE_BODY_7X9', 'internal readTextFile was unexpectedly redacted');
  assert.equal(internalRaw.bytes, privateBytes, 'internal readTextFile changed byte metadata');
  assert.equal(internalRaw.sha256, privateDigest, 'internal readTextFile changed SHA metadata');

  client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'off', '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'off',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0',
      CODEXPRO_ANALYSIS: '0',
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1'
    }
  });
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-source-projection-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  const opened = assertToolSuccess(await client.request('tools/call', {
    name: 'open_current_workspace',
    arguments: { include_tree: false }
  }), 'MCP open_current_workspace');
  const workspaceId = opened.structuredContent.workspace_id;
  assert.ok(workspaceId, 'MCP open_current_workspace omitted workspace id');

  // TARGET_EVIDENCE: ordinary MCP read route. The route result must equal the
  // compiled pure projector for the same acquired snapshot.
  const mcpPrivate = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: privatePath, start_line: 3, end_line: 3 }
  }), 'MCP private body-only read');
  assertProjection(mcpPrivate.structuredContent, privateBodyExpected, 'MCP private body-only read');
  assert.ok(Object.prototype.hasOwnProperty.call(mcpPrivate, '_meta'), 'MCP read omitted _meta envelope');
  assert.equal(mcpPrivate.content?.[0]?.text.includes(privateBodyExpected.text), true, 'MCP read content omitted typed public-source body');
  expectSafe(mcpPrivate, privateLiterals, 'MCP private body-only read complete envelope');

  const mcpText = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'looks-python.txt' }
  }), 'MCP looks-Python .txt read');
  assertProjection(mcpText.structuredContent, looksPythonTextExpected, 'MCP looks-Python .txt read');
  expectSafe(mcpText, ['ACTUAL_LITERAL_SECRET_7X9'], 'MCP looks-Python .txt read complete envelope');

  const mcpPy = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'looks-python.py' }
  }), 'MCP looks-Python .py read');
  assertProjection(mcpPy.structuredContent, looksPythonPyExpected, 'MCP looks-Python .py read');
  assert.equal(mcpPy.structuredContent.text.includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'MCP .py read lost lawful path-aware bytes');

  const mcpMany = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      items: [
        { path: privatePath, start_line: 3, end_line: 3 },
        { path: 'looks-python.txt', start_line: 2, end_line: 2 },
        { path: 'looks-python.py', start_line: 2, end_line: 2 }
      ]
    }
  }), 'MCP read_many projection route');
  assert.ok(Object.prototype.hasOwnProperty.call(mcpMany, '_meta'), 'MCP read_many omitted _meta envelope');
  const manyResults = mcpMany.structuredContent.results ?? [];
  assert.equal(manyResults.length, 3, 'MCP read_many changed projection item count');
  const expectedMany = [privateBodyExpected, expectedProjection({
    logicalPath: 'looks-python.txt',
    raw: looksPythonRaw,
    safe: looksPythonSafeForText,
    bytes: looksPythonBytes,
    digest: looksPythonDigest,
    startLine: 2,
    endLine: 2
  }), expectedProjection({
    logicalPath: 'looks-python.py',
    raw: looksPythonRaw,
    safe: looksPythonRaw,
    bytes: looksPythonBytes,
    digest: looksPythonDigest,
    startLine: 2,
    endLine: 2
  })];
  for (const [index, expected] of expectedMany.entries()) {
    const actual = manyResults[index];
    assert.equal(actual.index, index, `MCP read_many changed item ${index} order`);
    assert.equal(actual.ok, true, `MCP read_many rejected item ${index}`);
    assertProjection(actual.result, expected, `MCP read_many item ${index}`);
  }
  assert.equal(mcpMany.content?.[0]?.text.includes(privateBodyExpected.text), true, 'MCP read_many content omitted source body');
  expectSafe(mcpMany, ['PRIVATE_BODY_7X9', 'PRIVATE KEY'], 'MCP read_many complete envelope');
  expectSafe(manyResults[1], ['ACTUAL_LITERAL_SECRET_7X9'], 'MCP read_many hostile .txt item');
  assert.equal(JSON.stringify(manyResults[2]).includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'MCP read_many lawful .py item lost path-aware source bytes');
} finally {
  client?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('source-projection-smoke: PASS (pure complete-snapshot projection, raw line-budget admission, metadata pass-through, filesystem parity, internal raw read, MCP read/read_many route)');
