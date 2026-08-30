import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BashMode, BashTranscriptMode, CodexSessionsMode, ToolMode, WriteMode } from "./config.js";
import { expandHome } from "./config.js";

export type TunnelMode = "none" | "cloudflare" | "cloudflare-named" | "ngrok" | "tailscale";
export type ConnectorMode = "agent" | "handoff" | "pro";

export interface WorkspaceProfile {
  version?: number;
  root?: string;
  updatedAt?: string;
  profilePath?: string;
  port?: string;
  mode?: ConnectorMode | string;
  tunnel?: TunnelMode | string;
  hostname?: string;
  tunnelName?: string;
  ngrokConfig?: string;
  cloudflareConfig?: string;
  cloudflareTokenFile?: string;
  cloudflareToken?: string;
  token?: string;
  bash?: BashMode | string;
  bashTranscript?: BashTranscriptMode | string;
  codexSessions?: CodexSessionsMode | string;
  codexDir?: string;
  bashSession?: string;
  requireBashSession?: boolean;
  write?: WriteMode | string;
  toolMode?: ToolMode | string;
  toolCards?: boolean;
  widgetDomain?: string;
  noInstallCloudflared?: boolean;
  allowedRoots?: string[];
}

export interface RuntimeConnection {
  version?: number;
  root?: string;
  pid?: number;
  runId?: string;
  startedAt?: string;
  updatedAt?: string;
  runtimePid?: number | null;
  endpoint?: string;
  localBase?: string;
  localStatusUrl?: string;
  tunnel?: TunnelMode | string;
  tunnelPid?: number | null;
  tunnelStatus?: "starting" | "running" | "disabled" | "unknown" | string;
  headless?: boolean;
  mode?: ConnectorMode | string;
  bash?: BashMode | string;
  bashTranscript?: BashTranscriptMode | string;
  codexSessions?: CodexSessionsMode | string;
  bashSession?: string;
  requireBashSession?: boolean;
  write?: WriteMode | string;
  toolMode?: ToolMode | string;
  toolCards?: boolean;
}

export type RuntimeFailureComponent = "http_child" | "tunnel" | "launcher";

export interface RuntimeFailureRecord {
  version?: number;
  root?: string;
  runId?: string;
  component?: RuntimeFailureComponent | string;
  event?: "unexpected_exit" | "startup_failure" | "spawn_error" | string;
  phase?: string;
  failedAt?: string;
  launcherPid?: number;
  httpPid?: number;
  tunnelPid?: number;
  tunnel?: TunnelMode | string;
  exitCode?: number | null;
  signal?: string | null;
  detail?: string;
}

export const RUNTIME_FAILURE_MAX_BYTES = 16_384;

const WORKSPACE_BINDING_VERSION = 1;
const WORKSPACE_BINDING_ID_PATTERN = /^ws_[0-9a-f]{24}$/u;
const WORKSPACE_BINDING_MAX_BYTES = 16_384;
const WORKSPACE_BINDING_ROOT_MAX_BYTES = 32 * 1024;
const WORKSPACE_BINDING_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;

export interface WorkspaceBinding {
  version: 1;
  id: string;
  root: string;
}

export type WorkspaceBindingErrorCode = "invalid" | "collision" | "unavailable";

export class WorkspaceBindingError extends Error {
  constructor(public readonly code: WorkspaceBindingErrorCode, message = "Workspace binding is unavailable.") {
    super(message);
    this.name = "WorkspaceBindingError";
  }
}

export function codexProHome(): string {
  const customHome = process.env.CODEXPRO_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), ".codexpro");
}

export function profileDir(): string {
  return path.join(codexProHome(), "profiles");
}

export function workspaceBindingDir(): string {
  return path.join(codexProHome(), "workspace-bindings", "v1");
}

function assertWorkspaceBindingId(id: string): void {
  if (typeof id !== "string" || !WORKSPACE_BINDING_ID_PATTERN.test(id)) {
    throw new WorkspaceBindingError("invalid");
  }
}

function assertWorkspaceBindingRoot(root: string): void {
  if (
    typeof root !== "string" ||
    !root ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    WORKSPACE_BINDING_CONTROL_PATTERN.test(root) ||
    Buffer.byteLength(root, "utf8") > WORKSPACE_BINDING_ROOT_MAX_BYTES
  ) {
    throw new WorkspaceBindingError("invalid");
  }
}

function existingDirectoryOrMissing(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new WorkspaceBindingError("invalid");
    }
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    if (error instanceof WorkspaceBindingError) throw error;
    throw new WorkspaceBindingError("unavailable");
  }
}

function ensureWorkspaceBindingDir(): string {
  const home = codexProHome();
  const base = path.join(home, "workspace-bindings");
  const dir = workspaceBindingDir();
  try {
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    throw new WorkspaceBindingError("unavailable");
  }
  if (!existingDirectoryOrMissing(base) || !existingDirectoryOrMissing(dir)) {
    throw new WorkspaceBindingError("unavailable");
  }
  try {
    fs.chmodSync(base, 0o700);
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort permission repair for filesystems that do not support chmod.
  }
  return dir;
}

function workspaceBindingPathForIdInternal(id: string): string {
  assertWorkspaceBindingId(id);
  return path.join(workspaceBindingDir(), `${id}.json`);
}

export function workspaceBindingPathForId(id: string): string {
  return workspaceBindingPathForIdInternal(id);
}

function parseWorkspaceBinding(id: string, raw: unknown): WorkspaceBinding {
  assertWorkspaceBindingId(id);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkspaceBindingError("invalid");
  }
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !keys.includes("version") || !keys.includes("id") || !keys.includes("root")) {
    throw new WorkspaceBindingError("invalid");
  }
  const candidate = raw as { version?: unknown; id?: unknown; root?: unknown };
  if (candidate.version !== WORKSPACE_BINDING_VERSION || candidate.id !== id || typeof candidate.root !== "string") {
    throw new WorkspaceBindingError("invalid");
  }
  assertWorkspaceBindingRoot(candidate.root);
  return { version: WORKSPACE_BINDING_VERSION, id, root: candidate.root };
}

function bindingFileBytes(filePath: string): Buffer | undefined {
  try {
    const linkStat = fs.lstatSync(filePath);
    if (linkStat.isSymbolicLink() || !linkStat.isFile()) {
      throw new WorkspaceBindingError("invalid");
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof WorkspaceBindingError) throw error;
    throw new WorkspaceBindingError("invalid");
  }

  let handle: number;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    handle = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw new WorkspaceBindingError("invalid");
  }
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > WORKSPACE_BINDING_MAX_BYTES) {
      throw new WorkspaceBindingError("invalid");
    }
    return fs.readFileSync(handle);
  } catch (error) {
    if (error instanceof WorkspaceBindingError) throw error;
    throw new WorkspaceBindingError("invalid");
  } finally {
    try {
      fs.closeSync(handle);
    } catch {
      // The descriptor is disposable; parsing already failed closed if read failed.
    }
  }
}

export function readWorkspaceBinding(id: string): WorkspaceBinding | undefined {
  assertWorkspaceBindingId(id);
  const home = codexProHome();
  const base = path.join(home, "workspace-bindings");
  const dir = workspaceBindingDir();
  if (!existingDirectoryOrMissing(base) || !existingDirectoryOrMissing(dir)) return undefined;

  const filePath = workspaceBindingPathForIdInternal(id);
  const bytes = bindingFileBytes(filePath);
  if (!bytes) return undefined;
  if (bytes.byteLength > WORKSPACE_BINDING_MAX_BYTES) {
    throw new WorkspaceBindingError("invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceBindingError("invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WorkspaceBindingError("invalid");
  }
  return parseWorkspaceBinding(id, parsed);
}

function canonicalExistingWorkspaceRoot(root: string): string {
  if (typeof root !== "string" || !root || WORKSPACE_BINDING_CONTROL_PATTERN.test(root)) {
    throw new WorkspaceBindingError("invalid");
  }
  const resolved = path.resolve(root);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new WorkspaceBindingError("invalid");
    const canonical = fs.realpathSync.native(resolved);
    assertWorkspaceBindingRoot(canonical);
    return canonical;
  } catch (error) {
    if (error instanceof WorkspaceBindingError) throw error;
    throw new WorkspaceBindingError("invalid");
  }
}

function syncDirectory(dirPath: string): void {
  try {
    const handle = fs.openSync(dirPath, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    // Directory fsync is unavailable on some supported filesystems/platforms.
  }
}

function removeTemporaryBinding(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort cleanup; the final binding remains immutable and authoritative.
  }
}

function publishBindingNoReplace(dir: string, finalPath: string, payload: Buffer, id: string, expectedRoot: string): void {
  const tempPath = path.join(dir, `.${id}.${process.pid}.${Date.now()}.${randomBytes(12).toString("hex")}.tmp`);
  let tempHandle: number | undefined;
  try {
    try {
      tempHandle = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeFileSync(tempHandle, payload);
      fs.fsyncSync(tempHandle);
      try {
        fs.fchmodSync(tempHandle, 0o600);
      } catch {
        // Best-effort permission repair for filesystems that do not support chmod.
      }
    } catch {
      throw new WorkspaceBindingError("unavailable");
    } finally {
      if (tempHandle !== undefined) {
        try {
          fs.closeSync(tempHandle);
        } catch {
          // The publication fails closed below if close itself prevented a safe write.
        }
      }
    }

    try {
      // A hard link publishes the complete fsynced payload without allowing a
      // racing writer to replace an existing immutable binding.
      fs.linkSync(tempPath, finalPath);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        const existing = readWorkspaceBinding(id);
        if (existing?.root === expectedRoot) return;
        if (existing) throw new WorkspaceBindingError("collision");
        throw new WorkspaceBindingError("unavailable");
      }

      // Hard links are unavailable on a few supported filesystems. Fall back
      // to a cooperative exclusive lock while retaining no-clobber behavior.
      const lockPath = `${finalPath}.lock`;
      let lockHandle: number | undefined;
      try {
        lockHandle = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      } catch {
        throw new WorkspaceBindingError("unavailable");
      }
      try {
        const existing = readWorkspaceBinding(id);
        if (existing?.root === expectedRoot) return;
        if (existing) throw new WorkspaceBindingError("collision");
        try {
          fs.renameSync(tempPath, finalPath);
        } catch {
          throw new WorkspaceBindingError("unavailable");
        }
        try {
          fs.chmodSync(finalPath, 0o600);
        } catch {
          // Best-effort permission repair for filesystems that do not support chmod.
        }
        syncDirectory(dir);
      } finally {
        if (lockHandle !== undefined) {
          try {
            fs.closeSync(lockHandle);
          } catch {
            // Best-effort lock descriptor cleanup.
          }
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // A stale lock is fail-closed on the next publication attempt.
        }
      }
      return;
    }

    try {
      fs.chmodSync(finalPath, 0o600);
    } catch {
      // Best-effort permission repair for filesystems that do not support chmod.
    }
    syncDirectory(dir);
  } finally {
    removeTemporaryBinding(tempPath);
  }
}

export function saveWorkspaceBinding(id: string, root: string): string {
  assertWorkspaceBindingId(id);
  const canonicalRoot = canonicalExistingWorkspaceRoot(root);
  const dir = ensureWorkspaceBindingDir();
  const filePath = workspaceBindingPathForIdInternal(id);
  const existing = readWorkspaceBinding(id);
  if (existing) {
    if (existing.root === canonicalRoot) return filePath;
    throw new WorkspaceBindingError("collision");
  }

  const payload = Buffer.from(`${JSON.stringify({ version: WORKSPACE_BINDING_VERSION, id, root: canonicalRoot })}\n`, "utf8");
  if (payload.byteLength > WORKSPACE_BINDING_MAX_BYTES) {
    throw new WorkspaceBindingError("invalid");
  }
  publishBindingNoReplace(dir, filePath, payload, id, canonicalRoot);
  return filePath;
}

function canonicalRootForIdentity(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function profileIdForRoot(root: string): string {
  return createHash("sha256").update(canonicalRootForIdentity(root)).digest("hex").slice(0, 24);
}

export function profilePathForRoot(root: string): string {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

export function runtimeDir(): string {
  return path.join(codexProHome(), "runtime");
}

export function runtimeStatusPathForRoot(root: string): string {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.json`);
}

export function runtimeFailurePathForRoot(root: string): string {
  return path.join(runtimeDir(), `${profileIdForRoot(root)}.last-failure.json`);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export function readWorkspaceProfile(root: string): WorkspaceProfile {
  const profilePath = profilePathForRoot(root);
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return {};
  const typed = profile as WorkspaceProfile;
  if (typed.root && canonicalRootForIdentity(typed.root) !== canonicalRootForIdentity(root)) return {};
  return { ...typed, profilePath };
}

export function saveWorkspaceProfile(root: string, profile: WorkspaceProfile): string {
  const canonicalRoot = canonicalRootForIdentity(root);
  const dir = profileDir();
  const filePath = profilePathForRoot(canonicalRoot);
  const { profilePath: _profilePath, ...rest } = profile;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: WorkspaceProfile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...rest,
    root: canonicalRoot
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort permission repair for filesystems that support chmod.
  }
  return filePath;
}

export function sanitizeWorkspaceProfile(profile: WorkspaceProfile): WorkspaceProfile {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: "<saved>" } : {}),
    ...(cloudflareToken ? { cloudflareToken: "<saved>" } : {})
  };
}

export function readRuntimeConnection(root: string): RuntimeConnection {
  const runtimePath = runtimeStatusPathForRoot(root);
  if (!fs.existsSync(runtimePath)) return {};
  const runtime = readJsonFile(runtimePath);
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return {};
  const typed = runtime as RuntimeConnection;
  if (typed.root && canonicalRootForIdentity(typed.root) !== canonicalRootForIdentity(root)) return {};
  if (typeof typed.pid === "number" && !processIsAlive(typed.pid)) {
    try {
      fs.rmSync(runtimePath, { force: true });
    } catch {
      // Best-effort stale runtime cleanup.
    }
    return {};
  }
  return typed;
}

export function readRuntimeFailure(root: string): RuntimeFailureRecord | null {
  const failurePath = runtimeFailurePathForRoot(root);
  try {
    const stat = fs.statSync(failurePath);
    if (!stat.isFile() || stat.size > RUNTIME_FAILURE_MAX_BYTES) return null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return null;
  }

  const failure = readJsonFile(failurePath);
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const typed = failure as RuntimeFailureRecord;
  if (typed.root && canonicalRootForIdentity(typed.root) !== canonicalRootForIdentity(root)) return null;
  return typed;
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}
