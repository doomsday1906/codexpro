import { CodexProError, type PathGuard } from "./guard.js";

const HISTORICAL_PATH_MAX_BYTES = 4_096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

function invalidHistoricalPath(): never {
  throw new CodexProError("Invalid historical repository path.");
}

/**
 * Validate and canonicalize a repository-tree path for historical Git reads.
 *
 * Historical paths describe entries in a Git tree, not files in the current
 * checkout. In particular, this deliberately does not call PathGuard.resolve,
 * whose filesystem and symlink checks require the current path to exist.
 */
export function validateHistoricalPath(guard: Pick<PathGuard, "isBlockedRelativePath">, rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return invalidHistoricalPath();
  }
  if (Buffer.byteLength(rawPath, "utf8") > HISTORICAL_PATH_MAX_BYTES) {
    return invalidHistoricalPath();
  }
  if (CONTROL_CHARACTER_PATTERN.test(rawPath)) {
    return invalidHistoricalPath();
  }

  const isWindows = process.platform === "win32";
  // A leading forward slash is absolute on every host. Two leading
  // backslashes are always rejected as UNC; on Windows, one leading
  // backslash is also a root. POSIX treats a single backslash as data.
  if (
    rawPath.startsWith("/") ||
    rawPath.startsWith("\\\\") ||
    (isWindows && rawPath.startsWith("\\")) ||
    WINDOWS_DRIVE_PREFIX_PATTERN.test(rawPath)
  ) {
    return invalidHistoricalPath();
  }

  const normalized = isWindows ? rawPath.replaceAll("\\", "/") : rawPath;
  const components = normalized.split("/");
  const canonicalComponents: string[] = [];
  for (const component of components) {
    if (component === "..") {
      return invalidHistoricalPath();
    }
    if (component === "" || component === ".") {
      continue;
    }
    canonicalComponents.push(component);
  }

  const canonicalPath = canonicalComponents.join("/");
  if (!canonicalPath) {
    return invalidHistoricalPath();
  }
  if (guard.isBlockedRelativePath(canonicalPath)) {
    throw new CodexProError("Historical repository path is blocked by safety rules.");
  }
  return canonicalPath;
}
