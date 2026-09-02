import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-quality-task005-'));

async function write(relativePath, content) {
  const target = path.join(fixtureRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function analysisOf(result) {
  assert(result.analysis, 'structured search omitted analysis');
  return result.analysis;
}

try {
  await write('package.json', JSON.stringify({ name: 'task005-fixture' }, null, 2));

  // Fixture 1: Test saturation scenario
  await write('src/target.ts', 'export class NeedleSymbol {}\n');
  for (let i = 0; i < 15; i++) {
    const pad = String(i).padStart(2, '0');
    await write(`src/consumer-${pad}.ts`, `import { NeedleSymbol } from "./target";\nconst ref_${pad} = NeedleSymbol;\n`);
  }
  for (let i = 0; i < 30; i++) {
    const pad = String(i).padStart(2, '0');
    await write(`tests/test-${pad}.test.ts`, `import { NeedleSymbol } from "../src/target";\ndescribe("NeedleSymbol ${pad}", () => {});\n`);
  }

  // Fixture 2: Visible + hidden saturation scenario
  for (let i = 0; i < 25; i++) {
    const pad = String(i).padStart(2, '0');
    await write(`src/visible-item-${pad}.ts`, `const marker = "HiddenProofMarker";\n`);
  }
  for (let i = 0; i < 5; i++) {
    const pad = String(i).padStart(2, '0');
    await write(`src/.hidden/item-${pad}.ts`, `const marker = "HiddenProofMarker";\n`);
  }

  const [
    { loadConfig },
    { PathGuard, WorkspaceManager },
    { searchWorkspace }
  ] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('searchOps.js')
  ]);

  const config = loadConfig(['--root', fixtureRoot, '--allow-root', fixtureRoot, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  // Test 1: AP-009: Test saturation cannot monopolize references when source references exist
  const refResult = await searchWorkspace(config, guard, workspace, {
    query: 'NeedleSymbol',
    intent: 'references',
    includeTests: true,
    maxResults: 20
  });
  const refAnalysis = analysisOf(refResult);
  const testCount = refAnalysis.groups.tests.length;
  const sourceRefCount = refAnalysis.groups.references.length;
  const defCount = refAnalysis.groups.definitions.length;

  console.log(`RAW_OBSERVATION: AP-009 groups: definitions=${defCount}, references=${sourceRefCount}, tests=${testCount}`);
  assert(defCount >= 1, 'Definition was missing from references intent');
  assert(sourceRefCount >= 8, `Source references were starved (count=${sourceRefCount})`);
  assert(testCount <= 10, `Tests monopolized the result (count=${testCount})`);
  assert(testCount > 0, 'Relevant tests were not represented');
  console.log('PASS: AP-009: Fair scheduling prevents tests from monopolizing references while source references exist.');

  // Test 2: AP-010: Visible + hidden saturation
  // 2a: include_hidden=false -> ZERO hidden results
  const hiddenFalseResult = await searchWorkspace(config, guard, workspace, {
    query: 'HiddenProofMarker',
    intent: 'text',
    includeHidden: false,
    maxResults: 20
  });
  const hiddenFalseAnalysis = analysisOf(hiddenFalseResult);
  const hiddenMatchesWhenFalse = hiddenFalseAnalysis.matches.filter((m) => m.path.includes('.hidden'));
  assert.equal(hiddenMatchesWhenFalse.length, 0, 'Hidden file leaked into includeHidden=false');
  assert.equal(hiddenFalseAnalysis.matches.length, 20, 'Expected 20 visible matches');
  console.log('PASS: AP-010 (negative): include_hidden=false strictly admits zero hidden files.');

  // 2b: include_hidden=true -> hidden candidate is reserved and participates alongside visible
  const hiddenTrueResult = await searchWorkspace(config, guard, workspace, {
    query: 'HiddenProofMarker',
    intent: 'text',
    includeHidden: true,
    maxResults: 20
  });
  const hiddenTrueAnalysis = analysisOf(hiddenTrueResult);
  const visibleMatches = hiddenTrueAnalysis.matches.filter((m) => !m.path.includes('.hidden'));
  const hiddenMatches = hiddenTrueAnalysis.matches.filter((m) => m.path.includes('.hidden'));
  console.log(`RAW_OBSERVATION: AP-010 visible=${visibleMatches.length}, hidden=${hiddenMatches.length}`);
  assert(visibleMatches.length > 0, 'Visible matches were missing in includeHidden=true');
  assert(hiddenMatches.length > 0, 'Hidden matches were starved despite includeHidden=true');
  assert(hiddenMatches.some((m) => m.path.startsWith('src/.hidden/')), 'Expected src/.hidden file in matches');
  console.log('PASS: AP-010 (positive): include_hidden=true reserves participation for hidden candidates without starving visible evidence.');

  console.log('ALL TASK-005 SMOKE CHECKS PASSED.');
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
