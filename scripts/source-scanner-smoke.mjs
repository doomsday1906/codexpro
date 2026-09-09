import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  scanStream,
  scanWorkingTreeFile,
  frameRawWindow,
  resolveWindow,
  identitiesEqual,
  TriviaMaskStream,
  NukeDetectorStream,
  SourceScanError,
  SelectedLineTooLargeError,
  SOURCE_SCAN_LIMIT_BYTES,
  LINE_FRAG_CAP_BYTES,
} = await import('../dist/sourceProjection.js');
const { projectPublicSourceText } = await import('../dist/fsOps.js');
const { createPrivateKeyScanner } = await import('../dist/redact.js');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const splitLines = (t) => t.replace(/\r\n/g, '\n').split('\n');
let tmpRoot = '';

async function makeTmp() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-scanner-'));
  return tmpRoot;
}
async function writeTmp(name, content) {
  const p = path.join(tmpRoot, name);
  await fsp.writeFile(p, content);
  return p;
}
async function oracleMeta(p) {
  const raw = await fsp.readFile(p);
  return { raw, text: raw.toString('utf8'), bytes: raw.byteLength, sha: sha256(raw) };
}

async function checkEdge(name, content, sel) {
  const p = await writeTmp(name, content);
  const { raw, text, bytes, sha } = await oracleMeta(p);
  const oracleLines = splitLines(text);
  const scan = await scanWorkingTreeFile(fsp, { absPath: p, ...sel, chunkBytes: 4096 });
  assert.equal(scan.bytes, bytes, `${name} bytes`);
  assert.equal(scan.sha256, sha, `${name} sha`);
  assert.equal(scan.totalLines, oracleLines.length, `${name} totalLines`);
  assert.equal(scan.nulFound, raw.includes(0), `${name} nul`);
  assert.equal(scan.race, false, `${name} race`);
  if (sel) {
    const a = Math.max(1, sel.startLine ?? 1);
    const b = Math.min(oracleLines.length, sel.endLine ?? oracleLines.length);
    const expected = a <= b ? oracleLines.slice(a - 1, b).filter((_, i) => true) : [];
    assert.equal(scan.selected.length, expected.length, `${name} selected length`);
    scan.selected.forEach((line, i) => {
      assert.equal(line.giant, false, `${name} unexpected giant`);
      assert.equal(line.text, expected[i], `${name} selected[${i}]`);
      assert.equal(line.bytes, Buffer.byteLength(expected[i], 'utf8'), `${name} selected bytes[${i}]`);
    });
  }
  assert.ok(scan.maxRetainedBytes <= 2 << 20, `${name} retention bound ${scan.maxRetainedBytes}`);
  console.log(`ok edge ${name} bytes=${bytes} lines=${scan.totalLines} retained=${scan.maxRetainedBytes}`);
}

async function main() {
  await makeTmp();
  try {
    // AP-004: newline/UTF-8/binary/race/paging corpus
    await checkEdge('empty', '', { startLine: 1, endLine: 10 });
    await checkEdge('lf', 'a\nb\nc\n', { startLine: 2, endLine: 3 });
    await checkEdge('crlf', 'a\r\nb\r\nc\r\n', { startLine: 1, endLine: 2 });
    await checkEdge('mixed', 'a\r\nb\nc', { startLine: 1, endLine: 3 });
    await checkEdge('noeol', 'hello', { startLine: 1, endLine: 1 });
    await checkEdge('loner', 'a\rb\nc\rd', { startLine: 1, endLine: 2 });
    await checkEdge('lone-cr-end', 'abc\r', { startLine: 1, endLine: 1 });
    await checkEdge('crlf-split', `${'x'.repeat(70000)}\r\ny\n`, { startLine: 1, endLine: 2 });
    await checkEdge('utf8', 'héllo wörld ✓\nline2 ’quotes’\n', { startLine: 1, endLine: 2 });
    await checkEdge('utf8-split', `${'a'.repeat(65534)}✓✓✓\nend\n`, { startLine: 1, endLine: 2 });
    await checkEdge('nul-before', 'line1\n\x00bin\nline3\nline4\n', { startLine: 3, endLine: 3 });
    await checkEdge('nul-after', 'line1\nline2\nline3\nla\x00te\n', { startLine: 2, endLine: 2 });
    await checkEdge('giant-mid', `top\n${'G'.repeat(500000)}\nbottom\n`, { startLine: 1, endLine: 3 });

    // giant first line: flagged, content withheld, exact bytes
    {
      const p = await writeTmp('giant-first', `${'H'.repeat(2 << 20)}\nsecond\n`);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 2, chunkBytes: 4096 });
      assert.equal(scan.selected.length, 2);
      assert.equal(scan.selected[0].giant, true);
      assert.equal(scan.selected[0].text, '');
      assert.equal(scan.selected[0].bytes, 2 << 20);
      assert.equal(scan.selected[1].text, 'second');
      assert.equal(scan.giants.length, 1);
      assert.deepEqual(scan.giants[0], { lineNo: 1, bytes: 2 << 20 });
      // framing a giant first line throws the specific bounded error
      const win = resolveWindow({ startLine: 1, endLine: 2 }, scan.totalLines);
      assert.throws(
        () => frameRawWindow(scan.selected, scan.selected, { ...win, totalLines: scan.totalLines, bytes: scan.bytes, sha256: scan.sha256, maxBytes: 180000 }),
        (e) => e instanceof SelectedLineTooLargeError && e.facts.line === 1
      );
      // paging around: window starting at line 2 works, nextStartLine skips the giant
      const scan2 = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 2, chunkBytes: 4096 });
      const framed2 = frameRawWindow(scan2.selected.slice(1), scan2.selected.slice(1), { startLine: 2, endLine: 2, totalLines: scan.totalLines, bytes: scan.bytes, sha256: scan.sha256, maxBytes: 180000 });
      assert.equal(framed2.text, '2 | second');
      console.log('ok giant-first withheld+paged');
    }

    // framing: paging, continuation, unbounded first page, over-budget first line
    {
      const p = await writeTmp('frame', `${Array.from({ length: 500 }, (_, i) => `note line ${i + 1} benign`).join('\n')}\n`);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 500 });
      const win = resolveWindow({}, scan.totalLines);
      const page1 = frameRawWindow(scan.selected, scan.selected, { ...win, totalLines: scan.totalLines, bytes: scan.bytes, sha256: scan.sha256, maxBytes: 1000 });
      assert.equal(page1.startLine, 1);
      assert.equal(page1.budgetTruncated, true);
      assert.ok(page1.nextStartLine > 1);
      assert.ok(page1.returnedBytes <= 1000);
      assert.equal(page1.truncated, true);
      // continuation resumes exactly where the page stopped
      const scan2 = await scanWorkingTreeFile(fsp, { absPath: p, startLine: page1.nextStartLine, endLine: 500 });
      const page2 = frameRawWindow(scan2.selected, scan2.selected, { startLine: page1.nextStartLine, endLine: 500, totalLines: scan.totalLines, bytes: scan.bytes, sha256: scan.sha256, maxBytes: 1000000 });
      assert.equal(page2.startLine, page1.nextStartLine);
      assert.equal(page2.budgetTruncated, false);
      assert.equal(page2.nextStartLine, undefined);
      // full-fit small window equals the accepted oracle projection text
      const { raw, text } = await oracleMeta(p);
      const oracle = projectPublicSourceText({ logicalPath: 'notes.txt', text, bytes: raw.byteLength, sha256: sha256(raw), startLine: 7, endLine: 42, maxBytes: 180000 });
      const scan3 = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 7, endLine: 42 });
      const framed3 = frameRawWindow(scan3.selected, scan3.selected, { startLine: 7, endLine: 42, totalLines: scan.totalLines, bytes: scan.bytes, sha256: scan.sha256, maxBytes: 180000 });
      assert.equal(framed3.text, oracle.text);
      // resolveWindow preserves accepted clamp errors
      assert.throws(() => resolveWindow({ startLine: 999, endLine: 1000 }, 10), /end_line \(10\) must be >= start_line \(999\)/);
      console.log(`ok framing page1 end=${page1.endLine} next=${page1.nextStartLine} oracle-parity`);
    }

    // race: replacement during scan fails closed; stable file has no false positive.
    // Deterministic ordering: the victim is large with 1KiB chunks (seconds-long
    // scan); a 100ms settle guarantees open+pre-stat completed while reads are
    // still in flight, so the rename provably interleaves.
    {
      const p = await writeTmp('race-victim', `${Array.from({ length: 200000 }, (_, i) => `padding line ${String(i).padStart(7, '0')} xxxxxxxxxxxxxxxxxxxxxxxxx`).join('\n')}\n`);
      const scanP = scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 2, chunkBytes: 1024 });
      await new Promise((r) => setTimeout(r, 100));
      await fsp.writeFile(`${p}.tmp`, 'replaced\n');
      await fsp.rename(`${p}.tmp`, p);
      await assert.rejects(scanP, (e) => e instanceof SourceScanError && e.reason === 'race');
      const stable = await writeTmp('race-stable', 'a\nb\n');
      const okScan = await scanWorkingTreeFile(fsp, { absPath: stable, startLine: 1, endLine: 2 });
      assert.equal(okScan.race, false);
      console.log('ok race coherent-failure + stable');
    }

    // abort: cancellation cleans up the handle
    {
      const p = await writeTmp('abort-victim', `${'z'.repeat(5000000)}\n`);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 2, signal: controller.signal }),
        (e) => e instanceof SourceScanError && e.reason === 'aborted'
      );
      console.log('ok abort');
    }

    // AP-006: no source-size gate derived from output/read budgets.
    {
      // tiny scan policy proves the failure reason is scan policy, not response budget
      const p = await writeTmp('over-policy', `${'q'.repeat(3 << 20)}\n`);
      await assert.rejects(
        scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 2, scanLimitBytes: 1 << 20 }),
        (e) => e instanceof SourceScanError && e.reason === 'source_scan_limit'
      );
      console.log('ok scan-limit reason independent of budgets');
    }

    // security observers: private-key spans match one-shot; nuke trigger agrees; mask snapshots exact
    {
      const hostile = 'header\n-----BEGIN RSA PRIVATE KEY-----\nBODYLINEONE\nBODYLINETWO\n-----END RSA PRIVATE KEY-----\ntail\n';
      const p = await writeTmp('hostile', hostile);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 3, endLine: 4, chunkBytes: 7 });
      const oneShot = createPrivateKeyScanner();
      oneShot.push(hostile, true);
      assert.deepEqual(scan.privateKeySpans, oneShot.spans().map((s) => ({ start: s.start, end: s.end })));
      assert.equal(scan.nukeOffset, -1);
      assert.ok(scan.maskAtWindowStart !== null && scan.windowStartsInCode);
      const nuked = await writeTmp('nuked', 'const API_TOKEN = getToken(abc,\nconst NORMAL = 1;\n');
      const scanNuked = await scanWorkingTreeFile(fsp, { absPath: nuked, startLine: 2, endLine: 2, chunkBytes: 11 });
      assert.ok(scanNuked.nukeOffset >= 0, `expected nuke trigger, got ${scanNuked.nukeOffset}`);
      const inComment = await writeTmp('incomment', '/* open comment\ncontent line two\ncontent line three\n');
      const scanComment = await scanWorkingTreeFile(fsp, { absPath: inComment, startLine: 3, endLine: 3, chunkBytes: 5 });
      assert.equal(scanComment.windowStartsInCode, false);
      assert.equal(scanComment.maskAtWindowStart.state, 'block-comment');
      // mask snapshot agrees with whole-string masker at the same offset
      const masker = new TriviaMaskStream();
      const fullMasked = masker.feed(hostile);
      const sliceCheck = fullMasked.slice(scan.maskAtWindowStart.offset);
      const reseeded = new TriviaMaskStream();
      reseeded.restore(scan.maskAtWindowStart);
      assert.equal(reseeded.feed(hostile.slice(scan.maskAtWindowStart.offset, scan.maskAtWindowStart.offset + 40)), sliceCheck.slice(0, 40));
      console.log('ok security observers (spans/nuke/mask snapshots)');
    }

    // AP-005: 1/20/64 MiB deterministic fixtures, constant retention, exact metadata.
    // Generator: PARAMS v1 — `line %09d + 60 x + optional ✓café (i%97) + optional \r (i%500)` joined with \n.
    const retained = [];
    for (const [name, target] of [['f1m', 1 << 20], ['f20m', 20 << 20], ['f64m', 64 << 20]]) {
      const p = path.join(tmpRoot, `${name}.bin`);
      const handle = await fsp.open(p, 'w');
      let i = 0, written = 0;
      const hash = createHash('sha256');
      while (written < target) {
        const s = `line ${String(i).padStart(9, '0')} ${'x'.repeat(60)}${i % 97 === 0 ? ' ✓café' : ''}${i % 500 === 0 ? '\r' : ''}\n`;
        await handle.write(s);
        hash.update(s, 'utf8');
        written += Buffer.byteLength(s, 'utf8');
        i += 1;
      }
      await handle.close();
      const expectedSha = hash.digest('hex');
      const stat = await fsp.stat(p);
      const t0 = Date.now();
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 100, endLine: 129 });
      const ms = Date.now() - t0;
      assert.equal(scan.bytes, stat.size, `${name} bytes`);
      assert.equal(scan.sha256, expectedSha, `${name} sha`);
      assert.equal(scan.nulFound, false, `${name} nul`);
      assert.equal(scan.selected.length, 30, `${name} window`);
      assert.ok(scan.selected[0].text.startsWith('line 000000099'), `${name} window content`);
      retained.push(scan.maxRetainedBytes);
      console.log(`ok ${name} bytes=${scan.bytes} lines=${scan.totalLines} retained=${scan.maxRetainedBytes} sha=${expectedSha.slice(0, 12)} (${ms}ms)`);
    }
    assert.ok(Math.max(...retained) <= 2 << 20, `retention bound ${Math.max(...retained)}`);
    assert.ok(Math.max(...retained) - Math.min(...retained) < 65536, `retention constant ${retained}`);
    console.log(`RETENTION 1/20/64MiB: ${retained.join('/')} (constant, source-independent)`);
    console.log('AP-004/AP-005/AP-006 PASS');
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

await main();
