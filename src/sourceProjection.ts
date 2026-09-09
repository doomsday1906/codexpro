/**
 * Shared bounded-source scanning and window-framing core for surgical
 * readability of large text sources.
 *
 * The public-source safety path historically materialized the complete source
 * (file Buffer/string/`allLines[]`, Git stdout capture) before projecting a
 * bounded line window. This module replaces acquisition with a single
 * sequential scan whose retained memory is bounded by fixed chunk/fragment
 * state plus the explicitly selected windows — never by total source size.
 *
 * Scan policy (`SOURCE_SCAN_LIMIT_BYTES`) is an independent operational bound:
 * it is not derived from any response budget and fails with a truthful
 * `source_scan_limit` reason instead of a misleading response-size error.
 *
 * Offset convention: every security-stream offset (private-key spans, nuke
 * trigger, mask snapshots) is a decoded-string offset matching the accepted
 * whole-string redactor semantics, so scan-phase observations compose exactly
 * with string-level projection.
 */
import { createHash } from "node:crypto";
import type fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { CodexProError } from "./guard.js";
import { createPrivateKeyScanner } from "./redact.js";

/** Sources at or below this fixed size keep the accepted complete-snapshot projector. */
export const FIXED_SNAPSHOT_BYTES = 2_000_000;
/** Sequential acquisition chunk. Two chunks plus small state bound retention. */
export const SCAN_CHUNK_BYTES = 64 * 1024;
/** A physical line longer than this streams in fragments; content is not retained. */
export const LINE_FRAG_CAP_BYTES = 1 << 20;
/** Independent operational scan ceiling. Fails as `source_scan_limit`, never as a response budget. */
export const SOURCE_SCAN_LIMIT_BYTES = 96 << 20;
/**
 * Default cap on retained selected-window bytes. Callers requesting a window
 * page through it; capture stops (counting continues) past the cap so one
 * explicit range can never pin memory proportional to the source.
 */
export const SELECT_CAPTURE_CAP_BYTES = 4 << 20;
/** Flanking context retained around a projected window for bounded redaction decisions. */
export const WINDOW_FLANK_BYTES = 64 * 1024;
/** Cap on simultaneously tracked paren-nuke candidates; overflow is conservative (nuke-all). */
export const NUKE_CANDIDATE_CAP = 1024;
/** Overlap for single-line nuke-candidate detection across stream segments. */
const NUKE_OVERLAP_BYTES = 1024;

export type ScanFailureReason = "source_scan_limit" | "race" | "aborted" | "not-a-file";

const SCAN_FAILURE_MESSAGES: Record<ScanFailureReason, string> = {
  source_scan_limit: "Source exceeds the operational scan limit.",
  race: "Source changed during scan; no mixed snapshot is returned.",
  aborted: "Source scan was cancelled.",
  "not-a-file": "Source is not a regular file."
};

export class SourceScanError extends CodexProError {
  readonly reason: ScanFailureReason;
  readonly facts: Readonly<Record<string, number>>;
  constructor(reason: ScanFailureReason, facts: Readonly<Record<string, number>> = {}) {
    super(SCAN_FAILURE_MESSAGES[reason]);
    this.name = "SourceScanError";
    this.reason = reason;
    this.facts = { ...facts };
  }
  toJSON(): object {
    return { name: this.name, message: this.message, reason: this.reason, facts: this.facts };
  }
}

export class SelectedLineTooLargeError extends CodexProError {
  readonly facts: Readonly<Record<string, number>>;
  constructor(line: number, lineBytes: number, limit: number) {
    super(`Selected line ${line} is too large (${lineBytes} bytes). Limit: ${limit} bytes.`);
    this.name = "SelectedLineTooLargeError";
    this.facts = { line, lineBytes, limit };
  }
  toJSON(): object {
    return { name: this.name, message: this.message, reason: "selected_line_too_large", facts: this.facts };
  }
}

export interface ScannedLine {
  readonly lineNo: number;
  /** Raw line content without terminator; empty when `giant` (content not retained). */
  readonly text: string;
  /** Exact UTF-8 byte length of the raw line content (terminator excluded). */
  readonly bytes: number;
  readonly giant: boolean;
}

export interface GiantLineRecord {
  readonly lineNo: number;
  readonly bytes: number;
}

export interface PrivateKeySpan {
  readonly start: number;
  readonly end: number;
}

export type TriviaMaskState = "code" | "line-comment" | "block-comment" | "string";

export interface MaskSnapshot {
  /** Decoded-string offset this state is valid for (start of a physical line). */
  readonly offset: number;
  readonly state: TriviaMaskState;
  readonly quote: string;
}

export interface FileIdentity {
  readonly ino: number;
  readonly dev: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

export interface SourceScan {
  readonly bytes: number;
  readonly sha256: string;
  readonly totalLines: number;
  readonly nulFound: boolean;
  /** Captured raw lines for the requested window (giant lines flagged, content withheld). */
  readonly selected: ScannedLine[];
  /** True when selected capture stopped at the byte cap (lines kept counting). */
  readonly selectionCapped: boolean;
  /** Last physical line stored in `selected` (selectStart-1 when none). */
  readonly capturedThroughLine: number;
  /** Every giant line in the source (count bounded by scanLimit / fragCap). */
  readonly giants: GiantLineRecord[];
  /** Full-stream private-key spans (decoded-string offsets; streaming-exact). */
  readonly privateKeySpans: PrivateKeySpan[];
  /**
   * Whole-source credential-paren-nuke trigger offset: -1 when absent,
   * otherwise the first unmatched offset (0 doubles as the conservative
   * overflow signal: treat as triggered at source start).
   */
  readonly nukeOffset: number;
  /** Exact mask state at the first selected line (null when no window was requested). */
  readonly maskAtWindowStart: MaskSnapshot | null;
  /** True when the window starts in plain code (flank-after masking is then exact). */
  readonly windowStartsInCode: boolean;
  readonly race: boolean;
  readonly maxRetainedBytes: number;
}

export interface ScanWindow {
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ScanOptions extends ScanWindow {
  readonly scanLimitBytes?: number;
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
  /** Retained selected-content cap (default SELECT_CAPTURE_CAP_BYTES). Giant entries are exempt. */
  readonly selectMaxBytes?: number;
}

/** Forward trivia-mask state machine mirroring `maskSourceTrivia` (scripts/redaction-policy.mjs). */
export class TriviaMaskStream {
  private state: TriviaMaskState = "code";
  private quote = "";
  snapshot(offset: number): MaskSnapshot {
    return { offset, state: this.state, quote: this.quote };
  }
  restore(snapshot: MaskSnapshot): void {
    this.state = snapshot.state;
    this.quote = snapshot.quote;
  }
  feed(chunk: string): string {
    const out = chunk.split("");
    for (let i = 0; i < chunk.length; i += 1) {
      const current = chunk[i];
      const next = chunk[i + 1] ?? "";
      const blank = (): void => {
        if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
      };
      if (this.state === "line-comment") {
        if (current === "\n" || current === "\r") this.state = "code";
        else blank();
        continue;
      }
      if (this.state === "block-comment") {
        if (current === "*" && next === "/") {
          blank();
          out[i + 1] = out[i + 1] === "\n" || out[i + 1] === "\r" ? out[i + 1] : " ";
          i += 1;
          this.state = "code";
        } else blank();
        continue;
      }
      if (this.state === "string") {
        if (current === "\\") {
          blank();
          if (i + 1 < chunk.length) {
            if (out[i + 1] !== "\n" && out[i + 1] !== "\r") out[i + 1] = " ";
            i += 1;
          }
        } else if (current === this.quote) {
          blank();
          this.state = "code";
          this.quote = "";
        } else blank();
        continue;
      }
      if (current === "/" && next === "/") {
        blank();
        out[i + 1] = " ";
        i += 1;
        this.state = "line-comment";
        continue;
      }
      if (current === "/" && next === "*") {
        blank();
        out[i + 1] = " ";
        i += 1;
        this.state = "block-comment";
        continue;
      }
      if (current === "#") {
        blank();
        this.state = "line-comment";
        continue;
      }
      if (current === "\"" || current === "'" || current === "`") {
        blank();
        this.state = "string";
        this.quote = current;
      }
    }
    return out.join("");
  }
}

const CREDENTIAL_LABEL = "[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}";
const NUKE_CANDIDATE_PATTERN = new RegExp(`\\b${CREDENTIAL_LABEL}\\s*(?::|=)[^\\r\\n]{0,512}\\(`, "gi");

interface NukeCandidate {
  opening: number;
  balance: number;
  min: number;
}

/**
 * Streaming replica of `unmatchedCredentialParenthesisStart`: masked-text
 * candidate detection with per-candidate (balance, min) tracking in absolute
 * offset order. Matched candidates are pruned; at most NUKE_CANDIDATE_CAP are
 * tracked and overflow resolves conservative (trigger at 0).
 */
export class NukeDetectorStream {
  private readonly candidates: NukeCandidate[] = [];
  private overflow = false;
  private readonly cap: number;
  constructor(cap = NUKE_CANDIDATE_CAP) {
    this.cap = cap;
  }
  /** Feed one masked segment with its absolute base offset. Segments must be fed once, in order. */
  feed(maskedSegment: string, baseOffset: number): void {
    const openings: Array<{ at: number; off: number }> = [];
    NUKE_CANDIDATE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NUKE_CANDIDATE_PATTERN.exec(maskedSegment)) !== null) {
      const localOpen = maskedSegment.indexOf("(", match.index);
      if (localOpen >= 0) openings.push({ at: localOpen, off: baseOffset + localOpen });
    }
    openings.sort((a, b) => a.off - b.off);
    let next = 0;
    const openingAt = new Set(openings.map((o) => o.at));
    for (let i = 0; i < maskedSegment.length; i += 1) {
      while (next < openings.length && openings[next].at === i) {
        if (this.candidates.length < this.cap) {
          // The opening paren itself counts first, mirroring the oracle loop.
          this.candidates.push({ opening: openings[next].off, balance: 1, min: 1 });
        } else {
          this.overflow = true;
        }
        next += 1;
      }
      const c = maskedSegment[i];
      if (c !== "(" && c !== ")") continue;
      if (c === "(" && openingAt.has(i)) continue;
      const cursor = baseOffset + i;
      for (const candidate of this.candidates) {
        if (candidate.opening >= cursor) continue;
        candidate.balance += c === "(" ? 1 : -1;
        if (candidate.balance < candidate.min) candidate.min = candidate.balance;
      }
      for (let j = this.candidates.length - 1; j >= 0; j -= 1) {
        if (this.candidates[j].balance === 0) this.candidates.splice(j, 1);
      }
    }
    while (next < openings.length) {
      if (this.candidates.length < this.cap) {
        this.candidates.push({ opening: openings[next].off, balance: 1, min: 1 });
      } else {
        this.overflow = true;
      }
      next += 1;
    }
  }
  /** -1 when no trigger; otherwise the first unmatched offset (0 on overflow). */
  result(): number {
    if (this.overflow) return 0;
    let trigger = -1;
    for (const candidate of this.candidates) {
      if (candidate.min > 0 && (trigger < 0 || candidate.opening < trigger)) trigger = candidate.opening;
    }
    return trigger;
  }
}

export interface StreamChunkSource {
  /** Read the next chunk; null signals EOF. */
  read(): Promise<Buffer | null>;
  /** Release underlying resources (handle close / child kill). */
  close(): Promise<void>;
}

export interface CoreScanOptions extends ScanWindow {
  scanLimitBytes: number;
  chunkBytes: number;
  signal?: AbortSignal;
  /** Retained selected-content cap (default SELECT_CAPTURE_CAP_BYTES). Giant entries are exempt. */
  selectMaxBytes?: number;
}

function normalizeSelectStart(value: number | undefined): number {
  if (value === undefined) return 1;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? Math.max(1, floored) : 1;
}

function normalizeSelectEnd(value: number | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) ? Math.max(1, floored) : Number.MAX_SAFE_INTEGER;
}

/**
 * Source-agnostic streaming scan core. Frames physical lines from a decoded
 * byte stream, computes exact metadata, detects NUL anywhere, captures only
 * the selected raw window, records giant lines without retaining them, and
 * feeds the security observer streams (private-key spans, nuke trigger, mask
 * snapshots) with retention bounded by chunk + fragment state.
 *
 * Observer feeds are line-ordered and exact: every completed line is fed with
 * its terminator before the next line begins, so mask state captured at a
 * line start is precisely the state the accepted whole-string masker holds
 * at the same offset.
 */
export async function scanStream(source: StreamChunkSource, options: CoreScanOptions): Promise<SourceScan> {
  const chunkBytes = Math.max(1024, Math.floor(options.chunkBytes));
  const scanLimit = Math.max(1, Math.floor(options.scanLimitBytes));
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const privateKeyScanner = createPrivateKeyScanner();
  const mask = new TriviaMaskStream();
  const nuke = new NukeDetectorStream();
  const wantSelect = options.startLine !== undefined || options.endLine !== undefined;
  const selectStart = normalizeSelectStart(options.startLine);
  const selectEnd = normalizeSelectEnd(options.endLine);
  const selectMaxBytes = Math.max(4096, Math.floor(options.selectMaxBytes ?? SELECT_CAPTURE_CAP_BYTES));
  let selectedBytes = 0;
  let selectionCapped = false;
  let capturedThroughLine = selectStart - 1;
  let totalBytes = 0;
  let completed = 0;
  let nulFound = false;
  let carry = "";
  let carryBytes = 0;
  let pendingCR = false;
  let giantActive = false;
  let giantBytes = 0;
  const selected: ScannedLine[] = [];
  const giants: GiantLineRecord[] = [];
  let maxRetained = 0;
  const windowSnapshots: { start: MaskSnapshot | null } = { start: null };
  let maskOffset = 0;

  const track = (bytes: number): void => {
    if (bytes > maxRetained) maxRetained = bytes;
  };
  const checkAborted = (): void => {
    if (options.signal?.aborted) throw new SourceScanError("aborted");
  };

  // Nuke-detector segment accounting (decoded-string offsets).
  let maskedFed = 0;
  let maskedPending = "";
  const feedMasked = (masked: string): void => {
    const combined = maskedPending + masked;
    if (combined.length > NUKE_OVERLAP_BYTES) {
      const cut = combined.length - NUKE_OVERLAP_BYTES;
      nuke.feed(combined.slice(0, cut), maskedFed);
      maskedFed += cut;
      maskedPending = combined.slice(cut);
    } else {
      maskedPending = combined;
    }
  };
  // Gated observer feed. Only the chunk containing the window-start line is
  // split per line (to capture the exact mask state at its first byte); every
  // other byte is fed in whole-chunk batches. The stream stays exact either way.
  let snapshotDone = !wantSelect;
  let observeAcc = "";
  const flushObserveAcc = (): void => {
    if (!observeAcc) return;
    privateKeyScanner.push(observeAcc, false);
    feedMasked(mask.feed(observeAcc));
    maskOffset += observeAcc.length;
    observeAcc = "";
  };
  /** Feed one exact source piece (content plus terminator where present). */
  const observe = (piece: string, lineNo: number): void => {
    if (!piece) return;
    if (snapshotDone) {
      observeAcc += piece;
      return;
    }
    flushObserveAcc();
    if (windowSnapshots.start === null && lineNo >= selectStart) {
      windowSnapshots.start = mask.snapshot(maskOffset);
      snapshotDone = true;
      observeAcc += piece;
      return;
    }
    privateKeyScanner.push(piece, false);
    feedMasked(mask.feed(piece));
    maskOffset += piece.length;
  };

  const emit = (line: string, lineBytes: number, giant: boolean): void => {
    completed += 1;
    if (giant) giants.push({ lineNo: completed, bytes: lineBytes });
    if (wantSelect && completed >= selectStart && completed <= selectEnd) {
      if (!giant && selectedBytes + lineBytes > selectMaxBytes) {
        selectionCapped = true; // keep counting; content stays on the source
      } else {
        if (!giant) selectedBytes += lineBytes;
        selected.push({ lineNo: completed, text: giant ? "" : line, bytes: lineBytes, giant });
        capturedThroughLine = completed;
      }
    }
  };

  try {
    for (;;) {
      checkAborted();
      const chunk = await source.read();
      if (chunk === null) break;
      if (chunk.byteLength === 0) continue;
      totalBytes += chunk.byteLength;
      if (totalBytes > scanLimit) throw new SourceScanError("source_scan_limit", { observed: totalBytes, limit: scanLimit });
      hash.update(chunk);
      if (!nulFound && chunk.includes(0)) nulFound = true;
      let text = decoder.write(chunk);
      track(chunk.byteLength + Buffer.byteLength(text, "utf8") + carryBytes + giantBytes + NUKE_OVERLAP_BYTES + 2048 + selectedBytes);
      if (pendingCR) {
        text = `\r${text}`;
        pendingCR = false;
      }
      if (text.endsWith("\r")) {
        text = text.slice(0, -1);
        pendingCR = true;
      }
      if (text.length === 0) continue;
      const parts = text.split("\n");
      if (parts.length === 1) {
        const fragBytes = Buffer.byteLength(parts[0], "utf8");
        if (!giantActive && carryBytes + giantBytes + fragBytes > LINE_FRAG_CAP_BYTES) {
          // Retire the retained carry into the fragment stream before it can grow.
          if (carry) {
            observe(carry, completed + 1);
            giantBytes += carryBytes;
            carry = "";
            carryBytes = 0;
          }
          giantActive = true;
        }
        if (giantActive) {
          observe(parts[0], completed + 1);
          giantBytes += fragBytes;
        } else {
          carry += parts[0];
          carryBytes += fragBytes;
        }
        track(chunk.byteLength + carryBytes + giantBytes + NUKE_OVERLAP_BYTES + 2048 + selectedBytes);
        continue;
      }
      // Head completes the carried fragment and its line (content + terminator fed exactly).
      const headContent = carry + parts[0];
      const headBytes = carryBytes + giantBytes + Buffer.byteLength(parts[0], "utf8");
      const hadCR = parts[0].endsWith("\r");
      const contentBytes = headBytes - (hadCR ? 1 : 0);
      const lineText = giantActive ? "" : headContent.endsWith("\r") ? headContent.slice(0, -1) : headContent;
      observe(`${headContent}\n`, completed + 1);
      emit(lineText, contentBytes, giantActive);
      carry = "";
      carryBytes = 0;
      giantActive = false;
      giantBytes = 0;
      for (let i = 1; i < parts.length - 1; i += 1) {
        const raw = parts[i];
        const stripped = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        const rawBytes = Buffer.byteLength(raw, "utf8");
        if (rawBytes > LINE_FRAG_CAP_BYTES) {
          // A middle giant line arrives whole within one chunk: feed exactly, retain nothing.
          observe(`${raw}\n`, completed + 1);
          emit("", rawBytes - (raw.endsWith("\r") ? 1 : 0), true);
        } else {
          observe(`${raw}\n`, completed + 1);
          emit(stripped, Buffer.byteLength(stripped, "utf8"), false);
        }
      }
      const tail = parts[parts.length - 1];
      const tailBytes = Buffer.byteLength(tail, "utf8");
      if (tailBytes > LINE_FRAG_CAP_BYTES) {
        giantActive = true;
        giantBytes = tailBytes;
        observe(tail, completed + 1);
        carry = "";
        carryBytes = 0;
      } else {
        carry = tail;
        carryBytes = tailBytes;
      }
      flushObserveAcc();
      track(chunk.byteLength + carryBytes + giantBytes + NUKE_OVERLAP_BYTES + 2048 + selectedBytes);
    }
    checkAborted();
    if (pendingCR) {
      if (!giantActive && carryBytes + giantBytes + 1 > LINE_FRAG_CAP_BYTES) {
        if (carry) {
          observe(carry, completed + 1);
          giantBytes += carryBytes;
          carry = "";
          carryBytes = 0;
        }
        giantActive = true;
      }
      if (giantActive) {
        observe("\r", completed + 1);
        giantBytes += 1;
      } else {
        carry += "\r";
        carryBytes += 1;
      }
      pendingCR = false;
    }
    const tail = decoder.end();
    if (tail) {
      const tailBytes = Buffer.byteLength(tail, "utf8");
      if (!giantActive && carryBytes + giantBytes + tailBytes > LINE_FRAG_CAP_BYTES) {
        if (carry) {
          observe(carry, completed + 1);
          giantBytes += carryBytes;
          carry = "";
          carryBytes = 0;
        }
        giantActive = true;
      }
      if (giantActive) {
        observe(tail, completed + 1);
        giantBytes += tailBytes;
      } else {
        carry += tail;
        carryBytes += tailBytes;
      }
    }
    flushObserveAcc();
    privateKeyScanner.push("", true);
    if (maskedPending) {
      nuke.feed(maskedPending, maskedFed);
      maskedFed += maskedPending.length;
      maskedPending = "";
    }
    // Oracle line semantics: always one final (possibly empty) line.
    if (giantActive) {
      emit("", giantBytes, true);
    } else {
      observe(carry, completed + 1);
      emit(carry, carryBytes, false);
    }
    const windowStartSnapshot: MaskSnapshot | null = windowSnapshots.start;
    const digest = hash.digest("hex");
    return {
      bytes: totalBytes,
      sha256: digest,
      totalLines: completed,
      nulFound,
      selected,
      selectionCapped,
      capturedThroughLine,
      giants,
      privateKeySpans: privateKeyScanner.spans().map((span) => ({ start: span.start, end: span.end })),
      nukeOffset: nuke.result(),
      maskAtWindowStart: windowStartSnapshot,
      windowStartsInCode: windowStartSnapshot === null ? true : windowStartSnapshot.state === "code",
      race: false,
      maxRetainedBytes: maxRetained
    };
  } finally {
    await source.close();
  }
}

export function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.ino === right.ino && left.dev === right.dev && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export interface WorkingTreeScanOptions extends ScanOptions {
  absPath: string;
}

/**
 * Working-tree adapter: the caller owns PathGuard; this adapter pins one open
 * handle, scans it, and compares beginning/end file identity so a
 * mutation/replacement/truncation race fails closed instead of mixing text
 * from one version with metadata from another. Any write or unlink of the
 * path during the scan changes ctime (and usually size/mtime), which the
 * pinned handle still observes via fstat.
 */
export async function scanWorkingTreeFile(fsh: typeof fsp, options: WorkingTreeScanOptions): Promise<SourceScan> {
  const scanLimit = Math.max(1, Math.floor(options.scanLimitBytes ?? SOURCE_SCAN_LIMIT_BYTES));
  const chunkBytes = Math.max(1024, Math.floor(options.chunkBytes ?? SCAN_CHUNK_BYTES));
  const handle = await fsh.open(options.absPath, "r");
  let pre: FileIdentity;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SourceScanError("not-a-file");
    if (stat.size > scanLimit) {
      await handle.close().catch(() => undefined);
      throw new SourceScanError("source_scan_limit", { observed: stat.size, limit: scanLimit });
    }
    pre = { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) {
    if (!(error instanceof SourceScanError)) await handle.close().catch(() => undefined);
    throw error;
  }
  let post: FileIdentity | undefined;
  const fileSource: StreamChunkSource = {
    read: async () => {
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) return null;
      return buffer.subarray(0, bytesRead);
    },
    close: async () => {
      try {
        const stat = await handle.stat();
        post = { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      } catch {
        post = undefined;
      }
      await handle.close().catch(() => undefined);
    }
  };
  const scanned = await scanStream(fileSource, {
    startLine: options.startLine,
    endLine: options.endLine,
    scanLimitBytes: scanLimit,
    chunkBytes,
    signal: options.signal,
    selectMaxBytes: options.selectMaxBytes
  });
  if (post === undefined || !identitiesEqual(pre, post)) throw new SourceScanError("race");
  return { ...scanned, race: false };
}

export interface FramedWindow {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly returnedBytes: number;
  readonly budgetTruncated: boolean;
  readonly nextStartLine?: number;
}

function withLineNumbers(lines: string[], startLine: number, width?: number): string {
  const digits = width ?? String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(digits, " ")} | ${line}`).join("\n");
}

/**
 * Frame captured lines into a complete-line page under the raw numbered-window
 * budget. `display` supplies visible text while `budget` supplies the raw
 * numbered bytes (redaction may expand/contract visible text without changing
 * the range admission/budget representation). Both arrays cover the same
 * physical lines in order; giant entries stop the page (content withheld).
 * Never returns a partial physical line or splits a UTF-8 code point: lines
 * are complete decoded strings by construction.
 */
export function frameRawWindow(
  display: ScannedLine[],
  budget: ScannedLine[],
  meta: {
    startLine: number; endLine: number; totalLines: number; bytes: number; sha256: string; maxBytes: number;
    /** Set when selected capture stopped at the byte cap before the requested end. */
    capped?: boolean; capturedThroughLine?: number;
  }
): FramedWindow {
  const { startLine, endLine, totalLines, bytes, sha256, maxBytes, capped, capturedThroughLine } = meta;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CodexProError("max_bytes must be a positive integer.");
  }
  if (endLine < startLine) {
    throw new CodexProError(`end_line (${endLine}) must be >= start_line (${startLine}).`);
  }
  if (display.length === 0 || budget.length === 0 || display.length !== budget.length) {
    throw new CodexProError("Window framing requires aligned display and budget lines.");
  }
  // Numbering width derives from the requested (clamped) end line so pages of
  // one request share stable columns; full windows match the accepted oracle.
  const width = String(endLine).length;
  const numberedBytes: number[] = budget.map((line) => {
    const prefix = `${String(line.lineNo).padStart(width, " ")} | `;
    return Buffer.byteLength(prefix, "utf8") + line.bytes;
  });
  let used = 0;
  let count = 0;
  for (let i = 0; i < budget.length; i += 1) {
    if (budget[i].giant && i > 0) break; // page around withheld giant content
    const add = numberedBytes[i] + (i > 0 ? 1 : 0);
    if (used + add > maxBytes) break;
    used += add;
    count += 1;
    if (budget[i].giant) break; // first line giant still counts below, then throws
  }
  if (count === 0 || budget[0].giant) {
    const first = budget[0];
    throw new SelectedLineTooLargeError(first.lineNo, numberedBytes[0], maxBytes);
  }
  const returned = display.slice(0, count);
  const text = withLineNumbers(returned.map((line) => line.text), startLine, width);
  const returnedEnd = startLine + count - 1;
  const captureCutShort = capped === true && (capturedThroughLine ?? endLine) < endLine;
  const budgetTruncated = count < budget.length || captureCutShort;
  const windowExhausted = returnedEnd >= endLine && !captureCutShort;
  return {
    text,
    startLine,
    endLine: returnedEnd,
    totalLines,
    bytes,
    sha256,
    truncated: startLine > 1 || returnedEnd < totalLines,
    returnedBytes: Buffer.byteLength(text, "utf8"),
    budgetTruncated,
    ...(!windowExhausted || budgetTruncated ? { nextStartLine: returnedEnd + 1 } : {})
  };
}

// ---------------------------------------------------------------------------
// Secure bounded projection (TASK-003).
//
// The large-source projector replicates the accepted whole-source redaction
// decisions with bounded retained memory:
//
// - private-key blocks: exact full-stream spans from the scan phase, mapped
//   per line exactly as the accepted line-preserving stage maps them;
// - credential-paren nukes: exact trigger offset from the scan phase;
// - credential/token/direct patterns: the accepted redactor over the window
//   plus bounded flanks, with the path-derived Python hint dropped (identical
//   to the accepted over-limit provenance behavior: no fidelity exceptions),
//   plus conservative force-redact rules for slice-edge uncertainty;
// - physical line correspondence is always preserved.
// ---------------------------------------------------------------------------

export const PRIVATE_KEY_MARKER = "[REDACTED_PRIVATE_KEY]";
export const REDACTED_SECRET_MARKER = "[REDACTED_SECRET]";

/** Over-approximate credential-label test for conservative force rules (safe direction). */
const FORCE_LABEL_PATTERN = /[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]*/i;
const FORCE_SHAPE_PATTERN = /=|:/;

/**
 * Map full-stream private-key spans onto window lines, replicating the
 * accepted `replacePrivateSpansWithLineMarkers` line mapping restricted to
 * the given lines. `lineStarts[i]` is the decoded-string offset of
 * `lines[i]`; `windowEnd` is the offset just past the last line's content.
 */
export function applyPrivateKeySpansToLines(
  lines: string[],
  lineStarts: number[],
  spans: PrivateKeySpan[],
  marker: string = PRIVATE_KEY_MARKER
): string[] {
  if (spans.length === 0) return [...lines];
  const out: string[] = [];
  let spanIndex = 0;
  for (let li = 0; li < lines.length; li += 1) {
    const lineStart = lineStarts[li];
    const line = lines[li];
    const lineEnd = lineStart + line.length;
    while (spanIndex < spans.length && spans[spanIndex].end <= lineStart) spanIndex += 1;
    let cursor = lineStart;
    let current = spanIndex;
    let transformed = "";
    while (current < spans.length) {
      const span = spans[current];
      if (span.start >= lineEnd) break;
      if (span.end <= lineStart) {
        current += 1;
        continue;
      }
      const start = Math.max(lineStart, span.start);
      const end = Math.min(lineEnd, span.end);
      if (start > cursor) transformed += line.slice(cursor - lineStart, start - lineStart);
      transformed += marker;
      cursor = Math.max(cursor, end);
      if (span.end <= lineEnd) current += 1;
      else break;
    }
    transformed += line.slice(cursor - lineStart);
    out.push(transformed);
    spanIndex = current;
  }
  return out;
}

/**
 * Replicate the accepted malformed-credential-paren nuke for a window:
 * content at/after the trigger offset becomes the marker plus preserved
 * newlines. Returns the mapped lines and whether the trigger touched them.
 */
export function applyNukeOffsetToLines(
  lines: string[],
  lineStarts: number[],
  trigger: number,
  marker: string = REDACTED_SECRET_MARKER
): { lines: string[]; applied: boolean } {
  if (trigger < 0) return { lines: [...lines], applied: false };
  let applied = false;
  const out = lines.map((line, li) => {
    const lineStart = lineStarts[li];
    const lineEnd = lineStart + line.length;
    if (lineEnd <= trigger) return line;
    applied = true;
    if (lineStart >= trigger) return "";
    return `${line.slice(0, trigger - lineStart)}${marker}`;
  });
  return { lines: out, applied };
}

export interface LargeWindowProjectionRequest {
  readonly scan: SourceScan;
  /** Raw window line contents in order (giant entries carry text "" and are never rendered). */
  readonly rawLines: string[];
  /** Decoded-string offset of the first window byte. */
  readonly windowStartOffset: number;
  /** Source text immediately before the window (line-boundary trimmed by the caller). */
  readonly flankBefore: string;
  /** Source text immediately after the window. */
  readonly flankAfter: string;
  /**
   * True when trimming flankBefore to a line boundary dropped a partial line
   * containing a credential label (a multi-line match may bridge into the window).
   */
  readonly bridgeSuspect: boolean;
}

export interface LargeWindowProjection {
  /** One redacted line per raw window line; physical correspondence preserved. */
  readonly lines: string[];
  /** Per-line flag: redaction policy actually changed the line. */
  readonly redacted: boolean[];
  readonly nukeApplied: boolean;
  readonly forcedLines: number[];
}

function forceRedactLine(): string {
  return REDACTED_SECRET_MARKER;
}

/** Back-scan for a statement boundary; true when the scan reaches the slice start. */
function anchorReachesSliceStart(maskedSlice: string, fromOffset: number): boolean {
  for (let i = fromOffset - 1; i >= 0; i -= 1) {
    const c = maskedSlice[i];
    if (c === ";" || c === "{" || c === "}") return false;
  }
  return true;
}

/**
 * Project one bounded window with whole-source-aware security.
 *
 * `redactSlice` is the accepted line-preserving redactor applied to the
 * flanked slice WITHOUT a path-derived language hint (dependency-injected so
 * this module stays decoupled from the redaction framework; production passes
 * `redactSensitiveTextPreservingLines` with `{ context: "source" }`).
 */
export function projectLargeWindow(
  request: LargeWindowProjectionRequest,
  redactSlice: (slice: string) => string
): LargeWindowProjection {
  const { scan, rawLines, windowStartOffset, flankBefore, flankAfter, bridgeSuspect } = request;
  const lineStarts: number[] = [];
  {
    let cursor = windowStartOffset;
    for (const line of rawLines) {
      lineStarts.push(cursor);
      cursor += line.length + 1; // +1 for the terminator (offsets are advisory past content)
    }
  }
  // Stage 1: exact private-key mapping from full-stream spans.
  const keyMapped = applyPrivateKeySpansToLines(rawLines, lineStarts, scan.privateKeySpans);
  // Stage 2: credential/direct patterns over the flanked slice.
  const slice = `${flankBefore}${keyMapped.join("\n")}${flankAfter}`;
  const sliceWindowBase = flankBefore.length;
  const redactedSlice = redactSlice(slice);
  const sliceLines = redactedSlice.split("\n");
  const baseLine = flankBefore.length === 0 ? 0 : flankBefore.split("\n").length - 1;
  if (flankBefore.length > 0 && !flankBefore.endsWith("\n")) {
    throw new CodexProError("flankBefore must end at a line boundary.");
  }
  let windowLines = sliceLines.slice(baseLine, baseLine + rawLines.length);
  if (windowLines.length !== rawLines.length) {
    throw new CodexProError("Projection broke physical line correspondence.");
  }
  // Stage 3: replicated paren nuke from the scan-phase trigger.
  const nuke = applyNukeOffsetToLines(windowLines, lineStarts, scan.nukeOffset);
  windowLines = nuke.lines;
  // Stage 4: conservative force rules for slice-edge uncertainty.
  const forcedLines: number[] = [];
  const maskedSlice = new TriviaMaskStream().feed(slice);
  const forceLine = (index: number): void => {
    windowLines[index] = forceRedactLine();
    if (!forcedLines.includes(index)) forcedLines.push(index);
  };
  rawLines.forEach((raw, index) => {
    if (raw.length === 0) return;
    if (!FORCE_LABEL_PATTERN.test(raw) || !FORCE_SHAPE_PATTERN.test(raw)) return;
    // Offsets track the key-mapped slice (private-key markers change lengths).
    const lineStartInSlice = sliceWindowBase + keyMapped.slice(0, index).join("\n").length + (index > 0 ? 1 : 0);
    if (anchorReachesSliceStart(maskedSlice, lineStartInSlice)) {
      forceLine(index); // R3: statement context extends beyond the slice start
      return;
    }
    if (bridgeSuspect && index === 0) {
      forceLine(index); // R4: a trimmed partial line may bridge a match into the window
    }
  });
  if (bridgeSuspect && rawLines.length > 0 && !forcedLines.includes(0)) {
    const firstRaw = rawLines[0];
    if (firstRaw.length > 0 && (FORCE_LABEL_PATTERN.test(firstRaw) || FORCE_SHAPE_PATTERN.test(firstRaw))) {
      forceLine(0);
    }
  }
  const redacted = windowLines.map((line, index) => line !== rawLines[index]);
  return { lines: windowLines, redacted, nukeApplied: nuke.applied, forcedLines };
}

/**
 * Trim a flank-before chunk to the first line boundary. Returns the trimmed
 * flank plus whether a dropped partial line looked credential-suspect.
 */
export function trimFlankBefore(chunk: string): { flank: string; bridgeSuspect: boolean } {
  if (chunk.length === 0) return { flank: "", bridgeSuspect: false };
  const newline = chunk.indexOf("\n");
  if (newline < 0) {
    return {
      flank: "",
      bridgeSuspect: FORCE_LABEL_PATTERN.test(chunk) && FORCE_SHAPE_PATTERN.test(chunk)
    };
  }
  const dropped = chunk.slice(0, newline);
  return {
    flank: chunk.slice(newline + 1),
    bridgeSuspect: FORCE_LABEL_PATTERN.test(dropped) && FORCE_SHAPE_PATTERN.test(dropped)
  };
}

/**
 * Resolve a caller line request against an exact total line count, mirroring
 * the accepted `readFileWindow` clamping (1-based, inclusive).
 */
export function resolveWindow(request: ScanWindow, totalLines: number): { startLine: number; endLine: number } {
  const startLine = Math.max(1, Math.floor(request.startLine ?? 1));
  const endLine = Math.min(totalLines, Math.floor(request.endLine ?? totalLines));
  if (endLine < startLine) {
    throw new CodexProError(`end_line (${endLine}) must be >= start_line (${startLine}).`);
  }
  return { startLine, endLine };
}
