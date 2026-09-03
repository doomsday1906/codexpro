import { isHiddenRelativePath } from "../fsOps.js";
import type { ExtractedFile } from "./extract.js";
import type { AnalysisRelationship, InventoryFile } from "./types.js";

export interface RelationshipBuildResult {
  relationships: AnalysisRelationship[];
  truncated: boolean;
}

export function buildRelationshipsWithCoverage(
  extractedFiles: ExtractedFile[],
  inventoryFiles: InventoryFile[],
  maxRelationships: number
): RelationshipBuildResult {
  const roles = new Map(inventoryFiles.map((file) => [file.path, file.role]));
  const limit = Math.max(0, maxRelationships);
  const visibleRelationships: AnalysisRelationship[] = [];
  const hiddenRelationships: AnalysisRelationship[] = [];
  let candidateCount = 0;
  for (const file of extractedFiles) {
    const imports = file.importRecords?.length
      ? file.importRecords
      : file.imports.map((target) => ({ target, line: undefined, text: undefined }));
    for (const imported of imports) {
      const target = imported.target;
      candidateCount += 1;
      const relationship: AnalysisRelationship = {
        from: file.path,
        to: target,
        kind: roles.get(file.path) === "test" ? "tests" : "imports",
        confidence: "strong",
        source: "built-in import extraction"
      };
      if (typeof imported.line === "number" && imported.line > 0) relationship.line = imported.line;
      if (typeof imported.text === "string") relationship.text = imported.text;
      const visibleToVisible = !isHiddenRelativePath(file.path) && !isHiddenRelativePath(target);
      if (visibleToVisible) {
        if (visibleRelationships.length < limit) visibleRelationships.push(relationship);
        // Hidden-affiliated candidates are provisional until every visible
        // relationship has had its chance. Keep the retained state bounded by
        // the configured capacity while evicting provisional tail entries as
        // visible authority grows.
        hiddenRelationships.length = Math.min(hiddenRelationships.length, Math.max(0, limit - visibleRelationships.length));
      } else if (visibleRelationships.length + hiddenRelationships.length < limit) {
        hiddenRelationships.push(relationship);
      }
    }
  }
  return {
    relationships: [...visibleRelationships, ...hiddenRelationships].slice(0, limit),
    truncated: candidateCount > limit
  };
}

export function buildRelationships(extractedFiles: ExtractedFile[], inventoryFiles: InventoryFile[], maxRelationships: number): AnalysisRelationship[] {
  return buildRelationshipsWithCoverage(extractedFiles, inventoryFiles, maxRelationships).relationships;
}

export function reverseDependencies(relationships: AnalysisRelationship[], targetPath: string): AnalysisRelationship[] {
  return relationships.filter((relationship) => relationship.to === targetPath);
}

export interface ImpactTraversalResult {
  path: string;
  depth: number;
  kind: "imports" | "tests";
  reasons: string[];
  line?: number;
  text?: string;
  source?: string;
  target?: string;
  via?: string;
}

export interface ImpactTraversalOutput {
  results: ImpactTraversalResult[];
  /** True only when the candidate bound prevented more eligible work from being evaluated. */
  truncated: boolean;
}

export const IMPACT_TRAVERSAL_TRUNCATION_WARNING =
  "Impact traversal reached its configured candidate limit; additional reachable candidates may be omitted.";

type ImpactQueueItem = { path: string; depth: number; rootDef: string; via?: string };

function hasEligibleReachableCandidate(
  incomingByTarget: Map<string, AnalysisRelationship[]>,
  frontier: ImpactQueueItem[],
  visited: Set<string>,
  maxDepth: number,
  includeTests: boolean
): boolean {
  for (const current of frontier) {
    if (current.depth >= maxDepth) continue;
    const incoming = incomingByTarget.get(current.path) ?? [];
    for (const rel of incoming) {
      if (rel.kind === "tests" && !includeTests) continue;
      if (visited.has(rel.from)) continue;
      return true;
    }
  }
  return false;
}

export function traverseImpactGraph(
  definitionPaths: Set<string>,
  relationships: AnalysisRelationship[],
  options: {
    maxDepth?: number;
    maxCandidates?: number;
    includeTests?: boolean;
    includePath?: (filePath: string) => boolean;
  } = {}
): ImpactTraversalOutput {
  const maxDepth = options.maxDepth ?? 3;
  const maxCandidates = Math.max(0, options.maxCandidates ?? 200);
  const includePath = options.includePath ?? (() => true);

  const incomingByTarget = new Map<string, AnalysisRelationship[]>();
  for (const rel of relationships) {
    if (!includePath(rel.from) || !includePath(rel.to)) continue;
    const list = incomingByTarget.get(rel.to) ?? [];
    list.push(rel);
    incomingByTarget.set(rel.to, list);
  }

  const results: ImpactTraversalResult[] = [];
  const visited = new Set<string>(definitionPaths);

  const queue: ImpactQueueItem[] = [];
  for (const defPath of definitionPaths) {
    queue.push({ path: defPath, depth: 0, rootDef: defPath });
  }

  if (maxCandidates === 0) {
    return {
      results,
      truncated: hasEligibleReachableCandidate(incomingByTarget, queue, visited, maxDepth, Boolean(options.includeTests))
    };
  }

  let truncated = false;

  while (queue.length > 0 && results.length < maxCandidates) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    const incoming = incomingByTarget.get(current.path) ?? [];
    for (const rel of incoming) {
      if (rel.kind === "tests" && !options.includeTests) continue;
      if (visited.has(rel.from)) continue;
      visited.add(rel.from);

      const nextDepth = current.depth + 1;
      const isDirect = nextDepth === 1;
      const isTest = rel.kind === "tests";

      const targetDisplay = current.rootDef.split("/").length > 2 ? current.rootDef.split("/").pop()! : current.rootDef;
      const viaDisplay = current.via && current.via.split("/").length > 2 ? current.via.split("/").pop()! : current.via;
      const reasons: string[] = [];
      if (isTest) {
        reasons.push(isDirect ? "dependent test" : "transitive test dependent");
        if (isDirect) reasons.push(`tests ${targetDisplay}`);
        else if (viaDisplay) reasons.push(`tests via ${viaDisplay}`);
      } else {
        reasons.push(isDirect ? "dependent module" : "transitive dependent module");
        if (isDirect) reasons.push(`imports ${targetDisplay}`);
        else if (viaDisplay) reasons.push(`transitive dependent via ${viaDisplay}`);
      }

      results.push({
        path: rel.from,
        depth: nextDepth,
        kind: rel.kind === "tests" ? "tests" : "imports",
        reasons,
        line: rel.line,
        text: rel.text,
        source: rel.source,
        target: rel.to,
        via: isDirect ? rel.from : current.via
      });

      const next = {
        path: rel.from,
        depth: nextDepth,
        rootDef: current.rootDef,
        via: isDirect ? rel.from : current.via
      };
      const canExpand = !rel.from.endsWith("/__init__.py") && rel.from !== "__init__.py";
      if (results.length >= maxCandidates) {
        // The current node was popped from the queue, so retain it in the
        // look-ahead frontier. The last admitted candidate is also pending
        // expansion when the normal traversal would enqueue it. This lets us
        // distinguish a naturally exhausted exact-bound traversal from one
        // that really has more eligible reachable work.
        const pending = [...queue, current];
        if (canExpand) pending.push(next);
        truncated = hasEligibleReachableCandidate(
          incomingByTarget,
          pending,
          visited,
          maxDepth,
          Boolean(options.includeTests)
        );
        break;
      }

      if (canExpand) {
        queue.push(next);
      }
    }
  }

  return { results, truncated };
}
