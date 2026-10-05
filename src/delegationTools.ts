/**
 * Authenticated MCP tools for durable delegation + MCP Events transport
 * (Leaf 2: group hestia-cli-canary, Codex Luna + OpenCode canary slices).
 *
 * Tools:
 *   delegation_launch      - launch one canary run (Codex Luna via
 *                            `codex exec --profile`; OpenCode via
 *                            `opencode run --standalone --model ... --format json`)
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
 *
 * Subscription routing: ONE canonical subscription authority per
 * (owner, server root) serves every permitted workspace. Default: the
 * user-data delegation dir (service storage OUTSIDE consumer repos,
 * namespaced by owner + canonical workspace); the legacy workspace
 * `.ai-bridge` layout applies ONLY under the explicit
 * CODEXPRO_DELEGATION_LEGACY_BRIDGE opt-in (first use migrates legacy
 * state forward, copy-only, source intact). Subscription storage
 * (events_subscribe, official POST /mcp events/subscribe) AND completion
 * delivery lookup (enqueue, pump, delegation_replay_events) all use the
 * authority dir; run state stays in the per-workspace run bridge dir.
 * Delivery targets are selected by owner identity (hash + kind,
 * constant-time) plus group/run filters. Subscription records (whsec_
 * secrets) are never copied into run workspaces: runs reference subIds only.
 * Stored events with zero targets are explicit no-target state (truthful
 * undelivered counts, never silent 0); delegation_replay_events explicitly
 * attaches currently matching in-scope targets without backfilling history.
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
  DELEGATION_TERMINAL_STATES,
  activeSessionHolders,
  applyCheckpointReply,
  clearPendingDispatch,
  findRunByRequestId,
  isDelegationGroupId,
  isEventUndelivered,
  isLaunchRequestConflict,
  isRunPidLess,
  isUncertainDispatch,
  listDelegationRuns,
  loadDelegationRun,
  localOwnerFor,
  markAmbiguousSpawn,
  markPendingDispatchFailed,
  newRunId,
  nextActionFor,
  openInputRequests,
  ownerIdFor,
  pendingDispatchFor,
  reconcileRunState,
  registerInputRequest,
  resolveDelegationStorage,
  runInputRequests,
  sanitizeSummary,
  sanitizeTaskText,
  saveDelegationRun,
  stableEventId,
  stagePendingDispatch,
  stagePendingLaunch,
  summarizeTerminal,
  validateCheckpointForRun,
  verifyRunOwner,
  type CheckpointShape,
  type DelegationAttempt,
  type DelegationRunRecord,
  type DelegationEngine,
  type DelegationRunState,
  type DelegationSessionBinding,
  type DelegationStorageConfig
} from "./delegationStore.js";
import {
  buildCodexCanaryArgv,
  buildCodexRealArgv,
  buildCodexResumeArgv,
  buildClaudeArgv,
  buildClaudeResumeArgv,
  buildFollowupPrompt,
  buildLaunchPreview,
  buildOpenCodeCanaryArgv,
  buildOpenCodeRealArgv,
  aliveTreeMembers,
  CANARY_FIXTURES,
  canaryPrompt,
  cancelOwnedTree,
  captureWorkdirBaseline,
  clampCanaryTimeout,
  clampRealTaskTimeout,
  CLAUDE_RESUME_CAPABILITY,
  classifyCodexFailure,
  codexHomeDir,
  collectOwnedTree,
  collectWorkdirEvidence,
  CODEX_RESUME_CAPABILITY,
  engineQualification,
  findPostCancelWrites,
  isClaudeSessionId,
  isEngineSessionId,
  isProcessIdentityAlive,
  newClaudeSessionId,
  OPENCODE_CANCEL_CAPABILITY,
  OPENCODE_RESUME_CAPABILITY,
  parseOpenCodeSessionId,
  probeEngineCapability,
  readProcessStartTime,
  resolveClaudeBinary,
  resolveOpenCodeBinary,
  sha256File,
  signalOwnedTree,
  snapshotWorkdirMtimes,
  verifyClaudeLaunch,
  verifyClaudeSession,
  verifyCodexLaunch,
  verifyOpenCodeLaunch,
  verifyOpenCodeSession,
  waitForSpawn,
  type OwnedTreeMemberIdentity,
  type PostCancelWrites,
  type WorkdirBaseline
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
  subscriptionOwnerMatchesRecord,
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

/** Post-cancel quiescence grace: bounded wait before the no-further-writes probe. */
const QUIESCENCE_GRACE_MS = 1500;
/**
 * Post-cancel verification window: a SECOND observation leg after the grace.
 * A single quiet 1.5s interval alone is insufficient (a slow-dying worker can
 * outlast it), so cancellation verifies quiescence across grace + window
 * (two probes against cancel-complete) plus an owned-tree liveness recheck.
 */
const QUIESCENCE_VERIFY_WINDOW_MS = 2000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Merge two post-cancel quiescence legs (grace leg + verification-window
 * leg, both compared against cancel-complete). BOTH legs must verify;
 * continued writes union (bounded at 50, oldest legs first). An unverifiable
 * leg fails the merge closed (checked false, never a clean-halt claim).
 * Exported for the focused regression proof.
 */
export function mergeQuiescenceLegs(first: PostCancelWrites, second: PostCancelWrites, limit = 50): PostCancelWrites {
  const checked = first.checked && second.checked;
  const seen = new Set<string>();
  const continued: string[] = [];
  let truncated = false;
  for (const entry of [...first.continued, ...second.continued]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (continued.length >= limit) {
      truncated = true;
      break;
    }
    continued.push(entry);
  }
  if (first.truncated || second.truncated) truncated = true;
  if (!checked) {
    return { continued, truncated, checked, reason: first.reason ?? second.reason ?? "quiescence unverifiable" };
  }
  return { continued, truncated, checked };
}

/**
 * OpenCode execution-route label for honest evidence. New runs record
 * "standalone" (private server per turn); run files that predate the route
 * field are "shared-service" (background service) and are never silently
 * converted (legacy true carries the explicit note). Non-opencode runs are
 * "n/a". Exported for the focused regression proof.
 */
export function opencodeExecutionRoute(run: DelegationRunRecord): { route: string; legacy: boolean } {
  if (run.engine !== "opencode") return { route: "n/a", legacy: false };
  if (run.opencodeRoute) return { route: run.opencodeRoute, legacy: false };
  return { route: "shared-service", legacy: true };
}

/**
 * Post-cancel owned-tree liveness recheck: after the quiescence window, the
 * exact PID+starttime-verified owned tree must be gone. Returns the still-
 * owned PIDs (empty when the tree is gone or the root never had a pid).
 * Never broadens beyond the exact owned tree. Exported for the focused
 * regression proof.
 */
export function recheckOwnedTreeGone(pid: number | undefined, startTime: string | undefined): number[] {
  if (pid === undefined) return [];
  const recheck = collectOwnedTree(pid, startTime);
  if (recheck.staleRoot) return [];
  return recheck.members.filter((member) => readProcessStartTime(member) === recheck.baselines.get(member));
}

function okResult(text: string, structured: Record<string, unknown>): any {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Short run binding for artifact filenames: the last 8 hex chars of a
 * run_<16hex> id. Unpredictable before launch (minted randomly per run), so
 * a run-bound filename is a namespace only this run can occupy: two runs
 * sharing one caller-chosen workdir can never cross-attribute, and a
 * preoccupied run-bound file proves forgery, never worker output.
 * Exported for the focused regression proof.
 */
export function shortRunId(runId: string): string {
  const m = /^run_([0-9a-f]{16})$/.exec(String(runId ?? ""));
  if (m) return m[1].slice(-8);
  const clean = String(runId ?? "").replace(/[^A-Za-z0-9]/g, "").slice(-8);
  return clean || "unknown";
}

/**
 * Persist one attempt's output artifact with provenance. Never overwrites:
 * every candidate path is exclusively created (O_EXCL); an existing file —
 * including an existing EMPTY file (empty = unavailable, never a slot to
 * fill) AND an existing NONEMPTY file (preoccupied output is never claimed
 * as this run's result, never bound with created:false) — is left
 * untouched. A preoccupied primary diverts to the attempt's own run-bound
 * fallback sibling; when every candidate is preoccupied the attempt records
 * unavailable with a reason. `retained === null` means "stat only, never
 * write" (codex owns its file via --output-last-message): the run-bound
 * file is bound ONLY with namespace proof (the run_id-bound name) PLUS
 * temporal proof (the worker wrote it at/after the attempt start); a
 * pre-existing file (written before the attempt started) is never
 * attributed to the new run. Without a run id the result is fail-closed
 * unavailable: legacy shared names are never created anew. Exported for
 * the focused regression proof.
 */
export function persistAttemptArtifact(
  workdir: string,
  engine: DelegationEngine,
  attemptN: number,
  retained: string | null,
  runId?: string,
  attemptStartedAt?: string
): NonNullable<DelegationAttempt["outputArtifact"]> {
  const primaryRel = lastMessageRelPathForAttempt(engine, attemptN, runId);
  if (!runId) {
    return {
      relPath: primaryRel, bytes: 0, created: false, provenance: "unavailable" as const,
      reason: "run identity missing: no legacy shared artifact will be created or claimed without a run-bound name"
    };
  }
  if (retained === null) {
    // No finalize write for this engine: bind only what the worker proved.
    let existingSize: number | null = null;
    let existingMtimeMs: number | null = null;
    try {
      const stat = fs.statSync(path.join(workdir, primaryRel));
      if (stat.isFile()) {
        existingSize = stat.size;
        existingMtimeMs = stat.mtimeMs;
      }
    } catch { /* absent */ }
    if (existingSize === null) {
      return {
        relPath: primaryRel, bytes: 0, created: false, provenance: "unavailable" as const,
        reason: `worker wrote no file for this attempt (no ${primaryRel})`
      };
    }
    if (existingSize === 0) {
      return {
        relPath: primaryRel, bytes: 0, created: false, provenance: "unavailable" as const,
        reason: `worker left an empty file at ${primaryRel} (empty = unavailable, never a slot to fill)`
      };
    }
    // Nonempty run-bound file: temporal proof decides. The name is this
    // run's namespace, but a file written BEFORE the attempt started is
    // preoccupied (forged or stale), never worker output.
    const startMs = attemptStartedAt ? Date.parse(attemptStartedAt) : NaN;
    const mtimeOk = existingMtimeMs !== null &&
      (!Number.isFinite(startMs) || existingMtimeMs >= startMs - 2000);
    if (!mtimeOk) {
      return {
        relPath: primaryRel, bytes: existingSize, created: false, provenance: "unavailable" as const,
        reason: `primary artifact ${primaryRel} is preoccupied (written before this attempt started); left untouched, never claimed as this run's output`
      };
    }
    return { relPath: primaryRel, bytes: existingSize, created: false, provenance: "worker" as const };
  }
  if (!retained) {
    return {
      relPath: primaryRel, bytes: 0, created: false, provenance: "unavailable" as const,
      reason: "worker produced no output; finalize created no file"
    };
  }
  const candidates = [primaryRel, ...attemptArtifactFallbackPaths(engine, attemptN, runId)];
  for (const rel of candidates) {
    if (exclusivelyCreateArtifact(workdir, rel, retained) !== null) {
      const diverted = rel !== primaryRel;
      return {
        relPath: rel,
        bytes: Buffer.byteLength(retained, "utf8"),
        created: true,
        provenance: "created" as const,
        ...(diverted ? { reason: `primary artifact ${primaryRel} preoccupied (left untouched); output persisted to the attempt's own ${rel}` } : {})
      };
    }
  }
  return {
    relPath: primaryRel, bytes: 0, created: false, provenance: "unavailable" as const,
    reason: `primary artifact ${primaryRel} and every run-bound fallback is preoccupied; nothing written, nothing claimed`
  };
}

function failResult(text: string, structured: Record<string, unknown>): any {
  return { isError: true, content: [{ type: "text", text }], structuredContent: structured };
}

function localOwnerId(config: CodexProConfig): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  return `${uid}:${config.defaultRoot}`;
}

function storageConfigFor(config: CodexProConfig): DelegationStorageConfig {
  return {
    delegationDir: config.delegationDir,
    legacyBridge: config.delegationLegacyBridge,
    contextDir: config.contextDir,
    ...(config.authToken ? { authToken: config.authToken } : {}),
    localOwner: localOwnerFor(config.defaultRoot),
    defaultRoot: config.defaultRoot
  };
}

function bridgeDirFor(config: CodexProConfig, workspaceRoot: string): string {
  // Default (legacy OFF): run state lives OUTSIDE the repo under the
  // user-data delegation dir, namespaced by (owner, workspace). Legacy
  // workspace .ai-bridge applies ONLY under the explicit opt-in. First use
  // migrates existing legacy state forward (copy-only, source intact).
  return resolveDelegationStorage(storageConfigFor(config), workspaceRoot).runBridgeDir;
}

/**
 * Canonical subscription authority dir, shared across ALL permitted
 * workspaces for one (owner, server root). Default: the user-data
 * delegation dir (never a repo); legacy opt-in: the server defaultRoot
 * bridge. Subscription storage (events_subscribe / official POST /mcp
 * events/subscribe) AND completion delivery lookup (enqueue + pump +
 * replay) all use this dir; run state stays in the per-workspace run
 * bridge dir. Subscription records (which carry whsec_ secrets) are never
 * copied into run workspaces: runs reference targets by subId only.
 */
function subscriptionAuthorityDirFor(config: CodexProConfig): string {
  return resolveDelegationStorage(storageConfigFor(config), config.defaultRoot).authorityDir;
}

/**
 * Delivery target selection: owner identity (hash + kind, constant-time)
 * AND group/run filters (subscriptionMatches). Knowing a group, run, or
 * subscription id grants no access; only the run owner's currently matching
 * subscriptions become targets. Expiry is adjudicated at pump time (clear
 * permanent error), not by silently dropping targets here.
 */
function selectDeliveryTargets(run: DelegationRunRecord, subs: EventSubscription[]): EventSubscription[] {
  return subs.filter((sub) =>
    sub.eventName === RUN_ATTENTION_EVENT &&
    subscriptionOwnerMatchesRecord(run.ownerIdHash, run.ownerKind, sub) &&
    subscriptionMatches(sub, { delegationGroup: run.delegationGroup, runId: run.runId }));
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

/**
 * Binary provenance for honest evidence: true when a CODEXPRO_*_BIN override
 * selected the worker executable at launch. Test shims ride this override
 * route, so overridden runs are never live proof (the read path says so);
 * default-PATH runs carry no shim marker.
 */
function engineBinaryOverridden(engine: DelegationLaunchEngine): boolean {
  const name = engine === "codex" ? "CODEXPRO_CODEX_BIN" : engine === "opencode" ? "CODEXPRO_OPENCODE_BIN" : "CODEXPRO_CLAUDE_BIN";
  return Boolean(String(process.env[name] ?? "").trim());
}

type DelegationLaunchEngine = "codex" | "opencode" | "claude";

interface GatedLaunchPlan {
  engine: DelegationLaunchEngine;
  isCanary: boolean;
  delegationGroup: string;
  taskText: string;
  prompt: string;
  profile: string;
  model: string;
  agent: string;
  /** Explicit session id from the caller (opencode ses-id or claude UUID), or "". */
  requestedSessionId: string;
  executionPolicy: string;
  permissionMode: string;
  effort: string;
  allowedTools: string;
  disallowedTools: string;
  configOverrides: string[];
  /**
   * Separate explicit per-run opt-in to
   * --dangerously-bypass-approvals-and-sandbox (codex only; only meaningful
   * with explicit execution_policy danger-full-access; the sandbox alone
   * never implies it).
   */
  bypassApprovals: boolean;
  timeoutMs: number;
  timeoutClamped: boolean;
  gateReason: string;
  gateEvidence: Record<string, unknown>;
  configuredModel: string | null;
  configuredEffort: string | null;
  modelExplicit: boolean;
  effortExplicit: boolean;
  permissionExplicit: boolean;
  executable: string;
}

type GateOutcome =
  | { ok: true; plan: GatedLaunchPlan }
  | { ok: false; text: string; structured: Record<string, unknown> };

/**
 * Shared launch gate for delegation_launch AND delegation_preview (dry-run).
 * Pure apart from definition-file reads and the timeout clamp: no workdir
 * creation, no run record, no spawn. Per-engine rules:
 * - codex: legacy canary keeps the Luna read-only gate; real tasks verify
 *   the SELECTED profile (exists, non-Astra, resolvable sandbox) with an
 *   explicit-or-profile execution policy. `model` is an explicit -m override
 *   only; `config_overrides` are explicit -c entries only.
 * - opencode: legacy canary keeps the host-model equality gate (agent
 *   optional, preserved for back-compat); real tasks require the SELECTED
 *   agent by real name plus an explicit model. No Codex flag translation.
 * - claude: real tasks only (the legacy read-only canary slice is
 *   codex/opencode); the agent must exist by real name; --model/--effort/
 *   --permission-mode/--allowedTools ride ONLY when explicitly passed.
 * Refusals never substitute another engine, model, or permission.
 */
function gateLaunchRequest(args: Record<string, unknown>): GateOutcome {
  const engine = args.engine as string;
  if (engine !== "codex" && engine !== "opencode" && engine !== "claude") {
    return {
      ok: false,
      text: `Unknown engine ${JSON.stringify(String(args.engine))}: must be codex|opencode|claude (never substituted).`,
      structured: { error: "unknown_engine" }
    };
  }
  const rawGroup = String(args.delegation_group ?? "").trim();
  const delegationGroup = rawGroup || DELEGATION_GROUP_DEFAULT;
  if (!isDelegationGroupId(delegationGroup)) {
    return {
      ok: false,
      text: `Invalid delegation_group ${JSON.stringify(rawGroup || delegationGroup)}: must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/ within 64 chars.`,
      structured: { error: "invalid_delegation_group" }
    };
  }
  let taskText = "";
  let isCanary = true;
  if (args.task !== undefined) {
    const rawTask = String(args.task ?? "");
    if (rawTask.length > DELEGATION_BOUNDS.maxTaskChars) {
      return {
        ok: false,
        text: `task exceeds ${DELEGATION_BOUNDS.maxTaskChars} chars (${rawTask.length}); narrow the task and retry.`,
        structured: { error: "task_too_large", task_chars: rawTask.length }
      };
    }
    taskText = sanitizeTaskText(rawTask);
    if (!taskText) {
      return {
        ok: false,
        text: "task is empty after control-strip; supply real worker input or omit task with canary=true.",
        structured: { error: "task_empty" }
      };
    }
    isCanary = false;
  }
  if (isCanary && args.canary !== true) {
    return {
      ok: false,
      text: "Without a task, this leaf supports only the read-only canary slice: pass canary=true or supply task.",
      structured: { error: "non_canary_rejected" }
    };
  }
  if (isCanary && engine === "claude") {
    return {
      ok: false,
      text: "Engine claude supports real tasks only: supply task (the legacy read-only canary slice is codex/opencode, whose read-only gates do not apply to claude).",
      structured: { error: "canary_unsupported_for_engine", engine }
    };
  }
  const prompt = isCanary ? canaryPrompt(CANARY_FIXTURES) : taskText;
  const timeoutMs = isCanary ? clampCanaryTimeout(args.timeout_ms) : clampRealTaskTimeout(args.timeout_ms);
  const requestedTimeout = Number(args.timeout_ms);
  const timeoutClamped = args.timeout_ms === undefined ||
    !Number.isFinite(requestedTimeout) ||
    Math.floor(requestedTimeout) !== timeoutMs;
  const base: Omit<GatedLaunchPlan,
    "profile" | "model" | "agent" | "requestedSessionId" | "executionPolicy" |
    "permissionMode" | "effort" | "allowedTools" | "disallowedTools" | "configOverrides" |
    "bypassApprovals" |
    "gateReason" | "gateEvidence" | "configuredModel" | "configuredEffort" |
    "modelExplicit" | "effortExplicit" | "permissionExplicit" | "executable"> = {
    engine, isCanary, delegationGroup, taskText, prompt,
    timeoutMs, timeoutClamped
  };
  if (engine === "codex") {
    const gate = verifyCodexLaunch(codexHomeDir(), String(args.profile ?? ""), {
      isCanary,
      delegationGroup,
      executionPolicy: args.execution_policy,
      modelOverride: args.model,
      configOverrides: args.config_overrides
    });
    if (!gate.allowed) {
      return {
        ok: false,
        text: `${gate.gateKind === "luna" ? "Luna profile gate" : "Codex profile gate"} refused launch: ${gate.reason}`,
        structured: { error: gate.code, configured: gate.configured }
      };
    }
    const profile = String(args.profile ?? "").trim();
    // --dangerously-bypass-approvals-and-sandbox is NEVER implied by the
    // sandbox: it rides only with a separate explicit per-run opt-in
    // (bypass_approvals=true) PLUS explicit execution_policy
    // danger-full-access. Anything else refuses (including the canary slice).
    const bypassApprovals = args.bypass_approvals === true;
    if (bypassApprovals && isCanary) {
      return {
        ok: false,
        text: "bypass_approvals is refused for the legacy canary slice (read-only; the bypass flag never rides a canary run).",
        structured: { error: "bypass_refused_for_canary" }
      };
    }
    const explicitPolicy = typeof args.execution_policy === "string" ? args.execution_policy.trim() : "";
    if (bypassApprovals && explicitPolicy !== "danger-full-access") {
      return {
        ok: false,
        text: "bypass_approvals=true requires explicit execution_policy danger-full-access: the sandbox alone never implies --dangerously-bypass-approvals-and-sandbox (sandbox != bypass).",
        structured: { error: "bypass_requires_danger" }
      };
    }
    return {
      ok: true,
      plan: {
        ...base,
        profile,
        model: gate.modelOverride ?? "",
        agent: "",
        requestedSessionId: "",
        executionPolicy: gate.executionPolicy as string,
        permissionMode: "",
        effort: "",
        allowedTools: "",
        disallowedTools: "",
        configOverrides: gate.configOverrides ?? [],
        bypassApprovals,
        gateReason: gate.reason,
        gateEvidence: {
          model_configured: gate.configured.model,
          reasoning_configured: gate.configured.reasoningEffort,
          sandbox_configured: gate.configured.sandboxMode,
          execution_policy: gate.executionPolicy,
          ...(gate.effectiveModel ? { model_effective: gate.effectiveModel } : {}),
          ...(gate.effectiveEffort ? { effort_effective: gate.effectiveEffort } : {}),
          gate: gate.gateKind,
          ...(gate.modelOverride ? { model_override: gate.modelOverride } : {}),
          ...(gate.configOverrides?.length ? { config_overrides: gate.configOverrides } : {}),
          ...(bypassApprovals ? { bypass_approvals: true as const } : {})
        },
        configuredModel: gate.configured.model ?? null,
        configuredEffort: gate.configured.reasoningEffort ?? null,
        modelExplicit: Boolean(gate.modelOverride),
        effortExplicit: false,
        permissionExplicit: false,
        executable: resolveCodexBinary()
      }
    };
  }
  if (engine === "opencode") {
    const gate = verifyOpenCodeLaunch({
      model: args.model,
      agent: args.agent,
      isCanary,
      delegationGroup
    });
    if (!gate.allowed) {
      return {
        ok: false,
        text: `OpenCode launch gate refused: ${gate.reason}`,
        structured: {
          error: gate.code,
          host_model: gate.hostModel ?? null,
          requested_model: gate.requestedModel ?? null
        }
      };
    }
    const requestedSessionId = String(args.session_id ?? "").trim();
    if (requestedSessionId && !isEngineSessionId(requestedSessionId)) {
      return {
        ok: false,
        text: "session_id must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.",
        structured: { error: "invalid_session_id" }
      };
    }
    return {
      ok: true,
      plan: {
        ...base,
        profile: "",
        model: gate.requestedModel as string,
        agent: gate.agent?.name ?? "",
        requestedSessionId,
        executionPolicy: "",
        permissionMode: "",
        effort: "",
        allowedTools: "",
        disallowedTools: "",
        configOverrides: [],
        bypassApprovals: false,
        gateReason: gate.reason,
        gateEvidence: {
          model_verified: gate.requestedModel,
          host_model: gate.hostModel,
          host_equality_enforced: gate.hostEqualityEnforced,
          ...(gate.agent ? { agent: gate.agent.name } : {})
        },
        configuredModel: gate.hostModel,
        configuredEffort: null,
        modelExplicit: true,
        effortExplicit: false,
        permissionExplicit: false,
        executable: resolveOpenCodeBinary()
      }
    };
  }
  const gate = verifyClaudeLaunch({
    agent: args.agent,
    model: args.model,
    effort: args.effort,
    permissionMode: args.permission_mode,
    allowedTools: args.allowed_tools,
    disallowedTools: args.disallowed_tools
  });
  if (!gate.allowed) {
    return {
      ok: false,
      text: `Claude launch gate refused: ${gate.reason}`,
      structured: { error: gate.code, agent: String(args.agent ?? "") }
    };
  }
  const requestedSessionId = String(args.session_id ?? "").trim();
  if (requestedSessionId && !isClaudeSessionId(requestedSessionId)) {
    return {
      ok: false,
      text: "session_id for engine claude must be a UUID (the --session-id contract).",
      structured: { error: "invalid_session_id", engine }
    };
  }
  const model = typeof args.model === "string" ? args.model.trim() : "";
  const effort = typeof args.effort === "string" ? args.effort.trim() : "";
  const permissionMode = typeof args.permission_mode === "string" ? args.permission_mode.trim() : "";
  return {
    ok: true,
    plan: {
      ...base,
      profile: "",
      model,
      agent: gate.agent?.name ?? "",
      requestedSessionId,
      executionPolicy: "",
      permissionMode,
      effort,
      allowedTools: typeof args.allowed_tools === "string" ? args.allowed_tools.trim() : "",
      disallowedTools: typeof args.disallowed_tools === "string" ? args.disallowed_tools.trim() : "",
      configOverrides: [],
      bypassApprovals: false,
      gateReason: gate.reason,
      gateEvidence: {
        agent: gate.agent?.name,
        model_effective: gate.effectiveModel,
        effort_effective: gate.effectiveEffort,
        model_explicit: gate.modelExplicit,
        effort_explicit: gate.effortExplicit,
        permission_explicit: gate.permissionExplicit,
        ...(permissionMode ? { permission_mode: permissionMode } : { permission_mode_inherited: true })
      },
      configuredModel: gate.effectiveModel,
      configuredEffort: gate.effectiveEffort,
      modelExplicit: gate.modelExplicit,
      effortExplicit: gate.effortExplicit,
      permissionExplicit: gate.permissionExplicit,
      executable: resolveClaudeBinary()
    }
  };
}

/**
 * Build the dispatch argv for a gated plan. Codex uses the canary argv for
 * the legacy slice and the real-task argv (profile + adjudicated sandbox)
 * otherwise; opencode uses the canary argv only for the agent-less legacy
 * slice; claude always uses its explicit-flag argv. Flags are never shared
 * across engines.
 */
function buildPlannedArgv(plan: GatedLaunchPlan, prompt: string, lastMessagePath: string, sessionId?: string): string[] {
  if (plan.engine === "codex") {
    if (plan.isCanary) return buildCodexCanaryArgv(plan.profile, prompt, lastMessagePath);
    return buildCodexRealArgv(plan.profile, prompt, lastMessagePath, {
      executionPolicy: plan.executionPolicy as "read-only" | "workspace-write" | "danger-full-access",
      ...(plan.model ? { modelOverride: plan.model } : {}),
      ...(plan.configOverrides.length > 0 ? { configOverrides: plan.configOverrides } : {}),
      ...(plan.bypassApprovals ? { dangerBypassExplicit: true as const } : {})
    });
  }
  if (plan.engine === "opencode") {
    if (!plan.agent) return buildOpenCodeCanaryArgv(plan.model, prompt, sessionId);
    return buildOpenCodeRealArgv({ model: plan.model, agent: plan.agent, prompt, ...(sessionId ? { sessionId } : {}) });
  }
  return buildClaudeArgv({
    agent: plan.agent,
    prompt,
    ...(plan.modelExplicit && plan.model ? { model: plan.model } : {}),
    ...(plan.effortExplicit && plan.effort ? { effort: plan.effort } : {}),
    ...(plan.permissionExplicit && plan.permissionMode ? { permissionMode: plan.permissionMode } : {}),
    ...(plan.allowedTools ? { allowedTools: plan.allowedTools } : {}),
    ...(plan.disallowedTools ? { disallowedTools: plan.disallowedTools } : {}),
    ...(sessionId ? { sessionId } : {})
  });
}

function launchCodexReal(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  plan: GatedLaunchPlan,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean,
  attemptN = 1
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, lastMessageRelPathForAttempt("codex", attemptN, run.runId));
  return spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildPlannedArgv(plan, prompt, lastMessagePath), timeoutMs, lastMessagePath, isCanary, attemptN);
}

function launchOpenCodeReal(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  plan: GatedLaunchPlan,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean,
  sessionId?: string,
  attemptN = 1
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, lastMessageRelPathForAttempt("opencode", attemptN, run.runId));
  return spawnCanaryChild(deps, bridgeDir, run, resolveOpenCodeBinary(), buildPlannedArgv(plan, prompt, lastMessagePath, sessionId), timeoutMs, lastMessagePath, isCanary, attemptN);
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
  /** 1-based attempt number that owns this live child (artifact provenance). */
  attemptN: number;
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
  // Delivery lookup reads the canonical subscription authority (server
  // defaultRoot bridge), NOT the run workspace bridge: a subscription stored
  // via the official protocol path is visible to runs in every permitted
  // workspace. Run state still persists in bridgeDir (the run bridge).
  const subs = loadSubscriptions(subscriptionAuthorityDirFor(deps.config));
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
      // Fail-closed owner recheck at pump time: only the run owner's
      // subscription may receive this run's wake-up, even if the authority
      // file changed between target selection and delivery.
      if (!subscriptionOwnerMatchesRecord(run.ownerIdHash, run.ownerKind, sub)) {
        delivery.status = "permanent";
        delivery.lastError = "subscription owner mismatch; delivery stopped";
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
  // Target selection is owner-checked (run owner vs subscription owner,
  // constant-time) plus group/run-filtered. Callers pass the canonical
  // authority subscriptions; a run in any permitted workspace sees the same
  // targets. Zero matches => deliveries:[] (explicit no-target state, never
  // silent 0-delivered): truthful counts + delegation_replay_events cover it.
  const targets = selectDeliveryTargets(run, subs);
  run.pendingEvents = [
    ...run.pendingEvents,
    {
      eventId: stableEventId(run.runId, seq),
      seq,
      state: run.state,
      summary,
      createdAt: new Date().toISOString(),
      deliveries: targets.map((sub) => ({ subId: sub.subId, status: "pending" as const, attempts: 0 }))
    }
  ].slice(-DELEGATION_BOUNDS.maxPendingEventsPerRun);
  run.nextAction = nextActionFor(run.state, run.pendingEvents.some(isEventUndelivered),
    run.pendingEvents.some((event) => event.deliveries.length === 0));
  return run;
}

interface ReplayAttachment {
  eventId: string;
  subIds: string[];
}

/**
 * Explicit replay target attachment: for stored events with ZERO deliveries
 * (explicit no-target state), attach the CURRENTLY matching authority
 * subscriptions (owner-checked + group/run-filtered via
 * selectDeliveryTargets) as fresh pending deliveries. Events that already
 * carry deliveries are NEVER touched: no historical event is backfilled to
 * new/wider scopes, and delivery history is preserved. Secrets are never
 * copied: only subIds enter the run record.
 */
function attachReplayTargets(
  run: DelegationRunRecord,
  authoritySubs: EventSubscription[]
): { attached: ReplayAttachment[]; stillNoTarget: string[] } {
  const attached: ReplayAttachment[] = [];
  const stillNoTarget: string[] = [];
  for (const event of run.pendingEvents) {
    if (event.deliveries.length > 0) continue;
    const targets = selectDeliveryTargets(run, authoritySubs);
    if (targets.length === 0) {
      stillNoTarget.push(event.eventId);
      continue;
    }
    event.deliveries = targets.map((sub) => ({ subId: sub.subId, status: "pending" as const, attempts: 0 }));
    attached.push({ eventId: event.eventId, subIds: targets.map((sub) => sub.subId) });
  }
  return { attached, stillNoTarget };
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
        reason: "session id observed in worker --format json stdout (shape best-effort); resume via opencode run --standalone --session"
      };
    } else if (!run.session?.sessionId) {
      run.session = {
        engine: "opencode",
        resumable: false,
        reason: "no session id observed in worker stdout; follow-up starts a labeled new-continuation-attempt"
      };
    }
  }
  // Per-(run, attempt) output artifact, exclusively created and
  // provenance-bound: EVERY attempt's file binds (run_id, attempt)
  // (<stem>-<shortRunId>-attempt-<N><ext>, including attempt 1 — legacy
  // shared names are never created anew), so two runs sharing one
  // caller-chosen workdir occupy disjoint namespaces and a continuation can
  // never surface an earlier attempt's output file as the current result.
  // Existing files are never overwritten, never claimed: a preoccupied
  // file — empty or nonempty — is left untouched (retained output diverts
  // to the attempt's own run-bound fallback; a preoccupied worker-owned
  // file records unavailable with a reason). The recorded relPath plus the
  // provenance verdict binds which attempt produced the artifact for the
  // read path. Best effort and never throwing: an unavailable artifact
  // stays explicitly unavailable in read evidence (never an implied pass).
  // Output beyond the retained tail is reported via the stdoutTruncated
  // flag below. Codex owns its file via --output-last-message (stat only
  // here, never written, bound only with namespace + temporal proof);
  // opencode/claude output is persisted from the retained live stdout
  // buffer (newest up to the 64KiB live cap).
  const attemptN = live?.attemptN ?? latest?.n ?? 1;
  let outputArtifact: DelegationAttempt["outputArtifact"];
  try {
    const retained = live && (run.engine === "opencode" || run.engine === "claude")
      ? Buffer.concat(live.stdoutChunks).toString("utf8")
      : null;
    outputArtifact = persistAttemptArtifact(run.workdir, run.engine, attemptN, retained, run.runId, latest?.startedAt);
  } catch { /* artifact stays unrecorded; read evidence reports it unavailable */ }
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
        summary: sanitizeSummary(summary),
        ...(outputArtifact ? { outputArtifact } : {})
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
    // Explicit truncation flags: the live 64KiB cap keeps the newest bytes;
    // the 8KiB tail bound keeps the newest tail. A true flag means older
    // output exists beyond what is shown; larger evidence rides the run
    // workdir (last-message files) through the ordinary read route.
    ...(live ? {
      stdoutTruncated: live.stdoutBytes > DELEGATION_BOUNDS.maxTailBytes,
      stderrTruncated: live.stderrBytes > DELEGATION_BOUNDS.maxTailBytes
    } : {}),
    ...(fixturesUnchanged === undefined ? {} : { fixturesUnchanged })
  };
  enqueueTerminalEvent(run, loadSubscriptions(subscriptionAuthorityDirFor(deps.config)));
  // Atomic: terminal state + pending wake-up event persist in one write.
  saveDelegationRun(bridgeDir, run);
  void pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, runId) ?? run).catch(() => undefined);
}

/**
 * Ambiguous post-spawn failure: the child was successfully spawned, but
 * run-identity (pid) persistence then failed, so the worker may exist as a
 * pid-less orphan. Callers MUST fail closed on this error (uncertain
 * dispatch, never auto-spawn a second worker, never a false terminal) even
 * when persisting the error marker itself succeeds: the marker proves an
 * error was recorded, never that no child exists. Proven pre-spawn
 * failures (spawn threw synchronously, no child) propagate as ordinary
 * errors and stay explicitly retryable.
 */
export class AmbiguousSpawnError extends Error {
  readonly child?: ChildProcess;
  readonly childPid?: number;
  constructor(message: string, child?: ChildProcess) {
    super(message);
    this.name = "AmbiguousSpawnError";
    (this as { code?: string }).code = "SPAWN_AMBIGUOUS";
    this.child = child;
    this.childPid = child?.pid;
  }
}

export function isAmbiguousSpawnError(error: unknown): boolean {
  if (error instanceof AmbiguousSpawnError) return true;
  return !!error && typeof error === "object" &&
    (error as { code?: unknown }).code === "SPAWN_AMBIGUOUS";
}

/**
 * Test seam (exported ONLY for the spawn-truth transition proof): spawns one
 * worker child and persists its pid identity. Throws AmbiguousSpawnError
 * when the child spawned but identity persistence failed; ordinary errors
 * propagate for proven pre-spawn failures (spawn threw, no child).
 */
export function spawnCanaryChild(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  binary: string,
  argv: string[],
  timeoutMs: number,
  lastMessagePath: string,
  isCanary: boolean,
  attemptN = 1
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
    attemptN: Number.isSafeInteger(attemptN) && attemptN >= 1 ? attemptN : 1,
    timedOut: false
  };
  clearTimeout(live.timeout);
  // Provenance boundary: spawn() throwing synchronously means NO child
  // exists (proven pre-spawn); the raw error propagates untouched and the
  // caller may record an explicitly retryable failure. EVERYTHING after a
  // successful spawn() return is ambiguous on persistence failure: the
  // worker may exist as a pid-less orphan, so identity-save errors throw
  // AmbiguousSpawnError and the caller must fail closed (never auto-spawn).
  const pid = child.pid;
  const startTime = pid !== undefined ? readProcessStartTime(pid) ?? undefined : undefined;
  const latest = run.attempts.at(-1);
  if (latest && pid !== undefined) {
    latest.pid = pid;
    latest.processStartTime = startTime;
  }
  try {
    saveDelegationRun(bridgeDir, run);
  } catch (error) {
    if (isAmbiguousSpawnError(error)) throw error;
    // Best-effort reap of our own just-spawned child (it has no persisted
    // identity, so leaving it running guarantees an orphan). Guard the error
    // channel first so a late async spawn error cannot crash the server.
    child.on("error", () => undefined);
    if (pid !== undefined) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    // Still ambiguous even when the kill seemingly succeeds: the worker ran
    // (or may have run) with no persisted identity. Never claim pre-spawn.
    throw new AmbiguousSpawnError(
      `spawn succeeded but run identity persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      child
    );
  }
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
  isCanary: boolean,
  attemptN = 1
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, lastMessageRelPathForAttempt("codex", attemptN, run.runId));
  return spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildCodexCanaryArgv(profile, prompt, lastMessagePath), timeoutMs, lastMessagePath, isCanary, attemptN);
}

function launchOpenCodeCanary(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  model: string,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean,
  sessionId?: string,
  attemptN = 1
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, lastMessageRelPathForAttempt("opencode", attemptN, run.runId));
  return spawnCanaryChild(deps, bridgeDir, run, resolveOpenCodeBinary(), buildOpenCodeCanaryArgv(model, prompt, sessionId), timeoutMs, lastMessagePath, isCanary, attemptN);
}

function launchClaudeChild(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  argv: string[],
  timeoutMs: number,
  prompt: string,
  isCanary: boolean,
  attemptN = 1
): ChildProcess {
  // Claude runs non-interactive (-p --output-format json): worker JSON goes
  // to stdout (captured in the bounded live tails); the last-message path is
  // recorded for evidence-route parity with the other engines.
  const lastMessagePath = path.join(run.workdir, lastMessageRelPathForAttempt("claude", attemptN, run.runId));
  return spawnCanaryChild(deps, bridgeDir, run, resolveClaudeBinary(), argv, timeoutMs, lastMessagePath, isCanary, attemptN);
}

function launchCodexResume(
  deps: DelegationToolDeps,
  bridgeDir: string,
  run: DelegationRunRecord,
  sessionId: string,
  timeoutMs: number,
  prompt: string,
  isCanary: boolean,
  attemptN = 1
): ChildProcess {
  const lastMessagePath = path.join(run.workdir, lastMessageRelPathForAttempt("codex", attemptN, run.runId));
  return spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(), buildCodexResumeArgv(sessionId, prompt, lastMessagePath), timeoutMs, lastMessagePath, isCanary, attemptN);
}

function runSummary(run: DelegationRunRecord): Record<string, unknown> {
  // Truthful: no-target events count as undelivered (never silent 0).
  const undelivered = run.pendingEvents.filter(isEventUndelivered).length;
  const noTarget = run.pendingEvents.filter((event) => event.deliveries.length === 0).length;
  const failedDeliveries = run.pendingEvents.flatMap((event) =>
    event.deliveries.filter((delivery) => delivery.status === "failed" || delivery.status === "permanent")
      .map((delivery) => ({ eventId: event.eventId, subId: delivery.subId, status: delivery.status, error: delivery.lastError ?? null })));
  return {
    run_id: run.runId,
    delegation_group: run.delegationGroup,
    is_canary: run.isCanary !== false,
    engine: run.engine,
    ...(run.profile ? { profile: run.profile } : {}),
    ...(run.agent ? { agent: run.agent } : {}),
    ...(run.executionPolicy ? { execution_policy: run.executionPolicy } : {}),
    ...(run.permissionMode ? { permission_mode: run.permissionMode } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.session?.sessionId ? { session_id: run.session.sessionId } : {}),
    state: run.state,
    seq: run.seq,
    attempts: run.attempts.length,
    pending_events: run.pendingEvents.length,
    undelivered_events: undelivered,
    no_target_events: noTarget,
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

/**
 * Honest worker-output evidence. Nonempty stdout/stderr tails prove OUTPUT
 * PRESENCE ONLY, never that tests ran: worker output is not parsed for test
 * results. Every artifact reports present/truncated/unavailable with an
 * explicit reason; missing or empty evidence is labeled unavailable, never a
 * pass. Exported for the focused regression proof.
 */
export type EvidenceArtifactStatus = "present" | "truncated" | "unavailable";

export interface EvidenceArtifactReport {
  status: EvidenceArtifactStatus;
  truncated: boolean;
  bytes?: number;
  reason?: string;
}

export interface TestEvidenceReport {
  exit_code: number | null;
  timed_out: boolean;
  stdout_tail_present: boolean;
  stderr_tail_present: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  unavailable: boolean;
  unavailable_reason?: string;
  stdout: EvidenceArtifactReport;
  stderr: EvidenceArtifactReport;
  diff: EvidenceArtifactReport;
  last_message: EvidenceArtifactReport & { path?: string; attempt_n?: number };
  tests: EvidenceArtifactReport;
  output_note: string;
}

/** Engine last-message filename (durable output artifact in the run workdir). */
export function lastMessageRelPath(engine: DelegationEngine): string {
  return engine === "codex"
    ? "codex-last-message.md"
    : engine === "opencode"
      ? "opencode-last-message.json"
      : "claude-last-message.json";
}

/**
 * Per-(run, attempt) output artifact path. New artifacts ALWAYS bind
 * (run_id, attempt): `<stem>-<shortRunId>-attempt-<N><ext>` for EVERY
 * attempt including attempt 1, so two runs sharing one caller-chosen
 * workdir occupy disjoint namespaces and continuations never reuse an
 * earlier attempt's file. Attempt-1 legacy shared names are NOT acceptable
 * for new artifacts. WITHOUT a run id the legacy shape is returned
 * (attempt 1 keeps the legacy name; later attempts are suffixed) for
 * read-only back-compat with pre-binding run files ONLY — never for new
 * writes. Exported for the focused regression proof.
 */
export function lastMessageRelPathForAttempt(engine: DelegationEngine, attemptN: number, runId?: string): string {
  const base = lastMessageRelPath(engine);
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const ext = dot >= 0 ? base.slice(dot) : "";
  const n = Number.isSafeInteger(attemptN) && attemptN >= 1 ? attemptN : 1;
  if (typeof runId === "string" && runId) {
    return `${stem}-${shortRunId(runId)}-attempt-${n}${ext}`;
  }
  if (!Number.isSafeInteger(attemptN) || attemptN <= 1) return base;
  return `${stem}-attempt-${attemptN}${ext}`;
}

/**
 * Ordered run-bound fallback siblings for a preoccupied artifact path: the
 * first absent file wins. Every fallback binds the same (run_id, attempt)
 * as the primary (`<stem>-<short>-attempt-<N>-x<i><ext>`, at most 3); when
 * all are preoccupied the attempt records unavailable rather than
 * overwriting anything. WITHOUT a run id the legacy fallback shape is
 * returned for read-only back-compat ONLY — never for new writes.
 * Exported for the focused regression proof.
 */
export function attemptArtifactFallbackPaths(engine: DelegationEngine, attemptN: number, runId?: string): string[] {
  if (typeof runId === "string" && runId) {
    const primary = lastMessageRelPathForAttempt(engine, attemptN, runId);
    const pdot = primary.lastIndexOf(".");
    const pstem = pdot >= 0 ? primary.slice(0, pdot) : primary;
    const pext = pdot >= 0 ? primary.slice(pdot) : "";
    const out: string[] = [];
    for (let i = 1; i <= 3; i += 1) out.push(`${pstem}-x${i}${pext}`);
    return out;
  }
  const base = lastMessageRelPath(engine);
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const ext = dot >= 0 ? base.slice(dot) : "";
  const out: string[] = [];
  if (!Number.isSafeInteger(attemptN) || attemptN <= 1) {
    // Attempt 1's primary is the legacy name; its first fallback is the
    // same suffixed shape later attempts use as their primary.
    out.push(`${stem}-attempt-1${ext}`);
  } else {
    const primary = lastMessageRelPathForAttempt(engine, attemptN);
    const pdot = primary.lastIndexOf(".");
    const pstem = pdot >= 0 ? primary.slice(0, pdot) : primary;
    const pext = pdot >= 0 ? primary.slice(pdot) : "";
    for (let i = 1; i <= 3; i += 1) out.push(`${pstem}-x${i}${pext}`);
    return out;
  }
  for (let i = 1; i <= 3; i += 1) out.push(`${stem}-x${i}${ext}`);
  return out;
}

/**
 * Exclusively create one artifact file (O_EXCL): succeeds ONLY when the
 * path does not exist yet. An existing file — including an existing EMPTY
 * file (empty = unavailable, never a slot to fill) — is never overwritten,
 * never truncated, never filled. Returns the created relative path, or null
 * when the path is preoccupied. Never throws.
 */
export function exclusivelyCreateArtifact(workdir: string, relPath: string, text: string): string | null {
  if (relPath.includes("..") || path.isAbsolute(relPath)) return null;
  const abs = path.join(workdir, relPath);
  let fd = -1;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
    fd = fs.openSync(abs, "wx", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    return relPath;
  } catch {
    return null;
  } finally {
    if (fd !== -1) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Describe one attempt's durable last-message artifact WITH provenance:
 * ONLY the recorded path from this run/attempt's finalize record is ever
 * surfaced, and a nonempty file reads present ONLY with a provenance
 * verdict that proves this run created it (O_EXCL `created:true`, or a
 * `worker` verdict for a run-bound worker-written file). A preoccupied,
 * shared, foreign, empty, or absent file is explicitly unavailable with a
 * reason — never presented as this run's present result. WITHOUT a
 * recorded path there is deliberately NO legacy-name fallback lookup: a
 * preoccupied shared file must never surface as the current result.
 * A bare string carries no creation proof and never reads present on a
 * nonempty file (pass the structured finalize record instead); the string
 * form is accepted only so pre-verdict callers fail closed with a reason
 * instead of throwing.
 */
export function describeAttemptArtifact(
  workdir: string,
  engine: DelegationEngine,
  attemptN: number,
  recordedRelPath?: string | Pick<NonNullable<DelegationAttempt["outputArtifact"]>, "relPath" | "created"> & { provenance?: "created" | "worker" | "unavailable"; reason?: string }
): EvidenceArtifactReport & { path?: string; attempt_n: number } {
  const recorded = typeof recordedRelPath === "string"
    ? { relPath: recordedRelPath, created: false as const }
    : recordedRelPath;
  if (!recorded || !recorded.relPath || recorded.relPath.includes("..") || path.isAbsolute(recorded.relPath)) {
    return {
      status: "unavailable", truncated: false, attempt_n: attemptN,
      reason: `attempt ${attemptN} has no recorded artifact provenance; a shared last-message file (if any) is never presented without this run's provenance`
    };
  }
  const rel = recorded.relPath;
  try {
    const stat = fs.statSync(path.join(workdir, rel));
    if (!stat.isFile()) {
      return {
        path: undefined, status: "unavailable", truncated: false, bytes: 0, attempt_n: attemptN,
        reason: `attempt ${attemptN} artifact ${rel} exists but is not a file`
      };
    }
    if (stat.size === 0) {
      return {
        path: rel, status: "unavailable", truncated: false, bytes: 0, attempt_n: attemptN,
        reason: `attempt ${attemptN} artifact ${rel} is empty (empty = unavailable, never a slot to fill)`
      };
    }
    if (recorded.provenance === "unavailable") {
      return {
        path: rel, status: "unavailable", truncated: false, bytes: stat.size, attempt_n: attemptN,
        reason: recorded.reason ?? `attempt ${attemptN} artifact ${rel} carries no this-run creation proof (preoccupied or unproven); never presented as present`
      };
    }
    if (recorded.created === true || recorded.provenance === "created" || recorded.provenance === "worker") {
      return { path: rel, status: "present", truncated: false, bytes: stat.size, attempt_n: attemptN };
    }
    return {
      path: rel, status: "unavailable", truncated: false, bytes: stat.size, attempt_n: attemptN,
      reason: `attempt ${attemptN} artifact ${rel} is a pre-existing file without this run's creation proof (never claimed as this run's output)${recorded.reason ? `; ${recorded.reason}` : ""}`
    };
  } catch { /* absent below */ }
  void engine;
  return {
    status: "unavailable", truncated: false, attempt_n: attemptN,
    reason: `attempt ${attemptN} artifact absent (no ${rel}; the worker wrote none and finalize created none)`
  };
}

/**
 * Describe the durable last-message artifact WITHOUT inlining it: presence,
 * byte size, and — ONLY when the file exists — the relative path so the
 * consumer reads it through the ordinary read route. A nonexistent file is
 * reported as unavailable with a reason and NO path (never point at a
 * last-message file that is not there). Empty or absent is explicitly
 * unavailable, never a pass.
 */
export function describeLastMessageArtifact(
  workdir: string,
  engine: DelegationEngine
): EvidenceArtifactReport & { path?: string } {
  const rel = lastMessageRelPath(engine);
  try {
    const stat = fs.statSync(path.join(workdir, rel));
    if (!stat.isFile()) return { status: "unavailable", truncated: false, reason: "last-message path exists but is not a file" };
    if (stat.size === 0) return { status: "unavailable", truncated: false, bytes: 0, reason: "last-message file is empty" };
    return { path: rel, status: "present", truncated: false, bytes: stat.size };
  } catch {
    return { status: "unavailable", truncated: false, reason: "last-message file absent (the worker wrote none); inspect the workdir through the ordinary read route" };
  }
}

function tailArtifact(
  tail: string | undefined,
  truncated: boolean,
  label: string
): EvidenceArtifactReport {
  const text = String(tail ?? "");
  if (!text) {
    return { status: "unavailable", truncated: false, reason: `no captured ${label} tail (worker produced none or the run has no terminal result)` };
  }
  if (truncated) {
    return { status: "truncated", truncated: true, bytes: Buffer.byteLength(text, "utf8"), reason: `older ${label} output exists beyond the bounded tail; larger evidence rides the run workdir through the ordinary read route` };
  }
  return { status: "present", truncated: false, bytes: Buffer.byteLength(text, "utf8") };
}

export function buildTestEvidence(input: {
  terminal: boolean;
  state: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTail?: string;
  stderrTail?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  diffKind: "git" | "snapshot" | "unavailable";
  diffReason?: string;
  /** Changed-list bound (git status / snapshot slicing). */
  diffTruncated?: boolean;
  /** Content-fingerprint coverage bound (500-file limit hit). */
  fingerprintsTruncated?: boolean;
  /** Coverage-limit explanation (500-file / 256-KiB bounds). */
  coverageReason?: string;
  lastMessage: EvidenceArtifactReport & { path?: string; attempt_n?: number };
}): TestEvidenceReport {
  const tailsPresent = Boolean((input.stdoutTail ?? "") || (input.stderrTail ?? ""));
  const unavailable = !input.terminal || !tailsPresent;
  return {
    exit_code: input.exitCode,
    timed_out: input.timedOut,
    stdout_tail_present: Boolean(input.stdoutTail),
    stderr_tail_present: Boolean(input.stderrTail),
    stdout_truncated: input.stdoutTruncated,
    stderr_truncated: input.stderrTruncated,
    unavailable,
    ...(unavailable
      ? { unavailable_reason: !input.terminal ? `run is ${input.state}; no terminal worker evidence yet` : "worker produced no captured output tails" }
      : {}),
    stdout: tailArtifact(input.stdoutTail, input.stdoutTruncated, "stdout"),
    stderr: tailArtifact(input.stderrTail, input.stderrTruncated, "stderr"),
    diff: input.diffKind === "unavailable"
      ? { status: "unavailable", truncated: false, reason: input.diffReason ?? "workdir change evidence unavailable" }
      : (() => {
        const truncated = Boolean(input.diffTruncated) || Boolean(input.fingerprintsTruncated);
        const reasons: string[] = [];
        if (input.diffTruncated) reasons.push("changed-file list hit its bound; older entries exist beyond what is shown");
        if (input.coverageReason) reasons.push(input.coverageReason);
        else if (input.fingerprintsTruncated) reasons.push("content fingerprints hit the 500-file bound; files beyond the bound are unattributed by content");
        return truncated
          ? { status: "present", truncated: true, reason: reasons.join("; ") }
          : { status: "present", truncated: false };
      })(),
    last_message: input.lastMessage,
    tests: {
      status: "unavailable",
      truncated: false,
      reason: "worker output is not parsed for test results; a nonempty tail proves output presence only, never that tests ran — inspect the tails and the last-message file through the ordinary read route"
    },
    output_note: "nonempty stdout/stderr tails prove output presence only, never that tests ran"
  };
}

export function delegationToolDefs(deps: DelegationToolDeps): DelegationToolDef[] {
  const launchArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id. Omit to use the session-selected workspace."),
    engine: z.enum(["codex", "opencode", "claude"]).describe("Engine adapter: codex via `codex exec --profile`, opencode via `opencode run --standalone --model/--agent --format json` (private server per turn), claude via `-p --output-format json --agent`. Flags are never shared across engines and engines are never substituted."),
    profile: z.string().max(128).optional().describe("Explicit Codex profile name by real name (required for engine codex; legacy canary Luna-gated, real tasks profile-gated)."),
    agent: z.string().max(128).optional().describe("Explicit OpenCode/Claude agent name by real name (required for real tasks on opencode/claude; optional legacy canary on opencode; Codex profiles are never translated)."),
    model: z.string().max(256).optional().describe("Engine model flag, explicit only: required for engine opencode (host-model equality is canary-only); codex -m override and claude --model only when explicitly passed (otherwise the profile/agent is inherited, never replaced)."),
    effort: z.string().max(16).optional().describe("Explicit Claude --effort (low|medium|high|xhigh|max). Only when explicitly passed; otherwise the agent definition governs."),
    permission_mode: z.string().max(32).optional().describe("Explicit Claude --permission-mode (acceptEdits|auto|bypassPermissions|manual|dontAsk|plan). Only when explicitly passed; bypassPermissions is explicit-only."),
    allowed_tools: z.string().max(2048).optional().describe("Explicit Claude --allowedTools text. Only when explicitly passed."),
    disallowed_tools: z.string().max(2048).optional().describe("Explicit Claude --disallowedTools text. Only when explicitly passed."),
    execution_policy: z.string().max(32).optional().describe("Explicit Codex sandbox for real tasks (read-only|workspace-write|danger-full-access). Explicit wins over the profile; danger-full-access is explicit-only, never inherited or auto-escalated; refused for the legacy canary slice."),
    bypass_approvals: z.boolean().optional().describe("Separate explicit per-run opt-in to --dangerously-bypass-approvals-and-sandbox (codex only). Honored ONLY with explicit execution_policy danger-full-access; the sandbox alone never implies it (sandbox != bypass); refused for the legacy canary slice."),
    config_overrides: z.array(z.string().max(512)).max(8).optional().describe("Explicit Codex -c key=value overrides (bounded). Only when explicitly passed; refused for the legacy canary slice; keys that would set model/effort/sandbox/approval are protected and refused."),
    session_id: z.string().max(128).optional().describe("Explicit session id: opencode ses-id continues-or-creates via `run --standalone --session`; claude UUID rides --session-id (first use creates) or --resume when verified. Omit to let the route mint one. First use creates; resumed is claimed only after verification."),
    task: z.string().max(9000).optional().describe("Real worker input (bounded to 8000 chars after control-strip, validated, never empty). Omit for the legacy read-only canary slice (requires canary=true; codex/opencode only)."),
    delegation_group: z.string().max(64).optional().describe("Delegation group id (bounded, validated /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/; default hestia-cli-canary). Scopes subscription filters and events."),
    workdir: z.string().min(1).max(1024).describe("Explicit workspace-relative working directory for the disposable canary run."),
    request_id: z.string().min(1).max(128).optional().describe("Idempotency key. Repeating it returns the existing run without spawning a second worker."),
    canary: z.boolean().optional().describe("Must be true when no task is supplied (legacy read-only canary slice, codex/opencode only). Ignored when task is present."),
    timeout_ms: z.number().int().positive().optional().describe("Explicit bounded attempt timeout in ms. Canary clamps to 5 minutes; real tasks clamp to 30 minutes; 10s minimum. The clamped value is truthfully acked.")
  }).strict();

  const previewArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id. Omit to use the session-selected workspace."),
    engine: z.enum(["codex", "opencode", "claude"]).describe("Engine adapter to preview (never substituted)."),
    profile: z.string().max(128).optional().describe("Explicit Codex profile name by real name."),
    agent: z.string().max(128).optional().describe("Explicit OpenCode/Claude agent name by real name."),
    model: z.string().max(256).optional().describe("Explicit model flag (opencode required; codex -m / claude --model only when explicitly passed)."),
    effort: z.string().max(16).optional().describe("Explicit Claude --effort."),
    permission_mode: z.string().max(32).optional().describe("Explicit Claude --permission-mode."),
    allowed_tools: z.string().max(2048).optional().describe("Explicit Claude --allowedTools text."),
    disallowed_tools: z.string().max(2048).optional().describe("Explicit Claude --disallowedTools text."),
    execution_policy: z.string().max(32).optional().describe("Explicit Codex sandbox (read-only|workspace-write|danger-full-access)."),
    bypass_approvals: z.boolean().optional().describe("Separate explicit per-run opt-in to --dangerously-bypass-approvals-and-sandbox (codex only; explicit danger-full-access required)."),
    config_overrides: z.array(z.string().max(512)).max(8).optional().describe("Explicit Codex -c key=value overrides."),
    session_id: z.string().max(128).optional().describe("Explicit session id (opencode ses-id or claude UUID)."),
    task: z.string().max(9000).optional().describe("Real worker input (bounded, validated). Omit for the legacy read-only canary slice (requires canary=true; codex/opencode only)."),
    delegation_group: z.string().max(64).optional().describe("Delegation group id (default hestia-cli-canary)."),
    workdir: z.string().min(1).max(1024).describe("Explicit workspace-relative working directory that would host the run."),
    canary: z.boolean().optional().describe("Must be true when no task is supplied (legacy read-only canary slice, codex/opencode only)."),
    timeout_ms: z.number().int().positive().optional().describe("Explicit bounded attempt timeout in ms (clamped + truthfully acked like launch).")
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

  const replayArgs = z.object({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID.optional()
  }).strict();

  const eventsSubscribeArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id for access validation (must be permitted). Subscriptions always persist under the canonical subscription authority shared across permitted workspaces. Omit for the session workspace."),
    callback_url: z.string().max(2048).describe("HTTPS webhook callback. Private/local targets and redirects are refused."),
    event_name: z.string().optional().describe("Must be run-attention when set."),
    filter: z.object({
      delegation_group: z.string().optional(),
      run_id: z.string().optional()
    }).passthrough().optional().describe("Narrow delivery: owner plus delegation-group/run id."),
    webhook_secret: z.string().max(256).describe("Standard Webhooks secret starting with whsec_ (24-64 bytes entropy).")
  }).strict();

  const eventsUnsubscribeArgs = z.object({
    workspace_id: WORKSPACE_ID.optional().describe("Workspace id for access validation (must be permitted). Removal applies to the canonical subscription authority. Omit for the session workspace."),
    subscription_id: z.string().min(1).max(128)
  }).strict();

  const defs: DelegationToolDef[] = [
    {
      name: "delegation_launch",
      options: {
        title: "Delegation Launch",
        description: "Launch one durable delegation run (Codex via exec --profile with Luna gate for the legacy canary / selected-profile gate + per-run execution policy for real tasks; OpenCode via run --model/--agent with host-model gate for the legacy canary / selected-agent + explicit model for real tasks; Claude via -p --output-format json --agent with explicit-flag-only overrides for real tasks only). Real bounded task + validated delegation_group (default hestia-cli-canary), or the legacy canary slice (fixtures, canary=true; codex/opencode only). Requires an explicit workdir plus profile (codex), model (+ agent for real tasks, opencode), or agent (claude); idempotent request ids never spawn a second worker. Prefer delegation_preview (dry-run) before dispatch. Subscribe to events before launching or replay via delegation_read_result so fast completion never loses the result.",
        inputSchema: publicSchemaFrom(launchArgs),
        runtimeInputSchema: launchArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const gated = gateLaunchRequest(args as Record<string, unknown>);
        if (!gated.ok) return failResult(gated.text, gated.structured);
        const plan = gated.plan;
        const engine = plan.engine;
        const delegationGroup = plan.delegationGroup;
        const taskText = plan.taskText;
        const isCanary = plan.isCanary;
        const prompt = plan.prompt;
        const profile = plan.profile;
        const model = plan.model;
        const agent = plan.agent;
        const gateEvidence = plan.gateEvidence;
        // Idempotency first: an exact replay (id lookup + conflict check)
        // resolves BEFORE the active-session busy check, so an identical
        // retry with the same request id and session replays instead of
        // rejecting itself as session_busy. Only a genuinely new request id
        // reaches the busy check below.
        const requestId = String(args.request_id ?? "").trim() ||
          `req_${createHash("sha256").update(`${Date.now()}:${process.pid}:${Math.random()}`).digest("hex").slice(0, 16)}`;
        const existing = findRunByRequestId(bridgeDir, requestId);
        if (existing) {
          if (!ownerAllowed(deps, existing)) return denyAccess();
          // Candidate canonical workdir for identity: the same request id
          // with a different canonical directory is a conflicting re-use
          // (duplicate_conflicting), never a replay of the old run. Resolve
          // here (no mkdir, no side effect); an unresolvable candidate
          // workdir fails closed as workdir_rejected (identity unprovable).
          let candidateWorkdir: string;
          try {
            candidateWorkdir = deps.guard.resolve(workspace, String(args.workdir), { forWrite: true }).absPath;
          } catch (error) {
            return failResult(`Workdir rejected: ${error instanceof Error ? error.message : String(error)}`, { error: "workdir_rejected" });
          }
          // Same request id with different worker-input content (including
          // a different canonical workdir) is a conflicting re-use, not a
          // replay: refuse without spawning a second worker and without
          // consuming anything.
          if (isLaunchRequestConflict(existing, {
            engine,
            delegationGroup,
            isCanary,
            ...(isCanary ? {} : { task: taskText }),
            workdir: candidateWorkdir,
            ...(engine === "codex"
              ? {
                profile,
                executionPolicy: plan.executionPolicy,
                ...(plan.model ? { modelOverride: plan.model } : {}),
                ...(plan.configOverrides.length > 0 ? { configOverrides: plan.configOverrides } : {}),
                ...(plan.bypassApprovals ? { bypassApprovals: true as const } : {})
              }
              : engine === "opencode"
                ? { model, ...(agent ? { agent } : {}), ...(plan.requestedSessionId ? { sessionId: plan.requestedSessionId } : {}) }
                : {
                  agent,
                  ...(model ? { model } : {}),
                  ...(plan.permissionMode ? { permissionMode: plan.permissionMode } : {}),
                  ...(plan.effort ? { effort: plan.effort } : {}),
                  ...(plan.allowedTools ? { allowedTools: plan.allowedTools } : {}),
                  ...(plan.disallowedTools ? { disallowedTools: plan.disallowedTools } : {}),
                  ...(plan.requestedSessionId ? { sessionId: plan.requestedSessionId } : {})
                })
          })) {
            return failResult(`Conflicting re-use of request ${requestId}: it already owns run ${existing.runId} with different task/group/model/workdir content. Relaunch only with a NEW request id. No second worker spawned.`, {
              error: "duplicate_conflicting",
              run_id: existing.runId,
              request_id: requestId,
              stored: false,
              executed: false
            });
          }
          // Fail-closed crash window: a staged launch that never persisted a
          // pid and never observed a spawn failure is uncertain (possible
          // pid-less orphan). Never auto-spawn a second worker; require
          // explicit recover (inspect + cancel/replay). The same holds for
          // legacy pid-less running/queued launches that predate pending
          // staging. Terminal runs are not uncertain: they already settled.
          if (!DELEGATION_TERMINAL_STATES.has(existing.state) && isUncertainDispatch(existing)) {
            return failResult(`Launch dispatch for request ${requestId} is uncertain (run ${existing.runId} holds a pid-less pending launch with no observed spawn failure; a crash between spawn and pid save is possible with a pid-less orphan). No second worker spawned. Inspect via delegation_read_result, cancel any orphan via delegation_cancel, then relaunch only with explicit recover (never auto-spawn).`, {
              error: "launch_uncertain",
              run_id: existing.runId,
              request_id: requestId,
              stored: false,
              executed: false,
              uncertain_dispatch: true,
              next_action: existing.nextAction
            });
          }
          if (!DELEGATION_TERMINAL_STATES.has(existing.state) && !existing.pendingDispatch && isRunPidLess(existing) &&
            (existing.state === "running" || existing.state === "queued")) {
            return failResult(`Launch dispatch for request ${requestId} is uncertain (run ${existing.runId} is ${existing.state} but never persisted a pid; a crash between spawn and pid save is possible with a pid-less orphan). No second worker spawned. Inspect via delegation_read_result, cancel any orphan via delegation_cancel, then relaunch only with explicit recover (never auto-spawn).`, {
              error: "launch_uncertain",
              run_id: existing.runId,
              request_id: requestId,
              stored: false,
              executed: false,
              uncertain_dispatch: true,
              next_action: existing.nextAction
            });
          }
          return okResult(`Idempotent replay: request ${requestId} already owns run ${existing.runId} (state ${existing.state}). No second worker spawned.`, {
            run_id: existing.runId, request_id: requestId, state: existing.state, idempotent_replay: true, next_action: existing.nextAction
          });
        }
        // Fresh request id only: one active turn per explicit session.
        // Explicit session only: opencode ses-id or claude UUID. Claude mints
        // a stable UUID when omitted (always passed via --session-id, so
        // resume identity is deterministic); opencode omits the flag and the
        // worker mints (observed best-effort).
        let sessionId: string | undefined;
        if (plan.requestedSessionId) {
          const holders = activeSessionHolders(listDelegationRuns(bridgeDir), plan.requestedSessionId);
          if (holders.length > 0) {
            return failResult(`Session ${plan.requestedSessionId} already has an active turn (${holders[0].runId}); one active turn per session.`, {
              error: "session_busy",
              session_id: plan.requestedSessionId,
              holder_run_id: holders[0].runId
            });
          }
          sessionId = plan.requestedSessionId;
        } else if (engine === "claude") {
          sessionId = newClaudeSessionId();
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
        const timeoutMs = plan.timeoutMs;
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
        // Workdir baseline for attributable change evidence, taken AFTER
        // fixture staging so the baseline includes canary inputs: a bounded
        // listing snapshot + content fingerprints (edits to existing files,
        // including files git does not track) + the git commit baseline
        // (HEAD) where the workdir is a repo (worker commits are attributable;
        // `git status` alone cannot show committed work).
        let workdirBaseline: WorkdirBaseline;
        try {
          workdirBaseline = captureWorkdirBaseline(resolved.absPath);
        } catch {
          workdirBaseline = {};
        }
        const session: DelegationSessionBinding = engine === "codex"
          ? {
            engine: "codex",
            resumable: false,
            observed: false,
            evidence: "codex ephemeral run persists no session; follow-up is a new attempt by construction",
            reason: "codex ephemeral run persists no session; follow-up starts a labeled new-continuation-attempt"
          }
          : engine === "opencode"
            ? sessionId
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
              }
            : {
              engine: "claude",
              sessionId: sessionId as string,
              resumable: false,
              observed: false,
              evidence: plan.requestedSessionId
                ? "explicit --session-id UUID: first use creates, later verified uses resume via --resume"
                : "stable --session-id UUID minted at launch (caller omitted one): first use creates, later verified uses resume via --resume",
              reason: "claude session identity is the stable --session-id UUID; resumed only after the session file verifies"
            };
        const attemptSummary = engine === "codex"
          ? isCanary
            ? `canary attempt started via codex exec --profile ${profile}`
            : `real-task attempt started via codex exec --profile ${profile} -s ${plan.executionPolicy} (${taskText.length} chars, group ${delegationGroup})`
          : engine === "opencode"
            ? isCanary
              ? `canary attempt started via opencode run --standalone --model ${model}`
              : `real-task attempt started via opencode run --standalone --model ${model} --agent ${agent} (${taskText.length} chars, group ${delegationGroup})`
            : `real-task attempt started via claude --agent ${agent} --session-id ${(sessionId as string).slice(0, 8)}… (${taskText.length} chars, group ${delegationGroup})`;
        let run: DelegationRunRecord = {
          version: 1,
          runId,
          requestId,
          delegationGroup,
          engine,
          ...(engine === "codex" ? { profile, executionPolicy: plan.executionPolicy, ...(plan.model ? { modelOverride: plan.model } : {}), ...(plan.configOverrides.length > 0 ? { configOverrides: plan.configOverrides } : {}), ...(plan.bypassApprovals ? { bypassApprovals: true as const } : {}) } : {}),
          ...(engine === "opencode" ? { model, ...(agent ? { agent } : {}), requestedSessionId: plan.requestedSessionId, opencodeRoute: "standalone" as const } : {}),
          ...(engine === "claude" ? { agent, ...(model ? { model } : {}), ...(plan.permissionMode ? { permissionMode: plan.permissionMode } : {}), ...(plan.effort ? { effort: plan.effort } : {}), ...(plan.allowedTools ? { allowedTools: plan.allowedTools } : {}), ...(plan.disallowedTools ? { disallowedTools: plan.disallowedTools } : {}), requestedSessionId: plan.requestedSessionId } : {}),
          ...(isCanary ? { isCanary: true } : { isCanary: false, task: taskText }),
          workdirBaseline,
          executable: plan.executable,
          binaryOverridden: engineBinaryOverridden(engine),
          session,
          attemptTimeoutMs: timeoutMs,
          workspaceId: workspace.id,
          workspaceCanonical: workspace.root,
          workdir: resolved.absPath,
          ownerIdHash: owner.ownerIdHash,
          ownerKind: owner.ownerKind,
          state: "queued",
          seq: 0,
          attempts: [],
          pendingEvents: [],
          checkpoints: [],
          appliedCheckpointIds: [],
          lastAppliedCheckpointSeq: -1,
          inputRequests: [],
          nextAction: "launch staged as pending-dispatch; dispatching initial attempt",
          createdAt: now,
          updatedAt: now
        };
        // Crash-safe initial launch: reserve attempt 1 as pending-dispatch
        // BEFORE spawn (request id reserved, no pid yet). A crash between
        // spawn success and pid save leaves a pid-less pending launch that
        // retry must fail closed as launch_uncertain (never a second worker).
        run = stagePendingLaunch(run, {
          requestId,
          attemptN: 1,
          timeoutMs,
          prompt,
          sessionEvidence: engine === "codex"
            ? `initial launch via codex exec --profile ${profile} (${plan.gateReason})`
            : engine === "opencode"
              ? `initial launch via opencode run --standalone --model ${model}${agent ? ` --agent ${agent}` : ""} (${plan.gateReason})`
              : `initial launch via claude --agent ${agent} --session-id ${plan.requestedSessionId || "minted"} (${plan.gateReason})`
        });
        saveDelegationRun(bridgeDir, run);
        try {
          if (engine === "codex") {
            launchCodexReal(deps, bridgeDir, run, plan, timeoutMs, prompt, isCanary);
          } else if (engine === "opencode") {
            launchOpenCodeReal(deps, bridgeDir, run, plan, timeoutMs, prompt, isCanary, sessionId);
          } else {
            launchClaudeChild(deps, bridgeDir, run, buildPlannedArgv(plan, prompt, path.join(run.workdir, lastMessageRelPathForAttempt("claude", 1, run.runId)), sessionId), timeoutMs, prompt, isCanary);
          }
        } catch (error) {
          // Ambiguous post-spawn (child spawned OK, then identity-save
          // failed): NEVER mark terminal failed and NEVER clear the staged
          // pid-less launch reservation. The persisted record stays
          // non-terminal and pid-less, so a same-ID retry fails closed as
          // launch_uncertain (inspect + cancel/replay, never a second
          // worker). Reload from disk: the in-memory run may carry an
          // unpersisted pid from the failed save boundary.
          if (isAmbiguousSpawnError(error)) {
            const uncertain = loadDelegationRun(bridgeDir, runId) ?? run;
            return failResult(`Launch dispatch for request ${requestId} is uncertain (run ${runId} holds a pid-less pending launch; spawn succeeded but run identity was not persisted, so a pid-less orphan may exist). No second worker spawned. Inspect via delegation_read_result, cancel any orphan via delegation_cancel, then relaunch only with explicit recover (never auto-spawn).`, {
              error: "launch_uncertain",
              run_id: runId,
              request_id: requestId,
              stored: false,
              executed: false,
              uncertain_dispatch: true,
              next_action: uncertain.nextAction
            });
          }
          run = loadDelegationRun(bridgeDir, runId) ?? run;
          // Observed sync spawn failure after staging (no worker started):
          // drop the launch reservation and mark terminal failed. Retry
          // with the SAME request id replays the failed run (no second
          // worker); a fresh attempt needs a NEW request id. This is
          // distinct from crash-before-save AND from ambiguous post-spawn
          // (pid-less pending, no observed pre-spawn failure, non-terminal),
          // both of which stay uncertain and fail closed as launch_uncertain
          // on retry.
          if (run.pendingDispatch?.isLaunch) {
            run = clearPendingDispatch(run);
          }
          run.state = "failed";
          const latest = run.attempts.at(-1);
          if (latest) {
            latest.state = "failed";
            latest.finishedAt = new Date().toISOString();
            latest.summary = sanitizeSummary(`launch failed: ${error instanceof Error ? error.message : String(error)}`);
          } else {
            run.attempts = [{
              n: 1,
              startedAt: now,
              finishedAt: new Date().toISOString(),
              state: "failed",
              summary: sanitizeSummary(`launch failed: ${error instanceof Error ? error.message : String(error)}`)
            }];
          }
          run.result = { exitCode: 127, signal: null, timedOut: false, summary: sanitizeSummary(error instanceof Error ? error.message : String(error)) };
          enqueueTerminalEvent(run, loadSubscriptions(subscriptionAuthorityDirFor(deps.config)));
          saveDelegationRun(bridgeDir, run);
          return failResult(`Launch failed: ${error instanceof Error ? error.message : String(error)}`, { error: "launch_failed", run_id: runId });
        }
        // Spawn returned synchronously (no throw): confirm the staged launch
        // in the SAME pid-save boundary. spawnCanaryChild already persisted
        // the pid on the queued pending attempt (preserving pending); here
        // promote that queued attempt to running and clear the pending
        // reservation atomically. A crash before this save leaves pid-less
        // pending (uncertain, fail closed); a crash after leaves running with
        // a pid (idempotent replay, no second worker).
        {
          const confirmed = loadDelegationRun(bridgeDir, runId) ?? run;
          const stagedN = confirmed.pendingDispatch?.attemptN ?? 1;
          const latest = confirmed.attempts.find((a) => a.n === stagedN);
          if (latest) {
            latest.state = "running";
            latest.summary = sanitizeSummary(attemptSummary);
          }
          const { pendingDispatch: _droppedLaunch, ...restLaunch } = confirmed as DelegationRunRecord;
          run = {
            ...(restLaunch as DelegationRunRecord),
            state: "running",
            nextAction: "poll delegation_read_result or await the run-attention event"
          };
          saveDelegationRun(bridgeDir, run);
        }
        return okResult(
          engine === "codex"
            ? `${isCanary ? "Canary" : "Real-task"} run ${runId} launched (codex --profile ${profile}, ${plan.gateReason}, group ${delegationGroup}, timeout ${timeoutMs} ms${plan.timeoutClamped ? " (requested value defaulted or clamped, truthfully acked)" : ""}). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`
            : engine === "opencode"
              ? `${isCanary ? "Canary" : "Real-task"} run ${runId} launched (opencode run --standalone --model ${model}${agent ? ` --agent ${agent}` : ""} --format json, ${plan.gateReason}, group ${delegationGroup}, timeout ${timeoutMs} ms${plan.timeoutClamped ? " (requested value defaulted or clamped, truthfully acked)" : ""}${sessionId ? `, session ${sessionId}` : ""}). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`
              : `Real-task run ${runId} launched (claude --agent ${agent} --session-id ${sessionId}, ${plan.gateReason}, group ${delegationGroup}, timeout ${timeoutMs} ms${plan.timeoutClamped ? " (requested value defaulted or clamped, truthfully acked)" : ""}). Subscribe to the run-attention event before launch, or replay via delegation_read_result.`,
          {
            run_id: runId,
            request_id: requestId,
            delegation_group: delegationGroup,
            is_canary: isCanary,
            ...(isCanary ? {} : { task_chars: taskText.length }),
            engine,
            ...(engine === "codex" ? { profile, execution_policy: plan.executionPolicy } : {}),
            ...(engine === "opencode" ? { model, ...(agent ? { agent } : {}), execution_route: "standalone" } : {}),
            ...(engine === "claude" ? { agent, ...(model ? { model } : {}), ...(plan.permissionMode ? { permission_mode: plan.permissionMode } : {}), ...(plan.effort ? { effort: plan.effort } : {}) } : {}),
            ...(sessionId ? { session_id: sessionId } : {}),
            ...gateEvidence,
            engine_qualification: engineQualification(engine),
            workdir: resolved.absPath,
            timeout_ms: timeoutMs,
            timeout_clamped: plan.timeoutClamped,
            state: "running",
            next_action: "subscribe to events_subscribe before completion, or replay via delegation_read_result"
          }
        );
      }
    },
    {
      name: "delegation_preview",
      options: {
        title: "Delegation Preview",
        description: "Read-only resolved-launch preview (dry-run, never spawns a worker, never persists a run): shows the actual executable, argv shape, profile/agent, model/effort WHERE resolvable from the real definition files, execution policy, and working directory, with configured settings separated from runtime-observed evidence. The capability probe executes only `<binary> --version` (binary presence, no model call, bounded timeout). Reports the exact blocker and INCOMPLETE status when the requested engine or profile capability is missing (never substitutes another engine).",
        inputSchema: publicSchemaFrom(previewArgs),
        runtimeInputSchema: previewArgs,
        annotations: READ_ONLY
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        let resolved: { absPath: string; relPath: string };
        try {
          // Resolve only: preview creates no directories and persists nothing.
          resolved = deps.guard.resolve(workspace, String(args.workdir), { forWrite: true });
        } catch (error) {
          return failResult(`Workdir rejected: ${error instanceof Error ? error.message : String(error)}`, { error: "workdir_rejected" });
        }
        const gated = gateLaunchRequest(args as Record<string, unknown>);
        if (!gated.ok) return failResult(gated.text, gated.structured);
        const plan = gated.plan;
        // Preview display template only (dry-run, never persisted, never
        // spawned): the real artifact name binds (run_id, attempt) at
        // launch as <stem>-<shortRunId>-attempt-<N><ext> for EVERY attempt.
        // The "<run-id>" token marks the slot the launch mint fills; this
        // template must never leak into persisted state as a real path.
        const previewArtifactRel = (() => {
          const base = lastMessageRelPath(plan.engine);
          const dot = base.lastIndexOf(".");
          const stem = dot >= 0 ? base.slice(0, dot) : base;
          const ext = dot >= 0 ? base.slice(dot) : "";
          return `${stem}-<run-id>-attempt-1${ext}`;
        })();
        const lastMessagePath = path.join(resolved.absPath, previewArtifactRel);
        // Claude always rides a stable --session-id (minted when omitted):
        // preview shows the explicit id or the mint placeholder, never a fake.
        const sessionForArgv = plan.engine === "claude"
          ? (plan.requestedSessionId || "<uuid minted at launch>")
          : (plan.requestedSessionId || undefined);
        const argvPreview = buildPlannedArgv(plan, `<worker prompt ${plan.prompt.length} chars>`, lastMessagePath, sessionForArgv);
        const capability = probeEngineCapability(plan.engine, {
          profileOrAgent: plan.engine === "codex" ? plan.profile : plan.agent,
          binary: plan.executable
        });
        const preview = buildLaunchPreview({
          engine: plan.engine,
          executable: plan.executable,
          argvPreview,
          promptChars: plan.prompt.length,
          ...(plan.profile ? { profile: plan.profile } : {}),
          ...(plan.agent ? { agent: plan.agent } : {}),
          modelConfigured: plan.configuredModel,
          effortConfigured: plan.configuredEffort,
          modelExplicit: plan.modelExplicit,
          effortExplicit: plan.effortExplicit,
          ...(plan.executionPolicy ? { executionPolicy: plan.executionPolicy } : {}),
          ...(plan.permissionMode ? { permissionMode: plan.permissionMode } : {}),
          workdir: resolved.absPath,
          delegationGroup: plan.delegationGroup,
          isCanary: plan.isCanary,
          timeoutMs: plan.timeoutMs,
          gateReason: plan.gateReason,
          capability,
          qualification: engineQualification(plan.engine)
        });
        return okResult(
          capability.ready
            ? `Preview for engine ${plan.engine}: resolved launch (${plan.gateReason}). No worker spawned, nothing persisted.`
            : `Preview for engine ${plan.engine}: INCOMPLETE (${capability.blocker}). No worker spawned, nothing persisted; fix the blocker, never substitute another engine.`,
          { preview, timeout_clamped: plan.timeoutClamped, ...plan.gateEvidence }
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
        // Truthful: events with zero targets are undelivered (no-targets-
        // pending), never silent 0. Per-event no_targets marks the explicit
        // no-target state; delegation_replay_events attaches current matches.
        const undelivered = current.pendingEvents.filter(isEventUndelivered);
        const noTargetIds = current.pendingEvents
          .filter((event) => event.deliveries.length === 0)
          .map((event) => event.eventId);
        const failedDeliveries = current.pendingEvents.flatMap((event) =>
          event.deliveries.filter((delivery) => delivery.status === "failed" || delivery.status === "permanent")
            .map((delivery) => ({ event_id: event.eventId, sub_id: delivery.subId, status: delivery.status, attempts: delivery.attempts, error: delivery.lastError ?? null, next_retry_at: delivery.nextRetryAt ?? null })));
        // Raw change evidence for Hestia review: git-aware when the workdir
        // is a repo (status plus worker commits since the launch commit
        // baseline), otherwise a snapshot diff against the launch baseline
        // (added/removed by name, content edits by fingerprint). Bounded with
        // an explicit truncation flag; never throws. Legacy run files carry
        // workdirSnapshot (bare listing); newer runs carry workdirBaseline.
        const workdirEvidence = collectWorkdirEvidence(
          current.workdir,
          current.workdirBaseline ?? current.workdirSnapshot
        );
        // Worker-executed test evidence is whatever the worker printed under
        // the selected policy: captured tail + exit code. Nonempty tails prove
        // output presence only, never that tests ran. When the run has no
        // terminal result (or empty tails) the evidence is explicitly
        // unavailable, never implied. The durable last-message file is
        // reported by presence + path (ordinary read route), never inlined,
        // and is bound to the CURRENT attempt by recorded finalize
        // provenance (the attempt's own outputArtifact record: O_EXCL
        // creation or a run-bound worker-write verdict). A preoccupied,
        // shared, or legacy file without this run's recorded provenance is
        // never surfaced as present; a run with no recorded provenance (or
        // no attempts at all) reports unavailable with a reason.
        const terminalStates = DELEGATION_TERMINAL_STATES.has(current.state);
        const currentAttempt = current.attempts.at(-1);
        const lastMessage = currentAttempt
          ? describeAttemptArtifact(current.workdir, current.engine, currentAttempt.n, currentAttempt.outputArtifact)
          : describeAttemptArtifact(current.workdir, current.engine, 0, undefined);
        const testEvidence = buildTestEvidence({
          terminal: terminalStates,
          state: current.state,
          exitCode: current.result?.exitCode ?? null,
          timedOut: current.result?.timedOut ?? false,
          stdoutTail: current.result?.stdoutTail,
          stderrTail: current.result?.stderrTail,
          stdoutTruncated: current.result?.stdoutTruncated ?? false,
          stderrTruncated: current.result?.stderrTruncated ?? false,
          diffKind: workdirEvidence.kind,
          ...(workdirEvidence.reason ? { diffReason: workdirEvidence.reason } : {}),
          ...(workdirEvidence.kind === "unavailable" ? {} : { diffTruncated: workdirEvidence.truncated }),
          ...(workdirEvidence.fingerprintsTruncated ? { fingerprintsTruncated: true as const } : {}),
          ...(workdirEvidence.coverageReason ? { coverageReason: workdirEvidence.coverageReason } : {}),
          lastMessage
        });
        // Execution provenance: which binary ran this worker. Override-route
        // runs (test shims) are labeled as such and are never live proof.
        const provenance = {
          executable: current.executable ?? null,
          binary_overridden: current.binaryOverridden ?? null,
          ...(current.binaryOverridden
            ? { note: "a CODEXPRO_*_BIN override selected the worker executable at launch (test shims ride this route): shim results are never live proof" }
            : current.executable
              ? { note: "default PATH binary at launch (no CODEXPRO_*_BIN override); no shim marker" }
              : { note: "executable provenance unrecorded (legacy run); shim vs live cannot be judged from this record" })
        };
        // Classify codex failures BEFORE any permission change is proposed:
        // only a real tool-execution denial warrants proposing one (still
        // explicit, still per-run, through the confirmation surface).
        const failureClassification = current.engine === "codex" && current.result && current.state !== "completed"
          ? classifyCodexFailure({ exitCode: current.result.exitCode, stderrTail: current.result.stderrTail })
          : null;
        return okResult(
          `# Run ${current.runId}: ${current.state}\n\n${current.result?.summary ?? current.nextAction}`,
          {
            run_id: current.runId,
            delegation_group: current.delegationGroup,
            is_canary: current.isCanary !== false,
            ...(current.task ? { task: current.task } : {}),
            engine: current.engine,
            ...(current.profile ? { profile: current.profile } : {}),
            ...(current.agent ? { agent: current.agent } : {}),
            ...(current.executionPolicy ? { execution_policy: current.executionPolicy } : {}),
            ...(current.permissionMode ? { permission_mode: current.permissionMode } : {}),
            ...(current.model ? { model: current.model } : {}),
            // OpenCode execution route, honestly labeled: new runs record
            // "standalone" (private server per turn); run files that predate
            // the route field are "shared-service" (background service) and
            // are never silently converted.
            ...(current.engine === "opencode"
              ? (() => {
                const routeLabel = opencodeExecutionRoute(current);
                return {
                  execution_route: routeLabel.route,
                  ...(routeLabel.legacy
                    ? { execution_route_note: "legacy run predates the standalone route; labeled shared-service, never silently converted" }
                    : {})
                };
              })()
              : {}),
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
            workdir: current.workdir,
            workdir_evidence: workdirEvidence,
            test_evidence: testEvidence,
            execution_provenance: provenance,
            engine_qualification: engineQualification(current.engine),
            ...(current.lastCancelVerification ? { last_cancel_verification: current.lastCancelVerification } : {}),
            ...(failureClassification ? { failure_classification: failureClassification } : {}),
            ...(failureClassification ? { failure_classification: failureClassification } : {}),
            review_note: "A completed process or green canary NEVER establishes task success: review the raw evidence above (tails, workdir changes, test evidence) against the original task and repo rules before accepting. Nonempty tails prove output presence only, never that tests ran. Larger evidence rides the run workdir (including the last-message file) through the ordinary read route.",
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
            resume_capability: current.engine === "codex" ? CODEX_RESUME_CAPABILITY : current.engine === "opencode" ? OPENCODE_RESUME_CAPABILITY : CLAUDE_RESUME_CAPABILITY,
            ...(includeEvents ? {
              pending_events: current.pendingEvents.map((event) => ({
                event_id: event.eventId, seq: event.seq, state: event.state,
                summary: event.summary ?? null, acked: event.acked ?? false,
                ...(event.deliveries.length === 0 ? { no_targets: true } : {}),
                deliveries: event.deliveries
              })),
              undelivered_count: undelivered.length,
              no_target_events: noTargetIds.length,
              ...(noTargetIds.length ? { no_target_event_ids: noTargetIds } : {})
            } : {}),
            ...(noTargetIds.length ? { replay_hint: "stored event(s) have no delivery targets; attach current matching targets via delegation_replay_events" } : {}),
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
        description: "Durable follow-up Q&A: a checkpoint with questions moves a settled run to needs-input (structured, stored with run id + seq); a checkpoint with input_request_id answers the exact request at most once and launches one bounded continuation (opencode --standalone --session true resume after list/export verification; claude --resume after session-file verification, otherwise the stable --session-id; codex a labeled new attempt under the stored profile + policy). Rejects wrong-run, stale, conflicting-duplicate, unknown/closed/expired requests, and live-attempt races with typed errors. Approval-kind answers never widen the engine gate.",
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
          // config may have drifted since launch. Legacy canary keeps its
          // original gate (Luna / host-model equality); real tasks re-verify
          // the SELECTED profile/agent with the stored per-run policy.
          const runIsCanaryForGate = run.isCanary !== false;
          if (run.engine === "codex") {
            const gate = verifyCodexLaunch(codexHomeDir(), run.profile ?? "", {
              isCanary: runIsCanaryForGate,
              delegationGroup: run.delegationGroup,
              executionPolicy: run.executionPolicy,
              modelOverride: run.modelOverride,
              configOverrides: run.configOverrides
            });
            if (!gate.allowed) {
              return failResult(`Answer not applied: the Codex profile gate refused continuation: ${gate.reason}. Request ${request.id} stays open and the reply was not consumed.`, {
                error: gate.gateKind === "luna" ? "luna_gate_refused" : gate.code,
                run_id: run.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: false,
                executed: false,
                configured: gate.configured
              });
            }
          } else if (run.engine === "opencode") {
            const gate = verifyOpenCodeLaunch({
              model: run.model,
              agent: run.agent,
              isCanary: runIsCanaryForGate,
              delegationGroup: run.delegationGroup
            });
            if (!gate.allowed) {
              return failResult(`Answer not applied: the OpenCode launch gate refused continuation: ${gate.reason}. Request ${request.id} stays open and the reply was not consumed.`, {
                error: gate.code,
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
          } else {
            const gate = verifyClaudeLaunch({
              agent: run.agent,
              model: run.model,
              effort: run.effort,
              permissionMode: run.permissionMode,
              allowedTools: run.allowedTools,
              disallowedTools: run.disallowedTools
            });
            if (!gate.allowed) {
              return failResult(`Answer not applied: the Claude launch gate refused continuation: ${gate.reason}. Request ${request.id} stays open and the reply was not consumed.`, {
                error: gate.code,
                run_id: run.runId,
                checkpoint_id: checkpoint.id,
                input_request_id: request.id,
                stored: false,
                executed: false,
                agent: run.agent ?? null
              });
            }
            const sid = run.session?.sessionId;
            if (sid && isClaudeSessionId(sid)) {
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
          } else if (run.engine === "opencode") {
            const sid = run.session?.sessionId;
            if (sid && isEngineSessionId(sid)) {
              // Verified resume only: the id must have been observed AND be
              // confirmed live by session list/export. First use of an
              // explicit id creates (installed continue-or-create semantics).
              const probe = verifyOpenCodeSession(sid, run.workdir);
              if (probe.verified) {
                continuationLabel = "resumed";
                resumeSessionId = sid;
                spawnNote = `opencode session ${sid} verified live (${probe.evidence}) and continued via run --standalone --session (true resume)`;
                sessionEvidence = probe.evidence;
              } else {
                spawnNote = `opencode session ${sid} unverified (${probe.evidence}): follow-up runs a new attempt (first-use creation), never a resumed session`;
                sessionEvidence = probe.evidence;
              }
            } else {
              spawnNote = "no opencode session id recorded: follow-up runs a new attempt, never a resumed session";
            }
          } else {
            // Claude runs carry a stable --session-id UUID (minted at launch
            // when omitted). Verified session file => true resume via
            // --resume, EXCEPT when the stored run carries explicit
            // model/effort/tool settings: the resume argv drops them (agent +
            // permission-mode only; Claude qualification deferred), so resume
            // is withheld and the full explicit-flag argv runs as a labeled
            // new attempt instead. Otherwise the same id rides --session-id
            // as first-use creation, labeled new-continuation-attempt.
            const sid = run.session?.sessionId;
            const dropsStoredSettings = Boolean(run.model || run.effort || run.allowedTools || run.disallowedTools);
            if (sid && isClaudeSessionId(sid)) {
              const probe = verifyClaudeSession(sid);
              if (probe.verified && dropsStoredSettings) {
                continuationLabel = "new-continuation-attempt";
                resumeSessionId = sid;
                spawnNote = `claude session ${sid} verified (${probe.evidence}) BUT resume withheld: stored explicit model/effort/tool settings would be dropped by --resume (resume argv carries agent + permission-mode only; Claude qualification deferred) — follow-up reuses the full explicit-flag argv as a new attempt, never labeled resumed`;
                sessionEvidence = `session verified (${probe.evidence}); resume withheld (stored explicit model/effort/tool settings would drop under --resume; Claude qualification deferred)`;
              } else if (probe.verified) {
                continuationLabel = "resumed";
                resumeSessionId = sid;
                spawnNote = `claude session ${sid} verified (${probe.evidence}) and continued via --resume (true resume)`;
                sessionEvidence = probe.evidence;
              } else {
                resumeSessionId = sid;
                spawnNote = `claude session ${sid} unverified (${probe.evidence}): follow-up reuses the stable --session-id (first-use creation), never a resumed session`;
                sessionEvidence = probe.evidence;
              }
            } else {
              spawnNote = "no claude session UUID recorded: follow-up runs a new attempt, never a resumed session";
            }
          }
          const n = existingPending ? existingPending.attemptN : run.attempts.length + 1;
          // Fail-closed crash window for follow-up: a pid-less pending with
          // no observed failure marker is uncertain (crash between spawn
          // success and pid save is possible, with a pid-less orphan). The
          // stagedAlivePid liveness gate alone is insufficient: with no pid
          // there is nothing to probe. Never auto-spawn a second worker;
          // require explicit recover (inspect + cancel/replay).
          if (existingPending && isUncertainDispatch(run)) {
            return failResult(`Follow-up dispatch for checkpoint ${checkpoint.id} is uncertain (run ${run.runId} holds a pid-less pending dispatch with no observed spawn failure; a crash between spawn and pid save is possible with a pid-less orphan). No second worker spawned. Inspect via delegation_read_result, cancel any orphan via delegation_cancel, then replay only with explicit recover (never auto-spawn a second worker).`, {
              error: "dispatch_uncertain",
              run_id: run.runId,
              checkpoint_id: checkpoint.id,
              input_request_id: request.id,
              stored: false,
              executed: false,
              uncertain_dispatch: true,
              attempt_n: existingPending.attemptN,
              next_action: run.nextAction
            });
          }
          // Dispatch recovery: reconcile the persisted PID+starttime identity
          // via isProcessIdentityAlive BEFORE any retry, including
          // needs-input. A staged dispatch may have spawned its worker before
          // a crash without confirming (persisted pid on the queued pending
          // attempt). A live staged worker is confirmed without spawning a
          // second worker; only a dead/absent worker respawns (same attemptN).
          // Pid-less pending WITHOUT an observed failure marker never reaches
          // here (uncertain above): the liveness gate alone cannot prove a
          // pid-less dispatch did not spawn.
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
            : run.engine === "opencode"
              ? (resumeSessionId && continuationLabel === "resumed"
                ? `opencode session ${resumeSessionId} verified live (${sessionEvidence}) and continued via run --standalone --session (true resume)`
                : (run.session?.sessionId
                  ? `opencode session ${run.session.sessionId} unverified (${sessionEvidence}): follow-up runs a new attempt (first-use creation), never a resumed session`
                  : "no opencode session id recorded: follow-up runs a new attempt, never a resumed session"))
              : (resumeSessionId && continuationLabel === "resumed"
                ? `claude session ${resumeSessionId} verified (${sessionEvidence}) and continued via --resume (true resume)`
                : (resumeSessionId ?? run.session?.sessionId
                  ? ((staged.sessionEvidence ?? "").includes("resume withheld")
                    ? `claude session ${resumeSessionId ?? run.session?.sessionId} verified but resume withheld (${sessionEvidence}): follow-up reuses the full explicit-flag argv as a new attempt, never labeled resumed`
                    : `claude session ${resumeSessionId ?? run.session?.sessionId} unverified (${sessionEvidence}): follow-up reuses the stable --session-id (first-use creation), never a resumed session`)
                  : "no claude session UUID recorded: follow-up runs a new attempt, never a resumed session"));
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
            // Continuation argv is rebuilt from STORED run fields (profile +
            // execution policy + explicit overrides for codex; agent + model
            // for opencode; agent + explicit flags for claude): the selected
            // identity is preserved, never substituted. The last-message
            // path is per-(run, attempt): a continuation never reuses an
            // earlier attempt's output file as its result.
            const lastMessagePath = path.join(run.workdir,
              lastMessageRelPathForAttempt(run.engine, staged.attemptN, run.runId));
            try {
              if (run.engine === "codex" && continuationLabel === "resumed" && resumeSessionId) {
                child = launchCodexResume(deps, bridgeDir, run, resumeSessionId, staged.timeoutMs, staged.prompt, runIsCanary, staged.attemptN);
              } else if (run.engine === "codex") {
                if (runIsCanary) {
                  child = launchCodexCanary(deps, bridgeDir, run, run.profile ?? "", staged.timeoutMs, staged.prompt, runIsCanary, staged.attemptN);
                } else {
                  const policy = (run.executionPolicy === "workspace-write" || run.executionPolicy === "danger-full-access" || run.executionPolicy === "read-only")
                    ? run.executionPolicy
                    : "read-only";
                  child = spawnCanaryChild(deps, bridgeDir, run, resolveCodexBinary(),
                    buildCodexRealArgv(run.profile ?? "", staged.prompt, lastMessagePath, {
                      executionPolicy: policy,
                      ...(run.modelOverride ? { modelOverride: run.modelOverride } : {}),
                      ...(run.configOverrides?.length ? { configOverrides: run.configOverrides } : {}),
                      ...(run.bypassApprovals ? { dangerBypassExplicit: true as const } : {})
                    }), staged.timeoutMs, lastMessagePath, runIsCanary, staged.attemptN);
                }
              } else if (run.engine === "opencode") {
                if (run.agent) {
                  child = spawnCanaryChild(deps, bridgeDir, run, resolveOpenCodeBinary(),
                    buildOpenCodeRealArgv({
                      model: run.model ?? "", agent: run.agent, prompt: staged.prompt,
                      ...(resumeSessionId ? { sessionId: resumeSessionId } : {})
                    }), staged.timeoutMs, lastMessagePath, runIsCanary, staged.attemptN);
                } else {
                  child = launchOpenCodeCanary(deps, bridgeDir, run, run.model ?? "", staged.timeoutMs, staged.prompt, runIsCanary, resumeSessionId, staged.attemptN);
                }
              } else if (continuationLabel === "resumed" && resumeSessionId) {
                child = launchClaudeChild(deps, bridgeDir, run,
                  buildClaudeResumeArgv(resumeSessionId, staged.prompt, {
                    ...(run.agent ? { agent: run.agent } : {}),
                    ...(run.permissionMode ? { permissionMode: run.permissionMode } : {})
                  }), staged.timeoutMs, staged.prompt, runIsCanary, staged.attemptN);
              } else {
                const claudeSession = resumeSessionId ?? run.session?.sessionId;
                child = launchClaudeChild(deps, bridgeDir, run,
                  buildClaudeArgv({
                    agent: run.agent ?? "", prompt: staged.prompt,
                    ...(run.model ? { model: run.model } : {}),
                    ...(run.effort ? { effort: run.effort } : {}),
                    ...(run.permissionMode ? { permissionMode: run.permissionMode } : {}),
                    ...(run.allowedTools ? { allowedTools: run.allowedTools } : {}),
                    ...(run.disallowedTools ? { disallowedTools: run.disallowedTools } : {}),
                    ...(claudeSession ? { sessionId: claudeSession } : {})
                  }), staged.timeoutMs, staged.prompt, runIsCanary, staged.attemptN);
              }
            } catch (error) {
              // Ambiguous post-spawn (child spawned OK, then identity-save
              // failed): NEVER mark retryable. Record the ambiguity (this
              // marker save succeeding still leaves retry uncertain: the
              // marker proves an error was recorded, never that no child
              // exists) and fail closed as dispatch_uncertain. Reload to
              // preserve the exact persisted pending (spawn may have
              // partially mutated the in-memory run before throwing).
              if (isAmbiguousSpawnError(error)) {
                const toMarkAmbiguous = loadDelegationRun(bridgeDir, run.runId) ?? run;
                if (toMarkAmbiguous.pendingDispatch && toMarkAmbiguous.pendingDispatch.checkpointId === checkpoint.id) {
                  saveDelegationRun(bridgeDir, markAmbiguousSpawn(toMarkAmbiguous, error instanceof Error ? error.message : String(error)));
                }
                const ambiguous = loadDelegationRun(bridgeDir, run.runId) ?? run;
                return failResult(`Follow-up dispatch for checkpoint ${checkpoint.id} is uncertain (run ${run.runId}: spawn succeeded but run identity was not persisted, so a pid-less orphan may exist). No second worker spawned. Inspect via delegation_read_result, cancel any orphan via delegation_cancel, then replay only with explicit recover (never auto-spawn a second worker).`, {
                  error: "dispatch_uncertain",
                  run_id: ambiguous.runId,
                  checkpoint_id: checkpoint.id,
                  input_request_id: request.id,
                  stored: false,
                  executed: false,
                  uncertain_dispatch: true,
                  attempt_n: staged.attemptN,
                  next_action: ambiguous.nextAction
                });
              }
              // Observed sync spawn failure: mark the staged pending with the
              // failure so the identical reply id stays explicitly retryable
              // (same attempt number). A pid-less pending WITHOUT this marker
              // stays uncertain and fails closed instead (never auto-spawn).
              // Reload to preserve the exact persisted pending (spawn may have
              // partially mutated the in-memory run before throwing).
              const toMarkSync = loadDelegationRun(bridgeDir, run.runId) ?? run;
              if (toMarkSync.pendingDispatch && toMarkSync.pendingDispatch.checkpointId === checkpoint.id) {
                saveDelegationRun(bridgeDir, markPendingDispatchFailed(toMarkSync, error instanceof Error ? error.message : String(error)));
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
            try {
              await waitForSpawn(child);
            } catch (error) {
              // Observed async spawn failure (e.g. missing binary): mark the
              // staged pending with the failure so the identical reply id
              // stays explicitly retryable. The staged pending is otherwise
              // untouched (pre-confirm error/close never finalizes while
              // pending). Drop the dead live handle only.
              if (processRuntime().live.get(run.runId)?.child === child) {
                processRuntime().live.delete(run.runId);
              }
              const toMarkAsync = loadDelegationRun(bridgeDir, run.runId) ?? run;
              if (toMarkAsync.pendingDispatch && toMarkAsync.pendingDispatch.checkpointId === checkpoint.id) {
                saveDelegationRun(bridgeDir, markPendingDispatchFailed(toMarkAsync, error instanceof Error ? error.message : String(error)));
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
          // The previous attempt's terminal result is history, not the
          // current result: a new attempt is now running with its own
          // per-attempt artifact. Clear the stale result so the new
          // attempt can never surface the previous attempt's output or
          // tails as its own; the attempts history keeps the old outcome.
          delete run.result;
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
              engine_qualification: engineQualification(run.engine),
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
        // Needs-input wake-up targets come from the canonical authority too,
        // owner-checked plus group/run-filtered (same selection as terminal).
        const subs = selectDeliveryTargets(run, loadSubscriptions(subscriptionAuthorityDirFor(deps.config)));
        const event = run.pendingEvents.at(-1);
        if (event) {
          event.deliveries = subs
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
          engine_qualification: engineQualification(run.engine),
          next_action: "answer via delegation_followup with the matching input-request id"
        });
      }
    },
    {
      name: "delegation_cancel",
      options: {
        title: "Delegation Cancel",
        description: "Idempotent cancel of one run: signals only the exact PID+starttime-verified owned tree, rechecks the tree is gone after a grace + verification window, then verifies windowed quiescence (no further workdir writes across both legs). New opencode turns run --standalone (the owned tree is the serving tree); pre-standalone shared-service runs stay labeled, never silently converted. PID-tree cleanup alone is never presented as proof that a session-side turn halted: for opencode (no session-scoped halt in v2.0.22 on either route) session-side halt stays explicitly unclaimed with a blocker. The ack never claims cleanup finished while descendants remain, and a repeated cancel re-verifies live (never converts a cached incomplete into success).",
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
        // Already-cancelled runs RE-VERIFY live on every cancel call: cleanup
        // stays incomplete/uncertain until verified, and a repeated cancel
        // never converts a cached incomplete into success. The fresh window
        // proves no NEW writes plus the owned tree gone, right now.
        if (current.state === "cancelled") {
          if (reconciled.changed) saveDelegationRun(bridgeDir, current);
          const repeatLatest = current.attempts.at(-1);
          const repeatBefore = snapshotWorkdirMtimes(current.workdir);
          const repeatStart = Date.now();
          await sleepMs(QUIESCENCE_GRACE_MS);
          const repeatFirst = findPostCancelWrites(current.workdir, repeatBefore, repeatStart);
          await sleepMs(QUIESCENCE_VERIFY_WINDOW_MS);
          const repeatSecond = findPostCancelWrites(current.workdir, repeatBefore, repeatStart);
          const repeatQuiescence = mergeQuiescenceLegs(repeatFirst, repeatSecond);
          // Ownership/exit evidence (never cached): recheck the persisted
          // descendant PID+starttime identities live. A root-walk alone
          // proves nothing when the root is stale — an exited root never
          // hides a surviving reparented descendant — and a stale root with
          // no persisted identities is UNVERIFIED, never clean. Quiescence
          // only supports this ownership evidence: a quiet workdir never
          // substitutes for it.
          const priorMembers: OwnedTreeMemberIdentity[] = Array.isArray(current.lastCancelVerification?.ownedTreeMembers)
            ? current.lastCancelVerification.ownedTreeMembers.filter((m) =>
              !!m && Number.isSafeInteger(m.pid) && (m.pid as number) > 0 && typeof m.startTime === "string" && !!(m.startTime as string))
            : [];
          const memberAlive = aliveTreeMembers(priorMembers);
          const rootWalk = repeatLatest?.pid === undefined
            ? { staleRoot: true as const, members: [] as number[], baselines: new Map<number, string>() }
            : collectOwnedTree(repeatLatest.pid, repeatLatest.processStartTime);
          const rootWalkAlive = rootWalk.staleRoot
            ? []
            : rootWalk.members.filter((pid) => readProcessStartTime(pid) === rootWalk.baselines.get(pid));
          const repeatRemaining = [...new Set([...memberAlive, ...rootWalkAlive])];
          // Grounded only by a live enumeration: persisted members from a
          // cancel that saw the root alive, or a root verifiable alive
          // right now (its tree is then freshly enumerable). A stale root
          // with no persisted identities is never proof of cleanup.
          const ownershipGrounded = priorMembers.length > 0 || !rootWalk.staleRoot;
          const repeatClean = repeatRemaining.length === 0 && ownershipGrounded;
          const repeatQuiesced = repeatQuiescence.checked && repeatQuiescence.continued.length === 0;
          const repeatComplete = repeatClean && repeatQuiesced;
          // Carry the identities forward (plus any freshly enumerated
          // while the root is alive) so the NEXT repeat rechecks them too.
          const freshMembers: OwnedTreeMemberIdentity[] = rootWalk.staleRoot
            ? []
            : [...rootWalk.baselines.entries()]
              .filter(([pid]) => rootWalk.members.includes(pid))
              .map(([pid, startTime]) => ({ pid, startTime }));
          const mergedIdentities = new Map<number, string>();
          for (const m of [...priorMembers, ...freshMembers]) {
            if (!mergedIdentities.has(m.pid)) mergedIdentities.set(m.pid, m.startTime);
          }
          const ownershipReason = ownershipGrounded
            ? undefined
            : "ownership UNVERIFIED (no live owned-tree enumeration: missing pid or stale root is never proof of cleanup)";
          current.lastCancelVerification = {
            at: new Date().toISOString(),
            cleanupFinished: repeatClean,
            verificationComplete: repeatComplete,
            remainingPids: repeatRemaining,
            quiesced: repeatQuiesced,
            quiescenceChecked: repeatQuiescence.checked,
            ownedTreeMembers: [...mergedIdentities.entries()].map(([pid, startTime]) => ({ pid, startTime })),
            ...([ownershipReason, repeatQuiescence.reason].some(Boolean)
              ? { reason: [ownershipReason, repeatQuiescence.reason].filter(Boolean).join("; ") }
              : {})
          };
          saveDelegationRun(bridgeDir, current);
          const repeatVerification = {
            rechecked: true as const,
            pid_tree: {
              remaining: repeatRemaining,
              cleanup_finished: repeatClean,
              ownership_verified: ownershipGrounded
            },
            quiescence: {
              checked: repeatQuiescence.checked,
              quiesced: repeatQuiesced,
              continued_writes: repeatQuiescence.continued,
              ...(repeatQuiescence.truncated ? { truncated: true as const } : {}),
              ...(repeatQuiescence.reason ? { reason: repeatQuiescence.reason } : {})
            },
            verification_complete: repeatComplete
          };
          return okResult(
            repeatComplete
              ? `Run ${current.runId} is already cancelled; re-verified: owned tree gone, workdir quiet across the verification window.`
              : `Run ${current.runId} is already cancelled; re-verified INCOMPLETE: ${repeatRemaining.length > 0 ? `${repeatRemaining.length} owned descendant(s) still remain (${repeatRemaining.join(",")}). ` : ""}${!ownershipGrounded ? "ownership UNVERIFIED (no live owned-tree enumeration; a missing pid or stale root is never proof of cleanup). " : ""}${!repeatQuiescence.checked ? `quiescence UNVERIFIABLE (${repeatQuiescence.reason ?? "workdir unreadable"}).` : repeatQuiescence.continued.length > 0 ? `quiescence FAILED: ${repeatQuiescence.continued.length} post-cancel write(s).` : ""}`,
            {
              run_id: current.runId, state: current.state, already_terminal: true, cancelled: true,
              cleanup_finished: repeatClean,
              remaining_pids: repeatRemaining,
              cancel_verification: repeatVerification,
              engine_qualification: engineQualification(current.engine)
            }
          );
        }
        // Already-terminal runs NEVER report unconditional cleanup success:
        // completed, failed, timed_out, and interrupted runs all re-verify
        // live under the same evidence standard as the cancelled repeat
        // path above (persisted descendant PID+starttime identities
        // rechecked live + a fresh ownership-grounded tree walk + a
        // windowed quiescence probe). Without grounding the verdict stays
        // incomplete/unknown — never success. Legacy shared-service runs
        // keep their label (never converted); the label rides along while
        // the evidence decides the verdict.
        if (current.state === "completed" || current.state === "failed" ||
          current.state === "timed_out" || current.state === "interrupted") {
          if (reconciled.changed) saveDelegationRun(bridgeDir, current);
          const termLatest = current.attempts.at(-1);
          const termBefore = snapshotWorkdirMtimes(current.workdir);
          const termStart = Date.now();
          await sleepMs(QUIESCENCE_GRACE_MS);
          const termFirst = findPostCancelWrites(current.workdir, termBefore, termStart);
          await sleepMs(QUIESCENCE_VERIFY_WINDOW_MS);
          const termSecond = findPostCancelWrites(current.workdir, termBefore, termStart);
          const termQuiescence = mergeQuiescenceLegs(termFirst, termSecond);
          const termPriorMembers: OwnedTreeMemberIdentity[] = Array.isArray(current.lastCancelVerification?.ownedTreeMembers)
            ? current.lastCancelVerification.ownedTreeMembers.filter((m) =>
              !!m && Number.isSafeInteger(m.pid) && (m.pid as number) > 0 && typeof m.startTime === "string" && !!(m.startTime as string))
            : [];
          const termMemberAlive = aliveTreeMembers(termPriorMembers);
          const termRootWalk = termLatest?.pid === undefined
            ? { staleRoot: true as const, members: [] as number[], baselines: new Map<number, string>() }
            : collectOwnedTree(termLatest.pid, termLatest.processStartTime);
          const termRootAlive = termRootWalk.staleRoot
            ? []
            : termRootWalk.members.filter((pid) => readProcessStartTime(pid) === termRootWalk.baselines.get(pid));
          // The bare attempt root is liveness signal only, never grounding:
          // a stale root with no enumerated descendant identities is
          // UNVERIFIED (an exited root never hides a surviving reparented
          // descendant). Only a live enumeration grounds cleanup.
          const termLatestAlive = termLatest?.pid !== undefined && termLatest.processStartTime !== undefined &&
            isProcessIdentityAlive(termLatest.pid, termLatest.processStartTime)
            ? [termLatest.pid]
            : [];
          const termRemaining = [...new Set([...termMemberAlive, ...termRootAlive, ...termLatestAlive])];
          const termGrounded = termPriorMembers.length > 0 || !termRootWalk.staleRoot;
          const termClean = termRemaining.length === 0 && termGrounded;
          const termQuiesced = termQuiescence.checked && termQuiescence.continued.length === 0;
          const termComplete = termClean && termQuiesced;
          const termOwnershipReason = termGrounded
            ? undefined
            : "ownership UNVERIFIED (no live owned-tree enumeration for this terminal run: a missing pid or stale root is never proof of cleanup)";
          // Carry identities forward (plus any freshly enumerated while the
          // root is alive) so a later cancel rechecks them too.
          const termFreshMembers: OwnedTreeMemberIdentity[] = termRootWalk.staleRoot
            ? []
            : [...termRootWalk.baselines.entries()]
              .filter(([pid]) => termRootWalk.members.includes(pid))
              .map(([pid, startTime]) => ({ pid, startTime }));
          const termMergedIdentities = new Map<number, string>();
          for (const m of [...termPriorMembers, ...termFreshMembers]) {
            if (!termMergedIdentities.has(m.pid)) termMergedIdentities.set(m.pid, m.startTime);
          }
          current.lastCancelVerification = {
            at: new Date().toISOString(),
            cleanupFinished: termClean,
            verificationComplete: termComplete,
            remainingPids: termRemaining,
            quiesced: termQuiesced,
            quiescenceChecked: termQuiescence.checked,
            ownedTreeMembers: [...termMergedIdentities.entries()].map(([pid, startTime]) => ({ pid, startTime })),
            ...([termOwnershipReason, termQuiescence.reason].some(Boolean)
              ? { reason: [termOwnershipReason, termQuiescence.reason].filter(Boolean).join("; ") }
              : {})
          };
          saveDelegationRun(bridgeDir, current);
          const termVerification = {
            rechecked: true as const,
            pid_tree: {
              remaining: termRemaining,
              cleanup_finished: termClean,
              ownership_verified: termGrounded
            },
            quiescence: {
              checked: termQuiescence.checked,
              quiesced: termQuiesced,
              continued_writes: termQuiescence.continued,
              ...(termQuiescence.truncated ? { truncated: true as const } : {}),
              ...(termQuiescence.reason ? { reason: termQuiescence.reason } : {})
            },
            verification_complete: termComplete
          };
          const termRoute = current.engine === "opencode"
            ? (() => {
              const routeLabel = opencodeExecutionRoute(current);
              return {
                execution_route: routeLabel.route,
                ...(routeLabel.legacy
                  ? { execution_route_note: "legacy run predates the standalone route; labeled shared-service, never silently converted" }
                  : {})
              };
            })()
            : {};
          return okResult(
            termComplete
              ? `Run ${current.runId} is already ${current.state}; re-verified: owned tree gone with a grounded enumeration, workdir quiet across the verification window.`
              : `Run ${current.runId} is already ${current.state}; cancel re-verified INCOMPLETE: ${termRemaining.length > 0 ? `${termRemaining.length} owned process(es) still remain (${termRemaining.join(",")}). ` : ""}${!termGrounded ? "ownership UNVERIFIED (no live owned-tree enumeration; a missing pid or stale root is never proof of cleanup). " : ""}${!termQuiescence.checked ? `quiescence UNVERIFIABLE (${termQuiescence.reason ?? "workdir unreadable"}).` : termQuiescence.continued.length > 0 ? `quiescence FAILED: ${termQuiescence.continued.length} post-cancel write(s).` : ""}`,
            {
              run_id: current.runId, state: current.state, already_terminal: true, cancelled: false,
              cleanup_finished: termClean,
              remaining_pids: termRemaining,
              cancel_verification: termVerification,
              ...termRoute,
              engine_qualification: engineQualification(current.engine)
            }
          );
        }
        // Quiescence baseline BEFORE signaling: any workdir write at/after
        // cancel-complete means the worker (or an orphan of it) kept going.
        // A missing PID or an uncertain dispatch is NEVER proof of cleanup:
        // with no verifiable PID+starttime identity there is nothing to
        // probe, so the verdict stays incomplete/uncertain (fail closed).
        const writesBefore = snapshotWorkdirMtimes(current.workdir);
        const latest = current.attempts.at(-1);
        const uncertainCancel = isUncertainDispatch(current);
        let tree: {
          signalled: number[];
          remaining: number[];
          cleanupFinished: boolean;
          staleRoot: boolean;
          members: OwnedTreeMemberIdentity[];
        } = { signalled: [], remaining: [], cleanupFinished: false, staleRoot: true, members: [] };
        if (!uncertainCancel && latest?.pid !== undefined && latest.processStartTime !== undefined) {
          tree = await cancelOwnedTree(latest.pid, latest.processStartTime, 2_000);
        }
        processRuntime().live.delete(current.runId);
        const cancelDoneAt = Date.now();
        // Windowed quiescence: a single quiet grace alone is insufficient (a
        // slow-dying worker can outlast it), so TWO legs — grace + a further
        // verification window — are both compared against cancel-complete.
        // Either leg failing closed (or any post-cancel write) denies the
        // clean-halt claim.
        await sleepMs(QUIESCENCE_GRACE_MS);
        const quiescenceFirst = findPostCancelWrites(current.workdir, writesBefore, cancelDoneAt);
        await sleepMs(QUIESCENCE_VERIFY_WINDOW_MS);
        const quiescenceSecond = findPostCancelWrites(current.workdir, writesBefore, cancelDoneAt);
        const quiescence = mergeQuiescenceLegs(quiescenceFirst, quiescenceSecond);
        const quiesced = quiescence.checked && quiescence.continued.length === 0;
        // Owned-process exit recheck AFTER the window: the exact owned tree
        // must be gone, not just signalled. Any still-owned member keeps
        // cleanup incomplete (never claimed finished early). Quiescence
        // only supports this ownership evidence: a quiet workdir never
        // substitutes for it, and an unverified identity (missing pid,
        // stale root, uncertain dispatch) stays incomplete regardless of
        // how quiet the workdir is.
        const stillOwned = recheckOwnedTreeGone(latest?.pid, latest?.processStartTime);
        const remainingPids = [...new Set([...tree.remaining, ...stillOwned])];
        const cleanupFinished = tree.cleanupFinished && stillOwned.length === 0;
        const ownershipReason = tree.staleRoot
          ? (uncertainCancel || latest?.pid === undefined || latest?.processStartTime === undefined
            ? "cancel identity unverifiable (missing pid or uncertain dispatch is never proof of cleanup)"
            : "owned-tree root already stale at cancel (stale root is never proof of cleanup; no live enumeration happened)")
          : undefined;
        const now = new Date().toISOString();
        if (latest) {
          latest.finishedAt = now;
          latest.state = "cancelled";
          latest.summary = sanitizeSummary(cleanupFinished
            ? (quiesced ? "cancelled by owner; owned tree reaped and rechecked gone; workdir quiesced across grace + verification window (no further writes)" : "cancelled by owner; owned tree reaped and rechecked gone; quiescence INCOMPLETE (see cancel_verification)")
            : (remainingPids.length > 0
              ? "cancelled by owner; owned descendants remain"
              : "cancelled by owner; cleanup UNVERIFIED (no live owned-tree identity; a missing pid or stale root is never proof of cleanup)"));
        }
        current.state = "cancelled";
        current.result = { exitCode: null, signal: null, timedOut: false, summary: sanitizeSummary("cancelled by owner") };
        current.lastCancelVerification = {
          at: now,
          cleanupFinished,
          verificationComplete: cleanupFinished && quiescence.checked && quiescence.continued.length === 0,
          remainingPids,
          quiesced,
          quiescenceChecked: quiescence.checked,
          // Persist the enumerated descendant identities (full owned tree,
          // not just the attempt root) so a repeated cancel rechecks the
          // SAME identities live. Empty when no live enumeration happened,
          // which keeps repeat verification incomplete until grounded.
          ownedTreeMembers: tree.members,
          ...([ownershipReason, quiescence.reason].some(Boolean)
            ? { reason: [ownershipReason, quiescence.reason].filter(Boolean).join("; ") }
            : {})
        };
        enqueueTerminalEvent(current, loadSubscriptions(subscriptionAuthorityDirFor(deps.config)));
        saveDelegationRun(bridgeDir, current);
        await pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, current.runId) ?? current).catch(() => undefined);
        // Session-aware verification: PID-tree cleanup alone never proves a
        // session-side turn halted. For opencode (no session-scoped halt
        // subcommand in v2.0.22 on either the --standalone private-server
        // route or the legacy shared-service route) session halt stays
        // explicitly unclaimed with the capability blocker (fail closed);
        // the owned-tree recheck plus windowed quiescence carries the
        // execution proof instead. Unverifiable workdirs fail closed too
        // (no clean-halt claim).
        const sessionId = current.session?.sessionId;
        const sessionHalt = current.engine === "opencode"
          ? {
            applicable: true as const,
            claimed: false as const,
            ...(sessionId ? { session_id: sessionId } : {}),
            blocker: OPENCODE_CANCEL_CAPABILITY.blocker,
            note: cleanupFinished
              ? "owned tree reaped + rechecked gone (+ windowed quiescence below); session-side halt unproven via the qualified CLI and never claimed"
              : "owned-tree cleanup unverified or incomplete; session-side halt unproven via the qualified CLI and never claimed"
          }
          : { applicable: false as const, claimed: false as const, reason: "session-scoped halt applies to the opencode route only" };
        const verification = {
          pid_tree: {
            signalled: tree.signalled,
            remaining: remainingPids,
            cleanup_finished: cleanupFinished,
            stale_root: tree.staleRoot,
            ownership_verified: !tree.staleRoot,
            liveness_rechecked: true as const,
            owned_tree_gone: stillOwned.length === 0
          },
          quiescence: {
            checked: quiescence.checked,
            quiesced,
            continued_writes: quiescence.continued,
            ...(quiescence.truncated ? { truncated: true as const } : {}),
            ...(quiescence.reason ? { reason: quiescence.reason } : {})
          },
          session_halt: sessionHalt,
          verification_complete: cleanupFinished && quiescence.checked && quiescence.continued.length === 0
        };
        const quiescenceText = !quiescence.checked
          ? `quiescence UNVERIFIABLE (${quiescence.reason ?? "workdir unreadable"}); no clean-halt claim`
          : quiescence.continued.length > 0
            ? `quiescence FAILED: ${quiescence.continued.length} post-cancel write(s) (${quiescence.continued.slice(0, 5).join("; ")}); a worker or orphan may still be executing`
            : "quiescence passed (no further workdir writes across grace + verification window after cancel-complete)";
        const routeText = current.engine === "opencode"
          ? (() => {
            const routeLabel = opencodeExecutionRoute(current);
            return ` Execution route: ${routeLabel.route}${routeLabel.legacy ? " (legacy pre-standalone run; labeled, never silently converted)" : ""}.`;
          })()
          : "";
        const sessionText = current.engine === "opencode"
          ? " Session-side halt unclaimed (no session-scoped halt in opencode v2.0.22; owned-tree recheck + windowed quiescence only)."
          : "";
        return okResult(
          cleanupFinished
            ? `Run ${current.runId} cancelled; owned tree reaped and rechecked gone. ${quiescenceText}.${routeText}${sessionText}`
            : remainingPids.length > 0
              ? `Run ${current.runId} cancelled; cleanup INCOMPLETE: ${remainingPids.length} owned descendant(s) remain (${remainingPids.join(",")}). ${quiescenceText}.${routeText}${sessionText}`
              : `Run ${current.runId} cancelled; cleanup UNVERIFIED: no live owned-tree identity to recheck (a missing pid or stale root is never proof of cleanup). ${quiescenceText}.${routeText}${sessionText}`,
          {
            run_id: current.runId, state: "cancelled", cancelled: true,
            cleanup_finished: cleanupFinished,
            remaining_pids: remainingPids,
            signalled_pids: tree.signalled,
            cancel_verification: verification,
            engine_qualification: engineQualification(current.engine)
          }
        );
      }
    },
    {
      name: "delegation_replay_events",
      options: {
        title: "Delegation Replay Events",
        description: "Explicit replay for stored no-target wake-up events: attaches the CURRENTLY matching canonical-authority subscriptions (owner-checked plus delegation-group/run id filters) as fresh pending deliveries, then pumps through the ordinary app-delivery gate. Only events with zero deliveries are eligible; events that already carry deliveries keep their history and are never backfilled to new/wider scopes. Owner-scoped like every delegation op; knowing a group or run id grants no access.",
        inputSchema: publicSchemaFrom(replayArgs),
        runtimeInputSchema: replayArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        const workspace = deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = bridgeDirFor(deps.config, workspace.root);
        const run = loadDelegationRun(bridgeDir, args.run_id);
        if (!run || !ownerAllowed(deps, run)) return denyAccess();
        const reconciled = reconcileRunState(run, isProcessIdentityAlive);
        let current = reconciled.run;
        if (reconciled.changed) saveDelegationRun(bridgeDir, current);
        // Targets come from the canonical authority (never the run bridge),
        // filtered to the run owner's currently matching subscriptions.
        const authoritySubs = loadSubscriptions(subscriptionAuthorityDirFor(deps.config));
        const { attached, stillNoTarget } = attachReplayTargets(current, authoritySubs);
        if (attached.length > 0) {
          current.nextAction = nextActionFor(current.state,
            current.pendingEvents.some(isEventUndelivered),
            current.pendingEvents.some((event) => event.deliveries.length === 0));
          // Atomic: attached targets persist with the run before any POST.
          saveDelegationRun(bridgeDir, current);
        }
        current = await pumpDeliveries(deps, bridgeDir, loadDelegationRun(bridgeDir, current.runId) ?? current);
        const attachedSubIds = [...new Set(attached.flatMap((entry) => entry.subIds))];
        const undelivered = current.pendingEvents.filter(isEventUndelivered).length;
        if (attached.length === 0 && stillNoTarget.length === 0) {
          return okResult(`Run ${current.runId}: no no-target events to replay (every stored event already carries deliveries; history is never backfilled).`, {
            run_id: current.runId, state: current.state,
            replayed_event_ids: [], attached_sub_ids: [], still_no_target_event_ids: [],
            undelivered_events: undelivered,
            delivery_enabled: isAppEventDeliveryEnabled(),
            next_action: current.nextAction
          });
        }
        return okResult(
          `Run ${current.runId}: replay attached ${attachedSubIds.length} current matching target(s) to ${attached.length} no-target event(s)` +
          (stillNoTarget.length ? `; ${stillNoTarget.length} event(s) still have no matching targets` : "") +
          `.`,
          {
            run_id: current.runId, state: current.state,
            replayed_event_ids: attached.map((entry) => entry.eventId),
            attached_sub_ids: attachedSubIds,
            still_no_target_event_ids: stillNoTarget,
            undelivered_events: undelivered,
            delivery_enabled: isAppEventDeliveryEnabled(),
            next_action: current.nextAction
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
        description: "Subscribe a webhook to the run-attention event (official events/subscribe). Validates a whsec_ secret, HTTPS callback, and private/local blocks; verifies the callback with a signed verification challenge (msg_verification_* webhook-id, Standard Webhooks, X-MCP-Subscription-Id binding). Deterministic subscription ids make repeat calls idempotent. Challenge failure is error -32015 with data.reason. Verification + storage are always allowed; only app-event POSTs are gated by CODEXPRO_EVENTS_DELIVERY_ENABLED. Subscriptions persist once under the canonical subscription authority (server defaultRoot bridge) and serve runs in every permitted workspace; run state stays in the run workspace.",
        inputSchema: publicSchemaFrom(eventsSubscribeArgs),
        runtimeInputSchema: eventsSubscribeArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        // Resolve the named workspace for access-boundary validation (outside
        // allowedRoots still refuses), but store under the canonical
        // subscription authority so completion in ANY permitted workspace
        // finds the same targets. Matches POST /mcp events/subscribe.
        deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = subscriptionAuthorityDirFor(deps.config);
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
        description: "Remove one webhook subscription from the canonical subscription authority (server defaultRoot bridge). Idempotent and owner-checked: unknown ids and other owners' ids both report removed:false without disclosure.",
        inputSchema: publicSchemaFrom(eventsUnsubscribeArgs),
        runtimeInputSchema: eventsUnsubscribeArgs,
        annotations: DESTRUCTIVE
      },
      handler: async (args) => {
        // Same access-boundary validation as subscribe; removal applies to
        // the canonical authority, never a per-workspace copy.
        deps.workspaces.getWorkspace(args.workspace_id);
        const bridgeDir = subscriptionAuthorityDirFor(deps.config);
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

