import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-quality-task004-'));

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
  await write('package.json', JSON.stringify({ name: 'task004-fixture' }, null, 2));

  // Python module chain:
  // pkg/base.py defines BaseService
  // pkg/direct.py imports from pkg.base import BaseService
  // pkg/transitive.py imports from pkg.direct import DirectService
  // tests/test_base.py imports from pkg.base import BaseService
  // tests/test_unlinked_base.py (fallback test with matching filename)
  await write('pkg/__init__.py', '');
  await write('pkg/base.py', [
    'class BaseService:',
    '    def execute(self): pass'
  ].join('\n') + '\n');

  await write('pkg/direct.py', [
    'from pkg.base import BaseService',
    'class DirectService(BaseService):',
    '    pass'
  ].join('\n') + '\n');

  await write('pkg/transitive.py', [
    'from pkg.direct import DirectService',
    'class TransitiveConsumer:',
    '    service = DirectService()'
  ].join('\n') + '\n');

  // Cycle test: cycle_a imports cycle_b, cycle_b imports cycle_a, cycle_a imports base
  await write('pkg/cycle_a.py', [
    'from pkg.base import BaseService',
    'from pkg.cycle_b import CycleB'
  ].join('\n') + '\n');

  await write('pkg/cycle_b.py', [
    'from pkg.cycle_a import BaseService'
  ].join('\n') + '\n');

  await write('pkg/sibling.py', 'class Sibling:\n    pass\n');
  await write('pkg/submodule.py', 'class Submodule:\n    pass\n');
  await write('pkg/multi.py', [
    'import pkg.base as base, pkg.direct as direct',
    'from . import sibling, submodule',
    'from pkg.base import BaseService, DirectService'
  ].join('\n') + '\n');
  await write('pkg/multiline.py', [
    'from pkg import (',
    '    # comments do not hide imported names',
    '    submodule, # trailing comment',
    '    sibling,',
    ')'
  ].join('\n') + '\n');
  await write('pkg/continued.py', [
    'import pkg.base, \\',
    '    pkg.direct'
  ].join('\n') + '\n');
  await write('pkg/submodule_consumer.py', [
    'from pkg import submodule'
  ].join('\n') + '\n');
  await write('pkg/package_export_consumer.py', [
    'from pkg import BaseService'
  ].join('\n') + '\n');
  await write('pkg/sub/escape.py', [
    'from ....outside import NotARealModule'
  ].join('\n') + '\n');

  await write('tests/test_base.py', [
    'from pkg.base import BaseService',
    'def test_base(): pass'
  ].join('\n') + '\n');

  await write('tests/test_base_service_fallback.py', [
    '# Test file for BaseService without explicit import',
    'def test_unlinked(): pass'
  ].join('\n') + '\n');

  const [
    { loadConfig },
    { PathGuard, WorkspaceManager },
    { searchWorkspace },
    { inspectWorkspace },
    { traverseImpactGraph, IMPACT_TRAVERSAL_TRUNCATION_WARNING }
  ] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('searchOps.js'),
    importBuilt('analysis/index.js'),
    importBuilt('analysis/graph.js')
  ]);

  const config = loadConfig(['--root', fixtureRoot, '--allow-root', fixtureRoot, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  // Test 1: AP-007: Python relationship extraction produces bounded internal graph edges
  const analysis = await inspectWorkspace(config, guard, workspace);
  const pythonRels = analysis.relationships;
  assert(pythonRels.length > 0, 'No Python relationships extracted');
  assert(pythonRels.some((r) => r.from === 'pkg/direct.py' && r.to === 'pkg/base.py' && r.kind === 'imports'), 'direct import relationship missing');
  assert(pythonRels.some((r) => r.from === 'pkg/transitive.py' && r.to === 'pkg/direct.py' && r.kind === 'imports'), 'transitive import relationship missing');
  assert(pythonRels.some((r) => r.from === 'tests/test_base.py' && r.to === 'pkg/base.py' && r.kind === 'tests'), 'test relationship missing');
  const multiLine = pythonRels.filter((r) => r.from === 'pkg/multi.py');
  assert(multiLine.some((r) => r.to === 'pkg/base.py' && r.line === 1 && r.text === 'import pkg.base as base, pkg.direct as direct'), 'aliased multi-import provenance missing');
  assert(multiLine.some((r) => r.to === 'pkg/direct.py' && r.line === 1), 'second aliased import missing');
  assert(multiLine.some((r) => r.to === 'pkg/sibling.py' && r.line === 2), 'dot-only relative sibling import missing');
  assert(multiLine.some((r) => r.to === 'pkg/submodule.py' && r.line === 2), 'dot-only relative submodule import missing');
  assert(multiLine.some((r) => r.to === 'pkg/base.py' && r.line === 3), 'multiple from-import names missing');
  const multilineImports = pythonRels.filter((r) => r.from === 'pkg/multiline.py');
  assert(multilineImports.some((r) => r.to === 'pkg/submodule.py' && r.line === 1), 'commented multiline package import missing submodule');
  assert(multilineImports.some((r) => r.to === 'pkg/sibling.py' && r.line === 1), 'commented multiline package import missing sibling');
  const continuedImports = pythonRels.filter((r) => r.from === 'pkg/continued.py');
  assert(continuedImports.some((r) => r.to === 'pkg/base.py' && r.line === 1), 'continued import missing first module');
  assert(continuedImports.some((r) => r.to === 'pkg/direct.py' && r.line === 1), 'continued import missing second module');
  const submoduleImport = pythonRels.filter((r) => r.from === 'pkg/submodule_consumer.py');
  assert.deepEqual(submoduleImport.map((r) => r.to), ['pkg/submodule.py'], 'from-package submodule created a false __init__ edge');
  assert(pythonRels.some((r) => r.from === 'pkg/package_export_consumer.py' && r.to === 'pkg/__init__.py'), 'from-package exported name lost package edge');
  assert.equal(pythonRels.some((r) => r.from === 'pkg/sub/escape.py'), false, 'relative import escaped the guarded inventory');
  console.log('PASS: AP-007: Python relationship extraction cleanly produces internal graph edges.');

  // Test 2: Graph traversal with cycle avoidance and depth tracking
  const baseDefPaths = new Set(['pkg/base.py']);
  const impactTraversed = traverseImpactGraph(baseDefPaths, analysis.relationships, {
    maxDepth: 3,
    includeTests: true
  });
  assert(impactTraversed.results.some((t) => t.path === 'pkg/direct.py' && t.depth === 1), 'direct dependent missing at depth 1');
  assert(impactTraversed.results.some((t) => t.path === 'pkg/transitive.py' && t.depth === 2), 'transitive dependent missing at depth 2');
  assert(impactTraversed.results.some((t) => t.path === 'tests/test_base.py' && t.depth === 1 && t.kind === 'tests'), 'test dependent missing at depth 1');
  // Cycle safety: cycle_a and cycle_b are visited at most once
  const cycleACount = impactTraversed.results.filter((t) => t.path === 'pkg/cycle_a.py').length;
  const cycleBCount = impactTraversed.results.filter((t) => t.path === 'pkg/cycle_b.py').length;
  assert.equal(cycleACount, 1, 'cycle_a was visited more than once');
  assert.equal(cycleBCount, 1, 'cycle_b was visited more than once');
  const depthBounded = traverseImpactGraph(baseDefPaths, analysis.relationships, {
    maxDepth: 1,
    includeTests: true
  });
  assert.equal(depthBounded.results.some((t) => t.path === 'pkg/transitive.py'), false, 'impact exceeded the configured depth bound');
  const candidateBounded = traverseImpactGraph(baseDefPaths, analysis.relationships, {
    maxDepth: 3,
    maxCandidates: 1,
    includeTests: true
  });
  assert.equal(candidateBounded.results.length, 1, 'impact exceeded the configured candidate bound');
  assert.equal(candidateBounded.truncated, true, 'candidate bound did not report remaining reachable impact work');

  const exactBoundGraph = [
    { from: 'direct.py', to: 'base.py', kind: 'imports', confidence: 'strong', source: 'fixture', line: 1 }
  ];
  const exactBound = traverseImpactGraph(new Set(['base.py']), exactBoundGraph, { maxDepth: 3, maxCandidates: 1 });
  assert.equal(exactBound.results.length, 1, 'exact-bound graph did not return its only candidate');
  assert.equal(exactBound.truncated, false, 'naturally exhausted exact-bound graph was marked truncated');

  const cycleOnlyGraph = [
    { from: 'cycle-a.py', to: 'base.py', kind: 'imports', confidence: 'strong', source: 'fixture', line: 1 },
    { from: 'cycle-b.py', to: 'cycle-a.py', kind: 'imports', confidence: 'strong', source: 'fixture', line: 1 },
    { from: 'cycle-a.py', to: 'cycle-b.py', kind: 'imports', confidence: 'strong', source: 'fixture', line: 2 }
  ];
  const cycleBounded = traverseImpactGraph(new Set(['base.py']), cycleOnlyGraph, { maxDepth: 3, maxCandidates: 2 });
  assert.equal(cycleBounded.results.length, 2, 'cycle graph did not return both unique candidates');
  assert.equal(cycleBounded.truncated, false, 'cycle closure was mistaken for remaining impact work');
  console.log(`RAW_OBSERVATION: bounded graph returned ${candidateBounded.results.length} candidate and reported truncated=${candidateBounded.truncated}; exact-bound graph returned ${exactBound.results.length} candidate and reported truncated=${exactBound.truncated}; cycle graph reported truncated=${cycleBounded.truncated}.`);
  console.log('PASS: Reverse dependency traversal handles depth, transitive dependencies, cycles, and exact truncation truth.');

  // Test 3: AP-008: End-to-end impact search returns direct/transitive modules and tests
  const impactResult = await searchWorkspace(config, guard, workspace, {
    query: 'BaseService',
    intent: 'impact',
    includeTests: true,
    maxResults: 20
  });
  const impactAnalysis = analysisOf(impactResult);
  assert.equal(impactAnalysis.intent, 'impact', 'intent was not impact');
  assert.equal(impactAnalysis.groups.definitions.length, 1, 'BaseService definition missing');
  assert.equal(impactAnalysis.groups.definitions[0].path, 'pkg/base.py');

  // Verify direct dependent module
  const directMatch = impactAnalysis.matches.find((m) => m.path === 'pkg/direct.py');
  assert(directMatch, 'direct dependent module missing from matches');
  assert(directMatch.reasons.includes('dependent module'));
  assert(directMatch.reasons.some((r) => r.includes('imports pkg/base.py')));
  assert.equal(directMatch.line, 1, 'impact relationship did not retain its physical import line');
  assert.equal(directMatch.text, 'from pkg.base import BaseService', 'impact relationship did not retain its source text');
  assert.equal(directMatch.occurrenceCount, 2, 'impact did not retain both physical evidence lines');
  assert.deepEqual(directMatch.additionalLines, [2], 'impact occurrence provenance included an invented or missing line');

  // Verify transitive dependent module
  const transitiveMatch = impactAnalysis.matches.find((m) => m.path === 'pkg/transitive.py');
  assert(transitiveMatch, 'transitive dependent module missing from matches');
  assert(transitiveMatch.reasons.includes('transitive dependent module'));
  assert(transitiveMatch.reasons.some((r) => r.includes('transitive dependent via')));

  // Verify test dependent
  const testMatch = impactAnalysis.groups.tests.find((m) => m.path === 'tests/test_base.py');
  assert(testMatch, 'direct test dependent missing from groups.tests');
  assert(testMatch.reasons.includes('dependent test'));

  // Verify fallback test
  const fallbackTest = impactAnalysis.groups.tests.find((m) => m.path === 'tests/test_base_service_fallback.py');
  assert(fallbackTest, 'fallback test missing from groups.tests');
  assert(fallbackTest.reasons.includes('test filename matches definition'));

  const boundedImpactResult = await searchWorkspace(config, guard, workspace, {
    query: 'BaseService',
    intent: 'impact',
    includeTests: true,
    maxResults: 1
  });
  const boundedImpactAnalysis = analysisOf(boundedImpactResult);
  assert(boundedImpactAnalysis.warnings.includes(IMPACT_TRAVERSAL_TRUNCATION_WARNING), 'public structured impact omitted traversal truncation warning');
  assert(boundedImpactAnalysis.coverage.warnings.includes(IMPACT_TRAVERSAL_TRUNCATION_WARNING), 'coverage omitted traversal truncation warning');
  assert.equal(boundedImpactAnalysis.coverage.truncated, true, 'public structured impact omitted traversal truncation state');
  console.log(`RAW_OBSERVATION: bounded public impact warnings=${JSON.stringify(boundedImpactAnalysis.warnings.filter((warning) => warning === IMPACT_TRAVERSAL_TRUNCATION_WARNING))}; coverage.truncated=${boundedImpactAnalysis.coverage.truncated}.`);

  console.log('PASS: AP-008: impact returns direct/transitive affected modules and relevant tests with reasons.');
  console.log('ALL TASK-004 SMOKE CHECKS PASSED.');
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
