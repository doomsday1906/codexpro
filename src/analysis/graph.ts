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
    for (const target of file.imports) {
      candidateCount += 1;
      const relationship: AnalysisRelationship = {
        from: file.path,
        to: target,
        kind: roles.get(file.path) === "test" ? "tests" : "imports",
        confidence: "strong",
        source: "built-in import extraction"
      };
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
