/**
 * Durable Codex delegation run state (Leaf 2: hestia-cli-canary).
 *
 * This store EXTENDS the existing execute-handoff saved run state rather than
 * creating another runner: run files live next to `.ai-bridge/handoff-run-state.json`
 * under `.ai-bridge/delegation-runs/`, reuse the same atomic-write discipline
 * (tmp file + rename, mode 0600), and never execute anything themselves.
 *
 * Persisted per run (outside tmp): run identity, workspace canonical path,
 * profile/model, session binding, attempt history, state, result excerpts,
 * structured input requests (needs-input Q&A), checkpoints, pending events.
 * State changes and pending-event enqueue persist in ONE atomic file write so
 * a crash can never record a terminal state while losing its wake-up event.
 *
 * Follow-up is a real durable protocol, not a log guess: questions are
 * structured input requests (run id + seq + version) and replies reference
 * the exact request id. Replies apply at most once; stale, duplicate with
 * conflicting content, wrong-run, unknown-request, and closed-request replies
 * are rejected with typed errors. Approval-kind questions are never an
 * approval bypass: answering stores data only and any continuation relaunches
 * under the unchanged read-only engine gate.
 *
 * Process binding is PID + starttime identity (Linux /proc starttime, same
 * pattern as verificationOps/launcher-process-tree). PID alone is never
 * trusted. Reconciliation on restart is honest: a dead running process is
 * `interrupted` (never auto-restarted when the attempt may have mutated),
 * a terminal run with undelivered events is `completed-awaiting-delivery`.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DELEGATION_GROUP = "hestia-cli-canary";
/** Default group applied when launch omits delegation_group (back-compat). */
export const DELEGATION_GROUP_DEFAULT = DELEGATION_GROUP;
export const DELEGATION_STORE_VERSION = 1;
export const DELEGATION_RUNS_DIRNAME = "delegation-runs";
export const DELEGATION_SUBSCRIPTIONS_FILENAME = "delegation-subscriptions.json";

export type DelegationEngine = "codex" | "opencode";

/** Terminal states reuse the handoff vocabulary so wait_for_handoff stays valid. */
export type DelegationRunState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "timed_out"
  | "cancelled"
  | "needs-input";

export const DELEGATION_TERMINAL_STATES: ReadonlySet<DelegationRunState> = new Set([
  "completed",
  "failed",
  "interrupted",
  "timed_out",
  "cancelled"
]);

export interface DelegationAttempt {
  n: number;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  processStartTime?: string;
  state: DelegationRunState;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  /** Engine session observed for this attempt, when the worker reported one. */
  sessionId?: string;
  /** Honest continuation label: true resume vs a new attempt. */
  continuation?: "resumed" | "new-continuation-attempt";
  /** Sanitized one-line outcome only. Never transcripts, prompts, or credentials. */
  summary?: string;
}

export interface DelegationEventDelivery {
  subId: string;
  status: "pending" | "delivered" | "failed" | "permanent";
  attempts: number;
  lastError?: string;
  nextRetryAt?: string;
}

export interface DelegationPendingEvent {
  eventId: string;
  seq: number;
  state: DelegationRunState;
  /** Sanitized summary or input-request id only. Detail requires authorized read. */
  summary?: string;
  inputRequestId?: string;
  createdAt: string;
  deliveries: DelegationEventDelivery[];
  /** Consumer acknowledgement, recorded only via explicit ack. Never implied by read. */
  acked?: boolean;
}

export interface DelegationCheckpoint {
  id: string;
  runId: string;
  seq: number;
  payload: Record<string, unknown>;
  storedAt: string;
  applied: boolean;
  /** Exact input request this checkpoint answers, when it is a reply. */
  inputRequestId?: string;
}

/**
 * One structured question in a needs-input request. kind "approval" marks a
 * question the agent framed as needing approval; answering it stores data
 * only and NEVER widens the engine gate (no approval bypass by construction).
 */
export interface DelegationInputQuestion {
  id: string;
  question: string;
  kind: "input" | "approval";
}

/**
 * Durable structured input request: the needs-input artifact. Stored with
 * the owning run id, a monotonic seq, and version 1. Replies reference the
 * exact request id and apply at most once.
 */
export interface DelegationInputRequest {
  id: string;
  runId: string;
  seq: number;
  version: 1;
  questions: DelegationInputQuestion[];
  status: "open" | "answered" | "expired";
  storedAt: string;
  answeredAt?: string;
  answerCheckpointId?: string;
}

/**
 * Engine session binding for follow-up resume. Ephemeral Codex canary runs
 * record no session (resumable false); OpenCode runs record the session id
 * observed in worker stdout (resumable true) or the explicit --session id
 * used at launch. Continuation labels stay honest: "resumed" only for a real
 * session continue, otherwise "new-continuation-attempt".
 */
export interface DelegationSessionBinding {
  engine: DelegationEngine;
  sessionId?: string;
  resumable: boolean;
  continuation?: "resumed" | "new-continuation-attempt";
  reason: string;
  /** True only when the id was observed in worker output (not explicit-only). */
  observed?: boolean;
  /** How the session identity was evidenced. Never a credential. */
  evidence?: string;
}

export interface DelegationRunRecord {
  version: number;
  runId: string;
  requestId: string;
  delegationGroup: string;
  engine: DelegationEngine;
  profile?: string;
  /** Sanitized bounded task text supplied at launch (the real worker input).
   * Optional: Leaf 1/2 run files predate it and carry the canary prompt only. */
  task?: string;
  /** False for real tasks (no fixtures, larger timeout regime). Optional:
   * Leaf 1/2 run files predate it and are canary runs. */
  isCanary?: boolean;
  workspaceId: string;
  workspaceCanonical: string;
  workdir: string;
  /** SHA-256 hex of the bearer token, or a local-owner tuple. Never the secret. */
  ownerIdHash: string;
  ownerKind: "token" | "local";
  state: DelegationRunState;
  seq: number;
  attempts: DelegationAttempt[];
  result?: {
    exitCode?: number | null;
    signal?: string | null;
    timedOut?: boolean;
    summary?: string;
    stdoutTail?: string;
    stderrTail?: string;
    fixturesUnchanged?: boolean;
  };
  pendingEvents: DelegationPendingEvent[];
  checkpoints: DelegationCheckpoint[];
  appliedCheckpointIds: string[];
  lastAppliedCheckpointSeq: number;
  /** Structured needs-input requests. Optional: Leaf 1 run files predate it. */
  inputRequests?: DelegationInputRequest[];
  /** Engine session binding for follow-up resume. Optional: Leaf 1 predates it. */
  session?: DelegationSessionBinding;
  /** Explicit OpenCode --model for engine opencode. Optional: codex runs omit it. */
  model?: string;
  /** Clamped canary attempt timeout reused for continuations. Optional. */
  attemptTimeoutMs?: number;
  /**
   * Crash-safe pending dispatch: the staged answer persisted BEFORE spawn.
   * While present the reply is NOT consumed (request stays open, no answered
   * mark, no applied checkpoint). On spawn success the pending is confirmed
   * into an applied checkpoint + running attempt; on spawn failure it stays
   * pending and the identical checkpoint id remains retryable. Optional:
   * runs without a pending dispatch predate this field.
   */
  pendingDispatch?: DelegationPendingDispatch;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationPendingDispatch {
  checkpointId: string;
  requestId: string;
  seq: number;
  payload: Record<string, unknown>;
  attemptN: number;
  continuation: "resumed" | "new-continuation-attempt";
  resumeSessionId?: string;
  timeoutMs: number;
  prompt: string;
  sessionEvidence: string;
  storedAt: string;
  state: "pending-dispatch";
}

/** Storage / output / concurrency / execution bounds for this leaf. */
export const DELEGATION_BOUNDS = {
  maxAttemptsPerRun: 3,
  maxRunsPerWorkspace: 32,
  maxActiveRunsPerWorkspace: 2,
  maxPendingEventsPerRun: 16,
  maxCheckpointsPerRun: 16,
  maxTailBytes: 8_000,
  maxSummaryChars: 280,
  // Leaf 2 justification: the new structured Q&A surface needs caps so one run
  // cannot accumulate unbounded questions or smuggle transcripts/credentials
  // through checkpoint payloads; 8 questions and an 8 KiB payload keep the
  // needs-input event small (id + summary only) with detail via authorized read.
  maxInputRequestsPerRun: 8,
  maxQuestionsPerRequest: 8,
  maxCheckpointPayloadBytes: 8_192,
  // E2E leaf: real task/group inputs are bounded so one run cannot smuggle
  // unbounded instructions through the task surface; the needs-input event
  // stays small (id + summary only) with detail via authorized read.
  maxTaskChars: 8_000,
  maxDelegationGroupChars: 64,
  // Timeout regimes: canary keeps the 5-minute default/max; real tasks accept
  // an explicit bounded timeout up to 30 minutes (clamped + truthfully acked).
  maxAttemptTimeoutMsCanary: 300_000,
  maxAttemptTimeoutMsReal: 1_800_000,
  minAttemptTimeoutMs: 10_000
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function delegationRunsDir(bridgeDir: string): string {
  return path.join(bridgeDir, DELEGATION_RUNS_DIRNAME);
}

export function delegationRunPath(bridgeDir: string, runId: string): string {
  if (!/^run_[0-9a-f]{16}$/.test(runId)) throw new Error("Invalid delegation run id.");
  return path.join(delegationRunsDir(bridgeDir), `${runId}.json`);
}

export function subscriptionsPath(bridgeDir: string): string {
  return path.join(bridgeDir, DELEGATION_SUBSCRIPTIONS_FILENAME);
}

export function newRunId(): string {
  return `run_${createHash("sha256").update(`${Date.now()}:${process.pid}:${Math.random()}`).digest("hex").slice(0, 16)}`;
}

export function stableEventId(runId: string, seq: number): string {
  return `evt_${createHash("sha256").update(`${runId}:${seq}`).digest("hex").slice(0, 16)}`;
}

export function sanitizeSummary(value: unknown, maxChars = DELEGATION_BOUNDS.maxSummaryChars): string {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars - 20)}...[summary truncated]` : text;
}

export function summarizeTerminal(state: DelegationRunState, exitCode?: number | null, timedOut?: boolean): string {
  if (timedOut) return "attempt timed out";
  if (state === "cancelled") return "run cancelled";
  if (state === "interrupted") return "run interrupted before completion";
  if (state === "needs-input") return "run needs input";
  if (exitCode === 0) return "completed exit 0";
  return `finished state=${state} exit=${exitCode ?? "null"}`;
}

/**
 * Owner identity for delegation authorization. Knowing a group/run id grants
 * no access: every op recomputes this from the CURRENT server credentials and
 * compares in constant time against the run's recorded owner.
 */
export function ownerIdFor(authToken: string | undefined, localOwner: string): { ownerIdHash: string; ownerKind: "token" | "local" } {
  if (authToken) {
    return { ownerIdHash: createHash("sha256").update(authToken, "utf8").digest("hex"), ownerKind: "token" };
  }
  return { ownerIdHash: createHash("sha256").update(`local:${localOwner}`, "utf8").digest("hex"), ownerKind: "local" };
}

export function verifyRunOwner(authToken: string | undefined, localOwner: string, run: DelegationRunRecord): boolean {
  const current = ownerIdFor(authToken, localOwner);
  if (current.ownerKind !== run.ownerKind) return false;
  const a = Buffer.from(current.ownerIdHash, "utf8");
  const b = Buffer.from(run.ownerIdHash, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, filePath);
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

export function saveDelegationRun(bridgeDir: string, run: DelegationRunRecord): void {
  const capped: DelegationRunRecord = {
    ...run,
    version: DELEGATION_STORE_VERSION,
    attempts: run.attempts.slice(-DELEGATION_BOUNDS.maxAttemptsPerRun),
    pendingEvents: run.pendingEvents.slice(-DELEGATION_BOUNDS.maxPendingEventsPerRun),
    checkpoints: run.checkpoints.slice(-DELEGATION_BOUNDS.maxCheckpointsPerRun),
    inputRequests: (run.inputRequests ?? []).slice(-DELEGATION_BOUNDS.maxInputRequestsPerRun),
    updatedAt: new Date().toISOString()
  };
  atomicWriteJson(delegationRunPath(bridgeDir, run.runId), capped);
  pruneDelegationRuns(bridgeDir);
}

export function loadDelegationRun(bridgeDir: string, runId: string): DelegationRunRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(delegationRunPath(bridgeDir, runId), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== DELEGATION_STORE_VERSION) return undefined;
    return parsed as unknown as DelegationRunRecord;
  } catch {
    return undefined;
  }
}

export function listDelegationRuns(bridgeDir: string): DelegationRunRecord[] {
  const dir = delegationRunsDir(bridgeDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs: DelegationRunRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.startsWith(".")) continue;
    const runId = entry.slice(0, -".json".length);
    const run = loadDelegationRun(bridgeDir, runId);
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Idempotency: an idempotent request id must never spawn a second worker. */
export function findRunByRequestId(bridgeDir: string, requestId: string): DelegationRunRecord | undefined {
  if (!requestId) return undefined;
  return listDelegationRuns(bridgeDir).find((run) => run.requestId === requestId);
}

export interface LaunchConflictCandidate {
  engine: DelegationEngine;
  delegationGroup: string;
  isCanary: boolean;
  task?: string;
  profile?: string;
  model?: string;
  /** Explicit session id supplied at launch, if any. Omitted (minted) sessions never conflict. */
  sessionId?: string;
}

/**
 * Conflicting-payload guard for launch idempotency. The same request id with
 * identical worker-input content replays (no second worker); the same id with
 * different task/group/model content is a conflicting re-use and must be
 * rejected with duplicate_conflicting (no new worker, nothing consumed).
 * Operational fields (workdir, timeout) are not identity: retries may restate
 * them. An omitted session id never conflicts with a later-observed minted
 * session; only two explicit session ids are compared.
 */
export function isLaunchRequestConflict(existing: DelegationRunRecord, candidate: LaunchConflictCandidate): boolean {
  if (existing.engine !== candidate.engine) return true;
  if (existing.delegationGroup !== candidate.delegationGroup) return true;
  const existingCanary = existing.isCanary !== false;
  if (existingCanary !== candidate.isCanary) return true;
  if (!candidate.isCanary && (existing.task ?? "") !== (candidate.task ?? "")) return true;
  if (candidate.engine === "codex" && (existing.profile ?? "") !== (candidate.profile ?? "")) return true;
  if (candidate.engine === "opencode") {
    if ((existing.model ?? "") !== (candidate.model ?? "")) return true;
    const candidateSession = candidate.sessionId ?? "";
    if (candidateSession && (existing.session?.sessionId ?? "") !== candidateSession) return true;
  }
  return false;
}

function pruneDelegationRuns(bridgeDir: string): void {
  const runs = listDelegationRuns(bridgeDir);
  if (runs.length <= DELEGATION_BOUNDS.maxRunsPerWorkspace) return;
  const terminal = runs.filter((run) => DELEGATION_TERMINAL_STATES.has(run.state));
  const excess = runs.length - DELEGATION_BOUNDS.maxRunsPerWorkspace;
  const victims = terminal.slice(0, excess);
  for (const victim of victims) {
    try { fs.rmSync(delegationRunPath(bridgeDir, victim.runId), { force: true }); } catch { /* ignore */ }
  }
}

/** Backward-compatible accessor: Leaf 1 run files carry no inputRequests. */
export function runInputRequests(run: DelegationRunRecord): DelegationInputRequest[] {
  return Array.isArray(run.inputRequests) ? run.inputRequests : [];
}

export function openInputRequests(run: DelegationRunRecord): DelegationInputRequest[] {
  return runInputRequests(run).filter((request) => request.status === "open");
}

/** Checkpoint/question/request ids: bounded, no whitespace or path separators. */
export function isCheckpointId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

/**
 * Delegation group ids: bounded, no whitespace or path separators. The group
 * scopes subscriptions and events: a subscription only receives runs whose
 * delegationGroup matches its filter.
 */
export function isDelegationGroupId(value: unknown): boolean {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= DELEGATION_BOUNDS.maxDelegationGroupChars &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value);
}

/** Sanitize real task text: control chars stripped, bounded, never empty. */
export function sanitizeTaskText(value: unknown, maxChars = DELEGATION_BOUNDS.maxTaskChars): string {
  const text = String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars - 20)}...[task truncated]` : text;
}

/** Local stable stringify (events/canonicalJson equivalent without a cycle). */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface CheckpointShape {
  id: string;
  run_id: string;
  seq: number;
  payload: Record<string, unknown>;
  input_request_id?: string;
  questions?: unknown;
}

export interface CheckpointVerdict {
  ok: boolean;
  code?: string;
  message?: string;
  duplicate?: boolean;
  questions?: DelegationInputQuestion[];
  request?: DelegationInputRequest;
}

/**
 * Shared checkpoint validation for delegation_followup. Pure: never mutates.
 * Typed rejections: wrong_run_checkpoint, invalid_checkpoint_id,
 * checkpoint_payload_too_large, duplicate_conflicting,
 * checkpoint_needs_questions_or_request_ref, invalid_questions,
 * unknown_input_request. Stale seqs are rejected; identical duplicates are
 * idempotent (duplicate:true) so at-most-once holds without re-execution.
 */
export function validateCheckpointForRun(run: DelegationRunRecord, checkpoint: CheckpointShape): CheckpointVerdict {
  if (!checkpoint || typeof checkpoint !== "object") {
    return { ok: false, code: "invalid_checkpoint", message: "checkpoint must be an object with id, run_id, seq, and payload" };
  }
  if (checkpoint.run_id !== run.runId) {
    return { ok: false, code: "wrong_run_checkpoint", message: `Wrong-run checkpoint: checkpoint targets ${String(checkpoint.run_id)}, not ${run.runId}.` };
  }
  if (!isCheckpointId(checkpoint.id)) {
    return { ok: false, code: "invalid_checkpoint_id", message: "checkpoint id must match /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/." };
  }
  if (!Number.isSafeInteger(checkpoint.seq) || (checkpoint.seq as number) < 0) {
    return { ok: false, code: "invalid_checkpoint_seq", message: "checkpoint seq must be a non-negative integer." };
  }
  if (!checkpoint.payload || typeof checkpoint.payload !== "object" || Array.isArray(checkpoint.payload)) {
    return { ok: false, code: "invalid_checkpoint_payload", message: "checkpoint payload must be an object." };
  }
  if (Buffer.byteLength(JSON.stringify(checkpoint.payload), "utf8") > DELEGATION_BOUNDS.maxCheckpointPayloadBytes) {
    return { ok: false, code: "checkpoint_payload_too_large", message: `checkpoint payload exceeds ${DELEGATION_BOUNDS.maxCheckpointPayloadBytes} bytes.` };
  }
  const stored = run.checkpoints.find((candidate) => candidate.id === checkpoint.id);
  if (stored) {
    const same = stored.runId === checkpoint.run_id &&
      stored.seq === checkpoint.seq &&
      stableStringify(stored.payload) === stableStringify(checkpoint.payload) &&
      (stored.inputRequestId ?? null) === (typeof checkpoint.input_request_id === "string" ? checkpoint.input_request_id : null);
    if (same) return { ok: true, duplicate: true };
    return { ok: false, code: "duplicate_conflicting", message: `Checkpoint ${checkpoint.id} already stored with different content; refusing conflicting re-use (at-most-once).` };
  }
  // Crash-boundary pending dispatch: the same checkpoint id may be staged as
  // pending (persisted before spawn, not yet an applied checkpoint). The same
  // content stays retryable (falls through to the normal reply path, which
  // reuses the staged attempt number); different content for the same id is a
  // conflicting re-use and is rejected here, before any worker spawns and
  // without consuming the pending reply.
  const pending = run.pendingDispatch;
  if (pending && pending.checkpointId === checkpoint.id) {
    const incomingRequestId = typeof checkpoint.input_request_id === "string" ? checkpoint.input_request_id : null;
    const samePending = incomingRequestId !== null &&
      pending.requestId === incomingRequestId &&
      pending.seq === checkpoint.seq &&
      stableStringify(pending.payload) === stableStringify(checkpoint.payload);
    if (!samePending) {
      return { ok: false, code: "duplicate_conflicting", message: `Checkpoint ${checkpoint.id} has a pending dispatch with different content; refusing conflicting re-use (at-most-once). No worker spawned and the pending reply is not consumed.` };
    }
  }
  const maxStoredSeq = run.checkpoints.reduce((max, candidate) => Math.max(max, candidate.seq), -1);
  if ((checkpoint.seq as number) <= Math.max(run.lastAppliedCheckpointSeq, maxStoredSeq)) {
    return { ok: false, code: "stale_checkpoint", message: `Stale checkpoint: seq ${checkpoint.seq} is not newer than the stored stream.` };
  }
  const requestRef = typeof checkpoint.input_request_id === "string" ? checkpoint.input_request_id : "";
  const hasQuestions = checkpoint.questions !== undefined;
  if (!requestRef && !hasQuestions) {
    return { ok: false, code: "checkpoint_needs_questions_or_request_ref", message: "checkpoint must carry questions (question path) or input_request_id (reply path)." };
  }
  let questions: DelegationInputQuestion[] | undefined;
  if (hasQuestions) {
    if (!Array.isArray(checkpoint.questions) || checkpoint.questions.length === 0 ||
      checkpoint.questions.length > DELEGATION_BOUNDS.maxQuestionsPerRequest) {
      return { ok: false, code: "invalid_questions", message: `questions must be a non-empty array of at most ${DELEGATION_BOUNDS.maxQuestionsPerRequest}.` };
    }
    questions = [];
    for (const entry of checkpoint.questions) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, code: "invalid_questions", message: "each question needs {id, question} with optional kind input|approval." };
      }
      const raw = entry as Record<string, unknown>;
      if (!isCheckpointId(raw.id) || typeof raw.question !== "string" ||
        !raw.question.trim() || raw.question.length > 2000) {
        return { ok: false, code: "invalid_questions", message: "each question needs a valid id and a non-empty question of at most 2000 chars." };
      }
      const kind = raw.kind === undefined ? "input" : raw.kind;
      if (kind !== "input" && kind !== "approval") {
        return { ok: false, code: "invalid_questions", message: "question kind must be input or approval." };
      }
      questions.push({ id: raw.id as string, question: (raw.question as string).trim(), kind });
    }
  }
  let request: DelegationInputRequest | undefined;
  if (requestRef) {
    request = runInputRequests(run).find((candidate) => candidate.id === requestRef);
    if (!request) {
      return { ok: false, code: "unknown_input_request", message: `No input request ${requestRef} for run ${run.runId}.` };
    }
  }
  return { ok: true, questions, request };
}

export interface RegisterQuestionResult {
  run: DelegationRunRecord;
  request: DelegationInputRequest;
}

/**
 * Question path: register a durable structured input request and move the run
 * to needs-input with a needs-input wake-up event. Allowed only from
 * non-running states (completed/failed/timed_out/needs-input): questions
 * while an attempt is live are refused (ask after the run-attention event),
 * and cancelled/interrupted runs need an explicit new request id, never an
 * implicit resurrection. State + event are staged in ONE record; the caller
 * persists atomically with saveDelegationRun.
 */
export function registerInputRequest(
  run: DelegationRunRecord,
  checkpoint: CheckpointShape,
  questions: DelegationInputQuestion[]
): RegisterQuestionResult {
  if (run.state === "cancelled") {
    throw Object.assign(new Error("Run is cancelled; follow-up questions are refused."), { code: "run_cancelled" });
  }
  if (run.state === "interrupted") {
    throw Object.assign(new Error("Run was interrupted; relaunch only with a NEW request id, never an implicit resurrection."), { code: "run_interrupted_use_new_request" });
  }
  if (run.state === "running" || run.state === "queued") {
    throw Object.assign(new Error("An attempt is still active; ask follow-up questions after the run-attention event."), { code: "question_while_running_refused" });
  }
  if (runInputRequests(run).length >= DELEGATION_BOUNDS.maxInputRequestsPerRun) {
    throw Object.assign(new Error("Input-request bound reached for this run."), { code: "input_request_bound" });
  }
  const now = new Date().toISOString();
  const request: DelegationInputRequest = {
    id: checkpoint.id,
    runId: run.runId,
    seq: checkpoint.seq,
    version: 1,
    questions,
    status: "open",
    storedAt: now
  };
  const firstQuestion = sanitizeSummary(questions[0].question.slice(0, 140));
  const seq = run.seq + 1;
  const needsInputEvent: DelegationPendingEvent = {
    eventId: stableEventId(run.runId, seq),
    seq,
    state: "needs-input",
    summary: sanitizeSummary(`needs input: ${firstQuestion}`),
    inputRequestId: request.id,
    createdAt: now,
    deliveries: []
  };
  const next: DelegationRunRecord = {
    ...run,
    state: "needs-input",
    seq,
    checkpoints: [...run.checkpoints, {
      id: checkpoint.id,
      runId: checkpoint.run_id,
      seq: checkpoint.seq,
      payload: checkpoint.payload,
      storedAt: now,
      applied: false
    }].slice(-DELEGATION_BOUNDS.maxCheckpointsPerRun),
    inputRequests: [...runInputRequests(run), request].slice(-DELEGATION_BOUNDS.maxInputRequestsPerRun),
    pendingEvents: [...run.pendingEvents, needsInputEvent].slice(-DELEGATION_BOUNDS.maxPendingEventsPerRun),
    nextAction: "run is waiting for input; answer via delegation_followup with the matching input-request id"
  };
  return { run: next, request };
}

export interface ApplyReplyResult {
  run: DelegationRunRecord;
  request: DelegationInputRequest;
  attemptsExhausted: boolean;
}

/**
 * Reply path: answer the exact referenced request at most once. The request
 * must be open; answering stores the checkpoint durably (applied:true),
 * advances appliedCheckpointIds/lastAppliedCheckpointSeq, and keeps
 * needs-input only while other requests stay open. Approval-kind answers are
 * data only: they never widen the engine gate (enforced at continuation
 * launch, which re-verifies the read-only gate). Returns attemptsExhausted
 * when the answer is stored but no attempt budget remains.
 */
export function applyCheckpointReply(
  run: DelegationRunRecord,
  checkpoint: CheckpointShape,
  request: DelegationInputRequest
): ApplyReplyResult {
  if (run.state !== "needs-input") {
    throw Object.assign(new Error(`Run ${run.runId} is ${run.state}: replies require needs-input with an open request.`), { code: "reply_without_open_request" });
  }
  const stored = runInputRequests(run).find((candidate) => candidate.id === request.id);
  if (!stored) {
    throw Object.assign(new Error(`No input request ${request.id} for run ${run.runId}.`), { code: "unknown_input_request" });
  }
  if (stored.status === "expired") {
    throw Object.assign(new Error(`Input request ${request.id} expired; ask a fresh question.`), { code: "input_request_expired" });
  }
  if (stored.status === "answered") {
    if (stored.answerCheckpointId === checkpoint.id) {
      return { run, request: stored, attemptsExhausted: false };
    }
    throw Object.assign(new Error(`Input request ${request.id} already answered by ${stored.answerCheckpointId}; conflicting re-answer refused.`), { code: "input_request_closed" });
  }
  const now = new Date().toISOString();
  const answered: DelegationInputRequest = { ...stored, status: "answered", answeredAt: now, answerCheckpointId: checkpoint.id };
  const settled = runInputRequests(run).map((candidate) => candidate.id === answered.id ? answered : candidate);
  // Budget counts dispatched attempts only; a queued pending-dispatch
  // reservation (staged before spawn) does not itself exhaust budget.
  const dispatchedCount = run.attempts.filter(
    (a) => !(a.state === "queued" && (a.summary ?? "").includes("pending dispatch"))
  ).length;
  const attemptsExhausted = dispatchedCount >= DELEGATION_BOUNDS.maxAttemptsPerRun;
  const stillOpen = settled.some((candidate) => candidate.status === "open");
  const next: DelegationRunRecord = {
    ...run,
    checkpoints: [...run.checkpoints, {
      id: checkpoint.id,
      runId: checkpoint.run_id,
      seq: checkpoint.seq,
      payload: checkpoint.payload,
      inputRequestId: request.id,
      storedAt: now,
      applied: true
    }].slice(-DELEGATION_BOUNDS.maxCheckpointsPerRun),
    appliedCheckpointIds: [...run.appliedCheckpointIds, checkpoint.id],
    lastAppliedCheckpointSeq: Math.max(run.lastAppliedCheckpointSeq, checkpoint.seq),
    inputRequests: settled.slice(-DELEGATION_BOUNDS.maxInputRequestsPerRun),
    nextAction: attemptsExhausted
      ? "answer stored at-most-once but no attempt budget remains; relaunch only with a NEW request id"
      : stillOpen
        ? "answer applied at-most-once; other input requests remain open; answer via delegation_followup"
        : "answer applied at-most-once; continuation launching"
  };
  return { run: next, request: answered, attemptsExhausted };
}

/** Mark one open request expired (owner/hygiene path; expired replies are refused). */
export function expireInputRequest(run: DelegationRunRecord, requestId: string): DelegationRunRecord {
  return {
    ...run,
    inputRequests: runInputRequests(run).map((candidate) =>
      candidate.id === requestId && candidate.status === "open"
        ? { ...candidate, status: "expired" as const }
        : candidate)
  };
}

/**
 * One-active-turn-per-session: runs (other than excludeRunId) holding this
 * session id while in a non-terminal wait state.
 */
export function activeSessionHolders(
  runs: DelegationRunRecord[],
  sessionId: string,
  excludeRunId?: string
): DelegationRunRecord[] {
  return runs.filter((run) => run.runId !== excludeRunId &&
    run.session?.sessionId === sessionId &&
    (run.state === "running" || run.state === "queued" || run.state === "needs-input"));
}

export type LivenessProbe = (pid: number, startTime: string) => boolean;
export interface ReconcileResult {
  run: DelegationRunRecord;
  classification: "live" | "interrupted" | "completed-awaiting-delivery" | "terminal" | "needs-input";
  changed: boolean;
}

/**
 * Honest restart reconciliation. Never auto-restarts a potentially mutating
 * task: a dead running attempt becomes `interrupted` with an explicit next
 * action, never a silent relaunch.
 */
export function reconcileRunState(run: DelegationRunRecord, isAlive: LivenessProbe): ReconcileResult {
  const undelivered = run.pendingEvents.some((event) =>
    event.deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "failed")
  );
  if (DELEGATION_TERMINAL_STATES.has(run.state)) {
    if (run.state === "completed" && undelivered) {
      return {
        run: { ...run, nextAction: "terminal result stored but wake-up delivery is pending; replay via delegation_read_result or wait for redelivery" },
        classification: "completed-awaiting-delivery",
        changed: false
      };
    }
    return { run, classification: "terminal", changed: false };
  }
  if (run.state === "needs-input") {
    // No blind short-circuit: a staged dispatch may have spawned its worker
    // before a crash without confirming (persisted pid on the queued pending
    // attempt while the run is still needs-input). Consult PID+starttime
    // identity (never PID alone) before any retry decision. A live staged
    // worker classifies live so the retry confirms instead of spawning a
    // second worker; anything else stays needs-input (pending remains
    // retryable, finished attempts keep their terminal reading).
    const latestNeedsInput = run.attempts.at(-1);
    if (latestNeedsInput?.pid !== undefined && latestNeedsInput.processStartTime !== undefined) {
      if (isAlive(latestNeedsInput.pid, latestNeedsInput.processStartTime)) {
        return {
          run: {
            ...run,
            nextAction: "a staged continuation worker is still alive; confirm the pending dispatch instead of spawning a second worker"
          },
          classification: "live",
          changed: false
        };
      }
    }
    const undelivered = run.pendingEvents.some((event) =>
      event.deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "failed")
    );
    return {
      run: {
        ...run,
        nextAction: undelivered
          ? "run is waiting for input and wake-up delivery is pending; answer via delegation_followup with the matching input-request id, or replay via delegation_read_result"
          : "run is waiting for input; answer via delegation_followup with the matching input-request id"
      },
      classification: "needs-input",
      changed: false
    };
  }
  const latest = run.attempts.at(-1);
  const alive = latest?.pid !== undefined && latest.processStartTime !== undefined &&
    isAlive(latest.pid, latest.processStartTime);
  if (alive) {
    return {
      run: { ...run, nextAction: "attempt process is alive; poll delegation_read_result or await the run-attention event" },
      classification: "live",
      changed: false
    };
  }
  const now = new Date().toISOString();
  const finishedAttempt: DelegationAttempt | undefined = latest
    ? { ...latest, finishedAt: now, state: "interrupted", summary: sanitizeSummary("process not alive on restart; classified interrupted, not failed") }
    : undefined;
  const attempts = finishedAttempt ? [...run.attempts.slice(0, -1), finishedAttempt] : run.attempts;
  const interruptedEvent: DelegationPendingEvent = {
    eventId: stableEventId(run.runId, run.seq + 1),
    seq: run.seq + 1,
    state: "interrupted",
    summary: "run interrupted before completion",
    createdAt: now,
    deliveries: []
  };
  const next: DelegationRunRecord = {
    ...run,
    state: "interrupted",
    seq: run.seq + 1,
    attempts,
    pendingEvents: [...run.pendingEvents, interruptedEvent].slice(-DELEGATION_BOUNDS.maxPendingEventsPerRun),
    nextAction: "run was interrupted (process gone); inspect excerpts via delegation_read_result; relaunch only with a NEW request id, never an implicit restart"
  };
  return { run: next, classification: "interrupted", changed: true };
}

export function nextActionFor(state: DelegationRunState, undelivered: boolean): string {
  if (state === "running" || state === "queued") return "poll delegation_read_result or await the run-attention event";
  if (state === "needs-input") return "answer via delegation_followup with the matching input-request id";
  if (undelivered) return "terminal result stored but wake-up delivery is pending; replay via delegation_read_result";
  if (state === "interrupted") return "inspect excerpts via delegation_read_result; relaunch only with a NEW request id";
  return "read the terminal result via delegation_read_result";
}

/**
 * Crash-safe pending dispatch helpers (defect 5).
 *
 * stagePendingDispatch persists the answer BEFORE spawn without consuming it:
 * the request stays open, no applied checkpoint is recorded, and a queued
 * pending attempt reserves the attempt number. confirmPendingDispatch applies
 * the answer (answered mark + applied checkpoint + running attempt) only
 * after the spawn succeeds. On spawn failure the pending record stays and the
 * identical checkpoint id remains retryable (same attempt number, no
 * duplicate_conflicting). Pending records never count as consumed replies.
 */
export function stagePendingDispatch(
  run: DelegationRunRecord,
  opts: {
    checkpoint: CheckpointShape;
    requestId: string;
    attemptN: number;
    continuation: "resumed" | "new-continuation-attempt";
    resumeSessionId?: string;
    timeoutMs: number;
    prompt: string;
    sessionEvidence: string;
  }
): DelegationRunRecord {
  const now = new Date().toISOString();
  const pending: DelegationPendingDispatch = {
    checkpointId: opts.checkpoint.id,
    requestId: opts.requestId,
    seq: opts.checkpoint.seq,
    payload: opts.checkpoint.payload,
    attemptN: opts.attemptN,
    continuation: opts.continuation,
    ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
    timeoutMs: opts.timeoutMs,
    prompt: opts.prompt,
    sessionEvidence: opts.sessionEvidence,
    storedAt: now,
    state: "pending-dispatch"
  };
  // Reuse the same attempt number when retrying the identical pending id;
  // otherwise append a fresh queued pending attempt.
  const existingPending = run.attempts.find(
    (a) => a.n === opts.attemptN && a.state === "queued" && a.summary?.includes("pending dispatch")
  );
  const pendingAttempt = {
    n: opts.attemptN,
    startedAt: now,
    state: "queued" as DelegationRunState,
    ...(opts.resumeSessionId ? { sessionId: opts.resumeSessionId } : {}),
    continuation: opts.continuation,
    summary: sanitizeSummary(`pending dispatch for request ${opts.requestId} (checkpoint ${opts.checkpoint.id})`)
  };
  const attempts = existingPending
    ? run.attempts.map((a) => (a.n === opts.attemptN ? { ...pendingAttempt, startedAt: a.startedAt } : a))
    : [...run.attempts, pendingAttempt].slice(-DELEGATION_BOUNDS.maxAttemptsPerRun);
  return {
    ...run,
    pendingDispatch: pending,
    attempts,
    nextAction: "answer staged as pending-dispatch; dispatching continuation attempt"
  };
}

export function clearPendingDispatch(run: DelegationRunRecord): DelegationRunRecord {
  if (!run.pendingDispatch) return run;
  const { pendingDispatch: _dropped, ...rest } = run;
  // Drop the queued pending attempt (it was never dispatched, so it never
  // consumed budget beyond reservation; retry re-reserves the same number).
  const pendingN = (run.pendingDispatch as DelegationPendingDispatch).attemptN;
  const attempts = (rest as DelegationRunRecord).attempts.filter(
    (a) => !(a.n === pendingN && a.state === "queued" && a.summary?.includes("pending dispatch"))
  );
  return { ...(rest as DelegationRunRecord), attempts };
}

export function pendingDispatchFor(run: DelegationRunRecord, checkpointId: string): DelegationPendingDispatch | undefined {
  const pending = (run as DelegationRunRecord).pendingDispatch;
  if (pending && pending.checkpointId === checkpointId) return pending;
  return undefined;
}
