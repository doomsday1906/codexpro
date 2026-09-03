import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';
import { searchWorkspace } from '../dist/searchOps.js';

console.log('=== TASK-006 SMOKE: Public search payload shaping & quantitative gate ===');

const threadmarkRoot = '/home/andrew/Threadmark';
const config = loadConfig([
  '--root', threadmarkRoot,
  '--allow-root', threadmarkRoot,
  '--bash', 'off',
  '--write', 'off'
]);
const guard = new PathGuard(config);
const workspace = new WorkspaceManager(config).defaultWorkspace();

// Test 1: Gate 1 — BodyForm auto, no tests
const r1 = await searchWorkspace(config, guard, workspace, {
  query: 'BodyForm',
  intent: 'auto',
  includeTests: false,
  maxResults: 20
});

const sc1 = {
  codexpro_tool: 'search',
  codexpro_title: 'Search Workspace',
  workspace_id: workspace.id,
  root: workspace.root,
  matches: r1.matches,
  truncated: r1.truncated,
  used: r1.used,
  analysis: r1.analysis
};

const bytes1 = Buffer.byteLength(JSON.stringify(sc1), 'utf8');
console.log(`RAW_OBSERVATION: BodyForm auto bytes=${bytes1}, baseline=19343, target<=13540`);
assert(bytes1 <= 13540, `BodyForm auto exceeded quantitative budget: ${bytes1} > 13540`);
assert.equal(r1.analysis?.schemaVersion, 2, 'Expected schemaVersion 2');
assert(r1.analysis?.groups?.definitions?.length > 0, 'Expected definitions for BodyForm symbol');
assert.equal(r1.analysis?.groups?.tests?.length, 0, 'Expected zero tests when includeTests=false');
console.log('PASS: AP-012 (Gate 1): BodyForm auto satisfies quantitative requirement (>=30% reduction).');

// Test 2: Gate 2 — BodyFormSourceV2 impact, tests included
const r2 = await searchWorkspace(config, guard, workspace, {
  query: 'BodyFormSourceV2',
  intent: 'impact',
  includeTests: true,
  maxResults: 20
});

const sc2 = {
  codexpro_tool: 'search',
  codexpro_title: 'Search Workspace',
  workspace_id: workspace.id,
  root: workspace.root,
  matches: r2.matches,
  truncated: r2.truncated,
  used: r2.used,
  analysis: r2.analysis
};

const bytes2 = Buffer.byteLength(JSON.stringify(sc2), 'utf8');
console.log(`RAW_OBSERVATION: BodyFormSourceV2 impact bytes=${bytes2}, baseline=13452, target<=9416`);
assert(bytes2 <= 9416, `BodyFormSourceV2 impact exceeded quantitative budget: ${bytes2} > 9416`);

const paths = r2.analysis.matches.map((m) => m.path);
assert(paths.includes('server/app/actors_and_life/body_form_source.py'), 'Definition missing in impact results');
assert(paths.includes('server/app/actors_and_life/actor_body_state.py'), 'actor_body_state missing in impact results');
assert(paths.includes('server/app/actors_and_life/body_projection.py'), 'body_projection missing in impact results');
assert(paths.includes('server/app/services/creator_body_form_availability.py'), 'creator_body_form_availability missing in impact results');
assert(paths.includes('tests/unit/test_body_form_v2_source_model.py'), 'test_body_form_v2_source_model missing in impact results');

// Test 3: Public payload shaping & no uncompressed re-expansion
assert.equal(r2.matches.length, r2.analysis.matches.length, 'Public matches diverged in count from analysis matches');
const lexicalPaths = r2.matches.map((m) => m.path);
assert.equal(new Set(lexicalPaths).size, lexicalPaths.length, 'Public search payload duplicated identical paths');
for (const match of r2.analysis.matches) {
  if (match.additionalLinesTruncated !== undefined) {
    assert.equal(match.additionalLinesTruncated, true, 'additionalLinesTruncated should only be emitted when true');
  }
}

console.log('PASS: AP-011: Public search payload contract remains clean, structured, and bounded without payload bloat.');
console.log('PASS: AP-012 (Gate 2): BodyFormSourceV2 impact satisfies quantitative requirement and includes mandatory consumers and tests.');
console.log('ALL TASK-006 SMOKE CHECKS PASSED.');
