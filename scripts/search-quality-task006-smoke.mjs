import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BODY_FORM_AUTO_BASELINE_BYTES = 19_343;
const BODY_FORM_AUTO_MAX_BYTES = 13_540;
const BODY_FORM_SOURCE_IMPACT_BASELINE_BYTES = 13_452;
const BODY_FORM_SOURCE_IMPACT_MAX_BYTES = 9_416;
const ANALYSIS_FILE_LIMIT = 100;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, 'dist', relativePath)).href);
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-search-quality-task006-'));
const previousMaxAnalyzedFiles = process.env.CODEXPRO_ANALYSIS_MAX_ANALYZED_FILES;

async function writeFixture(relativePath, content) {
  const target = path.join(fixtureRoot, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function analysisOf(result, label) {
  assert(result.analysis, `${label} omitted structured analysis`);
  return result.analysis;
}

function supportingStructuredContent(workspace, result) {
  // This is the response-shaped supporting oracle used by the repository smoke.
  // AP-012 acceptance still requires a separate real public-route measurement.
  return {
    codexpro_tool: 'search',
    codexpro_title: 'Search Workspace',
    workspace_id: workspace.id,
    root: workspace.root,
    matches: result.matches,
    truncated: result.truncated,
    used: result.used,
    analysis: result.analysis
  };
}

function longComment(marker, suffix = '') {
  return `# ${marker} ${suffix}${' fixture evidence'.repeat(3)}`;
}

try {
  // Keep the analysis warning truthful and deterministic without requiring a
  // large persistent repository. Essential files sort before this coverage
  // tail, so the source/relationship evidence remains inside the bound.
  process.env.CODEXPRO_ANALYSIS_MAX_ANALYZED_FILES = String(ANALYSIS_FILE_LIMIT);

  await writeFixture('package.json', JSON.stringify({ name: 'task006-search-quality-fixture' }, null, 2) + '\n');

  // BodyForm auto: a real type definition, an incidental lower-case variable,
  // and documentation are all present so ranking/order is directly checked.
  await writeFixture('server/app/actors_and_life/body_form.py', [
    'class BodyForm:',
    '    pass'
  ].join('\n') + '\n');
  await writeFixture('src/body_form_variable.ts', 'const bodyForm = "incidental local variable";\n');
  await writeFixture('src/body_form_variants.ts', [
    `export class BodyFormVariantAlpha { ${'/* BodyForm definition fixture */ '.repeat(8)} }`,
    `export class BodyFormVariantBeta { ${'/* BodyForm definition fixture */ '.repeat(8)} }`
  ].join('\n') + '\n');
  await writeFixture('docs/body_form.md', '# BodyForm documentation\nThis is documentation, not a definition.\n');

  // BodyFormSourceV2 impact: these are real fixture modules connected by
  // internal Python imports, plus one test relationship. Comments on the
  // transitive modules provide lexical evidence that is merged with the
  // relationship evidence without changing the import topology.
  await writeFixture('server/app/actors_and_life/body_form_source.py', [
    'class BodyFormSourceV2:',
    '    pass'
  ].join('\n') + '\n');
  await writeFixture('server/app/actors_and_life/actor_body_state.py', [
    'from server.app.actors_and_life.body_form_source import BodyFormSourceV2',
    'class ActorBodyState:',
    '    source = "body form source"'
  ].join('\n') + '\n');
  await writeFixture('server/app/actors_and_life/body_projection.py', [
    longComment('BodyFormSourceV2', 'transitive source projection'),
    'from server.app.actors_and_life.actor_body_state import ActorBodyState',
    'class BodyProjection:',
    '    state = ActorBodyState'
  ].join('\n') + '\n');
  await writeFixture('server/app/services/creator_body_form_availability.py', [
    longComment('BodyFormSourceV2', 'transitive creator availability'),
    'from server.app.actors_and_life.body_projection import BodyProjection',
    'class CreatorBodyFormAvailability:',
    '    projection = BodyProjection'
  ].join('\n') + '\n');
  await writeFixture('tests/unit/test_body_form_v2_source_model.py', [
    'from server.app.actors_and_life.body_form_source import BodyFormSourceV2',
    'def test_source_model():',
    '    assert True'
  ].join('\n') + '\n');

  // Non-matching source files force a real, retained coverage warning. The
  // warning is part of the serialized payload and proves the size check cannot
  // pass by silently dropping coverage metadata.
  for (let index = 0; index < ANALYSIS_FILE_LIMIT + 10; index += 1) {
    const suffix = String(index).padStart(3, '0');
    await writeFixture(`zz-zcoverage/ordinary-${suffix}.py`, `# ordinary coverage file ${suffix}\n`);
  }

  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { searchWorkspace }] = await Promise.all([
    importBuilt('config.js'),
    importBuilt('guard.js'),
    importBuilt('searchOps.js')
  ]);
  const config = loadConfig(['--root', fixtureRoot, '--allow-root', fixtureRoot, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();

  // Test 1: BodyForm auto, no tests. The exact accepted ceilings are retained
  // as supporting serialization guards; fixture bytes do not close AP-012.
  const r1 = await searchWorkspace(config, guard, workspace, {
    query: 'BodyForm',
    intent: 'auto',
    includeTests: false,
    maxResults: 20
  });
  const a1 = analysisOf(r1, 'BodyForm auto');
  const sc1 = supportingStructuredContent(workspace, r1);
  const bytes1 = Buffer.byteLength(JSON.stringify(sc1), 'utf8');
  console.log(`RAW_OBSERVATION: SUPPORTING_ONLY BodyForm auto fixture bytes=${bytes1}, baseline=${BODY_FORM_AUTO_BASELINE_BYTES}, unchanged target<=${BODY_FORM_AUTO_MAX_BYTES}`);
  assert(bytes1 <= BODY_FORM_AUTO_MAX_BYTES, `BodyForm auto fixture exceeded unchanged quantitative budget: ${bytes1} > ${BODY_FORM_AUTO_MAX_BYTES}`);
  assert.equal(a1.schemaVersion, 2, 'Expected schemaVersion 2');
  assert.equal(a1.intent, 'symbol', 'auto did not resolve to symbol for BodyForm fixture definition');
  assert(a1.groups.definitions.length > 0, 'Expected definitions for BodyForm symbol');
  assert.equal(a1.groups.tests.length, 0, 'Expected zero tests when includeTests=false');
  const bodyFormDefinitionIndex = a1.matches.findIndex((match) => match.path === 'server/app/actors_and_life/body_form.py' && match.group === 'definitions');
  const incidentalVariableIndex = a1.matches.findIndex((match) => match.path === 'src/body_form_variable.ts' && match.group === 'definitions');
  const documentationIndex = a1.matches.findIndex((match) => match.path === 'docs/body_form.md' && match.group === 'documentation');
  assert(bodyFormDefinitionIndex >= 0, 'Real BodyForm definition was missing');
  assert(incidentalVariableIndex >= 0, 'Incidental bodyForm variable was missing');
  assert(documentationIndex >= 0, 'BodyForm documentation was missing');
  assert(bodyFormDefinitionIndex < incidentalVariableIndex, 'Real BodyForm definition did not precede incidental variable');
  assert(bodyFormDefinitionIndex < documentationIndex, 'Real BodyForm definition did not precede documentation');
  assert(a1.coverage.truncated, 'Expected bounded fixture coverage warning to be observable');
  assert(a1.warnings.some((warning) => warning.includes('Source analysis reached its file or byte limit.')), 'Coverage warning was not retained truthfully');
  console.log('PASS: BodyForm auto keeps a real definition ahead of the incidental variable/documentation and retains coverage truth.');

  // Test 2: BodyFormSourceV2 impact, tests included. Mandatory modules are
  // checked as actual graph results with relationship reasons/provenance.
  const r2 = await searchWorkspace(config, guard, workspace, {
    query: 'BodyFormSourceV2',
    intent: 'impact',
    includeTests: true,
    maxResults: 20
  });
  const a2 = analysisOf(r2, 'BodyFormSourceV2 impact');
  const sc2 = supportingStructuredContent(workspace, r2);
  const bytes2 = Buffer.byteLength(JSON.stringify(sc2), 'utf8');
  console.log(`RAW_OBSERVATION: SUPPORTING_ONLY BodyFormSourceV2 impact fixture bytes=${bytes2}, baseline=${BODY_FORM_SOURCE_IMPACT_BASELINE_BYTES}, unchanged target<=${BODY_FORM_SOURCE_IMPACT_MAX_BYTES}`);
  assert(bytes2 <= BODY_FORM_SOURCE_IMPACT_MAX_BYTES, `BodyFormSourceV2 impact fixture exceeded unchanged quantitative budget: ${bytes2} > ${BODY_FORM_SOURCE_IMPACT_MAX_BYTES}`);
  assert.equal(a2.schemaVersion, 2, 'Expected schemaVersion 2 for impact');
  assert.equal(a2.intent, 'impact', 'intent was not impact');

  const paths = a2.matches.map((match) => match.path);
  const definitionPath = 'server/app/actors_and_life/body_form_source.py';
  const requiredSourcePaths = [
    'server/app/actors_and_life/actor_body_state.py',
    'server/app/actors_and_life/body_projection.py',
    'server/app/services/creator_body_form_availability.py'
  ];
  const requiredTestPath = 'tests/unit/test_body_form_v2_source_model.py';
  assert(paths.includes(definitionPath), 'Definition missing in impact results');
  for (const requiredPath of requiredSourcePaths) {
    assert(paths.includes(requiredPath), `${requiredPath} missing in impact results`);
    const match = a2.matches.find((candidate) => candidate.path === requiredPath);
    assert(match?.group === 'references', `${requiredPath} was not an affected source reference`);
    assert(match.reasons.some((reason) => /dependent module|imports|transitive dependent/u.test(reason)), `${requiredPath} lacked truthful relationship reasons`);
    assert(match.source === 'built-in import extraction' || match.provenance?.includes('built-in import extraction'), `${requiredPath} lacked import provenance`);
  }
  const testMatch = a2.matches.find((match) => match.path === requiredTestPath);
  assert(testMatch?.group === 'tests', 'Relevant test missing from impact results');
  assert(testMatch.reasons.includes('dependent test'), 'Relevant test lacked dependent-test reason');
  assert(testMatch.provenance?.includes('built-in import extraction'), 'Relevant test lacked import provenance');
  assert(testMatch.provenance?.includes('lexical'), 'Relevant test lacked lexical provenance');

  // Test 3: Public payload shaping, no uncompressed re-expansion, and retained
  // provenance/warnings. The six fixture lexical lines produce six structured
  // logical records after impact merges while the request still uses the
  // accepted max_results=20 envelope.
  assert.equal(r2.matches.length, a2.matches.length, 'Public matches diverged in count from analysis matches');
  const lexicalPaths = r2.matches.map((match) => match.path);
  assert.equal(new Set(lexicalPaths).size, lexicalPaths.length, 'Public search payload duplicated identical paths');
  assert(a2.matches.some((match) => match.provenance?.includes('built-in import extraction')), 'Merged impact provenance was dropped');
  assert(a2.matches.some((match) => match.provenance?.includes('lexical')), 'Lexical provenance was dropped');
  assert(a2.coverage.truncated, 'Expected bounded fixture coverage warning to be observable for impact');
  assert(a2.warnings.some((warning) => warning.includes('Source analysis reached its file or byte limit.')), 'Impact coverage warning was not retained truthfully');
  for (const match of a2.matches) {
    if (match.additionalLinesTruncated !== undefined) {
      assert.equal(match.additionalLinesTruncated, true, 'additionalLinesTruncated should only be emitted when true');
    }
  }

  // Test 4: A structured scheduler may intentionally retain fewer records than
  // the raw lexical max-results window. The legacy projection must follow the
  // scheduled structured records exactly, including their text and order.
  const overflowQuery = 'BodyFormSourceV2';
  for (let index = 0; index < 30; index += 1) {
    const suffix = String(index).padStart(2, '0');
    await writeFixture(`src/structured-overflow/overflow-${suffix}.ts`, `const marker${index} = "${overflowQuery}";\n`);
  }
  const lexicalOnlyOverflow = await searchWorkspace(config, guard, workspace, {
    query: overflowQuery,
    maxResults: 20
  });
  const overflowResult = await searchWorkspace(config, guard, workspace, {
    query: overflowQuery,
    intent: 'impact',
    includeTests: true,
    maxResults: 20
  });
  const overflowAnalysis = analysisOf(overflowResult, 'structured overflow');
  assert.equal(lexicalOnlyOverflow.matches.length, 20, 'Overflow fixture did not produce the raw lexical max-results window');
  assert(lexicalOnlyOverflow.matches.length > overflowAnalysis.matches.length, 'Overflow fixture did not exercise fewer scheduled structured matches');
  const expectedLegacyMatches = overflowAnalysis.matches.map(({ path, line, text }) => ({ path, line, text }));
  assert.deepEqual(overflowResult.matches, expectedLegacyMatches, 'Legacy structured-search matches diverged from scheduled structured matches');
  const expectedLegacyText = expectedLegacyMatches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') || 'No matches.';
  assert.equal(overflowResult.text, expectedLegacyText, 'Legacy structured-search text was not rebuilt from scheduled matches');
  assert.equal(overflowAnalysis.schemaVersion, 2, 'Structured overflow regression lost schema v2');
  assert(overflowAnalysis.groups.definitions.length > 0, 'Structured overflow regression lost the definition evidence');
  assert(overflowAnalysis.groups.references.length > 0, 'Structured overflow regression lost reference evidence');
  assert(overflowAnalysis.matches.some((match) => match.provenance?.includes('lexical')), 'Structured overflow regression lost lexical provenance');
  assert(overflowAnalysis.coverage.truncated, 'Structured overflow regression lost truthful coverage truncation');
  assert(overflowAnalysis.warnings.some((warning) => warning.includes('Source analysis reached its file or byte limit.')), 'Structured overflow regression lost the coverage warning');
  console.log(`RAW_OBSERVATION: overflow fixture has ${lexicalOnlyOverflow.matches.length} raw lexical records but ${overflowAnalysis.matches.length} scheduled structured records; legacy projection count/text exactly match the scheduled set.`);
  console.log('SANITY_VERDICT: MATCH — the outward structured-search list and text show only the selected path/line/text records while analysis retains provenance and coverage warning fields.');

  console.log('PASS: SUPPORTING_ONLY public/structured payload remains bounded with required definitions, affected source modules, tests, reasons, provenance, and warnings.');
  console.log('AP-012 production thresholds remain unproven here; real public-route evidence is required separately.');
  console.log('ALL TASK-006 SMOKE CHECKS PASSED.');
} finally {
  if (previousMaxAnalyzedFiles === undefined) delete process.env.CODEXPRO_ANALYSIS_MAX_ANALYZED_FILES;
  else process.env.CODEXPRO_ANALYSIS_MAX_ANALYZED_FILES = previousMaxAnalyzedFiles;
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
