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
  platform?: string;
  arch?: string;
}

interface ActiveRunHandle {
  readonly id: symbol;
  terminate(state: PtyRunTerminalState): void;
  readonly donePromise: Promise<void>;
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
  private readonly platform: string;
  private readonly arch: string;

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
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;

    const envPath = makeRestrictedBashEnv(config).PATH;
    const rawWrapper = options.containmentWrapper ?? config.containmentWrapper;
    this.containmentWrapper = validateContainmentWrapper(rawWrapper, envPath);
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
      throw new CodexProError(`PTY execution rejected: manager is ${this.lifecycleState}.`);
    }

    // 2. Admission: Capacity check (synchronous before any async gap)
    if (this.activeCount >= this.maxActive) {
      throw new CodexProError(`PTY concurrency limit reached: maximum ${this.maxActive} active PTY runs.`);
    }

    // 3. Platform scope check: Linux/WSL x64 only (fail closed on unproven platforms)
    if (this.platform !== "linux" || this.arch !== "x64") {
      throw new CodexProError(
        `PTY execution is only supported on Linux/WSL x64 (current host platform is ${this.platform}/${this.arch}).`
      );
    }

    // 4. Native backend gate: zigpty.hasNative === true mandatory
    if (!this.backend || this.backend.hasNative !== true) {
      throw new CodexProError(
        "PTY backend is unavailable: native PTY bindings are missing or failed to load on this platform."
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
      throw new CodexProError(`Failed to spawn PTY process: ${(spawnError as Error).message}`);
    }

    if (!pty || typeof pty.pid !== "number" || pty.pid <= 0) {
      this.activeCount = Math.max(0, this.activeCount - 1);
      try {
        pty?.close?.();
      } catch {}
      throw new CodexProError("Failed to spawn PTY process: invalid process ID returned by backend.");
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
      let killTimer: NodeJS.Timeout | undefined;

      let finalized = false;
      let exitCode: number | null = null;
      let signal: string | null = null;

      let resolveDone: () => void;
      const donePromise = new Promise<void>((r) => {
        resolveDone = r;
      });

      const activeHandle: ActiveRunHandle = {
        id: Symbol("pty_run"),
        terminate: (termState: PtyRunTerminalState) => {
          finalize(termState);
        },
        donePromise
      };
      this.activeRuns.add(activeHandle);

      const finalize = (terminalState: PtyRunTerminalState) => {
        if (finalized) return;
        finalized = true;

        // Clear timers
        if (overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = undefined;
        }
        if (stepTimer) {
          clearTimeout(stepTimer);
          stepTimer = undefined;
        }

        // Detach listeners
        try {
          dataSub.dispose();
        } catch {}
        try {
          exitSub.dispose();
        } catch {}

        // Full process tree termination if not a clean natural exit
        if (terminalState !== "succeeded" && terminalState !== "failed") {
          terminatePtyProcessTree(pid, "SIGTERM");
          killTimer = setTimeout(() => {
            terminatePtyProcessTree(pid, "SIGKILL");
          }, this.processGraceTimeoutMs);
          killTimer.unref();
        }

        // Close native PTY fds and handles
        try {
          pty.close();
        } catch {}

        // Complete uncompleted step metadata
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

        // Finalize transcript pipeline
        const pipeRes = pipeline.finish();

        // Release capacity and remove from active runs
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.activeRuns.delete(activeHandle);

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

        resolveDone();
        resolve(result);
      };

      function startStep(idx: number) {
        currentStepIndex = idx;
        stepStartTime = Date.now();
        matcherBuffer = "";
        const step = request.steps[idx];
        const stepTimeout = step.timeout_ms ?? PTY_LIMITS.defaultStepTimeoutMs;
        stepTimer = setTimeout(() => {
          finalize("step_timeout");
        }, stepTimeout);
        stepTimer.unref();
      }

      if (request.steps.length > 0) {
        startStep(0);
      }

      // Overall execution timeout
      overallTimer = setTimeout(() => {
        finalize("timed_out");
      }, request.timeoutMs);
      overallTimer.unref();

      const dataSub = pty.onData((chunk) => {
        if (finalized) return;
        const sanitizedText = pipeline.push(chunk);

        if (pipeline.isCeilingExceeded()) {
          finalize("output_limit_exceeded");
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
                inputBytesSent += Buffer.byteLength(currentStep.send, "utf8");
              } catch {}
            }

            if (currentStep.submit === true) {
              try {
                pty.write("\r");
                inputBytesSent += 1;
              } catch {}
            }

            stepResults.push({
              step_index: currentStepIndex,
              matched: true,
              input_bytes_sent: inputBytesSent,
              submit: Boolean(currentStep.submit),
              elapsed_ms: elapsed
            });

            // CRITICAL: reset matcher state entirely so output produced before this step completed cannot satisfy next step
            matcherBuffer = "";
            const nextIdx = currentStepIndex + 1;
            if (nextIdx < request.steps.length) {
              startStep(nextIdx);
            } else {
              currentStepIndex = nextIdx;
            }
          } else {
            // Keep only needed suffix for potential future boundary match
            const maxNeeded = Math.max(0, currentStep.wait_for.length - 1);
            if (matcherBuffer.length > maxNeeded) {
              matcherBuffer = matcherBuffer.slice(-maxNeeded);
            }
          }
        }
      });

      const exitSub = pty.onExit((info) => {
        exitCode = info.exitCode ?? null;
        const sigNum = typeof info.signal === "number" && info.signal > 0 ? info.signal : null;
        signal = sigNum !== null ? String(sigNum) : null;
        if (!finalized) {
          if (exitCode === 0 && sigNum === null) {
            finalize("succeeded");
          } else {
            finalize("failed");
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
   * 4. Transition to closed.
   */
  public async close(): Promise<void> {
    if (this.lifecycleState === "closed") return;
    if (this.lifecycleState === "closing") return this.closePromise!;

    this.lifecycleState = "closing";

    this.closePromise = (async () => {
      const snapshot = [...this.activeRuns];
      for (const run of snapshot) {
        run.terminate("terminated_on_shutdown");
      }
      await Promise.all(snapshot.map((r) => r.donePromise));
      this.lifecycleState = "closed";
    })();

    return this.closePromise;
  }
}
