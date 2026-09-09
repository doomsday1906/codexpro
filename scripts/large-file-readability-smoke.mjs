import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const { loadConfig } = await import('../dist/config.js');
const { PathGuard } = await import('../dist/guard.js');
const { readPublicTextFile } = await import('../dist/fsOps.js');
const { SelectedLineTooLargeError, SourceScanError } = await import('../dist/sourceProjection.js');

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', () => {});
    this.child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited code=${code} signal=${signal ?? 'none'}`));
    });
  }
  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/u, '');
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
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return Promise.resolve();
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.kill('SIGTERM');
    return exited;
  }
}

function assertToolSuccess(result, label) {
  assert.notEqual(result.isError, true, `${label} failed: ${JSON.stringify(result).slice(0, 500)}`);
  return result;
}

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
// Deterministic generator PARAMS v1 (same family as scanner/projection smokes).
async function genFile(absPath, targetBytes, seedLines = []) {
  const handle = await fsp.open(absPath, 'w');
  const hash = createHash('sha256');
  let written = 0;
  for (const line of seedLines) {
    const s = `${line}\n`;
    await handle.write(s);
    hash.update(s, 'utf8');
    written += Buffer.byteLength(s, 'utf8');
  }
  let i = 0;
  while (written < targetBytes) {
    const s = `body line ${String(i).padStart(9, '0')} ${'x'.repeat(60)}${i % 97 === 0 ? ' ✓café' : ''}${i % 500 === 0 ? '\r' : ''}\n`;
    await handle.write(s);
    hash.update(s, 'utf8');
    written += Buffer.byteLength(s, 'utf8');
    i += 1;
  }
  await handle.close();
  // Oracle line semantics: every \n terminates a line plus one final (possibly empty) line.
  return { bytes: written, sha: hash.digest('hex'), lines: seedLines.length + i + 1 };
}

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-large-read-'));
let stdioClient;
try {
  const SECRET = 'gh' + 'p_' + 'LARGEFILETASK004LARGEFILETASK0040123456789ab';
  // 1MiB file: private key early, credential mid-file, witnesses late.
  const LF_PK_BEGIN = '-----' + 'BEG' + 'IN RSA PRI' + 'VATE KEY' + '-----';
  const LF_PK_BODY_A = 'MII' + 'EpTASK004BODYLINEONE';
  const LF_PK_BODY_B = 'TASK004BODY' + 'LINETWO';
  const LF_PK_END = '-----' + 'EN' + 'D RSA PRI' + 'VATE KEY' + '-----';
  const keyBlock = [LF_PK_BEGIN, LF_PK_BODY_A, LF_PK_BODY_B, LF_PK_END];
  const seed1 = ['// seed top', ...keyBlock, `deploy_token = "${SECRET}"`, 'class CampaignRepo {}'];
  const f1 = await genFile(path.join(tmp, 'big1m.txt'), 1 << 20, seed1);
  const seed20 = ['// twenty megabyte seed', 'CampaignStorageTopology = 1', 'def compose_campaign_storage():', '    pass'];
  const f20 = await genFile(path.join(tmp, 'big20m.txt'), 20 << 20, seed20);
  await fsp.writeFile(path.join(tmp, 'nul-after.txt'), `line one selected here\nline two\nline three\nlate\x00nul\n`);
  await fsp.writeFile(path.join(tmp, 'small.txt'), 'alpha\nbeta\ngamma\n');

  const config = loadConfig();
  const guard = new PathGuard(config);
  const workspace = { id: 'lfws', root: tmp };
  const effectiveMax = config.maxReadBytes;

  // AP-010 direct: 1MiB + 20MiB deep 30-line ranges through the public function.
  for (const [name, expect] of [['big1m.txt', f1], ['big20m.txt', f20]]) {
    const result = await readPublicTextFile(config, guard, workspace, name, { startLine: 536, endLine: 565 });
    assert.equal(result.startLine, 536);
    assert.equal(result.endLine, 565);
    assert.equal(result.bytes, expect.bytes);
    assert.equal(result.sha256, expect.sha);
    assert.equal(result.totalLines, expect.lines);
    assert.equal(result.truncated, true);
    assert.equal(result.budgetTruncated, false);
    assert.equal(result.nextStartLine, undefined);
    assert.ok(result.returnedBytes > 0 && result.returnedBytes <= effectiveMax);
    const bodyLines = result.text.split('\n');
    assert.equal(bodyLines.length, 30);
    assert.ok(bodyLines[0].startsWith('536 | body line 0000005'), `range content: ${bodyLines[0].slice(0, 40)}`);
    console.log(`ok direct range ${name} bytes=${result.bytes} lines=${result.totalLines}`);
  }

  // AP-010 direct: unbounded 20MiB pages with continuation; pages are disjoint and ordered.
  {
    const page1 = await readPublicTextFile(config, guard, workspace, 'big20m.txt', {});
    assert.equal(page1.startLine, 1);
    assert.equal(page1.budgetTruncated, true);
    assert.ok(typeof page1.nextStartLine === 'number' && page1.nextStartLine > 1);
    assert.ok(page1.returnedBytes <= effectiveMax);
    const page2 = await readPublicTextFile(config, guard, workspace, 'big20m.txt', { startLine: page1.nextStartLine });
    assert.equal(page2.startLine, page1.nextStartLine);
    assert.ok(!page1.text.split('\n').some((line) => page2.text.split('\n').includes(line) && line.length > 12),
      'pages overlap');
    console.log(`ok direct unbounded pages 1-${page1.endLine} then ${page2.startLine}-${page2.endLine}`);
  }

  // Small max_bytes pages a bounded range; a single over-budget line errors specifically.
  {
    const small = await readPublicTextFile(config, guard, workspace, 'big1m.txt', { startLine: 536, endLine: 565, maxBytes: 2000 });
    assert.equal(small.budgetTruncated, true);
    assert.ok(typeof small.nextStartLine === 'number');
    assert.ok(small.returnedBytes <= 2000);
    await assert.rejects(
      readPublicTextFile(config, guard, workspace, 'big1m.txt', { startLine: 6, endLine: 6, maxBytes: 10 }),
      (error) => error instanceof SelectedLineTooLargeError && error.facts.line === 6
    );
    console.log('ok direct small-budget paging + selected_line_too_large');
  }

  // Security through the public route: key block before the window stays redacted in-window.
  {
    const keyed = await readPublicTextFile(config, guard, workspace, 'big1m.txt', { startLine: 2, endLine: 5 });
    assert.ok(!keyed.text.includes(keyBlock[1]), 'private body leaked');
    assert.ok(keyed.text.includes('[REDACTED_PRIVATE_KEY]'), 'private marker missing');
    assert.ok(!keyed.text.includes(SECRET.slice(0, 12)) || keyed.text.includes('[REDACTED_SECRET]'), 'credential leak');
    console.log('ok direct out-of-range key + credential safety');
  }

  // F1-A: EOF observer ordering. >2MiB source, private-key BEGIN before the
  // window, >64KiB of body, final body line WITHOUT trailing newline, only
  // that line requested. The final line must be redacted in every field.
  // F1-D: a newline-terminated large source's final empty line is a stable
  // result, not a missing-projection-state error.
  {
    const F1_BEGIN = '-----' + 'BEG' + 'IN RSA PRIVATE ' + 'KEY-----';
    const F1_BODY = 'F1EOFBODY7X9_';
    const filler66 = 'eof-order filler line padding 0123456789 abcdef\n';
    const fillerReps = Math.ceil((2_200_000) / filler66.length);
    const bodyLine = `${F1_BODY}${'x'.repeat(1000)}\n`;
    const bodyReps = 70; // >64KiB of body separates BEGIN from the final line
    const finalLine = `${F1_BODY}FINAL${'y'.repeat(1000)}`; // NO trailing newline
    const src = `${filler66.repeat(fillerReps)}${F1_BEGIN}\n${bodyLine.repeat(bodyReps)}${finalLine}`;
    await fsp.writeFile(path.join(tmp, 'eof-block.txt'), src);
    const totalLines = src.split('\n').length;
    const only = await readPublicTextFile(config, guard, workspace, 'eof-block.txt', { startLine: totalLines, endLine: totalLines });
    const serialized = JSON.stringify(only);
    assert.ok(!serialized.includes(F1_BODY), 'F1-A: final key-body material visible in the read result');
    assert.ok(only.text.includes('[REDACTED_PRIVATE_KEY]'), 'F1-A: private marker missing');
    console.log('ok F1-A working-tree EOF block redacted');

    const src2 = `${filler66.repeat(fillerReps)}tail\n`;
    await fsp.writeFile(path.join(tmp, 'eof-empty.txt'), src2);
    const total2 = src2.split('\n').length;
    const emptyFinal = await readPublicTextFile(config, guard, workspace, 'eof-empty.txt', { startLine: total2, endLine: total2 });
    assert.equal(emptyFinal.startLine, total2);
    assert.equal(emptyFinal.endLine, total2);
    console.log('ok F1-D final empty line stable');
  }

  // NUL after the requested range still rejects (full-source binary law preserved).
  {
    await assert.rejects(
      readPublicTextFile(config, guard, workspace, 'nul-after.txt', { startLine: 1, endLine: 1 }),
      /Refusing to read binary file/
    );
    console.log('ok direct NUL-after-range binary rejection');
  }

  // Small-file compatibility: identical bytes to the accepted oracle behavior.
  {
    const small = await readPublicTextFile(config, guard, workspace, 'small.txt', {});
    assert.equal(small.text, '1 | alpha\n2 | beta\n3 | gamma\n4 | ');
    assert.equal(small.truncated, false);
    assert.equal(small.budgetTruncated, false);
    assert.equal(small.nextStartLine, undefined);
    assert.equal(small.totalLines, 4);
    console.log('ok direct small-file compatibility');
  }

  // AP-011 direct: read_many-style composition — per-file continuation is disjoint
  // from the aggregate item cursor (proven here at function level; MCP below).
  {
    const first = await readPublicTextFile(config, guard, workspace, 'big20m.txt', { startLine: 1, endLine: 500, maxBytes: 5000 });
    assert.equal(first.budgetTruncated, true);
    assert.ok(typeof first.nextStartLine === 'number' && first.nextStartLine <= 500);
    const continued = await readPublicTextFile(config, guard, workspace, 'big20m.txt', { startLine: first.nextStartLine, endLine: 500, maxBytes: 5000 });
    assert.equal(continued.startLine, first.nextStartLine);
    assert.ok(continued.endLine <= 500 || continued.budgetTruncated);
    // disjoint: no shared numbered content lines between the two pages
    const firstSet = new Set(first.text.split('\n'));
    assert.ok(!continued.text.split('\n').some((line) => line.length > 12 && firstSet.has(line)), 'pages overlap');
    console.log(`ok direct per-file continuation ${first.startLine}-${first.endLine} -> ${continued.startLine}-${continued.endLine}`);
  }

  // AP-010 MCP stdio: compiled public routes serve the new contract.
  stdioClient = new McpStdioClient(process.execPath, [
    'dist/stdio.js', '--root', tmp, '--allow-root', tmp,
    '--bash', 'off', '--write', 'off', '--tool-mode', 'full'
  ], { cwd: path.resolve('.'), env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp } });
  await stdioClient.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'large-file-smoke', version: '0.1.0' } });
  stdioClient.notify('notifications/initialized');
  const opened = assertToolSuccess(await stdioClient.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } }), 'open workspace');
  const ws = opened.structuredContent.workspace_id;

  const mcpRange = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read', arguments: { workspace_id: ws, path: 'big20m.txt', start_line: 536, end_line: 565 }
  }), 'mcp ranged read');
  assert.equal(mcpRange.structuredContent.startLine, 536);
  assert.equal(mcpRange.structuredContent.endLine, 565);
  assert.equal(mcpRange.structuredContent.bytes, f20.bytes);
  assert.equal(mcpRange.structuredContent.totalLines, f20.lines);
  assert.equal(mcpRange.structuredContent.budgetTruncated, false);
  assert.ok(typeof mcpRange.structuredContent.returnedBytes === 'number');
  const envelopeBytes = Buffer.byteLength(JSON.stringify(mcpRange), 'utf8');
  // F5: the complete serialized response plus transport reserve fits the
  // output policy (the old +65536 slack is gone; see hestia-envelope-proof).
  assert.ok(envelopeBytes + 2048 <= config.maxOutputBytes, `envelope ${envelopeBytes} exceeds output policy ${config.maxOutputBytes}`);
  console.log(`ok mcp stdio range envelope=${envelopeBytes}`);

  const mcpUnbounded = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read', arguments: { workspace_id: ws, path: 'big20m.txt' }
  }), 'mcp unbounded read');
  assert.equal(mcpUnbounded.structuredContent.startLine, 1);
  assert.equal(mcpUnbounded.structuredContent.budgetTruncated, true);
  assert.ok(typeof mcpUnbounded.structuredContent.nextStartLine === 'number');
  const mcpNext = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read', arguments: { workspace_id: ws, path: 'big20m.txt', start_line: mcpUnbounded.structuredContent.nextStartLine }
  }), 'mcp continued read');
  assert.equal(mcpNext.structuredContent.startLine, mcpUnbounded.structuredContent.nextStartLine);
  console.log('ok mcp stdio unbounded paging + continuation');

  // AP-011 MCP: read_many inherits per-file continuation; aggregate cursor stays disjoint.
  const mcpMany = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read_many', arguments: {
      workspace_id: ws,
      max_total_bytes: 100_000,
      items: [
        { path: 'small.txt' },
        { path: 'big20m.txt', end_line: 500, max_bytes: 5000 },
        { path: 'big1m.txt', start_line: 536, end_line: 565 }
      ]
    }
  }), 'mcp read_many');
  const results = mcpMany.structuredContent.results;
  assert.equal(results.length, 3);
  assert.ok(results.every((item) => item.ok), `read_many items failed: ${JSON.stringify(results).slice(0, 300)}`);
  const bigItem = results[1];
  assert.equal(bigItem.result.budgetTruncated, true);
  assert.ok(typeof bigItem.result.nextStartLine === 'number');
  assert.equal(mcpMany.structuredContent.next_index, null, 'aggregate cursor moved for per-file truncation');
  const continuedItem = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read_many', arguments: {
      workspace_id: ws,
      items: [{ path: 'big20m.txt', start_line: bigItem.result.nextStartLine, end_line: 500, max_bytes: 5000 }]
    }
  }), 'mcp read_many continued item');
  assert.equal(continuedItem.structuredContent.results[0].result.startLine, bigItem.result.nextStartLine);
  console.log('ok mcp read_many per-file continuation disjoint from aggregate cursor');
  // AP-015 (working-tree half): read_many per-file continuation already proven above.
  // AP-015 historical: compiled public read_at_ref over a real local repository.
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '--quiet'], { cwd: tmp });
  execFileSync('git', ['config', 'user.name', 'lf-smoke'], { cwd: tmp });
  execFileSync('git', ['config', 'user.email', 'lf-smoke@example.test'], { cwd: tmp });
  execFileSync('git', ['add', 'big1m.txt', 'small.txt'], { cwd: tmp });
  execFileSync('git', ['commit', '--quiet', '-m', 'lf fixtures'], { cwd: tmp });
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
  const headOid = execFileSync('git', ['rev-parse', 'HEAD:big1m.txt'], { cwd: tmp, encoding: 'utf8' }).trim();

  const mcpHistRange = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read_at_ref', arguments: { workspace_id: ws, ref: 'HEAD', path: 'big1m.txt', start_line: 536, end_line: 565 }
  }), 'mcp read_at_ref range');
  assert.equal(mcpHistRange.structuredContent.start_line, 536);
  assert.equal(mcpHistRange.structuredContent.end_line, 565);
  assert.equal(mcpHistRange.structuredContent.bytes, f1.bytes);
  assert.equal(mcpHistRange.structuredContent.total_lines, f1.lines);
  assert.equal(mcpHistRange.structuredContent.blob_sha, headOid);
  assert.equal(mcpHistRange.structuredContent.commit_sha, headSha);
  assert.equal(mcpHistRange.structuredContent.budget_truncated, false);
  console.log('ok mcp read_at_ref range with immutable metadata');

  const mcpHistUnbounded = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read_at_ref', arguments: { workspace_id: ws, ref: 'HEAD', path: 'big1m.txt' }
  }), 'mcp read_at_ref unbounded');
  assert.equal(mcpHistUnbounded.structuredContent.start_line, 1);
  assert.equal(mcpHistUnbounded.structuredContent.budget_truncated, true);
  assert.ok(typeof mcpHistUnbounded.structuredContent.next_start_line === 'number');
  const mcpHistNext = assertToolSuccess(await stdioClient.request('tools/call', {
    name: 'read_at_ref', arguments: { workspace_id: ws, ref: 'HEAD', path: 'big1m.txt', start_line: mcpHistUnbounded.structuredContent.next_start_line }
  }), 'mcp read_at_ref continued');
  assert.equal(mcpHistNext.structuredContent.start_line, mcpHistUnbounded.structuredContent.next_start_line);
  console.log('ok mcp read_at_ref unbounded paging + continuation');

  // LAW-009 schema/runtime agreement: sub-1000 max_bytes is rejected at validation.
  const badBudget = await stdioClient.request('tools/call', {
    name: 'read_at_ref', arguments: { workspace_id: ws, ref: 'HEAD', path: 'big1m.txt', max_bytes: 500 }
  });
  assert.equal(badBudget.isError, true, 'sub-minimum max_bytes accepted');
  const badBudget2 = await stdioClient.request('tools/call', {
    name: 'read', arguments: { workspace_id: ws, path: 'big1m.txt', max_bytes: 2000001 }
  });
  assert.equal(badBudget2.isError, true, 'over-maximum max_bytes accepted');
  console.log('ok max_bytes schema bounds agree across read/read_at_ref');

  // TASK-006 search hydration (AP-016/AP-017/AP-018) through compiled MCP + direct.
  const { searchWorkspace } = await import('../dist/searchOps.js');
  const directWs = { id: 'lfsearch', root: tmp };
  // benign witnesses + real secrets in the large fixtures; undecodable file for unavailable.
  await fsp.appendFile(path.join(tmp, 'big20m.txt'), 'class CampaignRepo {}\nconst CampaignStorageTopology = 9\ncompose_campaign_storage()\n');
  await fsp.writeFile(path.join(tmp, 'latin1.txt'), Buffer.from('benign CampaignStorageTopology caf\xe9 line\nsecond line\n', 'latin1'));
  const SEARCH_SECRET = 'gh' + 'p_' + 'SEARCHTASK006SEARCHTASK0060123456789ab';
  await fsp.writeFile(path.join(tmp, 'secret-line.txt'), `harmless header\napi_token = "${SEARCH_SECRET}"\ntrailer\n`);
  // The witness append changed big20m after f20 was recorded; refresh expectations.
  {
    const stat = await fsp.stat(path.join(tmp, 'big20m.txt'));
    const content = await fsp.readFile(path.join(tmp, 'big20m.txt'), 'utf8');
    f20.bytes = stat.size;
    f20.lines = content.replace(/\r\n/g, '\n').split('\n').length;
  }

  // AP-016 direct: explicit-file search finds benign witnesses in the 20MiB file as available.
  for (const witness of ['class CampaignRepo', 'CampaignStorageTopology', 'compose_campaign_storage']) {
    const found = await searchWorkspace(config, guard, directWs, { query: witness, regex: false, includeHidden: false, maxResults: 10, root: 'big20m.txt' });
    assert.ok(found.matches.length > 0, `explicit search missed ${witness}`);
    for (const match of found.matches) {
      assert.equal(match.text_status, 'available', `${witness} not available: ${JSON.stringify(match)}`);
      assert.ok(!match.text.includes('[REDACTED_SECRET]') && !match.text.includes('[SOURCE_CONTEXT_UNAVAILABLE]'), `${witness} mislabeled`);
    }
  }
  console.log('ok explicit-file large search: benign witnesses available');

  // AP-017 direct: actual credentials stay redacted across lexical routes.
  {
    const found = await searchWorkspace(config, guard, directWs, { query: 'api_token', regex: false, includeHidden: false, maxResults: 10, root: 'secret-line.txt' });
    const credentialMatch = found.matches.find((m) => m.line === 2);
    assert.ok(credentialMatch, 'credential line not found');
    assert.equal(credentialMatch.text_status, 'redacted');
    assert.ok(credentialMatch.text.includes('[REDACTED_SECRET]'), 'redaction marker missing');
    assert.ok(!credentialMatch.text.includes(SEARCH_SECRET.slice(0, 17)), 'credential leaked in match text');
    assert.ok(!found.text.includes(SEARCH_SECRET.slice(0, 17)), 'credential leaked in search text');
    console.log('ok credential matches genuinely redacted');
  }

  // F1-C: a query matching text inside the final key-body line of the >2MiB
  // EOF-block fixture is redacted, never available; neither the match text,
  // the query echo, nor structured metadata reconstructs the value.
  {
    const found = await searchWorkspace(config, guard, directWs, { query: 'F1EOFBODY7X9_FINAL', regex: false, includeHidden: false, maxResults: 10, root: 'eof-block.txt' });
    assert.ok(found.matches.length > 0, 'final body line not found');
    for (const match of found.matches) {
      assert.equal(match.text_status, 'redacted', `final body line not redacted: ${JSON.stringify(match)}`);
      assert.ok(!match.text.includes('F1EOFBODY7X9_'), 'body value in match text');
    }
    const serialized = JSON.stringify(found);
    assert.ok(!serialized.includes('F1EOFBODY7X9_'), 'body value reconstructed in search envelope');
    console.log('ok F1-C final body line search redacted');
  }

  // AP-018 direct: undecodable context is unavailable (never secret-labeled).
  {
    const found = await searchWorkspace(config, guard, directWs, { query: 'CampaignStorageTopology', regex: false, includeHidden: false, maxResults: 10, root: 'latin1.txt' });
    assert.ok(found.matches.length > 0, 'latin1 match missing');
    for (const match of found.matches) {
      assert.equal(match.text_status, 'unavailable');
      assert.ok(typeof match.reason === 'string' && match.reason.length > 0, 'unavailable lacks reason');
      assert.equal(match.text, '[SOURCE_CONTEXT_UNAVAILABLE]');
      assert.ok(!match.text.includes('[REDACTED_SECRET]'), 'unavailable masquerades as secret');
    }
    console.log(`ok unavailable distinguished (reason=${found.matches[0].reason})`);
  }

  // AP-016/018 MCP: same contract through compiled stdio search.
  {
    const mcpWitness = assertToolSuccess(await stdioClient.request('tools/call', {
      name: 'search', arguments: { workspace_id: ws, query: 'class CampaignRepo', path: 'big20m.txt' }
    }), 'mcp explicit search');
    const witnessMatch = mcpWitness.structuredContent.matches.find((m) => m.path === 'big20m.txt');
    assert.ok(witnessMatch, 'mcp explicit search missed witness');
    assert.equal(witnessMatch.text_status, 'available');
    assert.ok(witnessMatch.text.includes('class CampaignRepo'), 'witness text wrong');

    const mcpSecret = assertToolSuccess(await stdioClient.request('tools/call', {
      name: 'search', arguments: { workspace_id: ws, query: 'api_token', path: 'secret-line.txt' }
    }), 'mcp secret search');
    const secretMatch = mcpSecret.structuredContent.matches.find((m) => m.line === 2);
    assert.ok(secretMatch && secretMatch.text_status === 'redacted', `secret not redacted: ${JSON.stringify(secretMatch)}`);

    const mcpLatin = assertToolSuccess(await stdioClient.request('tools/call', {
      name: 'search', arguments: { workspace_id: ws, query: 'CampaignStorageTopology', path: 'latin1.txt' }
    }), 'mcp latin1 search');
    assert.ok(mcpLatin.structuredContent.matches.length > 0, 'mcp latin1 missed');
    for (const m of mcpLatin.structuredContent.matches) {
      assert.equal(m.text_status, 'unavailable');
      assert.ok(typeof m.reason === 'string');
      assert.ok(!m.text.includes('[REDACTED_SECRET]'), 'mcp unavailable masquerades as secret');
    }

    // Structured intent keeps statuses and never substitutes secret markers for failures.
    const mcpStructured = assertToolSuccess(await stdioClient.request('tools/call', {
      name: 'search', arguments: { workspace_id: ws, query: 'CampaignStorageTopology', path: 'latin1.txt', intent: 'text' }
    }), 'mcp structured search');
    for (const m of mcpStructured.structuredContent.matches) {
      assert.ok(['available', 'redacted', 'unavailable'].includes(m.text_status), `bad status ${m.text_status}`);
      if (m.text_status === 'unavailable') {
        assert.ok(typeof m.reason === 'string');
        assert.ok(!m.text.includes('[REDACTED_SECRET]'));
      }
    }
    for (const m of mcpStructured.structuredContent.analysis?.matches ?? []) {
      assert.ok(['available', 'redacted', 'unavailable'].includes(m.text_status), `analysis bad status ${m.text_status}`);
    }
    console.log('ok mcp search statuses end-to-end (lexical + structured)');
  }
  await stdioClient.close();
  stdioClient = null;

  // AP-010 MCP HTTP: compiled HTTP route serves the same contract.
  {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const getPort = () => new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : undefined;
        server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
      });
      server.on('error', reject);
    });
    const port = await getPort();
    const { randomBytes } = await import('node:crypto');
    const token = `lf-smoke-${randomBytes(24).toString('hex')}`;
    const child = spawn('node', ['dist/http.js'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp,
        CODEXPRO_HOST: '127.0.0.1', CODEXPRO_PORT: String(port), CODEXPRO_HTTP_TOKEN: token,
        CODEXPRO_BASH_MODE: 'off', CODEXPRO_WRITE_MODE: 'off'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(() => reject(new Error(`http listen timeout\n${stderr}`)), 15000);
        timer.unref();
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
          if (stderr.includes('HTTP MCP listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`http exited ${code}\n${stderr}`));
        });
      });
      const httpClient = new Client({ name: 'large-file-http-smoke', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?token=${token}`));
      await httpClient.connect(transport);
      const httpOpened = await httpClient.callTool({ name: 'open_current_workspace', arguments: { include_tree: false } });
      const httpWs = httpOpened.structuredContent.workspace_id;
      const httpRange = await httpClient.callTool({ name: 'read', arguments: { workspace_id: httpWs, path: 'big20m.txt', start_line: 536, end_line: 565 } });
      assert.equal(httpRange.structuredContent.endLine, 565);
      assert.equal(httpRange.structuredContent.bytes, f20.bytes);
      const httpUnbounded = await httpClient.callTool({ name: 'read', arguments: { workspace_id: httpWs, path: 'big1m.txt' } });
      assert.equal(httpUnbounded.structuredContent.budgetTruncated, true);
      assert.ok(typeof httpUnbounded.structuredContent.nextStartLine === 'number');
      await httpClient.close();
      console.log('ok mcp http range + unbounded paging');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
  }
  console.log('AP-010/AP-011 PASS');
} finally {
  try {
    await stdioClient?.close();
  } catch {}
  await fsp.rm(tmp, { recursive: true, force: true });
}
