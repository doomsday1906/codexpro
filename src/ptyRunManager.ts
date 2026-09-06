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

export interface PtyOwnershipCapability {
  supported: boolean;
  executablePath: string;
  reason?: string;
}

export const DEFAULT_UNSHARE_PATH = "/usr/bin/unshare";

/**
 * Validate that kernel-backed descendant ownership is available via unshare (user/PID namespace).
 * Preferred proven command: unshare --user --map-current-user --pid --fork --kill-child --mount-proc /usr/bin/true
 */
export function probePtyOwnershipCapability(options?: {
  unsharePath?: string;
  runner?: (file: string, args: string[], opts?: any) => { status: number | null; error?: Error };
}): PtyOwnershipCapability {
  const unsharePath = options?.unsharePath ?? DEFAULT_UNSHARE_PATH;
  try {
    fs.accessSync(unsharePath, fs.constants.X_OK);
  } catch (err: any) {
    return {
      supported: false,
      executablePath: unsharePath,
      reason: `Ownership executable '${unsharePath}' is not accessible or executable: ${err?.message || String(err)}`
    };
  }

  const runner = options?.runner ?? ((file: string, args: string[], opts: any) => spawnSync(file, args, opts));
  try {
    const res = runner(
      unsharePath,
      ["--user", "--map-current-user", "--pid", "--fork", "--kill-child", "--mount-proc", "/usr/bin/true"],
      { stdio: "ignore", timeout: 3000 }
    );
    if (res.error) {
      return {
        supported: false,
        executablePath: unsharePath,
        reason: `Ownership capability canary failed: ${res.error.message}`
      };
    }
    if (res.status !== 0) {
      return {
        supported: false,
        executablePath: unsharePath,
        reason: `Ownership capability canary exited with code ${res.status}`
      };
    }
    return {
      supported: true,
      executablePath: unsharePath
    };
  } catch (err: any) {
    return {
      supported: false,
      executablePath: unsharePath,
      reason: `Ownership capability canary execution threw: ${err?.message || String(err)}`
    };
  }
}

export interface PtyFaultInjectionHooks {
  onSpawn?: (context: {
    pty: zigpty.IPty;
    pid: number;
    injectBackendError: (err: Error) => void;
    triggerTimeout: () => void;
  }) => void;
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
  isAliveChecker?: (pid: number, knownPids?: Iterable<number>) => boolean;
  ownershipExecutable?: string;
  ownershipCapabilityProbe?: () => PtyOwnershipCapability;
  ownershipCapabilityOverride?: boolean | { supported: boolean; reason?: string };
  faultInjection?: PtyFaultInjectionHooks;
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

/**
 * Discover all descendant processes of rootPid using recursive /proc scanning on Linux.
 * Recursively resolves parent -> child -> grandchild and expands across process groups and sessions
 * associated with rootPid or known descendants, while guaranteeing unrelated decoys are preserved.
 */
export function getProcessTreePids(rootPid: number, knownPids?: Iterable<number>): number[] {
  if (!rootPid || rootPid <= 0) return [];
  if (process.platform !== "linux") {
    const result: number[] = [];
    if (isPidAlive(rootPid)) result.push(rootPid);
    if (knownPids) {
      for (const p of knownPids) {
        if (p > 0 && isPidAlive(p) && !result.includes(p)) {
          result.push(p);
        }
      }
    }
    return result;
  }

  try {
    const entries = fs.readdirSync("/proc");
    const childrenByPpid = new Map<number, number[]>();
    const byPgrp = new Map<number, number[]>();
    const bySid = new Map<number, number[]>();
    const allAlive = new Set<number>();

    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        const lastParen = stat.lastIndexOf(")");
        if (lastParen === -1) continue;
        const rest = stat.slice(lastParen + 2).trim().split(/\s+/);
        const ppid = parseInt(rest[1], 10);
        const pgrp = parseInt(rest[2], 10);
        const sid = parseInt(rest[3], 10);

        allAlive.add(pid);

        if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, []);
        childrenByPpid.get(ppid)!.push(pid);

        if (!byPgrp.has(pgrp)) byPgrp.set(pgrp, []);
        byPgrp.get(pgrp)!.push(pid);

        if (!bySid.has(sid)) bySid.set(sid, []);
        bySid.get(sid)!.push(pid);
      } catch {}
    }

    const ownedPids = new Set<number>();
    const targetPgrps = new Set<number>();
    const targetSids = new Set<number>();

    if (allAlive.has(rootPid)) {
      ownedPids.add(rootPid);
    }
    targetPgrps.add(rootPid);
    targetSids.add(rootPid);

    if (knownPids) {
      for (const p of knownPids) {
        if (p > 0 && allAlive.has(p)) {
          ownedPids.add(p);
          targetPgrps.add(p);
          targetSids.add(p);
        }
      }
    }

    // Expand through process group and session bindings
    for (const pgrp of targetPgrps) {
      const pids = byPgrp.get(pgrp);
      if (pids) {
        for (const p of pids) ownedPids.add(p);
      }
    }
    for (const sid of targetSids) {
      const pids = bySid.get(sid);
      if (pids) {
        for (const p of pids) ownedPids.add(p);
      }
    }

    // Recursively expand through children
    const queue = Array.from(ownedPids);
    if (!ownedPids.has(rootPid)) {
      queue.push(rootPid);
    }
    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = childrenByPpid.get(current);
      if (children) {
        for (const child of children) {
          if (!ownedPids.has(child)) {
            ownedPids.add(child);
            queue.push(child);
          }
        }
      }
    }

    return Array.from(ownedPids).filter((p) => allAlive.has(p));
  } catch {
    return isPidAlive(rootPid) ? [rootPid] : [];
  }
}

export function isProcessTreeAlive(pid: number, knownPids?: Iterable<number>): boolean {
  if (!pid || pid <= 0) return false;
  if (isPidAlive(pid)) return true;
  if (isProcessGroupAlive(pid)) return true;
  if (knownPids) {
    for (const p of knownPids) {
      if (p > 0 && (isPidAlive(p) || isProcessGroupAlive(p))) {
        return true;
      }
    }
  }
  const tree = getProcessTreePids(pid, knownPids);
  return tree.length > 0;
}

/**
 * Terminate a PTY process tree cleanly (LAW-016).
 * On Linux/WSL, signals the primary process group and all recursively discovered
 * descendants and their process groups.
 */
export function terminatePtyProcessTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  knownPids?: Iterable<number>
): void {
  if (!pid || pid <= 0) return;

  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t", "/f"];
    try {
      spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    } catch {}
    return;
  }

  const pids = getProcessTreePids(pid, knownPids);

  try {
    process.kill(-pid, signal);
  } catch {}
  try {
    process.kill(pid, signal);
  } catch {}

  for (const p of pids) {
    if (p === pid) continue;
    try {
      process.kill(-p, signal);
    } catch {}
    try {
      process.kill(p, signal);
    } catch {}
  }
}

export interface TerminateProcessTreeOptions {
  knownPids?: Iterable<number>;
  isAliveChecker?: (pid: number, knownPids?: Iterable<number>) => boolean;
}

/**
 * Terminate and await process tree disappearance with bounded grace (LAW-016, LAW-017).
 * Sends SIGTERM, awaits disappearance up to graceTimeoutMs, escalates to SIGKILL if still
 * alive, and awaits post-kill disappearance before returning.
 *
 * If post-SIGKILL wait expires and processes remain observed alive, performs one final
 * best-effort kill and fails closed with pty_cleanup_incomplete rather than silently
 * claiming cleanup success.
 */
export async function terminateAndAwaitProcessTree(
  pid: number,
  graceTimeoutMs = 1500,
  killWaitTimeoutMs = 1000,
  options: TerminateProcessTreeOptions = {}
): Promise<void> {
  if (!pid || pid <= 0) return;

  const isAlive = options.isAliveChecker ?? isProcessTreeAlive;
  const knownPids = options.knownPids;

  if (!isAlive(pid, knownPids)) return;

  terminatePtyProcessTree(pid, "SIGTERM", knownPids);

  const pollIntervalMs = 25;
  const startGrace = Date.now();
  while (Date.now() - startGrace < graceTimeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!isAlive(pid, knownPids)) {
      return;
    }
  }

  terminatePtyProcessTree(pid, "SIGKILL", knownPids);

  const startKill = Date.now();
  while (Date.now() - startKill < killWaitTimeoutMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (!isAlive(pid, knownPids)) {
      return;
    }
  }

  if (isAlive(pid, knownPids)) {
    terminatePtyProcessTree(pid, "SIGKILL", knownPids);
  }

  // Final verification: fail closed if descendant processes are still observed alive
  if (isAlive(pid, knownPids)) {
    throw new CodexProError(
      "PTY process tree cleanup incomplete: descendant processes still observed alive after SIGKILL escalation.",
      "pty_cleanup_incomplete"
    );
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
  private readonly isAliveChecker?: (pid: number, knownPids?: Iterable<number>) => boolean;
  private readonly ownershipExecutable: string;
  private readonly ownershipCapabilityProbe?: () => PtyOwnershipCapability;
  private readonly ownershipCapabilityOverride?: boolean | { supported: boolean; reason?: string };
  private readonly faultInjection?: PtyFaultInjectionHooks;

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
    this.isAliveChecker = options.isAliveChecker;
    this.ownershipExecutable = options.ownershipExecutable ?? DEFAULT_UNSHARE_PATH;
    this.ownershipCapabilityProbe = options.ownershipCapabilityProbe;
    this.ownershipCapabilityOverride = options.ownershipCapabilityOverride;
    this.faultInjection = options.faultInjection;

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

  public checkOwnershipCapability(): PtyOwnershipCapability {
    if (this.ownershipCapabilityOverride !== undefined) {
      if (typeof this.ownershipCapabilityOverride === "boolean") {
        return {
          supported: this.ownershipCapabilityOverride,
          executablePath: this.ownershipExecutable,
          reason: this.ownershipCapabilityOverride ? undefined : "Injected ownership capability failure"
        };
      }
      return {
        supported: this.ownershipCapabilityOverride.supported,
        executablePath: this.ownershipExecutable,
        reason: this.ownershipCapabilityOverride.reason
      };
    }
    if (this.ownershipCapabilityProbe) {
      return this.ownershipCapabilityProbe();
    }
    return probePtyOwnershipCapability({ unsharePath: this.ownershipExecutable });
  }

  public isAlive(pid: number, knownPids?: Iterable<number>): boolean {
    return (this.isAliveChecker ?? isProcessTreeAlive)(pid, knownPids);
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

    // 4. Kernel ownership capability gate (fail closed before reservation, spawn, or target execution)
    const ownershipCap = this.checkOwnershipCapability();
    if (!ownershipCap.supported) {
      throw new CodexProError(
        `PTY ownership boundary is unavailable: ${ownershipCap.reason ?? "kernel ownership capability check failed."}`,
        "pty_ownership_unavailable"
      );
    }

    // 5. Native backend gate: zigpty.hasNative === true mandatory
    if (!this.backend || this.backend.hasNative !== true) {
      throw new CodexProError(
        "PTY backend is unavailable: native PTY bindings are missing or failed to load on this platform.",
        "pty_backend_unavailable"
      );
    }

    // 6. Synchronously reserve active slot
    this.activeCount += 1;

    // Compose server-owned containment wrapper ahead of target argv
    const innerArgv = composeExecutionArgv(request.argv, this.containmentWrapper);
    const spawnExecutable = this.ownershipExecutable;
    const spawnArgs = [
      "--user",
      "--map-current-user",
      "--pid",
      "--fork",
      "--kill-child",
      "--mount-proc",
      "--",
      ...innerArgv
    ];

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

    const knownDescendants = new Set<number>();
    knownDescendants.add(pid);
    const updateKnownDescendants = () => {
      const currentPids = getProcessTreePids(pid, knownDescendants);
      for (const p of currentPids) {
        knownDescendants.add(p);
      }
    };
    const scanTimer = setInterval(updateKnownDescendants, 50);
    scanTimer.unref();

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

      let resolveDone: () => void = () => {};
      const donePromise = new Promise<void>((r) => {
        resolveDone = r;
      });

      const finalize = async (terminalState: PtyRunTerminalState): Promise<void> => {
        if (finalized) {
          return donePromise;
        }
        finalized = true;

        try {
          clearInterval(scanTimer);
          updateKnownDescendants();

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
            dataSub?.dispose();
          } catch {}
          try {
            exitSub?.dispose();
          } catch {}

          // 3. Process tree termination and bounded await (LAW-016, LAW-017)
          const cleanupOpts: TerminateProcessTreeOptions = {
            knownPids: knownDescendants,
            isAliveChecker: this.isAliveChecker
          };
          if (terminalState !== "succeeded" && terminalState !== "failed") {
            await terminateAndAwaitProcessTree(
              pid,
              this.processGraceTimeoutMs,
              this.processKillWaitTimeoutMs,
              cleanupOpts
            );
          } else {
            // Natural exit: ensure no background children were orphaned in the process tree
            if (this.isAlive(pid, knownDescendants)) {
              await terminateAndAwaitProcessTree(
                pid,
                this.processGraceTimeoutMs,
                this.processKillWaitTimeoutMs,
                cleanupOpts
              );
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
          throw err;
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

      let dataSub: zigpty.IDisposable | undefined;
      let exitSub: zigpty.IDisposable | undefined;

      const handleBackendError = async (err: Error): Promise<void> => {
        if (finalized) {
          return donePromise;
        }
        finalized = true;

        clearInterval(scanTimer);
        updateKnownDescendants();

        if (overallTimer) {
          clearTimeout(overallTimer);
          overallTimer = undefined;
        }
        if (stepTimer) {
          clearTimeout(stepTimer);
          stepTimer = undefined;
        }

        try {
          dataSub?.dispose();
        } catch {}
        try {
          exitSub?.dispose();
        } catch {}

        let cleanupError: unknown = null;
        try {
          await terminateAndAwaitProcessTree(
            pid,
            this.processGraceTimeoutMs,
            this.processKillWaitTimeoutMs,
            {
              knownPids: knownDescendants,
              isAliveChecker: this.isAliveChecker
            }
          );
        } catch (cleanErr) {
          cleanupError = cleanErr;
        }

        try {
          pty.close();
        } catch {}

        this.activeRuns.delete(activeHandle);
        this.activeCount = Math.max(0, this.activeCount - 1);
        resolveDone();

        if (cleanupError instanceof CodexProError && cleanupError.code === "pty_cleanup_incomplete") {
          reject(cleanupError);
        } else {
          reject(
            new CodexProError(
              `PTY backend error after process spawn: ${err.message}`,
              "pty_backend_error"
            )
          );
        }
      };

      try {
        dataSub = pty.onData((chunk) => {
          if (finalized) return;
          const sanitizedText = pipeline.push(chunk);

          if (pipeline.isCeilingExceeded()) {
            void finalize("output_limit_exceeded").catch(() => {});
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
                } catch {
                  inputBytesSent = 0;
                }
              }

              let submitSucceeded = false;
              if (currentStep.submit === true) {
                try {
                  pty.write("\r");
                  submitSucceeded = true;
                } catch {
                  submitSucceeded = false;
                }
              }

              stepResults.push({
                step_index: currentStepIndex,
                matched: true,
                input_bytes_sent: inputBytesSent,
                submit: submitSucceeded,
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

        exitSub = pty.onExit((info) => {
          exitCode = info.exitCode ?? null;
          const sigNum = typeof info.signal === "number" && info.signal > 0 ? info.signal : null;
          signal = sigNum !== null ? String(sigNum) : null;
          if (!finalized) {
            if (exitCode === 0 && sigNum === null) {
              void finalize("succeeded").catch(() => {});
            } else {
              void finalize("failed").catch(() => {});
            }
          }
        });
      } catch (listenerError) {
        void handleBackendError(listenerError as Error);
        return;
      }

      if (this.faultInjection?.onSpawn) {
        this.faultInjection.onSpawn({
          pty,
          pid,
          injectBackendError: (err: Error) => {
            void handleBackendError(err);
          },
          triggerTimeout: () => {
            void finalize("timed_out").catch(() => {});
          }
        });
      }

      function startStep(idx: number) {
        currentStepIndex = idx;
        stepStartTime = Date.now();
        matcherBuffer = "";
        const step = request.steps[idx];
        const stepTimeout = step.timeout_ms ?? PTY_LIMITS.defaultStepTimeoutMs;
        stepTimer = setTimeout(() => {
          void finalize("step_timeout").catch(() => {});
        }, stepTimeout);
        stepTimer.unref();
      }

      if (request.steps.length > 0) {
        startStep(0);
      }

      // Overall execution timeout
      overallTimer = setTimeout(() => {
        void finalize("timed_out").catch(() => {});
      }, request.timeoutMs);
      overallTimer.unref();
    });
  }

  /**
   * Controlled manager shutdown (LAW-017).
   * 1. Synchronously set lifecycle state to closing (admission immediately sealed).
   * 2. Snapshot currently owned active runs.
   * 3. Terminate / await bounded cleanup of all active runs.
   * 4. Transition to closed only after all active runs' owned trees have disappeared.
   *    If cleanup is incomplete, manager does NOT transition to closed.
   */
  public close(): Promise<void> {
    if (this.lifecycleState === "closed") {
      return this.closePromise ?? Promise.resolve();
    }
    if (this.closePromise) {
      return this.closePromise;
    }

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
