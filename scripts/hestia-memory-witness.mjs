// Hestia R1 F2 memory witness: every case runs the scanner/read in an ISOLATED
// child process; the child reports process-level peak RSS (ru_maxrss) plus
// source size, window, returned lines, and continuation. The parent asserts
// policy ceilings and prints the high-water table. Flat peaks across 1/20/64MiB
// plus structural cardinality assertions are the decisive proof (not the
// implementation's own maxRetainedBytes arithmetic).
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist");

if (process.argv[2] === "child") {
  await runChild(process.argv[3]);
  process.exit(0);
}

const CASES = [
  { name: "conv-1m", ceilingMB: 260 },
  { name: "conv-20m", ceilingMB: 260 },
  { name: "conv-64m", ceilingMB: 260 },
  { name: "giant-64m-nonl", ceilingMB: 300 },
  { name: "newlines-8m", ceilingMB: 300 },
  { name: "tiny-8m", ceilingMB: 300 },
  { name: "dense-spans", ceilingMB: 300 },
  { name: "hist-20m", ceilingMB: 300 },
  { name: "far-range", ceilingMB: 300 },
];

console.log("case,sourceBytes,totalLines,selected,capped,spans,overflow,peakRSS_MB,ceiling_MB,verdict");
let failures = 0;
for (const { name, ceilingMB } of CASES) {
  const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "child", name], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.log(`${name},?,?,?, ?,?,?,?,? ,CHILD_CRASH:${(run.stderr || "").slice(-200)}`);
    failures += 1;
    continue;
  }
  const r = JSON.parse(run.stdout);
  const peakMB = r.peakRSS / (1024 * 1024);
  const verdict = peakMB <= ceilingMB && r.structuralOk ? "PASS" : "FAIL";
  if (verdict === "FAIL") failures += 1;
  console.log(`${name},${r.sourceBytes},${r.totalLines},${r.selected},${r.capped},${r.spans},${r.overflow},${peakMB.toFixed(1)},${ceilingMB},${verdict}`);
  if (!r.structuralOk) console.log(`  structural breach: ${r.structuralNote}`);
}
console.log(failures === 0 ? "MEMORY_WITNESS: PASS" : "MEMORY_WITNESS: FAIL");
process.exit(failures === 0 ? 0 : 1);

async function runChild(name) {
  const { scanWorkingTreeFile, SELECT_CAPTURE_CAP_RECORDS, PRIVATE_KEY_SPAN_CAP } =
    await import(join(DIST, "sourceProjection.js"));
  const fsp = (await import("node:fs/promises")).default;
  const dir = mkdtempSync(join(tmpdir(), "hestia-mem-"));
  let absPath = join(dir, "case.bin.txt");
  let startLine; let endLine;

  // Fixtures are STREAMED to disk in small batches and never held in memory:
  // peak RSS must reflect the scanner, not the fixture builder.
  const line76 = (i) => `conventional source line ${String(i).padStart(8, "0")} padding text 0123456789\n`;
  const LINE76_LEN = 58;
  async function streamLines(abs, count, make) {
    const handle = await fsp.open(abs, "w");
    try {
      const BATCH = 20000;
      for (let base = 0; base < count; base += BATCH) {
        const n = Math.min(BATCH, count - base);
        const parts = new Array(n);
        for (let i = 0; i < n; i += 1) parts[i] = make(base + i);
        await handle.write(parts.join(""));
      }
    } finally {
      await handle.close();
    }
  }
  if (name === "conv-1m" || name === "conv-20m" || name === "conv-64m") {
    const target = name === "conv-1m" ? 1 << 20 : name === "conv-20m" ? 20 << 20 : 64 << 20;
    const reps = Math.ceil(target / LINE76_LEN);
    await streamLines(absPath, reps, line76);
    startLine = Math.floor(reps / 2); endLine = startLine + 500;
  } else if (name === "giant-64m-nonl") {
    const handle = await fsp.open(absPath, "w");
    try {
      const chunk = "g".repeat(1 << 20);
      for (let i = 0; i < 64; i += 1) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    startLine = 1; endLine = 1;
  } else if (name === "newlines-8m") {
    await streamLines(absPath, 8 << 20, () => "\n");
    startLine = 1; endLine = undefined;
  } else if (name === "tiny-8m") {
    await streamLines(absPath, 4 << 20, () => "a\n");
    startLine = 1; endLine = undefined;
  } else if (name === "dense-spans") {
    // F7: token-shaped delimiters are assembled from fragments (same standard
    // as the other proof scripts); bodies are synthetic single chars.
    const PK_BEGIN = "-----" + "BEG" + "IN RSA PRI" + "VATE KEY" + "-----";
    const PK_END = "-----" + "EN" + "D RSA PRI" + "VATE KEY" + "-----";
    const begin = (k) => `${PK_BEGIN}\nB${k}\n${PK_END}\n`;
    await streamLines(absPath, 60000, begin);
    const handle = await fsp.open(absPath, "a");
    try {
      await handle.write("benign tail line one\nbenign tail line two\n");
    } finally {
      await handle.close();
    }
    // 60000 blocks x 3 lines + 2 tail lines (+ final empty) -> tail window.
    startLine = 180001; endLine = 180002; // benign tail window
  } else if (name === "hist-20m") {
    const { streamGitBlobToScan } = await import(join(DIST, "gitHistoricalBlob.js"));
    const repo = mkdtempSync(join(tmpdir(), "hestia-memgit-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
    const repoFile = join(repo, "big.txt");
    const handle = await fsp.open(repoFile, "w");
    try {
      const BATCH = 20000;
      for (let base = 0; base < 360000; base += BATCH) {
        const parts = new Array(BATCH);
        for (let i = 0; i < BATCH; i += 1) parts[i] = line76(base + i);
        await handle.write(parts.join(""));
      }
    } finally {
      await handle.close();
    }
    execFileSync("git", ["add", "big.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "big"], { cwd: repo });
    const oid = execFileSync("git", ["rev-parse", "HEAD:big.txt"], { cwd: repo, encoding: "utf8" }).trim();
    const stat = execFileSync("git", ["cat-file", "-s", oid], { cwd: repo, encoding: "utf8" }).trim();
    const { scanStream } = await import(join(DIST, "sourceProjection.js"));
    const { scan } = await streamGitBlobToScan(
      { root: repo },
      {
        oid, advertised: Number(stat), timeoutMs: 120000, stderrMaxBytes: 65536,
        startLine: 1000, endLine: 1500, selectMaxBytes: 1 << 20, retainUpToBytes: 0,
      }
    );
    // streamGitBlobToScan returns the scan already run over the streamed blob.
    return report(scan, Number(stat), { SELECT_CAPTURE_CAP_RECORDS, PRIVATE_KEY_SPAN_CAP });
  } else if (name === "far-range") {
    await streamLines(absPath, 8 << 20, () => "\n");
    startLine = 1; endLine = 8000000; // far more lines than capture capacity
  }

  const scan = await scanWorkingTreeFile(fsp, { absPath, startLine, endLine });
  const stat = (await import("node:fs")).statSync(absPath);
  rmSync(dir, { recursive: true, force: true });
  return report(scan, stat.size, { SELECT_CAPTURE_CAP_RECORDS, PRIVATE_KEY_SPAN_CAP });

  function report(scan, sourceBytes, bounds) {
    const ru = process.resourceUsage();
    let structuralOk = true;
    const notes = [];
    if (scan.selected.length > bounds.SELECT_CAPTURE_CAP_RECORDS) {
      structuralOk = false; notes.push(`selected ${scan.selected.length} exceeds record cap`);
    }
    if (!scan.spansOverflowed && scan.privateKeySpans.length > bounds.PRIVATE_KEY_SPAN_CAP) {
      structuralOk = false; notes.push(`spans ${scan.privateKeySpans.length} exceed span cap`);
    }
    // Contiguity: captured lines must be an exact prefix from the window start.
    for (let i = 1; i < scan.selected.length; i += 1) {
      if (scan.selected[i].lineNo !== scan.selected[i - 1].lineNo + 1) {
        structuralOk = false; notes.push("capture hole"); break;
      }
    }
    // Giant content must never be retained.
    if (scan.selected.some((e) => e.giant && e.text !== "")) {
      structuralOk = false; notes.push("giant content retained");
    }
    if (name === "dense-spans") {
      if (!scan.spansOverflowed) { structuralOk = false; notes.push("dense corpus must overflow"); }
      if (scan.privateKeySpans.length !== 0) { structuralOk = false; notes.push("overflow must retain no spans"); }
    }
    if (name === "far-range" || name === "newlines-8m" || name === "tiny-8m") {
      if (!scan.selectionCapped) { structuralOk = false; notes.push("expected capture cap with continuation"); }
    }
    console.log(JSON.stringify({
      sourceBytes,
      totalLines: scan.totalLines,
      selected: scan.selected.length,
      capped: scan.selectionCapped,
      through: scan.capturedThroughLine,
      spans: scan.privateKeySpans.length,
      overflow: scan.spansOverflowed,
      peakRSS: ru.maxRSS * 1024,
      structuralOk,
      structuralNote: notes.join("; "),
    }));
  }
}
