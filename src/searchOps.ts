import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { isHiddenRelativePath, listFiles, textScanByteLimit } from "./fsOps.js";
import { redactDiagnosticText, redactSearchQuery, redactSensitiveTextPreservingLines, sourceLanguageForPath, truncateUtf8 } from "./redact.js";
import { searchWorkspaceStructured, type AnalysisSearchIntent, type StructuredSearchMatch, type StructuredSearchResult } from "./analysis/index.js";

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
  matches: Array<{ path: string; line: number; text: string }>;
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

type RedactedSearchLines = string[] | null;
const REDACTED_SEARCH_CONTEXT = "[REDACTED_SECRET]";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const RIPGREP_PARTIAL_RECORD_MAX_BYTES = 64 * 1024;

function decodeSearchText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    return null;
  }
}

function redactSearchBuffer(buffer: Buffer, relativePath?: string): RedactedSearchLines {
  const source = decodeSearchText(buffer);
  if (source === null) return null;
  return redactSensitiveTextPreservingLines(source, {
    context: "source",
    language: sourceLanguageForPath(relativePath ?? "")
  }).split(/\r?\n/);
}

async function readSearchBufferBounded(absPath: string, limit: number): Promise<Buffer | null> {
  const handle = await fsp.open(absPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit || offset < stat.size) return null;
    const finalStat = await handle.stat();
    if (finalStat.size !== offset || finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs) return null;
    const result = buffer.subarray(0, offset);
    return result.includes(0) ? null : result;
  } finally {
    await handle.close();
  }
}

async function loadRedactedSearchLines(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  relativePath: string
): Promise<RedactedSearchLines> {
  try {
    const resolved = guard.resolve(workspace, relativePath);
    const buffer = await readSearchBufferBounded(resolved.absPath, textScanByteLimit(config));
    return buffer ? redactSearchBuffer(buffer, relativePath) : null;
  } catch {
    return null;
  }
}

function selectRedactedSearchLine(lines: RedactedSearchLines, lineNumber: number): string {
  const contextualLine = lines?.[lineNumber - 1];
  return contextualLine === undefined
    ? REDACTED_SEARCH_CONTEXT
    : truncateLine(contextualLine);
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

async function runRipgrep(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const target = guard.resolve(workspace, options.root ?? ".");
  if (options.includeHidden === false && isHiddenRelativePath(target.relPath)) {
    return { text: "No matches.", matches: [], truncated: false, used: "ripgrep" };
  }
  const args = ["--json", "--line-number", "--with-filename", "--no-heading", "--color=never", "--max-columns", "500", "--max-count", "50", "--max-filesize", String(textScanByteLimit(config))];
  if (!options.regex) args.push("--fixed-strings");
  if (options.includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  if (options.deterministicOrder) args.push("--sort", "path");
  // Pass the query via -e so patterns beginning with "-" (e.g. "->", "--flag")
  // are treated as the search term instead of ripgrep options.
  args.push("-e", options.query, "--", target.absPath);
  const redactedLinesByPath = new Map<string, RedactedSearchLines>();

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

        const matches: Array<{ path: string; line: number; text: string }> = [];
        for (const admitted of admittedMatches) {
          if (settled) return;
          if (!redactedLinesByPath.has(admitted.path)) {
            redactedLinesByPath.set(admitted.path, await loadRedactedSearchLines(config, guard, workspace, admitted.path));
          }
          matches.push({
            path: admitted.path,
            line: admitted.line,
            text: selectRedactedSearchLine(redactedLinesByPath.get(admitted.path) ?? null, admitted.line)
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
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let visibleMatches = 0;
  const scanBytes = textScanByteLimit(config);
  for (const rel of files) {
    if (visibleMatches > options.maxResults) break;
    const resolved = guard.resolve(workspace, rel);
    try {
      const buffer = await readSearchBufferBounded(resolved.absPath, scanBytes);
      if (!buffer) continue;
      const source = decodeSearchText(buffer);
      if (source === null) continue;
      const lines = source.split(/\r?\n/);
      const redactedLines = redactSearchBuffer(buffer, rel);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const hit = line.includes(options.query);
        if (hit) {
          visibleMatches += 1;
          if (matches.length < options.maxResults) {
            matches.push({ path: rel, line: i + 1, text: selectRedactedSearchLine(redactedLines, i + 1) });
          }
          if (visibleMatches > options.maxResults) break;
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
  return { text, matches, truncated: visibleMatches > matches.length, used: "node" };
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
      maxResults: options.maxResults
    });
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
      lexical.matches = structured.matches.map(({ path, line, text, source, reasons }) => ({
        path,
        line,
        // Relationship producers synthesize text from graph paths rather than
        // a complete source line. Keep that derived text redacted before the
        // server's compatibility-preserving text restoration pass.
        text: source === "built-in analysis" && reasons.includes("exact text match")
          ? text
          : redactSensitiveTextPreservingLines(text, {
            context: "source",
            language: sourceLanguageForPath(path)
          })
      }));
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
