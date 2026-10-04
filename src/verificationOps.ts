import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import { CodexProError, PathGuard, type Workspace } from "./guard.js";
import { terminateProcessTree, makeRestrictedBashEnv, assertBashSession, SAFE_BLOCKED_PATTERNS } from "./bashOps.js";
import { redactDiagnosticText, createPrivateKeyScanner } from "./redact.js";

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
  generationId: string;
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
  cleanupAttempted?: boolean;
  cleanupPerformed?: number;
  descendantsObserved?: boolean;
  recoveryHint?: string;
}

export interface VerificationJobSummary {
  jobId: string;
  generationId: string;
  state: VerificationJobState;
  workspaceId: string;
  runner: VerificationRunnerFamily;
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  observedStdoutBytes: number;
  observedStderrBytes: number;
  truncated: boolean;
  terminalReason?: string;
}

export type VerificationManagerLifecycleState = "open" | "closing" | "closed";

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
  "start", "dev", "serve", "server", "watch", "watchall", "publish", "deploy",
  "install", "preinstall", "postinstall", "prepublish", "prepare",
  "prepack", "postpack", "listen", "daemon", "preview",
  "fix", "autofix", "mutate", "format", "write", "update", "upgrade"
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
  const tokens = trimmed.toLowerCase().split(/[:_\-\./]+/);
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
    if (
      lower === "--watch" ||
      lower === "-w" ||
      lower === "--watchall" ||
      lower === "--watch-all" ||
      lower.startsWith("--watch=") ||
      lower.startsWith("-w=") ||
      lower.startsWith("--watchall=") ||
      lower.startsWith("--watch-all=")
    ) {
      throw new CodexProError(`Argument '${arg}' is blocked: watch mode is forbidden for verification jobs.`);
    }

    // Block daemon/server flags across all runners
    if (
      lower === "--daemon" ||
      lower === "--serve" ||
      lower === "--server" ||
      lower.startsWith("--daemon=") ||
      lower.startsWith("--serve=") ||
      lower.startsWith("--server=")
    ) {
      throw new CodexProError(`Argument '${arg}' is blocked: daemon/server flags are forbidden for verification jobs.`);
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

export interface LinuxProcessIdentity {
  pid: number;
  startTime: string;
  processGroup: number;
  state: string;
}

const VERIFICATION_CLEANUP_TERM_WAIT_MS = 1000;
const VERIFICATION_CLEANUP_KILL_WAIT_MS = 1000;
const VERIFICATION_CLEANUP_POLL_MS = 50;
// Independent settlement deadline, started on root exit (or when root is
// known-exited). It does NOT depend on `close` firing, so a missed reparented
// child or unkillable pipe holder can never hold the job in `running` forever.
// Duration reuses the TERM+KILL totals plus margin: 1000 + 1000 + 2000 = 4000ms
// (~3-5s per design). This is the single authoritative ref'd watchdog for the
// exit->close gap; escalation timers stay unref'd best-effort and are cleared
// once settlement owns the terminal.
const VERIFICATION_SETTLE_DEADLINE_MS =
  VERIFICATION_CLEANUP_TERM_WAIT_MS + VERIFICATION_CLEANUP_KILL_WAIT_MS + 2000;
const VERIFICATION_SETTLE_SAMPLE_MAX = 5;
const VERIFICATION_RECOVERY_HINT_MAX_CHARS = 500;

function readLinuxProcessIdentity(pid: number): LinuxProcessIdentity | undefined {
  if (process.platform !== "linux") return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm is wrapped in parens and may itself contain spaces or parens;
    // the last ")" ends comm per proc(5), and the remaining fields never contain ")".
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const rest = stat.slice(closeParen + 2).trim();
    if (!rest) return undefined;
    const fields = rest.split(/\s+/u);
    // After "pid (comm)": [state, ppid, pgrp, session, ... starttime at index 19].
    if (fields.length < 20) return undefined;
    const state = fields[0];
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!state) return undefined;
    if (!Number.isSafeInteger(processGroup) || processGroup <= 0) return undefined;
    if (!/^\d+$/u.test(startTime)) return undefined;
    return { pid, processGroup, startTime, state };
  } catch {
    return undefined;
  }
}

/**
 * Allowlisted private job-channel endpoint check (ownership admission gate).
 *
 * Lineage reasoning (documented): `pipe:[inode]` and `socket:[inode]` name a
 * private kernel object. Only processes that inherited the exact open file
 * description (fork/spawn inheritance, or SCM_RIGHTS passing which this job
 * never uses) can hold that inode, so equality with a root-captured job pipe
 * inode is positive lineage evidence. A shared regular-file path
 * (`/tmp/shared.log`) or terminal (`/dev/pts/N`) is rendezvous by name: any
 * unrelated process can open the same path without any fork relationship to
 * the job, so path equality proves nothing about lineage and must never
 * adopt. `anon_inode:*`, `/dev/*`, and every other family are rejected for
 * the same reason. Allowlist, not denylist: unknown families default to
 * reject.
 */
export function isPrivateJobChannelTarget(target: unknown): boolean {
  if (typeof target !== "string" || !target) return false;
  return /^pipe:\[\d+\]$/u.test(target) || /^socket:\[\d+\]$/u.test(target);
}

/**
 * Deterministic injection hooks for the pipe-holder admission path.
 * Production leaves every field unset (real /proc scan). Tests inject bounded
 * snapshots to exercise the REAL `capturePipeHolders` admission function
 * (allowlist + double identity binding) without touching unrelated live PIDs.
 */
export interface PipeHolderScanHooks {
  listPids?: () => string[];
  listFds?: (pid: number) => string[];
  readFdTarget?: (pid: number, fd: string) => string | undefined;
  readIdentity?: (pid: number) => LinuxProcessIdentity | undefined;
}

interface StreamChunk {
  stream: "stdout" | "stderr";
  buf: Buffer;
}

export class StreamingRedactor {
  private readonly decoder = new StringDecoder("utf8");
  private readonly keyScanner = createPrivateKeyScanner();
  private readonly maxPendingLineChars: number;
  private linePending = "";
  private suppressingOverlongLine = false;
  public hasSuppressedContent = false;

  /** Default safety bound for callers without a tighter output-budget owner. */
  public static readonly MAX_PENDING_LINE_CHARS = 4096;
  public static readonly OUTPUT_SUPPRESSION_MARKER = "[OUTPUT_SUPPRESSED: line exceeds configured retention limit]";

  constructor(options: { maxPendingLineChars?: number } = {}) {
    const maxPendingLineChars = options.maxPendingLineChars ?? StreamingRedactor.MAX_PENDING_LINE_CHARS;
    if (!Number.isSafeInteger(maxPendingLineChars) || maxPendingLineChars <= 0) {
      throw new CodexProError("maxPendingLineChars must be a positive safe integer.");
    }
    this.maxPendingLineChars = maxPendingLineChars;
  }

  public push(chunk: Buffer): Buffer[] {
    const text = this.decoder.write(chunk);
    if (!text) return [];
    return this.processText(text, false);
  }

  public flush(): Buffer[] {
    const trailingText = this.decoder.end();
    return this.processText(trailingText, true);
  }

  public peekPending(): string {
    if (this.suppressingOverlongLine || !this.linePending) return "";
    return redactDiagnosticText(this.linePending);
  }

  private processText(text: string, final: boolean): Buffer[] {
    const afterKeys = this.keyScanner.push(text, final);
    let input = afterKeys;
    const outputChunks: Buffer[] = [];

    while (input.length > 0) {
      if (this.suppressingOverlongLine) {
        const nlMatch = this.findFirstNewline(input);
        if (!nlMatch) {
          // Entire input chunk is part of the suppressed overlong line.
          // Discard all characters; keep state bounded (0 chars retained).
          input = "";
          break;
        }
        // Newline encountered: end suppression
        this.suppressingOverlongLine = false;
        outputChunks.push(Buffer.from(nlMatch.separator, "utf8"));
        input = input.slice(nlMatch.index + nlMatch.separator.length);
        continue;
      }

      const nlMatch = this.findFirstNewline(input);
      if (!nlMatch) {
        const combined = this.linePending + input;
        input = "";
        if (combined.length > this.maxPendingLineChars) {
          this.hasSuppressedContent = true;
          this.suppressingOverlongLine = true;
          this.linePending = "";
          outputChunks.push(Buffer.from(StreamingRedactor.OUTPUT_SUPPRESSION_MARKER, "utf8"));
        } else {
          this.linePending = combined;
        }
        break;
      }

      const linePart = input.slice(0, nlMatch.index);
      const fullLineBody = this.linePending + linePart;
      this.linePending = "";
      input = input.slice(nlMatch.index + nlMatch.separator.length);

      if (fullLineBody.length > this.maxPendingLineChars) {
        this.hasSuppressedContent = true;
        outputChunks.push(Buffer.from(StreamingRedactor.OUTPUT_SUPPRESSION_MARKER + nlMatch.separator, "utf8"));
      } else {
        const fullLineWithSep = fullLineBody + nlMatch.separator;
        const redacted = redactDiagnosticText(fullLineWithSep);
        if (redacted) {
          outputChunks.push(Buffer.from(redacted, "utf8"));
        }
      }
    }

    if (final) {
      if (this.suppressingOverlongLine) {
        this.suppressingOverlongLine = false;
        this.linePending = "";
      } else if (this.linePending) {
        if (this.linePending.length > this.maxPendingLineChars) {
          this.hasSuppressedContent = true;
          this.linePending = "";
          outputChunks.push(Buffer.from(StreamingRedactor.OUTPUT_SUPPRESSION_MARKER, "utf8"));
        } else {
          const redacted = redactDiagnosticText(this.linePending);
          this.linePending = "";
          if (redacted) {
            outputChunks.push(Buffer.from(redacted, "utf8"));
          }
        }
      }
    }

    return outputChunks;
  }

  private findFirstNewline(text: string): { index: number; separator: string } | null {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") {
        return { index: i, separator: "\n" };
      }
      if (ch === "\r") {
        if (i + 1 < text.length && text[i + 1] === "\n") {
          return { index: i, separator: "\r\n" };
        }
        return { index: i, separator: "\r" };
      }
    }
    return null;
  }
}

export class CombinedRollingTailBuffer {
  private chunks: StreamChunk[] = [];
  private retainedBytes = 0;
  public hasDroppedBytes = false;

  constructor(public readonly maxBytes: number) {}

  append(stream: "stdout" | "stderr", buf: Buffer): void {
    if (buf.byteLength === 0) return;
    this.chunks.push({ stream, buf });
    this.retainedBytes += buf.byteLength;
    while (this.chunks.length > 0 && this.retainedBytes > this.maxBytes) {
      this.hasDroppedBytes = true;
      let excess = this.retainedBytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.buf.byteLength <= excess) {
        this.retainedBytes -= first.buf.byteLength;
        this.chunks.shift();
      } else {
        while (excess < first.buf.byteLength && (first.buf[excess] & 0xc0) === 0x80) {
          excess++;
        }
        if (excess >= first.buf.byteLength) {
          this.retainedBytes -= first.buf.byteLength;
          this.chunks.shift();
        } else {
          first.buf = first.buf.subarray(excess);
          this.retainedBytes -= excess;
          break;
        }
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

export function trimUtf8Tail(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.byteLength <= maxBytes) return str;
  let start = buf.byteLength - maxBytes;
  // If the byte at `start` is a UTF-8 continuation byte (10xxxxxx),
  // advance forward until we reach a valid UTF-8 lead byte or ASCII byte.
  // This drops the partial/split codepoint cleanly without inserting replacement characters.
  while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  if (start >= buf.byteLength) return "";
  return buf.subarray(start).toString("utf8");
}

export class ManagedVerificationJob {
  public readonly jobId: string;
  public readonly generationId: string;
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
  private descendantMonitorTimer?: NodeJS.Timeout;
  private settleDeadlineTimer?: NodeJS.Timeout;
  private rootProcessStartTime?: string;
  private readonly ownedDescendants = new Map<number, string>();
  private closed = false;
  private rootCloseSettling = false;
  private rootExited = false;
  private terminationStarted = false;
  private pendingTerminalState?: VerificationJobState;
  private pendingTerminalReason?: string;
  private startTimeMs: number;
  // Cleanup history, independent of the final live-set emptiness. Set by
  // signalOwnedProcessTree (exit-handler AND settleRootClose paths) whenever at
  // least one identity-gated owned descendant is signalled, even if that PID is
  // already dead by the later prune. Final status must reflect this
  // intervention: normal-completion-with-intervention is a cleanup-aware
  // `failed`, never ordinary `succeeded`. `cleanup_incomplete` stays reserved
  // for the unreaped case.
  private cleanupAttempted = false;
  private cleanupPerformedCount = 0;
  // Discovery observability. Set the first time any capture pass observes a
  // descendant. If no pass ever observed one (monitor missed window), the
  // record carries descendantsObserved:false. Contract choice (documented):
  // ordinary fast close with no descendant ever captured keeps ordinary success
  // (preserves the quick-job contract: no child, no intervention, pipes
  // released promptly; group kill was still attempted on exit). Only a delayed
  // close (pipes held) with nothing captured is dishonest as success, and that
  // case is owned by the independent settle deadline, which reports
  // cleanup_incomplete with an `unobserved` note instead of claiming all
  // children gone.
  private descendantsEverObserved = false;
  private descendantCapturePasses = 0;
  private exitCodeAtExit: number | null = null;
  private exitSignalAtExit: NodeJS.Signals | null = null;
  private recoveryHintText?: string;
  private lastKnownLiveSample: number[] = [];
  /** Test-only deterministic cleanup-failure injection (fake PIDs, never
   * signalled to real processes). When set, settlement treats these as the
   * still-live owned set after the bounded drain, proving the
   * `cleanup_incomplete` path without real unkillable D-state or stress. */
  public testHookForceLive: number[] | null = null;
  /**
   * Test-only deterministic pipe-scan injection. When set, `capturePipeHolders`
   * uses these snapshots instead of the live /proc walk, exercising the REAL
   * admission function (allowlist + double identity binding). Identity reads
   * via `readIdentity` are also honoured by the per-PID signal/prune gates so
   * stubbed holders gate exactly like real ones. Production leaves this null.
   */
  public testHookPipeScan: PipeHolderScanHooks | null = null;
  /**
   * Test-only kill stub. When true, per-PID signals are RECORDED in
   * `testHookKillAttempts` instead of signalling real PIDs, so unrelated-PID
   * admission tests prove NOT-signalled without touching live processes.
   */
  public testHookStubKill = false;
  public testHookKillAttempts: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  /**
   * Test-only signal suppression. When true, `signalOwnedProcessTree` records
   * intent but delivers NO signal (group or per-PID), keeping pipe holders
   * alive so the independent settle watchdog (close pending) can be proven
   * deterministically. Cleared by the test before real reaping; never set in
   * production.
   */
  public testHookSuppressSignals = false;
  // Private pipe inodes of this job's stdio (write ends inherited by every
  // pipe-holding descendant). Captured from /proc/<rootPid>/fd/1+2 while the
  // root is alive. A process holding one of these inodes inherited it from our
  // tree, so pipe-holder discovery is ownership proof (not a broad sweep):
  // tree-walk discovery misses fast-detach holders that reparent to init
  // before any capture pass runs, but the pipe scan still finds them.
  private readonly jobPipeInodes = new Set<string>();

  private observedStdoutBytes = 0;
  private observedStderrBytes = 0;
  private readonly stdoutRedactor: StreamingRedactor;
  private readonly stderrRedactor: StreamingRedactor;
  private combinedBuffer: CombinedRollingTailBuffer;

  private readonly waiters = new Set<() => void>();

  constructor(options: {
    jobId: string;
    generationId: string;
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
    this.generationId = options.generationId;
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
    this.stdoutRedactor = new StreamingRedactor({ maxPendingLineChars: this.retainedTailBytes });
    this.stderrRedactor = new StreamingRedactor({ maxPendingLineChars: this.retainedTailBytes });

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

    if (process.platform === "linux") {
      this.captureOwnedDescendants();
      this.captureJobPipeInodes();
      this.descendantMonitorTimer = setInterval(() => this.captureOwnedDescendants(), 50);
      this.descendantMonitorTimer.unref();
      this.child.once("spawn", () => {
        this.captureOwnedDescendants();
        this.captureJobPipeInodes();
      });
    }

    this.lifetimeTimer = setTimeout(() => {
      this.handleLifetimeTimeout();
    }, this.lifetimeMs);
    this.lifetimeTimer.unref();

    this.child.stdout?.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.observedStdoutBytes += buf.byteLength;
      const rChunks = this.stdoutRedactor.push(buf);
      for (const rc of rChunks) {
        this.combinedBuffer.append("stdout", rc);
      }
      this.checkOutputCeiling();
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.observedStderrBytes += buf.byteLength;
      const rChunks = this.stderrRedactor.push(buf);
      for (const rc of rChunks) {
        this.combinedBuffer.append("stderr", rc);
      }
      this.checkOutputCeiling();
    });

    this.child.on("error", (err: Error) => {
      const errBuf = Buffer.from(`\n[codexpro] Spawn error: ${err.message}`);
      this.observedStderrBytes += errBuf.byteLength;
      const rChunks = this.stderrRedactor.push(errBuf);
      for (const rc of rChunks) {
        this.combinedBuffer.append("stderr", rc);
      }
      this.flushRedactors();
      this.transitionToTerminal("failed", {
        exitCode: 1,
        signal: null,
        reason: `Process spawn error: ${err.message}`
      });
    });

    // 'exit' fires when the root process exits, independent of stdio pipe
    // lifetime. A detached descendant that inherits job pipes holds 'close'
    // back until its pipes release, so signal owned survivors here (best
    // effort) to unblock 'close' boundedly. Terminal settlement stays owned
    // by the 'close' handler below, with the independent settle deadline
    // (startSettleDeadline) as the truthful fallback when `close` never fires.
    this.child.on("exit", (code, sig) => {
      this.rootExited = true;
      this.exitCodeAtExit = code;
      this.exitSignalAtExit = sig;
      try {
        this.signalOwnedProcessTree("SIGTERM");
      } catch {
        // Best effort only; close handler owns bounded escalation.
      }
      if (!this.killEscalationTimer && !this.closed) {
        this.killEscalationTimer = setTimeout(() => {
          if (!this.closed) {
            try {
              this.signalOwnedProcessTree("SIGKILL");
            } catch {
              // Best effort only.
            }
          }
        }, 1000);
        this.killEscalationTimer.unref();
      }
      // Bound terminal settlement independently of pipe closure: a missed
      // reparented child or unkillable pipe holder can prevent `close`
      // forever, so start the single ref'd settlement watchdog here.
      this.startSettleDeadline();
    });

    this.child.on("close", (code, sig) => {
      if (this.rootCloseSettling) return;
      this.rootCloseSettling = true;
      this.closed = true;
      // Freeze periodic discovery and lifetime, but preserve ownership +
      // escalation for settleRootClose. The old kill-escalation timer (root
      // focused) is superseded by the bounded owned-settlement below. The
      // independent settle deadline is also superseded now that `close`
      // fired: clear it so only one settlement path owns the terminal.
      if (this.settleDeadlineTimer) {
        clearTimeout(this.settleDeadlineTimer);
        this.settleDeadlineTimer = undefined;
      }
      if (this.lifetimeTimer) {
        clearTimeout(this.lifetimeTimer);
        this.lifetimeTimer = undefined;
      }
      if (this.descendantMonitorTimer) {
        clearInterval(this.descendantMonitorTimer);
        this.descendantMonitorTimer = undefined;
      }
      if (this.killEscalationTimer) {
        clearTimeout(this.killEscalationTimer);
        this.killEscalationTimer = undefined;
      }
      this.flushRedactors();

      void this.settleRootClose(code, sig).catch(() => {
        if (this.state === "running") {
          this.transitionToTerminal(this.pendingTerminalState ?? "failed", {
            exitCode: code,
            signal: sig,
            reason: this.pendingTerminalReason ?? "Root close cleanup failed unexpectedly."
          });
        }
      });
    });
  }

  private flushRedactors(): void {
    const outChunks = this.stdoutRedactor.flush();
    for (const c of outChunks) {
      this.combinedBuffer.append("stdout", c);
    }
    const errChunks = this.stderrRedactor.flush();
    for (const c of errChunks) {
      this.combinedBuffer.append("stderr", c);
    }
  }

  private checkOutputCeiling(): void {
    const total = this.observedStdoutBytes + this.observedStderrBytes;
    if (this.closed) return;
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
    // A cancel arriving after root close (settlement pending) must not
    // rewrite the already-determined terminal; it only awaits settlement.
    if (!this.pendingTerminalState && !this.closed && !this.rootCloseSettling) {
      this.pendingTerminalState = "cancelled";
      this.pendingTerminalReason = "Cancelled by user";
    }
    this.terminateWithEscalation();

    if (this.state !== "running") {
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

    this.signalOwnedProcessTree("SIGTERM");
    this.killEscalationTimer = setTimeout(() => {
      if (!this.closed && this.child) {
        this.signalOwnedProcessTree("SIGKILL");
      }
    }, 1_500);
    this.killEscalationTimer.unref();
  }

  private isRootIdentityCurrent(): boolean {
    const rootPid = this.child?.pid;
    if (!rootPid) return false;
    if (process.platform !== "linux") return true;
    const root = readLinuxProcessIdentity(rootPid);
    if (!root) return false;
    if (this.rootProcessStartTime === undefined) {
      this.rootProcessStartTime = root.startTime;
      return true;
    }
    return root.startTime === this.rootProcessStartTime;
  }

  private readOwnedIdentity(pid: number): LinuxProcessIdentity | undefined {
    const hook = this.testHookPipeScan?.readIdentity;
    if (hook) {
      try {
        return hook(pid);
      } catch {
        return undefined;
      }
    }
    return readLinuxProcessIdentity(pid);
  }

  /** Test-only: invoke the real pipe-holder admission scan deterministically. */
  public testOnlyCapturePipeHolders(): void {
    this.capturePipeHolders();
  }

  /** Test-only: invoke the identity-gated signal path (honours stub/suppress hooks). */
  public testOnlySignalOwnedTree(signal: NodeJS.Signals): void {
    this.signalOwnedProcessTree(signal);
  }

  /** Test-only: replace the stored job pipe inodes with an exact controlled set. */
  public testOnlySetPipeInodes(inodes: string[]): void {
    this.jobPipeInodes.clear();
    for (const inode of inodes) this.jobPipeInodes.add(inode);
  }

  public testOnlyGetPipeInodes(): string[] {
    return [...this.jobPipeInodes];
  }

  public testOnlyOwnedEntries(): Array<[number, string]> {
    return [...this.ownedDescendants];
  }

  public testOnlyClearOwned(): void {
    this.ownedDescendants.clear();
  }

  private captureJobPipeInodes(): void {
    if (process.platform !== "linux") return;
    const rootPid = this.child?.pid;
    if (!rootPid) return;
    // Only capture from the live OWNED root: after root exit + PID reuse,
    // fd 1/2 would belong to an unrelated replacement, so refuse to learn new
    // inodes once the root identity is no longer current.
    if (!this.isRootIdentityCurrent()) return;
    for (const fd of ["1", "2"]) {
      try {
        const target = fs.readlinkSync(`/proc/${rootPid}/fd/${fd}`);
        // Allowlist only: retain verified original job pipe/socket endpoints.
        // Node child stdio is normally socketpair sockets (socket:[inode]);
        // plain pipes appear as pipe:[inode]. Both name a private kernel
        // object whose inode equality proves inheritance lineage (only
        // inheritors share it). Regular files (/path/file), terminals
        // (/dev/pts/N), /dev/null, anon_inode, and every other family are
        // rendezvous-by-name or non-inheritable and prove nothing, so reject.
        if (isPrivateJobChannelTarget(target)) {
          this.jobPipeInodes.add(target);
        }
      } catch {
        // Root already gone or fd closed; stored inodes (if any) still apply.
      }
    }
  }

  private capturePipeHolders(): void {
    if (process.platform !== "linux") return;
    if (this.jobPipeInodes.size === 0) return;
    let procEntries: string[];
    try {
      const hookList = this.testHookPipeScan?.listPids;
      procEntries = hookList ? hookList() : fs.readdirSync("/proc");
    } catch {
      return;
    }
    const selfPid = process.pid;
    const hookListFds = this.testHookPipeScan?.listFds;
    const hookReadTarget = this.testHookPipeScan?.readFdTarget;
    for (const entry of procEntries) {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === selfPid) continue;
      // Bind inspection to identity checked BEFORE the descriptor scan.
      const before = this.readOwnedIdentity(pid);
      if (!before) continue;
      const knownBefore = this.ownedDescendants.get(pid);
      if (knownBefore !== undefined && knownBefore !== before.startTime) {
        // Stale baseline vs replacement occupant: never overwrite the baseline
        // with the replacement's identity (that would launder an unrelated
        // process into the owned set). Prune stale and reject this pass; a
        // genuinely-owned replacement can only be adopted once no stale
        // baseline remains, via a fresh stable double-read below.
        this.ownedDescendants.delete(pid);
        continue;
      }
      let fdNames: string[];
      try {
        fdNames = hookListFds ? hookListFds(pid) : fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      // Bounded: a pipe holder is proven by a single matching fd.
      const capped = fdNames.slice(0, 128);
      let holds = false;
      for (const fd of capped) {
        let target: string | undefined;
        try {
          target = hookReadTarget
            ? hookReadTarget(pid, fd)
            : fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        if (target === undefined) continue;
        // Double-gate: the match must be an allowlisted private channel AND
        // one of this job's stored inodes. jobPipeInodes is already
        // allowlisted at capture, but re-check here so a poisoned or legacy
        // non-private entry can never adopt (defence in depth).
        if (!isPrivateJobChannelTarget(target)) continue;
        if (this.jobPipeInodes.has(target)) {
          holds = true;
          break;
        }
      }
      if (!holds) continue;
      // Re-read identity AFTER the scan; adopt ONLY if both reads succeed and
      // agree. A vanished process (undefined) or a PID reused mid-scan
      // (starttime changed) is rejected. Unadopted holders stay unowned and
      // are left for `cleanup_incomplete` with recovery evidence, never killed.
      const after = this.readOwnedIdentity(pid);
      if (!after) continue;
      if (after.startTime !== before.startTime) continue;
      const knownAfter = this.ownedDescendants.get(pid);
      if (knownAfter !== undefined) {
        if (knownAfter !== after.startTime) {
          // Baseline changed mid-scan: prune stale, never refresh.
          this.ownedDescendants.delete(pid);
          continue;
        }
        // Already owned + stable: preserve the existing baseline (no
        // overwrite), mark observed. Per-PID signalling later revalidates
        // identity immediately before any kill.
        this.descendantsEverObserved = true;
        continue;
      }
      // Unknown PID with stable identity + allowlisted match: adopt with its
      // exact identity for PID+starttime-gated kills.
      this.ownedDescendants.set(pid, after.startTime);
      this.descendantsEverObserved = true;
    }
  }

  private captureOwnedDescendants(): void {
    const rootPid = this.child?.pid;
    if (process.platform !== "linux" || !rootPid) return;

    const root = readLinuxProcessIdentity(rootPid);
    if (!root) return;
    if (this.rootProcessStartTime === undefined) {
      this.rootProcessStartTime = root.startTime;
    }
    if (root.startTime !== this.rootProcessStartTime) return;

    this.descendantCapturePasses += 1;
    // Refresh while the root is provably alive (cheap: two readlinks).
    this.captureJobPipeInodes();
    const pending = [rootPid];
    const visited = new Set<number>(pending);
    while (pending.length > 0) {
      const parentPid = pending.pop()!;
      let childText = "";
      try {
        childText = fs.readFileSync("/proc/" + parentPid + "/task/" + parentPid + "/children", "utf8");
      } catch {
        continue;
      }
      const trimmed = childText.trim();
      if (!trimmed) continue;
      for (const token of trimmed.split(/\s+/u)) {
        if (!token) continue;
        const pid = Number(token);
        if (!Number.isSafeInteger(pid) || pid <= 0 || visited.has(pid)) continue;
        visited.add(pid);
        const identity = this.readOwnedIdentity(pid);
        if (!identity) continue;
        this.ownedDescendants.set(pid, identity.startTime);
        pending.push(pid);
      }
    }
    if (this.ownedDescendants.size > 0) {
      this.descendantsEverObserved = true;
    }
  }

  private signalOwnedProcessTree(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    this.captureOwnedDescendants();
    // Pipe-holder fallback: tree-walk misses holders that detached+reparented
    // before any capture pass (narrow with fast-exiting roots). Only
    // allowlisted private-channel holders with stable double-read identity are
    // adopted; anything else is left for `cleanup_incomplete`, never killed.
    try {
      this.capturePipeHolders();
    } catch {
      // Best effort; identity-gated kills below decide.
    }
    const suppress = this.testHookSuppressSignals === true;
    // Only use the process-group kill while the root PID still identifies the
    // exact owned root (PID + starttime). After root exit + PID reuse, kill(-pid)
    // could signal an unrelated group, so skip it and rely on per-PID kills below.
    const rootCurrent = this.isRootIdentityCurrent();
    if (!suppress && (rootCurrent || process.platform !== "linux")) {
      terminateProcessTree(child, signal);
    }

    if (process.platform !== "linux") return;
    // Signal every still-owned descendant individually, regardless of pgid.
    // Group kill already covers pgid == root members when it succeeds, but a
    // failed/racing group kill must not leave same-group orphans, and detached
    // escapees (new pgid/session holding pipes open) are only reachable here.
    // Each kill is gated on exact PID + starttime identity revalidated
    // immediately before signalling; stale entries are pruned, never signalled.
    let signalled = 0;
    for (const [pid, startTime] of [...this.ownedDescendants]) {
      const current = this.readOwnedIdentity(pid);
      if (!current || current.startTime !== startTime) {
        this.ownedDescendants.delete(pid);
        continue;
      }
      if (suppress) {
        // Deterministic watchdog proof: record gated eligibility without
        // delivering, so the holder survives and `close` stays pending.
        this.testHookKillAttempts.push({ pid, signal });
        continue;
      }
      try {
        if (this.testHookStubKill) {
          // Deterministic admission proof: record instead of signalling real
          // PIDs, counting gated eligibility without touching live processes.
          this.testHookKillAttempts.push({ pid, signal });
          signalled += 1;
        } else {
          process.kill(pid, signal);
          signalled += 1;
        }
      } catch {
        // The exact descendant may have exited between identity check and signal.
      }
    }
    // Record intervention independently of the later live set: even if every
    // signalled PID is dead by prune time, the job did intervene and must not
    // report ordinary success.
    if (signalled > 0) {
      this.cleanupAttempted = true;
      this.cleanupPerformedCount += signalled;
      this.descendantsEverObserved = true;
    }
  }

  private pruneOwnedDescendants(): number[] {
    if (process.platform !== "linux") {
      this.ownedDescendants.clear();
      return [];
    }
    const hookIdentity = this.testHookPipeScan?.readIdentity;
    const live: number[] = [];
    for (const [pid, startTime] of [...this.ownedDescendants]) {
      const current = this.readOwnedIdentity(pid);
      if (!current || current.startTime !== startTime) {
        this.ownedDescendants.delete(pid);
        continue;
      }
      if (current.state === "Z" || current.state === "X" || current.state === "x") {
        this.ownedDescendants.delete(pid);
        continue;
      }
      if (hookIdentity) {
        // Deterministic injected-identity mode: trust the hook's stable
        // identity + state (fake PIDs have no kernel entry for kill probing).
        live.push(pid);
        continue;
      }
      try {
        process.kill(pid, 0);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ESRCH") {
          this.ownedDescendants.delete(pid);
          continue;
        }
      }
      live.push(pid);
    }
    return live;
  }

  private waitForOwnedDrain(timeoutMs: number): Promise<number[]> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const poll = (): Promise<number[]> => {
      const remaining = this.pruneOwnedDescendants();
      if (remaining.length === 0 || Date.now() >= deadline) {
        return Promise.resolve(remaining);
      }
      return new Promise<number[]>((resolve) => {
        const timer = setTimeout(() => {
          resolve(poll());
        }, VERIFICATION_CLEANUP_POLL_MS);
        // Keep the poll ref'd so bounded cleanup cannot evaporate before
        // settlement while the root pipes are already closed.
        void timer;
      });
    };
    return poll();
  }

  private startSettleDeadline(): void {
    if (this.settleDeadlineTimer || this.closed || this.rootCloseSettling) return;
    if (this.state !== "running") return;
    // Single ref'd watchdog: deliberately NOT unref'd so bounded settlement
    // cannot evaporate while root pipes are held open. Cleared on `close`
    // (settleRootClose supersedes) and on any terminal transition.
    this.settleDeadlineTimer = setTimeout(() => {
      this.handleSettleDeadline();
    }, VERIFICATION_SETTLE_DEADLINE_MS);
  }

  private buildRecoveryHint(live: number[], context: string): string {
    const sample = live.slice(0, VERIFICATION_SETTLE_SAMPLE_MAX).join(",");
    const hint =
      `recovery(${context}): live ${live.length}` +
      (sample ? ` [${sample}]` : "") +
      `; performed ${this.cleanupPerformedCount}` +
      `; attempted ${this.cleanupAttempted ? "SIGTERM/SIGKILL" : "none"}` +
      `; observed ${this.descendantsEverObserved ? "true" : "false"}` +
      `; root exit code ${this.exitCodeAtExit}`;
    return hint.slice(0, VERIFICATION_RECOVERY_HINT_MAX_CHARS);
  }

  private handleSettleDeadline(): void {
    this.settleDeadlineTimer = undefined;
    // `close` already settled (or job already terminal): deadline is superseded.
    // Single terminal assignment is enforced by transitionToTerminal's guard.
    if (this.state !== "running" || this.closed || this.rootCloseSettling) return;
    let live: number[] = [];
    try {
      this.captureOwnedDescendants();
      this.capturePipeHolders();
    } catch {
      // Best effort; prune below decides.
    }
    if (this.testHookForceLive && this.testHookForceLive.length > 0) {
      // Deterministic failure injection: fake PIDs only, never signalled.
      live = [...this.testHookForceLive].slice(0, 32);
      this.lastKnownLiveSample = [...live];
    } else {
      live = this.pruneOwnedDescendants();
      this.lastKnownLiveSample = [...live];
    }
    const code = this.exitCodeAtExit;
    const sig = this.exitSignalAtExit;
    const intendedState = this.pendingTerminalState;
    const intendedReason = this.pendingTerminalReason;
    if (live.length > 0) {
      const sample = live.slice(0, VERIFICATION_SETTLE_SAMPLE_MAX).join(",");
      // Snapshot ownership BEFORE transitionToTerminal clears the map: the
      // string hint is the persisted recovery record (bounded, single write).
      this.recoveryHintText = this.buildRecoveryHint(live, "settle-deadline");
      const suffix =
        `cleanup_incomplete: ${live.length} owned descendant(s) [${sample}] still alive at independent settle ` +
        `deadline (${VERIFICATION_SETTLE_DEADLINE_MS}ms after root exit) without 'close'; attempted SIGTERM/SIGKILL. ` +
        `${this.recoveryHintText}.`;
      if (intendedState) {
        const base = intendedReason ? `${intendedReason} ` : "";
        this.transitionToTerminal(intendedState, {
          exitCode: code,
          signal: sig,
          reason: `${base}${suffix}`.trim()
        });
        return;
      }
      this.transitionToTerminal("failed", {
        exitCode: code,
        signal: sig,
        reason: `${suffix} Original exit code ${code}.`
      });
      return;
    }
    if (this.cleanupPerformedCount > 0) {
      const count = this.cleanupPerformedCount;
      const suffix =
        `Cleanup performed: ${count} owned descendant(s) required termination after root exit (code ${code}); ` +
        `'close' still pending at settle deadline (${VERIFICATION_SETTLE_DEADLINE_MS}ms). ` +
        `Not reporting clean success while intervention occurred.`;
      if (intendedState) {
        const base = intendedReason ? `${intendedReason} ` : "";
        this.transitionToTerminal(intendedState, {
          exitCode: code,
          signal: sig,
          reason: `${base}[Cleanup: ${count} owned descendant(s) terminated after root exit; close pending at deadline.]`.trim()
        });
        return;
      }
      this.transitionToTerminal("failed", {
        exitCode: code,
        signal: sig,
        reason: suffix
      });
      return;
    }
    // Nothing reaped and nothing signalled, yet `close` never fired: pipes are
    // held by something discovery never captured (missed window / reparented
    // before capture). Claiming clean success would be dishonest, so report
    // cleanup_incomplete with an explicit unobserved note.
    this.recoveryHintText = this.buildRecoveryHint(live, "settle-deadline-unobserved");
    const observedFlag = this.descendantsEverObserved ? "true" : "false";
    const suffix =
      `cleanup_incomplete: 'close' pending at settle deadline (${VERIFICATION_SETTLE_DEADLINE_MS}ms after root exit) ` +
      `with no live owned descendant at deadline (descendantsObserved:${observedFlag}, capture passes ${this.descendantCapturePasses}); ` +
      `pipes held by an uncaptured holder; attempted SIGTERM/SIGKILL group kill. ${this.recoveryHintText}.`;
    if (intendedState) {
      const base = intendedReason ? `${intendedReason} ` : "";
      this.transitionToTerminal(intendedState, {
        exitCode: code,
        signal: sig,
        reason: `${base}${suffix}`.trim()
      });
      return;
    }
    this.transitionToTerminal("failed", {
      exitCode: code,
      signal: sig,
      reason: `${suffix} Original exit code ${code}.`
    });
  }

  private async settleRootClose(code: number | null, sig: NodeJS.Signals | null): Promise<void> {
    let intendedState: VerificationJobState = "succeeded";
    let intendedReason: string | undefined;
    if (this.pendingTerminalState) {
      intendedState = this.pendingTerminalState;
      intendedReason = this.pendingTerminalReason;
    } else if (code !== 0 || sig !== null) {
      intendedState = "failed";
      intendedReason = sig ? `Terminated with signal ${sig}` : `Exited with code ${code}`;
    }

    if (process.platform === "linux") {
      try {
        this.captureOwnedDescendants();
        this.capturePipeHolders();
      } catch {
        // Best effort; prune below decides liveness.
      }
      const initialLive = this.pruneOwnedDescendants();
      this.lastKnownLiveSample = [...initialLive];
      if (initialLive.length > 0) {
        const initialCount = initialLive.length;
        const initialSample = initialLive.slice(0, VERIFICATION_SETTLE_SAMPLE_MAX).join(",");
        try {
          this.signalOwnedProcessTree("SIGTERM");
        } catch {
          // Identity-gated best effort; waits below decide.
        }
        let remaining = await this.waitForOwnedDrain(VERIFICATION_CLEANUP_TERM_WAIT_MS);
        let killNeeded = remaining.length > 0;
        if (killNeeded) {
          try {
            this.signalOwnedProcessTree("SIGKILL");
          } catch {
            // Waits below decide.
          }
          remaining = await this.waitForOwnedDrain(VERIFICATION_CLEANUP_KILL_WAIT_MS);
        }
        if (this.testHookForceLive && this.testHookForceLive.length > 0) {
          remaining = [...this.testHookForceLive].slice(0, 32);
          killNeeded = true;
        }
        this.lastKnownLiveSample = [...remaining];
        if (remaining.length === 0) {
          if (intendedState === "succeeded") {
            this.transitionToTerminal("failed", {
              exitCode: code,
              signal: sig,
              reason:
                `Cleanup performed: ${initialCount} owned descendant(s) [${initialSample}] required termination ` +
                `via ${killNeeded ? "SIGTERM/SIGKILL" : "SIGTERM"} after root exit (code ${code}). ` +
                `Not reporting clean success while an owned child was alive.`
            });
            return;
          }
          const base = intendedReason ? `${intendedReason} ` : "";
          this.transitionToTerminal(intendedState, {
            exitCode: code,
            signal: sig,
            reason:
              `${base}[Cleanup: ${initialCount} owned descendant(s) terminated via ` +
              `${killNeeded ? "SIGTERM/SIGKILL" : "SIGTERM"} after root exit.]`.trim()
          });
          return;
        }
        const sample = remaining.slice(0, VERIFICATION_SETTLE_SAMPLE_MAX).join(",");
        // Snapshot ownership BEFORE transitionToTerminal clears the map.
        this.recoveryHintText = this.buildRecoveryHint(remaining, "root-close");
        const cleanupSuffix =
          `cleanup_incomplete: ${remaining.length} owned descendant(s) [${sample}] still alive after bounded ` +
          `SIGTERM (${VERIFICATION_CLEANUP_TERM_WAIT_MS}ms) + SIGKILL (${VERIFICATION_CLEANUP_KILL_WAIT_MS}ms) ` +
          `escalation (initial ${initialCount}). ${this.recoveryHintText}.`;
        if (intendedState === "succeeded") {
          this.transitionToTerminal("failed", {
            exitCode: code,
            signal: sig,
            reason: `${cleanupSuffix} Original exit code ${code}.`
          });
          return;
        }
        const base = intendedReason ? `${intendedReason} ` : "";
        this.transitionToTerminal(intendedState, {
          exitCode: code,
          signal: sig,
          reason: `${base}${cleanupSuffix}`.trim()
        });
        return;
      }
      // Live set is empty at `close`, but intervention history is independent
      // of it: if the exit handler (or an earlier settle signal) already
      // terminated an owned descendant, the job intervened and must not report
      // ordinary success.
      if (this.testHookForceLive && this.testHookForceLive.length > 0) {
        const forced = [...this.testHookForceLive].slice(0, 32);
        this.lastKnownLiveSample = [...forced];
        this.recoveryHintText = this.buildRecoveryHint(forced, "root-close-forced");
        const sample = forced.slice(0, VERIFICATION_SETTLE_SAMPLE_MAX).join(",");
        const cleanupSuffix =
          `cleanup_incomplete: ${forced.length} owned descendant(s) [${sample}] still alive after bounded ` +
          `SIGTERM (${VERIFICATION_CLEANUP_TERM_WAIT_MS}ms) + SIGKILL (${VERIFICATION_CLEANUP_KILL_WAIT_MS}ms) ` +
          `escalation (test-forced). ${this.recoveryHintText}.`;
        if (intendedState === "succeeded") {
          this.transitionToTerminal("failed", {
            exitCode: code,
            signal: sig,
            reason: `${cleanupSuffix} Original exit code ${code}.`
          });
          return;
        }
        const base = intendedReason ? `${intendedReason} ` : "";
        this.transitionToTerminal(intendedState, {
          exitCode: code,
          signal: sig,
          reason: `${base}${cleanupSuffix}`.trim()
        });
        return;
      }
      if (this.cleanupPerformedCount > 0) {
        const count = this.cleanupPerformedCount;
        if (intendedState === "succeeded") {
          this.transitionToTerminal("failed", {
            exitCode: code,
            signal: sig,
            reason:
              `Cleanup performed: ${count} owned descendant(s) required termination ` +
              `after root exit (code ${code}); live set already reaped by exit-handler signalling. ` +
              `Not reporting clean success while an owned child was alive.`
          });
          return;
        }
        if (intendedState !== undefined) {
          const base = intendedReason ? `${intendedReason} ` : "";
          this.transitionToTerminal(intendedState, {
            exitCode: code,
            signal: sig,
            reason:
              `${base}[Cleanup: ${count} owned descendant(s) terminated after root exit.]`.trim()
          });
          return;
        }
      }
    }

    this.transitionToTerminal(intendedState, {
      exitCode: code,
      signal: sig,
      reason: intendedReason
    });
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
    if (this.descendantMonitorTimer) {
      clearInterval(this.descendantMonitorTimer);
      this.descendantMonitorTimer = undefined;
    }
    if (this.settleDeadlineTimer) {
      clearTimeout(this.settleDeadlineTimer);
      this.settleDeadlineTimer = undefined;
    }
    // Owned-descendant map is cleared only here, AFTER the terminal reason +
    // recoveryHint string have been snapshotted above. The string hint (bounded)
    // is the persisted recovery record exposed via toRecord(); the raw map is
    // teardown, not evidence. lastKnownLiveSample + recoveryHintText survive.
    this.ownedDescendants.clear();
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
    const { stdout: committedStdout, stderr: committedStderr } = this.combinedBuffer.getOutputs();
    const pendingOut = this.state === "running" ? this.stdoutRedactor.peekPending() : "";
    const pendingErr = this.state === "running" ? this.stderrRedactor.peekPending() : "";

    const rawStdout = committedStdout + pendingOut;
    const rawStderr = committedStderr + pendingErr;

    const redactedStdout = redactDiagnosticText(rawStdout);
    const redactedStderr = redactDiagnosticText(rawStderr);
    const observedTotal = this.observedStdoutBytes + this.observedStderrBytes;
    const rawTruncated = observedTotal > this.retainedTailBytes;

    const budget = this.retainedTailBytes;
    const outBytes = Buffer.byteLength(redactedStdout, "utf8");
    const errBytes = Buffer.byteLength(redactedStderr, "utf8");

    let finalStdout = redactedStdout;
    let finalStderr = redactedStderr;
    let postRedactionTruncated = false;

    if (outBytes + errBytes > budget) {
      postRedactionTruncated = true;
      const halfBudget = Math.floor(budget / 2);
      let targetOutBytes: number;
      let targetErrBytes: number;

      if (outBytes <= halfBudget) {
        targetOutBytes = outBytes;
        targetErrBytes = budget - targetOutBytes;
      } else if (errBytes <= halfBudget) {
        targetErrBytes = errBytes;
        targetOutBytes = budget - targetErrBytes;
      } else {
        targetOutBytes = halfBudget;
        targetErrBytes = budget - targetOutBytes;
      }

      finalStdout = trimUtf8Tail(redactedStdout, targetOutBytes);
      const remainingForErr = budget - Buffer.byteLength(finalStdout, "utf8");
      finalStderr = trimUtf8Tail(redactedStderr, remainingForErr);
    }

    const truncated =
      rawTruncated ||
      this.combinedBuffer.hasDroppedBytes ||
      postRedactionTruncated ||
      this.stdoutRedactor.hasSuppressedContent ||
      this.stderrRedactor.hasSuppressedContent;

    return {
      jobId: this.jobId,
      generationId: this.generationId,
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
      stdout: finalStdout,
      stderr: finalStderr,
      truncated,
      observedStdoutBytes: this.observedStdoutBytes,
      observedStderrBytes: this.observedStderrBytes,
      observedTotalBytes: observedTotal,
      ...(this.terminalReason ? { terminalReason: this.terminalReason } : {}),
      lifetimeMs: this.lifetimeMs,
      ...(this.containmentWrapper ? { containmentWrapper: [...this.containmentWrapper] } : {}),
      cleanupAttempted: this.cleanupAttempted,
      cleanupPerformed: this.cleanupPerformedCount,
      descendantsObserved: this.descendantsEverObserved,
      ...(this.recoveryHintText ? { recoveryHint: this.recoveryHintText } : {})
    };
  }

  public get childProcess(): ChildProcess | undefined {
    return this.child;
  }
}

export class VerificationManager {
  public readonly generationId: string;
  private readonly jobs = new Map<string, ManagedVerificationJob>();
  private readonly config: CodexProConfig;
  private readonly limits: VerificationManagerLimits;
  private readonly containmentWrapper?: string[];
  private lifecycleState: VerificationManagerLifecycleState = "open";
  private closePromise: Promise<void> | null = null;

  constructor(
    config: CodexProConfig,
    options: Partial<VerificationManagerLimits> & { containmentWrapper?: string[] } = {}
  ) {
    this.config = config;
    this.generationId = `vgen_${randomBytes(16).toString("hex")}`;
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

  public get state(): VerificationManagerLifecycleState {
    return this.lifecycleState;
  }

  public async startVerification(
    workspace: Workspace,
    guard: PathGuard,
    input: VerificationStartInput
  ): Promise<VerificationJobRecord> {
    if (this.lifecycleState !== "open") {
      throw new CodexProError(
        "Verification manager is closing or closed. Cannot start new verification jobs.",
        "verification_manager_closing"
      );
    }
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
      generationId: this.generationId,
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

  public listJobSummaries(workspaceId: string, sessionId?: string): VerificationJobSummary[] {
    this.prune();
    if (this.config.requireBashSession || sessionId !== undefined) {
      assertBashSession(this.config, sessionId);
    }
    return [...this.jobs.values()]
      .filter((job) => job.workspaceId === workspaceId)
      .map((job) => {
        const record = job.toRecord();
        return {
          jobId: record.jobId,
          generationId: record.generationId,
          state: record.state,
          workspaceId: record.workspaceId,
          runner: record.runner,
          startedAt: record.startedAt,
          ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
          elapsedMs: record.durationMs ?? Math.max(0, Date.now() - Date.parse(record.startedAt)),
          exitCode: record.exitCode,
          signal: record.signal,
          observedStdoutBytes: record.observedStdoutBytes,
          observedStderrBytes: record.observedStderrBytes,
          truncated: record.truncated,
          ...(record.terminalReason ? { terminalReason: record.terminalReason } : {})
        };
      });
  }

  public getJobRecord(jobId: string): VerificationJobRecord | undefined {
    this.prune();
    return this.jobs.get(jobId.trim())?.toRecord();
  }

  public async close(): Promise<void> {
    if (this.lifecycleState === "closed") {
      return;
    }
    if (this.closePromise) {
      return this.closePromise;
    }
    this.lifecycleState = "closing";
    this.closePromise = (async () => {
      try {
        const activeJobs: ManagedVerificationJob[] = [];
        for (const job of this.jobs.values()) {
          if (job.state === "running") {
            activeJobs.push(job);
          }
        }
        await Promise.all(activeJobs.map((j) => j.cancel()));
      } finally {
        this.lifecycleState = "closed";
      }
    })();
    return this.closePromise;
  }
}
