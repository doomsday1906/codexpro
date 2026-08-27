import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NEEDLE = 'BoundaryNeedleAlpha';
const HIDDEN_SYMBOL = 'HiddenBoundaryDefinition';
const REFERENCE_SYMBOL = 'BoundaryReferenceTarget';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'dist', 'stdio.js');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-evidence-'));

class McpStdioClient {
  constructor() {
    this.child = spawn(process.execPath, [
      serverEntry,
      '--root', fixtureRoot,
      '--allow-root', fixtureRoot,
      '--bash', 'off',
      '--write', 'off',
      '--tool-mode', 'standard'
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEXPRO_ROOT: fixtureRoot,
        CODEXPRO_ALLOWED_ROOTS: fixtureRoot,
        CODEXPRO_BLOCKED_GLOBS: 'blocked/**',
        CODEXPRO_TOOL_CARDS: '0'
      }
    });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk); });
    this.child.on('exit', (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}: ${this.stderr}`));
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
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}: ${this.stderr}`)), 20_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

async function write(relativePath, content) {
  const target = path.join(fixtureRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function isHiddenPath(relativePath) {
  return relativePath.replaceAll('\\', '/').split('/').some((component) => component.startsWith('.'));
}

function lexicalPaths(result) {
  return result.structuredContent.matches.map((match) => match.path);
}

function structuredPaths(result) {
  return result.structuredContent.analysis.matches.map((match) => match.path);
}

function groupedMatches(result) {
  return Object.values(result.structuredContent.analysis.groups).flat();
}

function assertSearchSucceeded(result, label) {
  assert.equal(result.isError, undefined, `${label} returned an MCP error`);
  assert(result.structuredContent.analysis, `${label} omitted structured analysis`);
  assert.deepEqual(result.structuredContent.analysis.matches, groupedMatches(result), `${label} flat/grouped structured results diverged`);
}

function assertNoHiddenEvidence(result, label) {
  const evidence = [
    ...result.structuredContent.matches,
    ...result.structuredContent.analysis.matches,
    ...groupedMatches(result)
  ];
  for (const match of evidence) {
    assert.equal(isHiddenPath(match.path), false, `${label} leaked hidden path ${match.path}`);
    const serialized = JSON.stringify(match);
    assert(!serialized.includes('.brv/'), `${label} leaked synthetic project-memory path: ${serialized}`);
    assert(!serialized.includes('.hidden'), `${label} leaked hidden path text: ${serialized}`);
  }
}

function assertPathPresent(paths, expected, label) {
  assert(paths.includes(expected), `${label} missing ${expected}: ${JSON.stringify(paths)}`);
}

function assertPathAbsent(paths, expected, label) {
  assert(!paths.includes(expected), `${label} unexpectedly included ${expected}: ${JSON.stringify(paths)}`);
}

let client;
try {
  await write('package.json', JSON.stringify({ name: 'search-evidence-fixture', scripts: { test: 'node --test' } }, null, 2));
  await write('src/visible.ts', `export function ${NEEDLE}() { return true; }\n`);
  await write('.hidden-root.ts', `export function ${NEEDLE}() { return false; }\nexport function ${HIDDEN_SYMBOL}() { return true; }\n`);
  await write('src/.hidden/nested.ts', `export function ${NEEDLE}() { return false; }\n`);
  await write('.brv/context-tree/memory.md', `${NEEDLE} synthetic project memory fixture\n`);
  await write('docs/visible.md', `# ${NEEDLE}\n`);
  await write('tests/visible.test.ts', `import { ${NEEDLE} } from '../src/visible.js';\nvoid ${NEEDLE}();\n`);
  await write('tests/.hidden/hidden.test.ts', `import { ${NEEDLE} } from '../../src/visible.js';\nvoid ${NEEDLE}();\n`);
  await write('blocked/secret.ts', `export const blocked = '${NEEDLE}';\n`);
  await write('src/reference-target.ts', `export function ${REFERENCE_SYMBOL}() { return true; }\n`);
  await write('src/visible-dependent.ts', `import { ${REFERENCE_SYMBOL} } from './reference-target.js';\nvoid ${REFERENCE_SYMBOL}();\n`);
  await write('src/.hidden/reference-dependent.ts', `import { ${REFERENCE_SYMBOL} } from '../reference-target.js';\nvoid ${REFERENCE_SYMBOL}();\n`);
  await write('tests/visible-reference.test.ts', `import { ${REFERENCE_SYMBOL} } from '../src/reference-target.js';\nvoid ${REFERENCE_SYMBOL}();\n`);
  await write('tests/.hidden/reference-hidden.test.ts', `import { ${REFERENCE_SYMBOL} } from '../../src/reference-target.js';\nvoid ${REFERENCE_SYMBOL}();\n`);

  client = new McpStdioClient();
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-search-evidence-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
  const workspaceId = opened.structuredContent.workspace_id;
  const search = async (arguments_) => {
    const result = await client.request('tools/call', { name: 'search', arguments: { workspace_id: workspaceId, max_results: 100, ...arguments_ } });
    assertSearchSucceeded(result, JSON.stringify(arguments_));
    return result;
  };

  const defaultHidden = await search({ query: NEEDLE, intent: 'symbol', include_tests: true });
  assert.equal(defaultHidden.structuredContent.analysis.cache.hit, false);
  assertPathPresent(lexicalPaths(defaultHidden), 'src/visible.ts', 'default lexical search');
  assertPathPresent(lexicalPaths(defaultHidden), 'docs/visible.md', 'default lexical search');
  assertPathPresent(structuredPaths(defaultHidden), 'src/visible.ts', 'default structured search');
  assertPathPresent(structuredPaths(defaultHidden), 'docs/visible.md', 'default structured search');
  assertNoHiddenEvidence(defaultHidden, 'default search');

  const includeHidden = await search({ query: NEEDLE, intent: 'symbol', include_tests: true, include_hidden: true });
  assert.equal(includeHidden.structuredContent.analysis.cache.hit, true);
  assert.equal(includeHidden.structuredContent.analysis.cache.key, defaultHidden.structuredContent.analysis.cache.key);
  for (const expected of ['.hidden-root.ts', 'src/.hidden/nested.ts', '.brv/context-tree/memory.md', 'tests/.hidden/hidden.test.ts']) {
    assertPathPresent(lexicalPaths(includeHidden), expected, 'include_hidden=true lexical search');
    assertPathPresent(structuredPaths(includeHidden), expected, 'include_hidden=true structured search');
  }
  assertPathAbsent(lexicalPaths(includeHidden), 'blocked/secret.ts', 'include_hidden=true lexical search');
  assertPathAbsent(structuredPaths(includeHidden), 'blocked/secret.ts', 'include_hidden=true structured search');

  const explicitFalse = await search({ query: NEEDLE, intent: 'symbol', include_tests: true, include_hidden: false });
  assert.equal(explicitFalse.structuredContent.analysis.cache.hit, true);
  assert.equal(explicitFalse.structuredContent.analysis.cache.key, defaultHidden.structuredContent.analysis.cache.key);
  assertNoHiddenEvidence(explicitFalse, 'include_hidden=false search');

  const hiddenDefinitionFalse = await search({ query: HIDDEN_SYMBOL, intent: 'symbol', include_hidden: false });
  assert.equal(hiddenDefinitionFalse.structuredContent.analysis.groups.definitions.length, 0);
  assertNoHiddenEvidence(hiddenDefinitionFalse, 'hidden symbol search with include_hidden=false');
  const hiddenDefinitionTrue = await search({ query: HIDDEN_SYMBOL, intent: 'symbol', include_hidden: true });
  assertPathPresent(hiddenDefinitionTrue.structuredContent.analysis.groups.definitions.map((match) => match.path), '.hidden-root.ts', 'hidden symbol definition');

  const referencesFalse = await search({ query: REFERENCE_SYMBOL, intent: 'references', include_tests: true, include_hidden: false });
  assertNoHiddenEvidence(referencesFalse, 'reference search with include_hidden=false');
  assert(referencesFalse.structuredContent.analysis.groups.references.some((match) => match.path === 'src/visible-dependent.ts' && match.reasons.includes('dependent module')));
  assert(referencesFalse.structuredContent.analysis.groups.tests.some((match) => match.path === 'tests/visible-reference.test.ts' && match.reasons.includes('dependent test')));
  const referencesTrue = await search({ query: REFERENCE_SYMBOL, intent: 'references', include_tests: true, include_hidden: true });
  assert(referencesTrue.structuredContent.analysis.groups.references.some((match) => match.path === 'src/.hidden/reference-dependent.ts' && match.reasons.includes('dependent module')));
  assert(referencesTrue.structuredContent.analysis.groups.tests.some((match) => match.path === 'tests/.hidden/reference-hidden.test.ts' && match.reasons.includes('dependent test')));

  const scopedFalse = await search({ query: NEEDLE, intent: 'symbol', path: 'src', include_hidden: false });
  assertPathPresent(structuredPaths(scopedFalse), 'src/visible.ts', 'root-scoped structured search');
  assertPathAbsent(structuredPaths(scopedFalse), 'src/.hidden/nested.ts', 'root-scoped structured search');
  assertNoHiddenEvidence(scopedFalse, 'root-scoped search with include_hidden=false');
  const scopedTrue = await search({ query: NEEDLE, intent: 'symbol', path: 'src', include_hidden: true });
  assertPathPresent(lexicalPaths(scopedTrue), 'src/.hidden/nested.ts', 'root-scoped lexical search with include_hidden=true');
  assertPathPresent(structuredPaths(scopedTrue), 'src/.hidden/nested.ts', 'root-scoped structured search with include_hidden=true');

  const inspection = await client.request('tools/call', {
    name: 'inspect_workspace',
    arguments: { workspace_id: workspaceId, max_files: 100, max_symbols: 100, max_relationships: 100 }
  });
  assert.equal(inspection.isError, undefined);
  assert(inspection.structuredContent.files.some((file) => file.path === '.brv/context-tree/memory.md'));
  assert(inspection.structuredContent.files.some((file) => file.path === 'src/.hidden/nested.ts'));
  assert.equal(inspection.structuredContent.cache.hit, true);
  assert.equal(inspection.structuredContent.cache.key, defaultHidden.structuredContent.analysis.cache.key);

  console.log(JSON.stringify({
    default_visible_lexical: lexicalPaths(defaultHidden).filter((filePath) => !isHiddenPath(filePath)),
    include_hidden_lexical: lexicalPaths(includeHidden).filter(isHiddenPath),
    include_hidden_structured: structuredPaths(includeHidden).filter(isHiddenPath),
    cache: {
      first_hit: defaultHidden.structuredContent.analysis.cache.hit,
      toggled_hit: includeHidden.structuredContent.analysis.cache.hit,
      same_key: includeHidden.structuredContent.analysis.cache.key === defaultHidden.structuredContent.analysis.cache.key
    },
    inspect_workspace_hidden_files: inspection.structuredContent.files.filter((file) => isHiddenPath(file.path)).map((file) => file.path)
  }, null, 2));
  console.log('✓ search evidence boundary smoke test passed');
} finally {
  client?.close();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
