import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import type { CodexProConfig } from "../config.js";
import { isHiddenRelativePath, listFilesDetailed, textScanByteLimit } from "../fsOps.js";
import { CodexProError } from "../guard.js";
import type { PathGuard, Workspace } from "../guard.js";
import { classifyFileRole, classifyLanguage, isEntrypoint, isGeneratedFile } from "./classify.js";
import type { InventoryFile, InventoryResult } from "./types.js";

function compareCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isOrdinaryInventorySkip(error: unknown): boolean {
  if (error instanceof CodexProError) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "EACCES" || code === "EISDIR" || code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR" || code === "EPERM";
}

export async function inventoryWorkspace(config: CodexProConfig, guard: PathGuard, workspace: Workspace): Promise<InventoryResult> {
  const maxFiles = config.analysisLimits.maxInventoryFiles;
  const admissionBytes = textScanByteLimit(config);
  // F4-C: oversized exclusions are bounded skip facts, not silent ordinary
  // skips. Sized here from the pre-admission stat (already in hand) so no
  // error-message sniffing is needed.
  // R2-1: the exclusion SET is cache identity, not just the count. Adding,
  // removing, or growing a file across the admission boundary must change
  // the cache key so a fresh bounded coverage result can never be replaced
  // by an older complete one.
  // R3-2: that identity is a bounded streaming digest, never a retained
  // list. Excluded files do not consume maxInventoryFiles, so the exclusion
  // set is unbounded (thousands of files) — retaining or sorting one string
  // per exclusion is unbounded state. Instead each exclusion folds one
  // SHA-256 into a 32-byte XOR accumulator plus an exact counter. XOR is
  // order-independent (traversal order must not affect the key) and O(1)
  // state; the counter guarantees cardinality changes always flip the key.
  // NUL separators: POSIX paths cannot contain NUL, so distinct identities
  // cannot share a preimage. Excluded paths are never exposed publicly —
  // only the count and the digest survive this function.
  let oversizedSkippedFiles = 0;
  const exclusionFold = Buffer.alloc(32, 0);
  const foldExclusion = (relPath: string, size: number, mtimeMs: number): void => {
    const digest = createHash("sha256")
      .update("\0").update(relPath)
      .update("\0").update(String(size))
      .update("\0").update(String(mtimeMs))
      .digest();
    for (let i = 0; i < exclusionFold.length; i += 1) exclusionFold[i] ^= digest[i];
  };
  const traversalResult = await listFilesDetailed(guard, workspace, {
    root: ".",
    includeHidden: true,
    maxFiles,
    visibilityPriority: true,
    admitFile: async ({ relPath }) => {
      try {
        const resolved = guard.resolve(workspace, relPath);
        const stat = await fsp.stat(resolved.absPath);
        if (!stat.isFile()) return undefined;
        if (stat.size > admissionBytes) {
          oversizedSkippedFiles += 1;
          foldExclusion(resolved.relPath, stat.size, stat.mtimeMs);
          return undefined;
        }
        await guard.assertTextFile(resolved.absPath, admissionBytes);
        const language = classifyLanguage(resolved.relPath);
        return {
          path: resolved.relPath,
          bytes: stat.size,
          modifiedMs: stat.mtimeMs,
          language,
          role: classifyFileRole(resolved.relPath, language),
          generated: isGeneratedFile(resolved.relPath),
          entrypoint: isEntrypoint(resolved.relPath)
        };
      } catch (error) {
        if (isOrdinaryInventorySkip(error)) return undefined;
        throw error;
      }
    }
  });
  const truncated = traversalResult.truncated;
  const files: InventoryFile[] = (traversalResult.preparedFiles ?? []).map(({ prepared }) => prepared);

  files.sort((a, b) => Number(isHiddenRelativePath(a.path)) - Number(isHiddenRelativePath(b.path)) || compareCodeUnit(a.path, b.path));
  // R2 review R1-T1: traversal-capacity truncation is also cache identity.
  // Without it, filling the inventory to its file cap returns the same
  // fingerprint after one more file arrives, and a stale complete result
  // masks the fresh truncation. The flag pair below is exactly the input the
  // warnings derive from, so equal fingerprints imply fact-equal coverage.
  const truncationMark = `\n\x00truncation:${truncated ? 1 : 0}:${traversalResult.traversal?.capacityExhausted ? 1 : 0}`;
  const fingerprint = createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.bytes}:${file.modifiedMs}`).join("\n") +
      "\n\x00oversized-skipped:\n" + exclusionFold.toString("hex") + `\n${oversizedSkippedFiles}` + truncationMark)
    .digest("hex");
  const warnings = truncated
    ? traversalResult.traversal?.capacityExhausted
      ? [`Inventory truncated at ${maxFiles} files.`]
      : ["Inventory coverage is unresolved before reaching its configured file limit."]
    : [];
  if (oversizedSkippedFiles > 0) {
    warnings.push(
      `${oversizedSkippedFiles} file${oversizedSkippedFiles === 1 ? "" : "s"} exceed${oversizedSkippedFiles === 1 ? "s" : ""} the ${admissionBytes}-byte analysis admission and ${oversizedSkippedFiles === 1 ? "was" : "were"} not analyzed.`
    );
  }
  return {
    files,
    fingerprint,
    coverage: {
      inventoryFiles: files.length,
      analyzedFiles: 0,
      scannedBytes: 0,
      symbolCount: 0,
      relationshipCount: 0,
      truncated: truncated || oversizedSkippedFiles > 0,
      warnings,
      oversizedSkippedFiles
    }
  };
}
