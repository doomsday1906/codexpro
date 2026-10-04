/**
 * Authenticated MCP tools for durable delegation + MCP Events transport
 * (Leaf 2: group hestia-cli-canary, Codex Luna + OpenCode canary slices).
 *
 * Tools:
 *   delegation_launch      - launch one canary run (Codex Luna via
 *                            `codex exec --profile`; OpenCode via
 *                            `opencode run --model ... --format json`)
 *   delegation_list        - inspect/list runs (owner-scoped)
 *   delegation_read_result - authorized read + durable event replay + explicit ack
 *   delegation_followup    - real durable follow-up: structured questions move
 *                            a settled run to needs-input; replies reference
 *                            the exact input-request id, apply at most once,
 *                            and launch one bounded continuation (true resume
 *                            via opencode --session, honestly-labeled new
 *                            attempt for ephemeral Codex)
 *   delegation_cancel      - idempotent cancel of the exact owned tree only
 *   events_list            - the one narrow run-attention event
 *   events_subscribe       - webhook subscribe with challenge verification
 *   events_unsubscribe     - idempotent, owner-checked unsubscribe
 *
 * Every op verifies the authenticated owner: the caller recomputes the owner
 * id from the CURRENT server credentials and constant-time compares it with
 * the run/subscription record. Knowing a group or run id grants no access.
 * On the HTTP endpoint this rides the existing bearer-token gate; on stdio
 * the owner is the local user + server root.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CODEXPRO_PACKAGE_ROOT } from "./buildIdentity.js";
import { CodexProError, PathGuard, WorkspaceManager } from "./guard.js";
import {
  DELEGATION_BOUNDS,
  DELEGATION_GROUP_DEFAULT,
  activeSessionHolders,
  applyCheckpointReply,
  clearPendingDispatch,
  findRunByRequestId,
  isDelegationGroupId,
  isLaunchRequestConflict,
  listDelegationRuns,
  loadDelegationRun,
  newRunId,
  nextActionFor,
  openInputRequests,
  ownerIdFor,
  pendingDispatchFor,
  reconcileRunState,
  registerInputRequest,
  runInputRequests,
  sanitizeSummary,
  sanitizeTaskText,
  saveDelegationRun,
  stableEventId,
  stagePendingDispatch,
  summarizeTerminal,
  validateCheckpointForRun,
  verifyRunOwner,
  type CheckpointShape,
  type DelegationAttempt,
  type DelegationRunRecord,
  type DelegationRunState,
  type DelegationSessionBinding
} from "./delegationStore.js";
import {
  buildCodexCanaryArgv,
  buildCodexResumeArgv,
  buildFollowupPrompt,
  buildOpenCodeCanaryArgv,
  CANARY_FIXTURES,
  canaryPrompt,
  cancelOwnedTree,
  clampCanaryTimeout,
  clampRealTaskTimeout,
  CODEX_RESUME_CAPABILITY,
  codexHomeDir,
  collectOwnedTree,
  describeOpenCodeDiscovery,
  isEngineSessionId,
  isProcessIdentityAlive,
  OPENCODE_RESUME_CAPABILITY,
  parseOpenCodeSessionId,
  readProcessStartTime,
  resolveOpenCodeBinary,
  sha256File,
  signalOwnedTree,
  verifyLunaProfile,
  verifyOpenCodeModel,
  verifyOpenCodeSession,
  waitForSpawn
} from "./delegationEngines.js";
import {
  deliverEventToSubscription,
  deterministicSubscriptionId,
  eventsCapability,
  handleEventsList,
  handleEventsSubscribe,
  handleEventsUnsubscribe,
  handleServerDiscover,
  isAppEventDeliveryEnabled,
  isEventsDeliveryEnabled,
  isSubscriptionExpired,
  listRunAttentionEvent,
  loadSubscriptions,
  nextRetryDelayMs,
  RUN_ATTENTION_EVENT,
  saveSubscriptions,
  SUBSCRIPTION_CHALLENGE_ERROR_CODE,
  subscriptionMatches,
  validateSubscriptionInput,
  verifySubscriptionChallenge,
  type EventSubscription,
  type RunAttentionEvent
} from "./delegationEvents.js";

export interface DelegationToolDeps {
  config: CodexProConfig;
  workspaces: WorkspaceManager;
  guard: PathGuard;
}

export interface DelegationToolDef {
  name: string;
  options: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };

function okResult(text: string, structured: Record<string, unknown>): any {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function failResult(text: string, structured: Record<string, unknown>): any {
  return { isError: true, content: [{ type: "text", text }], structuredContent: structured };
}

function localOwnerId(config: CodexProConfig): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  return `${uid}:${config.defaultRoot}`;
}

function bridgeDirFor(config: CodexProConfig, workspaceRoot: string): string {
  return path.join(workspaceRoot, config.contextDir);
}

function fixtureSourceDir(): string {
  const override = String(process.env.CODEXPRO_DELEGATION_FIXTURES ?? "").trim();
  if (override) return path.resolve(override);
  return path.join(CODEXPRO_PACKAGE_ROOT, "scripts", "fixtures", "delegation-canary");
}

function resolveCodexBinary(): string {
  const explicit = String(process.env.CODEXPRO_CODEX_BIN ?? "").trim();
  return explicit || "codex";
}

/** Live child handles for this process. Files stay the durable authority. */
interface LiveRun {
  child: ChildProcess;
  timeout: NodeJS.Timeout;
  settled: boolean;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  fixtureHashes: Record<string, string>;
  lastMessagePath: string;
  timedOut: boolean;
}

type DelegationRuntime = { live: Map<string, LiveRun> };

function processRuntime(): DelegationRuntime {
  const key = "__codexproDelegationRuntime";
  const existing = (globalThis as Record<string, unknown>)[key] as DelegationRuntime | undefined;
  if (existing) return existing;
  const created: DelegationRuntime = { live: new Map() };
  (globalThis as Record<string, unknown>)[key] = created;
  return created;
}

const LIVE_OUTPUT_CAP_BYTES = 64 * 1024;

function appendLive(buf: Buffer[], total: { n: number }, chunk: Buffer): void {
  total.n += chunk.byteLength;
  buf.push(chunk);
  let bytes = buf.reduce((sum, part) => sum + part.byteLength, 0);
  while (buf.length > 0 && bytes > LIVE_OUTPUT_CAP_BYTES) {
    const first = buf.shift() as Buffer;
    bytes -= first.byteLength;
  }
}

function tailText(chunks: Buffer[], maxBytes: number): string {
  const full = Buffer.concat(chunks).toString("utf8");
  const buf = Buffer.from(full, "utf8");
  if (buf.byteLength <= maxBytes) return full;
  let start = buf.byteLength - maxBytes;
  while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

function ownerAllowed(deps: DelegationToolDeps, run: DelegationRunRecord): boolean {
  return verifyRunOwner(deps.config.authToken, localOwnerId(deps.config), run);
}

function subscriptionOwnerMatches(deps: DelegationToolDeps, sub: EventSubscription): boolean {
  const current = ownerIdFor(deps.config.authToken, localOwnerId(deps.config));
  if (current.ownerKind !== sub.ownerKind) return false;
  const a = Buffer.from(current.ownerIdHash, "utf8");
  const b = Buffer.from(sub.ownerIdHash, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function denyAccess(): any {
  return failResult("Access denied: this run or subscription belongs to a different authenticated owner.", {
    error: "access_denied",
    hint: "knowing a group or run id grants no access"
  });
}

function activeRuns(bridgeDir: string): DelegationRunRecord[] {
  return listDelegationRuns(bridgeDir).filter((run) => {
    if (run.state !== "running" && run.state !== "queued") return false;
    const latest = run.attempts.at(-1);
    if (latest?.pid === undefined || latest.processStartTime === undefined) return false;
    return isProcessIdentityAlive(latest.pid, latest.processStartTime);
  });
}

async function pumpDeliveries(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord
): Promise<DelegationRunRecord> {
  // Split flags: ONLY app-event POSTs are gated here.
  // Verification + subscription storage are always allowed (see
  // events_subscribe -> handleEventsSubscribe). While app delivery is OFF,
  // pending deliveries stay pending and remain replayable via read_result.
  if (!isAppEventDeliveryEnabled()) return run;
  const subs = loadSubscriptions(bridgeDir);
  const byId = new Map(subs.map((sub) => [sub.subId, sub]));
  let changed = false;
  const now = Date.now();
  for (const event of run.pendingEvents) {
    for (const delivery of event.deliveries) {
      if (delivery.status === "delivered" || delivery.status === "permanent") continue;
      if (delivery.status === "failed" && delivery.nextRetryAt && Date.parse(delivery.nextRetryAt) > now) continue;
      if (delivery.attempts >= 5) {
        delivery.status = "permanent";
        delivery.lastError = `${delivery.lastError ?? "delivery failed"}; retry budget exhausted`;
        changed = true;
        continue;
      }
      const sub = byId.get(delivery.subId);
      if (!sub) {
        delivery.status = "permanent";
        delivery.lastError = "subscription removed; delivery stopped";
        changed = true;
        continue;
      }
      if (isSubscriptionExpired(sub, now)) {
        delivery.status = "permanent";
        delivery.lastError = "subscription expired; delivery stopped";
        changed = true;
        continue;
      }
      let secret: Buffer;
      try {
        secret = Buffer.from(String(sub.secret).slice("whsec_".length), "base64");
      } catch {
        delivery.status = "permanent";
        delivery.lastError = "subscription secret unreadable";
        changed = true;
        continue;
      }
      const runEvent: RunAttentionEvent = {
        event: RUN_ATTENTION_EVENT,
        eventId: event.eventId,
        runId: run.runId,
        engine: run.engine,
        delegationGroup: run.delegationGroup,
        state: event.state as RunAttentionEvent["state"],
        seq: event.seq,
        version: 1,
        ...(event.summary ? { summary: event.summary } : {}),
        ...(event.inputRequestId ? { inputRequestId: event.inputRequestId } : {}),
        createdAt: event.createdAt
      };
      const outcome = await deliverEventToSubscription(sub.callbackUrl, secret, runEvent, fetch, 10_000, { subId: sub.subId });
      delivery.attempts += 1;
      if (outcome.status === "delivered") {
        delivery.status = "delivered";
        delete delivery.lastError;
        delete delivery.nextRetryAt;
      } else if (outcome.status === "permanent") {
        delivery.status = "permanent";
        delivery.lastError = outcome.error;
        delete delivery.nextRetryAt;
      } else {
        delivery.status = "failed";
        delivery.lastError = outcome.error;
        delivery.nextRetryAt = new Date(now + nextRetryDelayMs(delivery.attempts)).toISOString();
      }
      changed = true;
    }
  }
  if (changed) saveDelegationRun(bridgeDir, run);
  return run;
}

function enqueueTerminalEvent(run: DelegationRunRecord, subs: EventSubscription[]): DelegationRunRecord {
  const seq = run.seq + 1;
  const summary = sanitizeSummary(run.result?.summary ?? summarizeTerminal(run.state, run.result?.exitCode, run.result?.timedOut));
  run.seq = seq;
  run.pendingEvents = [
    ...run.pendingEvents,
    {
      eventId: stableEventId(run.runId, seq),
      seq,
      state: run.state,
      summary,
      createdAt: new Date().toISOString(),
      deliveries: subs.filter((sub) => subscriptionMatches(sub, { delegationGroup: run.delegationGroup, runId: run.runId }))
        .map((sub) => ({ subId: sub.subId, status: "pending" as const, attempts: 0 }))
    }
  ].slice(-DELEGATION_BOUNDS.maxPendingEventsPerRun);
  run.nextAction = nextActionFor(run.state, run.pendingEvents.some((event) =>
    event.deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "failed")));
  return run;
}

function finalizeLiveRun(deps: DelegationToolDeps, bridgeDir: string, runId: string, final: {
  state: DelegationRunState;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}, note?: string): void {
  const runtime = processRuntime();
  const live = runtime.live.get(runId);
  runtime.live.delete(runId);
  const run = loadDelegationRun(bridgeDir, runId);
  if (!run) return;
  const latest = run.attempts.at(-1);
  const finishedAt = new Date().toISOString();
  let fixturesUnchanged: boolean | undefined;
  // Read-only proof applies to canary runs only (legacy run files predate
  // isCanary and ARE canary runs). Real tasks carry no fixtures.
  if (live && run.isCanary !== false && Object.keys(live.fixtureHashes).length > 0) {
    try {
      fixturesUnchanged = CANARY_FIXTURES.every((name) => {
        const current = sha256File(path.join(run.workdir, name));
        return current === live.fixtureHashes[name];
      });
    } catch {
      fixturesUnchanged = false;
    }
  }
  if (run.engine === "opencode" && live) {
    const observed = parseOpenCodeSessionId(tailText(live.stdoutChunks, DELEGATION_BOUNDS.maxTailBytes));
    // An explicit --session id wins over best-effort output parsing: the
    // parse tries several key spellings and must never hijack resume to a
    // misparsed id. Observed ids are adopted only for minted (non-explicit)
    // runs, where they are the sole session evidence.
    if (observed && isEngineSessionId(observed) && !run.session?.sessionId) {
      if (latest) latest.sessionId = observed;
      run.session = {
        engine: "opencode",
        sessionId: observed,
        resumable: true,
        observed: true,
        evidence: "session id observed in worker --format json stdout (shape best-effort); liveness verified at continuation time via session list/export before any resumed label",
        reason: "session id observed in worker --format json stdout (shape best-effort); resume via opencode run --session"
      };
    } else if (!run.session?.sessionId) {
      run.session = {
        engine: "opencode",
        resumable: false,
        reason: "no session id observed in worker stdout; follow-up starts a labeled new-continuation-attempt"
      };
    }
  }
  let state = final.state;
  let summary = summarizeTerminal(final.state, final.exitCode, final.timedOut);
  if (note) summary = `${summary}; ${note}`;
  if (state === "completed" && fixturesUnchanged === false) {
    state = "failed";
    summary = "canary fixtures were modified; read-only contract violated";
  }
  const finishedAttempt: DelegationAttempt | undefined = latest
    ? {
        ...latest,
        finishedAt,
        state,
        exitCode: final.exitCode,
        signal: final.signal,
        timedOut: final.timedOut,
        summary: sanitizeSummary(summary)
      }
    : undefined;
  run.state = state;
  if (finishedAttempt) run.attempts = [...run.attempts.slice(0, -1), finishedAttempt];
  run.result = {
    exitCode: final.exitCode,
    signal: final.signal,
    timedOut: final.timedOut,
    summary: sanitizeSummary(summary),
    stdoutTail: live ? tailText(live.stdoutChunks, DELEGATION_BOUNDS.maxTailBytes) : undefined,
    stderrTail: live ? tailText(live.stderrChunks, DELEGATION_BOUNDS.maxTailBytes) : undefined,
    ...(fixturesUnchanged === undefined ? {} : { fixturesUnchanged })
  };
  enqueueTerminalEvent(run, loadSubscriptions(bridgeDir));
  // Atomic: terminal state + pending wake-up event persist in one write.
  saveDelegationRun(bridgeDir, run);
  void pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, runId) ?? run).catch(() => undefined);
}

function spawnCanaryChild(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  binary: string,
  argv: string[],
  timeoutMs: number,
  lastMessagePath: string,
  isCanary: boolean
): ChildProcess {
  const runtime = processRuntime();
  // Canary runs hash the read-only fixtures before spawn so completion can
  // prove them unchanged. Real tasks carry no fixtures: nothing to hash.
  const fixtureHashes: Record<string, string> = {};
  if (isCanary) {
    for (const name of CANARY_FIXTURES) fixtureHashes[name] = sha256File(path.join(run.workdir, name));
  }
  const child = spawn(binary, argv, {
    cwd: run.workdir,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    windowsHide: true
  });
  const stdoutTotal = { n: 0 };
  const stderrTotal = { n: 0 };
  const live: LiveRun = {
    child,
    timeout: setTimeout(() => undefined, 0),
    settled: false,
    stdoutChunks: [],
    stderrChunks: [],
    stdoutBytes: 0,
    stderrBytes: 0,
    fixtureHashes,
    lastMessagePath,
    timedOut: false
  };
  clearTimeout(live.timeout);
  const pid = child.pid;
  const startTime = pid !== undefined ? readProcessStartTime(pid) ?? undefined : undefined;
  const latest = run.attempts.at(-1);
  if (latest && pid !== undefined) {
    latest.pid = pid;
    latest.processStartTime = startTime;
  }
  saveDelegationRun(bridgeDir, run);
  child.stdout?.on("data", (chunk: Buffer) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    live.stdoutBytes += buf.byteLength;
    appendLive(live.stdoutChunks, stdoutTotal, buf);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    live.stderrBytes += buf.byteLength;
    appendLive(live.stderrChunks, stderrTotal, buf);
  });
  const settle = (outcome: { state: DelegationRunState; exitCode: number | null; signal: string | null; timedOut: boolean }, note?: string): void => {
    if (live.settled) return;
    live.settled = true;
    clearTimeout(live.timeout);
    // A cancel or hard-settle may have finalized first; never let a late
    // close rewrite an explicit terminal outcome (e.g. cancelled -> failed).
    const before = loadDelegationRun(bridgeDir, run.runId);
    if (before && before.state !== "running" && before.state !== "queued") return;
    finalizeLiveRun(deps, bridgeDir, run.runId, outcome, note);
  };
  // Bounded non-blocking expiry: SIGTERM the exact owned tree now, SIGKILL
  // still-owned members after a short escalation window, and hard-settle as a
  // truthful timeout even if close never arrives. Close finalizes earlier.
  const HARD_SETTLE_MS = 30_000;
  const onExpiry = (): void => {
    if (live.settled) return;
    live.timedOut = true;
    const rootPid = child.pid;
    if (rootPid !== undefined) {
      signalOwnedTree(rootPid, readProcessStartTime(rootPid) ?? undefined);
      const escalate = setTimeout(() => {
        if (live.settled) return;
        const tree = collectOwnedTree(rootPid, readProcessStartTime(rootPid) ?? undefined);
        if (tree.staleRoot) return;
        for (const pid of tree.members) {
          const baseline = tree.baselines.get(pid);
          if (baseline === undefined || readProcessStartTime(pid) !== baseline) continue;
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }, 2_000);
      if (escalate.unref) escalate.unref();
    }
    const hardSettle = setTimeout(() => {
      if (live.settled) return;
      settle({ state: "timed_out", exitCode: null, signal: null, timedOut: true }, "close not observed within bounded settle window");
    }, HARD_SETTLE_MS);
    if (hardSettle.unref) hardSettle.unref();
  };
  live.timeout = setTimeout(onExpiry, timeoutMs);
  if (live.timeout.unref) live.timeout.unref();
  child.on("error", (error: Error) => {
    run.result = { exitCode: 127, signal: null, timedOut: false, summary: sanitizeSummary(`spawn failed: ${error.message}`) };
    settle({ state: "failed", exitCode: 127, signal: null, timedOut: false });
  });
  child.on("close", (exitCode, signal) => {
    if (live.timedOut) {
      settle({ state: "timed_out", exitCode, signal, timedOut: true });
      return;
    }
    settle({ state: exitCode === 0 ? "completed" : "failed", exitCode, signal, timedOut: false });
  });
  runtime.live.set(run.runId, live);
  return child;
}

function launchCodexCanary(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  profile: string,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, "codex-last-message.md");
  return spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildCodexCanaryArgv(profile, prompt, lastMessagePath), timeoutMs, lastMessagePath, isCanary);
}

function launchOpenCodeCanary(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  model: string,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean,
  sessionId?: string
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, "opencode-last-message.json");
  return spawnCanaryChild(deps, bridgeDir, run, resolveOpenCodeBinary(), buildOpenCodeCanaryArgv(model, prompt, sessionId), timeoutMs, lastMessagePath, isCanary);
}

function launchCodexResume(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  sessionId: string,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, "codex-last-message.md");
  return spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildCodexResumeArgv(sessionId, prompt, lastMessagePath), timeoutMs, lastMessagePath, isCanary);
}

function runSummary(run: DelegationRunRecord): Record<string, unknown> {
  const undelivered = run.pendingEvents.filter((event) =>
    event.deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "failed")).length;
  const failedDeliveries = run.pendingEvents.flatMap((event) =>
    event.deliveries.filter((delivery) => delivery.status === "failed" || delivery.status === "permanent")
      .map((delivery) => ({ eventId: event.eventId, subId: delivery.subId, status: delivery.status, error: delivery.lastError ?? null })));
  return {
    run_id: run.runId,
    delegation_group: run.delegationGroup,
    is_canary: run.isCanary !== false,
    engine: run.engine,
    ...(run.profile ? { profile: run.profile } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.session?.sessionId ? { session_id: run.session.sessionId } : {}),
    state: run.state,
    seq: run.seq,
    attempts: run.attempts.length,
    pending_events: run.pendingEvents.length,
    undelivered_events: undelivered,
    ...(failedDeliveries.length ? { failed_deliveries: failedDeliveries } : {}),
    next_action: run.nextAction,
    updated_at: run.updatedAt
  };
}



function transportSchema(keys: string[]): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const key of keys) shape[key] = z.unknown().optional();
  return z.object(shape).passthrough();
}

function publicSchemaFrom(runtimeSchema: z.ZodObject<any>): z.ZodObject<any> {
  const keys = Object.keys((runtimeSchema as any).shape ?? {});
  const transport = transportSchema(keys);
  const publicSchema = z.object((runtimeSchema as any).shape).strict();
  (publicSchema as any).safeParse = ((args: unknown) => (transport as any).safeParse(args)) as typeof publicSchema.safeParse;
  (publicSchema as any).safeParseAsync = ((args: unknown) => (transport as any).safeParseAsync(args)) as typeof publicSchema.safeParseAsync;
  return publicSchema;
}

const WORKSPACE_ID = z.string().min(1).max(128).describe("Explicit workspace id from open_workspace.");
const RUN_ID = z.string().regex(/^run_[0-9a-f]{16}$/, "run_id must match the delegation run id grammar.");

export function delegationToolDefs(deps: DelegationToolDeps): DelegationToolDef[] {
  const launchArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id. Omit to use the session-selected workspace."),
    engine: z.enum(["codex", "opencode"]).describe("Engine adapter: codex via `codex exec --profile`, opencode via `opencode run --model ... --format json`. Flags are never shared across engines."),
    profile: z.string().max(128).optional().describe("Explicit Codex profile name (required for engine codex; Luna-gated)."),
    model: z.string().max(256).optional().describe("Explicit OpenCode model (required for engine opencode; must equal the host top-level model, never substituted)."),
    session_id: z.string().max(128).optional().describe("Explicit OpenCode session id to continue-or-create via `run --session`. Omit to let the worker mint one (observed best-effort from --format json stdout). First use creates; resumed is claimed only after session list/export verification."),
    task: z.string().max(9000).optional().describe("Real worker input (bounded to 8000 chars after control-strip, validated, never empty). Omit for the legacy read-only canary slice (requires canary=true)."),
    delegation_group: z.string().max(64).optional().describe("Delegation group id (bounded, validated /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/; default hestia-cli-canary). Scopes subscription filters and events."),
    workdir: z.string().min(1).max(1024).describe("Explicit workspace-relative working directory for the disposable canary run."),
    request_id: z.string().min(1).max(128).optional().describe("Idempotency key. Repeating it returns the existing run without spawning a second worker."),
    canary: z.boolean().optional().describe("Must be true when no task is supplied (legacy read-only canary slice). Ignored when task is present."),
    timeout_ms: z.number().int().positive().optional().describe("Explicit bounded attempt timeout in ms. Canary clamps to 5 minutes; real tasks clamp to 30 minutes; 10s minimum. The clamped value is truthfully acked.")
  }).strict();

  const listArgs = z.object({
    workspace_id: WORKSPACE_ID.optional(),
    run_id: RUN_ID.optional().describe("Optional exact run id to inspect instead of listing."),
    include_terminal: z.boolean().optional().describe("Include terminal runs. Default: true.")
  }).strict();

  const readArgs = z.object({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID.optional(),
    include_events: z.boolean().optional().describe("Replay pending/failed events durably. Default: true."),
    ack_event_ids: z.array(z.string().max(128)).max(32).optional().describe("Explicit consumer ack, recorded separately from read. Reading never implies ack.")
  }).strict();

  const followupArgs = z.object({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID.optional(),
    checkpoint: z.object({
      id: z.string().min(1).max(128),
      run_id: RUN_ID,
      seq: z.number().int().min(0),
      payload: z.record(z.any()),
      input_request_id: z.string().min(1).max(128).optional().describe("Reply path: the exact input-request id being answered (applied at most once)."),
      questions: z.array(z.object({
        id: z.string().min(1).max(128),
        question: z.string().min(1).max(2000),
        kind: z.enum(["input", "approval"]).optional().describe("approval-kind questions are data only and never widen the engine gate.")
      }).strict()).max(8).optional().describe("Question path: structured questions that move a settled run to needs-input.")
    }).strict().describe("Durable checkpoint: stable id, owning run id, monotonic seq, bounded payload, plus questions or a request reference.")
  }).strict();

  const cancelArgs = z.object({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID.optional()
  }).strict();

  const eventsSubscribeArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id whose bridge dir owns the subscription. Omit for the session workspace."),
    callback_url: z.string().max(2048).describe("HTTPS webhook callback. Private/local targets and redirects are refused."),
    event_name: z.string().optional().describe("Must be run-attention when set."),
    filter: z.object({
      delegation_group: z.string().optional(),
      run_id: z.string().optional()
    }).passthrough().optional().describe("Narrow delivery: owner plus delegation-group/run id."),
    webhook_secret: z.string().max(256).describe("Standard Webhooks secret starting with whsec_ (24-64 bytes entropy).")
  }).strict();

  const eventsUnsubscribeArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id whose bridge dir owns the subscription. Omit for the session workspace."),
    subscription_id: z.string().min(1).max(128)
  }).strict();

  const defs: DelegationToolDef[] = [
    {
      name: "delegation_launch",
      options: {
        title: "Delegation Launch",
        description: "Launch one durable read-only delegation run (Codex via exec --profile with Luna gate; OpenCode via run --model with host-model gate). Real bounded task + validated delegation_group (default hestia-cli-canary), or the legacy canary slice (fixtures, canary=true). Requires an explicit workdir plus profile (codex) or model (opencode); idempotent request ids never spawn a second worker. Subscribe to events before launching or replay via delegation_read_result so fast completion never loses the result.",
        inputSchema: publicSchemaFrom(launchArgs),
        runtimeInputSchema: launchArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const engine = args.engine as "codex" | "opencode";
        // Real task + delegation group (bounded, validated; default
        // hestia-cli-canary). No hardcoded prompt or group: the worker input
        // is the sanitized task, or the legacy canary prompt when no task is
        // supplied (which still requires canary=true).
        const rawGroup = String(args.delegation_group ?? "").trim();
        const delegationGroup = rawGroup || DELEGATION_GROUP_DEFAULT;
        if (!isDelegationGroupId(delegationGroup)) {
          return failResult(`Invalid delegation_group ${JSON.stringify(rawGroup || delegationGroup)}: must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ within 64 chars.`, { error: "invalid_delegation_group" });
        }
        let taskText = "";
        let isCanary = true;
        if (args.task !== undefined) {
          const rawTask = String(args.task ?? "");
          if (rawTask.length > DELEGATION_BOUNDS.maxTaskChars) {
            return failResult(`task exceeds ${DELEGATION_BOUNDS.maxTaskChars} chars (${rawTask.length}); narrow the task and retry.`, { error: "task_too_large", task_chars: rawTask.length });
          }
          taskText = sanitizeTaskText(rawTask);
          if (!taskText) {
            return failResult("task is empty after control-strip; supply real worker input or omit task with canary=true.", { error: "task_empty" });
          }
          isCanary = false;
        }
        if (isCanary && args.canary !== true) {
          return failResult("Without a task, this leaf supports only the read-only canary slice: pass canary=true or supply task.", { error: "non_canary_rejected" });
        }
        const prompt = isCanary ? canaryPrompt(CANARY_FIXTURES) : taskText;
        let profile = "";
        let model = "";
        let sessionId: string | undefined;
        let gateEvidence: Record<string, unknown> = {};
        if (engine === "codex") {
          profile = String(args.profile ?? "").trim();
          if (!profile) {
            return failResult("An explicit Codex profile is required for Luna delegation.", { error: "profile_required" });
          }
          const gate = verifyLunaProfile(codexHomeDir(), profile);
          if (!gate.allowed) {
            return failResult(`Luna profile gate refused launch: ${gate.reason}`, { error: "luna_gate_refused", configured: gate.configured });
          }
          gateEvidence = {
            model_configured: gate.configured.model,
            reasoning_configured: gate.configured.reasoningEffort,
            sandbox_configured: gate.configured.sandboxMode
          };
        } else {
          model = String(args.model ?? "").trim();
          const discovery = describeOpenCodeDiscovery();
          const gate = verifyOpenCodeModel(model || undefined, discovery.hostModel);
          if (!gate.allowed) {
            const code = !model
              ? "model_required"
              : !gate.hostModel
                ? "opencode_host_model_unknown"
                : "opencode_model_mismatch";
            return failResult(`OpenCode model gate refused launch: ${gate.reason}`, {
              error: code,
              host_model: gate.hostModel ?? null,
              requested_model: gate.requested ?? null
            });
          }
          model = gate.requested as string;
          const rawSession = String(args.session_id ?? "").trim();
          if (rawSession) {
            if (!isEngineSessionId(rawSession)) {
              return failResult("session_id must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.", { error: "invalid_session_id" });
            }
            const holders = activeSessionHolders(listDelegationRuns(bridgeDir), rawSession);
            if (holders.length > 0) {
              return failResult(`Session ${rawSession} already has an active turn (${holders[0].runId}); one active turn per session.`, {
                error: "session_busy",
                session_id: rawSession,
                holder_run_id: holders[0].runId
              });
            }
            sessionId = rawSession;
          }
          gateEvidence = { model_verified: model, host_model: gate.hostModel };
        }
        const requestId = String(args.request_id ?? "").trim() ||
          `req_${createHash("sha256").update(`${Date.now()}:${process.pid}:${Math.random()}`).digest("hex").slice(0, 16)}`;
        const existing = findRunByRequestId(bridgeDir, requestId);
        if (existing) {
          if (!ownerAllowed(deps, existing)) return denyAccess();
          // Same request id with different worker-input content is a
          // conflicting re-use, not a replay: refuse without spawning a
          // second worker and without consuming anything.
          if (isLaunchRequestConflict(existing, {
            engine,
            delegationGroup,
            isCanary,
            ...(isCanary ? {} : { task: taskText }),
            ...(engine === "codex" ? { profile } : { model, ...(sessionId ? { sessionId } : {}) })
          })) {
            return failResult(`Conflicting re-use of request ${requestId}: it already owns run ${existing.runId} with different task/group/model content. Relaunch only with a NEW request id. No second worker spawned.`, {
              error: "duplicate_conflicting",
              run_id: existing.runId,
              request_id: requestId,
              stored: false,
              executed: false
            });
          }
          return okResult(`Idempotent replay: request ${requestId} already owns run ${existing.runId} (state ${existing.state}). No second worker spawned.`, {
            run_id: existing.runId, request_id: requestId, state: existing.state, idempotent_replay: true, next_action: existing.nextAction
          });
        }
        if (activeRuns(bridgeDir).length >= DELEGATION_BOUNDS.maxActiveRunsPerWorkspace) {
          return failResult(`Concurrency bound reached (${DELEGATION_BOUNDS.maxActiveRunsPerWorkspace} active runs). Wait for a run-attention event first.`, { error: "concurrency_bound" });
        }
        let resolved: { absPath: string; relPath: string };
        try {
          resolved = deps.guard.resolve(workspace, String(args.workdir), { forWrite: true });
        } catch (error) {
          return failResult(`Workdir rejected: ${error instanceof Error ? error.message : String(error)}`, { error: "workdir_rejected" });
        }
        const timeoutMs = isCanary ? clampCanaryTimeout(args.timeout_ms) : clampRealTaskTimeout(args.timeout_ms);
        const runId = newRunId();
        const owner = ownerIdFor(deps.config.authToken, localOwnerId(deps.config));
        const now = new Date().toISOString();
        fs.mkdirSync(resolved.absPath, { recursive: true, mode: 0o700 });
        // Canary runs stage the read-only fixtures; real tasks stage nothing.
        if (isCanary) {
          for (const name of CANARY_FIXTURES) {
            const source = path.join(fixtureSourceDir(), name);
            try {
              fs.copyFileSync(source, path.join(resolved.absPath, name));
            } catch (error) {
              return failResult(`Canary fixture unavailable: ${name} (${error instanceof Error ? error.message : String(error)})`, { error: "canary_input_missing" });
            }
          }
        }
        const session: DelegationSessionBinding = engine === "codex"
          ? {
            engine: "codex",
            resumable: false,
            observed: false,
            evidence: "codex ephemeral run persists no session; follow-up is a new attempt by construction",
            reason: "codex ephemeral run persists no session; follow-up starts a labeled new-continuation-attempt"
          }
          : sessionId
            ? {
              engine: "opencode",
              sessionId,
              resumable: false,
              observed: false,
              evidence: "explicit --session id only: creation-or-resume unverified at launch; verified at continuation time via session list/export before any resumed label",
              reason: "explicit --session id: continues when known, otherwise creates (installed CLI semantics); first use may be creation"
            }
            : {
              engine: "opencode",
              resumable: false,
              observed: false,
              evidence: "no explicit --session id; the worker mints the session, observed best-effort from --format json stdout",
              reason: "no explicit --session id; the worker mints the session, observed best-effort from --format json stdout"
            };
        const attemptSummary = engine === "codex"
          ? isCanary
            ? `canary attempt started via codex exec --profile ${profile}`
            : `real-task attempt started via codex exec --profile ${profile} (${taskText.length} chars, group ${delegationGroup})`
          : isCanary
            ? `canary attempt started via opencode run --model ${model}`
            : `real-task attempt started via opencode run --model ${model} (${taskText.length} chars, group ${delegationGroup})`;
        let run: DelegationRunRecord = {
          version: 1,
          runId,
          requestId,
          delegationGroup,
          engine,
          ...(engine === "codex" ? { profile } : { model }),
          ...(isCanary ? { isCanary: true } : { isCanary: false, task: taskText }),
          session,
          attemptTimeoutMs: timeoutMs,
          workspaceId: workspace.id,
          workspaceCanonical: workspace.root,
          workdir: resolved.absPath,
          ownerIdHash: owner.ownerIdHash,
          ownerKind: owner.ownerKind,
          state: "running",
          seq: 0,
          attempts: [{
            n: 1,
            startedAt: now,
            state: "running",
            summary: sanitizeSummary(attemptSummary)
          }],
          pendingEvents: [],
          checkpoints: [],
          appliedCheckpointIds: [],
          lastAppliedCheckpointSeq: -1,
          inputRequests: [],
          nextAction: "poll delegation_read_result or await the run-attention event",
          createdAt: now,
          updatedAt: now
        };
        saveDelegationRun(bridgeDir, run);
        try {
          if (engine === "codex") {
            launchCodexCanary(deps, bridgeDir, run, profile, timeoutMs, prompt, isCanary);
          } else {
            launchOpenCodeCanary(deps, bridgeDir, run, model, timeoutMs, prompt, isCanary, sessionId);
          }
        } catch (error) {
          run = loadDelegationRun(bridgeDir, runId) ?? run;
          run.state = "failed";
          const latest = run.attempts.at(-1);
          if (latest) {
            latest.state = "failed";
            latest.finishedAt = new Date().toISOString();
            latest.summary = sanitizeSummary(`launch failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          run.result = { exitCode: 127, signal: null, timedOut: false, summary: sanitizeSummary(error instanceof Error ? error.message : String(error)) };
          enqueueTerminalEvent(run, loadSubscriptions(bridgeDir));
          saveDelegationRun(bridgeDir, run);
          return failResult(`Launch failed: ${error instanceof Error ? error.message : String(error)}`, { error: "launch_failed", run_id: runId });
        }
        return okResult(
          engine === "codex"
            ? `${isCanary ? "Canary" : "Real-task"} run ${runId} launched (codex --profile ${profile}, Luna verified, group ${delegationGroup}, timeout ${timeoutMs} ms). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`
            : `${isCanary ? "Canary" : "Real-task"} run ${runId} launched (opencode run --model ${model} --format json, host-model verified, group ${delegationGroup}, timeout ${timeoutMs} ms${sessionId ? `, session ${sessionId}` : ""}). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`,
          {
            run_id: runId,
            request_id: requestId,
            delegation_group: delegationGroup,
            is_canary: isCanary,
            ...(isCanary ? {} : { task_chars: taskText.length }),
            engine,
            ...(engine === "codex" ? { profile } : { model }),
            ...(sessionId ? { session_id: sessionId } : {}),
            ...gateEvidence,
            workdir: resolved.absPath,
            timeout_ms: timeoutMs,
            state: "running",
            next_action: "subscribe to events_subscribe before completion, or replay via delegation_read_result"
          }
        );
      }
    },
    {
      name: "delegation_list",
      options: {
        title: "Delegation List",
        description: "Inspect delegation runs for this workspace (owner-scoped; knowing a group or run id grants no access). Restarts reconcile honestly to interrupted vs completed-awaiting-delivery without auto-restarting.",
        inputSchema: publicSchemaFrom(listArgs),
        runtimeInputSchema: listArgs,
        annotations: READ_ONLY
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        if (args.run_id) {
          const run = loadDelegationRun(bridgeDir, args.run_id);
          if (!run || !ownerAllowed(deps, run)) return denyAccess();
          const reconciled = reconcileRunState(run, isProcessIdentityAlive);
          if (reconciled.changed) saveDelegationRun(bridgeDir, reconciled.run);
          return okResult(`Run ${run.runId}: ${reconciled.run.state}.`, { ...runSummary(reconciled.run), classification: reconciled.classification });
        }
        const includeTerminal = args.include_terminal !== false;
        const runs = listDelegationRuns(bridgeDir).filter((run) => ownerAllowed(deps, run))
          .filter((run) => includeTerminal || (run.state === "running" || run.state === "queued" || run.state === "needs-input"));
        for (const run of runs) {
          const reconciled = reconcileRunState(run, isProcessIdentityAlive);
          if (reconciled.changed) {
            Object.assign(run, reconciled.run);
            saveDelegationRun(bridgeDir, reconciled.run);
          }
        }
        await pumpSweep(deps, bridgeDir).catch(() => undefined);
        return okResult(`# Delegation runs (${runs.length} visible to this owner)\n\n${runs.map((run) => `- ${run.runId} ${run.engine}${run.profile ? `:${run.profile}` : ""} ${run.state} seq=${run.seq}`).join("\n") || "- none"}`, {
          delegation_groups: [...new Set(runs.map((run) => run.delegationGroup))],
          runs: runs.map(runSummary)
        });
      }
    },
    {
      name: "delegation_read_result",
      options: {
        title: "Delegation Read Result",
        description: "Authorized read of one run: terminal excerpts, fixture integrity, delivery status, and durable replay of pending/failed events. Reading never implies acknowledgement; ack_event_ids records explicit consumer ack separately.",
        inputSchema: publicSchemaFrom(readArgs),
        runtimeInputSchema: readArgs,
        annotations: READ_ONLY
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const run = loadDelegationRun(bridgeDir, args.run_id);
        if (!run || !ownerAllowed(deps, run)) return denyAccess();
        const reconciled = reconcileRunState(run, isProcessIdentityAlive);
        let current = reconciled.run;
        if (reconciled.changed) saveDelegationRun(bridgeDir, current);
        current = await pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, current.runId) ?? current);
        const acked: string[] = [];
        if (Array.isArray(args.ack_event_ids) && args.ack_event_ids.length > 0) {
          for (const id of args.ack_event_ids.slice(0, 32)) {
            const event = current.pendingEvents.find((candidate) => candidate.eventId === String(id));
            if (event && !event.acked) {
              event.acked = true;
              acked.push(event.eventId);
            }
          }
          if (acked.length > 0) saveDelegationRun(bridgeDir, current);
        }
        const includeEvents = args.include_events !== false;
        const undelivered = current.pendingEvents.filter((event) =>
          event.deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "failed"));
        const failedDeliveries = current.pendingEvents.flatMap((event) =>
          event.deliveries.filter((delivery) => delivery.status === "failed" || delivery.status === "permanent")
            .map((delivery) => ({ event_id: event.eventId, sub_id: delivery.subId, status: delivery.status, attempts: delivery.attempts, error: delivery.lastError ?? null, next_retry_at: delivery.nextRetryAt ?? null })));
        return okResult(
          `# Run ${current.runId}: ${current.state}\n\n${current.result?.summary ?? current.nextAction}`,
          {
            run_id: current.runId,
            delegation_group: current.delegationGroup,
            is_canary: current.isCanary !== false,
            ...(current.task ? { task: current.task } : {}),
            engine: current.engine,
            ...(current.profile ? { profile: current.profile } : {}),
            state: current.state,
            classification: reconciled.classification,
            seq: current.seq,
            attempts: current.attempts.map((attempt) => ({
              n: attempt.n, state: attempt.state, exit_code: attempt.exitCode ?? null,
              signal: attempt.signal ?? null, timed_out: attempt.timedOut ?? false,
              started_at: attempt.startedAt, finished_at: attempt.finishedAt ?? null,
              summary: attempt.summary ?? null
            })),
            result: current.result ?? null,
            input_requests: runInputRequests(current).map((request) => ({
              request_id: request.id,
              seq: request.seq,
              version: request.version,
              status: request.status,
              questions: request.questions,
              ...(request.answerCheckpointId ? { answer_checkpoint_id: request.answerCheckpointId } : {})
            })),
            open_input_requests: openInputRequests(current).length,
            ...(current.session ? { session: current.session } : {}),
            resume_capability: current.engine === "codex" ? CODEX_RESUME_CAPABILITY : OPENCODE_RESUME_CAPABILITY,
            ...(includeEvents ? {
              pending_events: current.pendingEvents.map((event) => ({
                event_id: event.eventId, seq: event.seq, state: event.state,
                summary: event.summary ?? null, acked: event.acked ?? false,
                deliveries: event.deliveries
              })),
              undelivered_count: undelivered.length
            } : {}),
            ...(failedDeliveries.length ? { failed_deliveries: failedDeliveries } : {}),
            ...(acked.length ? { acked_event_ids: acked } : {}),
            next_action: current.nextAction
          }
        );
      }
    },
    {
      name: "delegation_followup",
      options: {
        title: "Delegation Follow-up",
        description: "Durable follow-up Q&A: a checkpoint with questions moves a settled run to needs-input (structured, stored with run id + seq); a checkpoint with input_request_id answers the exact request at most once and launches one bounded continuation (opencode --session true resume; ephemeral Codex a labeled new attempt). Rejects wrong-run, stale, conflicting-duplicate, unknown/closed/expired requests, and live-attempt races with typed errors. Approval-kind answers never widen the engine gate.",
        inputSchema: publicSchemaFrom(followupArgs),
        runtimeInputSchema: followupArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const loaded = loadDelegationRun(bridgeDir, args.run_id);
        if (!loaded || !ownerAllowed(deps, loaded)) return denyAccess();
        const reconciled = reconcileRunState(loaded, isProcessIdentityAlive);
        let run = reconciled.run;
        if (reconciled.changed) saveDelegationRun(bridgeDir, run);
        const raw = (args.checkpoint ?? {}) as Record<string, unknown>;
        const checkpoint: CheckpointShape = {
          id: String(raw.id ?? ""),
          run_id: String(raw.run_id ?? ""),
          seq: Number(raw.seq),
          payload: (raw.payload ?? {}) as Record<string, unknown>,
          ...(typeof raw.input_request_id === "string" ? { input_request_id: raw.input_request_id } : {}),
          ...(raw.questions !== undefined ? { questions: raw.questions } : {})
        };
        const verdict = validateCheckpointForRun(run, checkpoint);
        if (!verdict.ok) {
          return failResult(verdict.message as string, { error: verdict.code, run_id: run.runId });
        }
        if (verdict.duplicate) {
          return okResult(`Duplicate checkpoint ${checkpoint.id}: already stored; at-most-once holds, nothing re-executed.`, {
            run_id: run.runId, checkpoint_id: checkpoint.id, duplicate: true, executed: false
          });
        }
        // Reply path: answer the exact referenced request at most once.
        // Refusals (attempt budget, engine gate, session busy) NEVER consume
        // the reply: no answered mark, no attempt, seq unchanged. The request
        // stays open so the identical checkpoint can be retried after the
        // cause clears. Crash-safe dispatch (defect 5): the answer is staged
        // as pending-dispatch BEFORE spawn (request stays open, no applied
        // mark); only a successful spawn confirms it (answered + running).
        // On spawn failure the pending record stays and the identical
        // checkpoint id remains retryable with the same attempt number.
        // No consumed reply without a dispatched attempt.
        if (verdict.request) {
          const request = verdict.request;
          const existingPending = run.pendingDispatch && run.pendingDispatch.checkpointId === checkpoint.id && run.pendingDispatch.requestId === request.id
            ? run.pendingDispatch
            : undefined;
          if (!existingPending && run.attempts.length >= DELEGATION_BOUNDS.maxAttemptsPerRun) {
            return failResult(
              `Answer not applied: no attempt budget remains (max ${DELEGATION_BOUNDS.maxAttemptsPerRun}); relaunch only with a NEW request id. Request ${request.id} stays open and the reply was not consumed (no answered mark, no attempt, seq unchanged).`,
              { error: "attempts_exhausted", run_id: run.runId, checkpoint_id: checkpoint.id, input_request_id: request.id, stored: false, executed: false }
            );
          }
          // Re-verify the engine gate at continuation time BEFORE applying:
          // config may have drifted since launch.
          if (run.engine === "codex") {
            const gate = verifyLunaProfile(codexHomeDir(), run.profile ?? "");
            if (!gate.allowed) {
              return failResult(`Answer not applied: the Luna profile gate refused continuation: ${gate.reason}. Request ${request.id} stays open and the reply was not consumed.`, {
                error: "luna_gate_refused",
                run_id: run.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: false,
                executed: false,
                configured: gate.configured
              });
            }
          } else {
            const gate = verifyOpenCodeModel(run.model, describeOpenCodeDiscovery().hostModel);
            if (!gate.allowed) {
              return failResult(`Answer not applied: the OpenCode model gate refused continuation: ${gate.reason}. Request ${request.id} stays open and the reply was not consumed.`, {
                error: "opencode_model_mismatch",
                run_id: run.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: false,
                executed: false,
                host_model: gate.hostModel ?? null
              });
            }
            const sid = run.session?.sessionId;
            if (sid && isEngineSessionId(sid)) {
              const holders = activeSessionHolders(listDelegationRuns(bridgeDir), sid, run.runId);
              if (holders.length > 0) {
                return failResult(`Answer not applied: session ${sid} has an active turn (${holders[0].runId}); one active turn per session, retry after it settles. Request ${request.id} stays open and the reply was not consumed.`, {
                  error: "session_busy",
                  run_id: run.runId,
                  checkpoint_id: checkpoint.id,
                  input_request_id: request.id,
                  stored: false,
                  executed: false,
                  session_id: sid,
                  holder_run_id: holders[0].runId
                });
              }
            }
          }
          const approvalNote = request.questions.some((question) => question.kind === "approval")
            ? " Approval-kind answers are data only and never widen sandbox, profile, or model."
            : "";
          // Pre-check reply validity BEFORE staging/spawn (no worker for
          // closed/invalid replies): mirrors applyCheckpointReply guards
          // without consuming.
          {
            const storedReq = runInputRequests(run).find((c) => c.id === request.id);
            if (!storedReq) {
              return failResult(`No input request ${request.id} for run ${run.runId}.`, { error: "unknown_input_request", run_id: run.runId });
            }
            if (run.state !== "needs-input") {
              return failResult(`Run ${run.runId} is ${run.state}: replies require needs-input with an open request.`, { error: "reply_without_open_request", run_id: run.runId });
            }
            if (storedReq.status === "expired") {
              return failResult(`Input request ${request.id} expired; ask a fresh question.`, { error: "input_request_expired", run_id: run.runId });
            }
            if (storedReq.status === "answered") {
              if (storedReq.answerCheckpointId === checkpoint.id) {
                return okResult(`Duplicate answer ${checkpoint.id} for request ${request.id}: already applied at-most-once, nothing re-executed.`, {
                  run_id: run.runId, checkpoint_id: checkpoint.id, input_request_id: request.id, duplicate: true, executed: false
                });
              }
              return failResult(`Input request ${request.id} already answered by ${storedReq.answerCheckpointId}; conflicting re-answer refused.`, { error: "input_request_closed", run_id: run.runId });
            }
          }
          const runIsCanary = run.isCanary !== false;
          const timeoutMs = runIsCanary ? clampCanaryTimeout(run.attemptTimeoutMs) : clampRealTaskTimeout(run.attemptTimeoutMs);
          let continuationLabel: "resumed" | "new-continuation-attempt" = "new-continuation-attempt";
          let resumeSessionId: string | undefined;
          let spawnNote: string;
          let sessionEvidence = "no session identity recorded: follow-up runs a new attempt, never a resumed session";
          if (run.engine === "codex") {
            // Codex runs are ephemeral: they persist no session, so there is
            // no session evidence to verify. Fail closed to a new attempt by
            // construction, even if a stale record names a session.
            spawnNote = "codex ephemeral run persists no session: follow-up runs a new attempt, never a resumed session";
            sessionEvidence = "codex ephemeral run persists no session; resumed requires observed + verified session evidence, which cannot exist here";
          } else {
            const sid = run.session?.sessionId;
            if (sid && isEngineSessionId(sid)) {
              // Verified resume only: the id must have been observed AND be
              // confirmed live by session list/export. First use of an
              // explicit id creates (installed continue-or-create semantics).
              const probe = verifyOpenCodeSession(sid, run.workdir);
              if (probe.verified) {
                continuationLabel = "resumed";
                resumeSessionId = sid;
                spawnNote = `opencode session ${sid} verified live (${probe.evidence}) and continued via run --session (true resume)`;
                sessionEvidence = probe.evidence;
              } else {
                spawnNote = `opencode session ${sid} unverified (${probe.evidence}): follow-up runs a new attempt (first-use creation), never a resumed session`;
                sessionEvidence = probe.evidence;
              }
            } else {
              spawnNote = "no opencode session id recorded: follow-up runs a new attempt, never a resumed session";
            }
          }
          const n = existingPending ? existingPending.attemptN : run.attempts.length + 1;
          // Dispatch recovery: reconcile the persisted PID+starttime identity
          // via isProcessIdentityAlive BEFORE any retry, including
          // needs-input. A staged dispatch may have spawned its worker before
          // a crash without confirming (persisted pid on the queued pending
          // attempt). A live staged worker is confirmed without spawning a
          // second worker; only a dead/absent worker respawns (same attemptN).
          let stagedAlivePid: number | undefined;
          if (existingPending) {
            const persistedLatest = run.attempts.at(-1);
            if (persistedLatest?.pid !== undefined && persistedLatest.processStartTime !== undefined &&
              isProcessIdentityAlive(persistedLatest.pid, persistedLatest.processStartTime)) {
              stagedAlivePid = persistedLatest.pid;
            }
          }
          const alreadyDispatched = existingPending !== undefined && stagedAlivePid !== undefined;
          // The worker input IS the follow-up: base task plus the actual
          // answer payload, forwarded into the worker prompt/argv (reserved).
          const followupPrompt = existingPending && existingPending.prompt
            ? existingPending.prompt
            : buildFollowupPrompt({
              baseTask: run.task,
              isCanary: runIsCanary,
              requestId: request.id,
              questions: request.questions,
              answerPayload: checkpoint.payload,
              attemptN: n
            });
          // Crash-safe: stage pending-dispatch BEFORE spawn (request stays
          // open, no applied mark). Only a successful spawn confirms it.
          // A retry of the identical staged reply reuses the persisted
          // pending (same attempt number); a live staged worker skips
          // staging and spawning entirely and goes straight to confirm.
          if (!alreadyDispatched) {
            run = stagePendingDispatch(run, {
              checkpoint,
              requestId: request.id,
              attemptN: n,
              continuation: existingPending?.continuation ?? continuationLabel,
              ...(existingPending?.resumeSessionId ?? resumeSessionId ? { resumeSessionId: (existingPending?.resumeSessionId ?? resumeSessionId) as string } : {}),
              timeoutMs: existingPending?.timeoutMs ?? timeoutMs,
              prompt: followupPrompt,
              sessionEvidence: existingPending?.sessionEvidence ?? sessionEvidence
            });
          }
          // Re-resolve effective values from the staged pending (retry reuses).
          const staged = run.pendingDispatch!;
          continuationLabel = staged.continuation;
          resumeSessionId = staged.resumeSessionId;
          sessionEvidence = staged.sessionEvidence;
          spawnNote = run.engine === "codex"
            ? "codex ephemeral run persists no session: follow-up runs a new attempt, never a resumed session"
            : resumeSessionId && continuationLabel === "resumed"
              ? `opencode session ${resumeSessionId} verified live (${sessionEvidence}) and continued via run --session (true resume)`
              : (run.session?.sessionId
                ? `opencode session ${run.session.sessionId} unverified (${sessionEvidence}): follow-up runs a new attempt (first-use creation), never a resumed session`
                : "no opencode session id recorded: follow-up runs a new attempt, never a resumed session");
          if (alreadyDispatched) {
            spawnNote = `staged continuation worker still alive (pid ${stagedAlivePid}); confirmed without spawning a second worker; ${spawnNote}`;
          } else {
            saveDelegationRun(bridgeDir, run);
          }
          // Dispatch: spawn the continuation. A sync throw leaves the pending
          // record (retryable with the same reply ID, same attempt number).
          // The spawn acknowledgement is then awaited BEFORE confirming: an
          // async spawn error also leaves pending retryable, never consumed.
          if (!alreadyDispatched) {
            let child: ChildProcess;
            try {
              if (run.engine === "codex" && continuationLabel === "resumed" && resumeSessionId) {
                child = launchCodexResume(deps, bridgeDir, run, resumeSessionId, staged.timeoutMs, staged.prompt, runIsCanary);
              } else if (run.engine === "codex") {
                child = launchCodexCanary(deps, bridgeDir, run, run.profile ?? "", staged.timeoutMs, staged.prompt, runIsCanary);
              } else {
                child = launchOpenCodeCanary(deps, bridgeDir, run, run.model ?? "", staged.timeoutMs, staged.prompt, runIsCanary, resumeSessionId);
              }
            } catch (error) {
              // Pending stays: not consumed, retryable with the same reply ID.
              // Reload to preserve the exact persisted pending (spawn may have
              // partially mutated the in-memory run before throwing).
              const pending = loadDelegationRun(bridgeDir, run.runId) ?? run;
              return failResult(`Continuation dispatch failed before attempt start; answer staged as pending-dispatch (not consumed, retryable with the same reply ID): ${error instanceof Error ? error.message : String(error)}`, {
                error: "dispatch_pending",
                run_id: pending.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: false,
                executed: false,
                pending_dispatch: true,
                attempt_n: staged.attemptN
              });
            }
            try {
              await waitForSpawn(child);
            } catch (error) {
              // Async spawn failure (e.g. missing binary): the staged pending
              // is untouched (pre-confirm error/close never finalizes while
              // pending), so the identical reply id stays retryable with the
              // same attempt number. Drop the dead live handle only.
              if (processRuntime().live.get(run.runId)?.child === child) {
                processRuntime().live.delete(run.runId);
              }
              const pending = loadDelegationRun(bridgeDir, run.runId) ?? run;
              return failResult(`Continuation dispatch failed before attempt start; answer staged as pending-dispatch (not consumed, retryable with the same reply ID): ${error instanceof Error ? error.message : String(error)}`, {
                error: "dispatch_pending",
                run_id: pending.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: false,
                executed: false,
                pending_dispatch: true,
                attempt_n: staged.attemptN
              });
            }
          }
          // Spawn succeeded (or the staged worker was already alive):
          // confirm the staged answer (answered mark + applied checkpoint)
          // and promote the queued pending attempt to running. No consumed
          // reply without a dispatched attempt. The promotion preserves the
          // spawn-captured pid/startTime.
          let confirmed = loadDelegationRun(bridgeDir, run.runId) ?? run;
          let applied;
          try {
            applied = applyCheckpointReply(confirmed, checkpoint, request);
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code ?? "reply_rejected")
              : "reply_rejected";
            // Apply failure means the reply itself is invalid; drop the
            // pending reservation so a fresh valid reply can be staged.
            const withoutPending = clearPendingDispatch(loadDelegationRun(bridgeDir, run.runId) ?? run);
            saveDelegationRun(bridgeDir, withoutPending);
            return failResult(error instanceof Error ? error.message : String(error), { error: code, run_id: run.runId });
          }
          if (applied.run === confirmed) {
            return okResult(`Duplicate answer ${checkpoint.id} for request ${request.id}: already applied at-most-once, nothing re-executed.`, {
              run_id: confirmed.runId, checkpoint_id: checkpoint.id, input_request_id: request.id, duplicate: true, executed: false
            });
          }
          if (applied.attemptsExhausted) {
            const withoutPending = clearPendingDispatch(applied.run);
            saveDelegationRun(bridgeDir, withoutPending);
            return failResult(
              `Answer not applied: no attempt budget remains (max ${DELEGATION_BOUNDS.maxAttemptsPerRun}); relaunch only with a NEW request id.`,
              { error: "attempts_exhausted", run_id: confirmed.runId, checkpoint_id: checkpoint.id, input_request_id: request.id, stored: false, executed: false }
            );
          }
          run = applied.run;
          // Promote the queued pending attempt (n) to running with dispatch identity.
          // Preserve the spawn-captured pid/startTime (set by spawnCanaryChild
          // before confirm); never drop process identity.
          const startedAt = new Date().toISOString();
          run.attempts = run.attempts.map((a) => a.n === staged.attemptN && a.state === "queued"
            ? {
              ...a,
              n: staged.attemptN,
              startedAt: a.startedAt ?? startedAt,
              state: "running" as DelegationRunState,
              ...(staged.resumeSessionId ? { sessionId: staged.resumeSessionId } : (a as { sessionId?: string }).sessionId ? { sessionId: (a as { sessionId?: string }).sessionId as string } : {}),
              continuation: staged.continuation,
              summary: sanitizeSummary(`follow-up continuation (${staged.continuation}) for request ${request.id}`)
            }
            : a);
          // If the pending attempt was somehow absent (e.g., pruned), append it as running.
          if (!run.attempts.some((a) => a.n === staged.attemptN)) {
            run.attempts = [...run.attempts, {
              n: staged.attemptN,
              startedAt,
              state: "running" as DelegationRunState,
              ...(staged.resumeSessionId ? { sessionId: staged.resumeSessionId } : {}),
              continuation: staged.continuation,
              summary: sanitizeSummary(`follow-up continuation (${staged.continuation}) for request ${request.id}`)
            }].slice(-DELEGATION_BOUNDS.maxAttemptsPerRun);
          }
          run.state = "running";
          run.session = {
            engine: run.engine,
            ...(staged.resumeSessionId ?? run.session?.sessionId ? { sessionId: (staged.resumeSessionId ?? run.session?.sessionId) as string } : {}),
            resumable: staged.continuation === "resumed",
            observed: confirmed.session?.observed ?? false,
            evidence: staged.sessionEvidence,
            continuation: staged.continuation,
            reason: spawnNote
          };
          run.nextAction = "poll delegation_read_result or await the run-attention event";
          // Clear the pending reservation only after successful dispatch + apply.
          {
            const { pendingDispatch: _dropped, ...rest } = run;
            run = rest as DelegationRunRecord;
          }
          saveDelegationRun(bridgeDir, run);
          return okResult(
            `Answer ${checkpoint.id} for request ${request.id} applied at-most-once; continuation attempt ${staged.attemptN} ${alreadyDispatched ? "confirmed (staged worker was already alive, no second spawn)" : "launched"} (${staged.continuation}: ${spawnNote}).${approvalNote}`,
            {
              run_id: run.runId,
              checkpoint_id: checkpoint.id,
              input_request_id: request.id,
              stored: true,
              executed: true,
              attempt_n: staged.attemptN,
              continuation: staged.continuation,
              session_evidence: staged.sessionEvidence,
              ...(staged.resumeSessionId ? { session_id: staged.resumeSessionId } : {}),
              timeout_ms: staged.timeoutMs,
              state: "running",
              next_action: "poll delegation_read_result or await the run-attention event"
            }
          );
        }
        // Question path: register the structured request, move to needs-input.
        let registered;
        try {
          registered = registerInputRequest(run, checkpoint, verdict.questions ?? []);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code ?? "question_rejected")
            : "question_rejected";
          return failResult(error instanceof Error ? error.message : String(error), { error: code, run_id: run.runId });
        }
        run = registered.run;
        const subs = loadSubscriptions(bridgeDir);
        const event = run.pendingEvents.at(-1);
        if (event) {
          event.deliveries = subs
            .filter((sub) => subscriptionMatches(sub, { delegationGroup: run.delegationGroup, runId: run.runId }))
            .map((sub) => ({ subId: sub.subId, status: "pending" as const, attempts: 0 }));
        }
        // Atomic: needs-input state + wake-up event persist in one write.
        saveDelegationRun(bridgeDir, run);
        void pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, run.runId) ?? run).catch(() => undefined);
        return okResult(`Question ${checkpoint.id} stored durably for run ${run.runId}: needs-input with request ${registered.request.id} (seq ${registered.request.seq}).`, {
          run_id: run.runId,
          checkpoint_id: checkpoint.id,
          input_request_id: registered.request.id,
          stored: true,
          executed: false,
          state: "needs-input",
          next_action: "answer via delegation_followup with the matching input-request id"
        });
      }
    },
    {
      name: "delegation_cancel",
      options: {
        title: "Delegation Cancel",
        description: "Idempotent cancel of one run: signals only the exact PID+starttime-verified owned tree. The ack never claims cleanup finished while descendants remain.",
        inputSchema: publicSchemaFrom(cancelArgs),
        runtimeInputSchema: cancelArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const run = loadDelegationRun(bridgeDir, args.run_id);
        if (!run || !ownerAllowed(deps, run)) return denyAccess();
        const reconciled = reconcileRunState(run, isProcessIdentityAlive);
        let current = reconciled.run;
        if (current.state === "completed" || current.state === "failed" || current.state === "cancelled" ||
          current.state === "timed_out" || current.state === "interrupted") {
          if (reconciled.changed) saveDelegationRun(bridgeDir, current);
          return okResult(`Run ${current.runId} is already ${current.state}; cancel is idempotent.`, {
            run_id: current.runId, state: current.state, already_terminal: true, cleanup_finished: true
          });
        }
        const latest = current.attempts.at(-1);
        let tree = { signalled: [] as number[], remaining: [] as number[], cleanupFinished: true, staleRoot: true };
        if (latest?.pid !== undefined) {
          tree = await cancelOwnedTree(latest.pid, latest.processStartTime, 2_000);
        }
        processRuntime().live.delete(current.runId);
        const now = new Date().toISOString();
        if (latest) {
          latest.finishedAt = now;
          latest.state = "cancelled";
          latest.summary = sanitizeSummary(tree.cleanupFinished ? "cancelled by owner; owned tree reaped" : "cancelled by owner; owned descendants remain");
        }
        current.state = "cancelled";
        current.result = { exitCode: null, signal: null, timedOut: false, summary: sanitizeSummary("cancelled by owner") };
        enqueueTerminalEvent(current, loadSubscriptions(bridgeDir));
        saveDelegationRun(bridgeDir, current);
        await pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, current.runId) ?? current).catch(() => undefined);
        return okResult(
          tree.cleanupFinished
            ? `Run ${current.runId} cancelled; owned tree reaped.`
            : `Run ${current.runId} cancelled; cleanup INCOMPLETE: ${tree.remaining.length} owned descendant(s) remain (${tree.remaining.join(",")}).`,
          {
            run_id: current.runId, state: "cancelled", cancelled: true,
            cleanup_finished: tree.cleanupFinished,
            remaining_pids: tree.remaining,
            signalled_pids: tree.signalled
          }
        );
      }
    },
    {
      name: "events_list",
      options: {
        title: "Events List",
        description: "List the narrow MCP Events surface: exactly one run-attention event (completed/failed/interrupted/timed_out/cancelled/needs-input) with owner plus delegation-group/run id filters and webhook-only delivery. Official events/list handler; compat tools wrap it.",
        inputSchema: publicSchemaFrom(z.object({}).strict()),
        runtimeInputSchema: z.object({}).strict(),
        annotations: READ_ONLY
      },
      handler: async () => {
        const listed = handleEventsList();
        return okResult("# Events\n\n- run-attention: delegation wake-up with run id, state, seq/version, and a sanitized summary only.", {
          capability: eventsCapability(),
          discover: handleServerDiscover(),
          ...listed
        });
      }
    },
    {
      name: "events_subscribe",
      options: {
        title: "Events Subscribe",
        description: "Subscribe a webhook to the run-attention event (official events/subscribe). Validates a whsec_ secret, HTTPS callback, and private/local blocks; verifies the callback with a signed verification challenge (msg_verification_* webhook-id, Standard Webhooks, X-MCP-Subscription-Id binding). Deterministic subscription ids make repeat calls idempotent. Challenge failure is error -32015 with data.reason. Verification + storage are always allowed; only app-event POSTs are gated by CODEXPRO_EVENTS_DELIVERY_ENABLED.",
        inputSchema: publicSchemaFrom(eventsSubscribeArgs),
        runtimeInputSchema: eventsSubscribeArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const owner = ownerIdFor(deps.config.authToken, localOwnerId(deps.config));
        // Compat wrapper -> official params (verification + storage always
        // allowed; split flags gate only app-event pump, never subscribe).
        const officialParams = {
          name: args.event_name ?? RUN_ATTENTION_EVENT,
          arguments: (() => {
            const f = (args.filter ?? {}) as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            if (f.delegation_group !== undefined) out.delegationGroup = f.delegation_group;
            if (f.delegationGroup !== undefined) out.delegationGroup = f.delegationGroup;
            if (f.run_id !== undefined) out.runId = f.run_id;
            if (f.runId !== undefined) out.runId = f.runId;
            return out;
          })(),
          delivery: { mode: "webhook", url: args.callback_url, secret: args.webhook_secret }
        };
        // Owner check before verification (knowing a sub id grants no access).
        let preId: string | undefined;
        try {
          const translated = (await import("./delegationEvents.js") as typeof import("./delegationEvents.js")).translateSubscribeParams(officialParams as never);
          preId = (await import("./delegationEvents.js") as typeof import("./delegationEvents.js")).deterministicSubscriptionId(
            owner.ownerIdHash, translated.validated.callbackUrl, translated.validated.eventName, translated.validated.filter
          );
          const preexisting = loadSubscriptions(bridgeDir).find((sub) => sub.subId === preId);
          if (preexisting && !subscriptionOwnerMatches(deps, preexisting)) return denyAccess();
        } catch (error) {
          return failResult(`Subscription rejected: ${error instanceof Error ? error.message : String(error)}`, { error: "subscription_rejected" });
        }
        try {
          const result = await handleEventsSubscribe(officialParams as never, {
            bridgeDir,
            ownerIdHash: owner.ownerIdHash,
            ownerKind: owner.ownerKind
          });
          return okResult(`Subscribed ${result.id} to run-attention (verification challenge verified, refreshBefore ${result.refreshBefore ?? "none"}).`, {
            subscription_id: result.id,
            id: result.id,
            event_name: RUN_ATTENTION_EVENT,
            idempotent: result.idempotent,
            refreshBefore: result.refreshBefore,
            cursor: result.cursor,
            truncated: result.truncated,
            filter: (officialParams as { arguments: unknown }).arguments
          });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? Number((error as { code?: unknown }).code)
            : SUBSCRIPTION_CHALLENGE_ERROR_CODE;
          const reason = error && typeof error === "object" && (error as { data?: unknown }).data
            ? String(((error as { data: { reason?: unknown } }).data.reason ?? "challenge_failed"))
            : "challenge_failed";
          const isChallenge = Number.isFinite(code) && code === SUBSCRIPTION_CHALLENGE_ERROR_CODE;
          return failResult(`Subscription challenge failed: ${error instanceof Error ? error.message : String(error)}`, {
            error: isChallenge ? "challenge_failed" : "subscription_rejected",
            code: Number.isFinite(code) ? code : SUBSCRIPTION_CHALLENGE_ERROR_CODE,
            data: { reason }
          });
        }
      }
    },
    {
      name: "events_unsubscribe",
      options: {
        title: "Events Unsubscribe",
        description: "Remove one webhook subscription. Idempotent and owner-checked: unknown ids and other owners' ids both report removed:false without disclosure.",
        inputSchema: publicSchemaFrom(eventsUnsubscribeArgs),
        runtimeInputSchema: eventsUnsubscribeArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const subs = loadSubscriptions(bridgeDir);
        const index = subs.findIndex((sub) => sub.subId === String(args.subscription_id));
        if (index < 0) {
          return okResult("No such subscription; unsubscribe is idempotent.", { subscription_id: args.subscription_id, removed: false, idempotent: true });
        }
        if (!subscriptionOwnerMatches(deps, subs[index])) return denyAccess();
        subs.splice(index, 1);
        saveSubscriptions(bridgeDir, subs);
        return okResult(`Subscription ${args.subscription_id} removed.`, { subscription_id: args.subscription_id, removed: true });
      }
    }
  ];
  return defs;
}

async function pumpSweep(deps: DelegationToolDeps, bridgeDir: string): Promise<void> {
  for (const run of listDelegationRuns(bridgeDir)) {
    if (!ownerAllowed(deps, run)) continue;
    const due = run.pendingEvents.some((event) =>
      event.deliveries.some((delivery) => delivery.status === "pending" ||
        (delivery.status === "failed" && (!delivery.nextRetryAt || Date.parse(delivery.nextRetryAt) <= Date.now()))));
    if (due) await pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, run.runId) ?? run);
  }
}

