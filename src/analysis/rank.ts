import { isHiddenRelativePath } from "../fsOps.js";
import type { AnalysisFileRole, AnalysisResultGroup, AnalysisSearchIntent, AnalysisSymbolKind, StructuredSearchMatch, WorkspaceAnalysis } from "./types.js";

const GROUPS = ["definitions", "references", "tests", "configuration", "documentation", "other"] as const;

export function emptySearchGroups(): Record<(typeof GROUPS)[number], StructuredSearchMatch[]> {
  return { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] };
}

/**
 * Definition ranking tiers, deterministic and documented:
 *
 * Name matching tiers:
 * - Tier 0: exact case-sensitive name (name === query)
 * - Tier 1: exact case-insensitive name (name.toLowerCase() === query.toLowerCase())
 * - Tier 2: case-sensitive name prefix (name.startsWith(query))
 * - Tier 3: case-insensitive name prefix (name.toLowerCase().startsWith(query.toLowerCase()))
 *
 * Kind tiers within name tier:
 * - Kind 0: type/class/interface/struct/enum/trait/protocol/type-like
 * - Kind 1: function
 * - Kind 2: incidental variable
 *
 * Type-family rule:
 * When query is a type-family prefix (starts with uppercase, e.g. "BodyForm"),
 * type-like definitions (Kind 0) in tiers 1-3 outrank incidental variables (Kind 2)
 * in tiers 1-3. This prevents a lowercase local variable (e.g. "bodyForm") from
 * becoming the top/sole definition when real BodyForm* classes exist.
 */
export interface DefinitionMatchTier {
  nameTier: 0 | 1 | 2 | 3;
  kindTier: 0 | 1 | 2;
  score: number;
}

export function isTypeLikeKind(kind: AnalysisSymbolKind): boolean {
  return kind === "class" || kind === "interface" || kind === "struct" || kind === "enum" || kind === "trait" || kind === "protocol" || kind === "type";
}

export function symbolKindTier(kind: AnalysisSymbolKind): 0 | 1 | 2 {
  if (isTypeLikeKind(kind)) return 0;
  if (kind === "function") return 1;
  return 2;
}

export function isTypeFamilyPrefix(query: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(query);
}

export function classifyDefinitionMatch(
  symbol: { name: string; kind: AnalysisSymbolKind },
  query: string
): DefinitionMatchTier | null {
  const name = symbol.name;
  const queryLower = query.toLowerCase();
  const nameLower = name.toLowerCase();

  let nameTier: 0 | 1 | 2 | 3;
  if (name === query) {
    nameTier = 0;
  } else if (nameLower === queryLower) {
    nameTier = 1;
  } else if (name.startsWith(query)) {
    nameTier = 2;
  } else if (nameLower.startsWith(queryLower)) {
    nameTier = 3;
  } else {
    return null;
  }

  const kindTier = symbolKindTier(symbol.kind);
  const typeFamilyQuery = isTypeFamilyPrefix(query);

  let score: number;
  if (typeFamilyQuery) {
    if (nameTier === 0) {
      score = 220 - kindTier * 3;
    } else if (kindTier === 0) {
      score = 210 - (nameTier - 1) * 3;
    } else if (kindTier === 1) {
      score = 200 - (nameTier - 1) * 3;
    } else {
      score = 190 - (nameTier - 1) * 3;
    }
  } else {
    score = 220 - nameTier * 10 - kindTier * 3;
  }

  return { nameTier, kindTier, score };
}

export function classifySearchIntent(
  query: string,
  requested: AnalysisSearchIntent = "auto",
  regex = false,
  hasSymbolEvidence?: boolean
): Exclude<AnalysisSearchIntent, "auto"> {
  if (requested !== "auto") return requested;
  if (regex || /\s/.test(query) || /^['"].*['"]$/.test(query)) return "text";
  if (!/^[A-Za-z_$][\w$]*$/.test(query)) return "text";
  if (hasSymbolEvidence !== undefined) {
    return hasSymbolEvidence ? "symbol" : "text";
  }
  return "symbol";
}

export function sortStructuredMatches(matches: StructuredSearchMatch[]): StructuredSearchMatch[] {
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
}

export function groupForFile(
  analysis: WorkspaceAnalysis,
  filePath: string,
  isDefinition: boolean,
  fileRole?: AnalysisFileRole
): StructuredSearchMatch["group"] {
  if (isDefinition) return "definitions";
  const role = fileRole ?? analysis.files.find((file) => file.path === filePath)?.role;
  if (role === "test") return "tests";
  if (role === "config") return "configuration";
  if (role === "docs") return "documentation";
  return "references";
}

export const DEFAULT_STRUCTURED_PAYLOAD_BUDGET_IMPACT = 9_400;
export const DEFAULT_STRUCTURED_PAYLOAD_BUDGET_STANDARD = 14_500;
export const BUDGET_TRUNCATION_WARNING = "Structured search results were truncated to fit the structured payload budget.";

export function defaultStructuredPayloadBudget(
  intent: Exclude<AnalysisSearchIntent, "auto">,
  resultLimit: number,
  maxOutputBytes = 120_000
): number {
  const envBudget = Number(process.env.CODEXPRO_SEARCH_PAYLOAD_BUDGET);
  if (Number.isFinite(envBudget) && envBudget > 0) {
    return Math.min(maxOutputBytes, Math.floor(envBudget));
  }
  const baseBudget = intent === "impact" ? DEFAULT_STRUCTURED_PAYLOAD_BUDGET_IMPACT : DEFAULT_STRUCTURED_PAYLOAD_BUDGET_STANDARD;
  if (resultLimit <= 20) {
    return baseBudget;
  }
  return Math.min(maxOutputBytes, Math.round(baseBudget * (resultLimit / 20)));
}

export function isAffectedSourceModule(match: StructuredSearchMatch): boolean {
  if (match.group !== "references") return false;
  return (match.reasons ?? []).some((r) =>
    r.includes("dependent module") ||
    r.includes("transitive dependent") ||
    r.includes("imports")
  );
}

function fallbackMeasurePayloadBytes(
  selected: StructuredSearchMatch[],
  intent: Exclude<AnalysisSearchIntent, "auto">
): number {
  const groups = emptySearchGroups();
  for (const m of selected) groups[m.group].push(m);
  const ordered = Object.values(groups).flat();
  const legacyMatches = ordered.map(({ path, line, text }) => ({ path, line, text }));
  const payload = {
    workspace_id: "ws_default_workspace",
    root: ".",
    matches: legacyMatches,
    truncated: true,
    used: 1,
    analysis: {
      schemaVersion: 2,
      query: "query",
      intent,
      groups,
      matches: ordered,
      coverage: {
        inventoryFiles: 100,
        analyzedFiles: 100,
        scannedBytes: 1000,
        symbolCount: 100,
        relationshipCount: 100,
        truncated: true,
        warnings: [BUDGET_TRUNCATION_WARNING]
      },
      warnings: [BUDGET_TRUNCATION_WARNING],
      cache: { hit: false }
    }
  };
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

export interface ScheduleStructuredMatchesOptions {
  intent: Exclude<AnalysisSearchIntent, "auto">;
  resultLimit: number;
  includeHidden?: boolean;
  includeTests?: boolean;
  maxPayloadBytes?: number;
  calculatePayloadBytes?: (selected: StructuredSearchMatch[]) => number;
}

export interface ScheduleStructuredMatchesResult {
  matches: StructuredSearchMatch[];
  budgetTruncated: boolean;
}

export function scheduleStructuredMatches(
  matches: StructuredSearchMatch[],
  options: ScheduleStructuredMatchesOptions
): ScheduleStructuredMatchesResult {
  if (matches.length === 0) {
    return { matches: [], budgetTruncated: false };
  }

  const sorted = sortStructuredMatches([...matches]);
  const selected: StructuredSearchMatch[] = [];
  const selectedKeys = new Set<string>();

  const matchKey = (m: StructuredSearchMatch) => `${m.path}\u0000${m.line}\u0000${m.group}`;
  const select = (m: StructuredSearchMatch): boolean => {
    const key = matchKey(m);
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    selected.push(m);
    return true;
  };

  const maxPayloadBytes = options.maxPayloadBytes ?? defaultStructuredPayloadBudget(options.intent, options.resultLimit);
  const measure = options.calculatePayloadBytes ?? ((cand) => fallbackMeasurePayloadBytes(cand, options.intent));

  // 1. Visibility fairness reservation:
  // With include_hidden=true and capacity >= 2, reserve at least one result for each
  // visibility class if both classes have relevant candidates available.
  if (options.includeHidden === true && options.resultLimit >= 2) {
    const bestVisible = sorted.find((m) => !isHiddenRelativePath(m.path));
    const bestHidden = sorted.find((m) => isHiddenRelativePath(m.path));
    if (bestVisible) select(bestVisible);
    if (bestHidden) select(bestHidden);
  }

  let budgetTruncated = false;

  // 2. Mandatory semantic envelope reservation based on intent:
  if (options.intent === "impact") {
    // a) Definition orientation
    const def = sorted.find((m) => m.group === "definitions");
    if (def) select(def);

    // b) Relevant requested test (reserve space for the required test)
    if (options.includeTests) {
      const test = sorted.find((m) => m.group === "tests");
      if (test) select(test);
    }

    // c) Highest-value direct/transitive affected source modules
    const affectedModules = sorted.filter(isAffectedSourceModule);
    for (const m of affectedModules) {
      if (selected.filter(isAffectedSourceModule).length >= 6 || selected.length >= options.resultLimit) break;
      const trialBytes = measure([...selected, m]);
      if (trialBytes > maxPayloadBytes) {
        budgetTruncated = true;
        break;
      }
      select(m);
    }
  } else if (options.intent === "symbol") {
    // Definitions for orientation & symbol family (up to 8)
    for (const m of sorted) {
      if (selected.filter((s) => s.group === "definitions").length >= 8 || selected.length >= options.resultLimit) break;
      if (m.group === "definitions") {
        if (measure([...selected, m]) <= maxPayloadBytes) select(m);
        else break;
      }
    }
    // References (up to 2)
    for (const m of sorted) {
      if (selected.filter((s) => s.group === "references").length >= 2 || selected.length >= options.resultLimit) break;
      if (m.group === "references") {
        if (measure([...selected, m]) <= maxPayloadBytes) select(m);
        else break;
      }
    }
    // Test if requested
    if (options.includeTests) {
      const test = sorted.find((m) => m.group === "tests");
      if (test && measure([...selected, test]) <= maxPayloadBytes) select(test);
    }
  } else if (options.intent === "references") {
    // Definitions for orientation (up to 2)
    for (const m of sorted) {
      if (selected.filter((s) => s.group === "definitions").length >= 2 || selected.length >= options.resultLimit) break;
      if (m.group === "definitions") {
        if (measure([...selected, m]) <= maxPayloadBytes) select(m);
        else break;
      }
    }
    // Source references (up to 8)
    for (const m of sorted) {
      if (selected.filter((s) => s.group === "references").length >= 8 || selected.length >= options.resultLimit) break;
      if (m.group === "references") {
        if (measure([...selected, m]) <= maxPayloadBytes) select(m);
        else break;
      }
    }
    // Test if requested (up to 3)
    if (options.includeTests) {
      for (const m of sorted) {
        if (selected.filter((s) => s.group === "tests").length >= 3 || selected.length >= options.resultLimit) break;
        if (m.group === "tests") {
          if (measure([...selected, m]) <= maxPayloadBytes) select(m);
          else break;
        }
      }
    }
  } else {
    // Text intent: reserve bounded representation for definitions (2), references (6), tests (3 if includeTests)
    for (const group of ["definitions", "references", ...(options.includeTests ? ["tests" as const] : [])] as const) {
      const quota = group === "definitions" ? 2 : group === "references" ? 6 : 3;
      for (const m of sorted) {
        if (selected.filter((s) => s.group === group).length >= quota || selected.length >= options.resultLimit) break;
        if (m.group === group) {
          if (measure([...selected, m]) <= maxPayloadBytes) select(m);
          else break;
        }
      }
    }
  }

  // 3. Fill remaining capacity by global score, bounded by deterministic payload byte budget
  for (const m of sorted) {
    if (selected.length >= options.resultLimit) break;
    const key = matchKey(m);
    if (selectedKeys.has(key)) continue;

    const trialBytes = measure([...selected, m]);
    if (trialBytes > maxPayloadBytes) {
      budgetTruncated = true;
      break;
    }
    select(m);
  }

  const finalBudgetTruncated = budgetTruncated && selected.length < options.resultLimit && selected.length < sorted.length;
  return { matches: sortStructuredMatches(selected), budgetTruncated: finalBudgetTruncated };
}
