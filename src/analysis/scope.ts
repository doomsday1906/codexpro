import { isHiddenRelativePath, matchesSearchGlob } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";

export interface SearchScopeOptions {
  root?: string;
  glob?: string;
  includeHidden?: boolean;
}

export interface SearchScope {
  /** Canonical workspace-relative root, or an empty string for the workspace. */
  readonly root: string;
  /** The exact lexical glob supplied by the caller, if one was supplied. */
  readonly glob?: string;
  readonly includeHidden: boolean;
  readonly matches: (relativePath: string) => boolean;
}

/**
 * Resolve the public search path once and share the resulting path/glob/
 * visibility predicate across every structured producer and projection.
 * PathGuard remains the authority for root resolution and blocked/symlink
 * admission; this predicate only narrows already-admitted analysis paths.
 */
export function resolveSearchScope(
  guard: PathGuard,
  workspace: Workspace,
  options: SearchScopeOptions
): SearchScope {
  const root = options.root?.trim()
    ? guard.resolve(workspace, options.root).relPath.replace(/^\.\/?$/, "")
    : "";
  const glob = options.glob || undefined;
  const includeHidden = options.includeHidden === true;
  const matches = (relativePath: string): boolean => {
    if (!includeHidden && isHiddenRelativePath(relativePath)) return false;
    if (root && relativePath !== root && !relativePath.startsWith(`${root}/`)) return false;
    return matchesSearchGlob(relativePath, glob);
  };
  return { root, glob, includeHidden, matches };
}

/**
 * Request-local cache identity for structured search envelopes. The shared
 * whole-workspace analysis cache stays keyed only by its analysis inputs, but
 * callers must not mistake one root/glob result for another scope variant.
 */
export function searchScopeCacheKey(scope: SearchScope): string | undefined {
  if (!scope.root && !scope.glob) return undefined;
  return JSON.stringify({ root: scope.root || ".", glob: scope.glob ?? null });
}
