import type { CodexProConfig } from "../config.js";
import fsp from "node:fs/promises";
import { TextDecoder } from "node:util";
import { isHiddenRelativePath } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSearchQuery, redactSensitiveTextPreservingLines, sourceLanguageForPath } from "../redact.js";
import { detectProjectTypes } from "./classify.js";
import { getCachedWorkspaceAnalysis, invalidateWorkspaceAnalysis, setCachedWorkspaceAnalysis } from "./cache.js";
import { extractWorkspaceFiles } from "./extract.js";
import { buildRelationshipsWithCoverage, IMPACT_TRAVERSAL_TRUNCATION_WARNING, traverseImpactGraph } from "./graph.js";
import { inventoryWorkspace } from "./inventory.js";
import { BUDGET_TRUNCATION_WARNING, classifyDefinitionMatch, classifySearchIntent, emptySearchGroups, groupForFile, scheduleStructuredMatches, sortStructuredMatches } from "./rank.js";
import { resolveSearchScope, searchScopeCacheKey } from "./scope.js";
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
  const allReasons = [...a.reasons, ...b.reasons];
  const hasRelationship = allReasons.some((r) => r.includes("dependent") || r.includes("imports") || r.includes("tests"));
  const hasTextMatch = allReasons.some((r) => r.includes("exact text match") || r.includes("symbol definition"));
  const boost = (hasRelationship && hasTextMatch) ? 5 : 0;
  const merged: StructuredSearchMatch = {
    ...winner,
    score: Math.max(a.score, b.score) + boost,
    confidence: CONFIDENCE_RANK[a.confidence] >= CONFIDENCE_RANK[b.confidence] ? a.confidence : b.confidence,
    reasons: orderedUnique(allReasons)
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
  private readonly logicalKeys = new Set<string>();
  private readonly testLogicalKeys = new Set<string>();
  private readonly sourceLogicalKeys = new Set<string>();

  /**
   * Admit one producer record while counting only the logical identity that
   * survives finalization. Repeated non-definition lines in one file/group
   * therefore do not exhaust the candidate window before later evidence can
   * be considered; distinct definitions remain line-addressable.
   * Tests are tracked independently from source candidates so include_tests=true
   * cannot starve source references.
   */
  add(match: StructuredSearchMatch, candidateLimit?: number, testCandidateLimit?: number): boolean {
    const isTest = match.group === "tests";
    const logicalKey = match.group === "definitions"
      ? structuredEvidenceKey(match)
      : occurrenceGroupKey(match);
    if (!this.logicalKeys.has(logicalKey)) {
      if (isTest) {
        const limit = testCandidateLimit ?? candidateLimit;
        if (limit !== undefined && this.testLogicalKeys.size >= limit) return false;
        this.testLogicalKeys.add(logicalKey);
      } else {
        if (candidateLimit !== undefined && this.sourceLogicalKeys.size >= candidateLimit) return false;
        this.sourceLogicalKeys.add(logicalKey);
      }
      this.logicalKeys.add(logicalKey);
    }
    const key = structuredEvidenceKey(match);
    const existing = this.byIdentity.get(key);
    this.byIdentity.set(key, existing ? mergeEvidenceMatches(existing, match) : { ...match, reasons: [...match.reasons] });
    return true;
  }

  has(path: string, group: string): boolean {
    return this.logicalKeys.has(`${path}\u0000${group}`);
  }

  entriesFor(path: string, group: string): StructuredSearchMatch[] {
    return [...this.byIdentity.values()].filter((match) => match.path === path && match.group === group);
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
        if (extraLines.length > MAX_ADDITIONAL_OCCURRENCE_LINES) {
          merged.additionalLinesTruncated = true;
        }
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
  options: { query: string; intent?: AnalysisSearchIntent; includeTests?: boolean; includeHidden?: boolean; regex?: boolean; root?: string; glob?: string; maxResults?: number }
): Promise<StructuredSearchResult> {
  const query = options.query.trim();
  if (!query) throw new Error("query is required.");
  const analysis = await inspectWorkspace(config, guard, workspace);
  const lowered = query.toLowerCase();
  const scope = resolveSearchScope(guard, workspace, options);
  const includePath = scope.matches;
  const scopedCacheKey = searchScopeCacheKey(scope);
  const cache = scopedCacheKey
    ? { hit: analysis.cache.hit, key: `${analysis.cache.key}:scope:${scopedCacheKey}` }
    : analysis.cache;
  const hasSymbolEvidence = analysis.symbols.some((symbol) => {
    if (!includePath(symbol.path)) return false;
    const nameLower = symbol.name.toLowerCase();
    return symbol.name === query || nameLower === lowered || symbol.name.startsWith(query) || nameLower.startsWith(lowered);
  });
  const intent = classifySearchIntent(query, options.intent ?? "auto", options.regex, hasSymbolEvidence);
  const groups = emptySearchGroups();
  const accumulator = new StructuredEvidenceAccumulator();
  const warnings = [...analysis.warnings];
  const resultLimit = Math.max(1, Math.min(options.maxResults ?? config.maxSearchResults, config.maxSearchResults));
  const candidateLimit = Math.max(resultLimit, Math.min(resultLimit * 4, 20_000));
  const testCandidateLimit = candidateLimit;
  if (scope.root && !scope.includeHidden && isHiddenRelativePath(scope.root)) {
    return {
      schemaVersion: 2,
      query: redactSearchQuery(query),
      intent,
      groups,
      matches: [],
      coverage: { ...analysis.coverage, warnings },
      warnings,
      cache
    };
  }
  const definitionsByPath = new Map<string, Map<number, WorkspaceAnalysis["symbols"][number][]>>();
  for (const symbol of analysis.symbols) {
    if (!includePath(symbol.path)) continue;
    const byLine = definitionsByPath.get(symbol.path) ?? new Map<number, WorkspaceAnalysis["symbols"][number][]>();
    const list = byLine.get(symbol.line) ?? [];
    list.push(symbol);
    byLine.set(symbol.line, list);
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
      cache
    };
  }
  let scannedFiles = 0;
  let scannedBytes = 0;
  let searchBudgetReached = false;
  let candidateLimitReached = false;
  let sourceCandidateLimitReached = false;
  let testCandidateLimitReached = false;
  let impactTraversalTruncated = false;
  let skippedFiles = 0;
  const firstTestLineText = new Map<string, string>();

  const scopedFiles = analysis.files.filter((file) => includePath(file.path));

  scan:
  for (const file of scopedFiles) {
    if (file.generated) continue;
    if (!options.includeTests && file.role === "test") continue;
    if (file.role === "test" && testCandidateLimitReached) continue;
    if (file.role !== "test" && sourceCandidateLimitReached) {
      if (!options.includeTests || testCandidateLimitReached) break scan;
      continue;
    }
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
    if (file.role === "test") {
      if (contextAvailable) {
        redactedLines = redactSensitiveTextPreservingLines(text, {
          context: "source",
          language: sourceLanguageForPath(file.path)
        }).split(/\r?\n/);
      }
      firstTestLineText.set(file.path, (redactedLines?.[0] ?? REDACTED_SEARCH_CONTEXT).trim().slice(0, 400));
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toLowerCase().includes(lowered)) continue;
      if (contextAvailable) {
        redactedLines ??= redactSensitiveTextPreservingLines(text, {
          context: "source",
          language: sourceLanguageForPath(file.path)
        }).split(/\r?\n/);
      }
      const lineSymbols = definitions.get(index + 1);
      let bestDefTier: ReturnType<typeof classifyDefinitionMatch> = null;
      if (lineSymbols) {
        for (const sym of lineSymbols) {
          const tier = classifyDefinitionMatch(sym, query);
          if (tier && (!bestDefTier || tier.score > bestDefTier.score)) {
            bestDefTier = tier;
          }
        }
      }
      const isDefinition = bestDefTier !== null;
      const group = groupForFile(analysis, file.path, isDefinition, file.role);
      const reasons = bestDefTier
        ? bestDefTier.nameTier === 0
          ? ["exact text match", "symbol definition", "exact symbol match"]
          : ["exact text match", "symbol definition"]
        : file.role === "test"
          ? ["exact text match", "related test"]
          : ["exact text match"];
      const score = bestDefTier
        ? bestDefTier.score
        : file.role === "source"
          ? 150
          : file.role === "test"
            ? 130
            : file.role === "config"
              ? 110
              : file.role === "docs"
                ? 100
                : 90;
      const admitted = accumulator.add({
        path: file.path,
        line: index + 1,
        text: (redactedLines?.[index] ?? REDACTED_SEARCH_CONTEXT).trim().slice(0, 400),
        group,
        score,
        reasons,
        confidence: isDefinition ? "strong" : "exact",
        source: "built-in analysis"
      }, candidateLimit, testCandidateLimit);
      if (!admitted) {
        if (group === "tests") {
          testCandidateLimitReached = true;
        } else {
          sourceCandidateLimitReached = true;
        }
        if (sourceCandidateLimitReached && (!options.includeTests || testCandidateLimitReached)) {
          candidateLimitReached = true;
          break scan;
        }
      }
    }
  }

  if (searchBudgetReached) warnings.push("Grouped search reached its configured file or byte limit.");
  if (skippedFiles) warnings.push(`Grouped search skipped ${skippedFiles} file${skippedFiles === 1 ? "" : "s"} that changed or became unreadable during analysis.`);

  if (intent === "impact") {
    const definitionPaths = new Set(
      analysis.symbols
        .filter((symbol) => includePath(symbol.path) && classifyDefinitionMatch(symbol, query) !== null)
        .map((symbol) => symbol.path)
    );
    const impactTraversal = traverseImpactGraph(definitionPaths, analysis.relationships, {
      maxDepth: 3,
      maxCandidates: candidateLimit,
      includeTests: Boolean(options.includeTests),
      includePath
    });
    impactTraversalTruncated = impactTraversal.truncated;
    if (impactTraversal.truncated) warnings.push(IMPACT_TRAVERSAL_TRUNCATION_WARNING);
    for (const res of impactTraversal.results) {
      const group = res.kind === "tests" ? "tests" : "references";
      const score = res.kind === "tests"
        ? (res.depth === 1 ? 166 : 158)
        : (res.depth === 1 ? 170 : 162);
      const line = res.line;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) continue;
      const admitted = accumulator.add({
        path: res.path,
        line,
        text: res.text ?? `${res.kind} ${res.target ?? res.via ?? [...definitionPaths][0] ?? query}`,
        group,
        score,
        reasons: res.reasons,
        confidence: "strong",
        source: res.source ?? "built-in import extraction"
      }, candidateLimit, testCandidateLimit);
      if (!admitted) {
        if (group === "tests") testCandidateLimitReached = true;
        else sourceCandidateLimitReached = true;
        candidateLimitReached = true;
      }
    }
    if (options.includeTests) {
      const defBasenames = [...definitionPaths].map((p) => p.split("/").pop()?.replace(/\.[^.]+$/, "").toLowerCase()).filter(Boolean) as string[];
      const queryStem = query.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
      for (const file of scopedFiles) {
        if (!includePath(file.path) || file.role !== "test" || file.generated) continue;
        const fileLower = (file.path.split("/").pop() ?? "").toLowerCase();
        const matchesDef = defBasenames.some((stem) => stem.length > 3 && fileLower.includes(stem));
        const matchesQuery = queryStem.length > 3 && fileLower.replace(/[^a-z0-9]/g, "").includes(queryStem);
        if (matchesDef || matchesQuery) {
          const physicalEntries = accumulator.entriesFor(file.path, "tests");
          const fallbackEntries = physicalEntries.length > 0
            ? physicalEntries
            : [{ line: 1, text: firstTestLineText.get(file.path) ?? REDACTED_SEARCH_CONTEXT }];
          for (const physical of fallbackEntries) {
            accumulator.add({
              path: file.path,
              line: physical.line,
              text: physical.text,
              group: "tests",
              score: 150,
              reasons: ["dependent test", "related test", "test filename matches definition"],
              confidence: "inferred",
              source: "built-in analysis"
            }, candidateLimit, testCandidateLimit);
          }
        }
      }
    }
  } else if (intent === "references") {
    const definitionPaths = new Set(
      analysis.symbols
        .filter((symbol) => includePath(symbol.path) && classifyDefinitionMatch(symbol, query) !== null)
        .map((symbol) => symbol.path)
    );
    for (const relationship of analysis.relationships) {
      if (!includePath(relationship.from) || !includePath(relationship.to)) continue;
      if (!definitionPaths.has(relationship.to)) continue;
      const group = relationship.kind === "tests" ? "tests" : "references";
      if (group === "tests" && !options.includeTests) continue;
      const line = relationship.line;
      if (typeof line !== "number" || !Number.isInteger(line) || line < 1) continue;
      const reason = relationship.kind === "tests" ? "dependent test" : "dependent module";
      const score = relationship.kind === "tests" ? 140 : 165;
      const admitted = accumulator.add({
        path: relationship.from,
        line,
        text: relationship.text ?? `${relationship.kind} ${relationship.to}`,
        group,
        score,
        reasons: [reason, `${relationship.kind} relationship`],
        confidence: "strong",
        source: relationship.source
      }, candidateLimit, testCandidateLimit);
      if (!admitted) {
        if (group === "tests") testCandidateLimitReached = true;
        else sourceCandidateLimitReached = true;
        candidateLimitReached = true;
      }
    }
  }

  if (sourceCandidateLimitReached) {
    warnings.push(`Grouped search retained the first ${candidateLimit} source/non-test candidates before ranking.`);
  }
  if (testCandidateLimitReached) {
    warnings.push(`Grouped search retained the first ${testCandidateLimit} test candidates before ranking.`);
  }
  if (candidateLimitReached && !sourceCandidateLimitReached && !testCandidateLimitReached) {
    warnings.push(`Grouped search retained the first ${candidateLimit} candidates (after logical deduplication) before ranking.`);
  }

  const matches = accumulator.finalize();
  const eligibleMatches = matches.filter((match) => includePath(match.path));

  const measureStructuredPayloadBytes = (candidateMatches: StructuredSearchMatch[]): number => {
    const candidateGroups = emptySearchGroups();
    for (const m of candidateMatches) {
      const reasons = m.reasons.includes("lexical exact match")
        ? m.reasons
        : [...m.reasons, "lexical exact match"].sort((a, b) => a.localeCompare(b));
      const provenance = m.provenance
        ? (m.provenance.includes("lexical") ? m.provenance : [...m.provenance, "lexical"].sort((a, b) => a.localeCompare(b)))
        : [m.source, "lexical"].sort((a, b) => a.localeCompare(b));
      candidateGroups[m.group].push({
        ...m,
        reasons,
        provenance
      });
    }
    const candidateOrdered = Object.values(candidateGroups).flat();
    const candidateLegacyMatches = candidateOrdered.map(({ path, line, text, source, reasons }) => ({
      path,
      line,
      text: source === "built-in analysis" && reasons.includes("exact text match")
        ? text
        : redactSensitiveTextPreservingLines(text, {
          context: "source",
          language: sourceLanguageForPath(path)
        })
    }));
    const trialWarnings = [...warnings];
    if (!trialWarnings.includes(BUDGET_TRUNCATION_WARNING)) {
      trialWarnings.push(BUDGET_TRUNCATION_WARNING);
    }
    const trialEnvelope: Record<string, unknown> = {
      codexpro_tool: "search",
      codexpro_title: "Search Workspace",
      workspace_id: workspace.id,
      root: workspace.root,
      matches: candidateLegacyMatches,
      truncated: true,
      used: 1,
      analysis: {
        schemaVersion: 2,
        query: redactSearchQuery(query, candidateOrdered.map((m) => m.text)),
        intent,
        groups: candidateGroups,
        matches: candidateOrdered,
        coverage: {
          ...analysis.coverage,
          truncated: true,
          warnings: trialWarnings
        },
        warnings: trialWarnings,
        cache
      }
    };
    return Buffer.byteLength(JSON.stringify(trialEnvelope), "utf8") + 128;
  };

  const { matches: scheduled, budgetTruncated } = scheduleStructuredMatches(eligibleMatches, {
    intent,
    resultLimit,
    includeHidden: Boolean(options.includeHidden),
    includeTests: Boolean(options.includeTests),
    calculatePayloadBytes: measureStructuredPayloadBytes
  });
  for (const match of scheduled) groups[match.group].push(match);
  if (budgetTruncated) {
    warnings.push(BUDGET_TRUNCATION_WARNING);
  }
  const orderedMatches = Object.values(groups).flat();
  return {
    schemaVersion: 2,
    query: redactSearchQuery(query, orderedMatches.map((match) => match.text)),
    intent,
    groups,
    matches: orderedMatches,
    coverage: {
      ...analysis.coverage,
      truncated: analysis.coverage.truncated || searchBudgetReached || candidateLimitReached || impactTraversalTruncated || budgetTruncated || skippedFiles > 0,
      warnings
    },
    warnings,
    cache
  };
}

export { invalidateWorkspaceAnalysis } from "./cache.js";
export { reviewWorkspaceChanges } from "./impact.js";
export { listAnalysisProviders, normalizeProviderPaths, registerAnalysisProvider } from "./providers.js";
export type * from "./types.js";
