import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { CodexProConfig } from "./config.js";
import { expandHome } from "./config.js";

export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
}

export class CodexProError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexProError";
  }
}

export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{24}$/u;

function isWorkspaceId(id: string): boolean {
  return WORKSPACE_ID_PATTERN.test(id);
}

function workspaceIdError(id: string, detail: "unknown" | "invalid" = "unknown"): CodexProError {
  if (detail === "invalid" || !isWorkspaceId(id)) {
    return new CodexProError("Unknown workspace_id. Call open_workspace first.");
  }
  return new CodexProError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
}

// Workspace ids are process-scoped identities, while selection remains local to
// each WorkspaceManager/MCP session. Store only canonical roots here; callers
// must still pass them through the current allowed-root and filesystem checks
// before a workspace is reconstructed.
const processWorkspaceRoots = new Map<string, string>();

function rememberWorkspaceRoot(id: string, realRoot: string): void {
  const existingRoot = processWorkspaceRoots.get(id);
  if (existingRoot && existingRoot !== realRoot) {
    throw new CodexProError(`Workspace id collision: ${id} identifies both ${existingRoot} and ${realRoot}.`);
  }
  processWorkspaceRoots.set(id, realRoot);
}

function currentAllowedRoot(config: CodexProConfig, realRoot: string): boolean {
  return config.allowedRoots.some((allowedRoot) => {
    try {
      const stat = fs.lstatSync(allowedRoot);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const currentAllowedRoot = fs.realpathSync.native(allowedRoot);
      if (currentAllowedRoot !== allowedRoot) return false;
      return isSubpath(realRoot, currentAllowedRoot);
    } catch {
      return false;
    }
  });
}

function canonicalDirectoryRoot(rootInput: string, options: { rejectSymlink?: boolean } = {}): string {
  const resolved = path.resolve(rootInput);
  let stat: fs.Stats;
  try {
    const linkStat = fs.lstatSync(resolved);
    if (options.rejectSymlink && linkStat.isSymbolicLink()) {
      throw new CodexProError("Workspace identity is stale.");
    }
    stat = fs.statSync(resolved);
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    throw new CodexProError("Workspace root is unavailable.");
  }
  if (!stat.isDirectory()) throw new CodexProError("Workspace root is not a directory.");
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    throw new CodexProError("Workspace root is unavailable.");
  }
}

function validateRememberedRoot(config: CodexProConfig, id: string, rememberedRoot: string): string {
  const expected = rememberedRoot;
  let realRoot: string;
  try {
    realRoot = canonicalDirectoryRoot(expected, { rejectSymlink: true });
  } catch {
    throw new CodexProError(`Workspace id no longer matches its canonical root: ${id}. Call open_workspace again.`);
  }
  if (realRoot !== expected || workspaceIdForRoot(realRoot) !== id || !currentAllowedRoot(config, realRoot)) {
    throw new CodexProError(`Workspace id no longer matches its canonical root: ${id}. Call open_workspace again.`);
  }
  return realRoot;
}

function validateExistingWorkspace(config: CodexProConfig, workspace: Workspace): Workspace {
  const rememberedRoot = processWorkspaceRoots.get(workspace.id);
  if (!rememberedRoot || rememberedRoot !== workspace.root) {
    throw new CodexProError(`Workspace id no longer matches its canonical root: ${workspace.id}. Call open_workspace again.`);
  }
  const realRoot = validateRememberedRoot(config, workspace.id, rememberedRoot);
  if (realRoot !== workspace.root) {
    throw new CodexProError(`Workspace id no longer matches its canonical root: ${workspace.id}. Call open_workspace again.`);
  }
  return workspace;
}

function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return undefined;
  }
}

function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private selectedWorkspaceId?: string;

  constructor(private readonly config: CodexProConfig) {}

  defaultWorkspace(): Workspace {
    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === this.config.defaultRoot);
    return existing ? validateExistingWorkspace(this.config, existing) : this.openWorkspace(this.config.defaultRoot, { select: false });
  }

  selectDefaultWorkspace(): Workspace {
    const workspace = this.defaultWorkspace();
    this.selectedWorkspaceId = workspace.id;
    return workspace;
  }

  openWorkspace(rootInput?: string, options: { select?: boolean } = {}): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new CodexProError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new CodexProError(`Workspace root is not a directory: ${resolved}`);
    }
    let realRoot: string;
    try {
      realRoot = fs.realpathSync.native(resolved);
    } catch {
      throw new CodexProError(`Workspace root does not exist: ${resolved}`);
    }
    if (!currentAllowedRoot(this.config, realRoot)) {
      throw new CodexProError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    const id = workspaceIdForRoot(realRoot);
    rememberWorkspaceRoot(id, realRoot);
    if (existing) {
      if (options.select !== false) this.selectedWorkspaceId = existing.id;
      return existing;
    }

    const workspace = { id, root: realRoot, openedAt: new Date().toISOString() };
    this.workspaces.set(id, workspace);
    if (options.select !== false) this.selectedWorkspaceId = id;
    return workspace;
  }

  getWorkspace(id?: string): Workspace {
    if (!id) {
      if (this.selectedWorkspaceId) {
        const selected = this.workspaces.get(this.selectedWorkspaceId);
        if (selected) return validateExistingWorkspace(this.config, selected);
      }
      return this.selectDefaultWorkspace();
    }
    const workspace = this.workspaces.get(id);
    if (workspace) {
      return validateExistingWorkspace(this.config, workspace);
    }
    if (!isWorkspaceId(id)) {
      throw workspaceIdError(id, "invalid");
    }

    const rememberedRoot = processWorkspaceRoots.get(id);
    if (rememberedRoot) {
      const realRoot = validateRememberedRoot(this.config, id, rememberedRoot);
      const reconstructed = { id, root: realRoot, openedAt: new Date().toISOString() };
      this.workspaces.set(id, reconstructed);
      return reconstructed;
    }

    // Preserve the historical convenience where a configured allowed root can
    // be addressed by its deterministic id before any prior session opened it.
    // This path never scans the filesystem or widens the configured allowed-root
    // set; openWorkspace applies the same current-root validation as an explicit
    // open and does not change this manager's selection when select is false.
    const configuredRoot = this.config.allowedRoots.find((allowedRoot) => workspaceIdForRoot(allowedRoot) === id);
    if (configuredRoot) {
      const reconstructed = this.openWorkspace(configuredRoot, { select: false });
      if (reconstructed.id !== id) {
        throw new CodexProError(`Workspace id no longer matches its canonical root: ${id}. Call open_workspace again.`);
      }
      return reconstructed;
    }
    throw workspaceIdError(id);
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()].filter((workspace) => {
      try {
        validateExistingWorkspace(this.config, workspace);
        return true;
      } catch {
        return false;
      }
    });
  }

  currentWorkspaceId(): string {
    return this.getWorkspace().id;
  }
}

export class PathGuard {
  constructor(private readonly config: CodexProConfig) {}

  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new CodexProError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    let absPath = path.resolve(candidate);
    const realTarget = maybeRealpath(absPath);
    let relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      if (realTarget && isSubpath(realTarget, workspace.root)) {
        absPath = realTarget;
        relPath = displayPath(realTarget, workspace.root);
      } else if (options.forWrite) {
        const parent = closestExistingParent(path.dirname(absPath));
        const realParent = maybeRealpath(parent);
        if (!realParent || !isSubpath(realParent, workspace.root)) {
          throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
        }
        absPath = path.resolve(realParent, path.relative(parent, absPath));
        relPath = displayPath(absPath, workspace.root);
      } else {
        throw new CodexProError(`Path escapes workspace root: ${inputPath}`);
      }
    }

    this.assertNotBlocked(relPath);

    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new CodexProError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    if (options.forWrite) {
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          throw new CodexProError(`Refusing to write through a symlink: ${inputPath}`);
        }
      } catch (error) {
        if (error instanceof CodexProError) throw error;
      }
      const parent = closestExistingParent(path.dirname(absPath));
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new CodexProError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  async assertTextFile(absPath: string, maxBytes: number): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new CodexProError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes) {
      throw new CodexProError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    if (stat.size === 0) return;
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(64 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(sample, 0, sample.length, offset);
        if (bytesRead === 0) break;
        if (sample.subarray(0, bytesRead).includes(0)) {
          throw new CodexProError("Refusing to read binary file.");
        }
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}

export function userHome(): string {
  return os.homedir();
}
