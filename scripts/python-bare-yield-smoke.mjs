import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPythonProvenance, collectPythonCallKeywordApprovals, PYTHON_PROVENANCE_MAX_BYTES } from './python-provenance.mjs';
import { scanSecretValues, hasSecretValue, redactSensitiveTextPreservingLines } from './redaction-policy.mjs';

const options = { context: 'source', language: 'python' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const scaffold = 'from typing import Any\nclass State:\n    context_token: Any\n\ndef enter(token):\n    return State(context_token=token)\n';
const generator = 'def transaction():\n    try:\n        yield\n    finally:\n        cleanup()\n';
const small = scaffold + generator + 'marker = 1\n';
const markerPatch = (file, source, before, after) => {
  const rows = source.trimEnd().split('\n');
  const index = rows.indexOf(before);
  assert(index >= 0);
  const start = Math.max(0, index - 3);
  const end = Math.min(rows.length, index + 4);
  const body = rows.slice(start, end).flatMap((row, i) => i + start === index
    ? [`-${before}`, `+${after}`] : [` ${row}`]);
  return `--- a/${file}\n+++ b/${file}\n@@ -${start + 1},${end - start} +${start + 1},${end - start} @@\n${body.join('\n')}\n`;
};
const valid = [
  small,
  small.replace('yield\n', 'yield # transaction boundary\n'),
  small.replace('yield\n', 'yield   \n'),
  small.replaceAll('\n', '\r\n'),
  scaffold + 'def transaction():\n    yield',
  scaffold + 'async def transaction():\n    yield\n',
  scaffold + 'class Catalog:\n    def transaction(self):\n        with lock():\n            yield\n',
  scaffold + 'def outer():\n    def inner():\n        yield\n    return inner\n',
  small.replace('yield\n', 'yield None\n'),
  scaffold + 'def transaction():\n    yield # comment with token: REDACT_THIS_LITERAL\n',
];
const invalid = [
  'def transaction():\n    yield from\n',
  'def transaction():\n    yield,\n',
  'def transaction():\n    yield +\n',
  'def transaction():\n    yield )\n',
  'def transaction():\n    yield = value\n',
  'def transaction():\n    yield :\n',
  generator + 'broken = (\n',
  generator + 'def broken(\n',
  generator + 'if True:\n',
  'def transaction():\n    yield\n    finally:\n        pass\n',
  'yield\n',
  'class Catalog:\n    yield\n',
  'def outer():\n    class Catalog:\n        yield\n',
  '    context_token: Any\n' + generator,
];
let validCount = 0;
for (const source of valid) {
  const python = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: source, encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  assert.equal(scanSecretValues(source, options).complete, true);
  // A credential-looking comment still takes the ordinary conservative path.
  if (!source.includes('REDACT_THIS_LITERAL')) {
    assert.equal(hasSecretValue(source, options), false);
    assert.equal(redactSensitiveTextPreservingLines(source, options), source);
  } else {
    assert.equal(hasSecretValue(source, options), true);
    assert.equal(redactSensitiveTextPreservingLines(source, options).includes('REDACT_THIS_LITERAL'), false);
  }
  validCount++;
}
for (const source of invalid) {
  assert.equal(scanSecretValues(source, options).complete, false, `invalid source obtained coverage: ${JSON.stringify(source)}`);
  assert.throws(() => collectPythonCallKeywordApprovals(source, ['context_token']), /complete valid Python/);
}
const overLimit = '#'.repeat(PYTHON_PROVENANCE_MAX_BYTES + 1);
assert.equal(createPythonProvenance(overLimit, { language: 'python' }).reason, 'over-limit');
assert.equal(scanSecretValues(overLimit, options).complete, false);
assert.throws(() => collectPythonCallKeywordApprovals(overLimit, ['context_token']), /complete valid Python/);
assert.equal(hasSecretValue(small, { context: 'source' }), true, 'untrusted language obtained Python provenance');

// Match the reported file shape: class annotation at 520, reference at 4462,
// three distant contextmanager yields, and over 220KB across 5000 lines.
const lines = Array.from({ length: 5000 }, (_, i) => `# catalog filler ${String(i).padStart(5, '0')} ${'x'.repeat(24)}`);
lines[0] = 'from typing import Any';
lines[518] = 'class State:';
lines[519] = '    context_token: Any';
for (const [index, name] of [[1578, 'one'], [1598, 'two'], [3772, 'three']]) {
  const body = generator.replace('transaction', name).trimEnd().split('\n');
  lines.splice(index, body.length, ...body);
}
lines[4460] = 'def enter(token):';
lines[4461] = '    return State(context_token=token)';
lines[4998] = 'marker = 1';
const large = lines.join('\n') + '\n';
assert(Buffer.byteLength(large) > 220000);
assert.equal(scanSecretValues(large, options).complete, true);
assert.equal(hasSecretValue(large, options), false);
assert.equal(redactSensitiveTextPreservingLines(large, options), large);

const provider = 'gh' + 'p_' + '0123456789abcdefghijklmnopqrstuvwxyzABCD';
const credentials = [
  `def hostile():\n    context_token = '${provider}'\n`,
  `def hostile():\n    send(context_token='${provider}')\n`,
  "def hostile():\n    password = 'not-a-real-password-but-sensitive'\n",
  "def hostile():\n    send(context_token='opaque-unapproved-value')\n",
  `def hostile():\n    ordinary = '${provider}'\n`,
  "def hostile():\n    headers = 'Authorization: Bearer nonfunctional-sensitive-value'\n",
  "def hostile():\n    ordinary = 'https://example.invalid/?api_key=nonfunctional-sensitive-value'\n",
  'def hostile():\n    ordinary = """-----BEGIN PRIVATE KEY-----\nMII_FAKE_BODY\n-----END PRIVATE KEY-----"""\n',
];
for (const [index, tail] of credentials.entries()) {
  const source = small + tail;
  assert.equal(scanSecretValues(source, options).complete, true, `credential fixture ${index} parse coverage`);
  assert.equal(hasSecretValue(source, options), true, `credential fixture ${index} rejection`);
  assert.notEqual(redactSensitiveTextPreservingLines(source, options), source);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-bare-yield-'));
const registry = path.join(tmp, 'approvals.json');
const client = new Client({ name: 'bare-yield-smoke', version: '1' });
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'workspace', '--tool-mode', 'full'],
  env: { ...process.env, CODEXPRO_SOURCE_APPROVALS_FILE: registry }, stderr: 'inherit' });
let operations = 0;
try {
  await fs.writeFile(path.join(tmp, 'catalog.py'), large);
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Yield Smoke', '-c', 'user.email=yield@example.invalid', 'commit', '-m', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await client.connect(transport);
  const opened = await client.callTool({ name: 'open_current_workspace', arguments: {} });
  assert.notEqual(opened.isError, true);
  const workspace_id = opened.structuredContent.workspace_id;
  const call = async (name, args, rejected = false) => {
    const result = await client.callTool({ name, arguments: { workspace_id, ...args } });
    assert.equal(result.isError === true, rejected, `${name}: ${JSON.stringify(result).slice(0, 500)}`);
    operations++;
    return result;
  };
  await call('edit', { path: 'catalog.py', old_text: 'marker = 1', new_text: 'marker = 2', expected_sha256: sha(large) });
  assert.equal(await fs.readFile(path.join(tmp, 'catalog.py'), 'utf8'), large.replace('marker = 1', 'marker = 2'));
  await call('apply_patch', { patch: markerPatch('catalog.py', large.replace('marker = 1', 'marker = 2'), 'marker = 2', 'marker = 3') });
  assert.equal(await fs.readFile(path.join(tmp, 'catalog.py'), 'utf8'), large.replace('marker = 1', 'marker = 3'));
  await call('write', { path: 'new.py', content: small });
  const newIdentity = await fs.stat(path.join(tmp, 'new.py'));
  for (const tail of credentials) {
    await call('write', { path: 'new.py', content: small + tail }, true);
    assert.equal(await fs.readFile(path.join(tmp, 'new.py'), 'utf8'), small);
    assert.equal((await fs.stat(path.join(tmp, 'new.py'))).mtimeMs, newIdentity.mtimeMs);
  }
  for (const [i, source] of invalid.entries()) {
    const name = `invalid-${i}.py`;
    await fs.writeFile(path.join(tmp, name), source + '\nmarker = 1\n');
    await call('edit', { path: name, old_text: 'marker = 1', new_text: 'marker = 2' }, true);
    assert.equal(await fs.readFile(path.join(tmp, name), 'utf8'), source + '\nmarker = 1\n');
  }
  await call('edit', { path: 'new.py', old_text: 'marker = 1', new_text: `context_token = '${provider}'` }, true);
  await call('apply_patch', { patch: markerPatch('new.py', small, 'marker = 1', `context_token = '${provider}'`) }, true);
  const catalogBefore = await fs.readFile(path.join(tmp, 'catalog.py'), 'utf8');
  await call('apply_patch', { patch: markerPatch('catalog.py', catalogBefore, 'marker = 3', 'marker = 4')
    + markerPatch('new.py', small, 'marker = 1', `context_token = '${provider}'`) }, true);
  assert.equal(await fs.readFile(path.join(tmp, 'catalog.py'), 'utf8'), catalogBefore, 'mixed patch changed its safe file');
  assert.equal(await fs.readFile(path.join(tmp, 'new.py'), 'utf8'), small, 'refused credential mutation changed source');
  await call('write', { path: '.env', content: small }, true);

  const approved = small + "def reviewed():\n    send(context_token='nonsecret-reviewed-id')\n";
  const approvalPath = path.join(tmp, 'reviewed.py');
  await fs.writeFile(approvalPath, approved);
  const enroll = (source) => spawnSync(process.execPath, ['scripts/approve-source.mjs', approvalPath,
    '--expected-sha', sha(source), '--keywords', 'context_token', '--registry', registry], { encoding: 'utf8' });
  const enrolled = enroll(approved);
  assert.equal(enrolled.status, 0, enrolled.stderr);
  assert.equal(JSON.parse(enrolled.stdout).approved_values, 1);
  const registryBefore = await fs.readFile(registry, 'utf8');
  assert.equal(registryBefore.includes('nonsecret-reviewed-id'), false);
  await call('edit', { path: 'reviewed.py', old_text: 'marker = 1', new_text: 'marker = 2' });
  assert.equal(await fs.readFile(approvalPath, 'utf8'), approved.replace('marker = 1', 'marker = 2'));
  for (const source of [approved.replace('nonsecret-reviewed-id', provider), ...invalid.map((s) => s + "\nsend(context_token='nonsecret-reviewed-id')\n")]) {
    await fs.writeFile(approvalPath, source);
    assert.notEqual(enroll(source).status, 0, 'invalid or real credential source was approved');
    assert.equal(await fs.readFile(registry, 'utf8'), registryBefore);
  }
  console.log(`python-bare-yield-smoke: PASS (${validCount} valid variants, ${invalid.length} invalid shapes, unchanged 2MB bound, ${credentials.length} credential forms, ${operations} ordinary MCP operations, hash-only owner approval and ${invalid.length + 1} enrollment refusals)`);
} finally {
  await client.close();
  await transport.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
