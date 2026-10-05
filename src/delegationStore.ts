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

export type DelegationEngine = "codex" | "opencode" | "claude";

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
  /**
   * Pre-launch artifact ownership reservation (codex worker-owned path).
   * Persisted BEFORE the worker spawns: the exact run+attempt-bound output
   * destination reserved for this attempt, whether the file already existed
   * at reservation time, and when the reservation was recorded. Finalize
   * binds a worker verdict ONLY when the reservation proves the file was
   * absent at reserve time (this attempt's namespace, nobody else's file);
   * a preoccupied, missing, or uncertain reservation reports unavailable.
   * Optional: attempts that predate reservations carry none and read
   * unavailable under the current standard.
   */
  artifactReservation?: {
    /** Workdir-relative reserved output destination for this attempt. */
    relPath: string;
    /** True when the file did NOT exist at reservation (clean slot). */
    absentAtReserve: boolean;
    /** ISO timestamp of the reservation (temporal baseline, not proof alone). */
    reservedAt: string;
    /**
     * Exclusive-claim proof: device + inode + creation time of the empty
     * placeholder this reservation exclusively created (O_EXCL + O_NOFOLLOW)
     * at the reserved path. Finalize binds a worker verdict ONLY when the
     * observed file still carries this identity (delete + recreate, even
     * with inode reuse, changes the creation time: replacement = foreign,
     * never claimed). Absent on reservations that predate claims: without
     * a claim the reservation proves absence at probe time only, never
     * ownership.
     */
    claim?: { dev: number; ino: number; birthtimeMs?: number };
  };
  /** Sanitized one-line outcome only. Never transcripts, prompts, or credentials. */
  summary?: string;
  /**
   * Per-attempt output artifact provenance: which workdir-relative file THIS
   * attempt produced (or preoccupied). Attempt N never reuses attempt N-1's
   * file as its result; the read path surfaces only the recorded path.
   * New artifacts always bind the FULL validated run identity plus the
   * attempt number: the filename carries the complete run_<16hex> id plus
   * the attempt number, so two runs sharing one workdir can never
   * cross-attribute even when their trailing hex collides. Legacy shared
   * names are never created anew and never read as present without this
   * record.
   */
  outputArtifact?: {
    /** Workdir-relative artifact path recorded at finalize. */
    relPath: string;
    /** Byte size observed at finalize (0 = empty/unavailable, never a slot). */
    bytes: number;
    /** True when this attempt exclusively created the file (O_EXCL). */
    created: boolean;
    /** Unavailable reason when bytes is 0 or the file was preoccupied. */
    reason?: string;
    /**
     * Provenance verdict at finalize: "created" (this attempt exclusively
     * created the file via O_EXCL), "worker" (a run-bound file the worker
     * wrote during this attempt: run_id namespace plus write-after-attempt-
     * start temporal proof), or "unavailable" (preoccupied, absent, or
     * empty: never presented as present). Absent on records that predate
     * this verdict (created:true still proves O_EXCL; created:false without
     * a worker verdict reads unavailable under the current standard).
     */
    provenance?: "created" | "worker" | "unavailable";
  };
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
  /**
   * Engine-returned live-steer thread id (codex steerable launches only:
   * the session UUID/name the engine persisted for a non-ephemeral run).
   * Ephemeral codex runs carry none (no steerable thread by construction);
   * opencode/claude runs carry none (no steer verb in the qualified CLI).
   * Steering queues only to this recorded id, never a synthesized one.
   */
  threadId?: string;
  /** How the thread id was evidenced (never synthesized). */
  threadEvidence?: string;
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
    /** True when the live 64KiB cap truncated the tail (explicit truncation flag). */
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
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
  /** Explicit OpenCode --agent / Claude --agent by real name (real tasks). */
  agent?: string;
  /** Adjudicated Codex sandbox for engine codex (explicit per-run wins over profile). */
  executionPolicy?: string;
  /** Explicit Claude --permission-mode (otherwise the agent/settings default governs). */
  permissionMode?: string;
  /** Explicit Claude --effort (otherwise the agent definition governs). */
  effort?: string;
  /** Explicit codex -m model override (real tasks only; canary never carries one). */
  modelOverride?: string;
  /** Explicit codex -c key=value overrides (real tasks only). */
  configOverrides?: string[];
  /** Explicit Claude --allowedTools / --disallowedTools text. */
  allowedTools?: string;
  disallowedTools?: string;
  /** Launch-time workdir listing baseline for non-repo snapshot diffs (bounded). Legacy: prefer workdirBaseline. */
  workdirSnapshot?: string[];
  /** True when the workdir was a git repo at launch (git-aware evidence). Legacy: prefer workdirBaseline. */
  workdirIsRepo?: boolean;
  /**
   * Launch-time baseline for attributable change evidence: listing snapshot,
   * content fingerprints (edits to existing files, including files git does
   * not track), and the git commit baseline (HEAD) where the workdir is a
   * repo. Runs that predate this field fall back to workdirSnapshot.
   */
  workdirBaseline?: {
    snapshot?: string[];
    fingerprints?: Array<{ path: string; sha256: string | null; mtimeMs: number; reason?: string }>;
    fingerprintsTruncated?: boolean;
    gitHead?: string | null;
    gitHeadReason?: string;
  };
  /**
   * Explicit session id supplied at launch (opencode ses-id or claude UUID),
   * "" when the caller omitted one (claude mints a stable UUID afterwards;
   * opencode leaves minting to the worker). Present on runs launched after
   * this field; legacy runs predate it and keep the old session rule (an
   * omitted/minted session never conflicts; only a differing explicit
   * candidate id conflicts with the observed session).
   */
  requestedSessionId?: string;
  /** Separate explicit per-run opt-in to --dangerously-bypass-approvals-and-sandbox (codex danger only). */
  bypassApprovals?: boolean;
  /**
   * OpenCode execution route at launch: "standalone" runs a private server
   * (`opencode run --standalone`); "shared-service" uses the background
   * service (pre-standalone launches). Absent on run files that predate this
   * field, which are honestly treated as shared-service (labeled, never
   * silently converted). Only meaningful for engine opencode.
   */
  opencodeRoute?: "standalone" | "shared-service";
  /**
   * Explicit steerable opt-in (codex real tasks only): the launch ran
   * without --ephemeral so the session persists and the engine may return
   * an addressable thread id (recorded on session.threadId when observed).
   * Profile + execution-policy boundaries are unchanged; the default stays
   * ephemeral. Absent/false on runs that predate this field (ephemeral).
   */
  steerable?: boolean;
  /**
   * Last cancel verification for this run (persisted so an incomplete or
   * uncertain cancel stays incomplete until a later cancel re-verifies live;
   * a repeated cancel never converts it into success from cache). Optional:
   * runs that were never cancelled carry no record.
   */
  lastCancelVerification?: {
    at: string;
    cleanupFinished: boolean;
    verificationComplete: boolean;
    remainingPids: number[];
    quiesced: boolean;
    quiescenceChecked: boolean;
    reason?: string;
    /**
     * Descendant PID+starttime identities enumerated while the root was
     * alive at cancel time (the full owned tree, not just the attempt
     * root). A repeated cancel rechecks THESE identities live (never a
     * cached success); an exited root can therefore never hide a surviving
     * reparented descendant. Empty when no live enumeration ever happened
     * (pid-less or stale-root cancel), which keeps repeat verification
     * incomplete until a live enumeration grounds it.
     */
    ownedTreeMembers?: Array<{ pid: number; startTime: string }>;
  };
  /** Resolved worker executable at launch (provenance: shim vs live is judged from binaryOverridden, never guessed). */
  executable?: string;
  /** True when a CODEXPRO_*_BIN override selected the executable at launch (test shims ride this route). */
  binaryOverridden?: boolean;
  /** Clamped canary attempt timeout reused for continuations. Optional. */
  attemptTimeoutMs?: number;
  /**
   * Crash-safe pending dispatch: the staged answer persisted BEFORE spawn.
   * While present the reply is NOT consumed (request stays open, no answered
   * mark, no applied checkpoint). On spawn success the pending is confirmed
   * into an applied checkpoint + running attempt; on observed spawn failure
   * it stays pending with lastDispatchError (the identical checkpoint id
   * remains retryable). On crash between spawn success and pid save the
   * persisted record is pid-less with NO lastDispatchError: dispatch outcome
   * is uncertain (possible orphan) and retry must fail closed as
   * dispatch_uncertain/launch_uncertain (inspect + cancel/replay, never a
   * second worker). The same staging applies to initial launch (isLaunch):
   * the launch request id is reserved as pending BEFORE spawn; a
   * crash-before-save leaves a pid-less pending launch that retry must not
   * relaunch. Optional: runs without a pending dispatch predate this field.
   */
  pendingDispatch?: DelegationPendingDispatch;
  /**
   * Durable live-steering record: one entry per accepted steering_key.
   * Idempotency: the same key with the same content replays the stored
   * outcome (no second dispatch); the same key with changed content is a
   * conflict (never dispatched); an uncertain dispatch stays uncertain
   * until reconciled (a retry reuses the same key and never duplicates).
   * Status vocabulary: stored-local (recorded, engine not yet called) >
   * queued (the engine confirmed the message is held for the worker) |
   * rejected (the engine refused) | unknown (timeout/lost reply/ambiguous
   * output). applied is claimed ONLY on worker-observable evidence (worker
   * output observed after the queue time), never from queued alone.
   * Optional: runs that were never steered carry no record.
   */
  steering?: DelegationSteeringRecord[];
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One durable live-steering request. The message that reached (or failed to
 * reach) ONLY its intended run: run binding is verified at dispatch and the
 * engine call addresses only the run's recorded thread/session id.
 * threadId binds the exact engine thread queued to (same attempt/thread
 * correlation for applied); absent on records that predate thread binding
 * (unverifiable, never promoted to applied).
 */
export interface DelegationSteeringRecord {
  /** Caller-supplied idempotency key (bounded, per-run unique). */
  steeringKey: string;
  /** SHA-256 hex of the exact message text (conflict detection, never the text). */
  messageHash: string;
  /** Message length in chars (bounded; the text itself is not persisted). */
  messageChars: number;
  /** Attempt number live at dispatch (which worker turn was steered). */
  attemptN: number;
  /**
   * Exact engine thread id queued to (codex steerable only). Binds applied
   * correlation to the same attempt/thread; a record without it (legacy or
   * non-codex) never promotes to applied.
   */
  threadId?: string;
  status: "stored-local" | "queued" | "applied" | "rejected" | "unknown";
  /** Engine-observed evidence excerpt for the status (never synthesized). */
  engineEvidence?: string;
  /** Worker-observable evidence for applied (never claimed without it). */
  appliedEvidence?: string;
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
  /**
   * True for initial-launch staging (checkpointId === launch request id, no
   * input request). Follow-up staging omits this flag.
   */
  isLaunch?: boolean;
  /**
   * Observed spawn-failure marker: set ONLY when a spawn attempt was
   * observed to fail synchronously or via spawn acknowledgement BEFORE any
   * pid was persisted. A pending WITH this marker is explicitly retryable
   * (same id, same attemptN). A pid-less pending WITHOUT it is uncertain
   * (crash between spawn success and pid save is possible) and must fail
   * closed, never auto-spawn a second worker.
   */
  lastDispatchError?: string;
  /**
   * Ambiguous post-spawn marker: set ONLY when a child was successfully
   * spawned but run-identity persistence then failed (the worker may exist
   * as a pid-less orphan). While pid-less, an ambiguous pending stays
   * UNCERTAIN (fail closed, never auto-spawn) even when a failure marker
   * was also persisted afterwards: a persisted error marker cannot prove
   * a live child does not exist. Never set for a proven pre-spawn failure
   * (spawn threw, no child), which stays explicitly retryable instead.
   */
  spawnAmbiguous?: boolean;
  /**
   * Sanitized diagnosis recorded with the ambiguity marker (never a
   * credential or transcript). Audit only; retry decisions key off
   * spawnAmbiguous + pid-less state, never this text.
   */
  spawnAmbiguousError?: string;
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
  minAttemptTimeoutMs: 10_000,
  // Live steering: one run cannot accumulate unbounded steering records;
  // 16 cap keeps the run file small (key + hash + status only, never text).
  // The cap is enforced by REFUSAL (never silent eviction): a new distinct
  // key past the bound refuses with a truthful bound error, while retries
  // of retained keys (identical replay, conflicting re-use, uncertain
  // reconciliation) always resolve against durable state and never dispatch
  // a second engine call. Run-lifetime dedup is therefore preserved.
  maxSteeringPerRun: 16
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

/**
 * Canonical subscription authority dir: derived from the SERVER defaultRoot
 * (plus the workspace-relative context dir), shared across ALL permitted
 * workspaces. Official protocol subscribe (POST /mcp events/subscribe,
 * delegationProtocol.ts) stores here; completion delivery lookup MUST read
 * here too, while run state stays in the run workspace bridge dir. Deriving
 * strictly from defaultRoot keeps every authority read inside allowedRoots
 * (defaultRoot is always an allowed root by construction).
 */
export function authorityBridgeDirFor(defaultRoot: string, contextDir: string): string {
  try {
    return path.join(fs.realpathSync.native(defaultRoot), contextDir);
  } catch {
    return path.join(defaultRoot, contextDir);
  }
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
  /**
   * Canonical absolute workdir for identity. The SAME request id with a
   * DIFFERENT canonical directory is a conflicting re-use
   * (duplicate_conflicting), never a replay of the old run. Compare via
   * canonicalizeWorkdirForCompare (realpath when the path exists).
   */
  workdir?: string;
  /** Real-task identity: selected agent (opencode/claude), Codex sandbox, Claude permission/effort. */
  agent?: string;
  executionPolicy?: string;
  permissionMode?: string;
  effort?: string;
  /** Explicit codex -m model override (real tasks only). */
  modelOverride?: string;
  /** Explicit codex -c key=value overrides (order-sensitive, real tasks only). */
  configOverrides?: string[];
  /** Explicit Claude --allowedTools / --disallowedTools text. */
  allowedTools?: string;
  disallowedTools?: string;
  /** Separate explicit per-run bypass opt-in (codex danger only). */
  bypassApprovals?: boolean;
}

/**
 * Canonicalize a workdir for request-identity comparison: the realpath when
 * the path exists (resolves symlinks and spelling variants to one canonical
 * directory), otherwise the resolved absolute path. Never throws.
 */
export function canonicalizeWorkdirForCompare(workdir: string): string {
  const text = String(workdir ?? "");
  if (!text) return text;
  try {
    return fs.realpathSync.native(path.resolve(text));
  } catch {
    try {
      return path.resolve(text);
    } catch {
      return text;
    }
  }
}

/**
 * Conflicting-payload guard for launch idempotency. The same request id with
 * identical worker-input content replays (no second worker); the same id with
 * different task/group/model content is a conflicting re-use and must be
 * rejected with duplicate_conflicting (no new worker, nothing consumed).
 * The canonical workdir IS identity: the same request id with a different
 * canonical directory is a conflicting re-use (duplicate_conflicting), never
 * a replay of the old run. Only the timeout stays non-identity (retries may
 * restate it). EVERY other launch-affecting setting is identity: engine, profile/agent,
 * model AND model/config overrides, tool filters (allowed/disallowed),
 * execution policy, permission mode, effort, bypass opt-in, session
 * selection, task, group, canary flag. A different value in any of them is a
 * different worker and refuses (no second worker, no silent reuse).
 * Backward compatibility for run files that predate a field: agent,
 * execution policy, permission mode, and effort are compared only when the
 * STORED run carries them, so an absent stored field never turns an
 * idempotent replay (or an uncertain-dispatch retry) into a conflict. Newer
 * identity fields (model/config overrides, tool filters, bypass) compare
 * symmetrically (absent means not selected): selecting a setting the stored
 * run did not select is a changed launch and refuses rather than silently
 * reusing the old worker. Session selection: runs launched after
 * requestedSessionId compare strictly in both directions (explicit X vs
 * omitted is a changed selection and refuses); legacy runs without the
 * marker keep the old rule (only a differing explicit candidate id conflicts
 * with the observed session; an omitted session never conflicts).
 */
export function isLaunchRequestConflict(existing: DelegationRunRecord, candidate: LaunchConflictCandidate): boolean {
  if (existing.engine !== candidate.engine) return true;
  if (existing.delegationGroup !== candidate.delegationGroup) return true;
  const existingCanary = existing.isCanary !== false;
  if (existingCanary !== candidate.isCanary) return true;
  if (!candidate.isCanary && (existing.task ?? "") !== (candidate.task ?? "")) return true;
  // Canonical workdir IS identity: the same request id with a different
  // canonical directory is a conflicting re-use, never a replay. Stored runs
  // always carry workdir; a stored record that somehow predates the field
  // keeps the legacy wildcard (absent stored workdir never conflicts) so old
  // replays cannot turn into conflicts.
  if (candidate.workdir !== undefined && existing.workdir !== undefined) {
    if (canonicalizeWorkdirForCompare(existing.workdir) !== canonicalizeWorkdirForCompare(candidate.workdir)) return true;
  }
  if (candidate.engine === "codex") {
    if ((existing.profile ?? "") !== (candidate.profile ?? "")) return true;
    // Stored-guarded (legacy wildcard): Leaf 1/2 run files predate these
    // fields, and an absent stored field must not turn an idempotent replay
    // (or an uncertain-dispatch retry) into a conflict.
    if (existing.executionPolicy !== undefined &&
      (existing.executionPolicy ?? "") !== (candidate.executionPolicy ?? "")) return true;
    // Symmetric: absent means not selected. A model/config/bypass setting
    // the stored run did not select is a changed launch and refuses rather
    // than silently reusing the old worker.
    if ((existing.modelOverride ?? "") !== (candidate.modelOverride ?? "")) return true;
    if ((existing.configOverrides ?? []).join("\0") !== (candidate.configOverrides ?? []).join("\0")) return true;
    if (Boolean(existing.bypassApprovals) !== Boolean(candidate.bypassApprovals)) return true;
  }
  if (candidate.engine === "opencode") {
    if ((existing.model ?? "") !== (candidate.model ?? "")) return true;
    if (existing.agent !== undefined && (existing.agent ?? "") !== (candidate.agent ?? "")) return true;
  }
  if (candidate.engine === "claude") {
    if (existing.agent !== undefined && (existing.agent ?? "") !== (candidate.agent ?? "")) return true;
    if ((existing.model ?? "") !== (candidate.model ?? "")) return true;
    if (existing.permissionMode !== undefined && (existing.permissionMode ?? "") !== (candidate.permissionMode ?? "")) return true;
    if (existing.effort !== undefined && (existing.effort ?? "") !== (candidate.effort ?? "")) return true;
    if ((existing.allowedTools ?? "") !== (candidate.allowedTools ?? "")) return true;
    if ((existing.disallowedTools ?? "") !== (candidate.disallowedTools ?? "")) return true;
  }
  if (candidate.engine !== "codex") {
    if (existing.requestedSessionId !== undefined) {
      if ((existing.requestedSessionId ?? "") !== (candidate.sessionId ?? "")) return true;
    } else {
      const candidateSession = candidate.sessionId ?? "";
      if (candidateSession && (existing.session?.sessionId ?? "") !== candidateSession) return true;
    }
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
    teardownRunArtifacts(victim);
  }
}

/**
 * Bounded lifecycle for retained worker-output artifacts (Finding 5):
 * run-bound last-message files (`<stem>-<16hex>-attempt-<N>[-x<i>].<ext>`)
 * are retained only while their run is retained (max 32 runs/workspace).
 * When a terminal run is pruned from central storage, its OWN exact
 * run-bound artifacts are torn down from its workdir via exact-name match
 * only (full 16-hex identity + attempt, never task code, never other runs,
 * never fixtures, never bridge/subscription state). Temp atomic-write
 * siblings (`.<name>.<pid>.<ts>.tmp`) are already removed in their finally
 * paths; empty reservation placeholders for pruned runs are covered here
 * (they carry the same run-bound name). Never throws; never touches
 * `.ai-bridge` subscription state, security material, or anything outside
 * the victim's workdir artifact namespace. Exported for the focused
 * regression proof.
 */
export function teardownRunArtifacts(run: DelegationRunRecord): { removed: string[] } {
  const removed: string[] = [];
  const runId = String((run as { runId?: unknown })?.runId ?? "");
  const workdir = String((run as { workdir?: unknown })?.workdir ?? "");
  const m = /^run_([0-9a-f]{16})$/.exec(runId);
  if (!m || !workdir) return { removed };
  const short = m[1];
  let entries: string[];
  try {
    const stat = fs.statSync(workdir);
    if (!stat.isDirectory()) return { removed };
    entries = fs.readdirSync(workdir);
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.includes(`-${short}-attempt-`)) continue;
    if (!/^(codex|opencode|claude)-last-message-[0-9a-f]{16}-attempt-\d+(-x\d+)?\.(md|json)$/.test(entry)) continue;
    if (entry.includes("..") || path.isAbsolute(entry)) continue;
    const abs = path.join(workdir, entry);
    try {
      const lst = fs.lstatSync(abs);
      if (!lst.isFile() && !lst.isSymbolicLink()) continue;
      fs.rmSync(abs, { force: true });
      removed.push(entry);
    } catch { /* best effort; never throws */ }
  }
  return { removed };
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
  classification: "live" | "interrupted" | "completed-awaiting-delivery" | "terminal" | "needs-input" | "uncertain";
  changed: boolean;
}

/**
 * Honest restart reconciliation. Never auto-restarts a potentially mutating
 * task: a dead running attempt becomes `interrupted` with an explicit next
 * action, never a silent relaunch. A pid-less pending dispatch with no
 * observed failure marker is `uncertain` (crash between spawn success and
 * pid save is possible): it never auto-spawns and never silently becomes
 * interrupted (which would invite a NEW request id while a pid-less orphan
 * may still run). Explicit recover only: inspect + cancel/replay.
 */
export function reconcileRunState(run: DelegationRunRecord, isAlive: LivenessProbe): ReconcileResult {
  const undelivered = run.pendingEvents.some(isEventUndelivered);
  const noTarget = run.pendingEvents.some((event) => event.deliveries.length === 0);
  if (DELEGATION_TERMINAL_STATES.has(run.state)) {
    if (run.state === "completed" && undelivered) {
      return {
        run: {
          ...run,
          nextAction: noTarget
            ? "terminal result stored but wake-up has no delivery targets; attach current matching targets via delegation_replay_events"
            : "terminal result stored but wake-up delivery is pending; replay via delegation_read_result or wait for redelivery"
        },
        classification: "completed-awaiting-delivery",
        changed: false
      };
    }
    return { run, classification: "terminal", changed: false };
  }
  // Fail-closed crash window: a staged dispatch that never persisted a pid
  // and never observed a spawn failure is uncertain. The stagedAlivePid gate
  // alone is insufficient: with no pid there is nothing to probe, and a
  // prior spawn may still run as a pid-less orphan. Never auto-spawn, never
  // silently mark interrupted (which would invite a NEW request id while the
  // orphan may live). Explicit recover only.
  if (run.pendingDispatch && isUncertainDispatch(run)) {
    const launchHint = run.pendingDispatch.isLaunch
      ? "initial launch dispatch is uncertain (crash between spawn and pid save is possible); inspect via delegation_read_result, cancel any orphan via delegation_cancel, then relaunch only with explicit recover (never auto-spawn)"
      : "follow-up dispatch is uncertain (crash between spawn and pid save is possible); inspect via delegation_read_result, cancel any orphan via delegation_cancel, then replay only with explicit recover (never auto-spawn a second worker)";
    return {
      run: { ...run, nextAction: launchHint },
      classification: "uncertain",
      changed: false
    };
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
    const undeliveredNeedsInput = run.pendingEvents.some(isEventUndelivered);
    return {
      run: {
        ...run,
        nextAction: undeliveredNeedsInput
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
  // Legacy crash window (pre-pending launches): a running/queued attempt
  // that never persisted a pid is uncertain, not interrupted. Marking it
  // interrupted would invite a NEW request id while a pid-less orphan may
  // still run. Fail closed with explicit recover.
  if ((run.state === "running" || run.state === "queued") && isRunPidLess(run) && !run.pendingDispatch) {
    return {
      run: {
        ...run,
        nextAction: "initial launch dispatch is uncertain (no pid was ever persisted; crash between spawn and pid save is possible); inspect via delegation_read_result, cancel any orphan via delegation_cancel, then relaunch only with explicit recover (never auto-spawn)"
      },
      classification: "uncertain",
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

export function nextActionFor(state: DelegationRunState, undelivered: boolean, noTarget = false): string {
  if (state === "running" || state === "queued") return "poll delegation_read_result or await the run-attention event";
  if (state === "needs-input") return "answer via delegation_followup with the matching input-request id";
  if (undelivered) return noTarget
    ? "terminal result stored but wake-up has no delivery targets; attach current matching targets via delegation_replay_events"
    : "terminal result stored but wake-up delivery is pending; replay via delegation_read_result";
  if (state === "interrupted") return "inspect excerpts via delegation_read_result; relaunch only with a NEW request id";
  return "read the terminal result via delegation_read_result";
}

/**
 * Truthful undelivered predicate: an event is undelivered when it carries
 * pending/failed deliveries OR when it has no delivery targets at all. A
 * stored event with zero targets must NEVER read as silent 0-delivered: it
 * is no-targets-pending until an explicit replay attaches current matching
 * targets (see delegation_replay_events).
 */
export function isEventUndelivered(event: DelegationPendingEvent): boolean {
  if (event.deliveries.length === 0) return true;
  return event.deliveries.some((delivery) => delivery.status === "pending" || delivery.status === "failed");
}

/** Stored events with zero delivery targets (explicit no-target state). */
export function noTargetEvents(run: DelegationRunRecord): DelegationPendingEvent[] {
  return run.pendingEvents.filter((event) => event.deliveries.length === 0);
}

/** All truthfully undelivered events (pending/failed deliveries OR no targets). */
export function undeliveredEvents(run: DelegationRunRecord): DelegationPendingEvent[] {
  return run.pendingEvents.filter(isEventUndelivered);
}

/**
 * Crash-safe pending dispatch helpers (defect 5 + initial-launch crash window).
 *
 * stagePendingDispatch persists the answer BEFORE spawn without consuming it:
 * the request stays open, no applied checkpoint is recorded, and a queued
 * pending attempt reserves the attempt number. confirmPendingDispatch applies
 * the answer (answered mark + applied checkpoint + running attempt) only
 * after the spawn succeeds. On OBSERVED spawn failure the pending record
 * stays with lastDispatchError and the identical checkpoint id remains
 * retryable (same attempt number, no duplicate_conflicting). A pid-less
 * pending WITHOUT lastDispatchError is uncertain (crash between spawn
 * success and pid save is possible) and must fail closed, never auto-spawn.
 * Pending records never count as consumed replies.
 *
 * stagePendingLaunch applies the same discipline to initial launch: the
 * launch request id is reserved as pending BEFORE spawn (queued attempt 1).
 * Crash-before-save leaves a pid-less pending launch that retry must not
 * relaunch (dispatch_uncertain/launch_uncertain, explicit recover only).
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
    isLaunch?: boolean;
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
    state: "pending-dispatch",
    ...(opts.isLaunch ? { isLaunch: true as const } : {})
  };
  // Reuse the same attempt number when retrying the identical pending id;
  // otherwise append a fresh queued pending attempt. A restage preserves an
  // existing observed-failure marker only when the caller does not replace
  // it: a fresh stage starts uncertain (no marker) until a failure is
  // observed and marked via markPendingDispatchFailed.
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
    nextAction: opts.isLaunch
      ? "launch staged as pending-dispatch; dispatching initial attempt"
      : "answer staged as pending-dispatch; dispatching continuation attempt"
  };
}

/**
 * Stage a pending dispatch for initial launch (reserve attempt 1 BEFORE
 * spawn). The launch request id doubles as the checkpoint id: there is no
 * input request to answer, only the idempotency reservation. The persisted
 * pending makes a crash-before-save explicitly uncertain on retry.
 */
export function stagePendingLaunch(
  run: DelegationRunRecord,
  opts: {
    requestId: string;
    attemptN: number;
    timeoutMs: number;
    prompt: string;
    sessionEvidence: string;
  }
): DelegationRunRecord {
  return stagePendingDispatch(run, {
    checkpoint: { id: opts.requestId, run_id: run.runId, seq: 0, payload: {} },
    requestId: opts.requestId,
    attemptN: opts.attemptN,
    continuation: "new-continuation-attempt",
    timeoutMs: opts.timeoutMs,
    prompt: opts.prompt,
    sessionEvidence: opts.sessionEvidence,
    isLaunch: true
  });
}

/** True when an attempt never persisted PID+starttime identity. */
export function isPidLessAttempt(attempt: DelegationAttempt | undefined): boolean {
  if (!attempt) return true;
  return attempt.pid === undefined || attempt.processStartTime === undefined;
}

/** True when the latest attempt never persisted PID+starttime identity. */
export function isRunPidLess(run: DelegationRunRecord): boolean {
  return isPidLessAttempt(run.attempts.at(-1));
}

/**
 * Uncertain dispatch predicate: a staged pending whose latest attempt is
 * pid-less AND no spawn failure was ever observed (no lastDispatchError).
 * The stagedAlivePid liveness gate alone is insufficient here: with no pid
 * there is nothing to probe, and a prior spawn may still run as a pid-less
 * orphan. Uncertain retries must fail closed (dispatch_uncertain /
 * launch_uncertain), never auto-spawn a second worker.
 *
 * Two refinements keep the predicate truthful after a spawn-failure fix:
 * - spawnAmbiguous (child spawned OK, then identity persistence failed)
 *   stays uncertain while pid-less EVEN when a failure marker was also
 *   persisted afterwards: the marker proves an error was recorded, never
 *   that no child exists.
 * - Initial-launch staging (isLaunch) is pid-less + marker = uncertain: a
 *   non-terminal pid-less launch reservation can never prove pre-spawn
 *   (the observed-failure path for launches resolves to terminal failed
 *   with the reservation cleared, never to a marked non-terminal pending),
 *   so any surviving pid-less launch pending fails closed.
 * A proven pre-spawn follow-up failure (spawn threw synchronously or the
 * spawn acknowledgement failed with no child, marker set, no ambiguity)
 * stays explicitly retryable: same id, same attempt number.
 */
export function isUncertainDispatch(run: DelegationRunRecord): boolean {
  const pending = run.pendingDispatch;
  if (!pending) return false;
  if (pending.spawnAmbiguous) return isRunPidLess(run);
  if (pending.isLaunch) return isRunPidLess(run);
  if (pending.lastDispatchError) return false;
  return isRunPidLess(run);
}

/**
 * Mark an observed spawn failure on the staged pending (sync throw or async
 * spawn acknowledgement failure BEFORE any pid was persisted). The pending
 * stays with the marker, the request stays open, and the identical id
 * remains retryable with the same attempt number. Never marks applied or
 * consumed. The caller persists the returned run before returning
 * dispatch_pending.
 */
export function markPendingDispatchFailed(run: DelegationRunRecord, errorMessage: string): DelegationRunRecord {
  const pending = run.pendingDispatch;
  if (!pending) return run;
  return {
    ...run,
    pendingDispatch: {
      ...pending,
      lastDispatchError: sanitizeSummary(errorMessage || "spawn failed before attempt start")
    },
    nextAction: "answer staged as pending-dispatch but the last spawn attempt failed before start; retry the identical reply id (same attempt number)"
  };
}

/**
 * Mark an ambiguous post-spawn outcome on the staged pending: the child was
 * successfully spawned, but run-identity (pid) persistence then failed, so a
 * pid-less orphan may exist. The pending stays WITHOUT lastDispatchError
 * (no proven pre-spawn claim) and gains spawnAmbiguous, which keeps same-id
 * retry uncertain while pid-less even if a failure marker is persisted
 * later. Never marks applied or consumed. The caller persists the returned
 * run before returning dispatch_uncertain.
 */
export function markAmbiguousSpawn(run: DelegationRunRecord, errorMessage: string): DelegationRunRecord {
  const pending = run.pendingDispatch;
  if (!pending) return run;
  return {
    ...run,
    pendingDispatch: {
      ...pending,
      spawnAmbiguous: true as const,
      spawnAmbiguousError: sanitizeSummary(errorMessage || "spawn succeeded but run identity persistence failed")
    },
    nextAction: "dispatch outcome is uncertain (spawn succeeded but run identity was not persisted; a pid-less orphan may exist); inspect via delegation_read_result, cancel any orphan via delegation_cancel, then replay only with explicit recover (never auto-spawn a second worker)"
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

/** Storage input for delegation run/subscription dirs (primitives only). */
export interface DelegationStorageConfig {
  /** Service user-data root (CODEXPRO_DELEGATION_DIR, default ~/.codexpro/delegation). */
  delegationDir: string;
  /** Explicit opt-in to the legacy workspace .ai-bridge layout. Default false. */
  legacyBridge: boolean;
  /** Legacy workspace-relative bridge dirname (e.g. .ai-bridge). */
  contextDir: string;
  /** Current server bearer token, when set (owner identity input). */
  authToken?: string;
  /** Local owner tuple `${uid}:${defaultRoot}` (owner identity input). */
  localOwner: string;
  /** Server default root (subscription-authority input). */
  defaultRoot: string;
}

export interface DelegationStorageDirs {
  /** Where run files for this (owner, workspace) persist. */
  runBridgeDir: string;
  /** Canonical subscription authority for this (owner, server root). */
  authorityDir: string;
  /** True only under the explicit legacy opt-in. */
  legacy: boolean;
  /** Migrations performed by this resolution (usually []). */
  migrations: DelegationMigration[];
}

export interface DelegationMigration {
  from: string;
  to: string;
  workspaceCanonical: string;
  runFiles: number;
  subscriptions: boolean;
  at: string;
  receipt: string;
}

export const DELEGATION_MIGRATION_RECEIPT = "delegation-migration.json";
/** Current migration receipt version: 2 carries expected counts + hashes. */
export const DELEGATION_MIGRATION_RECEIPT_VERSION = 2;

export interface DelegationMigrationReceipt {
  version: number;
  from: string;
  to: string;
  runFiles: number;
  /** Expected SHA-256 hex per run file name (e.g. run_abc.json -> hex). */
  runFileHashes: Record<string, string>;
  subscriptions: boolean;
  /** Sorted legacy subscription ids expected in the destination authority. */
  subscriptionIds: string[];
  /** SHA-256 hex of the canonical legacy subscription list, or null when none. */
  subsHash: string | null;
  at: string;
}

function realDirOrInput(input: string): string {
  try {
    return fs.realpathSync.native(input);
  } catch {
    return input;
  }
}

/** Local owner tuple for delegation storage identity. */
export function localOwnerFor(defaultRoot: string): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  return `${uid}:${defaultRoot}`;
}

function ownerScopeFor(cfg: DelegationStorageConfig): string {
  const owner = ownerIdFor(cfg.authToken, cfg.localOwner);
  return `${owner.ownerKind}-${owner.ownerIdHash}`;
}

function workspaceScopeFor(canonicalRoot: string): string {
  return createHash("sha256").update(realDirOrInput(canonicalRoot), "utf8").digest("hex").slice(0, 32);
}

/** Pure run-state dir for one (owner, workspace): no IO, no migration. */
export function resolveDelegationRunBridgeDir(cfg: DelegationStorageConfig, workspaceCanonical: string): string {
  if (cfg.legacyBridge) return path.join(realDirOrInput(workspaceCanonical), cfg.contextDir);
  return path.join(cfg.delegationDir, ownerScopeFor(cfg), "workspaces", workspaceScopeFor(workspaceCanonical));
}

/** Pure canonical subscription authority dir for one (owner, server root). */
export function resolveDelegationAuthorityDir(cfg: DelegationStorageConfig): string {
  if (cfg.legacyBridge) return authorityBridgeDirFor(cfg.defaultRoot, cfg.contextDir);
  return path.join(cfg.delegationDir, ownerScopeFor(cfg), "workspaces", workspaceScopeFor(cfg.defaultRoot));
}

function runFileNames(bridgeDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(delegationRunsDir(bridgeDir));
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.endsWith(".json") && !entry.startsWith(".")).sort();
}

function hasSubscriptionsFile(bridgeDir: string): boolean {
  try {
    fs.accessSync(subscriptionsPath(bridgeDir), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256HexBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function atomicWriteBytes(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on odd fs */ }
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function atomicWriteReceipt(filePath: string, receipt: DelegationMigrationReceipt): void {
  atomicWriteBytes(filePath, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
}

/** Read the migration receipt when present, or undefined when absent/unparseable. */
export function readDelegationMigrationReceipt(newBridgeDir: string): DelegationMigrationReceipt | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(newBridgeDir, DELEGATION_MIGRATION_RECEIPT), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return undefined;
    return parsed as unknown as DelegationMigrationReceipt;
  } catch {
    return undefined;
  }
}

interface ParsedSubscriptions {
  ids: string[];
  byId: Map<string, Record<string, unknown>>;
  hash: string | null;
}

function parseSubscriptionsBytes(bytes: Buffer): ParsedSubscriptions {
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed) || !Array.isArray((parsed as { subscriptions?: unknown }).subscriptions)) {
      return { ids: [], byId: new Map(), hash: sha256HexBytes(bytes) };
    }
    const list = (parsed as { subscriptions: Array<Record<string, unknown>> }).subscriptions;
    const byId = new Map<string, Record<string, unknown>>();
    for (const entry of list) {
      if (entry && typeof entry === "object" && typeof (entry as { subId?: unknown }).subId === "string") {
        byId.set((entry as { subId: string }).subId, entry as Record<string, unknown>);
      }
    }
    const ids = [...byId.keys()].sort();
    const canonical = stableStringify(ids.map((id) => byId.get(id)));
    return { ids, byId, hash: createHash("sha256").update(canonical, "utf8").digest("hex") };
  } catch {
    return { ids: [], byId: new Map(), hash: sha256HexBytes(bytes) };
  }
}

/**
 * Merge legacy subscriptions into the destination authority by subId.
 * Legacy entries win on the same subId (source of truth for migrated
 * records); destination-only entries are preserved (no lost authority).
 * Secrets stay inside the authority file only: only sub records are merged,
 * never copied into run files, and the receipt records hashes/ids only
 * (never secret bytes). Pure apart from the returned list.
 */
export function mergeSubscriptionsById(
  destSubs: Array<Record<string, unknown>>,
  legacySubs: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of destSubs) {
    const id = (entry as { subId?: unknown })?.subId;
    if (typeof id === "string") byId.set(id, entry);
  }
  for (const entry of legacySubs) {
    const id = (entry as { subId?: unknown })?.subId;
    if (typeof id === "string") byId.set(id, entry);
  }
  return [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

function loadSubscriptionRecords(bridgeDir: string): Array<Record<string, unknown>> {
  try {
    const bytes = fs.readFileSync(subscriptionsPath(bridgeDir));
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed) || !Array.isArray((parsed as { subscriptions?: unknown }).subscriptions)) return [];
    return (parsed as { subscriptions: Array<Record<string, unknown>> }).subscriptions.filter(
      (s) => s && typeof (s as { subId?: unknown }).subId === "string"
    );
  } catch {
    return [];
  }
}

/**
 * Final completion predicate: a well-formed v2 receipt for this (from,to)
 * pair proves migration completion FINALLY. The receipt is published
 * atomically LAST only after full publish-time verification (counts + hashes
 * + ids verified in ensureDelegationStorage), so its expected counts/hashes/
 * ids are bound to that publish-time verification for audit. Reopen finality
 * does NOT re-compare current dest bytes to legacy bytes: ordinary dest
 * changes after completion (run updates, checkpoint/delivery history,
 * unsubscribe, subscription edits) must never trigger re-reconciliation,
 * and legacy files remain untouched (never deleted/modified).
 *
 * Well-formed means: version 2, from/to resolve to this exact pair, and the
 * expected audit fields are present with the right shapes (runFileHashes
 * record, subscriptionIds string array, subsHash string|null, runFiles
 * non-negative integer, subscriptions boolean). Anything else (no receipt,
 * unparseable, version mismatch, from-to mismatch, missing expected fields)
 * is interrupted and must be recovered by an incremental retry (copy
 * missing/differing runs only, merge subs by id, verify, publish receipt
 * last). Never trusts "any dest file exists".
 */
export function isMigrationReceiptComplete(
  legacyBridgeDir: string,
  newBridgeDir: string,
  receipt: DelegationMigrationReceipt | undefined
): boolean {
  if (!receipt || typeof receipt !== "object") return false;
  if ((receipt as { version?: unknown }).version !== DELEGATION_MIGRATION_RECEIPT_VERSION) return false;
  if (typeof (receipt as { from?: unknown }).from !== "string") return false;
  if (typeof (receipt as { to?: unknown }).to !== "string") return false;
  if (path.resolve(receipt.from) !== path.resolve(legacyBridgeDir)) return false;
  if (path.resolve(receipt.to) !== path.resolve(newBridgeDir)) return false;
  if (typeof (receipt as { runFiles?: unknown }).runFiles !== "number") return false;
  const runFiles = (receipt as { runFiles: number }).runFiles;
  if (!Number.isSafeInteger(runFiles) || runFiles < 0) return false;
  if (typeof (receipt as { subscriptions?: unknown }).subscriptions !== "boolean") return false;
  const expectedHashes = (receipt as { runFileHashes?: unknown }).runFileHashes;
  if (!isRecord(expectedHashes)) return false;
  for (const value of Object.values(expectedHashes as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  const subscriptionIds = (receipt as { subscriptionIds?: unknown }).subscriptionIds;
  if (!Array.isArray(subscriptionIds)) return false;
  for (const id of subscriptionIds) {
    if (typeof id !== "string") return false;
  }
  const subsHash = (receipt as { subsHash?: unknown }).subsHash;
  if (typeof subsHash !== "string" && subsHash !== null) return false;
  return true;
}

/**
 * Deliberate one-way migration from a legacy workspace bridge dir to the new
 * user-data authority. Copy-only with count/hash verification: the legacy
 * source is ALWAYS left intact (never deleted, never modified; only read)
 * and a receipt records the move. Completion is FINAL: once a well-formed
 * v2 receipt for this (from,to) pair was published (atomically, LAST, only
 * after full publish-time verification), later reopens return null WITHOUT
 * re-comparing current dest bytes to legacy bytes. Ordinary dest changes
 * after completion (run updates, checkpoint/delivery history, unsubscribe,
 * subscription edits) never trigger re-reconciliation.
 *
 * Interrupted copies are recoverable by retry: only missing/differing run
 * files are copied (stable run ids, no event re-queue from rewriting
 * identical bytes), subscriptions are merged by subId (legacy wins on the
 * same id, destination-only preserved so no authority is lost, secrets stay
 * inside the authority file and never enter run files or the receipt), and
 * the receipt is published LAST (atomically) only after full verification.
 * A half-copied authority throws instead of being trusted silently.
 */
export function ensureDelegationStorage(legacyBridgeDir: string, newBridgeDir: string): DelegationMigration | null {
  if (path.resolve(legacyBridgeDir) === path.resolve(newBridgeDir)) return null;
  // FINALITY FIRST: a well-formed v2 receipt for this exact pair ends the
  // migration. No dest-vs-legacy comparison here; post-completion dest edits
  // stay intact and legacy stays untouched. Check before any dest mutation.
  const existingReceipt = readDelegationMigrationReceipt(newBridgeDir);
  if (isMigrationReceiptComplete(legacyBridgeDir, newBridgeDir, existingReceipt)) return null;
  const legacyRuns = runFileNames(legacyBridgeDir);
  const legacySubs = hasSubscriptionsFile(legacyBridgeDir);
  if (legacyRuns.length === 0 && !legacySubs) return null;
  fs.mkdirSync(delegationRunsDir(newBridgeDir), { recursive: true, mode: 0o700 });
  // Incremental run copy: missing/differing only. Identical bytes are left
  // untouched so stable run ids are preserved and no event is re-queued by
  // rewriting. Source is only ever read.
  const runFileHashes: Record<string, string> = {};
  for (const name of legacyRuns) {
    const legacyBytes = fs.readFileSync(path.join(delegationRunsDir(legacyBridgeDir), name));
    const legacyHash = sha256HexBytes(legacyBytes);
    runFileHashes[name] = legacyHash;
    const target = path.join(delegationRunsDir(newBridgeDir), name);
    let destMatches = false;
    try {
      const destBytes = fs.readFileSync(target);
      destMatches = sha256HexBytes(destBytes) === legacyHash;
    } catch {
      destMatches = false;
    }
    if (!destMatches) {
      atomicWriteBytes(target, legacyBytes);
    }
  }
  // Subscription merge by id (authority only, secrets never leave it).
  let subscriptionIds: string[] = [];
  let subsHash: string | null = null;
  if (legacySubs) {
    const legacyBytes = fs.readFileSync(subscriptionsPath(legacyBridgeDir));
    const legacyParsed = parseSubscriptionsBytes(legacyBytes);
    subscriptionIds = legacyParsed.ids;
    subsHash = legacyParsed.hash;
    const legacyRecords = [...legacyParsed.byId.values()];
    const destRecords = hasSubscriptionsFile(newBridgeDir) ? loadSubscriptionRecords(newBridgeDir) : [];
    const merged = mergeSubscriptionsById(destRecords, legacyRecords);
    const destCanonical = stableStringify(destRecords.slice().sort((a, b) =>
      String((a as { subId?: unknown }).subId) < String((b as { subId?: unknown }).subId) ? -1 : 1));
    const mergedCanonical = stableStringify(merged);
    if (destCanonical !== mergedCanonical || !hasSubscriptionsFile(newBridgeDir)) {
      const payload = { version: 1 as const, subscriptions: merged };
      atomicWriteBytes(subscriptionsPath(newBridgeDir), Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
    }
  }
  // Verify BEFORE trusting: every run hash plus every legacy subscription id
  // must verify in the destination. The legacy source is left intact either way.
  const copiedRuns = runFileNames(newBridgeDir);
  if (copiedRuns.length < legacyRuns.length) {
    throw new Error(`Delegation migration verification failed: copied ${copiedRuns.length} runs, legacy holds ${legacyRuns.length}. Source left intact at ${legacyBridgeDir}.`);
  }
  for (const name of legacyRuns) {
    const expected = runFileHashes[name];
    const destBytes = fs.readFileSync(path.join(delegationRunsDir(newBridgeDir), name));
    if (sha256HexBytes(destBytes) !== expected) {
      throw new Error(`Delegation migration verification failed: run ${name} hash mismatch. Source left intact at ${legacyBridgeDir}.`);
    }
  }
  if (legacySubs) {
    const destRecords = loadSubscriptionRecords(newBridgeDir);
    const destById = new Map(destRecords.map((r) => [(r as { subId: string }).subId, r]));
    const legacyBytes = fs.readFileSync(subscriptionsPath(legacyBridgeDir));
    const legacyParsed = parseSubscriptionsBytes(legacyBytes);
    for (const id of legacyParsed.ids) {
      const destRec = destById.get(id);
      if (!destRec || stableStringify(destRec) !== stableStringify(legacyParsed.byId.get(id))) {
        throw new Error(`Delegation migration verification failed: subscription ${id} missing or differs. Source left intact at ${legacyBridgeDir}.`);
      }
    }
  }
  const at = new Date().toISOString();
  const receiptPath = path.join(newBridgeDir, DELEGATION_MIGRATION_RECEIPT);
  const receipt: DelegationMigrationReceipt = {
    version: DELEGATION_MIGRATION_RECEIPT_VERSION,
    from: legacyBridgeDir,
    to: newBridgeDir,
    runFiles: legacyRuns.length,
    runFileHashes,
    subscriptions: legacySubs,
    subscriptionIds,
    subsHash,
    at
  };
  atomicWriteReceipt(receiptPath, receipt);
  return {
    from: legacyBridgeDir,
    to: newBridgeDir,
    workspaceCanonical: legacyBridgeDir,
    runFiles: legacyRuns.length,
    subscriptions: legacySubs,
    at,
    receipt: receiptPath
  };
}

/**
 * Resolve effective delegation storage for one (owner, workspace), migrating
 * legacy bridge state forward on first use. Under the default (legacy OFF)
 * run state and subscriptions live OUTSIDE consumer repos under
 * `<delegationDir>/<ownerKind>-<ownerHash>/workspaces/<wsHash>/`; the legacy
 * workspace `.ai-bridge` layout applies ONLY under the explicit opt-in.
 */
export function resolveDelegationStorage(
  cfg: DelegationStorageConfig,
  workspaceCanonical: string
): DelegationStorageDirs {
  if (cfg.legacyBridge) {
    return {
      runBridgeDir: path.join(realDirOrInput(workspaceCanonical), cfg.contextDir),
      authorityDir: authorityBridgeDirFor(cfg.defaultRoot, cfg.contextDir),
      legacy: true,
      migrations: []
    };
  }
  const runBridgeDir = resolveDelegationRunBridgeDir(cfg, workspaceCanonical);
  const authorityDir = resolveDelegationAuthorityDir(cfg);
  const migrations: DelegationMigration[] = [];
  const runMigration = ensureDelegationStorage(
    path.join(realDirOrInput(workspaceCanonical), cfg.contextDir),
    runBridgeDir
  );
  if (runMigration) migrations.push(runMigration);
  const authorityMigration = ensureDelegationStorage(
    authorityBridgeDirFor(cfg.defaultRoot, cfg.contextDir),
    authorityDir
  );
  if (authorityMigration) migrations.push(authorityMigration);
  return { runBridgeDir, authorityDir, legacy: false, migrations };
}
