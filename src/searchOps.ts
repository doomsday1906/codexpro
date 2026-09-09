import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { isHiddenRelativePath, listFiles, textScanByteLimit } from "./fsOps.js";
import { redactDiagnosticText, redactSearchQuery, redactSensitiveTextPreservingLines, sourceLanguageForPath, truncateUtf8 } from "./redact.js";
import {
  FIXED_SNAPSHOT_BYTES,
  SOURCE_SCAN_LIMIT_BYTES,
  projectLargeWindow,
  scanWorkingTreeFile,
  type SourceScan
} from "./sourceProjection.js";
import { searchWorkspaceStructured, type AnalysisSearchIntent, type StructuredSearchMatch, type StructuredSearchResult } from "./analysis/index.js";
import {
  UNAVAILABLE_SEARCH_CONTEXT,
  statusForDerivedSearchText,
  type SearchTextStatus,
  type SearchUnavailableReason
} from "./analysis/types.js";
import { resolveSearchScope } from "./analysis/scope.js";

export type { SearchTextStatus, SearchUnavailableReason };
export { UNAVAILABLE_SEARCH_CONTEXT };

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  text_status: SearchTextStatus;
  reason?: SearchUnavailableReason;
}

export interface SearchOptions {
  query: string;
  regex: boolean;
  root?: string;
  glob?: string;
  includeHidden: boolean;
  maxResults: number;
  intent?: AnalysisSearchIntent;
  symbol?: string;
  includeTests?: boolean;
  deterministicOrder?: boolean;
}

export interface SearchResult {
  text: string;
  matches: SearchMatch[];
  truncated: boolean;
  used: "ripgrep" | "node";
  analysis?: StructuredSearchResult;
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = process.platform === "win32"
      ? spawn("where", [command], { stdio: "ignore", shell: false })
      : spawn("/bin/sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function truncateLine(line: string, max = 400): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const RIPGREP_PARTIAL_RECORD_MAX_BYTES = 64 * 1024;

const NODE_SEARCH_SLAB_BYTES = 64 * 1024;
const NODE_SEARCH_MAX_QUERY_BYTES = 1024 * 1024;

function countLfBytes(buf: Buffer, start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    if (buf[i] === 10) total += 1;
  }
  return total;
}

interface NodeFallbackFileScan {
  keptLines: number[];
  extraCount: number;
  nulFound: boolean;
  utf8Valid: boolean;
  race: boolean;
  scanLimited: boolean;
  ioError: boolean;
}

function nodeFallbackFileReason(scan: NodeFallbackFileScan): SearchUnavailableReason | null {
  if (scan.ioError) return "io-error";
  if (scan.scanLimited) return "scan-limit";
  if (scan.race) return "race";
  if (scan.nulFound) return "binary";
  if (!scan.utf8Valid) return "invalid-encoding";
  return null;
}

/**
 * F3 bounded streaming literal matcher for the Node fallback. Reads one file
 * in fixed 64KiB slabs (never the scan ceiling, never the whole file), matches
 * on raw UTF-8 query bytes so invalid-encoding files still yield locations,
 * counts exact 1-based lines via 0x0A, and tracks binary / encoding / race /
 * scan-limit per file. Retained line numbers stay bounded by the caller budget;
 * anything past the budget is counted but not kept so truncation stays honest.
 */
async function scanNodeFallbackFile(
  absPath: string,
  queryBytes: Buffer,
  limit: number,
  retainBudget: number
): Promise<NodeFallbackFileScan> {
  const failed = (partial: Partial<NodeFallbackFileScan>): NodeFallbackFileScan => ({
    keptLines: [],
    extraCount: 0,
    nulFound: false,
    utf8Valid: true,
    race: false,
    scanLimited: false,
    ioError: false,
    ...partial
  });
  if (queryBytes.length === 0) return failed({ ioError: true });
  const qlen = queryBytes.length;
  const overlap = qlen > 1 ? qlen - 1 : 0;
  let handle;
  try {
    handle = await fsp.open(absPath, "r");
  } catch {
    return failed({ ioError: true });
  }
  try {
    let pre;
    try {
      pre = await handle.stat();
    } catch {
      return failed({ ioError: true });
    }
    if (!pre.isFile()) return failed({ ioError: true });
    const cap = Math.max(1, Math.floor(limit));
    let scanLimited = pre.size > cap;
    const slab = Buffer.allocUnsafe(NODE_SEARCH_SLAB_BYTES);
    const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let nulFound = false;
    let utf8Valid = true;
    let race = false;
    let ioError = false;
    const kept: number[] = [];
    let extra = 0;
    let carry = Buffer.alloc(0);
    let currentLine = 1;
    let totalRead = 0;
    let reachedEof = false;
    let lastReportedLine = 0;
    const report = (lineNo: number): void => {
      if (lineNo === lastReportedLine) return;
      lastReportedLine = lineNo;
      if (kept.length < retainBudget) kept.push(lineNo);
      else extra += 1;
    };
    for (;;) {
      if (totalRead >= cap) {
        if (scanLimited) break;
        const probe = Buffer.allocUnsafe(1);
        let probeRead = 0;
        try {
          const r = await handle.read(probe, 0, 1, null);
          probeRead = r.bytesRead;
        } catch {
          ioError = true;
          break;
        }
        if (probeRead === 0) {
          reachedEof = true;
          break;
        }
        scanLimited = true;
        break;
      }
      const toRead = Math.min(slab.length, cap - totalRead);
      let bytesRead = 0;
      try {
        const r = await handle.read(slab, 0, toRead, null);
        bytesRead = r.bytesRead;
      } catch {
        ioError = true;
        break;
      }
      if (bytesRead === 0) {
        reachedEof = true;
        break;
      }
      const chunk = slab.subarray(0, bytesRead);
      if (!nulFound && chunk.includes(0)) nulFound = true;
      if (utf8Valid) {
        try {
          strict.decode(chunk, { stream: true });
        } catch {
          utf8Valid = false;
        }
      }
      let window: Buffer;
      let windowStartLine: number;
      if (carry.length === 0) {
        window = Buffer.from(chunk);
        windowStartLine = currentLine;
      } else {
        window = Buffer.concat([carry, chunk]);
        windowStartLine = currentLine - countLfBytes(carry, 0, carry.length);
      }
      const idxs: number[] = [];
      let from = 0;
      for (;;) {
        const idx = window.indexOf(queryBytes, from);
        if (idx < 0) break;
        if (idx + qlen > carry.length) idxs.push(idx);
        from = idx + 1;
        if (from > window.length) break;
      }
      if (idxs.length > 0) {
        let newlinesSoFar = 0;
        let prev = 0;
        for (const idx of idxs) {
          newlinesSoFar += countLfBytes(window, prev, idx);
          prev = idx;
          report(windowStartLine + newlinesSoFar);
        }
      }
      currentLine += countLfBytes(chunk, 0, chunk.length);
      totalRead += bytesRead;
      if (totalRead > cap) {
        scanLimited = true;
        break;
      }
      if (overlap === 0) {
        carry = Buffer.alloc(0);
      } else if (window.length <= overlap) {
        carry = Buffer.from(window);
      } else {
        carry = Buffer.from(window.subarray(window.length - overlap));
      }
    }
    if (utf8Valid && reachedEof && !scanLimited) {
      try {
        strict.decode();
      } catch {
        utf8Valid = false;
      }
    }
    try {
      const post = await handle.stat();
      if (!post.isFile() || post.size !== pre.size || post.mtimeMs !== pre.mtimeMs || post.ctimeMs !== pre.ctimeMs) {
        if (!scanLimited) race = true;
      }
    } catch {
      if (!scanLimited) race = true;
    }
    return { keptLines: kept, extraCount: extra, nulFound, utf8Valid, race, scanLimited, ioError };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface HydratedSearchLine {
  readonly line: number;
  readonly text: string;
  readonly text_status: SearchTextStatus;
  readonly reason?: SearchUnavailableReason;
}

function unavailableLine(line: number, reason: SearchUnavailableReason): HydratedSearchLine {
  return { line, text: UNAVAILABLE_SEARCH_CONTEXT, text_status: "unavailable", reason };
}

/**
 * Hydrate requested source lines through the shared bounded-source pipeline
 * with exactly one scan per file per call. Small sources use the accepted
 * complete-snapshot oracle (with path-derived language); large sources use
 * the secure bounded projector — the same evidence the read routes return.
 * Failures are `unavailable` with a bounded reason; only actual policy
 * suppression is `redacted`. `[REDACTED_SECRET]` is never an unavailability
 * placeholder here.
 */
export async function hydrateSearchLines(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  relativePath: string,
  lineNumbers: number[]
): Promise<Map<number, HydratedSearchLine>> {
  const unique = [...new Set(lineNumbers.filter((line) => Number.isSafeInteger(line) && line >= 1))].sort((a, b) => a - b);
  const result = new Map<number, HydratedSearchLine>();
  if (unique.length === 0) return result;
  const failAll = (reason: SearchUnavailableReason): Map<number, HydratedSearchLine> => {
    for (const line of unique) result.set(line, unavailableLine(line, reason));
    return result;
  };
  let resolved;
  try {
    resolved = guard.resolve(workspace, relativePath);
  } catch {
    return failAll("io-error");
  }
  // Cluster far-apart lines so each bounded scan covers a tight span: one scan
  // in the common clustered case, sequential bounded scans otherwise. Memory
  // stays capped per scan; a cluster wider than the capture cap still reports
  // its tail truthfully instead of failing the whole hydration.
  const clusters: number[][] = [];
  for (const line of unique) {
    const current = clusters[clusters.length - 1];
    if (current !== undefined && line - current[current.length - 1] <= CLUSTER_LINE_GAP) {
      current.push(line);
    } else {
      clusters.push([line]);
    }
  }
  const merged = new Map<number, HydratedSearchLine>();
  for (const cluster of clusters) {
    const partial = await hydrateSearchCluster(resolved.absPath, relativePath, cluster);
    for (const [line, hydrated] of partial) merged.set(line, hydrated);
  }
  return merged;
}

/** Lines farther apart than this start a new hydration scan cluster. */
const CLUSTER_LINE_GAP = 10000;

async function hydrateSearchCluster(
  absPath: string,
  relativePath: string,
  unique: number[]
): Promise<Map<number, HydratedSearchLine>> {
  const result = new Map<number, HydratedSearchLine>();
  const failAll = (reason: SearchUnavailableReason): Map<number, HydratedSearchLine> => {
    for (const line of unique) result.set(line, unavailableLine(line, reason));
    return result;
  };
  const minLine = unique[0];
  const maxLine = unique[unique.length - 1];
  let scan;
  try {
    scan = await scanWorkingTreeFile(fsp, { absPath, startLine: minLine, endLine: maxLine });
  } catch (error) {
    if (error && typeof error === "object" && "reason" in error) {
      const reason = (error as { reason?: unknown }).reason;
      if (reason === "race") return failAll("race");
      if (reason === "source_scan_limit") return failAll("scan-limit");
    }
    return failAll("io-error");
  }
  if (scan.nulFound) return failAll("binary");
  if (!scan.utf8Valid) return failAll("invalid-encoding");
  if (scan.bytes <= FIXED_SNAPSHOT_BYTES) {
    return hydrateSnapshotLines(absPath, scan, relativePath, unique);
  }
  return hydrateLargeLines(scan, unique);
}

async function hydrateSnapshotLines(
  absPath: string,
  scan: SourceScan,
  relPath: string,
  unique: number[]
): Promise<Map<number, HydratedSearchLine>> {
  const result = new Map<number, HydratedSearchLine>();
  const missing = (reason: SearchUnavailableReason): void => {
    for (const line of unique) {
      if (!result.has(line)) result.set(line, unavailableLine(line, reason));
    }
  };
  // Bounded re-read with content-addressed coherence against the scan.
  let buffer: Buffer;
  try {
    const handle = await fsp.open(absPath, "r");
    try {
      const chunks: Buffer[] = [];
      let total = 0;
      const slab = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(slab, 0, slab.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > scan.bytes + 65536) {
          missing("race");
          return result;
        }
        chunks.push(Buffer.from(slab.subarray(0, bytesRead)));
      }
      buffer = Buffer.concat(chunks);
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    missing("io-error");
    return result;
  }
  if (buffer.byteLength !== scan.bytes || createHash("sha256").update(buffer).digest("hex") !== scan.sha256) {
    missing("race");
    return result;
  }
  const text = buffer.toString("utf8");
  const redacted = redactSensitiveTextPreservingLines(text, {
    context: "source",
    language: sourceLanguageForPath(relPath)
  });
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const redactedLines = redacted.replace(/\r\n/g, "\n").split("\n");
  if (redactedLines.length !== rawLines.length) {
    missing("io-error");
    return result;
  }
  for (const line of unique) {
    const raw = rawLines[line - 1];
    if (raw === undefined) {
      result.set(line, unavailableLine(line, "io-error"));
      continue;
    }
    const red = redactedLines[line - 1] ?? "";
    result.set(line, {
      line,
      text: truncateLine(red),
      text_status: red !== raw ? "redacted" : "available"
    });
  }
  return result;
}

function hydrateLargeLines(
  scan: SourceScan,
  unique: number[]
): Map<number, HydratedSearchLine> {
  const result = new Map<number, HydratedSearchLine>();
  if (scan.maskAtWindowStart === null) {
    for (const line of unique) result.set(line, unavailableLine(line, "io-error"));
    return result;
  }
  // Project the full contiguous captured range in one call (same decisions as
  // the read routes), then pick the requested lines out of the projection.
  let projected: readonly string[];
  try {
    projected = projectLargeWindow(
      { scan, window: scan.selected },
      (slice) => redactSensitiveTextPreservingLines(slice, { context: "source" })
    ).lines;
  } catch {
    for (const line of unique) result.set(line, unavailableLine(line, "io-error"));
    return result;
  }
  if (projected.length !== scan.selected.length) {
    for (const line of unique) result.set(line, unavailableLine(line, "io-error"));
    return result;
  }
  // Empty selection means the window started past EOF: every line is past the end.
  const baseLineNo = scan.selected.length > 0 ? scan.selected[0].lineNo : unique[0];
  for (const line of unique) {
    if (line > scan.totalLines) {
      result.set(line, unavailableLine(line, "io-error"));
      continue;
    }
    const index = line - baseLineNo;
    const entry = index >= 0 && index < scan.selected.length && scan.selected[index].lineNo === line
      ? scan.selected[index]
      : undefined;
    if (entry === undefined) {
      result.set(line, unavailableLine(line, "capture-capped"));
      continue;
    }
    if (entry.giant) {
      result.set(line, unavailableLine(line, "line-too-large"));
      continue;
    }
    const raw = entry.text;
    const red = projected[index] ?? "";
    result.set(line, {
      line,
      text: truncateLine(red),
      text_status: red !== raw ? "redacted" : "available"
    });
  }
  return result;
}

/**
 * A caller explicitly targeting a file (root resolves to a regular file)
 * searches it under the independent scan policy instead of the broad
 * admission ceiling, so large in-scope files stay searchable.
 */
async function isExplicitFileTarget(guard: PathGuard, workspace: Workspace, root: string): Promise<boolean> {
  try {
    const target = guard.resolve(workspace, root);
    return (await fsp.stat(target.absPath)).isFile();
  } catch {
    return false;
  }
}

function mergeLexicalProvenance(structured: StructuredSearchResult, lexical: SearchResult): void {
  const byPathLine = new Map<string, StructuredSearchMatch>();
  for (const match of structured.matches) {
    byPathLine.set(`${match.path}\u0000${match.line}`, match);
    for (const line of match.additionalLines ?? []) {
      byPathLine.set(`${match.path}\u0000${line}`, match);
    }
  }
  for (const lexicalMatch of lexical.matches) {
    const structuredMatch = byPathLine.get(`${lexicalMatch.path}\u0000${lexicalMatch.line}`);
    if (!structuredMatch) continue;
    structuredMatch.reasons = [...new Set([...structuredMatch.reasons, "lexical exact match"])].sort((a, b) => a.localeCompare(b));
    const provenance = [...new Set([...(structuredMatch.provenance ?? [structuredMatch.source]), "lexical"])].sort((a, b) => a.localeCompare(b));
    structuredMatch.provenance = provenance;
  }
}

function enforceStructuredSearchScope(structured: StructuredSearchResult, scope: ReturnType<typeof resolveSearchScope>): void {
  structured.matches = structured.matches.filter((match) => scope.matches(match.path));
  for (const group of Object.keys(structured.groups) as Array<keyof StructuredSearchResult["groups"]>) {
    structured.groups[group] = structured.groups[group].filter((match) => scope.matches(match.path));
  }
}

async function runRipgrep(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const target = guard.resolve(workspace, options.root ?? ".");
  if (options.includeHidden === false && isHiddenRelativePath(target.relPath)) {
    return { text: "No matches.", matches: [], truncated: false, used: "ripgrep" };
  }
  const explicitFile = await isExplicitFileTarget(guard, workspace, options.root ?? ".");
  const fileSizeCeiling = explicitFile ? SOURCE_SCAN_LIMIT_BYTES : textScanByteLimit(config);
  const args = ["--json", "--line-number", "--with-filename", "--no-heading", "--color=never", "--max-columns", "500", "--max-count", "50", "--max-filesize", String(fileSizeCeiling)];
  if (!options.regex) args.push("--fixed-strings");
  if (options.includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  if (options.deterministicOrder) args.push("--sort", "path");
  // Pass the query via -e so patterns beginning with "-" (e.g. "->", "--flag")
  // are treated as the search term instead of ripgrep options.
  args.push("-e", options.query, "--", target.absPath);

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const maxOutputBytes = Math.max(0, config.maxOutputBytes);
    const stderrMaxBytes = maxOutputBytes;
    let stderr = "";
    let stderrBytes = 0;
    let partialLine = "";
    let partialLineBytes = 0;
    let evidenceBytes = 0;
    let visibleMatches = 0;
    const admittedMatches: Array<{ path: string; line: number }> = [];
    let outputLimited = false;
    let parserFailure: CodexProError | undefined;
    let terminationRequested = false;
    let settled = false;

    const requestTermination = (): void => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close event still settles the request if the child already exited.
      }
    };

    const failParser = (message: string): void => {
      if (parserFailure || outputLimited || settled) return;
      parserFailure = new CodexProError(message);
      partialLine = "";
      partialLineBytes = 0;
      requestTermination();
    };

    const appendStderr = (text: string): void => {
      if (!text || stderrBytes >= stderrMaxBytes) return;
      const remaining = stderrMaxBytes - stderrBytes;
      const bounded = Buffer.byteLength(text, "utf8") <= remaining
        ? text
        : truncateUtf8(text, remaining);
      if (!bounded) return;
      stderr += bounded;
      stderrBytes += Buffer.byteLength(bounded, "utf8");
    };

    const relativeMatchPath = (pathText: unknown): string | null => {
      if (typeof pathText !== "string" || !pathText) return null;
      const absPath = path.isAbsolute(pathText)
        ? path.resolve(pathText)
        : path.resolve(workspace.root, pathText);
      const nativeRelativePath = path.relative(workspace.root, absPath);
      if (
        path.isAbsolute(nativeRelativePath) ||
        nativeRelativePath === ".." ||
        nativeRelativePath.startsWith(`..${path.sep}`)
      ) {
        return null;
      }
      const relativePath = nativeRelativePath.split(path.sep).join("/") || ".";
      if (guard.isBlockedRelativePath(relativePath)) return null;
      if (!options.includeHidden && isHiddenRelativePath(relativePath)) return null;
      return relativePath;
    };

    const processRecord = (line: string, recordBytes: number): void => {
      if (parserFailure || outputLimited || settled || !line.trim()) return;

      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        failParser("ripgrep returned malformed JSON.");
        return;
      }
      if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "match") return;

      const data = (value as { data?: unknown }).data;
      if (!data || typeof data !== "object") return;
      const pathValue = (data as { path?: unknown }).path;
      const pathText = pathValue && typeof pathValue === "object"
        ? (pathValue as { text?: unknown }).text
        : undefined;
      const relativePath = relativeMatchPath(pathText);
      if (relativePath === null) return;

      // Admission is deliberately before every accounting operation. This
      // keeps excluded transport (hidden, blocked, or outside) out of the
      // evidence budget and visible result counters.
      visibleMatches += 1;
      if (evidenceBytes + recordBytes > maxOutputBytes) {
        outputLimited = true;
        partialLine = "";
        partialLineBytes = 0;
        requestTermination();
        return;
      }
      evidenceBytes += recordBytes;
      if (admittedMatches.length >= options.maxResults) return;

      const lineNumberValue = (data as { line_number?: unknown }).line_number;
      admittedMatches.push({
        path: relativePath,
        line: Number(lineNumberValue ?? 0)
      });
    };

    const consumeDecodedText = (text: string): void => {
      if (!text || parserFailure || outputLimited || settled) return;
      let offset = 0;
      while (offset < text.length && !parserFailure && !outputLimited && !settled) {
        const newline = text.indexOf("\n", offset);
        const segmentEnd = newline < 0 ? text.length : newline;
        const segment = text.slice(offset, segmentEnd);
        const segmentBytes = Buffer.byteLength(segment, "utf8");
        if (partialLineBytes + segmentBytes > RIPGREP_PARTIAL_RECORD_MAX_BYTES) {
          failParser("ripgrep returned an oversized incomplete JSON record.");
          return;
        }
        partialLine += segment;
        partialLineBytes += segmentBytes;
        if (newline < 0) return;

        processRecord(partialLine, partialLineBytes + 1);
        partialLine = "";
        partialLineBytes = 0;
        offset = newline + 1;
      }
    };

    const flushDecoder = (): void => {
      if (parserFailure || outputLimited || settled) return;
      consumeDecodedText(stdoutDecoder.end());
      if (parserFailure || outputLimited || settled || !partialLine.trim()) return;
      processRecord(partialLine, partialLineBytes);
      partialLine = "";
      partialLineBytes = 0;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      consumeDecodedText(stdoutDecoder.write(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      appendStderr(stderrDecoder.write(chunk));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", async (code) => {
      if (settled) return;
      try {
        appendStderr(stderrDecoder.end());
        flushDecoder();
        if (parserFailure) {
          settled = true;
          reject(parserFailure);
          return;
        }
        if (code && code > 1) {
          const diagnostic = redactDiagnosticText(stderr.trim());
          settled = true;
          reject(new CodexProError(truncateUtf8(diagnostic || `ripgrep failed with exit code ${code}`, maxOutputBytes)));
          return;
        }

        // One shared-pipeline hydration per file: requested lines are grouped so
        // a large file is scanned once per operation, not once per match.
        const linesByPath = new Map<string, number[]>();
        for (const admitted of admittedMatches) {
          const wanted = linesByPath.get(admitted.path);
          if (wanted) wanted.push(admitted.line);
          else linesByPath.set(admitted.path, [admitted.line]);
        }
        const hydratedByPath = new Map<string, Map<number, HydratedSearchLine>>();
        for (const [matchPath, wanted] of linesByPath) {
          if (settled) return;
          hydratedByPath.set(matchPath, await hydrateSearchLines(config, guard, workspace, matchPath, wanted));
        }
        const matches: SearchMatch[] = [];
        for (const admitted of admittedMatches) {
          if (settled) return;
          const line = hydratedByPath.get(admitted.path)?.get(admitted.line) ??
            { line: admitted.line, text: UNAVAILABLE_SEARCH_CONTEXT, text_status: "unavailable" as const, reason: "io-error" as const };
          matches.push({
            path: admitted.path,
            line: admitted.line,
            text: line.text,
            text_status: line.text_status,
            ...(line.reason === undefined ? {} : { reason: line.reason })
          });
        }
        if (settled) return;
        const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
        settled = true;
        resolve({ text, matches, truncated: visibleMatches > matches.length || outputLimited, used: "ripgrep" });
      } catch (error) {
        if (settled) return;
        settled = true;
        reject(error);
      }
    });
  });
}

async function runNodeSearch(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  if (options.regex) {
    throw new CodexProError(
      "Regex search requires ripgrep. Install rg or retry with regex=false; the Node fallback only supports literal search."
    );
  }
  const queryByteLength = Buffer.byteLength(options.query, "utf8");
  if (queryByteLength > NODE_SEARCH_MAX_QUERY_BYTES) {
    throw new CodexProError("Node fallback query exceeds the 1MiB literal limit; narrow the query and retry.");
  }
  const explicitFile = await isExplicitFileTarget(guard, workspace, options.root ?? ".");
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  // Matching admission: broad scans keep the response-budget-derived ceiling;
  // explicit file targets match under the independent scan policy instead.
  const scanBytes = explicitFile ? SOURCE_SCAN_LIMIT_BYTES : textScanByteLimit(config);
  const queryBytes = Buffer.from(options.query, "utf8");
  const pending: Array<{ path: string; line: number }> = [];
  const scanInfoByPath = new Map<string, NodeFallbackFileScan>();
  let visibleMatches = 0;
  let hasIncomplete = false;
  const incompleteExplicit: Array<{ path: string; reason: SearchUnavailableReason }> = [];
  for (const rel of files) {
    // Explicit targets scan every admitted file fully (correctness over speed).
    // Broad scans stop between files once truncation is proven; each scanned
    // file is still read fully so its error state cannot be hidden.
    if (!explicitFile && visibleMatches > options.maxResults) break;
    let resolved;
    try {
      resolved = guard.resolve(workspace, rel);
    } catch {
      hasIncomplete = true;
      if (explicitFile) incompleteExplicit.push({ path: rel, reason: "io-error" });
      continue;
    }
    let scan: NodeFallbackFileScan;
    try {
      const retainBudget = Math.max(0, options.maxResults - pending.length);
      scan = await scanNodeFallbackFile(resolved.absPath, queryBytes, scanBytes, retainBudget);
    } catch {
      hasIncomplete = true;
      if (explicitFile) incompleteExplicit.push({ path: rel, reason: "io-error" });
      continue;
    }
    const totalInFile = scan.keptLines.length + scan.extraCount;
    visibleMatches += totalInFile;
    for (const line of scan.keptLines) {
      if (pending.length < options.maxResults) pending.push({ path: rel, line });
    }
    if (scan.keptLines.length > 0) scanInfoByPath.set(rel, scan);
    const reason = nodeFallbackFileReason(scan);
    if (totalInFile === 0) {
      if (reason !== null) {
        hasIncomplete = true;
        if (explicitFile) incompleteExplicit.push({ path: rel, reason });
      }
    } else if (scan.scanLimited || scan.race || scan.ioError) {
      hasIncomplete = true;
    }
  }
  // Hydrate through the shared pipeline (one scan per file), so match evidence
  // carries honest available/redacted/unavailable status like the read routes.
  // Scan-limit files bypass hydration (it cannot run under their ceiling) and
  // are constructed directly with the same unavailable marker, never a secret.
  const linesByPath = new Map<string, number[]>();
  for (const hit of pending) {
    const wanted = linesByPath.get(hit.path);
    if (wanted) wanted.push(hit.line);
    else linesByPath.set(hit.path, [hit.line]);
  }
  const hydratedByPath = new Map<string, Map<number, HydratedSearchLine>>();
  const directByPath = new Map<string, Map<number, HydratedSearchLine>>();
  for (const [matchPath, wanted] of linesByPath) {
    const info = scanInfoByPath.get(matchPath);
    if (info?.scanLimited) {
      const reason = nodeFallbackFileReason(info) ?? "scan-limit";
      const direct = new Map<number, HydratedSearchLine>();
      for (const line of wanted) direct.set(line, unavailableLine(line, reason));
      directByPath.set(matchPath, direct);
    } else {
      hydratedByPath.set(matchPath, await hydrateSearchLines(config, guard, workspace, matchPath, wanted));
    }
  }
  const matches: SearchMatch[] = pending.map((hit) => {
    const line = directByPath.get(hit.path)?.get(hit.line) ?? hydratedByPath.get(hit.path)?.get(hit.line) ??
      { line: hit.line, text: UNAVAILABLE_SEARCH_CONTEXT, text_status: "unavailable" as const, reason: "io-error" as const };
    return {
      path: hit.path,
      line: hit.line,
      text: line.text,
      text_status: line.text_status,
      ...(line.reason === undefined ? {} : { reason: line.reason })
    };
  });
  const truncated = visibleMatches > matches.length || hasIncomplete;
  let text: string;
  if (matches.length === 0) {
    if (explicitFile && incompleteExplicit.length > 0) {
      const details = incompleteExplicit.map((e) => `${e.path}: could not be fully covered (${e.reason}).`).join(" ");
      text = `No matches. ${details} Coverage is incomplete.`;
    } else {
      text = "No matches.";
    }
  } else {
    text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
  }
  return { text, matches, truncated, used: "node" };
}

export async function searchWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace, rawOptions: Partial<SearchOptions>): Promise<SearchResult> {
  const query = rawOptions.symbol?.toString() || rawOptions.query?.toString() || "";
  if (!query) throw new CodexProError("query is required.");
  const structuredRequested = rawOptions.intent !== undefined || rawOptions.symbol !== undefined || rawOptions.includeTests !== undefined;
  const options: SearchOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults)),
    intent: rawOptions.intent,
    symbol: rawOptions.symbol,
    includeTests: rawOptions.includeTests,
    deterministicOrder: structuredRequested
  };
  let lexical: SearchResult;
  if (await commandExists("rg")) {
    lexical = await runRipgrep(config, guard, workspace, options);
  } else if (options.regex) {
    throw new CodexProError("regex search requires ripgrep. Install rg or retry with regex=false.");
  } else {
    lexical = await runNodeSearch(config, guard, workspace, options);
  }
  if (!structuredRequested) return lexical;
  if (!config.analysisEnabled) {
    lexical.analysis = {
      schemaVersion: 1,
      query: redactSearchQuery(query, lexical.matches.map((match) => match.text)),
      intent: rawOptions.intent && rawOptions.intent !== "auto" ? rawOptions.intent : "text",
      groups: { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] },
      matches: [],
      coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0, relationshipCount: 0, truncated: true, warnings: ["Repository analysis is disabled by configuration."] },
      warnings: ["Repository analysis is disabled by configuration."],
      cache: { hit: false, key: "disabled" }
    };
    return lexical;
  }
  try {
    const structured = await searchWorkspaceStructured(config, guard, workspace, {
      query,
      intent: rawOptions.intent ?? "auto",
      includeTests: Boolean(rawOptions.includeTests),
      includeHidden: options.includeHidden,
      regex: Boolean(rawOptions.regex),
      root: options.root,
      glob: options.glob,
      maxResults: options.maxResults
    });
    // Keep the public projection behind the same request-local scope predicate
    // as the structured producers, even if a future producer adds a record
    // through a path not covered by its own admission loop.
    enforceStructuredSearchScope(structured, resolveSearchScope(guard, workspace, options));
    mergeLexicalProvenance(structured, lexical);
    // Binary/NUL files may be found by lexical ripgrep while analysis has no
    // decodable inventory or structured matches. Use both redacted producers
    // before echoing the query, including the regex structured route.
    structured.query = redactSearchQuery(query, [
      ...lexical.matches.map((match) => match.text),
      ...structured.matches.map((match) => match.text)
    ]);
    // Structured scheduling is the authoritative result set for semantic
    // searches. Keep the legacy projection aligned with that same set instead
    // of exposing an independently truncated lexical window alongside it.
    // Text intent intentionally retains lexical occurrence cardinality: its
    // structured records may compress multiple same-file lines into one
    // evidence record while the legacy contract exposes every occurrence.
    // Regex searches intentionally return no grouped records and retain their
    // lexical ripgrep output as the supported fallback. The same fallback is
    // needed when structured analysis has no scheduled records (for example,
    // an eligible lexical producer can be independent of the analyzed source).
    if (!options.regex && structured.intent !== "text" && structured.matches.length > 0) {
      lexical.matches = structured.matches.map(({ path, line, text, text_status, reason, source, reasons }) => {
        // Relationship producers synthesize text from graph paths rather than
        // a complete source line. Keep that derived text redacted before the
        // server's compatibility-preserving text restoration pass.
        const body = source === "built-in analysis" && reasons.includes("exact text match")
          ? text
          : redactSensitiveTextPreservingLines(text, {
            context: "source",
            language: sourceLanguageForPath(path)
          });
        // Invariant: the unavailable marker is never available/redacted, and a
        // missing status defaults from actual marker evidence.
        const status: SearchTextStatus = body === UNAVAILABLE_SEARCH_CONTEXT
          ? "unavailable"
          : (text_status ?? statusForDerivedSearchText(body));
        return {
          path,
          line,
          text: body,
          text_status: status,
          ...(reason !== undefined
            ? { reason }
            : status === "unavailable" ? { reason: "io-error" as const } : {})
        };
      });
      lexical.text = lexical.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || "No matches.";
    }
    lexical.analysis = structured;
  } catch (error) {
    lexical.analysis = {
      schemaVersion: 1,
      query: redactSearchQuery(query, lexical.matches.map((match) => match.text)),
      intent: rawOptions.intent && rawOptions.intent !== "auto" ? rawOptions.intent : "text",
      groups: { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] },
      matches: [],
      coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0, relationshipCount: 0, truncated: true, warnings: [] },
      warnings: [`Repository analysis unavailable: ${redactDiagnosticText(error instanceof Error ? error.message : String(error))}`],
      cache: { hit: false, key: "unavailable" }
    };
  }
  return lexical;
}
