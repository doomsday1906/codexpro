import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { terminateProcessTree, makeRestrictedBashEnv, assertBashSession, SAFE_BLOCKED_PATTERNS } from "./bashOps.js";
import { redactDiagnosticText } from "./redact.js";

export type VerificationRunnerFamily =
  | "package_script"
  | "pytest"
  | "go_test"
  | "cargo"
  | "tsc"
  | "eslint"
  | "biome_check";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type VerificationJobState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "output_limit_exceeded";

export interface VerificationStartInput {
  workspace_id: string;
  runner: VerificationRunnerFamily;
  package_manager?: PackageManager;
  script?: string;
  args?: string[];
  cwd?: string;
  lifetime_ms?: number;
  session_id?: string;
}

export interface VerificationJobRecord {
  jobId: string;
  state: VerificationJobState;
  workspaceId: string;
  workspaceRoot: string;
  cwd: string;
  runner: VerificationRunnerFamily;
  packageManager?: PackageManager;
  script?: string;
  args: string[];
  commandSummary: string;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  observedStdoutBytes: number;
  observedStderrBytes: number;
  observedTotalBytes: number;
  terminalReason?: string;
  lifetimeMs: number;
  containmentWrapper?: string[];
}

export interface VerificationManagerLimits {
  minLifetimeMs: number;
  defaultLifetimeMs: number;
  maxLifetimeMs: number;
  maxActiveJobs: number;
  terminalRecordTtlMs: number;
  terminalRecordMax: number;
  hardOutputCeilingBytes: number;
  retainedTailBytes: number;
}

export const DEFAULT_VERIFICATION_LIMITS: VerificationManagerLimits = {
  minLifetimeMs: 10_000,
  defaultLifetimeMs: 1_800_000, // 30 minutes
  maxLifetimeMs: 3_600_000, // 60 minutes
  maxActiveJobs: 3,
  terminalRecordTtlMs: 3_600_000, // 60 minutes
  terminalRecordMax: 32,
  hardOutputCeilingBytes: 16 * 1024 * 1024, // 16 MiB
  retainedTailBytes: 120_000
};

const VALID_RUNNERS = new Set<string>([
  "package_script",
  "pytest",
  "go_test",
  "cargo",
  "tsc",
  "eslint",
  "biome_check"
]);

const VALID_PACKAGE_MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

const FORBIDDEN_SCRIPT_TOKENS = new Set<string>([
  "start", "dev", "serve", "server", "watch", "publish", "deploy",
  "install", "preinstall", "postinstall", "prepublish", "prepare",
  "prepack", "postpack", "listen", "daemon", "preview",
  "fix", "mutate", "format", "write", "update", "upgrade"
]);

const SCRIPT_NAME_REGEX = /^[A-Za-z0-9._:-]+$/;
const CARGO_ALLOWED_SUBCOMMANDS = new Set<string>(["test", "check", "clippy"]);
const MAX_ARGS_COUNT = 64;
const MAX_ARG_LENGTH = 1024;
const MAX_TOTAL_ARG_BYTES = 8192;
const SHELL_META_PATTERN = /[;&|<>`$]/;

export function validatePackageScriptName(script: unknown): string {
  if (typeof script !== "string" || !script.trim()) {
    throw new CodexProError("script name is required for package_script runner.");
  }
  const trimmed = script.trim();
  if (trimmed.length > 128) {
    throw new CodexProError(`Script name too long: ${trimmed.length} chars (max 128).`);
  }
  if (!SCRIPT_NAME_REGEX.test(trimmed)) {
    throw new CodexProError(`Script name contains invalid characters: '${trimmed}'. Allowed: letters, numbers, dot, dash, underscore, colon.`);
  }
  const tokens = trimmed.toLowerCase().split(/[:_\-\/]+/);
  for (const token of tokens) {
    if (FORBIDDEN_SCRIPT_TOKENS.has(token)) {
      throw new CodexProError(`Package script '${trimmed}' is blocked: non-verification lifecycle/daemon/deployment/mutating token '${token}' is not allowed.`);
    }
  }
  return trimmed;
}

export function validateArgs(args: unknown): string[] {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) {
    throw new CodexProError("args must be an array of strings.");
  }
  if (args.length > MAX_ARGS_COUNT) {
    throw new CodexProError(`Too many arguments: ${args.length} (max ${MAX_ARGS_COUNT}).`);
  }
  let totalBytes = 0;
  const sanitized: string[] = [];
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new CodexProError("Every argument in args must be a string.");
    }
    if (arg.length > MAX_ARG_LENGTH) {
      throw new CodexProError(`Argument exceeds maximum length of ${MAX_ARG_LENGTH}: ${arg.slice(0, 32)}...`);
    }
    if (/[\x00-\x1f\x7f]/.test(arg)) {
      throw new CodexProError("Arguments must not contain control characters or newlines.");
    }
    if (SHELL_META_PATTERN.test(arg)) {
      throw new CodexProError(`Argument contains forbidden shell metacharacter: '${arg}'`);
    }

    // Path safety: block absolute paths, home paths, and parent traversal
    if (arg.startsWith("/") || arg.startsWith("\\") || /^[A-Za-z]:[/\\]/.test(arg)) {
      throw new CodexProError(`Argument contains forbidden absolute path: '${arg}'. Arguments must be workspace-relative.`);
    }
    if (arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")) {
      throw new CodexProError(`Argument contains forbidden home path: '${arg}'. Arguments must be workspace-relative.`);
    }
    if (/(^|[/\\])\.\.([/\\]|$)/.test(arg)) {
      throw new CodexProError(`Argument contains forbidden parent directory traversal: '${arg}'.`);
    }

    // Block long-lived watch flags across all runners
    const lower = arg.toLowerCase();
    if (lower === "--watch" || lower === "-w" || lower === "--watchall" || lower.startsWith("--watch=") || lower.startsWith("-w=")) {
      throw new CodexProError(`Argument '${arg}' is blocked: watch mode is forbidden for verification jobs.`);
    }

    // Block write/fix/mutate flags across all runners
    if (
      lower === "--fix" ||
      lower === "--fix-dry-run" ||
      lower === "--fix-type" ||
      lower === "--write" ||
      lower === "--apply" ||
      lower === "--apply-unsafe" ||
      lower.startsWith("--fix=") ||
      lower.startsWith("--write=") ||
      lower.startsWith("--apply=")
    ) {
      throw new CodexProError(`Argument '${arg}' is blocked: source-mutating flags are forbidden for verification jobs.`);
    }

    // Block file output redirection / delegation flags
    if (
      lower === "--output" ||
      lower === "--output-file" ||
      lower === "-o" ||
      lower === "--outfile" ||
      lower === "--outdir" ||
      lower.startsWith("--output=") ||
      lower.startsWith("--output-file=") ||
      lower.startsWith("-o=") ||
      lower.startsWith("--outfile=") ||
      lower.startsWith("--outdir=") ||
      lower === "-exec" ||
      lower === "-execdir" ||
      lower === "-delete" ||
      lower === "-ok" ||
      lower === "-okdir" ||
      lower === "-fprint" ||
      lower === "-fprintf" ||
      lower === "-fls"
    ) {
      throw new CodexProError(`Argument '${arg}' is blocked: output writing or execution delegation is forbidden.`);
    }

    // Sensitive file protection (from SAFE_BLOCKED_PATTERNS)
    for (const pattern of SAFE_BLOCKED_PATTERNS) {
      if (pattern.test(arg) || pattern.test(` ${arg} `)) {
        throw new CodexProError(`Argument contains blocked or unsafe pattern: '${arg}'`);
      }
    }

    totalBytes += Buffer.byteLength(arg, "utf8");
    if (totalBytes > MAX_TOTAL_ARG_BYTES) {
      throw new CodexProError(`Total arguments size exceeds ${MAX_TOTAL_ARG_BYTES} bytes.`);
    }
    sanitized.push(arg);
  }
  return sanitized;
}

export function compileRunnerArgv(input: {
  runner: VerificationRunnerFamily;
  package_manager?: PackageManager;
  script?: string;
  args?: string[];
}): string[] {
  if (!VALID_RUNNERS.has(input.runner)) {
    throw new CodexProError(`Unsupported runner family: '${input.runner}'. Allowed: ${[...VALID_RUNNERS].join(", ")}`);
  }
  const args = validateArgs(input.args);

  switch (input.runner) {
    case "package_script": {
      const pm = input.package_manager || "npm";
      if (!VALID_PACKAGE_MANAGERS.has(pm)) {
        throw new CodexProError(`Unsupported package manager: '${pm}'. Allowed: ${[...VALID_PACKAGE_MANAGERS].join(", ")}`);
      }
      const script = validatePackageScriptName(input.script);
      if (pm === "yarn") {
        return args.length > 0 ? ["yarn", "run", script, ...args] : ["yarn", "run", script];
      }
      return args.length > 0 ? [pm, "run", script, "--", ...args] : [pm, "run", script];
    }
    case "pytest": {
      for (const arg of args) {
        const lower = arg.toLowerCase();
        if (lower === "--watch" || lower === "-w" || lower.startsWith("--watch=")) {
          throw new CodexProError(`pytest option '${arg}' is blocked: watch mode is forbidden.`);
        }
        if (lower === "--pdb" || lower === "--capture=no") {
          throw new CodexProError(`pytest option '${arg}' is blocked: interactive debugging flags are forbidden.`);
        }
        if (lower === "-o" || lower === "--override-ini" || lower.startsWith("-o=") || lower.startsWith("--override-ini=")) {
          throw new CodexProError(`pytest option '${arg}' is blocked: configuration override flags are forbidden.`);
        }
      }
      return ["pytest", ...args];
    }
    case "go_test": {
      for (const arg of args) {
        const lower = arg.toLowerCase();
        if (lower === "-exec" || lower.startsWith("-exec=")) {
          throw new CodexProError(`go test option '${arg}' is blocked: arbitrary execution delegation is forbidden.`);
        }
        if (lower === "-o" || lower.startsWith("-o=")) {
          throw new CodexProError(`go test option '${arg}' is blocked: binary output writing is forbidden.`);
        }
      }
      return ["go", "test", ...args];
    }
    case "cargo": {
      if (args.length === 0) {
        return ["cargo", "test"];
      }
      const subcommand = args[0].toLowerCase();
      if (!CARGO_ALLOWED_SUBCOMMANDS.has(subcommand)) {
        throw new CodexProError(`Forbidden cargo subcommand: '${args[0]}'. Allowed: ${[...CARGO_ALLOWED_SUBCOMMANDS].join(", ")}`);
      }
      for (const arg of args.slice(1)) {
        const lower = arg.toLowerCase();
        if (lower === "--target-dir" || lower.startsWith("--target-dir=") || lower === "--config" || lower.startsWith("--config=")) {
          throw new CodexProError(`cargo option '${arg}' is blocked.`);
        }
      }
      return ["cargo", ...args];
    }
    case "tsc": {
      for (const arg of args) {
        const lower = arg.toLowerCase();
        if (lower === "--watch" || lower === "-w" || lower.startsWith("--watch=") || lower.startsWith("-w=")) {
          throw new CodexProError(`tsc option '${arg}' is blocked: long-lived watch mode is forbidden for verification jobs.`);
        }
        if (lower === "--outfile" || lower.startsWith("--outfile=") || lower === "--outdir" || lower.startsWith("--outdir=")) {
          throw new CodexProError(`tsc option '${arg}' is blocked: output writing is forbidden for verification jobs.`);
        }
      }
      return ["tsc", ...args];
    }
    case "eslint": {
      for (const arg of args) {
        const lower = arg.toLowerCase();
        if (lower === "--fix" || lower === "--fix-dry-run" || lower === "--fix-type" || lower.startsWith("--fix=")) {
          throw new CodexProError(`eslint option '${arg}' is blocked: mutating source files is forbidden for verification jobs.`);
        }
        if (lower === "-o" || lower === "--output-file" || lower.startsWith("--output-file=")) {
          throw new CodexProError(`eslint option '${arg}' is blocked: output writing is forbidden for verification jobs.`);
        }
        if (lower === "--rulesdir" || lower.startsWith("--rulesdir=") || lower === "--rule" || lower.startsWith("--rule=")) {
          throw new CodexProError(`eslint option '${arg}' is blocked: arbitrary rule/plugin delegation is forbidden.`);
        }
      }
      return ["eslint", ...args];
    }
    case "biome_check": {
      for (const arg of args) {
        const lower = arg.toLowerCase();
        if (lower === "--write" || lower.startsWith("--write=") || lower === "--fix" || lower === "--apply" || lower === "--apply-unsafe") {
          throw new CodexProError(`biome check option '${arg}' is blocked: mutating source files is forbidden for verification jobs.`);
        }
      }
      return ["biome", "check", ...args];
    }
    default:
      throw new CodexProError(`Unhandled runner: ${input.runner}`);
  }
}

export function isExecutableAvailable(executable: string, envPath?: string): boolean {
  if (path.isAbsolute(executable) || (process.platform === "win32" && path.win32.isAbsolute(executable))) {
    try {
      if (!fs.existsSync(executable)) return false;
      const stat = fs.statSync(executable);
      if (!stat.isFile()) return false;
      if (process.platform !== "win32") {
        fs.accessSync(executable, fs.constants.X_OK);
      }
      return true;
    } catch {
      return false;
    }
  }
  const searchPath = envPath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const dirs = searchPath.split(path.delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, executable.endsWith(ext) ? executable : executable + ext);
      try {
        if (fs.existsSync(candidate)) {
          const stat = fs.statSync(candidate);
          if (stat.isFile()) {
            if (process.platform !== "win32") {
              fs.accessSync(candidate, fs.constants.X_OK);
            }
            return true;
          }
        }
      } catch {
        // continue searching
      }
    }
  }
  return false;
}

export function validateContainmentWrapper(wrapperArgv?: string[], envPath?: string): string[] | undefined {
  if (!wrapperArgv || wrapperArgv.length === 0) return undefined;
  const executable = wrapperArgv[0];
  if (typeof executable !== "string" || !executable.trim()) {
    throw new CodexProError("Configured containment wrapper executable is empty or invalid.");
  }
  if (!isExecutableAvailable(executable, envPath)) {
    throw new CodexProError(`Configured containment wrapper executable '${executable}' was not found or is not executable (containment wrapper path does not exist).`);
  }
  for (let i = 1; i < wrapperArgv.length; i++) {
    const part = wrapperArgv[i];
    if (path.isAbsolute(part) && !fs.existsSync(part)) {
      throw new CodexProError(`Configured containment wrapper path does not exist: ${part}`);
    }
  }
  return [...wrapperArgv];
}

export function composeExecutionArgv(runnerArgv: string[], containmentWrapperArgv?: string[]): string[] {
  if (!containmentWrapperArgv || containmentWrapperArgv.length === 0) {
    return [...runnerArgv];
  }
  return [...containmentWrapperArgv, ...runnerArgv];
}

export function clampLifetime(
  requestedMs?: number,
  minMs = DEFAULT_VERIFICATION_LIMITS.minLifetimeMs,
  maxMs = DEFAULT_VERIFICATION_LIMITS.maxLifetimeMs,
  defaultMs = DEFAULT_VERIFICATION_LIMITS.defaultLifetimeMs
): number {
  if (requestedMs === undefined || requestedMs === null) return defaultMs;
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs)) {
    throw new CodexProError("lifetime_ms must be a finite number.");
  }
  return Math.max(minMs, Math.min(Math.floor(requestedMs), maxMs));
}

interface StreamChunk {
  stream: "stdout" | "stderr";
  buf: Buffer;
}

export class CombinedRollingTailBuffer {
  private chunks: StreamChunk[] = [];
  private retainedBytes = 0;

  constructor(public readonly maxBytes: number) {}

  append(stream: "stdout" | "stderr", buf: Buffer): void {
    this.chunks.push({ stream, buf });
    this.retainedBytes += buf.byteLength;
    while (this.chunks.length > 0 && this.retainedBytes > this.maxBytes) {
      const excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.buf.byteLength <= excess) {
        this.retainedBytes -= first.buf.byteLength;
        this.chunks.shift();
      } else {
        first.buf = first.buf.subarray(excess);
        this.retainedBytes -= excess;
        break;
      }
    }
  }

  getOutputs(): { stdout: string; stderr: string } {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    for (const item of this.chunks) {
      if (item.stream === "stdout") stdoutChunks.push(item.buf);
      else stderrChunks.push(item.buf);
    }
    return {
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8")
    };
  }
}

export class ManagedVerificationJob {
  public readonly jobId: string;
  public readonly workspaceId: string;
  public readonly workspaceRoot: string;
  public readonly cwd: string; // workspace-relative
  public readonly runner: VerificationRunnerFamily;
  public readonly packageManager?: PackageManager;
  public readonly script?: string;
  public readonly args: string[];
  public readonly commandSummary: string;
  public readonly createdAt: string;
  public startedAt: string;
  public finishedAt?: string;
  public durationMs?: number;
  public exitCode: number | null = null;
  public signal: NodeJS.Signals | null = null;
  public state: VerificationJobState = "running";
  public terminalReason?: string;
  public readonly lifetimeMs: number;
  public readonly containmentWrapper?: string[];

  private readonly absCwd: string;
  private readonly executionArgv: string[];
  private readonly config: CodexProConfig;
  private readonly hardOutputCeilingBytes: number;
  private readonly retainedTailBytes: number;

  private child?: ChildProcess;
  private lifetimeTimer?: NodeJS.Timeout;
  private killEscalationTimer?: NodeJS.Timeout;
  private closed = false;
  private terminationStarted = false;
  private pendingTerminalState?: VerificationJobState;
  private pendingTerminalReason?: string;
  private startTimeMs: number;

  private observedStdoutBytes = 0;
  private observedStderrBytes = 0;
  private combinedBuffer: CombinedRollingTailBuffer;

  private readonly waiters = new Set<() => void>();

  constructor(options: {
    jobId: string;
    workspace: Workspace;
    cwd: string;
    absCwd: string;
    runner: VerificationRunnerFamily;
    packageManager?: PackageManager;
    script?: string;
    args: string[];
    executionArgv: string[];
    commandSummary: string;
    lifetimeMs: number;
    containmentWrapper?: string[];
    config: CodexProConfig;
    hardOutputCeilingBytes?: number;
    retainedTailBytes?: number;
  }) {
    this.jobId = options.jobId;
    this.workspaceId = options.workspace.id;
    this.workspaceRoot = options.workspace.root;
    this.cwd = options.cwd;
    this.absCwd = options.absCwd;
    this.runner = options.runner;
    this.packageManager = options.packageManager;
    this.script = options.script;
    this.args = options.args;
    this.executionArgv = options.executionArgv;
    this.commandSummary = options.commandSummary;
    this.lifetimeMs = options.lifetimeMs;
    this.containmentWrapper = options.containmentWrapper;
    this.config = options.config;
    this.hardOutputCeilingBytes = options.hardOutputCeilingBytes ?? DEFAULT_VERIFICATION_LIMITS.hardOutputCeilingBytes;
    this.retainedTailBytes = options.retainedTailBytes ?? (options.config.maxOutputBytes || DEFAULT_VERIFICATION_LIMITS.retainedTailBytes);

    const now = new Date();
    this.createdAt = now.toISOString();
    this.startedAt = now.toISOString();
    this.startTimeMs = now.getTime();

    this.combinedBuffer = new CombinedRollingTailBuffer(this.retainedTailBytes);
  }

  public start(): void {
    const binary = this.executionArgv[0];
    const argv = this.executionArgv.slice(1);

    const baseEnv = makeRestrictedBashEnv(this.config);
    const nodeBinDirs = [
      path.join(this.absCwd, "node_modules", ".bin"),
      path.join(this.workspaceRoot, "node_modules", ".bin")
    ];
    const pathParts = [...nodeBinDirs, baseEnv.PATH || ""].filter(Boolean);
    const env = {
      ...baseEnv,
      PATH: pathParts.join(path.delimiter)
    };

    this.child = spawn(binary, argv, {
      cwd: this.absCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    this.lifetimeTimer = setTimeout(() => {
      this.handleLifetimeTimeout();
    }, this.lifetimeMs);
    this.lifetimeTimer.unref();

    this.child.stdout?.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.observedStdoutBytes += buf.byteLength;
      this.combinedBuffer.append("stdout", buf);
      this.checkOutputCeiling();
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.observedStderrBytes += buf.byteLength;
      this.combinedBuffer.append("stderr", buf);
      this.checkOutputCeiling();
    });

    this.child.on("error", (err: Error) => {
      const errBuf = Buffer.from(`\n[codexpro] Spawn error: ${err.message}`);
      this.observedStderrBytes += errBuf.byteLength;
      this.combinedBuffer.append("stderr", errBuf);
      this.transitionToTerminal("failed", {
        exitCode: 1,
        signal: null,
        reason: `Process spawn error: ${err.message}`
      });
    });

    this.child.on("close", (code, sig) => {
      this.closed = true;
      this.cleanupTimers();

      let targetState: VerificationJobState = "succeeded";
      let reason: string | undefined;

      if (this.pendingTerminalState) {
        targetState = this.pendingTerminalState;
        reason = this.pendingTerminalReason;
      } else if (code !== 0 || sig !== null) {
        targetState = "failed";
        reason = sig ? `Terminated with signal ${sig}` : `Exited with code ${code}`;
      }

      this.transitionToTerminal(targetState, {
        exitCode: code,
        signal: sig,
        reason
      });
    });
  }

  private checkOutputCeiling(): void {
    const total = this.observedStdoutBytes + this.observedStderrBytes;
    if (total > this.hardOutputCeilingBytes && !this.terminationStarted) {
      this.pendingTerminalState = "output_limit_exceeded";
      this.pendingTerminalReason = `Output ceiling of ${this.hardOutputCeilingBytes} bytes exceeded (observed ${total} bytes).`;
      this.terminateWithEscalation();
    }
  }

  private handleLifetimeTimeout(): void {
    if (this.closed || this.terminationStarted) return;
    this.pendingTerminalState = "timed_out";
    this.pendingTerminalReason = `Verification lifetime of ${this.lifetimeMs} ms exceeded.`;
    this.terminateWithEscalation();
  }

  public cancel(): Promise<VerificationJobRecord> {
    if (this.state !== "running") {
      return Promise.resolve(this.toRecord());
    }
    if (!this.pendingTerminalState) {
      this.pendingTerminalState = "cancelled";
      this.pendingTerminalReason = "Cancelled by user";
    }
    this.terminateWithEscalation();

    if (this.closed) {
      return Promise.resolve(this.toRecord());
    }

    return new Promise((resolve) => {
      this.waiters.add(() => resolve(this.toRecord()));
    });
  }

  private terminateWithEscalation(): void {
    if (this.terminationStarted || this.closed) return;
    this.terminationStarted = true;
    if (!this.child) return;

    terminateProcessTree(this.child, "SIGTERM");
    this.killEscalationTimer = setTimeout(() => {
      if (!this.closed && this.child) {
        terminateProcessTree(this.child, "SIGKILL");
      }
    }, 1_500);
    this.killEscalationTimer.unref();
  }

  private cleanupTimers(): void {
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
    if (this.killEscalationTimer) {
      clearTimeout(this.killEscalationTimer);
      this.killEscalationTimer = undefined;
    }
  }

  private transitionToTerminal(
    state: VerificationJobState,
    details: { exitCode: number | null; signal: NodeJS.Signals | null; reason?: string }
  ): void {
    if (this.state !== "running") return; // Single-assignment guarantee

    this.state = state;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.terminalReason = details.reason;
    const now = new Date();
    this.finishedAt = now.toISOString();
    this.durationMs = now.getTime() - this.startTimeMs;

    this.cleanupTimers();

    for (const waiter of this.waiters) {
      try {
        waiter();
      } catch {
        // Waiter error should not disrupt other waiters.
      }
    }
    this.waiters.clear();
  }

  public wait(maxWaitMs: number): Promise<VerificationJobRecord> {
    if (this.state !== "running") {
      return Promise.resolve(this.toRecord());
    }

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const onDone = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(onDone);
        resolve(this.toRecord());
      };

      timer = setTimeout(() => {
        this.waiters.delete(onDone);
        resolve(this.toRecord());
      }, maxWaitMs);
      timer.unref();

      this.waiters.add(onDone);
    });
  }

  public toRecord(): VerificationJobRecord {
    const { stdout: rawStdout, stderr: rawStderr } = this.combinedBuffer.getOutputs();
    const redactedStdout = redactDiagnosticText(rawStdout);
    const redactedStderr = redactDiagnosticText(rawStderr);
    const observedTotal = this.observedStdoutBytes + this.observedStderrBytes;
    const truncated = observedTotal > this.retainedTailBytes;

    return {
      jobId: this.jobId,
      state: this.state,
      workspaceId: this.workspaceId,
      workspaceRoot: this.workspaceRoot,
      cwd: this.cwd,
      runner: this.runner,
      packageManager: this.packageManager,
      script: this.script,
      args: [...this.args],
      commandSummary: this.commandSummary,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      ...(this.finishedAt ? { finishedAt: this.finishedAt } : {}),
      ...(this.durationMs !== undefined ? { durationMs: this.durationMs } : {}),
      exitCode: this.exitCode,
      signal: this.signal,
      stdout: redactedStdout,
      stderr: redactedStderr,
      truncated,
      observedStdoutBytes: this.observedStdoutBytes,
      observedStderrBytes: this.observedStderrBytes,
      observedTotalBytes: observedTotal,
      ...(this.terminalReason ? { terminalReason: this.terminalReason } : {}),
      lifetimeMs: this.lifetimeMs,
      ...(this.containmentWrapper ? { containmentWrapper: [...this.containmentWrapper] } : {})
    };
  }

  public get childProcess(): ChildProcess | undefined {
    return this.child;
  }
}

export class VerificationManager {
  private readonly jobs = new Map<string, ManagedVerificationJob>();
  private readonly config: CodexProConfig;
  private readonly limits: VerificationManagerLimits;
  private readonly containmentWrapper?: string[];

  constructor(
    config: CodexProConfig,
    options: Partial<VerificationManagerLimits> & { containmentWrapper?: string[] } = {}
  ) {
    this.config = config;
    this.limits = {
      ...DEFAULT_VERIFICATION_LIMITS,
      ...options
    };
    const envPath = makeRestrictedBashEnv(config).PATH;
    const wrapper = options.containmentWrapper ?? config.containmentWrapper;
    this.containmentWrapper = validateContainmentWrapper(wrapper, envPath);
  }

  public getJob(jobId: string): ManagedVerificationJob | undefined {
    return this.jobs.get(jobId);
  }

  public getActiveJobs(): ManagedVerificationJob[] {
    return [...this.jobs.values()].filter((j) => j.state === "running");
  }

  public getActiveCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "running") count += 1;
    }
    return count;
  }

  public getTotalCount(): number {
    return this.jobs.size;
  }

  public prune(now = Date.now()): void {
    const terminalJobs: ManagedVerificationJob[] = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.state !== "running") {
        const finishedMs = job.finishedAt ? new Date(job.finishedAt).getTime() : 0;
        if (now - finishedMs >= this.limits.terminalRecordTtlMs) {
          this.jobs.delete(id);
        } else {
          terminalJobs.push(job);
        }
      }
    }

    if (terminalJobs.length > this.limits.terminalRecordMax) {
      terminalJobs.sort((a, b) => {
        const tA = a.finishedAt ? new Date(a.finishedAt).getTime() : 0;
        const tB = b.finishedAt ? new Date(b.finishedAt).getTime() : 0;
        return tA - tB;
      });
      const toEvict = terminalJobs.length - this.limits.terminalRecordMax;
      for (let i = 0; i < toEvict; i++) {
        this.jobs.delete(terminalJobs[i].jobId);
      }
    }
  }

  public async startVerification(
    workspace: Workspace,
    guard: PathGuard,
    input: VerificationStartInput
  ): Promise<VerificationJobRecord> {
    if (this.config.bashMode === "off") {
      throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable verification jobs.");
    }
    assertBashSession(this.config, input.session_id);

    this.prune();

    if (this.getActiveCount() >= this.limits.maxActiveJobs) {
      throw new CodexProError(
        `Verification capacity reached (maximum ${this.limits.maxActiveJobs} active jobs). Wait for an active job to complete or cancel one.`,
        "verification_capacity_reached"
      );
    }

    const cwdResolved = guard.resolve(workspace, input.cwd ?? ".");
    const relativeCwd = path.relative(workspace.root, cwdResolved.absPath) || ".";

    const runnerArgv = compileRunnerArgv(input);
    const executionArgv = composeExecutionArgv(runnerArgv, this.containmentWrapper);
    const commandSummary = executionArgv.join(" ");
    const lifetimeMs = clampLifetime(
      input.lifetime_ms,
      this.limits.minLifetimeMs,
      this.limits.maxLifetimeMs,
      this.limits.defaultLifetimeMs
    );

    const jobId = `vjob_${randomBytes(12).toString("hex")}`;
    const job = new ManagedVerificationJob({
      jobId,
      workspace,
      cwd: relativeCwd,
      absCwd: cwdResolved.absPath,
      runner: input.runner,
      packageManager: input.package_manager,
      script: input.script,
      args: validateArgs(input.args),
      executionArgv,
      commandSummary,
      lifetimeMs,
      containmentWrapper: this.containmentWrapper,
      config: this.config,
      hardOutputCeilingBytes: this.limits.hardOutputCeilingBytes,
      retainedTailBytes: this.limits.retainedTailBytes
    });

    this.jobs.set(jobId, job);
    job.start();
    return job.toRecord();
  }

  public async waitVerification(
    jobId: string,
    maxWaitSeconds = 20,
    sessionId?: string
  ): Promise<VerificationJobRecord> {
    this.prune();
    if (this.config.requireBashSession || sessionId !== undefined) {
      assertBashSession(this.config, sessionId);
    }
    const cleanId = String(jobId ?? "").trim();
    const job = this.jobs.get(cleanId);
    if (!job) {
      throw new CodexProError(`Verification job not found or expired: '${cleanId}'.`);
    }

    const clampedWaitSec = Math.max(1, Math.min(maxWaitSeconds, 60));
    return job.wait(clampedWaitSec * 1000);
  }

  public async cancelVerification(jobId: string, sessionId?: string): Promise<VerificationJobRecord> {
    this.prune();
    if (this.config.requireBashSession || sessionId !== undefined) {
      assertBashSession(this.config, sessionId);
    }
    const cleanId = String(jobId ?? "").trim();
    const job = this.jobs.get(cleanId);
    if (!job) {
      throw new CodexProError(`Verification job not found or expired: '${cleanId}'.`);
    }
    return job.cancel();
  }

  public getJobRecord(jobId: string): VerificationJobRecord | undefined {
    this.prune();
    return this.jobs.get(jobId.trim())?.toRecord();
  }

  public async close(): Promise<void> {
    const activeJobs: ManagedVerificationJob[] = [];
    for (const job of this.jobs.values()) {
      if (job.state === "running") {
        activeJobs.push(job);
      }
    }
    await Promise.all(activeJobs.map((j) => j.cancel()));
  }
}
