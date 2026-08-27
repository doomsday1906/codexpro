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
const FLOOD_NEEDLE = 'BoundaryNeedleAdmissionFlood';
const BLOCKED_FLOOD_NEEDLE = 'BoundaryNeedleBlockedFlood';
const MALFORMED_NEEDLE = 'BoundaryNeedleMalformedRecord';
const AFTER_MALFORMED_NEEDLE = 'BoundaryNeedleAfterMalformedRecord';
const SHIM_MAX_OUTPUT_BYTES = 4000;
const UNTERMINATED_RECORD_BYTES = 96_000;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'dist', 'stdio.js');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-evidence-'));
const realRgLookup = spawnSync('/bin/sh', ['-lc', 'command -v rg'], { encoding: 'utf8' });
const realRgPath = realRgLookup.status === 0 ? realRgLookup.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) : '';

class McpStdioClient {
  constructor({ pathOverride, envOverrides = {} } = {}) {
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
        ...envOverrides,
        ...(pathOverride === undefined ? {} : { PATH: pathOverride }),
        CODEXPRO_ROOT: fixtureRoot,
        CODEXPRO_ALLOWED_ROOTS: fixtureRoot,
        CODEXPRO_BLOCKED_GLOBS: 'blocked/**',
        CODEXPRO_TOOL_CARDS: '0'
      }
    });
    this.exitCode = null;
    this.exitSignal = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk); });
    this.child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
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

  waitForExit(timeoutMs = 2_000) {
    if (this.exitCode !== null || this.exitSignal !== null) {
      return Promise.resolve({ code: this.exitCode, signal: this.exitSignal });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref();
      this.child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
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

function assertPathAbsentEverywhere(result, expected, label) {
  assertPathAbsent(lexicalPaths(result), expected, `${label} lexical`);
  assertPathAbsent(structuredPaths(result), expected, `${label} structured`);
  assertPathAbsent(groupedMatches(result).map((match) => match.path), expected, `${label} grouped`);
}

function mcpErrorText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shimMatchRecord(pathText, lineText, lineNumber = 1) {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: pathText },
      lines: { text: `${lineText}\n` },
      line_number: lineNumber,
      absolute_offset: 0,
      submatches: []
    }
  });
}

function shimPrintf(records, { newline = true } = {}) {
  const suffix = newline ? '\\n' : '';
  return `printf '%s${suffix}' ${records.map(shellQuote).join(' ')}`;
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

async function openMcpClient(clients, pathOverride, envOverrides = {}) {
  const current = new McpStdioClient({ pathOverride, envOverrides });
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

function callSearch(current, workspaceId, arguments_) {
  return current.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, max_results: 100, ...arguments_ }
  });
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
  const hiddenFloodPath = path.join(fixtureRoot, '.hidden-root.ts');
  const visibleFloodPath = path.join(fixtureRoot, 'src', 'visible.ts');
  const blockedFloodPath = path.join(fixtureRoot, 'blocked', 'secret.ts');
  const outsideFloodPath = path.join(os.tmpdir(), 'codexpro-search-evidence-outside.ts');
  const hiddenFloodRecords = Array.from({ length: 48 }, (_, index) => shimMatchRecord(
    hiddenFloodPath,
    `${FLOOD_NEEDLE} hidden flood ${String(index).padStart(2, '0')} ${'x'.repeat(100)}`
  ));
  const visibleFloodRecord = shimMatchRecord(visibleFloodPath, `${FLOOD_NEEDLE} visible survivor`);
  const blockedFloodRecords = Array.from({ length: 48 }, (_, index) => shimMatchRecord(
    blockedFloodPath,
    `${BLOCKED_FLOOD_NEEDLE} blocked flood ${String(index).padStart(2, '0')} ${'x'.repeat(100)}`
  ));
  const outsideFloodRecords = Array.from({ length: 8 }, (_, index) => shimMatchRecord(
    outsideFloodPath,
    `${BLOCKED_FLOOD_NEEDLE} outside flood ${String(index).padStart(2, '0')} ${'x'.repeat(100)}`
  ));
  const blockedVisibleFloodRecord = shimMatchRecord(visibleFloodPath, `${BLOCKED_FLOOD_NEEDLE} visible survivor`);
  const malformedPayloadMarker = 'MALFORMED_PRODUCER_PAYLOAD_';
  const unterminatedRecord = `{"type":"match","data":{"path":{"text":"${hiddenFloodPath}"},"lines":{"text":"${malformedPayloadMarker}${'z'.repeat(UNTERMINATED_RECORD_BYTES)}`;
  const malformedJsonLine = `{${malformedPayloadMarker}${'q'.repeat(2_000)}\n`;
  assert(Buffer.byteLength(hiddenFloodRecords.join('\n') + '\n', 'utf8') > SHIM_MAX_OUTPUT_BYTES, 'hidden flood did not exceed shim byte budget');
  assert(Buffer.byteLength(blockedFloodRecords.join('\n') + '\n', 'utf8') > SHIM_MAX_OUTPUT_BYTES, 'blocked flood did not exceed shim byte budget');
  assert(Buffer.byteLength(unterminatedRecord, 'utf8') > SHIM_MAX_OUTPUT_BYTES, 'unterminated record did not exceed shim byte budget');
  assert(Buffer.byteLength(unterminatedRecord, 'utf8') > 64 * 1024, 'unterminated record did not exceed the bounded pending-record limit');
  await fs.writeFile(rgShimPath, `#!/bin/sh
printf '%s\\n' "shim mode=${'${CODEXPRO_RG_SHIM_MODE:-delegate}'} --hidden $*" >> ${shellQuote(rgShimInvocationLog)}
case "${'${CODEXPRO_RG_SHIM_MODE:-delegate}'}" in
  hidden-admission-flood)
    ${shimPrintf(hiddenFloodRecords)}
    ${shimPrintf([visibleFloodRecord])}
    exit 0
    ;;
  blocked-admission-flood)
    ${shimPrintf(outsideFloodRecords)}
    ${shimPrintf(blockedFloodRecords)}
    ${shimPrintf([blockedVisibleFloodRecord])}
    exit 0
    ;;
  malformed-unterminated)
    case "$*" in
      *${FLOOD_NEEDLE}*)
        ${shimPrintf(hiddenFloodRecords)}
        ${shimPrintf([visibleFloodRecord])}
        ;;
      *${AFTER_MALFORMED_NEEDLE}*)
        ${shimPrintf([visibleFloodRecord])}
        ;;
      *)
        ${shimPrintf([unterminatedRecord], { newline: false })}
        ;;
    esac
    exit 0
    ;;
  malformed-json)
    ${shimPrintf([malformedJsonLine], { newline: false })}
    exit 0
    ;;
  *)
    exec ${shellQuote(realRgPath)} --hidden "$@"
    ;;
esac
`, { mode: 0o755 });
  await fs.chmod(rgShimPath, 0o755);
  const { client: shimClient, workspaceId: shimWorkspaceId } = await openMcpClient(clients, rgShimDir, {
    CODEXPRO_MAX_OUTPUT_BYTES: String(SHIM_MAX_OUTPUT_BYTES)
  });
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

  const { client: admissionClient, workspaceId: admissionWorkspaceId } = await openMcpClient(clients, rgShimDir, {
    CODEXPRO_MAX_OUTPUT_BYTES: String(SHIM_MAX_OUTPUT_BYTES),
    CODEXPRO_RG_SHIM_MODE: 'hidden-admission-flood'
  });
  const admissionSearch = makeSearch(admissionClient, admissionWorkspaceId);
  const hiddenFloodExcluded = await admissionSearch({
    query: FLOOD_NEEDLE,
    intent: 'symbol',
    include_hidden: false,
    max_results: 1
  });
  assert.equal(hiddenFloodExcluded.structuredContent.used, 'ripgrep', 'hidden flood exclusion did not use ripgrep');
  assert.deepEqual(lexicalPaths(hiddenFloodExcluded), ['src/visible.ts'], 'eligible visible result was starved by excluded hidden flood');
  assertNoHiddenEvidence(hiddenFloodExcluded, 'hidden flood exclusion');
  assert.equal(hiddenFloodExcluded.structuredContent.truncated, false, 'excluded hidden flood incorrectly set truncation');

  const hiddenFloodIncluded = await admissionSearch({
    query: FLOOD_NEEDLE,
    intent: 'symbol',
    include_hidden: true,
    max_results: 1
  });
  assert.equal(hiddenFloodIncluded.structuredContent.used, 'ripgrep', 'hidden flood inclusion did not use ripgrep');
  assertPathPresent(lexicalPaths(hiddenFloodIncluded), '.hidden-root.ts', 'included hidden flood result');
  assertPathAbsent(lexicalPaths(hiddenFloodIncluded), 'src/visible.ts', 'included hidden flood unexpectedly returned later visible result');
  assert.equal(hiddenFloodIncluded.structuredContent.truncated, true, 'eligible hidden flood did not consume bounded output/result budget');

  const { client: blockedClient, workspaceId: blockedWorkspaceId } = await openMcpClient(clients, rgShimDir, {
    CODEXPRO_MAX_OUTPUT_BYTES: String(SHIM_MAX_OUTPUT_BYTES),
    CODEXPRO_RG_SHIM_MODE: 'blocked-admission-flood'
  });
  const blockedSearch = makeSearch(blockedClient, blockedWorkspaceId);
  const blockedFloodExcluded = await blockedSearch({
    query: BLOCKED_FLOOD_NEEDLE,
    intent: 'symbol',
    include_hidden: false,
    max_results: 1
  });
  assert.equal(blockedFloodExcluded.structuredContent.used, 'ripgrep', 'blocked flood exclusion did not use ripgrep');
  assert.deepEqual(lexicalPaths(blockedFloodExcluded), ['src/visible.ts'], 'eligible visible result was starved by blocked/outside flood');
  assertPathAbsentEverywhere(blockedFloodExcluded, 'blocked/secret.ts', 'blocked flood leaked into evidence');
  assertPathAbsentEverywhere(blockedFloodExcluded, '../codexpro-search-evidence-outside.ts', 'outside flood leaked into evidence');
  assert.equal(blockedFloodExcluded.structuredContent.truncated, false, 'excluded blocked/outside flood incorrectly set truncation');

  const { client: malformedClient, workspaceId: malformedWorkspaceId } = await openMcpClient(clients, rgShimDir, {
    CODEXPRO_MAX_OUTPUT_BYTES: String(SHIM_MAX_OUTPUT_BYTES),
    CODEXPRO_RG_SHIM_MODE: 'malformed-unterminated'
  });
  const malformedResult = await callSearch(malformedClient, malformedWorkspaceId, {
    query: MALFORMED_NEEDLE,
    intent: 'symbol',
    include_hidden: false,
    max_results: 1
  });
  assert.equal(malformedResult.isError, true, 'unterminated oversized record was not rejected as an MCP error');
  const malformedErrorText = mcpErrorText(malformedResult);
  assert(malformedErrorText.length > 0, 'unterminated oversized record returned an empty MCP error');
  assert(malformedErrorText.length <= 2_000, `malformed MCP error was not bounded: ${malformedErrorText.length} bytes`);
  assert(!malformedErrorText.includes(malformedPayloadMarker), 'malformed MCP error echoed producer payload');
  const postMalformed = await malformedClient.request('tools/call', {
    name: 'search',
    arguments: {
      workspace_id: malformedWorkspaceId,
      query: AFTER_MALFORMED_NEEDLE,
      intent: 'symbol',
      include_hidden: false,
      max_results: 1
    }
  });
  let malformedClientUsable = false;
  if (!postMalformed.isError) {
    assertSearchSucceeded(postMalformed, 'post-malformed search');
    assert.deepEqual(lexicalPaths(postMalformed), ['src/visible.ts'], 'post-malformed search returned the wrong lexical evidence');
    malformedClientUsable = true;
  }
  if (!malformedClientUsable) {
    malformedClient.close();
    assert(await malformedClient.waitForExit(), 'malformed-record client neither remained usable nor closed cleanly');
  }

  const { client: malformedJsonClient, workspaceId: malformedJsonWorkspaceId } = await openMcpClient(clients, rgShimDir, {
    CODEXPRO_MAX_OUTPUT_BYTES: String(SHIM_MAX_OUTPUT_BYTES),
    CODEXPRO_RG_SHIM_MODE: 'malformed-json'
  });
  const malformedJsonResult = await callSearch(malformedJsonClient, malformedJsonWorkspaceId, {
    query: MALFORMED_NEEDLE,
    intent: 'symbol',
    include_hidden: false,
    max_results: 1
  });
  assert.equal(malformedJsonResult.isError, true, 'malformed JSON line was not rejected as an MCP error');
  const malformedJsonErrorText = mcpErrorText(malformedJsonResult);
  assert(malformedJsonErrorText.length > 0, 'malformed JSON line returned an empty MCP error');
  assert(malformedJsonErrorText.length <= 2_000, `malformed JSON MCP error was not bounded: ${malformedJsonErrorText.length} bytes`);
  assert(!malformedJsonErrorText.includes(malformedPayloadMarker), 'malformed JSON MCP error echoed producer payload');

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
    admission_boundary: {
      hidden_flood_excluded: { paths: lexicalPaths(hiddenFloodExcluded), truncated: hiddenFloodExcluded.structuredContent.truncated },
      hidden_flood_included: { paths: lexicalPaths(hiddenFloodIncluded), truncated: hiddenFloodIncluded.structuredContent.truncated },
      blocked_outside_flood_excluded: { paths: lexicalPaths(blockedFloodExcluded), truncated: blockedFloodExcluded.structuredContent.truncated },
      max_output_bytes: SHIM_MAX_OUTPUT_BYTES
    },
    malformed_record: {
      is_error: malformedResult.isError === true,
      error_bytes: Buffer.byteLength(malformedErrorText, 'utf8'),
      client_reused: malformedClientUsable,
      malformed_json_is_error: malformedJsonResult.isError === true,
      malformed_json_error_bytes: Buffer.byteLength(malformedJsonErrorText, 'utf8')
    },
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
