import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLE = 'HestiaNodeFallbackNeedle';
const MAX_RESULTS_SMALL = 5;
const MAX_RESULTS_LARGE = 50;
const TWENTY_MIB = 20 * 1024 * 1024;
const RSS_CEILING_KB = 300 * 1024;
const UNAVAILABLE_MARKER = '[SOURCE_CONTEXT_UNAVAILABLE]';

function rgUnavailableUnderEnv(env) {
  const probe = spawnSync('/bin/sh', ['-lc', 'command -v rg'], { encoding: 'utf8', env });
  return probe.status !== 0;
}

async function loadSearchModules() {
  const [{ loadConfig }, { PathGuard, WorkspaceManager }, { searchWorkspace }] = await Promise.all([
    import(pathToFileURL(path.join(projectRoot, 'dist', 'config.js')).href),
    import(pathToFileURL(path.join(projectRoot, 'dist', 'guard.js')).href),
    import(pathToFileURL(path.join(projectRoot, 'dist', 'searchOps.js')).href)
  ]);
  return { loadConfig, PathGuard, WorkspaceManager, searchWorkspace };
}

function openSearch(fixtureRoot, loadConfig, PathGuard, WorkspaceManager) {
  const config = loadConfig(['--root', fixtureRoot, '--allow-root', fixtureRoot, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  return { config, guard, workspace };
}

async function runChild() {
  const fixtureRoot = process.argv[3];
  const bigName = process.argv[4];
  const needle = process.argv[5];
  const maxResults = Number(process.argv[6]);
  assert(fixtureRoot && bigName && needle && Number.isSafeInteger(maxResults), 'child usage: --child <root> <file> <needle> <maxResults>');
  assert.equal(rgUnavailableUnderEnv(process.env), true, 'child PATH still resolves rg; fallback not forced');
  const { loadConfig, PathGuard, WorkspaceManager, searchWorkspace } = await loadSearchModules();
  const { config, guard, workspace } = openSearch(fixtureRoot, loadConfig, PathGuard, WorkspaceManager);
  const result = await searchWorkspace(config, guard, workspace, {
    query: needle, regex: false, root: bigName, includeHidden: false, maxResults
  });
  const usage = process.resourceUsage();
  const out = {
    used: result.used,
    truncated: result.truncated,
    matches: result.matches.map((m) => ({ path: m.path, line: m.line, text_status: m.text_status, reason: m.reason ?? null, text: m.text })),
    text: result.text,
    maxRssKb: Math.round(usage.maxRSS)
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function writeBigFixture(target, needle, syntheticSecret) {
  const handle = await fs.open(target, 'w');
  let lineNo = 0;
  let bytes = 0;
  const writeChunk = async (text) => {
    await handle.write(text, null, 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  };
  const writeLine = async (text) => {
    lineNo += 1;
    await writeChunk(`${text}\n`);
    return lineNo;
  };
  try {
    await writeLine('// hestia node fallback proof fixture');
    const benignLine = await writeLine(`export const benignStart = "${needle} benign-start";`);
    const secretLine = await writeLine(`export const secretRef = "${needle} ${syntheticSecret} end";`);
    const padLine = (idx) => `export const pad${idx} = "filler ${'x'.repeat(72)}";`;
    let padIdx = 0;
    const padUntil = async (targetBytes) => {
      let batch = '';
      while (bytes < targetBytes) {
        batch += `${padLine(padIdx)}\n`;
        padIdx += 1;
        lineNo += 1;
        if (batch.length >= 64 * 1024) {
          await writeChunk(batch);
          batch = '';
        }
      }
      if (batch) await writeChunk(batch);
    };
    await padUntil(10 * 1024 * 1024);
    const middleLines = [];
    for (let i = 0; i < 4; i += 1) middleLines.push(await writeLine(`export const mid${i} = "${needle} middle-${i}";`));
    await padUntil(19 * 1024 * 1024);
    const lateLines = [];
    for (let i = 0; i < 2; i += 1) lateLines.push(await writeLine(`export const late${i} = "${needle} late-${i}";`));
    await padUntil(TWENTY_MIB - 512);
    const eofLine = await writeLine(`export const eofMatch = "${needle} near-eof";`);
    return { benignLine, secretLine, middleLines, lateLines, eofLine, totalLines: lineNo };
  } finally {
    await handle.close();
  }
}

async function runParent() {
  const emptyPathDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hestia-norg-'));
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hestia-node-fallback-'));
  const controlledEnv = { ...process.env, PATH: emptyPathDir };
  try {
    assert.equal(rgUnavailableUnderEnv(controlledEnv), true, 'controlled PATH still resolves rg; cannot force fallback');
    // Build the synthetic secret only via fragment concatenation at runtime.
    const fragA = 'gh';
    const fragB = 'p_';
    const syntheticSecret = fragA + fragB + 'A'.repeat(24);
    assert(syntheticSecret.length >= 24, 'synthetic secret assembly failed');

    const bigName = 'big.txt';
    const badName = 'bad.bin';
    const bigPath = path.join(fixtureRoot, bigName);
    const badPath = path.join(fixtureRoot, badName);
    const layout = await writeBigFixture(bigPath, NEEDLE, syntheticSecret);
    const badBytes = Buffer.concat([
      Buffer.from(`${NEEDLE} invalid-prefix `, 'utf8'),
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from(' invalid-suffix\nsecond line without needle\n', 'utf8')
    ]);
    await fs.writeFile(badPath, badBytes);
    const bigStat = await fs.stat(bigPath);
    assert(bigStat.size >= TWENTY_MIB, `big fixture too small: ${bigStat.size}`);
    assert(layout.eofLine === layout.totalLines, 'EOF match is not the last line');

    // Isolated child peak-RSS proof for the 20MiB explicit fallback search.
    const scriptPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [scriptPath, '--child', fixtureRoot, bigName, NEEDLE, String(MAX_RESULTS_SMALL)], {
      env: controlledEnv, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.equal(exitCode, 0, `fallback child failed (${exitCode}): ${stderr}`);
    const childResult = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(childResult.used, 'node', `child did not use node fallback: ${childResult.used}`);
    assert.equal(childResult.truncated, true, 'child 20MiB search with 9 matches / maxResults 5 must truncate');
    assert.equal(childResult.matches.length, MAX_RESULTS_SMALL, `child retained ${childResult.matches.length}, want ${MAX_RESULTS_SMALL}`);
    assert(childResult.maxRssKb > 0, 'child reported no maxRSS');
    assert(childResult.maxRssKb <= RSS_CEILING_KB, `child peak RSS ${childResult.maxRssKb}KB exceeds ${RSS_CEILING_KB}KB`);
    const childBenign = childResult.matches.find((m) => m.line === layout.benignLine);
    assert(childBenign, 'child missing benign match at line 2');
    assert.equal(childBenign.text_status, 'available', `benign match status ${childBenign.text_status}, want available`);
    assert(childBenign.text.includes(NEEDLE), 'benign match text lost the needle');
    const childSecret = childResult.matches.find((m) => m.line === layout.secretLine);
    assert(childSecret, 'child missing secret match at line 3');
    assert.equal(childSecret.text_status, 'redacted', `secret match status ${childSecret.text_status}, want redacted`);
    assert(childSecret.text.includes('[REDACTED_SECRET]'), 'secret match missing redaction marker');
    assert(!childSecret.text.includes(syntheticSecret), 'secret match leaked the raw synthetic value');
    for (const m of childResult.matches) {
      assert.notEqual(m.text, '[REDACTED_SECRET]', 'unavailability must not use the secret marker');
    }

    // In-process checks under the same controlled PATH (rg neutralized here too).
    const savedPath = process.env.PATH;
    process.env.PATH = emptyPathDir;
    try {
      assert.equal(rgUnavailableUnderEnv(process.env), true, 'in-process PATH still resolves rg');
      const { loadConfig, PathGuard, WorkspaceManager, searchWorkspace } = await loadSearchModules();
      const { config, guard, workspace } = openSearch(fixtureRoot, loadConfig, PathGuard, WorkspaceManager);
      const search = (opts) => searchWorkspace(config, guard, workspace, opts);

      const full = await search({ query: NEEDLE, regex: false, root: bigName, includeHidden: false, maxResults: MAX_RESULTS_LARGE });
      assert.equal(full.used, 'node', `explicit full search used ${full.used}, want node`);
      assert.equal(full.truncated, false, 'explicit full search (9 matches / 50) must not truncate');
      assert.equal(full.matches.length, 9, `explicit full search found ${full.matches.length}, want 9`);
      const eofHit = full.matches.find((m) => m.line === layout.eofLine);
      assert(eofHit, `explicit full search missing EOF match at line ${layout.eofLine}`);
      assert(eofHit.text.includes(NEEDLE), 'EOF match text lost the needle');

      const bad = await search({ query: NEEDLE, regex: false, root: badName, includeHidden: false, maxResults: 10 });
      assert.equal(bad.used, 'node', `invalid-encoding search used ${bad.used}, want node`);
      assert(bad.matches.length >= 1, 'invalid-encoding file yielded no match locations');
      const badHit = bad.matches[0];
      assert.equal(badHit.text_status, 'unavailable', `invalid-encoding match status ${badHit.text_status}, want unavailable`);
      assert.equal(badHit.reason, 'invalid-encoding', `invalid-encoding match reason ${badHit.reason}, want invalid-encoding`);
      assert.equal(badHit.text, UNAVAILABLE_MARKER, 'invalid-encoding match text must be the unavailable marker');
      assert(!badHit.text.includes('[REDACTED_SECRET]'), 'unavailable match must never use the secret marker');

      const broad = await search({ query: NEEDLE, regex: false, root: '.', includeHidden: false, maxResults: 10 });
      assert.equal(broad.used, 'node', `broad search used ${broad.used}, want node`);
      assert.equal(broad.truncated, true, 'broad search over a 20MiB scan-limit file must report truncated');
      const unavailableReasons = new Set(broad.matches.filter((m) => m.text_status === 'unavailable').map((m) => m.reason));
      assert(unavailableReasons.size > 0, 'broad search surfaced no unavailable match with a bounded reason');
      for (const r of unavailableReasons) {
        assert(['binary', 'invalid-encoding', 'race', 'scan-limit', 'io-error', 'line-too-large', 'capture-capped'].includes(r), `broad unavailable reason ${r} is not bounded`);
      }
      for (const m of broad.matches) {
        if (m.text_status === 'unavailable') assert.equal(m.text, UNAVAILABLE_MARKER, 'broad unavailable text must be the marker');
      }

      const empty = await search({ query: 'HestiaNeedleThatMatchesNothing000', regex: false, root: badName, includeHidden: false, maxResults: 10 });
      assert.equal(empty.truncated, true, 'no-match search over an invalid-encoding file must disclose incomplete coverage');
      assert.equal(empty.matches.length, 0, 'empty search should retain no matches');

      let absurdFailed = false;
      try {
        await search({ query: `q${'y'.repeat(1024 * 1024 + 1)}`, regex: false, root: bigName, includeHidden: false, maxResults: 5 });
      } catch (error) {
        absurdFailed = /1MiB/.test(error instanceof Error ? error.message : String(error));
      }
      assert.equal(absurdFailed, true, 'absurd >1MiB query must fail with an honest 1MiB error');
    } finally {
      process.env.PATH = savedPath;
    }

    console.log(`HESTIA_NODE_FALLBACK_PROOF PASS rss_kb=${childResult.maxRssKb} ceiling_kb=${RSS_CEILING_KB} big_bytes=${bigStat.size} eof_line=${layout.eofLine}`);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(emptyPathDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv.includes('--child')) {
  await runChild();
} else {
  await runParent();
}
