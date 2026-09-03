import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-quality-task003-'));

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
  await write('package.json', JSON.stringify({ name: 'task003-fixture' }, null, 2));

  // Definition ranking tier fixtures
  await write('src/exactDefinitions.ts', [
    'export class ExactMatchTarget {}',
    'export function ExactMatchTargetFunc() {}',
    'export const ExactMatchTargetVar = 1;'
  ].join('\n') + '\n');

  await write('src/caseInsensitiveDefinitions.ts', [
    'export class exactmatchtarget {}',
    'export function exactmatchtargetfunc() {}',
    'export const exactmatchtargetvar = 1;'
  ].join('\n') + '\n');

  await write('src/prefixDefinitions.ts', [
    'export class ExactMatchTargetExtendedClass {}',
    'export function ExactMatchTargetExtendedFunc() {}',
    'export const ExactMatchTargetExtendedVar = 1;'
  ].join('\n') + '\n');

  // BodyForm type-family test fixture
  await write('src/bodyFormVariable.ts', 'const bodyForm = "incidental local variable";\n');
  await write('src/BodyFormClass.ts', 'export class BodyFormCatalogDefinition {}\nexport class BodyFormSourceV2 {}\n');
  await write('docs/bodyForm.md', '# Census documentation\nMentions BodyForm data in legacy documentation.\n');

  // Test role classification fixtures
  await write('scripts/search-evidence-smoke.mjs', 'const proofMarker = "SmokeNeedle";\n');
  await write('scripts/smoke.mjs', 'const proofMarker = "SmokeNeedle";\n');
  await write('e2e/app-smoke.ts', 'const proofMarker = "SmokeNeedle";\n');
  await write('tests/unit.test.ts', 'const proofMarker = "SmokeNeedle";\n');
  await write('src/ordinarySource.ts', 'const proofMarker = "SmokeNeedle";\n');
  await write('src/smoke.ts', 'const proofMarker = "SmokeNeedle";\n');
  await write('src/widget-smoke.ts', 'const proofMarker = "SmokeNeedle";\n');

  // Search-scope fixtures: stronger definitions/dependents/tests live in a
  // nearby directory and must not influence a scoped structured query.
  await write('scope/allowed/ScopeOnlyAuto.txt', 'ScopeOnlyAuto appears as text in the requested root.\n');
  await write('scope/nearby/ScopeOnlyAuto.ts', 'export class ScopeOnlyAuto {}\n');
  await write('scope/allowed/scoped_target.py', 'class ScopedTarget:\n    pass\n');
  await write('scope/allowed/allowed_dependent.py', 'from scope.allowed.scoped_target import ScopedTarget\nclass AllowedDependent:\n    pass\n');
  await write('scope/nearby/nearby_dependent.py', 'from scope.allowed.scoped_target import ScopedTarget\nclass NearbyDependent:\n    pass\n');
  await write('scope/allowed/tests/test_scoped_target.py', 'from scope.allowed.scoped_target import ScopedTarget\ndef test_scoped_target():\n    assert ScopedTarget\n');
  await write('scope/nearby/tests/test_scoped_target.py', 'from scope.allowed.scoped_target import ScopedTarget\ndef test_nearby_scoped_target():\n    assert ScopedTarget\n');
  await write('scope/allowed/scoped_glob.py', 'class ScopedGlob:\n    pass\n');
  await write('scope/allowed/scoped_glob.ts', 'const scopedGlob = "ScopedGlob";\n');
  await write('scope/nearby/scoped_glob.py', 'class ScopedGlob:\n    pass\n');
  await write('scope/allowed/fallback_target.py', 'class FallbackTarget:\n    pass\n');
  await write('scope/allowed/tests/test_fallback_target.py', '# filename-only fallback evidence\n');
  await write('scope/nearby/tests/test_fallback_target.py', '# nearby filename-only fallback must stay out of scope\n');

  const [
    { loadConfig },
    { PathGuard, WorkspaceManager },
    { searchWorkspace },
    { classifyFileRole },
    { classifyDefinitionMatch, isTypeFamilyPrefix, symbolKindTier }
  ] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('searchOps.js'),
    importBuilt('analysis/classify.js'),
    importBuilt('analysis/rank.js')
  ]);

  const config = loadConfig(['--root', fixtureRoot, '--allow-root', fixtureRoot, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  // Test 1: File role classification including scripts/*-smoke.* and e2e
  assert.equal(classifyFileRole('scripts/search-evidence-smoke.mjs'), 'test', 'search-evidence-smoke.mjs was not classified as test');
  assert.equal(classifyFileRole('scripts/smoke.mjs'), 'test', 'smoke.mjs was not classified as test');
  assert.equal(classifyFileRole('scripts/analysis-smoke.mjs'), 'test', 'analysis-smoke.mjs was not classified as test');
  assert.equal(classifyFileRole('e2e/app-smoke.ts'), 'test', 'e2e/app-smoke.ts was not classified as test');
  assert.equal(classifyFileRole('tests/unit.test.ts'), 'test', 'tests/unit.test.ts was not classified as test');
  assert.equal(classifyFileRole('src/ordinarySource.ts'), 'source', 'src/ordinarySource.ts was misclassified');
  assert.equal(classifyFileRole('src/smoke.ts'), 'source', 'src/smoke.ts was misclassified as test');
  assert.equal(classifyFileRole('src/widget-smoke.ts'), 'source', 'src/widget-smoke.ts was misclassified as test');
  console.log('PASS: File role classification correctly identifies scripts/*-smoke.* and e2e proof scripts as tests.');

  // Test 2: Definition ranking tiers
  const exactClassTier = classifyDefinitionMatch({ name: 'ExactMatchTarget', kind: 'class' }, 'ExactMatchTarget');
  const exactFuncTier = classifyDefinitionMatch({ name: 'ExactMatchTarget', kind: 'function' }, 'ExactMatchTarget');
  const exactVarTier = classifyDefinitionMatch({ name: 'ExactMatchTarget', kind: 'variable' }, 'ExactMatchTarget');
  assert.equal(exactClassTier.nameTier, 0, 'exact case-sensitive was not tier 0');
  assert.equal(exactClassTier.kindTier, 0, 'class was not kind tier 0');
  assert.equal(exactFuncTier.kindTier, 1, 'function was not kind tier 1');
  assert.equal(exactVarTier.kindTier, 2, 'variable was not kind tier 2');
  assert(exactClassTier.score > exactFuncTier.score, 'class did not outrank function in tier 0');
  assert(exactFuncTier.score > exactVarTier.score, 'function did not outrank variable in tier 0');

  // Test 3: BodyForm type-family ranking: BodyForm* class outranks incidental lowercase bodyForm variable
  const bodyFormClassTier = classifyDefinitionMatch({ name: 'BodyFormCatalogDefinition', kind: 'class' }, 'BodyForm');
  const bodyFormVarTier = classifyDefinitionMatch({ name: 'bodyForm', kind: 'variable' }, 'BodyForm');
  assert(isTypeFamilyPrefix('BodyForm'), 'BodyForm was not identified as type family prefix');
  assert(bodyFormClassTier.score > bodyFormVarTier.score, 'BodyForm class did not outrank bodyForm variable');
  console.log(`RAW_OBSERVATION: BodyFormCatalogDefinition score=${bodyFormClassTier.score} vs bodyForm variable score=${bodyFormVarTier.score}`);
  console.log('PASS: Type-family ranking correctly prioritizes class definitions over incidental lowercase variables.');

  // Test 4: Live search on BodyForm: auto intent, definitions ordering, and doc ranking
  const bodyFormSearchResult = await searchWorkspace(config, guard, workspace, {
    query: 'BodyForm',
    intent: 'auto',
    includeTests: false,
    maxResults: 20
  });
  const bodyFormAnalysis = analysisOf(bodyFormSearchResult);
  assert.equal(bodyFormAnalysis.intent, 'symbol', 'auto did not resolve to symbol for existing symbol BodyForm');
  const defs = bodyFormAnalysis.groups.definitions;
  assert(defs.length >= 2, 'expected definitions for BodyForm');
  const classIndex = defs.findIndex((m) => m.path === 'src/BodyFormClass.ts');
  const varIndex = defs.findIndex((m) => m.path === 'src/bodyFormVariable.ts');
  assert(classIndex !== -1, 'BodyFormClass not found in definitions');
  assert(varIndex !== -1, 'bodyFormVariable not found in definitions');
  assert(classIndex < varIndex, `BodyForm class at ${classIndex} did not precede bodyForm variable at ${varIndex}`);
  // Definitions must precede documentation
  const docMatches = bodyFormAnalysis.matches.filter((m) => m.path === 'docs/bodyForm.md');
  if (docMatches.length > 0) {
    const docIndex = bodyFormAnalysis.matches.indexOf(docMatches[0]);
    assert(classIndex < docIndex, 'BodyForm class did not precede documentation');
  }
  console.log('PASS: AP-005: BodyForm symbol/auto surfaces real type/class definitions before incidental variables.');

  // Test 5: auto intent predictability
  const nonExistentResult = await searchWorkspace(config, guard, workspace, {
    query: 'NonExistentSymbolIdentifier123',
    intent: 'auto',
    includeTests: false,
    maxResults: 20
  });
  assert.equal(analysisOf(nonExistentResult).intent, 'text', 'auto did not resolve to text for non-existent symbol');

  const whitespaceResult = await searchWorkspace(config, guard, workspace, {
    query: 'ExactMatchTarget with whitespace',
    intent: 'auto',
    includeTests: false,
    maxResults: 20
  });
  assert.equal(analysisOf(whitespaceResult).intent, 'text', 'auto did not resolve to text for query with spaces');

  const explicitIntentResult = await searchWorkspace(config, guard, workspace, {
    query: 'ExactMatchTarget',
    intent: 'references',
    includeTests: false,
    maxResults: 20
  });
  assert.equal(analysisOf(explicitIntentResult).intent, 'references', 'explicit intent did not win over auto');
  console.log('PASS: auto intent resolution is deterministic from real repository symbol evidence.');

  // Test 6: Independent test collection (AP-006)
  // 6a: include_tests=false excludes all tests
  const testsFalseResult = await searchWorkspace(config, guard, workspace, {
    query: 'SmokeNeedle',
    intent: 'text',
    includeTests: false,
    maxResults: 20
  });
  const testsFalseAnalysis = analysisOf(testsFalseResult);
  assert.equal(testsFalseAnalysis.groups.tests.length, 0, 'include_tests=false returned test matches');
  assert(testsFalseAnalysis.matches.some((m) => m.path === 'src/ordinarySource.ts'), 'source reference was not returned');
  assert(testsFalseAnalysis.matches.some((m) => m.path === 'src/smoke.ts'), 'src/smoke.ts source reference was not returned');
  assert(testsFalseAnalysis.matches.some((m) => m.path === 'src/widget-smoke.ts'), 'src/widget-smoke.ts source reference was not returned');
  assert(!testsFalseAnalysis.matches.some((m) => m.path.startsWith('scripts/')), 'smoke scripts leaked into include_tests=false');

  // 6b: include_tests=true includes tests without starving source
  const testsTrueResult = await searchWorkspace(config, guard, workspace, {
    query: 'SmokeNeedle',
    intent: 'text',
    includeTests: true,
    maxResults: 20
  });
  const testsTrueAnalysis = analysisOf(testsTrueResult);
  assert(testsTrueAnalysis.groups.tests.length > 0, 'include_tests=true returned 0 tests');
  assert(testsTrueAnalysis.groups.tests.some((m) => m.path === 'scripts/search-evidence-smoke.mjs'), 'search-evidence-smoke.mjs missing from tests');
  assert(testsTrueAnalysis.groups.references.some((m) => m.path === 'src/ordinarySource.ts'), 'ordinary source reference was starved by tests');
  assert(testsTrueAnalysis.groups.references.some((m) => m.path === 'src/smoke.ts'), 'src/smoke.ts source reference was misclassified');
  assert(testsTrueAnalysis.groups.references.some((m) => m.path === 'src/widget-smoke.ts'), 'src/widget-smoke.ts source reference was misclassified');

  // Source reference has score 150, test has score 130 -> source ranks before tests
  const srcIdx = testsTrueAnalysis.matches.findIndex((m) => m.path === 'src/ordinarySource.ts');
  const testIdx = testsTrueAnalysis.matches.findIndex((m) => m.path === 'scripts/search-evidence-smoke.mjs');
  assert(srcIdx < testIdx, `source reference at ${srcIdx} did not precede test at ${testIdx}`);
  console.log('PASS: AP-006: smoke proof scripts classify as tests; tests do not starve source references.');

  // Test 7: one exact root/glob/visibility predicate gates auto, definitions,
  // graph impact, filename fallback, scheduling, and the public projection.
  const scopedAutoResult = await searchWorkspace(config, guard, workspace, {
    query: 'ScopeOnlyAuto',
    intent: 'auto',
    root: 'scope/allowed',
    includeTests: true,
    maxResults: 20
  });
  const scopedAutoAnalysis = analysisOf(scopedAutoResult);
  console.log(`RAW_OBSERVATION: scoped auto payload intent=${scopedAutoAnalysis.intent}; analysis paths=${JSON.stringify(scopedAutoAnalysis.matches.map((match) => match.path))}; public paths=${JSON.stringify(scopedAutoResult.matches.map((match) => match.path))}`);
  assert.equal(scopedAutoAnalysis.intent, 'text', 'out-of-scope symbol evidence incorrectly selected auto=symbol');
  assert(scopedAutoAnalysis.matches.some((match) => match.path === 'scope/allowed/ScopeOnlyAuto.txt'), 'in-scope lexical fallback evidence was missing');
  assert(scopedAutoAnalysis.matches.every((match) => match.path === 'scope/allowed/ScopeOnlyAuto.txt'), 'scoped auto admitted an out-of-scope candidate');
  assert(scopedAutoResult.matches.every((match) => match.path === 'scope/allowed/ScopeOnlyAuto.txt'), 'public scoped auto projection escaped the requested root');

  const scopedImpactResult = await searchWorkspace(config, guard, workspace, {
    query: 'ScopedTarget',
    intent: 'impact',
    root: 'scope/allowed',
    includeTests: true,
    maxResults: 20
  });
  const scopedImpactAnalysis = analysisOf(scopedImpactResult);
  const scopedImpactPaths = scopedImpactAnalysis.matches.map((match) => match.path);
  console.log(`RAW_OBSERVATION: scoped impact analysis paths=${JSON.stringify(scopedImpactPaths)}; public paths=${JSON.stringify(scopedImpactResult.matches.map((match) => match.path))}`);
  assert(scopedImpactPaths.includes('scope/allowed/scoped_target.py'), 'scoped impact lost the in-scope definition');
  assert(scopedImpactPaths.includes('scope/allowed/allowed_dependent.py'), 'scoped impact lost the in-scope dependent');
  assert(scopedImpactPaths.includes('scope/allowed/tests/test_scoped_target.py'), 'scoped impact lost the in-scope test');
  assert(scopedImpactPaths.every((matchPath) => matchPath.startsWith('scope/allowed/')), 'structured impact returned a path outside the requested root');
  assert(scopedImpactResult.matches.every((match) => match.path.startsWith('scope/allowed/')), 'public impact projection returned a path outside the requested root');
  assert(!scopedImpactPaths.some((matchPath) => matchPath.startsWith('scope/nearby/')), 'nearby dependent/test influenced or appeared in scoped impact');

  const scopedGlobResult = await searchWorkspace(config, guard, workspace, {
    query: 'ScopedGlob',
    intent: 'auto',
    root: 'scope/allowed',
    glob: '**/*.py',
    includeTests: true,
    maxResults: 20
  });
  const scopedGlobAnalysis = analysisOf(scopedGlobResult);
  console.log(`RAW_OBSERVATION: scoped glob payload intent=${scopedGlobAnalysis.intent}; paths=${JSON.stringify(scopedGlobAnalysis.matches.map((match) => match.path))}; cache keys differ=${scopedGlobAnalysis.cache.key !== scopedImpactAnalysis.cache.key}`);
  assert.equal(scopedGlobAnalysis.intent, 'symbol', 'in-glob definition did not drive auto=symbol');
  assert(scopedGlobAnalysis.matches.some((match) => match.path === 'scope/allowed/scoped_glob.py'), 'glob-eligible in-scope definition was missing');
  assert(scopedGlobAnalysis.matches.every((match) => match.path.endsWith('.py')), 'structured glob scope admitted a non-matching extension');
  assert(!scopedGlobAnalysis.matches.some((match) => match.path.startsWith('scope/nearby/')), 'glob-scoped search admitted a nearby path');
  assert.notEqual(scopedGlobAnalysis.cache.key, scopedImpactAnalysis.cache.key, 'root/glob scope variants reused one public cache identity');

  const originalPath = process.env.PATH;
  let nodeScopedGlobResult;
  try {
    process.env.PATH = '/nonexistent';
    nodeScopedGlobResult = await searchWorkspace(config, guard, workspace, {
      query: 'ScopedGlob',
      intent: 'auto',
      root: 'scope/allowed',
      glob: '**/*.py',
      includeTests: true,
      maxResults: 20
    });
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
  const nodeScopedGlobAnalysis = analysisOf(nodeScopedGlobResult);
  console.log(`RAW_OBSERVATION: Node fallback scoped glob backend=${nodeScopedGlobResult.used}; paths=${JSON.stringify(nodeScopedGlobAnalysis.matches.map((match) => match.path))}`);
  assert.equal(nodeScopedGlobResult.used, 'node', 'Node fallback scope proof did not disable ripgrep');
  assert(nodeScopedGlobAnalysis.matches.every((match) => match.path === 'scope/allowed/scoped_glob.py'), 'Node fallback scoped glob escaped root or glob');

  const scopedFallbackResult = await searchWorkspace(config, guard, workspace, {
    query: 'FallbackTarget',
    intent: 'impact',
    root: 'scope/allowed',
    includeTests: true,
    maxResults: 20
  });
  const scopedFallbackAnalysis = analysisOf(scopedFallbackResult);
  console.log(`RAW_OBSERVATION: scoped fallback analysis paths=${JSON.stringify(scopedFallbackAnalysis.matches.map((match) => match.path))}; public paths=${JSON.stringify(scopedFallbackResult.matches.map((match) => match.path))}`);
  console.log('SANITY_VERDICT: MATCH — each scoped raw result contains only paths under scope/allowed, and the glob result contains only .py paths.');
  assert(scopedFallbackAnalysis.matches.some((match) => match.path === 'scope/allowed/tests/test_fallback_target.py'), 'in-scope filename fallback test was missing');
  assert(!scopedFallbackAnalysis.matches.some((match) => match.path === 'scope/nearby/tests/test_fallback_target.py'), 'out-of-scope filename fallback test appeared');
  assert(scopedFallbackResult.matches.every((match) => match.path.startsWith('scope/allowed/')), 'public fallback projection escaped the requested root');
  console.log('PASS: root/path and glob scope remains authoritative for auto, definitions, graph impact, filename fallback, scheduling, cache identity, and public matches.');

  console.log('ALL TASK-003 SMOKE CHECKS PASSED.');
} finally {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
