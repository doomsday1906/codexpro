import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-quality-task002-'));

async function write(relativePath, content) {
  const target = path.join(fixtureRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function analysisOf(result) {
  assert(result.analysis, 'structured search omitted analysis');
  return result.analysis;
}

function withoutCache(result) {
  const analysis = analysisOf(result);
  return { ...result, analysis: { ...analysis, cache: { hit: false, key: '<normalized>' } } };
}

try {
  await write('package.json', JSON.stringify({ name: 'task002-fixture' }, null, 2));
  await write('src/repeated.ts', Array.from({ length: 20 }, (_, index) => `const marker${index} = 'StableNeedle';`).join('\n') + '\n');
  await write('src/target.ts', 'export class StableTarget {}\n');
  await write('src/consumer.ts', "import { StableTarget } from './target.js';\nconst current = StableTarget;\n");
  await write('src/definitions.ts', "export function PreserveDefinition() {}\nconst note = PreserveDefinition;\nexport function PreserveDefinition() {}\n");

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { searchWorkspace }] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('searchOps.js')
  ]);
  const config = loadConfig(['--root', fixtureRoot, '--allow-root', fixtureRoot, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  const repeatedResult = await searchWorkspace(config, guard, workspace, {
    query: 'StableNeedle',
    intent: 'text',
    includeTests: false,
    maxResults: 20
  });
  const repeated = analysisOf(repeatedResult);
  const repeatedMatches = repeated.matches.filter((match) => match.path === 'src/repeated.ts');
  assert.equal(repeated.schemaVersion, 2, 'structured accumulator did not expose schema v2');
  assert.equal(repeatedMatches.length, 1, `same-file occurrences were not compressed: ${JSON.stringify(repeatedMatches)}`);
  assert.equal(repeatedMatches[0].line, 1);
  assert.equal(repeatedMatches[0].occurrenceCount, 20);
  assert.deepEqual(repeatedMatches[0].additionalLines, Array.from({ length: 16 }, (_, index) => index + 2));
  assert.equal(repeatedMatches[0].additionalLinesTruncated, true);
  assert.equal(new Set(repeatedMatches[0].additionalLines).size, repeatedMatches[0].additionalLines.length);
  console.log(`RAW_OBSERVATION: src/repeated.ts has one structured record at line ${repeatedMatches[0].line}, with occurrenceCount=${repeatedMatches[0].occurrenceCount} and additionalLines=${repeatedMatches[0].additionalLines.length}; no second record represents the same file/group.`);
  console.log('SANITY_VERDICT: MATCH — repeated physical lines are represented by one visible record and bounded line provenance preserves that more occurrences existed.');

  const referenceResult = await searchWorkspace(config, guard, workspace, {
    query: 'StableTarget',
    intent: 'references',
    includeTests: true,
    maxResults: 20
  });
  const references = analysisOf(referenceResult);
  const consumerMatches = references.matches.filter((match) => match.path === 'src/consumer.ts');
  assert.equal(consumerMatches.filter((match) => match.line === 1).length, 1, 'identical path/line evidence remained duplicated');
  assert.equal(consumerMatches.length, 1, 'same-file references were not compressed');
  assert(consumerMatches[0].reasons.includes('dependent module'));
  assert(consumerMatches[0].reasons.includes('exact text match'));
  assert(consumerMatches[0].reasons.includes('imports relationship'));
  assert(consumerMatches[0].reasons.includes('lexical exact match'));
  assert(consumerMatches[0].provenance?.includes('built-in analysis'));
  assert(consumerMatches[0].provenance?.includes('built-in import extraction'));
  assert(consumerMatches[0].provenance?.includes('lexical'));
  console.log(`RAW_OBSERVATION: src/consumer.ts appears once in references at line ${consumerMatches[0].line}; its reasons include source text plus relationship and lexical evidence, and provenance has ${consumerMatches[0].provenance.length} producers.`);
  console.log('SANITY_VERDICT: MATCH — one path/line record carries the independently visible text and relationship evidence without a duplicate logical hit.');

  const definitionsResult = await searchWorkspace(config, guard, workspace, {
    query: 'PreserveDefinition',
    intent: 'symbol',
    includeTests: false,
    maxResults: 20
  });
  const definitions = analysisOf(definitionsResult);
  const definitionLines = definitions.groups.definitions
    .filter((match) => match.path === 'src/definitions.ts')
    .map((match) => match.line);
  assert.deepEqual(definitionLines, [1, 3], 'distinct definition lines were compressed together');
  assert.equal(definitions.groups.references.filter((match) => match.path === 'src/definitions.ts').length, 1);

  const repeatedAgain = await searchWorkspace(config, guard, workspace, {
    query: 'StableNeedle',
    intent: 'text',
    includeTests: false,
    maxResults: 20
  });
  assert.deepEqual(withoutCache(repeatedAgain), withoutCache(repeatedResult), 'structured evidence changed across identical input order');
  console.log('PASS TASK-002 accumulator, merged provenance/reasons, bounded occurrence compression, definition preservation, and deterministic repeat.');
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
