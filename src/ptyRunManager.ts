import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as zigpty from "zigpty";
import type { CodexProConfig } from "./config.js";
import { CodexProError } from "./guard.js";
import { makeRestrictedBashEnv } from "./bashOps.js";
import { redactDiagnosticText } from "./redact.js";
import { validateContainmentWrapper, composeExecutionArgv } from "./verificationOps.js";
import {
  PTY_LIMITS,
  validatePtyRunInput,
  type PtyStepInput,
  type PtyValidationContext,
  type ValidatedPtyRunRequest
} from "./ptyValidator.js";
import { PtyTranscriptPipeline } from "./ptyTerminalSanitizer.js";

export type PtyRunTerminalState =
  | "succeeded"
  | "failed"
  | "step_timeout"
  | "timed_out"
  | "output_limit_exceeded"
  | "terminated_on_shutdown";

export interface PtyStepResultMetadata {
  step_index: number;
  matched: boolean;
  input_bytes_sent: number;
  submit: boolean;
  elapsed_ms: number;
}

export interface PtyTerminalProfile {
  cols: number;
  rows: number;
  term: string;
  no_color: string;
}

export interface PtyRunResult {
  state: PtyRunTerminalState;
  workspace_id: string;
  workspace_root: string;
  cwd: string;
  command: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  transcript: string;
  raw_observed_bytes: number;
  truncated: boolean;
  steps: PtyStepResultMetadata[];
  terminal_profile: PtyTerminalProfile;
  containment_enabled: boolean;
}

export interface PtyBackend {
  hasNative: boolean;
  spawn: (file: string, args: string[], options: any) => zigpty.IPty;
}

export interface PtyRunManagerOptions {
  maxActive?: number;
  containmentWrapper?: string[];
  backend?: PtyBackend;
  hardOutputCeilingBytes?: number;
  maxControlPayloadChars?: number;
  processGraceTimeoutMs?: number;
  processKillWaitTimeoutMs?: number;
  platform?: string;
  arch?: string;
  onMatcherBufferUpdate?: (bufferLength: number, bufferContent: string) => void;
}

interface ActiveRunHandle {
  readonly id: symbol;
  terminate(state: PtyRunTerminalState): Promise<void>;
  readonly donePromise: Promise<void>;
}

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  if (process.platform === "win32") {
    return isPidAlive(pid);
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

export function isProcessTreeAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;

  if (isPidAlive(pid)) return true;
  if (isProcessGroupAlive(pid)) return true;

  if (process.platform === "linux") {
    try {
      const entries = fs.readdirSync("/proc");
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const entryPid = parseInt(entry, 10);
        if (entryPid === pid) return true;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const lastParen = stat.lastIndexOf(")");
          if (lastParen !== -1) {
            const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
            const ppid = parseInt(rest[1], 10);
            const pgrp = parseInt(rest[2], 10);
            const sid = parseInt(rest[3], 10);
            if (ppid === pid || pgrp === pid || sid === pid) {
              return true;
            }
          }
        } catch {}
      }
    } catch {}
  }

  return false;
}

/**
 * Terminate a PTY process tree cleanly (LAW-016).
 * On Linux/WSL, zigpty leader is its own process group leader (setsid),
 * so sending the signal to `-pid` terminates leader and all descendants.
 */
export function terminatePtyProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t", "/f"];
    try {
      spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch (innerError) {
        // ESRCH is expected when child has already exited
      }
    }
  }

  try {
    process.kill(pid, signal);
  } catch {}

  if (process.platform === "linux") {
    try {
      const entries = fs.readdirSync("/proc");
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const entryPid = parseInt(entry, 10);
        if (entryPid === pid) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const lastParen = stat.lastIndexOf(")");
          if (lastParen !== -1) {
            const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
            const ppid = parseInt(rest[1], 10);
            const pgrp = parseInt(rest[2], 10);
            const sid = parseInt(rest[3], 10);
            if (ppid === pid || pgrp === pid || sid === pid) {
              try {
                process.kill(entryPid, signal);
              } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }
}

/**
 * Terminate and await process tree disappearance with bounded grace (LAW-016, LAW-017).
 * Sends SIGTERM, awaits disappearance up to graceTimeoutMs, escalates to SIGKILL if still
 * alive, and awaits post-kill disappearance before returning.
 */
export async function terminateAndAwaitProcessTree(
  pid: number,
  graceTimeoutMs = 1500,
  killWaitTimeoutMs = 1000
): Promise<void> {
  if (!pid || pid <= 0) return;

  if (!isProcessTreeAlive(pid)) return;

  terminatePtyProcessTree(pid, "SIGTERM");

  const pollIntervalMs = 25;
  const startGrace = Date.now();
  while (Date.now() - startGrace < graceTimeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!isProcessTreeAlive(pid)) {
      return;
    }
  }

  terminatePtyProcessTree(pid, "SIGKILL");

  const startKill = Date.now();
  while (Date.now() - startKill < killWaitTimeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!isProcessTreeAlive(pid)) {
      return;
    }
  }

  if (isProcessTreeAlive(pid)) {
    terminatePtyProcessTree(pid, "SIGKILL");
  }
}

/**
 * Explicitly trim matcher buffer to the needed suffix length.
 * When wait_for length is 1 (maxNeeded = 0), buffer becomes "" instead of retaining
 * entire buffer via slice(-0).
 */
export function trimMatcherBuffer(buffer: string, waitForLength: number): string {
  const maxNeeded = Math.max(0, waitForLength - 1);
  if (maxNeeded === 0) {
    return "";
  }
  if (buffer.length > maxNeeded) {
    return buffer.slice(-maxNeeded);
  }
  return buffer;
}

/**
 * Cleanup-only, process-scoped PTY execution manager (LAW-002, LAW-013, LAW-017).
 *
 * Enforces:
 * - lifecycle: open -> closing -> closed;
 * - synchronous admission seal and maxActive capacity bound (default: 2, no queue);
 * - platform scope: Linux/WSL x64 only;
 * - native backend gate: zigpty.hasNative === true, no pipe fallback;
 * - server-owned terminal profile: 80x24, xterm-256color, NO_COLOR=1, no caller env injection;
 * - server-owned containment wrapper composition;
 * - stateful terminal sanitization -> StreamingRedactor -> bounded transcript;
 * - sequential literal prompt matching;
 * - caller send text never leaked into metadata or synthetic annotations;
 * - exactly-once finalization, timer cleanup, listener detaching, active slot release;
 * - zero continuity surface (no PTY/run ID, no attach/resume/cancel/lookup, no completed store).
 */
export class PtyRunManager {
  private readonly config: CodexProConfig;
  private readonly maxActive: number;
  private readonly containmentWrapper?: string[];
  private readonly backend: PtyBackend;
  private readonly hardOutputCeilingBytes: number;
  private readonly maxControlPayloadChars: number;
  private readonly processGraceTimeoutMs: number;
  private readonly processKillWaitTimeoutMs: number;
  private readonly platform: string;
  private readonly arch: string;
  private readonly onMatcherBufferUpdate?: (bufferLength: number, bufferContent: string) => void;

  private lifecycleState: "open" | "closing" | "closed" = "open";
  private activeCount = 0;
  private readonly activeRuns = new Set<ActiveRunHandle>();
  private closePromise: Promise<void> | null = null;

  constructor(config: CodexProConfig, options: PtyRunManagerOptions = {}) {
    this.config = config;
    this.maxActive = options.maxActive ?? PTY_LIMITS.maxActivePtys;
    this.backend = options.backend ?? (zigpty as unknown as PtyBackend);
    this.hardOutputCeilingBytes = options.hardOutputCeilingBytes ?? PTY_LIMITS.hardOutputCeilingBytes;
    this.maxControlPayloadChars = options.maxControlPayloadChars ?? 4096;
    this.processGraceTimeoutMs = options.processGraceTimeoutMs ?? 1500;
    this.processKillWaitTimeoutMs = options.processKillWaitTimeoutMs ?? 1000;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.onMatcherBufferUpdate = options.onMatcherBufferUpdate;

    const envPath = makeRestrictedBashEnv(config).PATH;
    const rawWrapper = options.containmentWrapper ?? config.containmentWrapper;
    try {
      this.containmentWrapper = validateContainmentWrapper(rawWrapper, envPath);
    } catch (err) {
      if (err instanceof CodexProError) {
        err.code = "pty_containment_wrapper_invalid";
        throw err;
      }
      throw new CodexProError(
        `Failed to initialize containment wrapper: ${(err as Error).message}`,
        "pty_containment_wrapper_invalid"
      );
    }
  }

  public get state(): "open" | "closing" | "closed" {
    return this.lifecycleState;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Validate and execute a PTY run input envelope.
   */
  public async run(rawInput: unknown, context: PtyValidationContext): Promise<PtyRunResult> {
    const validated = await validatePtyRunInput(rawInput, this.config, context);
    return this.execute(validated);
  }

  /**
   * Execute an already-validated PTY run request.
   */
  public async execute(request: ValidatedPtyRunRequest): Promise<PtyRunResult> {
    // 1. Admission: Lifecycle check (synchronous before any async gap)
    if (this.lifecycleState !== "open") {
      throw new CodexProError(`PTY execution rejected: manager is ${this.lifecycleState}.`, "pty_shutting_down");
    }

    // 2. Admission: Capacity check (synchronous before any async gap)
    if (this.activeCount >= this.maxActive) {
      throw new CodexProError(
        `PTY concurrency limit reached: maximum ${this.maxActive} active PTY runs.`,
        "pty_capacity_reached"
      );
    }

    // 3. Platform scope check: Linux/WSL x64 only (fail closed on unproven platforms)
    if (this.platform !== "linux" || this.arch !== "x64") {
      throw new CodexProError(
        `PTY execution is only supported on Linux/WSL x64 (current host platform is ${this.platform}/${this.arch}).`,
        "pty_platform_unsupported"
      );
    }

    // 4. Native backend gate: zigpty.hasNative === true mandatory
    if (!this.backend || this.backend.hasNative !== true) {
      throw new CodexProError(
        "PTY backend is unavailable: native PTY bindings are missing or failed to load on this platform.",
        "pty_backend_unavailable"
      );
    }

    // 5. Synchronously reserve active slot
    this.activeCount += 1;

    // Compose server-owned containment wrapper ahead of target argv
    const composedArgv = composeExecutionArgv(request.argv, this.containmentWrapper);
    const spawnExecutable = composedArgv[0];
    const spawnArgs = composedArgv.slice(1);

    // Prepare restricted PTY environment
    const baseEnv = makeRestrictedBashEnv(this.config);
    const ptyEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(baseEnv)) {
      if (v !== undefined) {
        ptyEnv[k] = v;
      }
    }
    // Server-owned terminal profile overrides
    ptyEnv.TERM = "xterm-256color";
    ptyEnv.NO_COLOR = "1";
    // CI must not suppress interactive prompts in PTY mode
    delete ptyEnv.CI;

    const ptyOptions: zigpty.IPtyOptions = {
      cols: PTY_LIMITS.fixedCols,
      rows: PTY_LIMITS.fixedRows,
      name: "xterm-256color",
      cwd: request.cwd,
      env: ptyEnv,
      pipe: false,
      shell: false
    };

    let pty: zigpty.IPty;
    try {
      pty = this.backend.spawn(spawnExecutable, spawnArgs, ptyOptions);
    } catch (spawnError) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      throw new CodexProError(`Failed to spawn PTY process: ${(spawnError as Error).message}`, "pty_spawn_failed");
    }

    if (!pty || typeof pty.pid !== "number" || pty.pid <= 0) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      try {
        pty?.close?.();
      } catch {}
      throw new CodexProError("Failed to spawn PTY process: invalid process ID returned by backend.", "pty_spawn_failed");
    }

    const startTime = Date.now();
    const pid = pty.pid;

    return new Promise<PtyRunResult>((resolve, reject) => {
      const pipeline = new PtyTranscriptPipeline({
        maxOutputBytes: this.config.maxOutputBytes,
        hardOutputCeilingBytes: this.hardOutputCeilingBytes,
        maxControlPayloadChars: this.maxControlPayloadChars
      });

      const stepResults: PtyStepResultMetadata[] = [];
      let currentStepIndex = 0;
      let stepStartTime = Date.now();
      let matcherBuffer = "";
      let stepTimer: NodeJS.Timeout | undefined;
      let overallTimer: NodeJS.Timeout | undefined;

      let finalized = false;
      let exitCode: number | null = null;
      let signal: string | null = null;

      let resolveDone: () => void;
      const donePromise = new Promise<void>((r) => {
        resolveDone = r;
      });

      const finalize = async (terminalState: PtyRunTerminalState): Promise<void> => {
        if (finalized) {
          return donePromise;
        }
        finalized = true;

        try {
          // 1. Clear timers synchronously
          if (overallTimer) {
            clearTimeout(overallTimer);
            overallTimer = undefined;
          }
          if (stepTimer) {
            clearTimeout(stepTimer);
            stepTimer = undefined;
          }

          // 2. Detach listeners synchronously
          try {
            dataSub.dispose();
          } catch {}
          try {
            exitSub.dispose();
          } catch {}

          // 3. Process tree termination and bounded await (LAW-016, LAW-017)
          if (terminalState !== "succeeded" && terminalState !== "failed") {
            await terminateAndAwaitProcessTree(pid, this.processGraceTimeoutMs, this.processKillWaitTimeoutMs);
          } else {
            // Natural exit: ensure no background children were orphaned in the process group
            if (isProcessTreeAlive(pid)) {
              await terminateAndAwaitProcessTree(pid, 200, 500);
            }
          }

          // 4. Close native PTY fds and handles only after process tree termination
          try {
            pty.close();
          } catch {}

          // 5. Complete uncompleted step metadata
          if (stepResults.length < request.steps.length) {
            for (let i = stepResults.length; i < request.steps.length; i++) {
              const isCurrentTimedOut = terminalState === "step_timeout" && i === currentStepIndex;
              stepResults.push({
                step_index: i,
                matched: false,
                input_bytes_sent: 0,
                submit: false,
                elapsed_ms: isCurrentTimedOut ? Date.now() - stepStartTime : 0
              });
            }
          }

          // 6. Finalize transcript pipeline
          const pipeRes = pipeline.finish();

          const finishTime = Date.now();
          const durationMs = finishTime - startTime;

          const result: PtyRunResult = {
            state: terminalState,
            workspace_id: request.workspaceId,
            workspace_root: request.workspaceRoot,
            cwd: path.relative(request.workspaceRoot, request.cwd) || ".",
            command: redactDiagnosticText(request.argv.join(" ")),
            started_at: new Date(startTime).toISOString(),
            finished_at: new Date(finishTime).toISOString(),
            duration_ms: durationMs,
            exit_code: exitCode,
            signal,
            transcript: pipeRes.transcript,
            raw_observed_bytes: pipeRes.rawObservedBytes,
            truncated: pipeRes.truncated,
            steps: stepResults,
            terminal_profile: {
              cols: PTY_LIMITS.fixedCols,
              rows: PTY_LIMITS.fixedRows,
              term: "xterm-256color",
              no_color: "1"
            },
            containment_enabled: Boolean(this.containmentWrapper && this.containmentWrapper.length > 0)
          };

          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          // 7. Release capacity and remove from active runs only after tree cleanup
          this.activeRuns.delete(activeHandle);
          this.activeCount = Math.max(0, this.activeCount - 1);
          resolveDone();
        }
      };

      const activeHandle: ActiveRunHandle = {
        id: Symbol("pty_run"),
        terminate: async (termState: PtyRunTerminalState) => {
          await finalize(termState);
        },
        donePromise
      };
      this.activeRuns.add(activeHandle);

      function startStep(idx: number) {
        currentStepIndex = idx;
        stepStartTime = Date.now();
        matcherBuffer = "";
        const step = request.steps[idx];
        const stepTimeout = step.timeout_ms ?? PTY_LIMITS.defaultStepTimeoutMs;
        stepTimer = setTimeout(() => {
          void finalize("step_timeout");
        }, stepTimeout);
        stepTimer.unref();
      }

      if (request.steps.length > 0) {
        startStep(0);
      }

      // Overall execution timeout
      overallTimer = setTimeout(() => {
        void finalize("timed_out");
      }, request.timeoutMs);
      overallTimer.unref();

      const dataSub = pty.onData((chunk) => {
        if (finalized) return;
        const sanitizedText = pipeline.push(chunk);

        if (pipeline.isCeilingExceeded()) {
          void finalize("output_limit_exceeded");
          return;
        }

        if (currentStepIndex < request.steps.length && !finalized) {
          matcherBuffer += sanitizedText;
          const currentStep = request.steps[currentStepIndex];
          const matchIdx = matcherBuffer.indexOf(currentStep.wait_for);
          if (matchIdx !== -1) {
            if (stepTimer) {
              clearTimeout(stepTimer);
              stepTimer = undefined;
            }
            const elapsed = Date.now() - stepStartTime;
            let inputBytesSent = 0;

            if (currentStep.send) {
              try {
                pty.write(currentStep.send);
                // LAW-011: input_bytes_sent counts UTF-8 bytes from caller send only
                inputBytesSent = Buffer.byteLength(currentStep.send, "utf8");
              } catch {}
            }

            if (currentStep.submit === true) {
              try {
                pty.write("\r");
              } catch {}
            }

            stepResults.push({
              step_index: currentStepIndex,
              matched: true,
              input_bytes_sent: inputBytesSent,
              submit: currentStep.submit === true,
              elapsed_ms: elapsed
            });

            // Reset matcher state entirely so output produced before this step completed cannot satisfy next step
            matcherBuffer = "";
            this.onMatcherBufferUpdate?.(0, "");
            const nextIdx = currentStepIndex + 1;
            if (nextIdx < request.steps.length) {
              startStep(nextIdx);
            } else {
              currentStepIndex = nextIdx;
            }
          } else {
            // Keep only needed suffix for potential future boundary match; empty when length is 1
            matcherBuffer = trimMatcherBuffer(matcherBuffer, currentStep.wait_for.length);
            this.onMatcherBufferUpdate?.(matcherBuffer.length, matcherBuffer);
          }
        }
      });

      const exitSub = pty.onExit((info) => {
        exitCode = info.exitCode ?? null;
        const sigNum = typeof info.signal === "number" && info.signal > 0 ? info.signal : null;
        signal = sigNum !== null ? String(sigNum) : null;
        if (!finalized) {
          if (exitCode === 0 && sigNum === null) {
            void finalize("succeeded");
          } else {
            void finalize("failed");
          }
        }
      });
    });
  }

  /**
   * Controlled manager shutdown (LAW-017).
   * 1. Synchronously set lifecycle state to closing (admission immediately sealed).
   * 2. Snapshot currently owned active runs.
   * 3. Terminate / await bounded cleanup of all active runs.
   * 4. Transition to closed only after all active runs' owned trees have disappeared.
   */
  public async close(): Promise<void> {
    if (this.lifecycleState === "closed") return;
    if (this.lifecycleState === "closing") return this.closePromise!;

    this.lifecycleState = "closing";

    this.closePromise = (async () => {
      const snapshot = [...this.activeRuns];
      const terminations = snapshot.map((run) => run.terminate("terminated_on_shutdown"));
      await Promise.all(terminations);
      await Promise.all(snapshot.map((r) => r.donePromise));
      this.lifecycleState = "closed";
    })();

    return this.closePromise;
  }
}
