import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { CodexProConfig } from "./config.js";
import {
  FIXED_SNAPSHOT_BYTES,
  LINE_FRAG_CAP_BYTES,
  SOURCE_SCAN_LIMIT_BYTES,
  SourceScanError,
  SelectedLineTooLargeError,
  frameRawWindow,
  projectLargeWindow,
  resolveWindow,
  scanStream,
  type ScannedLine,
  type SourceScan,
  type StreamChunkSource
} from "./sourceProjection.js";
import { splitLines, type ReadFileResult } from "./fsOps.js";
import { GIT_REVIEWER_GLOBAL_ARGS, GitExecutionError, gitReviewerEnvironment, runGitReadOnly, terminateGitProcess } from "./gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { redactSensitiveTextPreservingLines, sourceLanguageForPath } from "./redact.js";
import { validateHistoricalPath } from "./historicalPath.js";
import { GitRefResolutionError, resolveGitRef, type GitObjectFormat, type GitReviewRef } from "./gitReviewRef.js";

export type GitHistoricalBlobConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes" | "maxReadBytes">;

export interface GitHistoricalBlobOptions {
  readonly ref: string;
  readonly path: unknown;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxBytes?: number;
}

export type HistoricalBlobEntryKind = "file" | "symlink";

export type HistoricalBlobFailureReason =
  | "invalid-input"
  | "invalid-path"
  | "blocked-path"
  | "invalid-range"
  | "invalid-max-bytes"
  | "ref-resolution"
  | "missing-path"
  | "malformed-entry"
  | "invalid-object-id"
  | "invalid-object-size"
  | "directory"
  | "gitlink"
  | "type-mismatch"
  | "oversized"
  | "execution"
  | "timeout"
  | "stdout-overflow"
  | "blob-size-mismatch"
  | "binary"
  | "projection"
  | "range-too-large";

const FAILURE_MESSAGES: Record<HistoricalBlobFailureReason, string> = {
  "invalid-input": "Historical blob input is invalid.",
  "invalid-path": "Historical blob path is invalid.",
  "blocked-path": "Historical blob path is blocked by safety rules.",
  "invalid-range": "Historical blob line range is invalid.",
  "invalid-max-bytes": "Historical blob max_bytes must be a positive integer.",
  "ref-resolution": "Historical blob ref could not be resolved.",
  "missing-path": "Historical blob path was not present in the requested tree.",
  "malformed-entry": "Git returned a malformed historical tree entry.",
  "invalid-object-id": "Git returned an invalid historical object ID.",
  "invalid-object-size": "Git returned an invalid historical object size.",
  directory: "Historical path is a directory.",
  gitlink: "Historical path is a gitlink.",
  "type-mismatch": "Historical tree entry type is not supported.",
  oversized: "Historical blob exceeds the configured read limit.",
  execution: "Historical blob Git execution failed.",
  timeout: "Historical blob Git execution timed out.",
  "stdout-overflow": "Historical blob Git output exceeded its bound.",
  "blob-size-mismatch": "Historical blob byte count did not match Git metadata.",
  binary: "Historical blob is binary.",
  projection: "Historical blob source projection failed.",
  "range-too-large": "Historical blob line range exceeds the byte limit."
};

/**
 * Constant-message, JSON-safe failure for the historical blob operation.
 * Only a bounded reason and numeric facts are retained; caller inputs and
 * Git/source streams are deliberately never stored on this error.
 */
export class HistoricalBlobError extends CodexProError {
  readonly reason: HistoricalBlobFailureReason;
  readonly facts: Readonly<Record<string, number>>;

  constructor(reason: HistoricalBlobFailureReason, facts: Readonly<Record<string, number>> = {}) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "HistoricalBlobError";
    this.reason = reason;
    this.facts = { ...facts };
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      facts: this.facts
    };
  }
}

export { HistoricalBlobError as GitHistoricalBlobError };

export interface GitHistoricalBlobResult extends ReadFileResult {
  readonly ref: GitReviewRef;
  readonly commitSha: string;
  readonly gitMode: string;
  readonly entryKind: HistoricalBlobEntryKind;
  readonly blobSha: string;
}

interface HistoricalTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  readonly size: number | undefined;
  readonly entryKind?: HistoricalBlobEntryKind;
}

function failure(reason: HistoricalBlobFailureReason, facts: Readonly<Record<string, number>> = {}): HistoricalBlobError {
  return new HistoricalBlobError(reason, facts);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateLineOption(value: unknown): void {
  if (value !== undefined && !isPositiveInteger(value)) throw failure("invalid-range");
}

interface ValidatedHistoricalBlobOptions {
  /** The bounded budget passed to the shared projector. */
  readonly projectionMaxBytes: number;
}

function validateOptions(
  config: GitHistoricalBlobConfig,
  options: GitHistoricalBlobOptions
): ValidatedHistoricalBlobOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("invalid-input");
  if (typeof options.ref !== "string" || options.ref.length === 0) throw failure("invalid-input");
  validateLineOption(options.startLine);
  validateLineOption(options.endLine);
  if (options.startLine !== undefined && options.endLine !== undefined && options.endLine < options.startLine) {
    throw failure("invalid-range");
  }

  if (!isPositiveInteger(config.maxReadBytes)) throw failure("invalid-max-bytes");
  if (options.maxBytes !== undefined && !isPositiveInteger(options.maxBytes)) throw failure("invalid-max-bytes");
  const projectionMaxBytes = Math.min(options.maxBytes ?? config.maxReadBytes, config.maxReadBytes);
  if (!isPositiveInteger(projectionMaxBytes)) throw failure("invalid-max-bytes");
  return { projectionMaxBytes };
}

function objectIdPattern(objectFormat: GitObjectFormat): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
}

function isMissingObjectError(error: GitExecutionError): boolean {
  if (error.failure !== "exit") return false;
  const stderr = error.result.copyStderrBytes().toString("utf8").toLowerCase();
  return /(?:bad object|not a valid object|unknown revision|ambiguous argument|missing object|object .* not found|does not exist)/u.test(
    stderr
  );
}

function executionFailure(error: unknown): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof GitExecutionError) {
    const facts = {
      stdoutBytes: error.result.toJSON().stdoutBytes,
      stderrBytes: error.result.toJSON().stderrBytes
    };
    if (error.failure === "timeout") return failure("timeout", facts);
    if (error.failure === "stdout-overflow") return failure("stdout-overflow", facts);
    if (isMissingObjectError(error)) return failure("execution", facts);
    return failure("execution", facts);
  }
  return failure("execution");
}

async function runHistoricalGit(
  config: GitHistoricalBlobConfig,
  workspace: Workspace,
  args: readonly string[]
) {
  try {
    return await runGitReadOnly(config, workspace, args);
  } catch (error) {
    throw executionFailure(error);
  }
}

function parseObjectSize(sizeText: string): number | undefined {
  if (sizeText === "-") return undefined;
  if (!/^\d+$/u.test(sizeText)) throw failure("invalid-object-size");
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) throw failure("invalid-object-size");
  return size;
}

function parseTreeEntry(bytes: Buffer, canonicalPath: string, objectFormat: GitObjectFormat): HistoricalTreeEntry {
  if (bytes.byteLength === 0) throw failure("missing-path");
  const nul = bytes.indexOf(0);
  if (nul < 0 || bytes.lastIndexOf(0) !== nul || nul !== bytes.byteLength - 1) {
    throw failure("malformed-entry", { bytes: bytes.byteLength });
  }

  const record = bytes.subarray(0, nul);
  const tab = record.indexOf(0x09);
  if (tab < 0) throw failure("malformed-entry", { bytes: bytes.byteLength });
  const metadata = record.subarray(0, tab).toString("utf8");
  const returnedPath = record.subarray(tab + 1);
  const expectedPath = Buffer.from(canonicalPath, "utf8");
  if (!returnedPath.equals(expectedPath)) throw failure("malformed-entry", { bytes: returnedPath.byteLength });

  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+) +(-|[0-9]+)$/u.exec(metadata);
  if (!match) throw failure("malformed-entry", { bytes: metadata.length });
  const [, mode, type, oid, sizeText] = match;
  if (!objectIdPattern(objectFormat).test(oid)) throw failure("invalid-object-id", { bytes: oid.length });
  const size = parseObjectSize(sizeText);

  if (type === "blob") {
    if (size === undefined) throw failure("invalid-object-size");
    if (mode === "100644" || mode === "100755") return { mode, type, oid, size, entryKind: "file" };
    if (mode === "120000") return { mode, type, oid, size, entryKind: "symlink" };
    throw failure("type-mismatch");
  }
  if (size !== undefined) throw failure("malformed-entry", { bytes: size });
  if (mode === "040000" && type === "tree") throw failure("directory");
  if (mode === "160000" && type === "commit") throw failure("gitlink");
  throw failure("type-mismatch");
}

function mapPathFailure(error: unknown): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof CodexProError && error.message === "Historical repository path is blocked by safety rules.") {
    return failure("blocked-path");
  }
  return failure("invalid-path");
}

function mapProjectionFailure(error: unknown): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof SelectedLineTooLargeError) return failure("range-too-large");
  if (error instanceof CodexProError && error.message.startsWith("Selected line range is too large.")) {
    return failure("range-too-large");
  }
  return failure("projection");
}

function mapScanFailure(error: unknown, advertised: number): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof SourceScanError) {
    if (error.reason === "source_scan_limit") return failure("oversized", { advertised, limit: SOURCE_SCAN_LIMIT_BYTES });
    return failure("execution", { advertised });
  }
  if (error instanceof CodexProError && error.message.startsWith("end_line")) {
    return failure("invalid-range");
  }
  return failure("execution", { advertised });
}

/** Bounded queue cap between the Git pipe and the sequential scanner (backpressure via pause/resume). */
const GIT_STREAM_QUEUE_CAP_BYTES = 1 << 20;

export interface GitBlobStreamRequest {
  readonly oid: string;
  readonly advertised: number;
  readonly timeoutMs: number;
  readonly stderrMaxBytes: number;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly selectMaxBytes: number;
  /** Retain up to this many leading content bytes (snapshot materialization); 0 disables retention. */
  readonly retainUpToBytes: number;
}

export interface GitBlobStreamResult {
  readonly scan: SourceScan;
  /** Leading content bytes (exactly the full blob when retainUpToBytes covered it). */
  readonly retained: Buffer;
  readonly exitCode: number | null;
}

/**
 * Consume `git cat-file blob` through a bounded streaming path: stdout is
 * never captured whole, the pipe applies backpressure, advertised-vs-observed
 * byte counts are enforced with early exit, and the process group is always
 * reaped. Mirrors `runGitReadOnly` lifecycle semantics (reviewer globals,
 * isolated environment, no shell, SIGTERM→SIGKILL escalation, timeout,
 * bounded stderr) without its stdout capture.
 */
export function streamGitBlobToScan(
  workspace: Workspace,
  request: GitBlobStreamRequest
): Promise<GitBlobStreamResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settleResolve = (result: GitBlobStreamResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      resolve(result);
    };
    const settleReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
      terminateGitProcess(child, "SIGKILL");
      reject(error);
    };
    const child: ChildProcess = spawn("git", [...GIT_REVIEWER_GLOBAL_ARGS, "cat-file", "blob", request.oid], {
      cwd: workspace.root,
      env: gitReviewerEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let timedOut = false;
    let closed = false;
    let terminationStarted = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    const terminateWithEscalation = (): void => {
      if (closed || terminationStarted) return;
      terminationStarted = true;
      terminateGitProcess(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!closed) terminateGitProcess(child, "SIGKILL");
      }, 250);
      escalationTimer.unref();
    };
    const timeoutTimer = setTimeout(() => {
      if (closed) return;
      timedOut = true;
      terminateWithEscalation();
    }, Math.max(1, Math.floor(request.timeoutMs)));
    timeoutTimer.unref();

    const queue: Buffer[] = [];
    let queuedBytes = 0;
    let paused = false;
    let eof = false;
    let streamFailed: unknown = null;
    let readWake: (() => void) | null = null;
    let observed = 0;
    const retained: Buffer[] = [];
    let retainedBytes = 0;
    let stderrOverflow = false;
    let stderrBytes = 0;
    const stderrHead: Buffer[] = [];

    const wakeReader = (): void => {
      if (readWake !== null) {
        const wake = readWake;
        readWake = null;
        wake();
      }
    };
    const failStream = (error: unknown): void => {
      if (streamFailed === null) streamFailed = error;
      terminateWithEscalation();
      wakeReader();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observed += incoming.length;
      if (observed > request.advertised) {
        failStream(failure("blob-size-mismatch", { actual: observed, advertised: request.advertised }));
        return;
      }
      if (retainedBytes < request.retainUpToBytes) {
        const take = Math.min(incoming.length, request.retainUpToBytes - retainedBytes);
        retained.push(incoming.subarray(0, take));
        retainedBytes += take;
      }
      queue.push(incoming);
      queuedBytes += incoming.length;
      if (!paused && queuedBytes > GIT_STREAM_QUEUE_CAP_BYTES) {
        paused = true;
        child.stdout?.pause();
      }
      wakeReader();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += incoming.length;
      if (stderrHead.length < 4) stderrHead.push(incoming.subarray(0, 65536));
      if (stderrBytes > request.stderrMaxBytes) {
        stderrOverflow = true;
        failStream(failure("stdout-overflow", { advertised: request.advertised }));
      }
    });
    child.once("error", (error: Error) => {
      failStream(failure("execution", { advertised: request.advertised }));
      void error;
    });

    const source: StreamChunkSource = {
      read: async () => {
        for (;;) {
          if (settled) throw new CodexProError("Git blob stream ended.");
          const next = queue.shift();
          if (next !== undefined) {
            queuedBytes -= next.length;
            if (paused && queuedBytes < GIT_STREAM_QUEUE_CAP_BYTES / 2) {
              paused = false;
              child.stdout?.resume();
            }
            return next;
          }
          if (streamFailed !== null) throw streamFailed;
          if (eof) return null;
          await new Promise<void>((wake) => {
            readWake = wake;
          });
        }
      },
      close: async () => undefined
    };

    const scanPromise = scanStream(source, {
      startLine: request.startLine,
      endLine: request.endLine,
      scanLimitBytes: SOURCE_SCAN_LIMIT_BYTES,
      chunkBytes: 64 * 1024,
      selectMaxBytes: request.selectMaxBytes
    });
    // The scan rejects as soon as the stream fails (e.g. advertised/observed
    // mismatch), well before the close handler consumes it below. Observe the
    // rejection immediately so a deterministic failure never surfaces as a
    // process-level unhandled rejection; the close handler still awaits the
    // same promise for the authoritative outcome.
    scanPromise.then(undefined, () => undefined);

    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      eof = true;
      void signal;
      if (timedOut) {
        failStream(failure("timeout", { advertised: request.advertised }));
      } else if (exitCode !== 0) {
        const stderrText = Buffer.concat(stderrHead).toString("utf8").toLowerCase();
        void stderrText;
        failStream(failure("execution", { advertised: request.advertised }));
      }
      wakeReader();
      void (async () => {
        try {
          const scan = await scanPromise;
          if (timedOut) {
            settleReject(failure("timeout", { advertised: request.advertised }));
            return;
          }
          if (exitCode !== 0) {
            settleReject(failure("execution", { advertised: request.advertised }));
            return;
          }
          if (stderrOverflow) {
            settleReject(failure("stdout-overflow", { advertised: request.advertised }));
            return;
          }
          if (scan.bytes !== request.advertised) {
            settleReject(failure("blob-size-mismatch", { actual: scan.bytes, advertised: request.advertised }));
            return;
          }
          settleResolve({ scan, retained: Buffer.concat(retained), exitCode });
        } catch (error) {
          if (error instanceof HistoricalBlobError) settleReject(error);
          else settleReject(mapScanFailure(error, request.advertised));
        }
      })();
    });
  });
}

/**
 * Read one complete text blob from an immutable commit tree. Ref resolution,
 * tree lookup, and blob acquisition are all local read-only Git operations;
 * the historical path is never resolved through the current filesystem.
 */
export async function readAtRef(
  config: GitHistoricalBlobConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitHistoricalBlobOptions
): Promise<GitHistoricalBlobResult> {
  const validatedOptions = validateOptions(config, options);

  let resolved: GitReviewRef;
  try {
    resolved = await resolveGitRef(config, workspace, options.ref);
  } catch (error) {
    if (error instanceof HistoricalBlobError) throw error;
    if (error instanceof GitRefResolutionError) throw failure("ref-resolution");
    throw executionFailure(error);
  }

  let canonicalPath: string;
  try {
    canonicalPath = validateHistoricalPath(guard, options.path);
  } catch (error) {
    throw mapPathFailure(error);
  }

  const treeEntryResult = await runHistoricalGit(config, workspace, [
    "ls-tree",
    "-z",
    "-l",
    "--full-tree",
    resolved.fullSha,
    "--",
    `:(literal)${canonicalPath}`
  ]);
  const entry = parseTreeEntry(treeEntryResult.copyStdoutBytes(), canonicalPath, resolved.objectFormat);
  if (entry.size === undefined || entry.entryKind === undefined) throw failure("type-mismatch");
  // The only total-blob gate is the independent operational scan policy, never
  // a response budget. Bounded requests stream regardless of blob size.
  if (entry.size > SOURCE_SCAN_LIMIT_BYTES) {
    throw failure("oversized", { advertised: entry.size, limit: SOURCE_SCAN_LIMIT_BYTES });
  }
  const effectiveMaxBytes = validatedOptions.projectionMaxBytes;

  let streamed: GitBlobStreamResult;
  try {
    streamed = await streamGitBlobToScan(workspace, {
      oid: entry.oid,
      advertised: entry.size,
      timeoutMs: Number.isFinite(config.maxGitTimeoutMs)
        ? Math.max(1, Math.min(300_000, Math.floor(config.maxGitTimeoutMs)))
        : 60_000,
      stderrMaxBytes: Number.isFinite(config.maxOutputBytes) ? Math.max(1, Math.floor(config.maxOutputBytes)) : 1,
      startLine: options.startLine ?? 1,
      endLine: options.endLine,
      selectMaxBytes: effectiveMaxBytes + LINE_FRAG_CAP_BYTES + 65536,
      retainUpToBytes: entry.size <= FIXED_SNAPSHOT_BYTES ? entry.size : 0
    });
  } catch (error) {
    throw mapScanFailure(error, entry.size);
  }
  const scan = streamed.scan;
  if (scan.nulFound) throw failure("binary", { bytes: scan.bytes });
  if (scan.bytes !== entry.size) {
    throw failure("blob-size-mismatch", { actual: scan.bytes, advertised: entry.size });
  }

  let projected: ReadFileResult;
  try {
    if (scan.bytes <= FIXED_SNAPSHOT_BYTES) {
      projected = projectHistoricalSnapshot(canonicalPath, streamed.retained, scan, options, effectiveMaxBytes);
    } else {
      projected = projectHistoricalLarge(canonicalPath, scan, options, effectiveMaxBytes);
    }
  } catch (error) {
    throw mapProjectionFailure(error);
  }

  return {
    ...projected,
    ref: resolved,
    commitSha: resolved.fullSha,
    path: canonicalPath,
    gitMode: entry.mode,
    entryKind: entry.entryKind,
    blobSha: entry.oid
  };
}

function resolveHistoricalWindow(
  options: GitHistoricalBlobOptions,
  totalLines: number
): { startLine: number; endLine: number } {
  try {
    return resolveWindow({ startLine: options.startLine, endLine: options.endLine }, totalLines);
  } catch {
    throw failure("invalid-range");
  }
}

/**
 * Snapshot route for blobs within the fixed envelope: the accepted
 * `projectPublicSourceText` redaction runs verbatim over the streamed bytes;
 * only over-budget/unbounded framing uses the shared pager (byte-identical to
 * the accepted projector whenever it admits the window).
 */
function projectHistoricalSnapshot(
  canonicalPath: string,
  retained: Buffer,
  scan: SourceScan,
  options: GitHistoricalBlobOptions,
  maxBytes: number
): ReadFileResult {
  const text = retained.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== scan.bytes ||
    createHash("sha256").update(text, "utf8").digest("hex") !== scan.sha256) {
    throw failure("blob-size-mismatch", { actual: retained.byteLength, advertised: scan.bytes });
  }
  const redacted = redactSensitiveTextPreservingLines(text, {
    context: "source",
    language: sourceLanguageForPath(canonicalPath)
  });
  const rawLines = splitLines(text);
  const redactedLines = splitLines(redacted);
  if (redactedLines.length !== rawLines.length) throw failure("projection");
  const window = resolveHistoricalWindow(options, rawLines.length);
  // Exact decoded-string offsets (terminator-aware, so CRLF counts two).
  const lineStarts: number[] = [];
  {
    let cursor = 0;
    const pieces = text.split(/(\r\n|\n)/);
    for (let i = 0; i < pieces.length; i += 2) {
      lineStarts.push(cursor);
      cursor += pieces[i].length + (pieces[i + 1] ?? "").length;
    }
  }
  const toScanned = (lines: string[]): ScannedLine[] =>
    lines.map((line, index) => ({
      lineNo: window.startLine + index,
      text: line,
      bytes: Buffer.byteLength(line, "utf8"),
      giant: false,
      startOffset: lineStarts[window.startLine - 1 + index] ?? 0
    }));
  const framed = frameRawWindow(
    toScanned(redactedLines.slice(window.startLine - 1, window.endLine)),
    toScanned(rawLines.slice(window.startLine - 1, window.endLine)),
    {
      startLine: window.startLine,
      endLine: window.endLine,
      totalLines: rawLines.length,
      bytes: scan.bytes,
      sha256: scan.sha256,
      maxBytes
    }
  );
  return { path: canonicalPath, ...framed };
}

/** Large-blob route: shared secure projector over the streamed window. */
function projectHistoricalLarge(
  canonicalPath: string,
  scan: SourceScan,
  options: GitHistoricalBlobOptions,
  maxBytes: number
): ReadFileResult {
  const window = resolveHistoricalWindow(options, scan.totalLines);
  if (scan.maskAtWindowStart === null) throw failure("projection");
  const captured = scan.selected.filter((line) => line.lineNo >= window.startLine && line.lineNo <= window.endLine);
  if (captured.length === 0) throw failure("invalid-range");
  const projected = projectLargeWindow(
    {
      scan,
      window: captured
    },
    (slice) => redactSensitiveTextPreservingLines(slice, { context: "source" })
  );
  const display: ScannedLine[] = captured.map((line, index) => ({
    lineNo: line.lineNo,
    text: projected.lines[index] ?? "",
    bytes: line.bytes,
    giant: line.giant,
    startOffset: line.startOffset
  }));
  const framed = frameRawWindow(display, captured, {
    startLine: window.startLine,
    endLine: window.endLine,
    totalLines: scan.totalLines,
    bytes: scan.bytes,
    sha256: scan.sha256,
    maxBytes,
    capped: scan.selectionCapped,
    capturedThroughLine: scan.capturedThroughLine
  });
  return { path: canonicalPath, ...framed };
}

// Operation-oriented aliases keep the internal primitive easy to consume
// while the public `read_at_ref` registration remains a later task.
export const gitHistoricalBlob = readAtRef;
export const readHistoricalBlob = readAtRef;
export const gitReadAtRef = readAtRef;
