import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  scanWorkingTreeFile,
  projectLargeWindow,
  applyPrivateKeySpansToLines,
  applyNukeOffsetToLines,
  trimFlankBefore,
  WINDOW_FLANK_BYTES,
} = await import('../dist/sourceProjection.js');
const { projectPublicSourceText } = await import('../dist/fsOps.js');
const {
  createPrivateKeyScanner,
  redactSensitiveTextPreservingLines,
  hasSecretValue,
} = await import('../dist/redact.js');
const { createPythonProvenance } = await import('../scripts/python-provenance.mjs');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const redactSlice = (slice) => redactSensitiveTextPreservingLines(slice, { context: 'source' });
let tmpRoot = '';
let failures = 0;
function noteFail(message) {
  failures += 1;
  console.log(`FAIL ${message}`);
}

function lineOffsets(text) {
  const lines = text.split('\n');
  const offsets = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  return { lines, offsets };
}

async function projectWindow(absPath, text, startLine, endLine, chunkBytes = 4096) {
  const scan = await scanWorkingTreeFile(fsp, { absPath, startLine, endLine, chunkBytes });
  const { lines, offsets } = lineOffsets(text);
  const winStart = offsets[startLine - 1];
  const projected = projectLargeWindow({
    scan,
    rawLines: lines.slice(startLine - 1, endLine),
    windowStartOffset: winStart,
  }, redactSlice);
  // the scan-derived flanks must reproduce the caller-visible window context
  assert.ok(scan.flankBefore.length <= 65536, 'flankBefore bound');
  assert.ok(scan.flankAfter.length <= 65536, 'flankAfter bound');
  return { scan, projected };
}

function assertSuperset(name, text, lang, startLine, endLine, projected) {
  const oracle = redactSensitiveTextPreservingLines(text, { context: 'source', language: lang }).split('\n');
  const { lines } = lineOffsets(text);
  for (let i = 0; i < projected.lines.length; i += 1) {
    const ln = startLine + i;
    if (oracle[ln - 1] !== lines[ln - 1] && projected.lines[i] === lines[ln - 1]) {
      noteFail(`UNDER-REDACT [${name}] line ${ln}: oracle=${JSON.stringify(oracle[ln - 1].slice(0, 80))}`);
    }
  }
}

async function main() {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-projection-'));
  try {
    // AP-007a: private-key line mapper == oracle private-key stage (label-free filler).
    {
      const filler = Array.from({ length: 30 }, (_, i) => `benign code line ${i} class Foo${i} { value = ${i}; }`).join('\n');
      const text = `${filler}\n-----BEGIN RSA PRIVATE KEY-----\nMIIBODYLINEONE\nBODYLINETWO\n-----END RSA PRIVATE KEY-----\n${filler}\n`;
      const p = path.join(tmpRoot, 'keys.txt');
      await fsp.writeFile(p, text);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 28, endLine: 36, chunkBytes: 13 });
      const { lines, offsets } = lineOffsets(text);
      const mapped = applyPrivateKeySpansToLines(lines.slice(27, 36), offsets.slice(27, 36), scan.privateKeySpans);
      const oracle = redactSensitiveTextPreservingLines(text, { context: 'source' }).split('\n').slice(27, 36);
      assert.deepEqual(mapped, oracle, 'private-key line mapping differs from oracle stage');
      console.log('ok AP-007a private-key stage parity');
    }

    // AP-007b: nuke mapper == oracle nuke on the same window.
    {
      const text = 'const API_TOKEN = getToken(abc,\nconst NORMAL = 1;\nconst OTHER = 2;\n';
      const p = path.join(tmpRoot, 'nuke.txt');
      await fsp.writeFile(p, text);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 2, endLine: 3, chunkBytes: 7 });
      assert.ok(scan.nukeOffset >= 0, 'expected scan nuke trigger');
      const { lines, offsets } = lineOffsets(text);
      const { lines: mapped, applied } = applyNukeOffsetToLines(lines.slice(1, 3), offsets.slice(1, 3), scan.nukeOffset);
      const oracle = redactSensitiveTextPreservingLines(text, { context: 'source' }).split('\n').slice(1, 3);
      assert.equal(applied, true);
      assert.deepEqual(mapped, oracle, 'nuke mapping differs from oracle');
      console.log('ok AP-007b nuke mapping parity');
    }

    // AP-007c: full large-path projection on small inputs is a superset of the oracle
    // (language hint dropped = accepted over-limit provenance behavior).
    {
      const cases = {
        'py-cred': { lang: 'python', text: 'import os\nAPI_KEY = os.getenv("PROD_KEY")\nOTHER = 1\npassword = "hunter2"\n' },
        'js-typed': { lang: undefined, text: 'const TOKEN: string = getToken();\nconst cfg = { api_token: getToken(), };\n' },
        'benign': { lang: undefined, text: 'class CampaignRepo {}\nconst CampaignStorageTopology = 1;\nfunction compose_campaign_storage() {}\n' },
      };
      for (const [name, { lang, text }] of Object.entries(cases)) {
        const p = path.join(tmpRoot, `${name}.txt`);
        await fsp.writeFile(p, text);
        const n = text.split('\n').length;
        const { projected } = await projectWindow(p, text, 1, n - 1, 11);
        assert.equal(projected.lines.length, n - 1, `${name} line correspondence`);
        assertSuperset(`small-${name}`, text, lang, 1, n - 1, projected);
      }
      console.log('ok AP-007c small-input superset + correspondence');
    }

    // AP-007d: python provenance boundary — available at/below cap, over-limit above (no unbounded parse).
    {
      const small = `API_KEY = "x"\n`.repeat(100);
      const prov = createPythonProvenance(small, { language: 'python' });
      assert.equal(prov.available, true);
      const big = `x = ${'1'.repeat(2100000)}\n`;
      const provBig = createPythonProvenance(big, { language: 'python' });
      assert.equal(provBig.available, false);
      assert.equal(provBig.reason, 'over-limit');
      console.log('ok AP-007d provenance cap (no unbounded parse above 2MiB)');
    }

    // AP-008: hostile large file — private key far before window, secrets at every chunk split.
    {
      const SECRET = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
      const parts = ['// top marker'];
      parts.push('-----BEGIN OPENSSH PRIVATE KEY-----');
      parts.push('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQ');
      parts.push('-----END OPENSSH PRIVATE KEY-----');
      // ~3MiB of filler with a credential line placed so its value crosses 64-byte chunk splits
      let i = 0;
      while (Buffer.byteLength(parts.join('\n'), 'utf8') < 3 * 1024 * 1024) {
        i += 1;
        if (i % 25 === 0) parts.push(`api_token_${i} = "${SECRET.slice(0, 10)}${'y'.repeat(i % 7)}${SECRET.slice(10)}"`);
        else parts.push(`// filler ${i} lorem ipsum dolor sit amet consectetur adipiscing elit ${'z'.repeat(40)}`);
      }
      parts.push('class CampaignRepo {}');
      const text = `${parts.join('\n')}\n`;
      const p = path.join(tmpRoot, 'hostile3m.txt');
      await fsp.writeFile(p, text);
      const total = text.split('\n').length;
      const startLine = total - 60;
      const { scan, projected } = await projectWindow(p, text, startLine, total - 1, 64);
      assert.equal(projected.lines.length, total - startLine);
      assertSuperset('hostile3m', text, undefined, startLine, total - 1, projected);
      const joined = projected.lines.join('\n');
      assert.ok(!joined.includes('b3BlbnNzaC1rZXktdjE'), 'private body leaked');
      assert.ok(!joined.includes(SECRET), 'credential leaked across chunk splits');
      assert.ok(!hasSecretValue(joined, { context: 'source' }), 'absolute hasSecretValue net');
      assert.ok(scan.maxRetainedBytes <= 2 * 1024 * 1024, `retention ${scan.maxRetainedBytes}`);
      // benign tail witness visible
      assert.ok(projected.lines[projected.lines.length - 1].includes('class CampaignRepo'), 'benign witness hidden');
      console.log(`ok AP-008 hostile 3MiB (splits@64B) superset + no-leak retained=${scan.maxRetainedBytes}`);
    }

    // AP-008b: template-literal + minified adversarial shapes (measure; superset required).
    {
      const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCD';
      const pad = Array.from({ length: 1200 }, (_, k) => `// pad line ${k} ${'p'.repeat(60)}`).join('\n');
      const text = [
        'const tpl = `prefix ${API_KEY} suffix`;',
        `const min = {a:1,api_token:"${SECRET}",b:2};`,
        pad,
        'const AFTER = 1;',
      ].join('\n') + '\n';
      const p = path.join(tmpRoot, 'adversarial.txt');
      await fsp.writeFile(p, text);
      const { projected } = await projectWindow(p, text, 1203, 1204, 97);
      assertSuperset('adversarial', text, undefined, 1203, 1204, projected);
      const joined = projected.lines.join('\n');
      assert.ok(!joined.includes(SECRET), 'minified secret leaked');
      console.log('ok AP-008b adversarial superset + no-leak');
    }

    // Scan-derived flanks: boundary-aligned, bounded, and sufficient context.
    {
      const pad = Array.from({ length: 3000 }, (_, k) => `context line ${k} filler content for flank assembly`).join('\n');
      const text = `${pad}\nTARGET_A = 1\nTARGET_B = 2\n${pad}\n`;
      const p = path.join(tmpRoot, 'flanks.txt');
      await fsp.writeFile(p, text);
      const { lines } = lineOffsets(text);
      const targetA = lines.findIndex((l) => l === 'TARGET_A = 1') + 1;
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: targetA, endLine: targetA + 1, chunkBytes: 1024 });
      assert.ok(scan.flankBefore.endsWith('\n') || scan.flankBefore === '');
      assert.ok(scan.flankBefore.length <= 65536 && scan.flankAfter.length <= 65536);
      assert.ok(scan.flankBefore.includes(`context line ${3000 - 1}`) || scan.flankBefore.length === 65536);
      assert.ok(scan.flankAfter.includes('TARGET_B = 2') || scan.flankAfter.length > 0);
      assert.equal(scan.bridgeSuspect, false);
      assert.equal(scan.windowStartsInCode, true);
      console.log(`ok scan flanks before=${scan.flankBefore.length} after=${scan.flankAfter.length}`);
    }

    // Uncertain mask state (window opens inside a block comment): labeled lines forced.
    {
      const text = '/* open comment\nTOKEN = config.prod_value_here\nstill comment\n*/\nconst AFTER = 1;\n';
      const p = path.join(tmpRoot, 'uncertain.txt');
      await fsp.writeFile(p, text);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 2, endLine: 2, chunkBytes: 5 });
      assert.equal(scan.windowStartsInCode, false);
      const { lines, offsets } = lineOffsets(text);
      const projected = projectLargeWindow({
        scan, rawLines: lines.slice(1, 2), windowStartOffset: offsets[1],
      }, redactSlice);
      // The whole-source oracle redacts comment-embedded credential shapes (fail-closed);
      // the uncertain path must not allow what the oracle denies.
      const oracleLine = redactSlice(text).split('\n')[1];
      if (oracleLine !== lines[1] && projected.lines[0] === lines[1]) {
        noteFail('uncertain-mask UNDER-REDACT vs oracle');
      }
      console.log(`ok uncertain-mask window (oracle=${JSON.stringify(oracleLine.slice(0, 40))} projected=${JSON.stringify(projected.lines[0].slice(0, 40))})`);
    }
    // AP-008c: bridge-suspect flank (trimmed partial line with label) forces first window line.
    // trimFlankBefore unit behavior first, then the R4 projector rule with a
    // scan carrying a trimmed flank (64KiB-scale trimming is covered at scale in AP-008).
    {
      const t1 = trimFlankBefore('x = 1; API_TOKEN = "ghp_BRID');
      assert.equal(t1.flank, '');
      assert.equal(t1.bridgeSuspect, true);
      const t2 = trimFlankBefore('plain partial line without labels');
      assert.equal(t2.bridgeSuspect, false);
      const t3 = trimFlankBefore('first partial\ndropped\nsecond line kept\n');
      assert.equal(t3.flank, 'dropped\nsecond line kept\n');
      assert.equal(t3.bridgeSuspect, false);

      const SECRET = 'ghp_BRIDGETESTBRIDGETESTBRIDGETEST0123456789ab';
      const text = `x = 1; API_TOKEN = "${SECRET}"\nTAILLINE = "${SECRET.slice(8)}";\nconst CLEAN = 2;\n`;
      const p = path.join(tmpRoot, 'bridge.txt');
      await fsp.writeFile(p, text);
      const { lines, offsets } = lineOffsets(text);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 2, endLine: 3, chunkBytes: 9 });
      // Simulate a trimmed flank: the 30-byte pre-window chunk was one partial
      // line (trimmed to empty) carrying the label, so the match may bridge in.
      const bridgedScan = { ...scan, flankBefore: '', bridgeSuspect: true };
      const projected = projectLargeWindow({
        scan: bridgedScan, rawLines: lines.slice(1, 3), windowStartOffset: offsets[1],
      }, redactSlice);
      assert.ok(projected.forcedLines.includes(0), 'R4 did not force the bridged first line');
      const joined = projected.lines.join('\n');
      assert.ok(!joined.includes(SECRET), 'bridged secret leaked');
      console.log('ok AP-008c bridge force-redact');
    }

    // AP-009: large benign source stays fully visible (no secret-treating).
    {
      const lines = [];
      for (let k = 0; k < 260000; k += 1) {
        lines.push(`ordinary source line ${k} with plain boring code and numbers ${k * 7}`);
      }
      lines.push('class CampaignRepo {}');
      lines.push('const CampaignStorageTopology = build();');
      lines.push('compose_campaign_storage();');
      const text = `${lines.join('\n')}\n`;
      const p = path.join(tmpRoot, 'benign20m.txt');
      await fsp.writeFile(p, text);
      const total = lines.length;
      const { scan, projected } = await projectWindow(p, text, total - 40, total, 8192);
      assert.ok(projected.redacted.every((flag) => flag === false), 'benign lines flagged redacted');
      assert.ok(projected.lines[projected.lines.length - 1].includes('compose_campaign_storage'));
      assert.ok(projected.lines[projected.lines.length - 2].includes('CampaignStorageTopology'));
      assert.ok(projected.lines[projected.lines.length - 3].includes('class CampaignRepo'));
      assert.ok(scan.maxRetainedBytes <= 2 * 1024 * 1024, `retention ${scan.maxRetainedBytes}`);
      console.log(`ok AP-009 benign 20MiB fully available retained=${scan.maxRetainedBytes}`);
    }

    // Errors and metadata never echo source secrets.
    {
      const SECRET = 'ghp_ERRORPATHTESTERRORPATHTEST0123456789abcd';
      const p = path.join(tmpRoot, 'errpath.txt');
      await fsp.writeFile(p, `API_KEY = "${SECRET}"\n`);
      const scan = await scanWorkingTreeFile(fsp, { absPath: p, startLine: 1, endLine: 1 });
      try {
        const { frameRawWindow } = await import('../dist/sourceProjection.js');
        frameRawWindow(scan.selected, scan.selected, {
          startLine: 1, endLine: 1, totalLines: 1, bytes: scan.bytes, sha256: scan.sha256, maxBytes: 5,
        });
        noteFail('expected SelectedLineTooLargeError');
      } catch (error) {
        assert.ok(!String(error.message).includes(SECRET), 'secret in error message');
        assert.ok(!JSON.stringify(error.facts ?? {}).includes(SECRET), 'secret in error facts');
      }
      console.log('ok error/metadata hygiene');
    }

    // Below-threshold snapshot route keeps the accepted oracle verbatim (parity premise).
    {
      const text = 'import os\nAPI_KEY = os.getenv("PROD_KEY")\nclass CampaignRepo:\n    pass\n';
      const raw = Buffer.from(text, 'utf8');
      const oracle = projectPublicSourceText({
        logicalPath: 'mod.py', text, bytes: raw.byteLength, sha256: sha256(raw),
        startLine: 1, endLine: 4, maxBytes: 180000,
      });
      const oracle2 = projectPublicSourceText({
        logicalPath: 'mod.py', text, bytes: raw.byteLength, sha256: sha256(raw),
        startLine: 1, endLine: 4, maxBytes: 180000,
      });
      assert.deepEqual(oracle, oracle2, 'oracle determinism');
      assert.equal(oracle.totalLines, 5);
      console.log('ok snapshot oracle stable (TASK-004 wires it under the threshold)');
    }
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
  if (failures > 0) {
    console.log(`AP-007/AP-008/AP-009: ${failures} FAILURES`);
    process.exit(1);
  }
  console.log('AP-007/AP-008/AP-009 PASS');
}

await main();
