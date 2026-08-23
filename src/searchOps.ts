import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { listFiles, textScanByteLimit } from "./fsOps.js";
import { redactDiagnosticText, redactSearchQuery, redactSensitiveTextPreservingLines } from "./redact.js";
import { searchWorkspaceStructured, type AnalysisSearchIntent, type StructuredSearchResult } from "./analysis/index.js";

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

function decodeSearchText(buffer: Buffer): string | null {
  if (buffer.includes(0)) return null;
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    return null;
  }
}

function redactSearchBuffer(buffer: Buffer): RedactedSearchLines {
  const source = decodeSearchText(buffer);
  if (source === null) return null;
  return redactSensitiveTextPreservingLines(source).split(/\r?\n/);
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
    return buffer ? redactSearchBuffer(buffer) : null;
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

async function runRipgrep(config: CodexProConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const args = ["--json", "--line-number", "--with-filename", "--no-heading", "--color=never", "--max-columns", "500", "--max-count", "50", "--max-filesize", String(textScanByteLimit(config))];
  if (!options.regex) args.push("--fixed-strings");
  if (options.includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  // Pass the query via -e so patterns beginning with "-" (e.g. "->", "--flag")
  // are treated as the search term instead of ripgrep options.
  args.push("-e", options.query, "--", target.absPath);
  const redactedLinesByPath = new Map<string, RedactedSearchLines>();

  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    let outputLimited = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!outputLimited && Buffer.byteLength(stdout, "utf8") > config.maxOutputBytes) {
        outputLimited = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code && code > 1) {
        reject(new CodexProError(stderr.trim() || `ripgrep failed with exit code ${code}`));
        return;
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const lines = stdout.split("\n").filter(Boolean);
      let visibleMatches = 0;
      for (const line of lines) {
        let value: any;
        try {
          value = JSON.parse(line);
        } catch (error) {
          if (outputLimited) continue;
          reject(new CodexProError(`ripgrep returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        if (value.type !== "match") continue;
        const absPath = path.resolve(value.data?.path?.text ?? "");
        const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
        if (rel.startsWith("..")) continue;
        if (guard.isBlockedRelativePath(rel)) continue;
        visibleMatches += 1;
        if (matches.length >= options.maxResults) continue;
        const lineText = String(value.data?.lines?.text ?? "").replace(/\r?\n$/, "");
        const lineNumber = Number(value.data?.line_number ?? 0);
        if (!redactedLinesByPath.has(rel)) {
          redactedLinesByPath.set(rel, await loadRedactedSearchLines(config, guard, workspace, rel));
        }
        matches.push({
          path: rel || ".",
          line: lineNumber,
          text: selectRedactedSearchLine(redactedLinesByPath.get(rel) ?? null, lineNumber)
        });
      }
      const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
      resolve({ text, matches, truncated: visibleMatches > matches.length || outputLimited, used: "ripgrep" });
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
      const redactedLines = redactSearchBuffer(buffer);
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
  const options: SearchOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults)),
    intent: rawOptions.intent,
    symbol: rawOptions.symbol,
    includeTests: rawOptions.includeTests
  };
  let lexical: SearchResult;
  if (await commandExists("rg")) {
    lexical = await runRipgrep(config, guard, workspace, options);
  } else if (options.regex) {
    throw new CodexProError("regex search requires ripgrep. Install rg or retry with regex=false.");
  } else {
    lexical = await runNodeSearch(config, guard, workspace, options);
  }
  const structuredRequested = rawOptions.intent !== undefined || rawOptions.symbol !== undefined || rawOptions.includeTests !== undefined;
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
      regex: Boolean(rawOptions.regex),
      root: options.root,
      maxResults: options.maxResults
    });
    // Binary/NUL files may be found by lexical ripgrep while analysis has no
    // decodable inventory or structured matches. Use both redacted producers
    // before echoing the query, including the regex structured route.
    structured.query = redactSearchQuery(query, [
      ...lexical.matches.map((match) => match.text),
      ...structured.matches.map((match) => match.text)
    ]);
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
