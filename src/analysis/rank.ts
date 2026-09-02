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

export function scheduleStructuredMatches(
  matches: StructuredSearchMatch[],
  options: {
    intent: Exclude<AnalysisSearchIntent, "auto">;
    resultLimit: number;
    includeHidden?: boolean;
    includeTests?: boolean;
  }
): StructuredSearchMatch[] {
  if (matches.length <= options.resultLimit) {
    return sortStructuredMatches([...matches]);
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

  // Visibility fairness reservation:
  // With include_hidden=true and capacity >= 2, reserve at least one result for each
  // visibility class if both classes have relevant candidates available.
  if (options.includeHidden === true && options.resultLimit >= 2) {
    const bestVisible = sorted.find((m) => !isHiddenRelativePath(m.path));
    const bestHidden = sorted.find((m) => isHiddenRelativePath(m.path));
    if (bestVisible) select(bestVisible);
    if (bestHidden) select(bestHidden);
  }

  // Bounded class reservation based on intent:
  // Definitions for orientation, primary category for intent, tests when requested, config/docs supplements.
  const classQuotas: Record<AnalysisResultGroup, number> = {
    definitions: 0,
    references: 0,
    tests: 0,
    configuration: 0,
    documentation: 0,
    other: 0
  };

  if (options.intent === "references") {
    classQuotas.definitions = 2;
    classQuotas.references = 8;
    classQuotas.tests = options.includeTests ? 3 : 0;
    classQuotas.configuration = 1;
    classQuotas.documentation = 1;
    classQuotas.other = 1;
  } else if (options.intent === "impact") {
    classQuotas.definitions = 2;
    classQuotas.references = 8;
    classQuotas.tests = options.includeTests ? 4 : 0;
    classQuotas.configuration = 1;
    classQuotas.documentation = 1;
    classQuotas.other = 1;
  } else if (options.intent === "symbol") {
    classQuotas.definitions = 6;
    classQuotas.references = 6;
    classQuotas.tests = options.includeTests ? 3 : 0;
    classQuotas.configuration = 1;
    classQuotas.documentation = 1;
    classQuotas.other = 1;
  } else {
    classQuotas.definitions = 2;
    classQuotas.references = 6;
    classQuotas.tests = options.includeTests ? 3 : 0;
    classQuotas.configuration = 2;
    classQuotas.documentation = 2;
    classQuotas.other = 1;
  }

  // Reserve bounded representation for each available class
  for (const group of GROUPS) {
    const quota = classQuotas[group];
    if (quota <= 0) continue;
    let count = selected.filter((m) => m.group === group).length;
    for (const m of sorted) {
      if (count >= quota || selected.length >= options.resultLimit) break;
      if (m.group === group && select(m)) {
        count += 1;
      }
    }
  }

  // Fill remaining capacity by global score
  for (const m of sorted) {
    if (selected.length >= options.resultLimit) break;
    select(m);
  }

  return sortStructuredMatches(selected);
}
