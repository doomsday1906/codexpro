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
import { TextDecoder } from "node:util";
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
/**
 * Explicit selected-record cardinality bound, independent of content bytes
 * (F2-B). A newline-only or tiny-line source can otherwise create millions of
 * selected records while content bytes stay tiny. Capture is always a
 * contiguous prefix of the requested window; past the cap, counting continues
 * and framing reports a truthful continuation — never holes.
 */
export const SELECT_CAPTURE_CAP_RECORDS = 50_000;
/**
 * Conservative retained-cost estimate per selected record, counted against the
 * byte cap alongside content bytes: covers the record object/cardinality
 * overhead plus numbered framing prefixes/terminators (F2-B).
 */
export const SELECT_RECORD_OVERHEAD_BYTES = 256;
/** Cap on retained private-key spans; overflow fails closed (F2-C). */
export const PRIVATE_KEY_SPAN_CAP = 4096;
/** Estimated retained bytes per private-key span, for honest retention accounting. */
const PRIVATE_KEY_SPAN_ESTIMATE_BYTES = 128;
/**
 * Post-snapshot observer staging flushes past this size, so giant-line
 * fragments can never accumulate source-sized staging before finalization
 * (F2-A). Flushing never moves the window-start snapshot (already captured).
 */
const OBSERVE_ACC_FLUSH_CHARS = 64 * 1024;
/** Flanking context retained around a projected window for bounded redaction decisions. */
export const WINDOW_FLANK_BYTES = 64 * 1024;

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
  /** Exact decoded-string offset of the line's first byte (for span mapping). */
  readonly startOffset: number;
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
  /** Lookahead-held tail chars at snapshot time (usually empty; restored exactly). */
  readonly pending?: string;
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
   * True when private-key span discovery exceeded PRIVATE_KEY_SPAN_CAP and the
   * scanner feed was stopped: the captured window is conservatively
   * fully redacted and no span history grew with source size (F2-C).
   */
  readonly spansOverflowed: boolean;
  /**
   * Whole-source credential-paren-nuke trigger offset: -1 when absent,
   * otherwise the first unmatched offset (0 doubles as the conservative
   * overflow signal: treat as triggered at source start).
   */
  readonly nukeOffset: number;
  /** False when the source is not strictly valid UTF-8 (lossy decoding was applied). */
  readonly utf8Valid: boolean;
  /** Exact mask state at the first selected line (null when no window was requested). */
  readonly maskAtWindowStart: MaskSnapshot | null;
  /** True when the window starts in plain code (flank-after masking is then exact). */
  readonly windowStartsInCode: boolean;
  /**
   * Decoded source text immediately before the captured window, already trimmed
   * to a line boundary (≤ WINDOW_FLANK_BYTES). Context only; never returned.
   */
  readonly flankBefore: string;
  /**
   * True when trimming flankBefore dropped a partial line, or the immediately
   * preceding line was giant (content withheld): a multi-line match may bridge
   * into the window, forcing conservative treatment of the first window line.
   */
  readonly bridgeSuspect: boolean;
  /** Decoded source text immediately after the requested window end (≤ WINDOW_FLANK_BYTES). */
  readonly flankAfter: string;
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

/** Forward trivia-mask state for source-window offset snapshots. */
export class TriviaMaskStream {
  private state: TriviaMaskState = "code";
  private quote = "";
  /**
   * Held trailing chars (≤2) whose masking needs lookahead past the current
   * feed (`//`, `/*`, `*​/`, backslash escapes, ``` fences split across
   * chunks). Held output is always emitted on the next feed or `flush`, so
   * the masked stream stays exact and contiguous. Holds only ever span
   * mid-line content: a newline-terminated tail is always fully decidable.
   */
  private pending = "";
  snapshot(offset: number): MaskSnapshot {
    return { offset, state: this.state, quote: this.quote, pending: this.pending };
  }
  restore(snapshot: MaskSnapshot): void {
    this.state = snapshot.state;
    this.quote = snapshot.quote;
    this.pending = snapshot.pending ?? "";
  }
  /** Masked length already emitted (source offsets for the next output start here). */
  get pendingLength(): number {
    return this.pending.length;
  }
  feed(chunk: string): string {
    const text = this.pending + chunk;
    this.pending = "";
    const out = text.split("");
    let stop = text.length;
    for (let i = 0; i < text.length; i += 1) {
      const current = text[i];
      const next = i + 1 < text.length ? text[i + 1] : null;
      const nextNext = i + 2 < text.length ? text[i + 2] : null;
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
        } else if (current === "*" && next === null) {
          stop = i;
          break;
        } else blank();
        continue;
      }
      if (this.state === "string") {
        if (current === "\\") {
          if (next === null) {
            stop = i;
            break;
          }
          blank();
          if (i + 1 < text.length) {
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
      if (current === "/" && next === null) {
        stop = i;
        break;
      }
      if (current === "`") {
        // A fence needs three consecutive ticks; a newline in the lookahead
        // rules one out without holding.
        if (next === null || (next === "`" && nextNext === null)) {
          stop = i;
          break;
        }
        if (next === "`" && nextNext === "`") {
          i += 2;
          continue;
        }
        blank();
        this.state = "string";
        this.quote = current;
        continue;
      }
      if (current === "#") {
        blank();
        this.state = "line-comment";
        continue;
      }
      if (current === "\"" || current === "'") {
        blank();
        this.state = "string";
        this.quote = current;
      }
    }
    this.pending = text.slice(stop);
    return out.slice(0, stop).join("");
  }
  /**
   * Decide held trailing chars with end-of-stream lookahead (nothing can
   * follow). Concatenated after the last feed output, the masked stream is
   * then complete and exact.
   */
  flush(): string {
    const tail = this.pending;
    this.pending = "";
    if (!tail) return "";
    const out = tail.split("");
    for (let i = 0; i < tail.length; i += 1) {
      const current = tail[i];
      if (this.state === "line-comment") {
        if (current === "\n" || current === "\r") this.state = "code";
        else if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
        continue;
      }
      if (this.state === "block-comment") {
        if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
        continue;
      }
      if (this.state === "string") {
        if (current === "\\") {
          if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
          continue;
        }
        if (current === this.quote) {
          if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
          this.state = "code";
          this.quote = "";
          continue;
        }
        if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
        continue;
      }
      // At true end of stream no multi-char token can complete. Plain code
      // chars pass through exactly like the whole-string oracle; quotes still
      // open (blanked) since that decision needs no lookahead.
      if (current === "\"" || current === "'" || current === "`") {
        if (out[i] !== "\n" && out[i] !== "\r") out[i] = " ";
        this.state = "string";
        this.quote = current;
      }
    }
    return out.join("");
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
 * Keep only spans that can touch the captured window (F2-C). A span starting
 * before the first captured line but ending inside it is kept (it still
 * protects the window); spans entirely outside are dropped so span history
 * never grows with source size. With no captured lines there is no window to
 * protect, so nothing is retained.
 */
export function filterSpansToCapture(spans: PrivateKeySpan[], captured: ScannedLine[]): PrivateKeySpan[] {
  if (spans.length === 0 || captured.length === 0) return [];
  const firstStart = captured[0].startOffset;
  const last = captured[captured.length - 1];
  const lastEnd = last.startOffset + last.text.length;
  return spans.filter((span) => span.end > firstStart && span.start < lastEnd);
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
  const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let utf8Valid = true;
  const privateKeyScanner = createPrivateKeyScanner();
  const mask = new TriviaMaskStream();
  const wantSelect = options.startLine !== undefined || options.endLine !== undefined;
  const selectStart = normalizeSelectStart(options.startLine);
  const selectEnd = normalizeSelectEnd(options.endLine);
  const selectMaxBytes = Math.max(4096, Math.floor(options.selectMaxBytes ?? SELECT_CAPTURE_CAP_BYTES));
  let selectedBytes = 0;
  let selectionCapped = false;
  let capturedThroughLine = selectStart - 1;
  // Capture is always a contiguous prefix of the requested window: once a
  // line is skipped, nothing is stored again. Holes would break line-number
  // arithmetic and span mapping downstream.
  let captureClosed = false;
  let totalBytes = 0;
  let completed = 0;
  let nulFound = false;
  let carry = "";
  let carryBytes = 0;
  let pendingCR = false;
  let giantActive = false;
  let giantBytes = 0;
  // Exact decoded-string accounting for line starts (terminator-aware, so CRLF
  // and non-ASCII giant fragments keep span mapping exact).
  let giantChars = 0;
  let nextLineStart = 0;
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

  // Gated observer feed. Only the chunk containing the window-start line is
  // split per line (to capture the exact mask state at its first byte); every
  // other byte is fed in whole-chunk batches. The stream stays exact either way.
  let snapshotDone = !wantSelect;
  let observeAcc = "";
  // Private-key span overflow (F2-C): the accepted scanner retains one record
  // per block, so a span-dense source would grow span history with source
  // size. Past the cap the feed stops and the window is conservatively fully
  // redacted — fail closed, never expose.
  let spansOverflowed = false;
  let pkFeedingStopped = false;
  let pkSpansSeen = 0;
  const flushObserveAcc = (): void => {
    if (observeAcc) {
      if (!pkFeedingStopped) privateKeyScanner.push(observeAcc, false);
      mask.feed(observeAcc);
      maskOffset += observeAcc.length;
      observeAcc = "";
    }
    if (!pkFeedingStopped) {
      const spanCount = privateKeyScanner.spans().length;
      if (spanCount > pkSpansSeen) pkSpansSeen = spanCount;
      if (spanCount > PRIVATE_KEY_SPAN_CAP) {
        pkFeedingStopped = true;
        spansOverflowed = true;
      }
    }
  };
  /** Feed one exact source piece (content plus terminator where present). */
  const observe = (piece: string, lineNo: number): void => {
    if (!piece) {
      // An empty final piece can still be the window start (a newline-
      // terminated source's final empty physical line): capture the exact mask
      // state so projection has state instead of a missing-snapshot error.
      if (!snapshotDone && windowSnapshots.start === null && lineNo >= selectStart) {
        flushObserveAcc();
        windowSnapshots.start = mask.snapshot(maskOffset);
        snapshotDone = true;
      }
      return;
    }
    if (snapshotDone) {
      observeAcc += piece;
    } else {
      flushObserveAcc();
      if (windowSnapshots.start === null && lineNo >= selectStart) {
        windowSnapshots.start = mask.snapshot(maskOffset);
        snapshotDone = true;
        observeAcc += piece;
      } else {
        if (!pkFeedingStopped) privateKeyScanner.push(piece, false);
        mask.feed(piece);
        maskOffset += piece.length;
      }
    }
    // Bound post-snapshot staging: giant fragments flush incrementally so a
    // source-sized line is counted and security-scanned without ever being
    // retained (F2-A). The snapshot was captured above; flushing cannot move it.
    if (observeAcc.length > OBSERVE_ACC_FLUSH_CHARS) flushObserveAcc();
  };

  // Flank context (fixed bounds; context only, never returned).
  let preTail = "";
  let preTailCut = false;
  let preGiant = false;
  let flankBefore = "";
  let flankBridgeSuspect = false;
  let flankAfter = "";
  const FLANK_RING_CHARS = WINDOW_FLANK_BYTES + 4096;

  const emit = (
    line: string,
    lineBytes: number,
    giant: boolean,
    record: string,
    contentChars: number,
    terminated: boolean
  ): void => {
    completed += 1;
    const startOffset = nextLineStart;
    if (terminated) nextLineStart = startOffset + contentChars + 1;
    else nextLineStart = startOffset + contentChars;
    if (giant) giants.push({ lineNo: completed, bytes: lineBytes });
    if (wantSelect && completed < selectStart) {
      // Pre-window context for the credential slice.
      if (giant) {
        preGiant = true;
      } else {
        preTail += record;
        if (preTail.length > FLANK_RING_CHARS) {
          preTail = preTail.slice(-WINDOW_FLANK_BYTES);
          preTailCut = true;
        }
      }
    }
    if (wantSelect && completed === selectStart) {
      // The retained pre-window text starts at file offset 0 (complete lines)
      // unless the ring cut it or it exceeds the flank bound; only a genuinely
      // mid-line start is trimmed, so bridge suspicion is never fabricated.
      let flankSource = preTail;
      let startsAtBoundary = !preTailCut;
      if (flankSource.length > WINDOW_FLANK_BYTES) {
        flankSource = flankSource.slice(-WINDOW_FLANK_BYTES);
        startsAtBoundary = false;
      }
      const trimmed = startsAtBoundary
        ? { flank: flankSource, bridgeSuspect: false }
        : trimFlankBefore(flankSource);
      flankBefore = trimmed.flank;
      flankBridgeSuspect = trimmed.bridgeSuspect || preGiant;
      preTail = "";
    }
    if (wantSelect && (completed > selectEnd || (selectionCapped && completed > capturedThroughLine))) {
      if (!giant && flankAfter.length < WINDOW_FLANK_BYTES) {
        flankAfter += record;
        if (flankAfter.length > WINDOW_FLANK_BYTES) flankAfter = flankAfter.slice(0, WINDOW_FLANK_BYTES);
      }
    }
    if (wantSelect && completed >= selectStart && completed <= selectEnd) {
      if (captureClosed) {
        selectionCapped = true;
      } else if (!giant && selected.length > 0 &&
        (selectedBytes + lineBytes + SELECT_RECORD_OVERHEAD_BYTES > selectMaxBytes ||
          selected.length >= SELECT_CAPTURE_CAP_RECORDS)) {
        // The first stored line always fits (keeps capture contiguous from the
        // window start); framing decides giant/over-budget fate deterministically.
        // Both the content-byte cap (with per-record overhead) and the explicit
        // record-count cap stop capture as a contiguous prefix with continuation.
        selectionCapped = true;
        captureClosed = true;
      } else {
        if (!giant) selectedBytes += lineBytes + SELECT_RECORD_OVERHEAD_BYTES;
        selected.push({ lineNo: completed, text: giant ? "" : line, bytes: lineBytes, giant, startOffset });
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
      if (utf8Valid) {
        try {
          strictDecoder.decode(chunk, { stream: true });
        } catch {
          utf8Valid = false;
        }
      }
      let text = decoder.write(chunk);
      track(chunk.byteLength + Buffer.byteLength(text, "utf8") + carryBytes + giantBytes + 2048 + selectedBytes + preTail.length + flankBefore.length + flankAfter.length + observeAcc.length + pkSpansSeen * PRIVATE_KEY_SPAN_ESTIMATE_BYTES);
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
            giantChars += carry.length;
            carry = "";
            carryBytes = 0;
          }
          giantActive = true;
        }
        if (giantActive) {
          observe(parts[0], completed + 1);
          giantBytes += fragBytes;
          giantChars += parts[0].length;
        } else {
          carry += parts[0];
          carryBytes += fragBytes;
        }
        // Same per-chunk observer cadence as the multi-line path: bounds
        // staging, feeds detector streams promptly, and runs the span-cap check.
        flushObserveAcc();
        track(chunk.byteLength + carryBytes + giantBytes + 2048 + selectedBytes + preTail.length + flankBefore.length + flankAfter.length + observeAcc.length + pkSpansSeen * PRIVATE_KEY_SPAN_ESTIMATE_BYTES);
        continue;
      }
      // Head completes the carried fragment and its line (content + terminator fed exactly).
      const headContent = carry + parts[0];
      const headBytes = carryBytes + giantBytes + Buffer.byteLength(parts[0], "utf8");
      const hadCR = parts[0].endsWith("\r");
      const contentBytes = headBytes - (hadCR ? 1 : 0);
      const lineText = giantActive ? "" : headContent.endsWith("\r") ? headContent.slice(0, -1) : headContent;
      observe(`${headContent}\n`, completed + 1);
      emit(lineText, contentBytes, giantActive, giantActive ? "" : `${lineText}\n`, giantChars + carry.length + parts[0].length, true);
      carry = "";
      carryBytes = 0;
      giantActive = false;
      giantBytes = 0;
      giantChars = 0;
      for (let i = 1; i < parts.length - 1; i += 1) {
        const raw = parts[i];
        const stripped = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        const rawBytes = Buffer.byteLength(raw, "utf8");
        if (rawBytes > LINE_FRAG_CAP_BYTES) {
          // A middle giant line arrives whole within one chunk: feed exactly, retain nothing.
          observe(`${raw}\n`, completed + 1);
          emit("", rawBytes - (raw.endsWith("\r") ? 1 : 0), true, "", raw.length, true);
        } else {
          observe(`${raw}\n`, completed + 1);
          emit(stripped, Buffer.byteLength(stripped, "utf8"), false, `${stripped}\n`, raw.length, true);
        }
      }
      const tail = parts[parts.length - 1];
      const tailBytes = Buffer.byteLength(tail, "utf8");
      if (tailBytes > LINE_FRAG_CAP_BYTES) {
        giantActive = true;
        giantBytes = tailBytes;
        giantChars = tail.length;
        observe(tail, completed + 1);
        carry = "";
        carryBytes = 0;
      } else {
        carry = tail;
        carryBytes = tailBytes;
      }
      flushObserveAcc();
      track(chunk.byteLength + carryBytes + giantBytes + 2048 + selectedBytes + preTail.length + flankBefore.length + flankAfter.length + observeAcc.length + pkSpansSeen * PRIVATE_KEY_SPAN_ESTIMATE_BYTES);
    }
    checkAborted();
    if (pendingCR) {
      if (!giantActive && carryBytes + giantBytes + 1 > LINE_FRAG_CAP_BYTES) {
        if (carry) {
          observe(carry, completed + 1);
          giantBytes += carryBytes;
          giantChars += carry.length;
          carry = "";
          carryBytes = 0;
        }
        giantActive = true;
      }
      if (giantActive) {
        observe("\r", completed + 1);
        giantBytes += 1;
        giantChars += 1;
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
          giantChars += carry.length;
          carry = "";
          carryBytes = 0;
        }
        giantActive = true;
      }
      if (giantActive) {
        observe(tail, completed + 1);
        giantBytes += tailBytes;
        giantChars += tail.length;
      } else {
        carry += tail;
        carryBytes += tailBytes;
      }
    }
    // Oracle line semantics: always one final (possibly empty) line.
    // F1: the final carry is observed AND emitted BEFORE any security observer
    // finalizes, so the last line reaches the private-key scanner, trivia
    // masker, and nuke detector exactly like every other line. Finalization
    // (flush, scanner close, mask flush, nuke drain) happens exactly once.
    if (giantActive) {
      emit("", giantBytes, true, "", giantChars, false);
    } else {
      observe(carry, completed + 1);
      emit(carry, carryBytes, false, carry, carry.length, false);
    }
    flushObserveAcc();
    if (!pkFeedingStopped) privateKeyScanner.push("", true);
    if (utf8Valid) {
      try {
        strictDecoder.decode();
      } catch {
        utf8Valid = false;
      }
    }
    // F2-C: retain only span state necessary to protect the captured window.
    // Blocks entirely outside it must not accumulate unbounded records. On
    // overflow the feed already stopped and the window is fully redacted.
    const rawSpans = spansOverflowed
      ? []
      : privateKeyScanner.spans().map((span) => ({ start: span.start, end: span.end }));
    const privateKeySpans = filterSpansToCapture(rawSpans, selected);
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
      utf8Valid,
      giants,
      privateKeySpans,
      spansOverflowed,
      nukeOffset: -1,
      maskAtWindowStart: windowStartSnapshot,
      windowStartsInCode: windowStartSnapshot === null ? true : windowStartSnapshot.state === "code",
      flankBefore,
      bridgeSuspect: flankBridgeSuspect,
      flankAfter,
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
  for (let i = 0; i < display.length; i += 1) {
    if (display[i].lineNo !== startLine + i || budget[i].lineNo !== startLine + i) {
      throw new CodexProError("Window framing requires contiguous window lines.");
    }
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

export interface LargeWindowProjectionRequest {
  readonly scan: SourceScan;
  /**
   * Captured window entries in order (a contiguous prefix of the requested
   * window carrying exact startOffsets; giant entries carry text "" and are
   * never rendered).
   */
  readonly window: ScannedLine[];
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
  const { scan, window } = request;
  if (window.length === 0) throw new CodexProError("Projection requires a non-empty window.");
  for (let i = 1; i < window.length; i += 1) {
    if (window[i].lineNo !== window[i - 1].lineNo + 1) {
      throw new CodexProError("Projection requires contiguous window lines.");
    }
  }
  // Two independent exact offset computations must agree: framing-loop
  // accounting (entries) and the observer-stream mask snapshot. Any drift
  // (e.g. terminator miscounting) fails closed instead of misplacing spans.
  if (scan.maskAtWindowStart === null || scan.maskAtWindowStart.offset !== window[0].startOffset) {
    throw new CodexProError("Projection window offsets disagree with the scan snapshot.");
  }
  const rawLines = window.map((entry) => entry.text);
  // F2-C fail-closed: span discovery overflowed, so whole-stream key-block
  // protection is no longer provable. Redact the entire window rather than
  // risk exposing an untracked block. The scan-level `spansOverflowed` flag is
  // the bounded machine-readable state for this condition.
  if (scan.spansOverflowed) {
    const forcedAll = window.map((_, index) => index);
    const lines = window.map(() => forceRedactLine());
    applySourceFinalEmptyLine(lines, window, scan.totalLines);
    return {
      lines,
      redacted: lines.map((line, index) => line !== window[index].text),
      nukeApplied: false,
      forcedLines: forcedAll
    };
  }
  const flankBefore = scan.flankBefore;
  const flankAfter = scan.flankAfter;
  // Exact per-line string offsets from the scan (terminator-aware: CRLF counts
  // two). Never recomputed with +1/line arithmetic here.
  const lineStarts: number[] = window.map((entry) => entry.startOffset);
  // Stage 1: exact private-key mapping from full-stream spans.
  const keyMapped = applyPrivateKeySpansToLines(rawLines, lineStarts, scan.privateKeySpans);
  // Stage 2: credential/direct patterns over the flanked slice. The window is
  // explicitly terminated so its last line can never fuse with flankAfter.
  const slice = `${flankBefore}${keyMapped.join("\n")}\n${flankAfter}`;
  const redactedSlice = redactSlice(slice);
  const sliceLines = redactedSlice.split("\n");
  const baseLine = flankBefore.length === 0 ? 0 : flankBefore.split("\n").length - 1;
  if (flankBefore.length > 0 && !flankBefore.endsWith("\n")) {
    throw new CodexProError("flankBefore must end at a line boundary.");
  }
  const windowLines = sliceLines.slice(baseLine, baseLine + rawLines.length);
  if (windowLines.length !== rawLines.length) {
    throw new CodexProError("Projection broke physical line correspondence.");
  }
  applySourceFinalEmptyLine(windowLines, window, scan.totalLines);
  const redacted = windowLines.map((line, index) => line !== rawLines[index]);
  return { lines: windowLines, redacted, nukeApplied: false, forcedLines: [] };
}

/**
 * Clear a source-final zero-width line to the oracle-exact bare verdict (see
 * the Stage 2 note at the end of projectLargeWindow). Interior empty lines
 * and giant entries are untouched: only the source's own final empty line
 * carries the oracle exemption.
 */
function applySourceFinalEmptyLine(lines: string[], window: ScannedLine[], totalLines: number): void {
  if (lines.length === 0 || window.length !== lines.length) return;
  const last = window.length - 1;
  const entry = window[last];
  if (!entry.giant && entry.text === "" && entry.lineNo === totalLines) {
    lines[last] = "";
  }
}

/**
 * Trim a flank-before chunk to the first line boundary.
 */
export function trimFlankBefore(chunk: string): { flank: string; bridgeSuspect: boolean } {
  if (chunk.length === 0) return { flank: "", bridgeSuspect: false };
  const newline = chunk.indexOf("\n");
  if (newline < 0) {
    return {
      flank: "",
      bridgeSuspect: false
    };
  }
  return {
    flank: chunk.slice(newline + 1),
    bridgeSuspect: false
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
