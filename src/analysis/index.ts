import type { CodexProConfig } from "../config.js";
import fsp from "node:fs/promises";
import { TextDecoder } from "node:util";
import { isHiddenRelativePath } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSearchQuery, redactSensitiveTextPreservingLines, sourceLanguageForPath } from "../redact.js";
import { detectProjectTypes } from "./classify.js";
import { getCachedWorkspaceAnalysis, invalidateWorkspaceAnalysis, setCachedWorkspaceAnalysis } from "./cache.js";
import { extractWorkspaceFiles } from "./extract.js";
import { buildRelationshipsWithCoverage } from "./graph.js";
import { inventoryWorkspace } from "./inventory.js";
import { classifySearchIntent, emptySearchGroups, groupForFile, sortStructuredMatches } from "./rank.js";
import type { AnalysisSearchIntent, StructuredSearchMatch, StructuredSearchResult, WorkspaceAnalysis } from "./types.js";

const REDACTED_SEARCH_CONTEXT = "[REDACTED_SECRET]";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_ADDITIONAL_OCCURRENCE_LINES = 16;
const CONFIDENCE_RANK: Record<StructuredSearchMatch["confidence"], number> = { exact: 0, inferred: 1, strong: 2 };

function structuredEvidenceKey(match: Pick<StructuredSearchMatch, "path" | "line" | "group">): string {
  return `${match.path}\u0000${match.line}\u0000${match.group}`;
}

function occurrenceGroupKey(match: Pick<StructuredSearchMatch, "path" | "group">): string {
  return `${match.path}\u0000${match.group}`;
}

function orderedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function evidenceQualityCompare(a: StructuredSearchMatch, b: StructuredSearchMatch): number {
  return b.score - a.score
    || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    || a.line - b.line
    || a.text.localeCompare(b.text)
    || a.source.localeCompare(b.source);
}

function mergeEvidenceMatches(a: StructuredSearchMatch, b: StructuredSearchMatch): StructuredSearchMatch {
  const winner = evidenceQualityCompare(a, b) <= 0 ? a : b;
  const sources = orderedUnique([
    ...(a.provenance ?? [a.source]),
    ...(b.provenance ?? [b.source])
  ]);
  const merged: StructuredSearchMatch = {
    ...winner,
    score: Math.max(a.score, b.score),
    confidence: CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence] ? a.confidence : b.confidence,
    reasons: orderedUnique([...a.reasons, ...b.reasons])
  };
  if (sources.length > 1) merged.provenance = sources;
  else if (winner.provenance?.length) merged.provenance = sources;
  else delete merged.provenance;
  // A source-line producer is the safest text for an exact path/line merge;
  // relationship-only records retain their derived text when no source line
  // exists. The score/confidence above still preserve the strongest semantics.
  const sourceLine = a.line === b.line && a.path === b.path && a.group === b.group
    ? [a, b].find((match) => match.source === "built-in analysis")
    : undefined;
  if (sourceLine) {
    merged.text = sourceLine.text;
    merged.source = "built-in analysis";
  }
  return merged;
}

/**
 * Internal structured evidence owner. Raw producer candidates enter once,
 * exact path/line/group identities merge, and non-definition same-file/group
 * lines compress at finalization so candidate limits remain truthful.
 */
class StructuredEvidenceAccumulator {
  private readonly byIdentity = new Map<string, StructuredSearchMatch>();

  add(match: StructuredSearchMatch): void {
    const key = structuredEvidenceKey(match);
    const existing = this.byIdentity.get(key);
    this.byIdentity.set(key, existing ? mergeEvidenceMatches(existing, match) : { ...match, reasons: [...match.reasons] });
  }

  finalize(): StructuredSearchMatch[] {
    const definitions: StructuredSearchMatch[] = [];
    const nonDefinitions = new Map<string, StructuredSearchMatch[]>();
    for (const match of this.byIdentity.values()) {
      if (match.group === "definitions") {
        definitions.push(match);
        continue;
      }
      const key = occurrenceGroupKey(match);
      const entries = nonDefinitions.get(key) ?? [];
      entries.push(match);
      nonDefinitions.set(key, entries);
    }

    const compressed: StructuredSearchMatch[] = [...definitions];
    for (const entries of nonDefinitions.values()) {
      const representative = [...entries].sort(evidenceQualityCompare)[0];
      const lines = [...new Set(entries.map((entry) => entry.line))].sort((a, b) => a - b);
      const extraLines = lines.filter((line) => line !== representative.line);
      let merged = entries.filter((entry) => entry !== representative).reduce(mergeEvidenceMatches, representative);
      // The representative may have been replaced by reduce's quality merge;
      // line provenance is physical and therefore derived from every entry.
      merged = { ...merged, reasons: orderedUnique(entries.flatMap((entry) => entry.reasons)) };
      const sources = orderedUnique(entries.flatMap((entry) => entry.provenance ?? [entry.source]));
      if (sources.length > 1) merged.provenance = sources;
      if (lines.length > 1) {
        merged.occurrenceCount = lines.length;
        merged.additionalLines = extraLines.slice(0, MAX_ADDITIONAL_OCCURRENCE_LINES);
        merged.additionalLinesTruncated = extraLines.length > MAX_ADDITIONAL_OCCURRENCE_LINES;
      }
      compressed.push(merged);
    }
    return compressed;
  }
}

function decodeSearchBuffer(buffer: Buffer): { text: string; contextAvailable: boolean } {
  if (buffer.includes(0)) return { text: buffer.toString("utf8"), contextAvailable: false };
  try {
    return { text: UTF8_DECODER.decode(buffer), contextAvailable: true };
  } catch {
    return { text: buffer.toString("utf8"), contextAvailable: false };
  }
}

function cacheKey(workspace: Workspace, fingerprint: string, config: CodexProConfig): string {
  return `${workspace.id}:${fingerprint}:${JSON.stringify(config.analysisLimits)}`;
}

function areasFor(files: WorkspaceAnalysis["files"]): WorkspaceAnalysis["areas"] {
  const counts = new Map<string, { role: WorkspaceAnalysis["files"][number]["role"]; files: number }>();
  for (const file of files) {
    const top = file.path.includes("/") ? file.path.split("/")[0] : ".";
    const current = counts.get(top) ?? { role: file.role, files: 0 };
    current.files += 1;
    if (current.role === "other" && file.role !== "other") current.role = file.role;
    counts.set(top, current);
  }
  return [...counts.entries()].map(([areaPath, value]) => ({ path: areaPath, ...value })).sort((a, b) => b.files - a.files || a.path.localeCompare(b.path));
}

export async function inspectWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<WorkspaceAnalysis> {
  if (!config.analysisEnabled) throw new Error("Repository analysis is disabled by CODEXPRO_ANALYSIS=0.");
  const inventory = await inventoryWorkspace(config, guard, workspace);
  const key = cacheKey(workspace, inventory.fingerprint, config);
  const cached = getCachedWorkspaceAnalysis(key);
  if (cached) return { ...cached, cache: { hit: true, key } };

  const extraction = await extractWorkspaceFiles(config, guard, workspace, inventory.files);
  const symbols = extraction.files
    .flatMap((file) => file.symbols)
    .sort((a, b) => Number(isHiddenRelativePath(a.path)) - Number(isHiddenRelativePath(b.path)) || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, config.analysisLimits.maxSymbols);
  const relationshipResult = buildRelationshipsWithCoverage(extraction.files, inventory.files, config.analysisLimits.maxRelationships);
  const relationships = relationshipResult.relationships;
  const languages = [...new Set(inventory.files.map((file) => file.language).filter((language) => language !== "unknown"))].sort();
  const warnings = [
    ...inventory.coverage.warnings,
    ...extraction.warnings,
    ...(relationshipResult.truncated ? ["Relationship extraction reached its configured limit."] : [])
  ];
  const result: WorkspaceAnalysis = {
    schemaVersion: 1,
    workspaceId: workspace.id,
    root: workspace.root,
    languages,
    projectTypes: detectProjectTypes(inventory.files),
    entrypoints: inventory.files.filter((file) => file.entrypoint).map((file) => file.path),
    importantFiles: inventory.files.filter((file) => file.role === "config" || /(^|\/)(README|AGENTS)\.md$/i.test(file.path)).map((file) => file.path),
    areas: areasFor(inventory.files),
    files: inventory.files,
    symbols,
    relationships,
    coverage: {
      ...inventory.coverage,
      analyzedFiles: extraction.analyzedFiles,
      scannedBytes: extraction.scannedBytes,
      symbolCount: symbols.length,
      relationshipCount: relationships.length,
      truncated: inventory.coverage.truncated || extraction.truncated || relationshipResult.truncated,
      warnings
    },
    warnings,
    fingerprint: inventory.fingerprint,
    cache: { hit: false, key }
  };
  setCachedWorkspaceAnalysis(key, result);
  return result;
}

export async function searchWorkspaceStructured(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { query: string; intent?: AnalysisSearchIntent; includeTests?: boolean; includeHidden?: boolean; regex?: boolean; root?: string; maxResults?: number }
): Promise<StructuredSearchResult> {
  const query = options.query.trim();
  if (!query) throw new Error("query is required.");
  const analysis = await inspectWorkspace(config, guard, workspace);
  const intent = classifySearchIntent(query, options.intent ?? "auto", options.regex);
  const groups = emptySearchGroups();
  const lowered = query.toLowerCase();
  const accumulator = new StructuredEvidenceAccumulator();
  const warnings = [...analysis.warnings];
  const resultLimit = Math.max(1, Math.min(options.maxResults ?? config.maxSearchResults, config.maxSearchResults));
  const candidateLimit = Math.max(resultLimit, Math.min(resultLimit * 4, 20_000));
  const resolvedRoot = options.root?.trim() ? guard.resolve(workspace, options.root).relPath.replace(/^\.\/?$/, "") : "";
  const inScope = (filePath: string) => !resolvedRoot || filePath === resolvedRoot || filePath.startsWith(`${resolvedRoot}/`);
  const includePath = (filePath: string) => options.includeHidden === true || !isHiddenRelativePath(filePath);
  if (resolvedRoot && options.includeHidden !== true && isHiddenRelativePath(resolvedRoot)) {
    return {
      schemaVersion: 2,
      query: redactSearchQuery(query),
      intent,
      groups,
      matches: [],
      coverage: { ...analysis.coverage, warnings },
      warnings,
      cache: analysis.cache
    };
  }
  const definitionsByPath = new Map<string, Map<number, WorkspaceAnalysis["symbols"][number]>>();
  for (const symbol of analysis.symbols) {
    if (!includePath(symbol.path)) continue;
    const byLine = definitionsByPath.get(symbol.path) ?? new Map<number, WorkspaceAnalysis["symbols"][number]>();
    byLine.set(symbol.line, symbol);
    definitionsByPath.set(symbol.path, byLine);
  }
  if (options.regex) {
    warnings.push("Grouped results are unavailable for regular expression searches. Lexical regex matching remains delegated to ripgrep.");
    return {
      schemaVersion: 2,
      query: redactSearchQuery(query),
      intent,
      groups,
      matches: [],
      coverage: { ...analysis.coverage, truncated: true, warnings },
      warnings,
      cache: analysis.cache
    };
  }
  let scannedFiles = 0;
  let scannedBytes = 0;
  let searchBudgetReached = false;
  let candidateLimitReached = false;
  let skippedFiles = 0;
  let candidateCount = 0;

  scan:
  for (const file of analysis.files) {
    if (!includePath(file.path) || file.generated || (!options.includeTests && file.role === "test")) continue;
    if (!inScope(file.path) && !(options.includeTests && file.role === "test")) continue;
    if (scannedFiles >= config.analysisLimits.maxAnalyzedFiles || scannedBytes + file.bytes > config.analysisLimits.maxScannedBytes) {
      searchBudgetReached = true;
      break;
    }
    let text: string;
    let contextAvailable = true;
    let sourceBytes = 0;
    try {
      const resolved = guard.resolve(workspace, file.path);
      const buffer = await fsp.readFile(resolved.absPath);
      sourceBytes = buffer.byteLength;
      const decoded = decodeSearchBuffer(buffer);
      text = decoded.text;
      contextAvailable = decoded.contextAvailable;
    } catch {
      skippedFiles += 1;
      continue;
    }
    const actualBytes = sourceBytes;
    if (scannedBytes + actualBytes > config.analysisLimits.maxScannedBytes) {
      searchBudgetReached = true;
      break;
    }
    scannedFiles += 1;
    scannedBytes += actualBytes;
    const definitions = definitionsByPath.get(file.path) ?? new Map();
    const lines = text.split(/\r?\n/);
    let redactedLines: string[] | null | undefined = contextAvailable ? undefined : null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toLowerCase().includes(lowered)) continue;
      if (contextAvailable) {
        redactedLines ??= redactSensitiveTextPreservingLines(text, {
          context: "source",
          language: sourceLanguageForPath(file.path)
        }).split(/\r?\n/);
      }
      const symbol = definitions.get(index + 1);
      const isDefinition = Boolean(symbol && symbol.name.toLowerCase() === lowered);
      const group = groupForFile(analysis, file.path, isDefinition);
      const reasons = isDefinition ? ["exact text match", "symbol definition"] : file.role === "test" ? ["exact text match", "related test"] : ["exact text match"];
      if (candidateCount >= candidateLimit) {
        candidateLimitReached = true;
        break scan;
      }
      candidateCount += 1;
      accumulator.add({
        path: file.path,
        line: index + 1,
        text: (redactedLines?.[index] ?? REDACTED_SEARCH_CONTEXT).trim().slice(0, 400),
        group,
        score: isDefinition ? 190 : file.role === "test" ? 160 : 100,
        reasons,
        confidence: isDefinition ? "strong" : "exact",
        source: "built-in analysis"
      });
    }
  }

  if (searchBudgetReached) warnings.push("Grouped search reached its configured file or byte limit.");
  if (skippedFiles) warnings.push(`Grouped search skipped ${skippedFiles} file${skippedFiles === 1 ? "" : "s"} that changed or became unreadable during analysis.`);

  if (intent === "references" || intent === "impact") {
    const definitionPaths = new Set(
      analysis.symbols
        .filter((symbol) => includePath(symbol.path) && symbol.name.toLowerCase() === lowered)
        .map((symbol) => symbol.path)
    );
    for (const relationship of analysis.relationships) {
      if (!includePath(relationship.from) || !includePath(relationship.to)) continue;
      if (!definitionPaths.has(relationship.to)) continue;
      const group = relationship.kind === "tests" ? "tests" : "references";
      if (group === "tests" && !options.includeTests) continue;
      const reason = relationship.kind === "tests" ? "dependent test" : "dependent module";
      if (candidateCount >= candidateLimit) {
        candidateLimitReached = true;
        continue;
      }
      candidateCount += 1;
      accumulator.add({
        path: relationship.from,
        line: 1,
        text: `${relationship.kind} ${relationship.to}`,
        group,
        score: relationship.kind === "tests" ? 170 : 165,
        reasons: [reason, `${relationship.kind} relationship`],
        confidence: "strong",
        source: relationship.source
      });
    }
  }

  if (candidateLimitReached) warnings.push(`Grouped search retained the first ${candidateLimit} candidates before ranking.`);

  const matches = accumulator.finalize();
  for (const match of sortStructuredMatches(matches).slice(0, resultLimit)) groups[match.group].push(match);
  const orderedMatches = Object.values(groups).flat();
  return {
    schemaVersion: 2,
    query: redactSearchQuery(query, orderedMatches.map((match) => match.text)),
    intent,
    groups,
    matches: orderedMatches,
    coverage: {
      ...analysis.coverage,
      truncated: analysis.coverage.truncated || searchBudgetReached || candidateLimitReached || skippedFiles > 0,
      warnings
    },
    warnings,
    cache: analysis.cache
  };
}

export { invalidateWorkspaceAnalysis } from "./cache.js";
export { reviewWorkspaceChanges } from "./impact.js";
export { listAnalysisProviders, normalizeProviderPaths, registerAnalysisProvider } from "./providers.js";
export type * from "./types.js";
