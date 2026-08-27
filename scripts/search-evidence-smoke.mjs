import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NEEDLE = 'BoundaryNeedleAlpha';
const HIDDEN_SYMBOL = 'HiddenBoundaryDefinition';
const REFERENCE_SYMBOL = 'BoundaryReferenceTarget';
const LIMIT_NEEDLE = 'BoundaryNeedleLimit';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'dist', 'stdio.js');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-evidence-'));
const realRgLookup = spawnSync('/bin/sh', ['-lc', 'command -v rg'], { encoding: 'utf8' });
const realRgPath = realRgLookup.status === 0 ? realRgLookup.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) : '';

class McpStdioClient {
  constructor({ pathOverride } = {}) {
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
        ...(pathOverride === undefined ? {} : { PATH: pathOverride }),
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

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function groupPaths(result, group) {
  return result.structuredContent.analysis.groups[group].map((match) => match.path);
}

function assertEmptyStructuredResult(result, label, expectedUsed) {
  assert.equal(result.structuredContent.used, expectedUsed, `${label} selected the wrong lexical backend`);
  assert.equal(result.structuredContent.truncated, false, `${label} unexpectedly truncated lexical output`);
  assert.deepEqual(result.structuredContent.matches, [], `${label} returned lexical evidence for a hidden target`);
  assert.deepEqual(result.structuredContent.analysis.matches, [], `${label} returned structured evidence for a hidden target`);
  for (const [group, matches] of Object.entries(result.structuredContent.analysis.groups)) {
    assert.deepEqual(matches, [], `${label} returned ${group} evidence for a hidden target`);
  }
}

function assertHiddenTargetResult(result, expectedPath, label, expectedUsed) {
  assert.equal(result.structuredContent.used, expectedUsed, `${label} selected the wrong lexical backend`);
  assert.equal(result.structuredContent.truncated, false, `${label} unexpectedly truncated lexical output`);
  assertPathPresent(lexicalPaths(result), expectedPath, `${label} lexical result`);
  assertPathPresent(structuredPaths(result), expectedPath, `${label} structured result`);
}

async function openMcpClient(clients, pathOverride) {
  const current = new McpStdioClient({ pathOverride });
  clients.push(current);
  await current.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-search-evidence-smoke', version: '0.1.0' }
  });
  current.notify('notifications/initialized');
  const opened = await current.request('tools/call', {
    name: 'open_current_workspace',
    arguments: { include_tree: false }
  });
  return { client: current, workspaceId: opened.structuredContent.workspace_id };
}

function makeSearch(current, workspaceId) {
  return async (arguments_) => {
    const result = await current.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: workspaceId, max_results: 100, ...arguments_ }
    });
    assertSearchSucceeded(result, JSON.stringify(arguments_));
    return result;
  };
}

async function exerciseHiddenTarget(search, target, expectedPath, label, expectedUsed) {
  const omitted = await search({ query: NEEDLE, intent: 'symbol', path: target });
  assertEmptyStructuredResult(omitted, `${label} omitted include_hidden`, expectedUsed);

  const explicitFalse = await search({ query: NEEDLE, intent: 'symbol', path: target, include_hidden: false });
  assertEmptyStructuredResult(explicitFalse, `${label} include_hidden=false`, expectedUsed);

  const explicitTrue = await search({ query: NEEDLE, intent: 'symbol', path: target, include_hidden: true });
  assertHiddenTargetResult(explicitTrue, expectedPath, `${label} include_hidden=true`, expectedUsed);
  return { omitted, explicitFalse, explicitTrue };
}

const clients = [];
let emptyPathDir;
let rgShimDir;
let rgShimInvocationLog;
try {
  assert(realRgPath, `default ripgrep client unavailable: ${realRgLookup.stderr?.trim() || 'rg was not found on PATH'}`);
  await write('package.json', JSON.stringify({ name: 'search-evidence-fixture', scripts: { test: 'node --test' } }, null, 2));
  await write('src/visible.ts', `export function ${NEEDLE}() { return true; }\nexport const ${LIMIT_NEEDLE} = true;\n`);
  await write('.hidden-root.ts', `export function ${NEEDLE}() { return false; }\nexport function ${HIDDEN_SYMBOL}() { return true; }\nexport const ${LIMIT_NEEDLE} = false;\n`);
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

  // This visible dependent/test imports the hidden definition without naming it,
  // so impact/reference expansion is the only route that can surface it.
  await write('src/visible-hidden-definition-dependent.ts', `import '../.hidden-root.ts';\n`);
  await write('tests/visible-hidden-definition.test.ts', `import '../.hidden-root.ts';\n`);

  const { client, workspaceId } = await openMcpClient(clients);
  const search = makeSearch(client, workspaceId);

  const defaultHidden = await search({ query: NEEDLE, intent: 'symbol', include_tests: true });
  assert.equal(defaultHidden.structuredContent.analysis.cache.hit, false);
  assertPathPresent(lexicalPaths(defaultHidden), 'src/visible.ts', 'default lexical search');
  assertPathPresent(lexicalPaths(defaultHidden), 'docs/visible.md', 'default lexical search');
  assertPathPresent(structuredPaths(defaultHidden), 'src/visible.ts', 'default structured search');
  assertPathPresent(structuredPaths(defaultHidden), 'docs/visible.md', 'default structured search');
  assertNoHiddenEvidence(defaultHidden, 'default search');

  const explicitRoot = await search({ query: NEEDLE, intent: 'symbol', path: '.', include_tests: true });
  assert.equal(explicitRoot.structuredContent.used, 'ripgrep');
  assertPathPresent(lexicalPaths(explicitRoot), 'src/visible.ts', 'explicit root lexical search');
  assertPathPresent(structuredPaths(explicitRoot), 'src/visible.ts', 'explicit root structured search');
  assertNoHiddenEvidence(explicitRoot, 'explicit root search');
  const visibleTarget = await search({ query: NEEDLE, intent: 'symbol', path: 'src/visible.ts' });
  assert.equal(visibleTarget.structuredContent.used, 'ripgrep');
  assertPathPresent(lexicalPaths(visibleTarget), 'src/visible.ts', 'visible target lexical search');
  assertPathPresent(structuredPaths(visibleTarget), 'src/visible.ts', 'visible target structured search');

  const ripgrepHiddenRootCases = await exerciseHiddenTarget(search, '.hidden-root.ts', '.hidden-root.ts', 'ripgrep hidden root file', 'ripgrep');
  const ripgrepHiddenDirectoryCases = await exerciseHiddenTarget(search, 'src/.hidden', 'src/.hidden/nested.ts', 'ripgrep hidden root directory', 'ripgrep');

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

  const hiddenDefinitionFalse = await search({ query: HIDDEN_SYMBOL, intent: 'symbol', include_tests: true, include_hidden: false });
  assertEmptyStructuredResult(hiddenDefinitionFalse, 'hidden symbol search with include_hidden=false', 'ripgrep');
  const hiddenDefinitionTrue = await search({ query: HIDDEN_SYMBOL, intent: 'symbol', include_tests: true, include_hidden: true });
  assertPathPresent(groupPaths(hiddenDefinitionTrue, 'definitions'), '.hidden-root.ts', 'hidden symbol definition');

  const regexHiddenOmitted = await search({ query: 'BoundaryNeedleAlph.', regex: true, intent: 'symbol', path: '.hidden-root.ts' });
  assertEmptyStructuredResult(regexHiddenOmitted, 'regex hidden root file omitted include_hidden', 'ripgrep');
  const regexHiddenFalse = await search({ query: 'BoundaryNeedleAlph.', regex: true, intent: 'symbol', path: '.hidden-root.ts', include_hidden: false });
  assertEmptyStructuredResult(regexHiddenFalse, 'regex hidden root file include_hidden=false', 'ripgrep');
  const regexHiddenTrue = await search({ query: 'BoundaryNeedleAlph.', regex: true, intent: 'symbol', path: '.hidden-root.ts', include_hidden: true });
  assert.equal(regexHiddenTrue.structuredContent.used, 'ripgrep');
  assert.equal(regexHiddenTrue.structuredContent.truncated, false);
  assertPathPresent(lexicalPaths(regexHiddenTrue), '.hidden-root.ts', 'regex hidden root file include_hidden=true');
  assert.deepEqual(regexHiddenTrue.structuredContent.analysis.matches, [], 'regex structured analysis unexpectedly fabricated grouped evidence');
  for (const matches of Object.values(regexHiddenTrue.structuredContent.analysis.groups)) assert.deepEqual(matches, [], 'regex structured groups unexpectedly contained evidence');

  const referencesFalse = await search({ query: REFERENCE_SYMBOL, intent: 'references', include_tests: true, include_hidden: false });
  assertNoHiddenEvidence(referencesFalse, 'reference search with include_hidden=false');
  assert(referencesFalse.structuredContent.analysis.groups.references.some((match) => match.path === 'src/visible-dependent.ts' && match.reasons.includes('dependent module')));
  assert(referencesFalse.structuredContent.analysis.groups.tests.some((match) => match.path === 'tests/visible-reference.test.ts' && match.reasons.includes('dependent test')));
  const referencesWithoutTests = await search({ query: REFERENCE_SYMBOL, intent: 'references', include_tests: false, include_hidden: false });
  assertNoHiddenEvidence(referencesWithoutTests, 'reference search with include_tests=false');
  assertPathPresent(groupPaths(referencesWithoutTests, 'references'), 'src/visible-dependent.ts', 'reference search with include_tests=false');
  assert.deepEqual(referencesWithoutTests.structuredContent.analysis.groups.tests, [], 'reference search with include_tests=false returned tests');
  const referencesTrue = await search({ query: REFERENCE_SYMBOL, intent: 'references', include_tests: true, include_hidden: true });
  assert(referencesTrue.structuredContent.analysis.groups.references.some((match) => match.path === 'src/.hidden/reference-dependent.ts' && match.reasons.includes('dependent module')));
  assert(referencesTrue.structuredContent.analysis.groups.tests.some((match) => match.path === 'tests/.hidden/reference-hidden.test.ts' && match.reasons.includes('dependent test')));

  const impactFalse = await search({ query: REFERENCE_SYMBOL, intent: 'impact', include_tests: true, include_hidden: false });
  assertNoHiddenEvidence(impactFalse, 'impact search with include_hidden=false');
  assert(impactFalse.structuredContent.analysis.groups.references.some((match) => match.path === 'src/visible-dependent.ts' && match.reasons.includes('dependent module')));
  assert(impactFalse.structuredContent.analysis.groups.tests.some((match) => match.path === 'tests/visible-reference.test.ts' && match.reasons.includes('dependent test')));
  const impactWithoutTests = await search({ query: REFERENCE_SYMBOL, intent: 'impact', include_tests: false, include_hidden: false });
  assertNoHiddenEvidence(impactWithoutTests, 'impact search with include_tests=false');
  assertPathPresent(groupPaths(impactWithoutTests, 'references'), 'src/visible-dependent.ts', 'impact search with include_tests=false');
  assert.deepEqual(impactWithoutTests.structuredContent.analysis.groups.tests, [], 'impact search with include_tests=false returned tests');
  const impactTrue = await search({ query: REFERENCE_SYMBOL, intent: 'impact', include_tests: true, include_hidden: true });
  assert(impactTrue.structuredContent.analysis.groups.references.some((match) => match.path === 'src/.hidden/reference-dependent.ts' && match.reasons.includes('dependent module')));
  assert(impactTrue.structuredContent.analysis.groups.tests.some((match) => match.path === 'tests/.hidden/reference-hidden.test.ts' && match.reasons.includes('dependent test')));

  const hiddenDefinitionImpactFalse = await search({ query: HIDDEN_SYMBOL, intent: 'impact', include_tests: true, include_hidden: false });
  assertEmptyStructuredResult(hiddenDefinitionImpactFalse, 'hidden definition impact with include_hidden=false', 'ripgrep');
  const hiddenDefinitionImpactTrue = await search({ query: HIDDEN_SYMBOL, intent: 'impact', include_tests: true, include_hidden: true });
  assertPathPresent(groupPaths(hiddenDefinitionImpactTrue, 'definitions'), '.hidden-root.ts', 'hidden definition impact definition');
  assertPathPresent(groupPaths(hiddenDefinitionImpactTrue, 'references'), 'src/visible-hidden-definition-dependent.ts', 'hidden definition impact dependent module');
  assertPathPresent(groupPaths(hiddenDefinitionImpactTrue, 'tests'), 'tests/visible-hidden-definition.test.ts', 'hidden definition impact dependent test');

  emptyPathDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-no-rg-'));
  const { client: nodeClient, workspaceId: nodeWorkspaceId } = await openMcpClient(clients, emptyPathDir);
  const nodeSearch = makeSearch(nodeClient, nodeWorkspaceId);
  const nodeRoot = await nodeSearch({ query: NEEDLE, intent: 'symbol', include_tests: true });
  assert.equal(nodeRoot.structuredContent.used, 'node');
  assertPathPresent(lexicalPaths(nodeRoot), 'src/visible.ts', 'Node fallback root lexical search');
  assertNoHiddenEvidence(nodeRoot, 'Node fallback root search');
  const nodeHiddenRootCases = await exerciseHiddenTarget(nodeSearch, '.hidden-root.ts', '.hidden-root.ts', 'Node fallback hidden root file', 'node');
  const nodeHiddenDirectoryCases = await exerciseHiddenTarget(nodeSearch, 'src/.hidden', 'src/.hidden/nested.ts', 'Node fallback hidden root directory', 'node');

  rgShimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-rg-shim-'));
  rgShimInvocationLog = path.join(rgShimDir, 'invocations.log');
  await fs.writeFile(rgShimInvocationLog, '', 'utf8');
  const rgShimPath = path.join(rgShimDir, 'rg');
  await fs.writeFile(rgShimPath, `#!/bin/sh\nprintf '%s\\n' "shim --hidden $*" >> ${shellQuote(rgShimInvocationLog)}\nexec ${shellQuote(realRgPath)} --hidden "$@"\n`, { mode: 0o755 });
  await fs.chmod(rgShimPath, 0o755);
  const { client: shimClient, workspaceId: shimWorkspaceId } = await openMcpClient(clients, rgShimDir);
  const shimSearch = makeSearch(shimClient, shimWorkspaceId);
  const shimBeforeHiddenTarget = await fs.readFile(rgShimInvocationLog, 'utf8');
  const shimHiddenTargetFalse = await shimSearch({ query: NEEDLE, intent: 'symbol', path: '.hidden-root.ts', include_hidden: false });
  assertEmptyStructuredResult(shimHiddenTargetFalse, 'shim hidden root file include_hidden=false', 'ripgrep');
  assert.equal(await fs.readFile(rgShimInvocationLog, 'utf8'), shimBeforeHiddenTarget, 'explicit hidden target unexpectedly spawned ripgrep');
  const limitedHiddenBackend = await shimSearch({ query: LIMIT_NEEDLE, intent: 'symbol', path: '.', include_hidden: false, max_results: 1 });
  assert.equal(limitedHiddenBackend.structuredContent.used, 'ripgrep');
  assert.equal(limitedHiddenBackend.structuredContent.truncated, false, 'hidden backend output incorrectly counted toward visible result limit');
  assert.deepEqual(lexicalPaths(limitedHiddenBackend), ['src/visible.ts'], 'post-ripgrep admission did not preserve the visible match');
  assertPathPresent(structuredPaths(limitedHiddenBackend), 'src/visible.ts', 'result-limit structured search');
  const shimInvocations = await fs.readFile(rgShimInvocationLog, 'utf8');
  assert(shimInvocations.split(/\r?\n/).some((line) => line.includes('--hidden')), 'ripgrep hidden-output shim was not exercised');

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
    explicit_targets: {
      ripgrep_hidden_root_cases: Object.keys(ripgrepHiddenRootCases),
      ripgrep_hidden_directory_cases: Object.keys(ripgrepHiddenDirectoryCases),
      node_hidden_root_cases: Object.keys(nodeHiddenRootCases),
      node_hidden_directory_cases: Object.keys(nodeHiddenDirectoryCases)
    },
    backends: { default: defaultHidden.structuredContent.used, node_fallback: nodeRoot.structuredContent.used, hidden_output_shim: limitedHiddenBackend.structuredContent.used },
    result_limit: { paths: lexicalPaths(limitedHiddenBackend), truncated: limitedHiddenBackend.structuredContent.truncated, shim_exercised: true },
    impact: {
      references_false: groupPaths(impactFalse, 'references'),
      references_true_hidden: groupPaths(impactTrue, 'references').filter(isHiddenPath),
      tests_false: groupPaths(impactFalse, 'tests'),
      tests_true_hidden: groupPaths(impactTrue, 'tests').filter(isHiddenPath)
    },
    cache: {
      first_hit: defaultHidden.structuredContent.analysis.cache.hit,
      toggled_hit: includeHidden.structuredContent.analysis.cache.hit,
      same_key: includeHidden.structuredContent.analysis.cache.key === defaultHidden.structuredContent.analysis.cache.key
    },
    inspect_workspace_hidden_files: inspection.structuredContent.files.filter((file) => isHiddenPath(file.path)).map((file) => file.path)
  }, null, 2));
  console.log('✓ search evidence boundary smoke test passed');
} finally {
  for (const current of clients) current.close();
  for (const disposable of [rgShimDir, emptyPathDir, fixtureRoot]) {
    if (disposable) await fs.rm(disposable, { recursive: true, force: true });
  }
}
