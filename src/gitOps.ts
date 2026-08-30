import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, isSubpath, PathGuard } from "./guard.js";
import { redactDiagnosticText, redactSensitiveText, redactUnifiedDiff, sourceLanguageForPath, type SourceLanguage } from "./redact.js";

export interface GitExecutionResultSummary {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdoutOverflow: boolean;
  readonly stderrOverflow: boolean;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/**
 * A bounded Git result whose raw streams stay private until a caller asks for
 * an explicit copy. The string getters retain the old runner compatibility
 * surface, while the serialization surface contains only status/count facts.
 */
export class GitExecutionResult {
  #stdout: Buffer;
  #stderr: Buffer;

  constructor(
    stdout: Buffer,
    stderr: Buffer,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly timedOut: boolean,
    readonly stdoutOverflow: boolean,
    readonly stderrOverflow: boolean
  ) {
    this.#stdout = Buffer.from(stdout);
    this.#stderr = Buffer.from(stderr);
  }

  get stdout(): string {
    return this.#stdout.toString("utf8");
  }

  get stderr(): string {
    return this.#stderr.toString("utf8");
  }

  copyStdoutBytes(): Buffer {
    return Buffer.from(this.#stdout);
  }

  copyStderrBytes(): Buffer {
    return Buffer.from(this.#stderr);
  }

  toJSON(): GitExecutionResultSummary {
    return {
      exitCode: this.exitCode,
      signal: this.signal,
      timedOut: this.timedOut,
      stdoutOverflow: this.stdoutOverflow,
      stderrOverflow: this.stderrOverflow,
      stdoutBytes: this.#stdout.length,
      stderrBytes: this.#stderr.length
    };
  }
}

export type GitExecutionFailure = "spawn" | "exit" | "signal" | "timeout" | "stdout-overflow" | "stderr-overflow";

/**
 * Typed failure for the internal reviewer runner. The bounded result is kept
 * on the error so callers can inspect Git's separate streams without parsing
 * a caller-visible success string for `fatal:` prefixes.
 */
export class GitExecutionError extends CodexProError {
  constructor(
    readonly result: GitExecutionResult,
    readonly failure: GitExecutionFailure,
    readonly spawnErrorCode?: string
  ) {
    super(`Git reviewer execution failed (${failure}).`);
    this.name = "GitExecutionError";
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      failure: this.failure,
      spawnErrorCode: this.spawnErrorCode,
      result: this.result.toJSON()
    };
  }
}

const GIT_REVIEWER_GLOBAL_ARGS = ["--no-replace-objects", "--no-pager", "-c", "color.ui=false"] as const;
const GIT_ISOLATION_MARKER = ".codexpro-git-isolation.json";
const GIT_ISOLATION_MARKER_KIND = "codexpro-git-isolation";
const GIT_ISOLATION_VERSION = 1;
const GIT_MIN_ATTR_SOURCE_MAJOR = 2;
const GIT_MIN_ATTR_SOURCE_MINOR = 41;
const GIT_NULL_CONFIG_PATH = process.platform === "win32" ? "NUL" : "/dev/null";

export interface GitReadOnlyOptions {
  readonly stdoutMaxBytes?: number;
  /** Controlled environment additions used by the private bare context. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Controlled global arguments placed before the Git subcommand. */
  readonly globalArgs?: readonly string[];
}

interface GitMutationOptions {
  /**
   * Keep the fixed literal-pathspec global by default. `check-ignore` does
   * not implement that Git global option, so its bounded internal caller may
   * opt out after validating the path and placing it after `--`.
   */
  readonly literalPathspecs?: boolean;
  /**
   * @internal Derived candidate index path for the local Git-commit recovery
   * transaction. This is deliberately not a general environment override.
   */
  readonly indexFile?: string;
}

function gitReviewerEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Git has a large and growing environment surface for repository routing,
  // object lookup, shallow history, pathspec behavior, tracing, credentials,
  // and external helpers. Preserve PATH and other non-Git process essentials,
  // but never inherit any Git-controlled variable by default.
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(key) && value !== undefined) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_CONFIG_SYSTEM: GIT_NULL_CONFIG_PATH,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ATTR_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_ATTR_SYSTEM: GIT_NULL_CONFIG_PATH,
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    LC_ALL: "C",
    LANG: "C"
  });
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

class BoundedGitOutput {
  private readonly bytes: Buffer;
  private length = 0;
  overflow = false;

  constructor(maxBytes: number) {
    this.bytes = Buffer.allocUnsafe(maxBytes);
  }

  append(chunk: Buffer | string): void {
    if (this.overflow) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.bytes.length - this.length;
    const copied = Math.min(remaining, incoming.length);
    if (copied > 0) {
      incoming.copy(this.bytes, this.length, 0, copied);
      this.length += copied;
    }
    if (copied < incoming.length) this.overflow = true;
  }

  text(): string {
    return this.bytes.subarray(0, this.length).toString("utf8");
  }

  copyBytes(): Buffer {
    return Buffer.from(this.bytes.subarray(0, this.length));
  }
}

function terminateGitProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the group and direct kill.
      }
      return;
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited before the timeout/overflow handler ran.
  }
}

function gitExecutionFailure(
  result: GitExecutionResult,
  spawnError: NodeJS.ErrnoException | undefined
): GitExecutionFailure | undefined {
  if (spawnError) return "spawn";
  if (result.timedOut) return "timeout";
  if (result.stdoutOverflow) return "stdout-overflow";
  if (result.stderrOverflow) return "stderr-overflow";
  if (result.signal) return "signal";
  if (result.exitCode !== 0) return "exit";
  return undefined;
}

/**
 * Execute one trusted internal Git operation with deterministic reviewer
 * defaults. The executable and shell mode are fixed; callers provide only
 * operation arguments. Non-success rejects with GitExecutionError and keeps
 * the bounded, separately captured result on the error.
 */
export async function runGitReadOnly(
  config: Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes"> &
    Partial<Pick<CodexProConfig, "maxReadBytes">>,
  workspace: Workspace,
  args: readonly string[],
  options?: GitReadOnlyOptions
): Promise<GitExecutionResult> {
  const maxOutputBytes = Number.isFinite(config.maxOutputBytes) ? Math.max(1, Math.floor(config.maxOutputBytes)) : 1;
  const maxReadBytes = Number.isFinite(config.maxReadBytes) ? Math.max(0, Math.floor(config.maxReadBytes as number)) : undefined;
  const stdoutCeiling = Math.max(maxOutputBytes, maxReadBytes ?? 0);
  const stdoutMaxBytes = stdoutLimit(options, maxOutputBytes, stdoutCeiling);
  const timeoutMs = Number.isFinite(config.maxGitTimeoutMs)
    ? Math.max(1, Math.min(300_000, Math.floor(config.maxGitTimeoutMs)))
    : 60_000;
  const stdout = new BoundedGitOutput(stdoutMaxBytes);
  const stderr = new BoundedGitOutput(maxOutputBytes);
  const globalArgs = [...GIT_REVIEWER_GLOBAL_ARGS, ...(options?.globalArgs ?? [])];

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...globalArgs, ...args], {
      cwd: workspace.root,
      env: gitReviewerEnvironment(options?.environment),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let timedOut = false;
    let closed = false;
    let terminationStarted = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;

    const terminateWithEscalation = () => {
      if (closed || terminationStarted) return;
      terminationStarted = true;
      terminateGitProcess(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!closed) terminateGitProcess(child, "SIGKILL");
      }, 250);
      escalationTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      if (closed) return;
      timedOut = true;
      terminateWithEscalation();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk);
      if (stdout.overflow) terminateWithEscalation();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
      if (stderr.overflow) terminateWithEscalation();
    });
    child.once("error", (error: Error) => {
      spawnError = error as NodeJS.ErrnoException;
    });
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      const result = new GitExecutionResult(
        stdout.copyBytes(),
        stderr.copyBytes(),
        spawnError ? null : exitCode,
        signal,
        timedOut,
        stdout.overflow,
        stderr.overflow
      );
      const failure = gitExecutionFailure(result, spawnError);
      if (failure) {
        reject(new GitExecutionError(result, failure, spawnError?.code));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Execute one bounded local Git operation for the mutation substrate.
 *
 * Unlike the reviewer runner above, this deliberately leaves Git's normal
 * system/global/local configuration hierarchy enabled. The caller cannot
 * supply environment or global-option overrides; every inherited GIT_* value
 * is removed before the fixed direct-argv invocation starts.
 */
export async function runGitMutation(
  config: Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes">,
  workspace: Workspace,
  args: readonly string[],
  options?: GitMutationOptions
): Promise<GitExecutionResult> {
  const maxOutputBytes = Number.isFinite(config.maxOutputBytes) ? Math.max(1, Math.floor(config.maxOutputBytes)) : 1;
  const timeoutMs = Number.isFinite(config.maxGitTimeoutMs)
    ? Math.max(1, Math.min(300_000, Math.floor(config.maxGitTimeoutMs)))
    : 60_000;
  const stdout = new BoundedGitOutput(maxOutputBytes);
  const stderr = new BoundedGitOutput(maxOutputBytes);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(key) && value !== undefined) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    // Snapshot/proof readers must not opportunistically rewrite a split index
    // while sibling readers are observing the same locked repository state.
    // Required mutation locks (including commit/update-index) remain active.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    LC_ALL: "C",
    LANG: "C"
  });
  if (options?.indexFile !== undefined) {
    if (!path.isAbsolute(options.indexFile) || /[\u0000-\u001f\u007f]/u.test(options.indexFile)) {
      throw new CodexProError("Git mutation index scope is invalid.");
    }
    environment.GIT_INDEX_FILE = options.indexFile;
  }

  // `--literal-pathspecs` is a fixed safety boundary for every command in
  // this private substrate. It protects selected names from pathspec magic;
  // callers still provide only the subcommand arguments below.
  const globalArgs = [
    "--no-replace-objects",
    "--no-pager",
    ...(options?.literalPathspecs === false ? [] : ["--literal-pathspecs"]),
    "-c",
    "color.ui=false"
  ] as const;
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...globalArgs, ...args], {
      cwd: workspace.root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let timedOut = false;
    let closed = false;
    let terminationStarted = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let spawnError: NodeJS.ErrnoException | undefined;

    const terminateWithEscalation = () => {
      if (closed || terminationStarted) return;
      terminationStarted = true;
      terminateGitProcess(child, "SIGTERM");
      escalationTimer = setTimeout(() => {
        if (!closed) terminateGitProcess(child, "SIGKILL");
      }, 250);
      escalationTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
      if (closed) return;
      timedOut = true;
      terminateWithEscalation();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.append(chunk);
      if (stdout.overflow) terminateWithEscalation();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.append(chunk);
      if (stderr.overflow) terminateWithEscalation();
    });
    child.once("error", (error: Error) => {
      spawnError = error as NodeJS.ErrnoException;
    });
    child.once("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      const result = new GitExecutionResult(
        stdout.copyBytes(),
        stderr.copyBytes(),
        spawnError ? null : exitCode,
        signal,
        timedOut,
        stdout.overflow,
        stderr.overflow
      );
      const failure = gitExecutionFailure(result, spawnError);
      if (failure) reject(new GitExecutionError(result, failure, spawnError?.code));
      else resolve(result);
    });
  });
}

interface GitRepositoryLayout {
  readonly commonGitDir: string;
  readonly objectDir: string;
}

interface GitIsolationMarker {
  readonly kind: typeof GIT_ISOLATION_MARKER_KIND;
  readonly version: typeof GIT_ISOLATION_VERSION;
  readonly token: string;
}

export interface GitReadOnlyContext {
  readonly workspace: Workspace;
  readonly environment: NodeJS.ProcessEnv;
  /** Global Git options, including the captured head attribute source. */
  readonly globalArgs: readonly string[];
  /** Empty order file used by every direct two-tree diff producer. */
  readonly orderFile: string;
  cleanup(): Promise<void>;
}

function isDirectoryStat(stat: import("node:fs").Stats | undefined): boolean {
  return stat?.isDirectory() === true;
}

async function statOrUndefined(filePath: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fsp.stat(filePath);
  } catch {
    return undefined;
  }
}

async function commonGitDirFromWorktreeGitDir(gitDir: string): Promise<string> {
  const commondirPath = path.join(gitDir, "commondir");
  const commondirStat = await statOrUndefined(commondirPath);
  if (!commondirStat?.isFile()) return fsp.realpath(gitDir);
  const content = (await fsp.readFile(commondirPath, "utf8")).trim();
  if (!content || /[\u0000\r\n]/u.test(content)) throw new Error("invalid Git common-dir metadata");
  return fsp.realpath(path.resolve(gitDir, content));
}

async function gitDirFromDotGit(dotGitPath: string): Promise<string | undefined> {
  const stat = await statOrUndefined(dotGitPath);
  if (!stat) return undefined;
  if (stat.isDirectory()) return commonGitDirFromWorktreeGitDir(await fsp.realpath(dotGitPath));
  if (!stat.isFile()) return undefined;

  const content = await fsp.readFile(dotGitPath, "utf8");
  const match = /^gitdir:\s*(\S(?:.*\S)?)\s*$/mu.exec(content);
  if (!match) throw new Error("invalid Git directory pointer");
  const gitDir = await fsp.realpath(path.resolve(path.dirname(dotGitPath), match[1]));
  return commonGitDirFromWorktreeGitDir(gitDir);
}

async function isBareGitDir(candidate: string): Promise<boolean> {
  const [head, config, objects] = await Promise.all([
    statOrUndefined(path.join(candidate, "HEAD")),
    statOrUndefined(path.join(candidate, "config")),
    statOrUndefined(path.join(candidate, "objects"))
  ]);
  return Boolean(head?.isFile() && config?.isFile() && isDirectoryStat(objects));
}

async function locateGitRepositoryLayout(workspace: Workspace): Promise<GitRepositoryLayout> {
  let current = await fsp.realpath(workspace.root);
  while (true) {
    const dotGitPath = path.join(current, ".git");
    const dotGitStat = await statOrUndefined(dotGitPath);
    let commonGitDir: string | undefined;
    if (dotGitStat) {
      commonGitDir = await gitDirFromDotGit(dotGitPath);
    } else if (await isBareGitDir(current)) {
      commonGitDir = current;
    }
    if (commonGitDir !== undefined) {
      const objectDir = path.join(commonGitDir, "objects");
      const objectStat = await statOrUndefined(objectDir);
      if (!isDirectoryStat(objectStat)) throw new Error("Git object database is unavailable");
      return { commonGitDir, objectDir: await fsp.realpath(objectDir) };
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Git repository is unavailable");
}

function parseGitVersion(stdout: string): { readonly major: number; readonly minor: number; readonly patch: number } | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/mu.exec(stdout.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0)
  };
}

function supportsAttrSource(version: { readonly major: number; readonly minor: number }): boolean {
  return version.major > GIT_MIN_ATTR_SOURCE_MAJOR
    || (version.major === GIT_MIN_ATTR_SOURCE_MAJOR && version.minor >= GIT_MIN_ATTR_SOURCE_MINOR);
}

function fullObjectId(value: string, objectFormat: "sha1" | "sha256"): boolean {
  const length = objectFormat === "sha1" ? 40 : 64;
  return value.length === length && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value);
}

function encodeGitAlternatePath(value: string): string {
  // GIT_ALTERNATE_OBJECT_DIRECTORIES uses Git's C-style quoted path syntax,
  // not a plain platform path list. Quote every path so spaces, colons, and
  // backslashes cannot alter the object-directory boundary.
  let encoded = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (character === '"') encoded += '\\\"';
    else if (character === "\\") encoded += "\\\\";
    else if (codePoint < 0x20 || codePoint === 0x7f) encoded += `\\${codePoint.toString(8).padStart(3, "0")}`;
    else encoded += character;
  }
  return `${encoded}"`;
}

async function writeEmptyFile(filePath: string): Promise<void> {
  await fsp.writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
}

async function safeGitIsolationCleanup(root: string, token: string): Promise<void> {
  if (!path.basename(root).startsWith("codexpro-git-range-")) {
    throw new CodexProError("Git reviewer isolation cleanup was not authorized.");
  }
  const markerPath = path.join(root, GIT_ISOLATION_MARKER);
  let marker: GitIsolationMarker;
  try {
    const parsed = JSON.parse(await fsp.readFile(markerPath, "utf8")) as Partial<GitIsolationMarker>;
    if (parsed.kind !== GIT_ISOLATION_MARKER_KIND || parsed.version !== GIT_ISOLATION_VERSION || parsed.token !== token) {
      throw new Error("Git isolation marker mismatch");
    }
    marker = parsed as GitIsolationMarker;
  } catch {
    throw new CodexProError("Git reviewer isolation cleanup was not authorized.");
  }
  void marker;

  let stat: import("node:fs").Stats;
  try {
    stat = await fsp.lstat(root);
  } catch {
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CodexProError("Git reviewer isolation cleanup was not authorized.");
  }
  try {
    await fsp.rm(root, { recursive: true, force: true });
  } catch {
    throw new CodexProError("Git reviewer isolation cleanup failed.");
  }
}

/**
 * Build a disposable bare repository used only for direct two-tree reads.
 * The target checkout contributes its canonical object database through a
 * read-only alternate; refs, index, worktree, and info attributes are never
 * copied into the context.
 */
export async function createGitReadOnlyContext(
  config: Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes"> & Partial<Pick<CodexProConfig, "maxReadBytes">>,
  workspace: Workspace,
  objectFormat: "sha1" | "sha256",
  attrSource: string
): Promise<GitReadOnlyContext> {
  if (!fullObjectId(attrSource, objectFormat)) throw new CodexProError("Git reviewer attribute source is invalid.");

  let versionResult: GitExecutionResult;
  try {
    versionResult = await runGitReadOnly(config, workspace, ["--version"]);
  } catch {
    throw new CodexProError("Git reviewer attribute source support is unavailable.");
  }
  const version = parseGitVersion(versionResult.stdout);
  if (!version || !supportsAttrSource(version)) {
    throw new CodexProError("Git reviewer attribute source support is unavailable.");
  }

  let layout: GitRepositoryLayout;
  try {
    layout = await locateGitRepositoryLayout(workspace);
  } catch {
    throw new CodexProError("Git reviewer repository isolation is unavailable.");
  }

  let tempBase: string;
  let targetRoot: string;
  try {
    tempBase = await fsp.realpath(path.resolve(os.tmpdir()));
    targetRoot = await fsp.realpath(workspace.root);
  } catch {
    throw new CodexProError("Git reviewer isolation directory is unavailable.");
  }
  if (isSubpath(tempBase, targetRoot)) {
    throw new CodexProError("Git reviewer isolation directory is not outside the target repository.");
  }

  let root: string;
  try {
    root = await fsp.mkdtemp(path.join(tempBase, "codexpro-git-range-"));
  } catch {
    throw new CodexProError("Git reviewer isolation directory is unavailable.");
  }
  let markerWritten = false;
  const token = randomBytes(16).toString("hex");
  const marker: GitIsolationMarker = {
    kind: GIT_ISOLATION_MARKER_KIND,
    version: GIT_ISOLATION_VERSION,
    token
  };
  try {
    const canonicalRoot = await fsp.realpath(root);
    await fsp.writeFile(path.join(root, GIT_ISOLATION_MARKER), `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
    markerWritten = true;
    if (isSubpath(canonicalRoot, targetRoot)) throw new CodexProError("Git reviewer isolation directory is not outside the target repository.");

    const home = path.join(root, "home");
    const xdg = path.join(root, "xdg");
    const template = path.join(root, "template");
    const globalConfig = path.join(root, "global.gitconfig");
    const systemConfig = path.join(root, "system.gitconfig");
    const globalAttributes = path.join(root, "global.attributes");
    const systemAttributes = path.join(root, "system.attributes");
    const orderFile = path.join(root, "empty.order");
    await Promise.all([
      fsp.mkdir(home, { recursive: true, mode: 0o700 }),
      fsp.mkdir(xdg, { recursive: true, mode: 0o700 }),
      fsp.mkdir(template, { recursive: true, mode: 0o700 }),
      writeEmptyFile(globalConfig),
      writeEmptyFile(systemConfig),
      writeEmptyFile(globalAttributes),
      writeEmptyFile(systemAttributes),
      writeEmptyFile(orderFile)
    ]);

    const contextParent = path.dirname(root);
    const initEnvironment = gitReviewerEnvironment({
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_TEMPLATE_DIR: template,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_ATTR_GLOBAL: globalAttributes,
      GIT_ATTR_SYSTEM: systemAttributes
    });
    const initWorkspace: Workspace = {
      id: `${workspace.id}:git-init`,
      root: contextParent,
      openedAt: new Date().toISOString()
    };
    await runGitReadOnly(
      config,
      initWorkspace,
      ["init", "--bare", `--object-format=${objectFormat}`, root],
      { environment: initEnvironment }
    );

    const environment = gitReviewerEnvironment({
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_TEMPLATE_DIR: template,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_ATTR_GLOBAL: globalAttributes,
      GIT_ATTR_SYSTEM: systemAttributes,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: encodeGitAlternatePath(layout.objectDir),
      GIT_ATTR_SOURCE: attrSource
    });
    const globalArgs = [
      `--attr-source=${attrSource}`,
      "-c", "core.quotePath=true",
      "-c", `core.attributesFile=${globalAttributes}`,
      "-c", "core.autocrlf=false",
      "-c", "diff.algorithm=myers",
      "-c", "diff.indentHeuristic=false",
      "-c", "diff.renames=true",
      "-c", "diff.renameLimit=1000",
      "-c", "diff.external=",
      "-c", "diff.trustExitCode=false",
      "-c", "diff.relative=false",
      "-c", "diff.submodule=short"
    ] as const;
    const contextWorkspace: Workspace = {
      id: `${workspace.id}:git-context:${token.slice(0, 12)}`,
      root,
      openedAt: new Date().toISOString()
    };
    let cleaned = false;
    return {
      workspace: contextWorkspace,
      environment,
      globalArgs,
      orderFile,
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        await safeGitIsolationCleanup(root, token);
      }
    };
  } catch (error) {
    if (markerWritten) await safeGitIsolationCleanup(root, token).catch(() => undefined);
    if (error instanceof CodexProError && !(error instanceof GitExecutionError)) throw error;
    throw new CodexProError("Git reviewer repository isolation failed.");
  }
}

function stdoutLimit(
  options: { readonly stdoutMaxBytes?: number } | undefined,
  defaultLimit: number,
  ceiling: number
): number {
  if (options === undefined) return defaultLimit;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new CodexProError("Git reviewer stdout limit override is invalid.");
  }
  const override = options.stdoutMaxBytes;
  if (override === undefined) return defaultLimit;
  if (!Number.isInteger(override) || override < 0) {
    throw new CodexProError("Git reviewer stdout limit override is invalid.");
  }
  if (override > ceiling) {
    throw new CodexProError("Git reviewer stdout limit override exceeds its authorized ceiling.");
  }
  return override;
}

function runGit(
  workspace: Workspace,
  args: string[],
  maxOutputBytes: number,
  languageForPath?: (path: string | undefined) => SourceLanguage | undefined
): string {
  const result = spawnSync("git", args, {
    cwd: workspace.root,
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (result.error) {
    return redactDiagnosticText(`git unavailable or failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || "";
    const stdout = result.stdout?.trim() || "";
    return redactDiagnosticText(stderr || stdout || `git exited with status ${result.status}`);
  }
  const output = result.stdout.trim() || "(no output)";
  if (args[0] === "diff") {
    return redactUnifiedDiff(output, languageForPath ?? sourceLanguageForPath);
  }
  return redactSensitiveText(output);
}

function isGitFailure(output: string): boolean {
  const trimmed = output.trim().toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    trimmed.includes("not a git repository")
  );
}

function outputLines(output: string): string[] {
  return output.trim() === "(no output)" ? [] : output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitStatus(config: CodexProConfig, workspace: Workspace, guard?: PathGuard, filePath?: string, staged = false): string {
  const args = staged ? ["diff", "--cached", "--name-status"] : ["status", "--short", "--branch"];
  if (filePath?.trim()) {
    if (!guard) return "path-scoped git status requires a path guard";
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  return runGit(workspace, args, config.maxOutputBytes);
}

export function gitDiff(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (staged) args.push("--staged");
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
  }
  // The redaction policy consults the actual ---/+++ side path from Git's
  // output. A scoped query only constrains which diff Git emits; it must never
  // donate its one path language to a renamed/copied opposite side.
  return runGit(workspace, args, config.maxOutputBytes, sourceLanguageForPath);
}

export function gitDiffStatus(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath?: string, staged = false): string {
  const args = ["diff", "--name-status"];
  if (staged) args.push("--staged");
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard"];
  if (filePath?.trim()) {
    const resolved = guard.resolve(workspace, filePath);
    args.push("--", resolved.relPath);
    untrackedArgs.push("--", resolved.relPath);
  }
  const diffStatus = runGit(workspace, args, config.maxOutputBytes);
  if (staged || isGitFailure(diffStatus)) return diffStatus;
  const untracked = runGit(workspace, untrackedArgs, config.maxOutputBytes);
  if (isGitFailure(untracked)) return diffStatus;
  const lines = [...outputLines(diffStatus), ...outputLines(untracked).map((line) => `?? ${line}`)];
  return lines.length ? lines.join("\n") : "(no output)";
}

export function gitLog(config: CodexProConfig, workspace: Workspace, maxCount = 8): string {
  const count = Math.max(1, Math.min(Math.floor(maxCount), 30));
  return runGit(workspace, ["log", `--max-count=${count}`, "--oneline", "--decorate"], config.maxOutputBytes);
}

export function assertGitCleanEnoughForWrite(_workspace: Workspace): void {
  // Reserved for future policy hooks. The first version allows writes and returns diffs.
  return;
}
