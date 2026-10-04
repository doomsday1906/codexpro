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
  DELEGATION_GROUP,
  activeSessionHolders,
  applyCheckpointReply,
  findRunByRequestId,
  listDelegationRuns,
  loadDelegationRun,
  newRunId,
  nextActionFor,
  openInputRequests,
  ownerIdFor,
  reconcileRunState,
  registerInputRequest,
  runInputRequests,
  sanitizeSummary,
  saveDelegationRun,
  stableEventId,
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
  buildOpenCodeCanaryArgv,
  CANARY_FIXTURES,
  canaryPrompt,
  cancelOwnedTree,
  clampCanaryTimeout,
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
  verifyOpenCodeModel
} from "./delegationEngines.js";
import {
  deliverEventToSubscription,
  deterministicSubscriptionId,
  eventsCapability,
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
      const outcome = await deliverEventToSubscription(sub.callbackUrl, secret, runEvent);
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
  if (live) {
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
    if (observed && isEngineSessionId(observed)) {
      if (latest) latest.sessionId = observed;
      run.session = {
        engine: "opencode",
        sessionId: observed,
        resumable: true,
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
  lastMessagePath: string
): void {
  const runtime = processRuntime();
  const fixtureHashes: Record<string, string> = {};
  for (const name of CANARY_FIXTURES) fixtureHashes[name] = sha256File(path.join(run.workdir, name));
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
}

function launchCodexCanary(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  profile: string,
  timeoutMs: number
): void {
  const prompt = canaryPrompt(CANARY_FIXTURES);
  const lastMessagePath = path.join(run.workdir, "codex-last-message.md");
  spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildCodexCanaryArgv(profile, prompt, lastMessagePath), timeoutMs, lastMessagePath);
}

function launchOpenCodeCanary(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  model: string,
  timeoutMs: number,
  sessionId?: string
): void {
  const prompt = canaryPrompt(CANARY_FIXTURES);
  const lastMessagePath = path.join(run.workdir, "opencode-last-message.json");
  spawnCanaryChild(deps, bridgeDir, run, resolveOpenCodeBinary(), buildOpenCodeCanaryArgv(model, prompt, sessionId), timeoutMs, lastMessagePath);
}

function launchCodexResume(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  sessionId: string,
  timeoutMs: number
): void {
  const prompt = canaryPrompt(CANARY_FIXTURES);
  const lastMessagePath = path.join(run.workdir, "codex-last-message.md");
  spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildCodexResumeArgv(sessionId, prompt, lastMessagePath), timeoutMs, lastMessagePath);
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
    session_id: z.string().max(128).optional().describe("Explicit OpenCode session id to continue-or-create via `run --session`. Omit to let the worker mint one (observed best-effort from --format json stdout)."),
    workdir: z.string().min(1).max(1024).describe("Explicit workspace-relative working directory for the disposable canary run."),
    request_id: z.string().min(1).max(128).optional().describe("Idempotency key. Repeating it returns the existing run without spawning a second worker."),
    canary: z.boolean().describe("Must be true: this leaf supports only the read-only canary slice."),
    timeout_ms: z.number().int().positive().optional().describe("Explicit bounded attempt timeout in ms. Canary clamps to 5 minutes; never applied to ordinary runs.")
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
        description: "Launch one durable read-only canary delegation run (Codex via exec --profile with Luna gate; OpenCode via run --model with host-model gate). Requires an explicit workdir plus profile (codex) or model (opencode); idempotent request ids never spawn a second worker. Subscribe to events before launching or replay via delegation_read_result so fast completion never loses the result.",
        inputSchema: publicSchemaFrom(launchArgs),
        runtimeInputSchema: launchArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const engine = args.engine as "codex" | "opencode";
        if (args.canary !== true) {
          return failResult("This leaf supports only the read-only canary slice: pass canary=true.", { error: "non_canary_rejected" });
        }
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
        const timeoutMs = clampCanaryTimeout(args.timeout_ms);
        const runId = newRunId();
        const owner = ownerIdFor(deps.config.authToken, localOwnerId(deps.config));
        const now = new Date().toISOString();
        fs.mkdirSync(resolved.absPath, { recursive: true, mode: 0o700 });
        for (const name of CANARY_FIXTURES) {
          const source = path.join(fixtureSourceDir(), name);
          try {
            fs.copyFileSync(source, path.join(resolved.absPath, name));
          } catch (error) {
            return failResult(`Canary fixture unavailable: ${name} (${error instanceof Error ? error.message : String(error)})`, { error: "canary_input_missing" });
          }
        }
        const session: DelegationSessionBinding = engine === "codex"
          ? {
            engine: "codex",
            resumable: false,
            reason: "codex ephemeral canary persists no session; follow-up starts a labeled new-continuation-attempt"
          }
          : sessionId
            ? {
              engine: "opencode",
              sessionId,
              resumable: true,
              reason: "explicit --session id: continues when known, otherwise creates (installed CLI semantics); first use may be creation"
            }
            : {
              engine: "opencode",
              resumable: false,
              reason: "no explicit --session id; the worker mints the session, observed best-effort from --format json stdout"
            };
        let run: DelegationRunRecord = {
          version: 1,
          runId,
          requestId,
          delegationGroup: DELEGATION_GROUP,
          engine,
          ...(engine === "codex" ? { profile } : { model }),
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
            summary: sanitizeSummary(engine === "codex"
              ? `canary attempt started via codex exec --profile ${profile}`
              : `canary attempt started via opencode run --model ${model}`)
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
            launchCodexCanary(deps, bridgeDir, run, profile, timeoutMs);
          } else {
            launchOpenCodeCanary(deps, bridgeDir, run, model, timeoutMs, sessionId);
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
            ? `Canary run ${runId} launched (codex --profile ${profile}, Luna verified, timeout ${timeoutMs} ms). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`
            : `Canary run ${runId} launched (opencode run --model ${model} --format json, host-model verified, timeout ${timeoutMs} ms${sessionId ? `, session ${sessionId}` : ""}). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`,
          {
            run_id: runId,
            request_id: requestId,
            delegation_group: DELEGATION_GROUP,
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
          delegation_group: DELEGATION_GROUP,
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
        if (verdict.request) {
          const request = verdict.request;
          let applied;
          try {
            applied = applyCheckpointReply(run, checkpoint, request);
          } catch (error) {
            const code = error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code ?? "reply_rejected")
              : "reply_rejected";
            return failResult(error instanceof Error ? error.message : String(error), { error: code, run_id: run.runId });
          }
          if (applied.run === run) {
            return okResult(`Duplicate answer ${checkpoint.id} for request ${request.id}: already applied at-most-once, nothing re-executed.`, {
              run_id: run.runId, checkpoint_id: checkpoint.id, input_request_id: request.id, duplicate: true, executed: false
            });
          }
          run = applied.run;
          const approvalNote = request.questions.some((question) => question.kind === "approval")
            ? " Approval-kind answers are data only and never widen sandbox, profile, or model."
            : "";
          if (applied.attemptsExhausted) {
            saveDelegationRun(bridgeDir, run);
            return okResult(
              `Answer ${checkpoint.id} for request ${request.id} stored at-most-once, but no attempt budget remains (max ${DELEGATION_BOUNDS.maxAttemptsPerRun}); relaunch only with a NEW request id.${approvalNote}`,
              { run_id: run.runId, checkpoint_id: checkpoint.id, input_request_id: request.id, stored: true, executed: false, reason: "attempts_exhausted" }
            );
          }
          // Re-verify the engine gate at continuation time: config may have drifted.
          if (run.engine === "codex") {
            const gate = verifyLunaProfile(codexHomeDir(), run.profile ?? "");
            if (!gate.allowed) {
              saveDelegationRun(bridgeDir, run);
              return failResult(`Answer stored at-most-once, but the Luna profile gate refused continuation: ${gate.reason}`, {
                error: "luna_gate_refused",
                run_id: run.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: true,
                executed: false,
                configured: gate.configured
              });
            }
          } else {
            const gate = verifyOpenCodeModel(run.model, describeOpenCodeDiscovery().hostModel);
            if (!gate.allowed) {
              saveDelegationRun(bridgeDir, run);
              return failResult(`Answer stored at-most-once, but the OpenCode model gate refused continuation: ${gate.reason}`, {
                error: "opencode_model_mismatch",
                run_id: run.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: true,
                executed: false,
                host_model: gate.hostModel ?? null
              });
            }
          }
          const timeoutMs = clampCanaryTimeout(run.attemptTimeoutMs);
          let continuationLabel: "resumed" | "new-continuation-attempt" = "new-continuation-attempt";
          let resumeSessionId: string | undefined;
          let spawnNote: string;
          if (run.engine === "codex") {
            if (run.session?.sessionId && run.session.resumable) {
              continuationLabel = "resumed";
              resumeSessionId = run.session.sessionId;
              spawnNote = `codex session ${resumeSessionId} resumed via exec resume (inherits its recorded profile)`;
            } else {
              spawnNote = "codex ephemeral canary persists no session: follow-up runs a new attempt, never a resumed session";
            }
          } else {
            const sid = run.session?.sessionId;
            if (sid && isEngineSessionId(sid)) {
              const holders = activeSessionHolders(listDelegationRuns(bridgeDir), sid, run.runId);
              if (holders.length > 0) {
                saveDelegationRun(bridgeDir, run);
                return failResult(`Answer stored at-most-once, but session ${sid} has an active turn (${holders[0].runId}); one active turn per session, retry after it settles.`, {
                  error: "session_busy",
                  run_id: run.runId,
                  checkpoint_id: checkpoint.id,
                  input_request_id: request.id,
                  stored: true,
                  executed: false,
                  session_id: sid,
                  holder_run_id: holders[0].runId
                });
              }
              continuationLabel = "resumed";
              resumeSessionId = sid;
              spawnNote = `opencode session ${sid} continued via run --session (true resume)`;
            } else {
              spawnNote = "no opencode session id recorded: follow-up runs a new attempt, never a resumed session";
            }
          }
          const n = run.attempts.length + 1;
          const startedAt = new Date().toISOString();
          run.attempts = [...run.attempts, {
            n,
            startedAt,
            state: "running",
            ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
            continuation: continuationLabel,
            summary: sanitizeSummary(`follow-up continuation (${continuationLabel}) for request ${request.id}`)
          }];
          run.state = "running";
          run.session = {
            engine: run.engine,
            ...(resumeSessionId ?? run.session?.sessionId ? { sessionId: (resumeSessionId ?? run.session?.sessionId) as string } : {}),
            resumable: run.engine === "opencode" && Boolean(resumeSessionId ?? run.session?.sessionId),
            continuation: continuationLabel,
            reason: spawnNote
          };
          run.nextAction = "poll delegation_read_result or await the run-attention event";
          saveDelegationRun(bridgeDir, run);
          try {
            if (run.engine === "codex" && continuationLabel === "resumed" && resumeSessionId) {
              launchCodexResume(deps, bridgeDir, run, resumeSessionId, timeoutMs);
            } else if (run.engine === "codex") {
              launchCodexCanary(deps, bridgeDir, run, run.profile ?? "", timeoutMs);
            } else {
              launchOpenCodeCanary(deps, bridgeDir, run, run.model ?? "", timeoutMs, resumeSessionId);
            }
          } catch (error) {
            const current = loadDelegationRun(bridgeDir, run.runId) ?? run;
            current.state = "failed";
            const failed = current.attempts.at(-1);
            if (failed) {
              failed.state = "failed";
              failed.finishedAt = new Date().toISOString();
              failed.summary = sanitizeSummary(`continuation launch failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            current.result = { exitCode: 127, signal: null, timedOut: false, summary: sanitizeSummary(error instanceof Error ? error.message : String(error)) };
            enqueueTerminalEvent(current, loadSubscriptions(bridgeDir));
            saveDelegationRun(bridgeDir, current);
            return failResult(`Continuation launch failed: ${error instanceof Error ? error.message : String(error)}`, {
              error: "launch_failed",
              run_id: run.runId,
              stored: true,
              executed: false
            });
          }
          return okResult(
            `Answer ${checkpoint.id} for request ${request.id} applied at-most-once; continuation attempt ${n} launched (${continuationLabel}: ${spawnNote}).${approvalNote}`,
            {
              run_id: run.runId,
              checkpoint_id: checkpoint.id,
              input_request_id: request.id,
              stored: true,
              executed: true,
              attempt_n: n,
              continuation: continuationLabel,
              ...(resumeSessionId ? { session_id: resumeSessionId } : {}),
              timeout_ms: timeoutMs,
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
        description: "List the narrow MCP Events surface: exactly one run-attention event (completed/failed/interrupted/timed_out/cancelled/needs-input) with owner plus delegation-group/run id filters and webhook-only delivery.",
        inputSchema: publicSchemaFrom(z.object({}).strict()),
        runtimeInputSchema: z.object({}).strict(),
        annotations: READ_ONLY
      },
      handler: async () => okResult("# Events\n\n- run-attention: delegation wake-up with run id, state, seq/version, and a sanitized summary only.", {
        capability: eventsCapability(),
        events: [listRunAttentionEvent()]
      })
    },
    {
      name: "events_subscribe",
      options: {
        title: "Events Subscribe",
        description: "Subscribe a webhook to the run-attention event. Validates a whsec_ secret, HTTPS callback, and private/local blocks; verifies the callback with a signed challenge (unique webhook-id, Standard Webhooks). Deterministic subscription ids make repeat calls idempotent. Challenge failure is error -32015.",
        inputSchema: publicSchemaFrom(eventsSubscribeArgs),
        runtimeInputSchema: eventsSubscribeArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        let validated;
        try {
          validated = validateSubscriptionInput({
            callbackUrl: args.callback_url,
            eventName: args.event_name ?? RUN_ATTENTION_EVENT,
            filter: args.filter,
            webhookSecret: args.webhook_secret
          });
        } catch (error) {
          return failResult(`Subscription rejected: ${error instanceof Error ? error.message : String(error)}`, { error: "subscription_rejected" });
        }
        const owner = ownerIdFor(deps.config.authToken, localOwnerId(deps.config));
        const subId = deterministicSubscriptionId(owner.ownerIdHash, validated.callbackUrl, validated.eventName, validated.filter);
        const preexisting = loadSubscriptions(bridgeDir).find((sub) => sub.subId === subId);
        if (preexisting && !subscriptionOwnerMatches(deps, preexisting)) return denyAccess();
        try {
          const { webhookId } = await verifySubscriptionChallenge(
            validated.callbackUrl, validated.secretBytes, validated.eventName, validated.filter
          );
          const subs = loadSubscriptions(bridgeDir);
          const index = subs.findIndex((sub) => sub.subId === subId);
          const record: EventSubscription = {
            version: 1,
            subId,
            eventName: validated.eventName,
            callbackUrl: validated.callbackUrl,
            filter: validated.filter,
            ownerIdHash: owner.ownerIdHash,
            ownerKind: owner.ownerKind,
            createdAt: index >= 0 ? subs[index].createdAt : new Date().toISOString(),
            lastWebhookId: webhookId,
            secret: args.webhook_secret as string
          };
          if (index >= 0) subs[index] = record;
          else subs.push(record);
          saveSubscriptions(bridgeDir, subs);
          return okResult(`Subscribed ${subId} to run-attention (challenge verified, webhook ${webhookId}).`, {
            subscription_id: subId, event_name: RUN_ATTENTION_EVENT, idempotent: index >= 0, filter: validated.filter
          });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? Number((error as { code?: unknown }).code)
            : SUBSCRIPTION_CHALLENGE_ERROR_CODE;
          return failResult(`Subscription challenge failed: ${error instanceof Error ? error.message : String(error)}`, {
            error: "challenge_failed", code: Number.isFinite(code) ? code : SUBSCRIPTION_CHALLENGE_ERROR_CODE
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

