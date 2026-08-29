import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactDiagnosticText, redactSensitiveText, redactUnifiedDiff, sourceLanguageForPath, type SourceLanguage } from "./redact.js";

export interface GitExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
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
}

const GIT_REVIEWER_GLOBAL_ARGS = ["--no-replace-objects", "--no-pager", "-c", "color.ui=false"] as const;
const GIT_ENVIRONMENT_ROUTING_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_ATTR_SOURCE",
  "GIT_PREFIX",
  "GIT_CONFIG"
] as const;

function gitReviewerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    LC_ALL: "C",
    LANG: "C"
  };
  for (const key of GIT_ENVIRONMENT_ROUTING_KEYS) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete environment[key];
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
  config: Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes">,
  workspace: Workspace,
  args: readonly string[]
): Promise<GitExecutionResult> {
  const maxOutputBytes = Number.isFinite(config.maxOutputBytes) ? Math.max(1, Math.floor(config.maxOutputBytes)) : 1;
  const timeoutMs = Number.isFinite(config.maxGitTimeoutMs)
    ? Math.max(1, Math.min(300_000, Math.floor(config.maxGitTimeoutMs)))
    : 60_000;
  const stdout = new BoundedGitOutput(maxOutputBytes);
  const stderr = new BoundedGitOutput(maxOutputBytes);

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...GIT_REVIEWER_GLOBAL_ARGS, ...args], {
      cwd: workspace.root,
      env: gitReviewerEnvironment(),
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
      const result: GitExecutionResult = {
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode: spawnError ? null : exitCode,
        signal,
        timedOut,
        stdoutOverflow: stdout.overflow,
        stderrOverflow: stderr.overflow
      };
      const failure = gitExecutionFailure(result, spawnError);
      if (failure) {
        reject(new GitExecutionError(result, failure, spawnError?.code));
      } else {
        resolve(result);
      }
    });
  });
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
