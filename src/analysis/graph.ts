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

export function traverseImpactGraph(
  definitionPaths: Set<string>,
  relationships: AnalysisRelationship[],
  options: {
    maxDepth?: number;
    maxCandidates?: number;
    includeTests?: boolean;
    includePath?: (filePath: string) => boolean;
  } = {}
): ImpactTraversalResult[] {
  const maxDepth = options.maxDepth ?? 3;
  const maxCandidates = options.maxCandidates ?? 200;
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

  type QueueItem = { path: string; depth: number; rootDef: string; via?: string };
  const queue: QueueItem[] = [];
  for (const defPath of definitionPaths) {
    queue.push({ path: defPath, depth: 0, rootDef: defPath });
  }

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

      if (results.length >= maxCandidates) break;

      if (!rel.from.endsWith("/__init__.py") && rel.from !== "__init__.py") {
        queue.push({
          path: rel.from,
          depth: nextDepth,
          rootDef: current.rootDef,
          via: isDirect ? rel.from : current.via
        });
      }
    }
  }

  return results;
}
