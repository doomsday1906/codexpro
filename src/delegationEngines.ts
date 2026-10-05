/**
 * Engine adapters for durable Codex delegation (Leaf 2: hestia-cli-canary).
 *
 * Engine separation is explicit and never assumed: Codex launches through the
 * `codex exec --profile` route; OpenCode launches through the
 * `opencode run --model ... --format json` route qualified against the
 * installed `opencode v2.0.22` CLI (`opencode run --help`). OpenCode session
 * resume uses `run --session <id>` (continue-or-create); Codex resume uses
 * `exec resume [SESSION_ID]`. Neither engine borrows the other's flags.
 *
 * Codex argv carries --skip-git-repo-check because delegation workdirs are
 * disposable directories that are generally not git repositories. It changes
 * nothing about the Luna gate (model/effort/read-only sandbox) or approval
 * policy, which the profile still enforces.
 *
 * Process binding is PID + starttime identity (Linux /proc/<pid>/stat field
 * 22, first read captured at spawn, verified with a double-read). PID alone
 * is never identity. Cancellation signals only the exact owned tree.
 */

import { createHash } from "node:crypto";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Exact Luna canary requirements for group hestia-cli-canary. */
export const LUNA_PROFILE_REQUIREMENTS = {
  model: "gpt-6-luna",
  reasoningEffort: "low",
  sandboxMode: "read-only"
} as const;

/** 5-minute total deadline per canary attempt, queue/startup/cleanup included. */
export const CANARY_ATTEMPT_TIMEOUT_MS = 5 * 60 * 1000;
export const CANARY_CLEANUP_GRACE_MS = 10_000;
export const CANARY_MIN_TIMEOUT_MS = 10_000;

/**
 * Real-task timeout regime: an explicit bounded timeout up to 30 minutes
 * (store DELEGATION_BOUNDS.maxAttemptTimeoutMsReal is the authority; the
 * literals here mirror it so this module stays dependency-free). The default
 * matches the canary default; callers truthfully ack the clamped value.
 */
export const REAL_TASK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const REAL_TASK_MAX_TIMEOUT_MS = 30 * 60 * 1000;

/** Canary fixture identities (harmless read-only inputs). */
export const CANARY_FIXTURES = ["fixture-a.txt", "fixture-b.txt"] as const;

export interface CodexProfileConfigured {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  profileConfigPath?: string;
}

export interface LunaGate {
  allowed: boolean;
  reason: string;
  configured: CodexProfileConfigured;
}

/** Minimal top-level TOML reader: only `key = "value"` lines before any [section]. */
export function readTomlTopLevel(filePath: string, keys: string[]): Record<string, string> {
  const wanted = new Set(keys);
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) break;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)\s*(?:#.*)?$/);
    if (!match) continue;
    const key = match[1];
    if (!wanted.has(key)) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function codexHomeDir(): string {
  const explicit = String(process.env.CODEX_HOME ?? "").trim();
  if (explicit) return path.resolve(explicit.replace(/^~(?=\/|$)/, os.homedir()));
  return path.join(os.homedir(), ".codex");
}

/**
 * Luna-only gate for group hestia-cli-canary. Refuses to launch on ANY
 * mismatch: wrong model, wrong effort, or a sandbox other than read-only.
 * No Astra, no paid substitution, no new credentials, no silent fallback.
 */
export function verifyLunaProfile(codexHome: string, profile: string): LunaGate {
  const trimmed = String(profile ?? "").trim();
  if (!trimmed) {
    return { allowed: false, reason: "an explicit Codex profile is required for Luna canary delegation", configured: {} };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(trimmed)) {
    return { allowed: false, reason: `invalid profile name ${JSON.stringify(trimmed)}`, configured: {} };
  }
  const profileConfigPath = path.join(codexHome, `${trimmed}.config.toml`);
  const base = readTomlTopLevel(path.join(codexHome, "config.toml"), ["model", "model_reasoning_effort", "sandbox_mode", "approval_policy"]);
  const fromProfile = readTomlTopLevel(profileConfigPath, ["model", "model_reasoning_effort", "sandbox_mode", "approval_policy"]);
  const configured: CodexProfileConfigured = {
    model: fromProfile.model ?? base.model,
    reasoningEffort: fromProfile.model_reasoning_effort ?? base.model_reasoning_effort,
    sandboxMode: fromProfile.sandbox_mode ?? base.sandbox_mode,
    approvalPolicy: fromProfile.approval_policy ?? base.approval_policy,
    profileConfigPath
  };
  if (!fromProfile.model && !base.model) {
    return { allowed: false, reason: `profile ${trimmed} resolves to no model; refusing Luna canary launch`, configured };
  }
  if (configured.model !== LUNA_PROFILE_REQUIREMENTS.model) {
    return { allowed: false, reason: `Luna canary requires model ${LUNA_PROFILE_REQUIREMENTS.model}; resolved ${configured.model ?? "(none)"}`, configured };
  }
  if ((configured.reasoningEffort ?? "") !== LUNA_PROFILE_REQUIREMENTS.reasoningEffort) {
    return { allowed: false, reason: `Luna canary requires reasoning effort low; resolved ${configured.reasoningEffort ?? "(none)"}`, configured };
  }
  if ((configured.sandboxMode ?? "") !== LUNA_PROFILE_REQUIREMENTS.sandboxMode) {
    return { allowed: false, reason: `Luna canary requires sandbox read-only; resolved ${configured.sandboxMode ?? "(none)"}`, configured };
  }
  return { allowed: true, reason: "Luna profile verified", configured };
}

export interface OpenCodeDiscovery {
  /** Host top-level model, depth-1 scan only. Never used as launch authority. */
  hostModel: string | null;
  /** Whether a top-level "providers" block was observed (evidence-grade read). */
  hasProvidersBlock: boolean;
  configPath: string;
  hasRepoProfileAbstraction: false;
  note: string;
}

/**
 * OpenCode discovery only. Reads the host opencode.jsonc top-level model with
 * a comment-aware depth-1 scan (nested provider model tables are ignored)
 * and reports whether a top-level providers block exists. The repo has no
 * OpenCode profile abstraction (the adapter passes --model explicitly and
 * requires equality), so nothing here may substitute another model.
 */
export function describeOpenCodeDiscovery(opencodeJsoncPath?: string): OpenCodeDiscovery {
  const candidate = opencodeJsoncPath ??
    path.join(os.homedir(), ".config", "opencode-v2", "opencode", "opencode.jsonc");
  const base = {
    hostModel: null as string | null,
    hasProvidersBlock: false,
    configPath: candidate,
    hasRepoProfileAbstraction: false as const,
    note: "repo has no OpenCode profile abstraction; launch passes --model explicitly and requires equality with the host top-level model; host model is discovery-only and is never substituted as launch authority"
  };
  let text: string;
  try {
    text = fs.readFileSync(candidate, "utf8");
  } catch {
    return base;
  }
  // Strip // and /* */ comments while honoring string literals.
  let stripped = "";
  let inString: string | null = null;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      stripped += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    stripped += ch;
    i += 1;
  }
  // Depth-1 key scan: only keys at brace depth 1 are top-level.
  let depth = 0;
  inString = null;
  escaped = false;
  const keyPattern = /^"(model|providers)"\s*:/;
  for (let j = 0; j < stripped.length; j += 1) {
    const ch = stripped[j];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"') {
      inString = ch;
      if (depth === 1) {
        const rest = stripped.slice(j);
        const keyMatch = rest.match(keyPattern);
        if (keyMatch) {
          if (keyMatch[1] === "providers") {
            base.hasProvidersBlock = true;
          } else {
            const valueMatch = rest.match(/^"model"\s*:\s*"([^"]*)"/);
            if (valueMatch) base.hostModel = valueMatch[1];
          }
        }
      }
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth = Math.max(0, depth - 1);
  }
  return base;
}

/**
 * Installed OpenCode route qualified for Leaf 2 (opencode v2.0.22,
 * `opencode run --help` / `opencode session --help`). Only these flags may
 * appear in adapter argv; Codex flags are never assumed.
 */
export const OPENCODE_VERSION_QUALIFIED = "v2.0.22";
export const OPENCODE_QUALIFIED_RUN_FLAGS = [
  "--standalone",
  "--server",
  "--continue/-c",
  "--session/-s",
  "--fork",
  "--model/-m",
  "--agent",
  "--format",
  "--file/-f",
  "--title",
  "--thinking",
  "--auto"
] as const;

/** Expected host top-level model (evidence: opencode.jsonc `"model"`). */
export const OPENCODE_HOST_MODEL = "opencode-go/muse-spark-1.3-contributor";

export function resolveCodexBinary(): string {
  const explicit = String(process.env.CODEXPRO_CODEX_BIN ?? "").trim();
  return explicit || "codex";
}

export function resolveOpenCodeBinary(): string {
  const explicit = String(process.env.CODEXPRO_OPENCODE_BIN ?? "").trim();
  return explicit || "opencode";
}

export interface OpenCodeModelGate {
  allowed: boolean;
  reason: string;
  hostModel: string | null;
  requested: string | null;
}

/**
 * OpenCode model gate: launch requires an EXPLICIT model equal to the host
 * top-level model. Any mismatch, any missing model, or an unreadable host
 * config refuses the launch. No Astra, no paid substitution, no fallback.
 */
export function verifyOpenCodeModel(requested: unknown, hostModel?: string | null): OpenCodeModelGate {
  const want = typeof requested === "string" ? requested.trim() : "";
  const host = hostModel === undefined ? describeOpenCodeDiscovery().hostModel : hostModel;
  if (!want) {
    return { allowed: false, reason: "an explicit OpenCode model is required (pass the host top-level model via --model)", hostModel: host, requested: null };
  }
  if (!host) {
    return { allowed: false, reason: "host OpenCode model is unknown (opencode.jsonc unreadable); refusing launch rather than substituting a model", hostModel: host, requested: want };
  }
  if (want !== host) {
    return { allowed: false, reason: `OpenCode canary requires the host model ${host}; requested ${want} (no substitution)`, hostModel: host, requested: want };
  }
  return { allowed: true, reason: "OpenCode model verified against host top-level model", hostModel: host, requested: want };
}

/** Build the OpenCode canary argv (opencode run --standalone route; no Codex flags). */
export function buildOpenCodeCanaryArgv(model: string, prompt: string, sessionId?: string): string[] {
  if (sessionId) {
    return ["run", "--standalone", "--session", sessionId, "--model", model, "--format", "json", prompt];
  }
  return ["run", "--standalone", "--model", model, "--format", "json", prompt];
}

/**
 * Build the OpenCode resume argv. `--standalone --session <id>` continues
 * the session when the id is known, otherwise it CREATES a new session under
 * that id (installed CLI semantics): first use of a minted id is creation,
 * later uses are true resume. Callers must say which one it is.
 */
export function buildOpenCodeResumeArgv(sessionId: string, model: string, prompt: string): string[] {
  return ["run", "--standalone", "--session", sessionId, "--model", model, "--format", "json", prompt];
}

/**
 * Build the Codex resume argv (`codex exec resume [SESSION_ID] [PROMPT]`).
 * The resume subcommand accepts --output-last-message but NOT --profile: a
 * resumed session inherits its recorded profile. Ephemeral runs persist no
 * session, so resuming an ephemeral canary session id is expected to fail;
 * such follow-ups launch a honestly-labeled new-continuation-attempt instead.
 */
export function buildCodexResumeArgv(sessionId: string, prompt: string, lastMessagePath: string): string[] {
  return ["exec", "resume", sessionId, "--skip-git-repo-check", "--output-last-message", lastMessagePath, prompt];
}

export function isEngineSessionId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

/**
 * Defensive session-id extraction from `opencode run --format json` stdout.
 * The exact JSON shape is UNPROVEN against a live model call (Leaf 2 proof
 * performs no live model calls): several key spellings and common nests are
 * attempted, otherwise null. A null id never blocks completion; it only
 * means follow-up resume degrades to a labeled new-continuation-attempt.
 */
export function parseOpenCodeSessionId(stdoutText: string): string | null {
  const text = String(stdoutText ?? "");
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        documents.push(JSON.parse(trimmed));
      } catch { /* skip non-JSON lines */ }
    }
  }
  const keys = ["sessionID", "sessionId", "session_id", "id"];
  const search = (value: unknown, depth: number): string | null => {
    if (depth > 3 || !value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const hit = search(entry, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (isEngineSessionId(record[key])) return record[key] as string;
    }
    for (const nest of ["session", "data", "result"]) {
      const hit = search(record[nest], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const document of documents) {
    const hit = search(document, 0);
    if (hit) return hit;
  }
  return null;
}

/**
 * Trusted thread-id extraction from Codex worker stdout (steerable launches
 * only, which run with `exec --json` structured JSONL events).
 *
 * Strict by construction:
 * - the JSON document (whole stdout or one JSONL line) must carry the
 *   observed startup type `thread.started`; documents with any other type
 *   (turn/item lifecycle, message/error types, missing/non-string type) are
 *   ignored (no observed startup type = no identity).
 * - the thread id is accepted ONLY from the observed key `thread_id` in
 *   that same `thread.started` document. Every other spelling (threadId,
 *   sessionId/session_id/sessionUuid, thread/session nests, generic `id`,
 *   data/result/payload nests) was NOT observed in the live startup stream
 *   and never qualifies. Generic `id` at top level never qualifies.
 * - plain-text `thread: <id>` lines are NEVER accepted (unstructured text
 *   cannot bind identity; lookalikes/foreign ids would otherwise qualify).
 * - conflicting distinct ids across valid documents resolve to null
 *   (unknown when unverifiable, never first-wins synthesis).
 *
 * OBSERVED live 2026-10-05 (codex-cli 0.159.0, trivial Luna task,
 * non-ephemeral + --json): stdout line 1 is exactly
 * `{"type":"thread.started","thread_id":"<uuid>"}`; later lines carry only
 * turn/item lifecycle (`turn.started`, `item.started`, `item.completed`,
 * `turn.completed` + usage), which carry no thread identity and are ignored
 * here. Session-rollout files independently record the same snake_case
 * `thread_id`/`session_id` (supporting only; the stdout stream is the parse
 * surface). All previously allowlisted unobserved names are DELETED (no
 * placeholders, no hypotheticals).
 * A null return never blocks completion; it only leaves steering
 * unavailable for that run (never synthesized). Callers bind the returned
 * id to the exact launched pid/run (live handle + attempt) and retain the
 * first verified id across reconnects (conflicting later ids never
 * overwrite).
 */
export const CODEX_THREAD_STARTUP_TYPE_PATTERN =
  /^thread\.started$/i;

export function isCodexThreadStartupType(value: unknown): boolean {
  return typeof value === "string" && CODEX_THREAD_STARTUP_TYPE_PATTERN.test(value.trim());
}

export function parseCodexThreadId(stdoutText: string): string | null {
  const text = String(stdoutText ?? "");
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(text));
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        documents.push(JSON.parse(trimmed));
      } catch { /* skip non-JSON lines */ }
    }
  }
  const grammar = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
  const found = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document !== "object" || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    if (!isCodexThreadStartupType(record.type)) continue;
    // ONLY the observed key: live 2026-10-05 startup documents carry
    // `thread_id` (snake_case). All unobserved spellings are deleted.
    const candidate = record["thread_id"];
    if (typeof candidate === "string" && grammar.test(candidate.trim())) {
      found.add(candidate.trim());
    }
  }
  if (found.size === 1) return [...found][0];
  // Zero (unverifiable) or conflicting distinct ids (foreign/conflicting):
  // unknown, never synthesized, never first-wins.
  return null;
}

/** Per-engine session-resume capability, qualified independently. */
export const CODEX_RESUME_CAPABILITY = {
  engine: "codex",
  route: "codex exec resume [SESSION_ID] [PROMPT]",
  resumeArgvShape: "exec resume <session-id> --skip-git-repo-check --output-last-message <file> <prompt>",
  profileFlagOnResume: false,
  inheritsSessionProfile: true,
  ephemeralResumable: false,
  note: "Ephemeral canary runs persist no session; follow-up on an ephemeral run starts a honestly-labeled new-continuation-attempt. Resume requires a recorded non-ephemeral session id."
} as const;

export const OPENCODE_RESUME_CAPABILITY = {
  engine: "opencode",
  route: "opencode run --standalone --session <session-id> --model <model> --format json <prompt>",
  sessionSubcommands: ["list", "delete", "export", "import"],
  noNativeResumeSubcommand: true,
  createsIfMissing: true,
  note: "--standalone runs a private server for the turn (new launches and continuations); --session continues the session when the id is known, otherwise creates it; first use of a minted id is creation, later uses are true resume. One active turn per session id is enforced."
} as const;

export function newOpenCodeSessionId(): string {
  return `ses_${createHash("sha256").update(`${Date.now()}:${process.pid}:${Math.random()}`).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Live steering: engine-native mid-turn message routes (bounded operation,
// distinct from follow-up question/reply and from cancel/relaunch).
// Inspected against the installed CLIs (codex-cli 0.159.0,
// opencode v2.0.22, claude 2.1.289); nothing is inferred beyond the help
// text quoted in the evidence fields below.
// ---------------------------------------------------------------------------

/**
 * Codex live-steer route: `codex queue --thread <THREAD> --message <TEXT>`
 * (inspected: `codex queue --help` prints "Queue a message for an existing
 * session", usage `codex queue [OPTIONS] --thread <THREAD> --message
 * <TEXT>`, where THREAD is a "Session UUID or exact session name"). One
 * native call, no prompt construction, no resume, no relaunch, never
 * injected into an unrelated terminal. Ephemeral launches (`codex exec
 * --ephemeral`, the delegation default) persist no session, so they expose
 * no steerable thread: steering them is unavailable by construction, never
 * emulated. A steerable launch variant (non-ephemeral, session-persisting,
 * with `exec --json` structured startup/control protocol) records its
 * engine-returned thread id at launch; only that id is ever queued to.
 * Queue-during-active vs after-end semantics: OBSERVED live 2026-10-05
 * (codex-cli 0.159.0, trivial Luna tasks, non-ephemeral + --json worker):
 * a mid-turn queue exits 0 with `Queued message <msg-uuid> for thread
 * <thread>.` (engine-held); the live exec turn completed WITHOUT observable
 * incorporation (final message ignored the queued content; the 45-line
 * session rollout ends at task_complete with no second turn). A post-end
 * queue to the settled thread likewise exits 0 with the same held shape and
 * starts no new exec turn while observed (rollout gains no lines). Queued
 * therefore means "held by the engine" only, never received/applied: the
 * engine emits no application-attesting event in the observed stream
 * (thread/turn/item lifecycle only), so records stay queued/unverified and
 * any REQUESTED EFFECT is proven separately in live qualification (worker
 * behavior change + timing + isolation), never by relabeling. The exact
 * success shape on a REAL thread is now live-observed (above); the
 * bogus-thread error shape `failed to queue session message ... no rollout
 * found for thread id ...` exit 1 stays live-mapped. Anything else
 * unobserved stays unknown, never claimed.
 */
export const CODEX_QUEUE_CAPABILITY = {
  engine: "codex",
  route: "codex queue --thread <THREAD> --message <TEXT>",
  inspected: "codex-cli 0.159.0 `codex queue --help`: 'Queue a message for an existing session'; usage 'codex queue [OPTIONS] --thread <THREAD> --message <TEXT>'; '--thread <THREAD>: Session UUID or exact session name'; '--message <TEXT>: Message text to queue'. `codex exec --help`: '--json: Print events to stdout as JSONL' (structured startup/control protocol requested on steerable launches). Live 2026-10-05 (trivial Luna tasks): --json stdout line 1 is {\"type\":\"thread.started\",\"thread_id\":\"<uuid>\"} (ONLY observed startup type/key; turn/item lifecycle lines carry no thread identity); mid-turn and post-end `codex queue` both exit 0 with `Queued message <msg-uuid> for thread <thread>.` (held-by-engine; no in-turn incorporation observed)",
  ephemeralSteerable: false,
  queueDuringActiveVsAfterEnd: "OBSERVED 2026-10-05 (codex-cli 0.159.0, live Luna workers): mid-turn queue exits 0 `Queued message <msg-uuid> for thread <thread>` (held; live turn completed without observable incorporation — final output ignored queued content, rollout ends at task_complete, no second turn); post-end queue exits 0 with the same held shape (no new turn while observed). Queued means held-by-engine only; received/applied stay unverified (engine emits no application-attesting event)",
  note: "ephemeral runs persist no session and expose no thread: steer refuses with steer_unavailable_no_thread (never emulated via resume, second session, or cancel+relaunch). Steerable launches use the explicit non-ephemeral + --json variant and queue only to the recorded engine-returned thread id."
} as const;

/** OpenCode live-steer capability: no native mid-run steer verb exists. */
export const OPENCODE_STEER_CAPABILITY = {
  engine: "opencode",
  supported: false,
  inspected: "opencode v2.0.22 `opencode session --help`: subcommands are list|delete|export|import (no halt/stop/steer verb); `opencode run --help`: flags are --standalone/--server/--continue/--session/--fork/--model/--agent/--format/--file/--title/--thinking/--auto (no queue/steer/message-inject flag); `opencode serve --help`: v2 API + web server flags --hostname/--port/--cors/--service/--stdio (no documented mid-turn message-inject op in help); `opencode acp --help`: Agent Client Protocol server (no steer verb in help); `opencode api --help`: OpenAPI operation-or-method-path request route (--data/--header/--param, --standalone/--server; no op catalog in help, no live server probed); `opencode debug --help`: agents/config/paths only; `opencode mcp --help`: list/add/auth/logout only. Live 2026-10-05 read-only: `opencode session list` exits 0 with no sessions (nothing live to address); `opencode models` lists models without a model call (no live input attempted, no paid call); no genuine local input route to a live turn exists, so no bounded input attempt was made",
  blocker: "steer_unsupported: opencode v2.0.22 exposes no queue/steer verb in the qualified CLI surface (run/session/serve/acp/api/debug/mcp helps inspected; no documented live-input op); delivery is never emulated via a second session, a resume, or a cancel+relaunch disguised as steering. Engine steering stays INCOMPLETE; post-completion follow-up (delegation_followup) is a separate needs-input protocol, never relabeled as steering. Smallest alternative for Andrew: wait for the turn to settle, then continue with an explicit new input via delegation_followup (needs-input) or relaunch with revised task text (completed/failed) — a new turn, never a live steer."
} as const;

/** Claude live-steer capability: no native mid-run steer verb exists. */
export const CLAUDE_STEER_CAPABILITY = {
  engine: "claude",
  supported: false,
  inspected: "claude 2.1.289 `claude --help`: session verbs are -c/--continue, -r/--resume, --fork-session, --session-id, plus --bg background agents managed via attach/logs/stop/rm and `claude attach <id>` (terminal attach, no message-inject flag in help; no queue/steer/message-inject verb); --print supports --input-format/--output-format stream-json for single-shot non-interactive input (a new process, not mid-turn injection into a live worker). No live Claude call attempted 2026-10-05 (quota unconfirmed from the prior probe state; never retry paid calls): precise inspected negative, no genuine local mid-turn input route exists",
  blocker: "steer_unsupported: claude 2.1.289 exposes no mid-run message-inject verb (attach opens the session in the terminal, it does not queue a bounded message from this adapter); --resume continues (same or copied session) rather than steering a live turn, so delivery is never relabeled from follow-up/resume. Engine steering stays INCOMPLETE; delegation_followup stays a separate post-completion Q&A protocol. Smallest alternative for Andrew: wait for the turn to settle, then answer/continue via delegation_followup or relaunch with revised task text — a new turn, never a live steer."
} as const;

/** Build the Codex queue argv (single native call, no prompt construction). */
export function buildCodexQueueArgv(thread: string, message: string): string[] {
  return ["queue", "--thread", thread, "--message", message];
}

export type CodexQueueOutcome = "queued" | "rejected" | "unknown";

export interface CodexQueueResult {
  outcome: CodexQueueOutcome;
  /** Bounded engine evidence excerpt (never the full stream). */
  evidence: string;
  exitCode: number | null;
}

/**
 * Map one observed `codex queue` call to queued/rejected/unknown. Exit 0
 * with no unknown-thread text is queued ONLY as "held by the engine"
 * (never applied: applied requires worker-observable evidence, and the
 * engine emits no application-attesting event — observed 2026-10-05). Live
 * success shape 2026-10-05: exit 0 with `Queued message <msg-uuid> for
 * thread <thread>.` on stdout (observed mid-turn AND post-end). A nonzero
 * exit, or engine text naming an unknown/invalid thread, is rejected.
 * Timeouts, spawn failures, and ambiguous output are unknown (never
 * duplicated on retry: callers reconcile against the stored steering
 * record first). Never throws.
 */
export function mapCodexQueueResult(exitCode: number | null, stdout: string, stderr: string): CodexQueueResult {
  const combined = `${stdout}\n${stderr}`.slice(0, 2000);
  const lower = combined.toLowerCase();
  // No exit code observed (timeout kill, spawn failure, lost reply):
  // the dispatch may or may not have landed — unknown, never duplicated.
  if (exitCode === null || exitCode === undefined) {
    return { outcome: "unknown", evidence: combined.slice(0, 500) || "queue returned no exit code (timeout, spawn failure, or lost reply)", exitCode };
  }
  // Unknown-thread shapes observed against codex-cli 0.159.0 (live probe,
  // bogus thread, no worker): `failed to queue session message:
  // thread/queue/add failed: failed to read thread: invalid thread-store
  // request: no rollout found for thread id <uuid> (code -32603)`, exit 1.
  const unknownThread = /unknown|no such|not found|invalid|no session|no rollout/.test(lower) &&
    /thread|session|rollout|unknown|no such|not found|invalid/.test(lower);
  if (exitCode === 0 && !unknownThread) {
    return { outcome: "queued", evidence: combined.slice(0, 500), exitCode };
  }
  return { outcome: "rejected", evidence: combined.slice(0, 500) || `queue exited ${exitCode}`, exitCode };
}

/**
 * Run one bounded `codex queue` call (spawnSync, no worker spawned, no
 * prompt construction). Message text is passed as a single argv element
 * (never a shell). Never throws: spawn failures map to unknown.
 */
export function runCodexQueue(
  thread: string,
  message: string,
  opts?: { binary?: string; timeoutMs?: number }
): CodexQueueResult {
  const bin = opts?.binary ?? resolveCodexBinary();
  const timeoutMs = Math.max(1000, Math.min(opts?.timeoutMs ?? 30_000, 120_000));
  try {
    const result = spawnSync(bin, buildCodexQueueArgv(thread, message), {
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 256 * 1024
    });
    const error = (result as { error?: Error }).error;
    if (error) {
      return { outcome: "unknown", evidence: `queue spawn failed: ${error.message}`.slice(0, 500), exitCode: null };
    }
    return mapCodexQueueResult(
      result.status,
      String(result.stdout ?? ""),
      String(result.stderr ?? "")
    );
  } catch (error) {
    return { outcome: "unknown", evidence: `queue threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), exitCode: null };
  }
}

/**
 * Worker-observed steering correlation: REMOVED 2026-10-05. The four
 * previously allowlisted event types (`codex.steering.received`,
 * `codex.steering.applied`, `codex.queue.received`,
 * `thread.message.received`) were hypothetical: the live 2026-10-05
 * `exec --json` stream on real Luna workers carries ONLY thread/turn/item
 * lifecycle (`thread.started`, `turn.started`, `item.started`,
 * `item.completed`, `turn.completed` + usage) and the engine emits NO
 * message-delivery event attesting receipt or application of a queued
 * message (a mid-turn queued message left no observable trace in the live
 * turn output or session rollout). Per protocol, unobserved names are
 * deleted, not placeholder-kept: there is NO trusted correlation shape, so
 * the adapter never auto-promotes queued->applied from worker output.
 * Queued records stay queued/unverified; any REQUESTED EFFECT is proven
 * separately in live qualification (worker behavior change + timing +
 * isolation), never by relabeling. The symbols below are deleted; the
 * reconciliation entry point documents the no-promotion rule.
 */

/** Canary prompt: read two harmless fixtures, report contents, change nothing. */
export function canaryPrompt(fixtureRelPaths: readonly string[]): string {
  return [
    "Canary read-only check.",
    `Read these two fixture files and report their exact contents: ${fixtureRelPaths.join(", ")}.`,
    "Do not create, modify, or delete any file. Leave the fixtures unchanged.",
    "Reply with the two file contents only."
  ].join(" ");
}

/** Build the Codex Luna canary argv (codex exec --profile route). */
export function buildCodexCanaryArgv(profile: string, prompt: string, lastMessagePath: string): string[] {
  return ["exec", "--ephemeral", "--skip-git-repo-check", "--profile", profile, "--output-last-message", lastMessagePath, prompt];
}

export interface FollowupPromptInput {
  /** Sanitized real task text (absent for legacy canary runs). */
  baseTask?: string;
  /** True for canary runs (fixtures + canary prompt); false for real tasks. */
  isCanary: boolean;
  /** Exact input-request id being answered. */
  requestId: string;
  /** Questions of the answered request (context for the worker). */
  questions: Array<{ id: string; question: string; kind?: string }>;
  /** Answer checkpoint payload (the worker input that must change the result). */
  answerPayload: Record<string, unknown>;
  /** 1-based continuation attempt number. */
  attemptN: number;
  /**
   * Sanitized owner-authorized revision of the accepted task (reply path,
   * real runs only). When present the continuation prompt carries this text
   * as its revised authority with the launch task retained for review; the
   * scope guard references the revised text. Absent means byte-identical
   * legacy behavior (original task + original guard).
   */
  amendedTask?: string;
  /** 1-based revision number for the authority label (taskAmendments length). */
  amendmentSeq?: number;
  /** Checkpoint id that carried the amendment (authority label provenance). */
  amendmentCheckpointId?: string;
}

/** Follow-up prompt cap: bounded worker input (base task + payload). */
export const MAX_FOLLOWUP_PROMPT_BYTES = 16_384;
/** Answer-payload JSON cap inside the follow-up prompt. */
export const MAX_FOLLOWUP_PAYLOAD_JSON_BYTES = 8_192;

function truncateUtf8(text: string, maxBytes: number, marker: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes - Buffer.byteLength(marker, "utf8");
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, Math.max(0, end)).toString("utf8") + marker;
}

/**
 * Build the follow-up worker prompt from the ACTUAL checkpoint payload.
 * The answer payload is forwarded into the prompt (and hence into worker
 * argv for both engines); a follow-up whose answers cannot change the prompt
 * is a stub and is refused by construction (empty payload + no questions
 * yields a prompt identical to the base, which callers must not launch).
 *
 * Answer reservation: the payload JSON is budgeted separately (up to
 * MAX_FOLLOWUP_PAYLOAD_JSON_BYTES) and the base task + questions are
 * truncated to the remaining budget FIRST (multibyte-safe). Whole-prompt
 * truncation never drops the answer: the payload slice is preserved even
 * when the base task is maximal or multibyte-heavy.
 */
export function buildFollowupPrompt(input: FollowupPromptInput): string {
  const rawBase = input.isCanary
    ? canaryPrompt(CANARY_FIXTURES)
    : String(input.baseTask ?? "").trim();
  // Owner-authorized revision: real runs only, non-empty text only. Canary
  // runs never carry one (refused at validation); a canary-shaped input here
  // defensively falls back to the legacy prompt so the canary proof never
  // changes shape.
  const revised = !input.isCanary &&
    typeof input.amendedTask === "string" &&
    input.amendedTask.trim()
    ? input.amendedTask.trim()
    : undefined;
  const questionLines = (input.questions ?? [])
    .map((q) => `[${q.id}] ${q.question}${q.kind === "approval" ? " (approval-kind: data only)" : ""}`);
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(input.answerPayload ?? {});
  } catch {
    payloadJson = "{}";
  }
  payloadJson = truncateUtf8(payloadJson, MAX_FOLLOWUP_PAYLOAD_JSON_BYTES, "...[payload truncated]");
  const instruction = input.isCanary
    ? "Do not create, modify, or delete any file. Leave the fixtures unchanged."
    : revised
      ? "Stay within the revised task's scope: create, modify, or delete no file unless the revised task explicitly authorized it."
      : "Stay within the original task's scope: create, modify, or delete no file unless the original task explicitly authorized it.";
  const prefix = `Follow-up continuation (attempt ${input.attemptN}) for input request ${input.requestId}.`;
  const questionsFull = questionLines.length > 0 ? questionLines.join(" | ") : "(none listed)";
  // Budget questions separately so a pathological question list cannot push
  // the answer out: cap questions at 4 KiB (multibyte-safe), base gets the rest.
  const MAX_QUESTIONS_BYTES = 4_096;
  let questionsText = truncateUtf8(questionsFull, MAX_QUESTIONS_BYTES, "...[questions truncated]");
  if (revised) {
    return buildAmendedFollowupPrompt({
      prefix,
      revised,
      revisionSeq: input.amendmentSeq ?? 1,
      checkpointId: input.amendmentCheckpointId ?? input.requestId,
      original: rawBase,
      questionsText,
      payloadJson,
      instruction
    });
  }
  const baseDisplay = rawBase || "(no base task recorded)";
  // Fixed cost with EMPTY base: everything except the base task text.
  const emptyJoin = [
    prefix,
    `Original task: `,
    `Answered questions: ${questionsText}`,
    `Answers (checkpoint payload JSON): ${payloadJson}`,
    instruction
  ].join(" ");
  let baseBudget = MAX_FOLLOWUP_PROMPT_BYTES - Buffer.byteLength(emptyJoin, "utf8");
  if (baseBudget < 0) {
    // Overhead + payload alone exceed the cap: shrink questions first,
    // payload is never shrunk beyond its own cap.
    const shrinkBy = -baseBudget;
    const questionsBytes = Buffer.byteLength(questionsText, "utf8");
    const shrunkBytes = Math.max(0, questionsBytes - shrinkBy);
    questionsText = truncateUtf8(questionsText, shrunkBytes, "...[questions truncated]");
    const retryEmpty = [
      prefix,
      `Original task: `,
      `Answered questions: ${questionsText}`,
      `Answers (checkpoint payload JSON): ${payloadJson}`,
      instruction
    ].join(" ");
    baseBudget = MAX_FOLLOWUP_PROMPT_BYTES - Buffer.byteLength(retryEmpty, "utf8");
  }
  const baseText = truncateUtf8(baseDisplay, Math.max(0, baseBudget), "...[task truncated]");
  return assembleFollowupPrompt(prefix, baseText, questionsText, payloadJson, instruction, payloadJson);
}

function assembleFollowupPrompt(
  prefix: string,
  baseText: string,
  questionsText: string,
  payloadJson: string,
  instruction: string,
  payloadMustContain: string
): string {
  const lines = [
    prefix,
    `Original task: ${baseText}`,
    `Answered questions: ${questionsText}`,
    `Answers (checkpoint payload JSON): ${payloadJson}`,
    instruction
  ];
  const joined = lines.join(" ");
  // Whole-prompt truncation is a final safety net only: it truncates the
  // TAIL (instruction) and asserts the reserved payload slice survived.
  // If the payload was somehow pushed out, fall back to a payload-preserving
  // minimal prompt (prefix + answers + truncated instruction).
  if (Buffer.byteLength(joined, "utf8") <= MAX_FOLLOWUP_PROMPT_BYTES) return joined;
  const truncated = truncateUtf8(joined, MAX_FOLLOWUP_PROMPT_BYTES, " ...[follow-up truncated]");
  if (truncated.includes(payloadMustContain.slice(0, Math.min(64, payloadMustContain.length)))) return truncated;
  const minimal = truncateUtf8(
    `${prefix} Answers (checkpoint payload JSON): ${payloadMustContain} ${instruction}`,
    MAX_FOLLOWUP_PROMPT_BYTES,
    " ...[follow-up truncated]"
  );
  return minimal;
}

/**
 * Amended follow-up prompt: the continuation worker's accepted-task authority
 * is the owner-authorized revision, explicitly labeled with its revision
 * number and carrying checkpoint; the launch task is retained verbatim for
 * review (superseded for scope purposes). The scope guard references the
 * revised text. Budgeting mirrors the legacy path: questions are capped
 * separately, the payload slice is reserved, and the revised text takes
 * budget priority over the retained original.
 */
function buildAmendedFollowupPrompt(args: {
  prefix: string;
  revised: string;
  revisionSeq: number;
  checkpointId: string;
  original: string;
  questionsText: string;
  payloadJson: string;
  instruction: string;
}): string {
  let questionsText = args.questionsText;
  const revisionLine = `Owner-authorized revision ${args.revisionSeq} of the accepted task (checkpoint ${args.checkpointId}): `;
  const originalLine = "Original task (superseded for scope purposes, retained for review): ";
  const revisedFull = args.revised || "(no base task recorded)";
  const originalFull = args.original || "(no base task recorded)";
  // Fixed cost with EMPTY task texts: everything except the two task texts.
  const emptyJoin = [
    args.prefix,
    revisionLine,
    originalLine,
    `Answered questions: ${questionsText}`,
    `Answers (checkpoint payload JSON): ${args.payloadJson}`,
    args.instruction
  ].join(" ");
  let baseBudget = MAX_FOLLOWUP_PROMPT_BYTES - Buffer.byteLength(emptyJoin, "utf8");
  if (baseBudget < 0) {
    // Overhead + payload alone exceed the cap: shrink questions first,
    // payload is never shrunk beyond its own cap.
    const shrinkBy = -baseBudget;
    const questionsBytes = Buffer.byteLength(questionsText, "utf8");
    const shrunkBytes = Math.max(0, questionsBytes - shrinkBy);
    questionsText = truncateUtf8(questionsText, shrunkBytes, "...[questions truncated]");
    const retryEmpty = [
      args.prefix,
      revisionLine,
      originalLine,
      `Answered questions: ${questionsText}`,
      `Answers (checkpoint payload JSON): ${args.payloadJson}`,
      args.instruction
    ].join(" ");
    baseBudget = MAX_FOLLOWUP_PROMPT_BYTES - Buffer.byteLength(retryEmpty, "utf8");
  }
  // The revision is the live authority: it takes budget priority, the
  // retained original gets the remainder.
  const revisedBytes = Buffer.byteLength(revisedFull, "utf8");
  const revisedText = truncateUtf8(revisedFull, Math.min(revisedBytes, Math.max(0, baseBudget)), "...[task truncated]");
  const remaining = Math.max(0, baseBudget - Buffer.byteLength(revisedText, "utf8"));
  const originalText = truncateUtf8(originalFull, remaining, "...[task truncated]");
  return assembleAmendedFollowupPrompt(
    args.prefix, revisionLine, revisedText, originalLine, originalText,
    questionsText, args.payloadJson, args.instruction, args.payloadJson
  );
}

function assembleAmendedFollowupPrompt(
  prefix: string,
  revisionLine: string,
  revisedText: string,
  originalLine: string,
  originalText: string,
  questionsText: string,
  payloadJson: string,
  instruction: string,
  payloadMustContain: string
): string {
  const lines = [
    prefix,
    `${revisionLine}${revisedText}`,
    `${originalLine}${originalText}`,
    `Answered questions: ${questionsText}`,
    `Answers (checkpoint payload JSON): ${payloadJson}`,
    instruction
  ];
  const joined = lines.join(" ");
  // Whole-prompt truncation is a final safety net only: it truncates the
  // TAIL and asserts the reserved payload slice survived. If the payload was
  // somehow pushed out, fall back to a revision-preserving minimal prompt
  // (prefix + revision + answers + truncated instruction).
  if (Buffer.byteLength(joined, "utf8") <= MAX_FOLLOWUP_PROMPT_BYTES) return joined;
  const truncated = truncateUtf8(joined, MAX_FOLLOWUP_PROMPT_BYTES, " ...[follow-up truncated]");
  if (truncated.includes(payloadMustContain.slice(0, Math.min(64, payloadMustContain.length)))) return truncated;
  const minimal = truncateUtf8(
    `${prefix} ${revisionLine}${revisedText} Answers (checkpoint payload JSON): ${payloadMustContain} ${instruction}`,
    MAX_FOLLOWUP_PROMPT_BYTES,
    " ...[follow-up truncated]"
  );
  return minimal;
}

/**
 * Real-task attempt-timeout clamp: 10s minimum, 30-minute maximum, 5-minute
 * default. The clamped value is truthfully acked by callers.
 */
export function clampRealTaskTimeout(requestedMs: unknown): number {
  const n = Number(requestedMs ?? REAL_TASK_DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(n)) return REAL_TASK_DEFAULT_TIMEOUT_MS;
  return Math.max(CANARY_MIN_TIMEOUT_MS, Math.min(Math.floor(n), REAL_TASK_MAX_TIMEOUT_MS));
}

export interface SessionVerification {
  verified: boolean;
  /** Human-readable evidence (never transcripts or credentials). */
  evidence: string;
}

function sessionListContains(stdoutText: string, sessionId: string): boolean {
  const text = String(stdoutText ?? "");
  if (!text.includes(sessionId)) return false;
  try {
    // Structured confirmation: the id must survive a JSON round-trip, so a
    // log-line accident cannot pass as session evidence.
    return JSON.stringify(JSON.parse(text)).includes(sessionId);
  } catch {
    // Non-JSON table output: fall back to line-anchored match.
    return text.split(/\r?\n/).some((line) => line.includes(sessionId));
  }
}

/**
 * Verify an OpenCode session id with LOCAL read-only probes only (no model
 * call): `session list --format json` scoped to the run workdir (sessions
 * are project-scoped), then `session export <id>` as a fallback. Anything
 * inconclusive fails closed: unverified ids are first-use creations under
 * the installed continue-or-create semantics and must be labeled
 * created/new-continuation-attempt, never resumed.
 */
export function verifyOpenCodeSession(
  sessionId: string,
  workdir: string,
  opts?: { binary?: string; timeoutMs?: number }
): SessionVerification {
  const sid = String(sessionId ?? "").trim();
  if (!isEngineSessionId(sid)) {
    return { verified: false, evidence: "session id malformed; never claimed resumed" };
  }
  const bin = opts?.binary ?? resolveOpenCodeBinary();
  const timeoutMs = Math.max(1000, Math.min(opts?.timeoutMs ?? 20_000, 60_000));
  const runProbe = (argv: string[]): { status: number | null; stdout: string } => {
    try {
      const result = spawnSync(bin, argv, {
        cwd: workdir,
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 256 * 1024
      });
      return { status: result.status, stdout: String(result.stdout ?? "") };
    } catch {
      return { status: null, stdout: "" };
    }
  };
  const listed = runProbe(["session", "list", "--format", "json", "--max-count", "100"]);
  if (listed.status === 0 && sessionListContains(listed.stdout, sid)) {
    return { verified: true, evidence: "session id observed in worker output and present in 'opencode session list --format json' (cwd = run workdir)" };
  }
  const exported = runProbe(["session", "export", sid]);
  if (exported.status === 0 && String(exported.stdout ?? "").includes(sid)) {
    return { verified: true, evidence: "session id observed in worker output and confirmed by 'opencode session export <id>' (exit 0)" };
  }
  return {
    verified: false,
    evidence: "session id not confirmed by session list/export; first use creates under continue-or-create semantics; labeled new-continuation-attempt"
  };
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/**
 * Linux process birth marker: /proc/<pid>/stat field 22 (starttime).
 * Returns the token string, or null when unreadable (not Linux, gone, no
 * /proc). Null means identity unprovable: callers must fail closed.
 */
export function readProcessStartTime(pid: number): string | null {
  if (process.platform !== "linux") return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const end = text.lastIndexOf(")");
  if (end < 0) return null;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20) return null;
  const starttime = fields[19];
  return /^\d+$/.test(starttime ?? "") ? starttime : null;
}

/**
 * Double-read liveness: the current starttime must equal the spawn baseline
 * on TWO consecutive reads. A vanished process or a PID reused mid-check
 * fails. Never PID alone.
 */
export function isProcessIdentityAlive(pid: number, baselineStartTime: string | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!baselineStartTime) return false;
  const first = readProcessStartTime(pid);
  if (first === null || first !== baselineStartTime) return false;
  const second = readProcessStartTime(pid);
  return second !== null && second === baselineStartTime;
}

interface ProcIdentity {
  pid: number;
  ppid: number;
  startTime: string;
}

function readProcIdentity(pid: number): ProcIdentity | undefined {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const end = text.lastIndexOf(")");
  if (end < 0) return undefined;
  const fields = text.slice(end + 1).trim().split(/\s+/);
  if (fields.length < 20) return undefined;
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !/^\d+$/.test(startTime ?? "")) return undefined;
  return { pid, ppid, startTime };
}

export interface OwnedTree {
  members: number[];
  staleRoot: boolean;
  /** PID -> starttime baseline captured while the parent chain verified. */
  baselines: Map<number, string>;
}

/**
 * One persisted descendant identity: a PID plus the starttime baseline that
 * proves it is still the same process. PID alone is never identity; a
 * recycled PID carries a different starttime and never matches.
 */
export interface OwnedTreeMemberIdentity {
  pid: number;
  startTime: string;
}

/**
 * Liveness of persisted descendant identities: a member counts as alive
 * ONLY while its CURRENT starttime still matches the captured baseline. A
 * reaped member (/proc gone) or a recycled PID (different starttime) counts
 * as gone. Never broadens beyond the listed identities. Exported for the
 * cancel-verification regression proof.
 */
export function aliveTreeMembers(members: readonly OwnedTreeMemberIdentity[]): number[] {
  const alive: number[] = [];
  for (const member of members) {
    if (!Number.isSafeInteger(member.pid) || member.pid <= 0) continue;
    if (!member.startTime) continue;
    if (readProcessStartTime(member.pid) === member.startTime) alive.push(member.pid);
  }
  return alive;
}

/**
 * Exact owned-tree discovery: the root PID must verify against its spawn
 * baseline, and a child is adopted only through a parent whose identity is
 * currently valid. Stale baselines are never refreshed with a replacement's
 * identity. Pure live reads; unprovable PIDs are never adopted.
 */
export function collectOwnedTree(rootPid: number, rootStartTime: string | undefined): OwnedTree {
  if (process.platform !== "linux") return { members: [], staleRoot: true, baselines: new Map() };
  if (!isProcessIdentityAlive(rootPid, rootStartTime)) return { members: [], staleRoot: true, baselines: new Map() };
  const known = new Map<number, string>([[rootPid, rootStartTime as string]]);
  const isValid = (pid: number): boolean => {
    const baseline = known.get(pid);
    if (baseline === undefined) return false;
    const current = readProcessStartTime(pid);
    return current !== null && current === baseline;
  };
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return { members: [rootPid], staleRoot: false, baselines: known };
  }
  const byParent = new Map<number, number[]>();
  const identities = new Map<number, string>();
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const identity = readProcIdentity(pid);
    if (!identity) continue;
    identities.set(pid, identity.startTime);
    const list = byParent.get(identity.ppid) ?? [];
    list.push(pid);
    byParent.set(identity.ppid, list);
  }
  const members = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift() as number;
    if (!isValid(parent)) continue;
    for (const child of byParent.get(parent) ?? []) {
      if (members.has(child)) continue;
      const knownChild = known.get(child);
      const currentChild = identities.get(child);
      if (knownChild !== undefined) {
        if (currentChild !== knownChild) continue;
      } else {
        if (currentChild === undefined) continue;
        known.set(child, currentChild);
      }
      members.add(child);
      pending.push(child);
    }
  }
  return { members: [...members], staleRoot: false, baselines: known };
}

export interface CancelTreeResult {
  signalled: number[];
  remaining: number[];
  cleanupFinished: boolean;
  staleRoot: boolean;
  /**
   * Full owned-tree identities enumerated while the root was alive
   * (persisted by the caller so a repeated cancel can recheck the same
   * identities). Empty when the root was already stale at entry: no live
   * enumeration happened, so nothing here can ground a later verdict.
   */
  members: OwnedTreeMemberIdentity[];
}

/**
 * Non-blocking SIGTERM to the exact owned tree only. Returns the signalled
 * PIDs; callers re-check liveness separately. Never broadens to sweeps.
 */
export function signalOwnedTree(rootPid: number, rootStartTime: string | undefined): { signalled: number[]; staleRoot: boolean } {
  const discovered = collectOwnedTree(rootPid, rootStartTime);
  if (discovered.staleRoot) return { signalled: [], staleRoot: true };
  const signalled: number[] = [];
  for (const pid of discovered.members) {
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch { /* already gone */ }
  }
  return { signalled, staleRoot: false };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Idempotent cancel of the EXACT owned tree only. Never broadens to pattern
 * sweeps or parent sessions. The ack reports cleanupFinished:false while any
 * owned descendant remains; it never claims cleanup finished early.
 *
 * A missing PID or an already-stale root is NEVER proof of cleanup: when
 * the root cannot be verified alive at entry, no live enumeration happened,
 * so unknown (possibly reparented) descendants may survive. The result is
 * cleanupFinished:false with the still-alive KNOWN members (if any) in
 * remaining — incomplete/uncertain until a live enumeration grounds the
 * verdict. Callers persist `members` so a repeated cancel rechecks the same
 * identities instead of trusting a cached outcome.
 *
 * NOTE: async with real sleeps (never a blocking busy-wait): the event loop
 * must turn so the kernel reaps our signalled children; otherwise they linger
 * as same-identity zombies and every liveness check lies. Timeout paths use
 * the non-blocking signalOwnedTree instead and finalize on close/settle.
 */
export async function cancelOwnedTree(
  rootPid: number,
  rootStartTime: string | undefined,
  graceMs = 2000,
  knownMembers: readonly OwnedTreeMemberIdentity[] = []
): Promise<CancelTreeResult> {
  const discovered = collectOwnedTree(rootPid, rootStartTime);
  if (discovered.staleRoot) {
    // No live enumeration: the root is already gone (or was never
    // verifiable), so the tree cannot be bounded. Recheck the caller-held
    // known identities only — an exited root never hides a surviving
    // reparented descendant — but the verdict stays incomplete regardless:
    // a stale root proves nothing about unknown descendants.
    const remaining = aliveTreeMembers(knownMembers);
    return { signalled: [], remaining, cleanupFinished: false, staleRoot: true, members: [] };
  }
  // A member counts as remaining only while its CURRENT starttime still
  // matches the captured baseline: a recycled PID is not our descendant.
  // Re-read through real event-loop turns so SIGCHLD reaping can land;
  // a synchronously blocked loop would observe its own zombies forever.
  const stillOwned = (pid: number): boolean => {
    const baseline = discovered.baselines.get(pid);
    if (baseline === undefined) return false;
    return readProcessStartTime(pid) === baseline;
  };
  const signalled: number[] = [];
  for (const pid of discovered.members) {
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch { /* already gone */ }
  }
  const deadline = Date.now() + Math.max(0, Math.min(graceMs, 10_000));
  let remaining = discovered.members.filter(stillOwned);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleepMs(50);
    remaining = discovered.members.filter(stillOwned);
  }
  if (remaining.length > 0) {
    for (const pid of remaining) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await sleepMs(200);
    remaining = discovered.members.filter(stillOwned);
  }
  const members: OwnedTreeMemberIdentity[] = [...discovered.baselines.entries()]
    .filter(([pid]) => discovered.members.includes(pid))
    .map(([pid, startTime]) => ({ pid, startTime }));
  return { signalled, remaining, cleanupFinished: remaining.length === 0, staleRoot: false, members };
}

export function clampCanaryTimeout(requestedMs: unknown): number {
  const n = Number(requestedMs ?? CANARY_ATTEMPT_TIMEOUT_MS);
  if (!Number.isFinite(n)) return CANARY_ATTEMPT_TIMEOUT_MS;
  return Math.max(CANARY_MIN_TIMEOUT_MS, Math.min(Math.floor(n), CANARY_ATTEMPT_TIMEOUT_MS));
}

/**
 * Spawn acknowledgement: resolves when the child reports successful spawn,
 * rejects on async spawn failure (e.g. ENOENT) or when neither arrives
 * within the bound. Crash-safe dispatch awaits this BEFORE confirming a
 * staged reply: a sync throw and an async spawn error both leave the pending
 * dispatch staged (request open, same reply id retryable with the same
 * attempt number). Never marks applied/confirmed before spawn success.
 */
export function waitForSpawn(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => fail(new Error("spawn acknowledgement timed out")), Math.max(1, Math.min(timeoutMs, 60_000)));
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("spawn", ok);
      child.off("error", fail);
    };
    const ok = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once("spawn", ok);
    child.once("error", fail);
  });
}

/**
 * Tri-engine RepoConnect CLI delegation (codex | opencode | claude).
 *
 * Engine separation is explicit and never assumed: each engine launches
 * through its OWN qualified flags, discovered against the INSTALLED CLIs
 * (codex-cli 0.159.0, opencode v2.0.22, claude 2.1.289). Codex flags are
 * never translated into guessed opencode/claude equivalents, and no engine
 * is ever silently substituted for another.
 *
 * Profile/agent authority: every launch reuses an EXISTING profile/agent
 * definition by real name (Codex `~/.codex/*.config.toml`, OpenCode
 * `~/.config/opencode-v2/opencode/agents/*.md`, Claude `~/.claude/agents/`
 * which symlinks the AgentWorkspace overlay). This module never invents a
 * parallel registry and never copies a skills library. Model/effort flags
 * (-m/-c, --model, --effort) appear ONLY where the engine supports them AND
 * the caller explicitly requested them; otherwise the run inherits the
 * selected profile/agent. A profile is never replaced by a bare model flag.
 *
 * Astra is never used, never spent, and never a fallback: any resolved or
 * requested Astra model refuses the launch (code astra_forbidden).
 *
 * The Luna read-only gate (verifyLunaProfile) applies ONLY to the legacy
 * canary slice (isCanary + group hestia-cli-canary). Real tasks verify the
 * SELECTED profile (exists, non-Astra model, resolvable sandbox) and run
 * under an explicit per-run execution policy.
 */

export const CANARY_DELEGATION_GROUP = "hestia-cli-canary";

/** True for any Astra model id (never used, never a fallback). */
export function isAstraModelId(value: unknown): boolean {
  return typeof value === "string" && /astra/i.test(value);
}

// ---------------------------------------------------------------------------
// Codex execution policy
// ---------------------------------------------------------------------------

export const CODEX_EXECUTION_POLICIES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexExecutionPolicy = (typeof CODEX_EXECUTION_POLICIES)[number];

export function isCodexExecutionPolicy(value: unknown): value is CodexExecutionPolicy {
  return typeof value === "string" &&
    (CODEX_EXECUTION_POLICIES as readonly string[]).includes(value);
}

export interface CodexProfileResolved {
  name: string;
  exists: boolean;
  configured: CodexProfileConfigured;
}

/**
 * Resolve one Codex profile by REAL name against CODEX_HOME. Pure file
 * reads only: base config.toml top-level keys overlaid by
 * `<name>.config.toml` top-level keys (same reader as the Luna gate).
 */
export function describeCodexProfile(codexHome: string, profile: string): CodexProfileResolved {
  const trimmed = String(profile ?? "").trim();
  const profileConfigPath = path.join(codexHome, `${trimmed}.config.toml`);
  let exists = false;
  try {
    fs.accessSync(profileConfigPath, fs.constants.F_OK);
    exists = true;
  } catch {
    exists = false;
  }
  const base = readTomlTopLevel(path.join(codexHome, "config.toml"), ["model", "model_reasoning_effort", "sandbox_mode", "approval_policy"]);
  const fromProfile = exists
    ? readTomlTopLevel(profileConfigPath, ["model", "model_reasoning_effort", "sandbox_mode", "approval_policy"])
    : {};
  return {
    name: trimmed,
    exists,
    configured: {
      model: fromProfile.model ?? base.model,
      reasoningEffort: fromProfile.model_reasoning_effort ?? base.model_reasoning_effort,
      sandboxMode: fromProfile.sandbox_mode ?? base.sandbox_mode,
      approvalPolicy: fromProfile.approval_policy ?? base.approval_policy,
      profileConfigPath
    }
  };
}

/** List real Codex profile names present in CODEX_HOME (bounded). */
export function listCodexProfileNames(codexHome: string, limit = 64): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(codexHome);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".config.toml") || entry === "config.toml") continue;
    names.push(entry.slice(0, -".config.toml".length));
    if (names.length >= Math.max(1, Math.min(limit, 256))) break;
  }
  return names.sort();
}

export interface CodexLaunchGate {
  allowed: boolean;
  /** Machine-readable refusal code (luna_gate_refused, profile_required, profile_unknown, astra_forbidden, ...). */
  code: string;
  reason: string;
  configured: CodexProfileConfigured;
  /** Effective sandbox for argv: explicit per-run policy wins over profile. */
  executionPolicy: CodexExecutionPolicy | null;
  /** Which gate adjudicated: luna (legacy canary) or profile (real tasks). */
  gateKind: "luna" | "profile";
  modelOverride?: string;
  configOverrides?: string[];
  /** Final effective model after profile resolution + explicit override (override wins). */
  effectiveModel?: string | null;
  /** Final effective effort from the resolved profile (config overrides can never set effort: those keys are protected). */
  effectiveEffort?: string | null;
}

function codexProfileNameGrammar(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

/**
 * Codex `-c key=value` keys that must never ride an override because they
 * would set model/effort/sandbox/approval outside the gate (evading the
 * model, effort, and execution-policy checks). Matched on the final dotted
 * segment, case-insensitive; anything containing "bypass" is protected too
 * (the approvals/sandbox bypass flag is never smuggled through -c).
 */
const CODEX_PROTECTED_CONFIG_SEGMENTS: ReadonlySet<string> = new Set([
  "model",
  "model_reasoning_effort",
  "reasoning_effort",
  "effort",
  "sandbox_mode",
  "sandbox",
  "approval_policy",
  "approval",
  "approvals",
  "profile",
  "dangerously_bypass_approvals_and_sandbox"
]);

/** True when a `-c` key would set model/effort/sandbox/approval or otherwise evade the gate. */
export function isProtectedCodexConfigKey(key: unknown): boolean {
  const raw = String(key ?? "").trim().replace(/^["']|["']$/g, "");
  if (!raw) return true;
  const lowered = raw.toLowerCase();
  if (lowered.includes("bypass")) return true;
  const segment = (lowered.split(".").pop() ?? "").trim();
  return CODEX_PROTECTED_CONFIG_SEGMENTS.has(segment);
}

/** Key part of one `-c key=value` entry (everything before the first `=`). */
export function codexConfigKeyOf(entry: string): string {
  const text = String(entry ?? "");
  const idx = text.indexOf("=");
  return (idx < 0 ? text : text.slice(0, idx)).trim();
}

/**
 * Codex launch gate. The Luna read-only gate applies ONLY when the run is
 * the legacy canary slice (isCanary AND group hestia-cli-canary); every
 * other run verifies the SELECTED profile instead: it must exist, resolve a
 * model, never be Astra, and resolve a sandbox. danger-full-access is an
 * EXPLICIT per-run choice only (never inherited, never auto-escalated: a
 * profile that resolves to danger without an explicit execution_policy is
 * refused). Model/config overrides ride argv ONLY when the caller explicitly
 * passed them, and overrides that would set model/effort/sandbox/approval
 * (protected keys) are refused so the model, effort, and execution-policy
 * checks cannot be bypassed. Machine-wide Codex defaults are never changed
 * here. The returned effectiveModel/effectiveEffort are the FINAL values
 * after profile resolution + explicit override (override wins for model;
 * effort always comes from the resolved profile).
 */
export function verifyCodexLaunch(
  codexHome: string,
  profile: string,
  opts: {
    isCanary: boolean;
    delegationGroup: string;
    executionPolicy?: unknown;
    modelOverride?: unknown;
    configOverrides?: unknown;
  }
): CodexLaunchGate {
  const trimmed = String(profile ?? "").trim();
  if (!trimmed) {
    return {
      allowed: false, code: "profile_required",
      reason: "an explicit Codex profile is required (pass a real profile name)",
      configured: {}, executionPolicy: null, gateKind: "profile"
    };
  }
  if (!codexProfileNameGrammar(trimmed)) {
    return {
      allowed: false, code: "profile_required",
      reason: `invalid profile name ${JSON.stringify(trimmed)}`,
      configured: {}, executionPolicy: null, gateKind: "profile"
    };
  }
  const resolved = describeCodexProfile(codexHome, trimmed);
  if (!resolved.exists) {
    return {
      allowed: false, code: "profile_unknown",
      reason: `unknown Codex profile ${JSON.stringify(trimmed)} (no ${trimmed}.config.toml under CODEX_HOME; pass a real existing profile, never a substitute)`,
      configured: resolved.configured, executionPolicy: null, gateKind: "profile"
    };
  }
  if (!resolved.configured.model) {
    return {
      allowed: false, code: "profile_unknown",
      reason: `profile ${trimmed} resolves to no model; refusing launch rather than substituting a model`,
      configured: resolved.configured, executionPolicy: null, gateKind: "profile"
    };
  }
  if (isAstraModelId(resolved.configured.model)) {
    return {
      allowed: false, code: "astra_forbidden",
      reason: `profile ${trimmed} resolves to Astra model ${resolved.configured.model}; Astra is never used and never a fallback`,
      configured: resolved.configured, executionPolicy: null, gateKind: "profile"
    };
  }
  const rawModelOverride = typeof opts.modelOverride === "string" ? opts.modelOverride.trim() : "";
  if (rawModelOverride && isAstraModelId(rawModelOverride)) {
    return {
      allowed: false, code: "astra_forbidden",
      reason: `explicit codex model override ${rawModelOverride} is Astra; Astra is never used and never a fallback`,
      configured: resolved.configured, executionPolicy: null, gateKind: "profile"
    };
  }
  const rawConfigs = Array.isArray(opts.configOverrides) ? opts.configOverrides : [];
  const configOverrides: string[] = [];
  for (const entry of rawConfigs) {
    if (typeof entry !== "string" || !/^[A-Za-z0-9_.]+\s*=/.test(entry.trim()) || entry.length > 512) {
      return {
        allowed: false, code: "invalid_config_override",
        reason: `config override ${JSON.stringify(String(entry)).slice(0, 80)} must be bounded key=value text (codex -c shape)`,
        configured: resolved.configured, executionPolicy: null, gateKind: "profile"
      };
    }
    const key = codexConfigKeyOf(entry);
    if (isProtectedCodexConfigKey(key)) {
      return {
        allowed: false, code: "protected_config_override",
        reason: `config override key ${JSON.stringify(key).slice(0, 80)} is protected (it would set model/effort/sandbox/approval outside the gate); pass model via the explicit model field and sandbox via the explicit execution_policy instead`,
        configured: resolved.configured, executionPolicy: null, gateKind: "profile"
      };
    }
    configOverrides.push(entry.trim());
  }
  const legacyCanary = opts.isCanary && opts.delegationGroup === CANARY_DELEGATION_GROUP;
  if (legacyCanary) {
    const luna = verifyLunaProfile(codexHome, trimmed);
    if (!luna.allowed) {
      return {
        allowed: false, code: "luna_gate_refused", reason: luna.reason,
        configured: luna.configured, executionPolicy: null, gateKind: "luna"
      };
    }
    const explicit = typeof opts.executionPolicy === "string" ? opts.executionPolicy.trim() : "";
    if (explicit && explicit !== "read-only") {
      return {
        allowed: false, code: "luna_gate_refused",
        reason: `legacy canary runs read-only only; explicit execution policy ${JSON.stringify(explicit)} is refused for group ${CANARY_DELEGATION_GROUP}`,
        configured: luna.configured, executionPolicy: null, gateKind: "luna"
      };
    }
    if (rawModelOverride || configOverrides.length > 0) {
      return {
        allowed: false, code: "luna_gate_refused",
        reason: "legacy canary inherits the Luna profile exactly; explicit model/config overrides are refused for the canary slice",
        configured: luna.configured, executionPolicy: null, gateKind: "luna"
      };
    }
    return {
      allowed: true, code: "ok", reason: "Luna profile verified (legacy canary gate)",
      configured: luna.configured, executionPolicy: "read-only", gateKind: "luna",
      effectiveModel: luna.configured.model ?? null,
      effectiveEffort: luna.configured.reasoningEffort ?? null
    };
  }
  // Real task: the selected profile governs; explicit per-run policy wins.
  // danger-full-access is NEVER inherited: a profile that resolves to it
  // without an explicit per-run execution_policy is refused (explicit
  // selection required), so no launch can silently run danger.
  const explicit = typeof opts.executionPolicy === "string" ? opts.executionPolicy.trim() : "";
  let executionPolicy: CodexExecutionPolicy | null = null;
  if (explicit) {
    if (!isCodexExecutionPolicy(explicit)) {
      return {
        allowed: false, code: "invalid_execution_policy",
        reason: `execution policy ${JSON.stringify(explicit)} must be one of ${CODEX_EXECUTION_POLICIES.join("|")}`,
        configured: resolved.configured, executionPolicy: null, gateKind: "profile"
      };
    }
    executionPolicy = explicit;
  } else if ((resolved.configured.sandboxMode ?? "") === "danger-full-access") {
    return {
      allowed: false, code: "danger_requires_explicit",
      reason: `profile ${trimmed} resolves to sandbox danger-full-access, which is an explicit per-run choice only and is never inherited; pass execution_policy "danger-full-access" explicitly to select it`,
      configured: resolved.configured, executionPolicy: null, gateKind: "profile"
    };
  } else if (isCodexExecutionPolicy(resolved.configured.sandboxMode ?? "")) {
    executionPolicy = resolved.configured.sandboxMode as CodexExecutionPolicy;
  } else {
    return {
      allowed: false, code: "execution_policy_unresolvable",
      reason: `profile ${trimmed} resolves to no known sandbox (${resolved.configured.sandboxMode ?? "(none)"}); pass an explicit execution_policy (read-only|workspace-write|danger-full-access)`,
      configured: resolved.configured, executionPolicy: null, gateKind: "profile"
    };
  }
  return {
    allowed: true, code: "ok",
    reason: `profile ${trimmed} verified for real-task delegation (model ${rawModelOverride || resolved.configured.model}, sandbox ${executionPolicy})`,
    configured: resolved.configured, executionPolicy, gateKind: "profile",
    effectiveModel: rawModelOverride || resolved.configured.model || null,
    effectiveEffort: resolved.configured.reasoningEffort ?? null,
    ...(rawModelOverride ? { modelOverride: rawModelOverride } : {}),
    ...(configOverrides.length > 0 ? { configOverrides } : {})
  };
}

/**
 * Build the real-task Codex argv. Sandbox comes from the adjudicated
 * execution policy via -s/--sandbox; approval behavior stays with the
 * selected profile. `-s danger-full-access` and
 * `--dangerously-bypass-approvals-and-sandbox` are DISTINCT flags that are
 * never equated: the sandbox alone never implies the bypass. The bypass
 * flag rides ONLY with a separate explicit per-run opt-in
 * (dangerBypassExplicit) AND the danger sandbox; any other combination
 * carries no bypass flag (launch-level refusal of mismatched combos lives
 * in the gate, not here). A refusal after failure must be classified, not
 * escalated.
 *
 * --ephemeral is kept for real tasks exactly as for the canary slice:
 * ephemeral drops session-file persistence only (capabilities still come
 * from -s), preserving the qualified no-resume honesty (follow-up is a
 * labeled new attempt) and the existing spawn/crash contract.
 */
export function buildCodexRealArgv(
  profile: string,
  prompt: string,
  lastMessagePath: string,
  opts: { executionPolicy: CodexExecutionPolicy; modelOverride?: string; configOverrides?: string[]; dangerBypassExplicit?: boolean }
): string[] {
  const argv = ["exec", "--ephemeral", "--skip-git-repo-check", "--profile", profile, "-s", opts.executionPolicy];
  if (opts.modelOverride) argv.push("-m", opts.modelOverride);
  for (const override of opts.configOverrides ?? []) argv.push("-c", override);
  if (opts.executionPolicy === "danger-full-access" && opts.dangerBypassExplicit === true) {
    argv.push("--dangerously-bypass-approvals-and-sandbox");
  }
  argv.push("--output-last-message", lastMessagePath, prompt);
  return argv;
}

/**
 * Build the steerable Codex argv: identical profile + execution-policy
 * boundaries to buildCodexRealArgv, except WITHOUT --ephemeral so the
 * session persists and the engine returns an addressable thread id, and WITH
 * --json so the launch requests the supported structured startup/control
 * protocol (JSONL events on stdout; `codex exec --help`: "--json: Print
 * events to stdout as JSONL"). The thread id is recorded only from
 * engine-observed events with a validated startup type (never synthesized);
 * steering later queues only to that recorded id. Explicit opt-in per run
 * (launch `steerable: true`, codex only); the default stays ephemeral.
 */
export function buildCodexSteerableArgv(
  profile: string,
  prompt: string,
  lastMessagePath: string,
  opts: { executionPolicy: CodexExecutionPolicy; modelOverride?: string; configOverrides?: string[]; dangerBypassExplicit?: boolean }
): string[] {
  const argv = ["exec", "--skip-git-repo-check", "--json", "--profile", profile, "-s", opts.executionPolicy];
  if (opts.modelOverride) argv.push("-m", opts.modelOverride);
  for (const override of opts.configOverrides ?? []) argv.push("-c", override);
  if (opts.executionPolicy === "danger-full-access" && opts.dangerBypassExplicit === true) {
    argv.push("--dangerously-bypass-approvals-and-sandbox");
  }
  argv.push("--output-last-message", lastMessagePath, prompt);
  return argv;
}

export type CodexFailureClass =
  | "execution-denial"
  | "missing-executable"
  | "auth-problem"
  | "unsupported-model"
  | "unknown";

export interface CodexFailureClassification {
  class: CodexFailureClass;
  evidence: string;
  /** True ONLY for a real tool-execution denial. Never for a file-read refusal without a tool attempt. */
  permissionChangeWarranted: boolean;
  note: string;
}

/**
 * Classify Codex launch/run failure evidence BEFORE any permission change is
 * even proposed. A file-read refusal WITHOUT a tool attempt is NOT evidence
 * to disable the sandbox: only a denial of an actually-attempted tool/command
 * execution warrants proposing a (still explicit, still per-run) policy
 * change. Missing binaries, auth problems, and unsupported-model assertions
 * are never permission evidence.
 */
export function classifyCodexFailure(input: {
  exitCode?: number | null;
  stderrTail?: string;
  spawnError?: string;
}): CodexFailureClassification {
  const stderr = String(input.stderrTail ?? "");
  const spawn = String(input.spawnError ?? "");
  const combined = `${spawn}\n${stderr}`;
  if (/ENOENT|spawn .* ENOENT|command not found|exit 127/i.test(combined) || input.exitCode === 127) {
    return {
      class: "missing-executable",
      evidence: "spawn ENOENT / exit 127 (binary missing, not a permission denial)",
      permissionChangeWarranted: false,
      note: "install or PATH problem; changing sandbox policy cannot fix a missing executable"
    };
  }
  if (/unauthorized|unauthenticated|401\b|invalid api key|api key.*(missing|invalid)|please (log in|run .*login)|auth.*(failed|expired)/i.test(combined)) {
    return {
      class: "auth-problem",
      evidence: "auth-shaped failure text (never permission evidence)",
      permissionChangeWarranted: false,
      note: "credential problem; changing sandbox policy cannot fix authentication"
    };
  }
  if (/model .* (not found|not supported|unavailable|does not exist)|unsupported model|unknown model/i.test(combined)) {
    return {
      class: "unsupported-model",
      evidence: "unsupported-model assertion (never permission evidence)",
      permissionChangeWarranted: false,
      note: "model assertion problem; changing sandbox policy cannot fix model availability"
    };
  }
  const toolDenial = /(denied by sandbox|sandbox.*denied|command .* (blocked|denied)|exec.*denied|approval.*(denied|required)|permission denied.*(exec|command|tool)|sandbox policy)/i.test(combined);
  if (toolDenial) {
    return {
      class: "execution-denial",
      evidence: "tool/command execution denial in worker stderr",
      permissionChangeWarranted: true,
      note: "a real execution denial warrants PROPOSING (never auto-applying) an explicit per-run policy change through the action-time confirmation surface"
    };
  }
  if (/refus|failed to read|could not read|EACCES/i.test(combined)) {
    return {
      class: "execution-denial",
      evidence: "read-shaped refusal without an observed tool/command attempt",
      permissionChangeWarranted: false,
      note: "a file-read refusal without a tool attempt is NOT evidence to disable the sandbox; no permission change is proposed"
    };
  }
  return {
    class: "unknown",
    evidence: "no classified denial signal in the bounded evidence",
    permissionChangeWarranted: false,
    note: "unclassified output never warrants a permission change; gather the actual worker evidence first"
  };
}

// ---------------------------------------------------------------------------
// OpenCode profiles (agents) + real-task launch
// ---------------------------------------------------------------------------

export function opencodeAgentsDir(): string {
  const explicit = String(process.env.CODEXPRO_OPENCODE_AGENTS_DIR ?? "").trim();
  if (explicit) return path.resolve(explicit.replace(/^~(?=\/|$)/, os.homedir()));
  return path.join(os.homedir(), ".config", "opencode-v2", "opencode", "agents");
}

export interface OpenCodeAgentResolved {
  name: string;
  exists: boolean;
  definitionPath: string;
}

/** Resolve one OpenCode agent by REAL name (agents/<name>.md). Read-only. */
export function describeOpenCodeAgent(agent: string, agentsDir?: string): OpenCodeAgentResolved {
  const trimmed = String(agent ?? "").trim();
  const dir = agentsDir ?? opencodeAgentsDir();
  const definitionPath = path.join(dir, `${trimmed}.md`);
  let exists = false;
  try {
    exists = fs.statSync(definitionPath).isFile();
  } catch {
    exists = false;
  }
  return { name: trimmed, exists, definitionPath };
}

/** List real OpenCode agent names present in the agents dir (bounded). */
export function listOpenCodeAgentNames(agentsDir?: string, limit = 64): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir ?? opencodeAgentsDir());
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length))
    .sort()
    .slice(0, Math.max(1, Math.min(limit, 256)));
}

export interface OpenCodeLaunchGate {
  allowed: boolean;
  code: string;
  reason: string;
  hostModel: string | null;
  requestedModel: string | null;
  agent: OpenCodeAgentResolved | null;
  /** Host-model equality was enforced (legacy canary) or not (real task). */
  hostEqualityEnforced: boolean;
}

/**
 * OpenCode launch gate. The host-model equality gate stays ONLY for the
 * legacy canary slice; real tasks use the SELECTED agent (must exist by real
 * name) plus an EXPLICIT model (never substituted, never Astra). Codex flags
 * are never translated: the route is always opencode run --model/--agent.
 */
export function verifyOpenCodeLaunch(opts: {
  model: unknown;
  agent: unknown;
  isCanary: boolean;
  delegationGroup: string;
  hostModel?: string | null;
  agentsDir?: string;
}): OpenCodeLaunchGate {
  const agentName = typeof opts.agent === "string" ? opts.agent.trim() : "";
  const legacyCanary = opts.isCanary && opts.delegationGroup === CANARY_DELEGATION_GROUP;
  const modelForError = typeof opts.model === "string" ? opts.model.trim() || null : null;
  const hostForError = opts.hostModel ?? describeOpenCodeDiscovery().hostModel;
  // Legacy canary predates the agent surface: agent is optional there (when
  // supplied it must still exist by real name). Real tasks require it.
  let agent: OpenCodeAgentResolved | null = null;
  if (agentName) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agentName)) {
      return {
        allowed: false, code: "agent_required",
        reason: `invalid OpenCode agent name ${JSON.stringify(agentName)}`,
        hostModel: hostForError, requestedModel: modelForError,
        agent: null, hostEqualityEnforced: false
      };
    }
    agent = describeOpenCodeAgent(agentName, opts.agentsDir);
    if (!agent.exists) {
      return {
        allowed: false, code: "agent_unknown",
        reason: `unknown OpenCode agent ${JSON.stringify(agentName)} (no ${agentName}.md in the agents dir; pass a real existing agent, never a substitute)`,
        hostModel: hostForError, requestedModel: modelForError,
        agent, hostEqualityEnforced: false
      };
    }
  } else if (!legacyCanary) {
    return {
      allowed: false, code: "agent_required",
      reason: "an explicit OpenCode agent is required for real tasks (pass a real agent name from the agents dir; Codex profiles are never translated)",
      hostModel: hostForError, requestedModel: modelForError,
      agent: null, hostEqualityEnforced: false
    };
  }
  const want = typeof opts.model === "string" ? opts.model.trim() : "";
  if (!want) {
    return {
      allowed: false, code: "model_required",
      reason: "an explicit OpenCode model is required (pass --model explicitly; nothing is inferred)",
      hostModel: opts.hostModel ?? describeOpenCodeDiscovery().hostModel,
      requestedModel: null, agent, hostEqualityEnforced: false
    };
  }
  if (isAstraModelId(want)) {
    return {
      allowed: false, code: "astra_forbidden",
      reason: `explicit OpenCode model ${want} is Astra; Astra is never used and never a fallback`,
      hostModel: opts.hostModel ?? null, requestedModel: want, agent, hostEqualityEnforced: false
    };
  }
  if (legacyCanary) {
    const gate = verifyOpenCodeModel(want, opts.hostModel);
    if (!gate.allowed) {
      const code = !gate.hostModel ? "opencode_host_model_unknown" : "opencode_model_mismatch";
      return {
        allowed: false, code, reason: gate.reason,
        hostModel: gate.hostModel, requestedModel: gate.requested ?? null,
        agent, hostEqualityEnforced: true
      };
    }
    return {
      allowed: true, code: "ok",
      reason: agent
        ? `OpenCode canary model verified against host top-level model (agent ${agent.name})`
        : "OpenCode canary model verified against host top-level model (legacy slice, no agent)",
      hostModel: gate.hostModel, requestedModel: gate.requested ?? null,
      agent, hostEqualityEnforced: true
    };
  }
  return {
    allowed: true, code: "ok",
    reason: `OpenCode real-task launch verified (agent ${agent?.name ?? "(none)"}, explicit model ${want}; host-model equality is canary-only)`,
    hostModel: opts.hostModel ?? describeOpenCodeDiscovery().hostModel,
    requestedModel: want, agent, hostEqualityEnforced: false
  };
}

/** Build the OpenCode real-task argv (opencode run --standalone route; no Codex flags). */
export function buildOpenCodeRealArgv(opts: {
  model: string;
  agent: string;
  prompt: string;
  sessionId?: string;
  title?: string;
}): string[] {
  const argv = ["run", "--standalone", "--model", opts.model, "--agent", opts.agent, "--format", "json"];
  if (opts.sessionId) argv.push("--session", opts.sessionId);
  if (opts.title) argv.push("--title", opts.title);
  argv.push(opts.prompt);
  return argv;
}

// ---------------------------------------------------------------------------
// Claude profiles (agents) + launch + resume
// ---------------------------------------------------------------------------

export const CLAUDE_VERSION_QUALIFIED = "2.1.289";
export const CLAUDE_QUALIFIED_FLAGS = [
  "--agent",
  "--agents json",
  "--model",
  "--effort low|medium|high|xhigh|max",
  "--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan",
  "--allowedTools/--disallowedTools",
  "-p --output-format text|json|stream-json",
  "-r/--resume",
  "-c/--continue",
  "--fork-session",
  "--session-id uuid",
  "--add-dir",
  "--mcp-config",
  "--settings"
] as const;

export const CLAUDE_PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function resolveClaudeBinary(): string {
  const explicit = String(process.env.CODEXPRO_CLAUDE_BIN ?? "").trim();
  return explicit || "claude";
}

export function claudeAgentsDir(): string {
  const explicit = String(process.env.CODEXPRO_CLAUDE_AGENTS_DIR ?? "").trim();
  if (explicit) return path.resolve(explicit.replace(/^~(?=\/|$)/, os.homedir()));
  return path.join(os.homedir(), ".claude", "agents");
}

export interface ClaudeAgentResolved {
  name: string;
  exists: boolean;
  definitionPath: string;
  /** Model from the agent frontmatter, when present (inheritance source). */
  definitionModel?: string;
  /** Effort from the agent frontmatter, when present (inheritance source). */
  definitionEffort?: string;
}

/**
 * Resolve one Claude agent by REAL name (agents/<name>.md). Reads the
 * frontmatter model/effort as the inheritance source ONLY: explicit caller
 * flags win, nothing is inferred beyond the file.
 */
export function describeClaudeAgent(agent: string, agentsDir?: string): ClaudeAgentResolved {
  const trimmed = String(agent ?? "").trim();
  const dir = agentsDir ?? claudeAgentsDir();
  const definitionPath = path.join(dir, `${trimmed}.md`);
  let text: string | null = null;
  try {
    if (!fs.statSync(definitionPath).isFile()) return { name: trimmed, exists: false, definitionPath };
    text = fs.readFileSync(definitionPath, "utf8");
  } catch {
    return { name: trimmed, exists: false, definitionPath };
  }
  const head = text.slice(0, 2048);
  const modelMatch = head.match(/^model:\s*([A-Za-z0-9][A-Za-z0-9_./+-]{0,127})/m);
  const effortMatch = head.match(/^effort:\s*([A-Za-z]+)/m);
  const out: ClaudeAgentResolved = { name: trimmed, exists: true, definitionPath };
  if (modelMatch) out.definitionModel = modelMatch[1];
  if (effortMatch && (CLAUDE_EFFORTS as readonly string[]).includes(effortMatch[1])) {
    out.definitionEffort = effortMatch[1];
  }
  return out;
}

/** List real Claude agent names present in the agents dir (bounded). */
export function listClaudeAgentNames(agentsDir?: string, limit = 64): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(agentsDir ?? claudeAgentsDir());
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.slice(0, -".md".length))
    .sort()
    .slice(0, Math.max(1, Math.min(limit, 256)));
}

/** Claude session ids are UUIDs (--session-id requires a valid UUID). */
export function isClaudeSessionId(value: unknown): boolean {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function newClaudeSessionId(): string {
  const bytes = createHash("sha256")
    .update(`${Date.now()}:${process.pid}:${Math.random()}`)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface ClaudeLaunchGate {
  allowed: boolean;
  code: string;
  reason: string;
  agent: ClaudeAgentResolved | null;
  effectiveModel: string | null;
  effectiveEffort: string | null;
  /** True when the value came from an explicit caller flag (never inherited silently). */
  modelExplicit: boolean;
  effortExplicit: boolean;
  permissionExplicit: boolean;
}

/**
 * Claude launch gate: the agent must exist by real name; --model/--effort/
 * --permission-mode/--allowedTools ride argv ONLY when the caller explicitly
 * passed them, otherwise the run inherits the agent/settings default.
 * bypassPermissions is an EXPLICIT per-run choice only. Never Astra.
 */
export function verifyClaudeLaunch(opts: {
  agent: unknown;
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
  allowedTools?: unknown;
  disallowedTools?: unknown;
  agentsDir?: string;
}): ClaudeLaunchGate {
  const agentName = typeof opts.agent === "string" ? opts.agent.trim() : "";
  if (!agentName || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agentName)) {
    return {
      allowed: false, code: "agent_required",
      reason: "an explicit Claude agent is required (pass a real agent name from ~/.claude/agents; nothing is inferred)",
      agent: null, effectiveModel: null, effectiveEffort: null,
      modelExplicit: false, effortExplicit: false, permissionExplicit: false
    };
  }
  const agent = describeClaudeAgent(agentName, opts.agentsDir);
  if (!agent.exists) {
    return {
      allowed: false, code: "agent_unknown",
      reason: `unknown Claude agent ${JSON.stringify(agentName)} (no ${agentName}.md in the agents dir; pass a real existing agent, never a substitute)`,
      agent, effectiveModel: null, effectiveEffort: null,
      modelExplicit: false, effortExplicit: false, permissionExplicit: false
    };
  }
  const model = typeof opts.model === "string" ? opts.model.trim() : "";
  const effort = typeof opts.effort === "string" ? opts.effort.trim() : "";
  const permissionMode = typeof opts.permissionMode === "string" ? opts.permissionMode.trim() : "";
  if (model && isAstraModelId(model)) {
    return {
      allowed: false, code: "astra_forbidden",
      reason: `explicit Claude model ${model} is Astra; Astra is never used and never a fallback`,
      agent, effectiveModel: null, effectiveEffort: null,
      modelExplicit: true, effortExplicit: false, permissionExplicit: false
    };
  }
  if (isAstraModelId(agent.definitionModel ?? "")) {
    return {
      allowed: false, code: "astra_forbidden",
      reason: `Claude agent ${agentName} defines Astra model ${agent.definitionModel}; Astra is never used and never a fallback`,
      agent, effectiveModel: null, effectiveEffort: null,
      modelExplicit: false, effortExplicit: false, permissionExplicit: false
    };
  }
  if (effort && !(CLAUDE_EFFORTS as readonly string[]).includes(effort)) {
    return {
      allowed: false, code: "invalid_effort",
      reason: `effort ${JSON.stringify(effort)} must be one of ${CLAUDE_EFFORTS.join("|")}`,
      agent, effectiveModel: null, effectiveEffort: null,
      modelExplicit: false, effortExplicit: false, permissionExplicit: false
    };
  }
  if (permissionMode && !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return {
      allowed: false, code: "invalid_permission_mode",
      reason: `permission_mode ${JSON.stringify(permissionMode)} must be one of ${CLAUDE_PERMISSION_MODES.join("|")}`,
      agent, effectiveModel: null, effectiveEffort: null,
      modelExplicit: false, effortExplicit: false, permissionExplicit: false
    };
  }
  for (const [label, value] of [["allowedTools", opts.allowedTools], ["disallowedTools", opts.disallowedTools]] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 2048)) {
      return {
        allowed: false, code: "invalid_tool_filter",
        reason: `${label} must be bounded non-empty tool text when present`,
        agent, effectiveModel: null, effectiveEffort: null,
        modelExplicit: false, effortExplicit: false, permissionExplicit: false
      };
    }
  }
  return {
    allowed: true, code: "ok",
    reason: model
      ? `Claude agent ${agentName} verified with explicit model ${model}`
      : `Claude agent ${agentName} verified (model/effort inherit the agent definition where the caller passed no explicit flag)`,
    agent,
    effectiveModel: model || agent.definitionModel || null,
    effectiveEffort: effort || agent.definitionEffort || null,
    modelExplicit: Boolean(model),
    effortExplicit: Boolean(effort),
    permissionExplicit: Boolean(permissionMode)
  };
}

export interface ClaudeArgvOpts {
  agent: string;
  prompt: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string;
  disallowedTools?: string;
  /** Stable session UUID always passed via --session-id (minted when omitted at launch). */
  sessionId?: string;
  /** True resume via --resume (only after session verification). */
  resume?: boolean;
  addDirs?: string[];
}

/**
 * Build the Claude argv (-p --output-format json, non-interactive). Only
 * explicitly-passed model/effort/permission/tool flags appear; otherwise the
 * agent/settings default governs. Resume uses --resume ONLY after
 * verifyClaudeSession; otherwise the stable --session-id rides (first use
 * creates under installed semantics, labeled new-continuation-attempt).
 */
export function buildClaudeArgv(opts: ClaudeArgvOpts): string[] {
  const argv = ["-p", "--output-format", "json", "--agent", opts.agent];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.effort) argv.push("--effort", opts.effort);
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.allowedTools) argv.push("--allowedTools", opts.allowedTools);
  if (opts.disallowedTools) argv.push("--disallowedTools", opts.disallowedTools);
  for (const dir of opts.addDirs ?? []) argv.push("--add-dir", dir);
  if (opts.resume && opts.sessionId) argv.push("--resume", opts.sessionId);
  else if (opts.sessionId) argv.push("--session-id", opts.sessionId);
  argv.push(opts.prompt);
  return argv;
}

/** Build the Claude true-resume argv (verified session only). Carries the
 * run's full explicit-flag set: agent + permission-mode AND the explicit
 * model/effort/tool filters, so a verified resume never drops stored
 * overrides. Every flag rides only when explicitly passed at launch (the
 * stored run fields already encode explicit-only); otherwise the
 * agent/settings default governs. Verified-resume is used only after
 * verifyClaudeSession confirms the session file; unverified ids ride
 * --session-id as first-use creation instead. */
export function buildClaudeResumeArgv(
  sessionId: string,
  prompt: string,
  opts?: {
    agent?: string;
    permissionMode?: string;
    model?: string;
    effort?: string;
    allowedTools?: string;
    disallowedTools?: string;
  }
): string[] {
  const argv = ["--resume", sessionId, "-p", "--output-format", "json"];
  if (opts?.agent) argv.push("--agent", opts.agent);
  if (opts?.model) argv.push("--model", opts.model);
  if (opts?.effort) argv.push("--effort", opts.effort);
  if (opts?.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts?.allowedTools) argv.push("--allowedTools", opts.allowedTools);
  if (opts?.disallowedTools) argv.push("--disallowedTools", opts.disallowedTools);
  argv.push(prompt);
  return argv;
}

/** Claude session-resume capability, qualified independently. */
export const CLAUDE_RESUME_CAPABILITY = {
  engine: "claude",
  route: "claude --resume <session-uuid> -p --output-format json / --session-id <uuid> for first-use creation",
  resumeArgvShape: "--resume <session-uuid> -p --output-format json [--agent <name>] [--model <m>] [--effort <e>] [--permission-mode <p>] [--allowedTools/--disallowedTools <t>] <prompt>",
  sessionIdGrammar: "uuid (verified by --session-id contract)",
  createsIfMissing: true,
  overridesRideResume: true,
  note: "The delegation run always passes a stable --session-id (minted when the caller omits one): first use creates the session, later uses with a verified session file are true resume via --resume carrying the run's full explicit-flag set (agent + permission-mode + explicit model/effort/tool filters; installed `claude --help` states no exclusion of session-scoped flags under --resume). Unverified ids are labeled new-continuation-attempt, never resumed."
} as const;

/**
 * Per-engine qualification, adjudicated INDEPENDENTLY (no engine's proof
 * depends on another's). Codex (codex-cli 0.159.0) and OpenCode (v2.0.22)
 * are qualified on their profile/agent-driven routes. Claude (2.1.289)
 * launch and verified-resume both carry the run's full explicit-flag set
 * (agent + permission-mode + explicit model/effort/tool filters ride every
 * continuation argv; verified-resume only after the session-file check), so
 * no stored override is dropped on continuation. Claude is qualified by a
 * bounded live probe on the launch route (quota/auth/config vs execution
 * classified from observed evidence: execution success); verified-resume
 * dispatches only after the session-file check, with the live --resume
 * flag-honoring caveat stated, never assumed. No engine's proof gates
 * another's.
 */
export const CODEX_ENGINE_QUALIFICATION = {
  engine: "codex",
  qualified: true,
  qualifiedCli: "codex-cli 0.159.0",
  note: "qualified on the selected-profile route with per-run execution policy; independent of the Claude path"
} as const;

export const OPENCODE_ENGINE_QUALIFICATION = {
  engine: "opencode",
  qualified: true,
  qualifiedCli: "opencode v2.0.22",
  note: "qualified on the selected-agent + explicit-model route via `opencode run --standalone` (private server per turn); pre-standalone shared-service runs stay labeled and are never silently converted; independent of the Claude path"
} as const;

export const CLAUDE_ENGINE_QUALIFICATION = {
  engine: "claude",
  qualified: true,
  status: "qualified-live-probe",
  qualifiedCli: "claude 2.1.289",
  probe: "bounded live probe 2026-10-05 (one economical call, then stop): `claude -p --output-format json --agent scout-fast --session-id <uuid>` exited 0 with subtype success and the exact worker reply PROBE-OK (cost $0.057025); the stable session file was observed under the claude projects dir (first-use creation); classification = execution success (no quota/rate-limit, no authentication, no configuration block; `claude doctor` exit 0 with no issues, credentials present, settings keys inspected without reading values)",
  resumeCaveat: "verified-resume (--resume carrying the run's full explicit-flag set) dispatches only after the session-file check; whether the engine honors every session-scoped flag under --resume is UNPROVEN live (one probe, then stop) and stays stated here, never assumed",
  note: "qualified on the selected-agent + explicit-flag route via `claude -p --output-format json --agent <real-name>` with a stable --session-id (minted when omitted); only explicitly-passed --model/--effort/--permission-mode/--allowedTools ride argv, otherwise the agent/settings default governs. Claude proof never gates Codex/OpenCode proof"
} as const;

/** Qualification marker for one engine (qualified codex/opencode/claude, each adjudicated independently). */
export function engineQualification(engine: string): Record<string, unknown> {
  if (engine === "codex") return { ...CODEX_ENGINE_QUALIFICATION };
  if (engine === "opencode") return { ...OPENCODE_ENGINE_QUALIFICATION };
  return { ...CLAUDE_ENGINE_QUALIFICATION };
}

/**
 * OpenCode cancel capability against the qualified CLI (opencode v2.0.22,
 * `opencode run --help` / `opencode session --help`). New launches and
 * continuations run `--standalone` (a private server for the turn), so the
 * PID+starttime-verified owned tree IS the serving process tree: reaping it
 * stops the owned work. Runs launched before the standalone route stay
 * honestly labeled shared-service (never silently converted). The session
 * subcommands are list/delete/export/import: there is NO session-scoped
 * halt/stop for an in-flight run turn on either route. PID-tree cleanup
 * alone therefore never proves the session turn halted. Cancel verification
 * is fail-closed: the PID+starttime-verified owned tree is reaped, a
 * post-cancel liveness recheck must show the owned tree gone, AND a windowed
 * post-cancel workdir quiescence probe (no further writes across a grace +
 * verification window) must pass; the ack reports session-side halt as
 * unclaimed with this blocker, never as cleanup proof. Cleanup stays
 * incomplete/uncertain until verified; a repeated cancel re-verifies live
 * (never converts a cached incomplete into success).
 */
export const OPENCODE_CANCEL_CAPABILITY = {
  engine: "opencode",
  pidRoute: "cancelOwnedTree over the PID+starttime-verified owned tree only (--standalone private server for new turns; pre-standalone runs labeled shared-service, never silently converted)",
  sessionScopedHaltSupported: false,
  sessionRoute: "opencode v2.0.22 session subcommands are list/delete/export/import (no halt/stop of an in-flight run turn on either route); new turns run --standalone (private server) so the owned tree is the serving tree, pre-standalone runs stay labeled shared-service",
  verification: "owned-tree liveness recheck plus a windowed post-cancel workdir quiescence probe (grace + verification window, no further writes after cancel-complete); unverifiable workdirs fail closed; repeated cancel re-verifies live",
  blocker: "no session-scoped halt in the qualified CLI; cancel verification is PID-tree + liveness recheck + windowed quiescence only and is reported as such, never as session-halt proof"
} as const;

function claudeProjectsRoot(): string {
  const explicit = String(process.env.CODEXPRO_CLAUDE_PROJECTS_DIR ?? "").trim();
  if (explicit) return path.resolve(explicit.replace(/^~(?=\/|$)/, os.homedir()));
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Verify a Claude session id with LOCAL read-only probes only (no model
 * call): the id must be a UUID and a matching `<uuid>.jsonl` session file
 * must exist under ~/.claude/projects. Anything inconclusive fails closed:
 * unverified ids ride --session-id as first-use creation and are labeled
 * new-continuation-attempt, never resumed.
 */
export function verifyClaudeSession(sessionId: string, projectsRoot?: string): SessionVerification {
  const sid = String(sessionId ?? "").trim();
  if (!isClaudeSessionId(sid)) {
    return { verified: false, evidence: "session id is not a UUID; never claimed resumed" };
  }
  const root = projectsRoot ?? claudeProjectsRoot();
  let slugs: string[];
  try {
    slugs = fs.readdirSync(root);
  } catch {
    return {
      verified: false,
      evidence: "claude projects dir unreadable; session unverified, labeled new-continuation-attempt"
    };
  }
  for (const slug of slugs.slice(0, 256)) {
    if (!slug || slug.startsWith(".")) continue;
    const candidate = path.join(root, slug, `${sid}.jsonl`);
    try {
      if (fs.statSync(candidate).isFile()) {
        return {
          verified: true,
          evidence: `session file ${slug}/${sid}.jsonl present under the claude projects dir (local probe, no model call)`
        };
      }
    } catch { /* not in this project slug */ }
  }
  return {
    verified: false,
    evidence: "no session file for this UUID under the claude projects dir; first use creates, labeled new-continuation-attempt"
  };
}

// ---------------------------------------------------------------------------
// Engine capability probe (no live model calls) + resolved-launch preview
// ---------------------------------------------------------------------------

export interface EngineBinaryProbe {
  binary: string;
  found: boolean;
  version: string | null;
  evidence: string;
}

/** Probe one engine binary with `--version` only (no model call, no mutation). */
export function probeEngineBinary(binary: string, timeoutMs = 10_000): EngineBinaryProbe {
  const bin = String(binary ?? "").trim() || "(none)";
  try {
    const result = spawnSync(bin, ["--version"], {
      timeout: Math.max(1000, Math.min(timeoutMs, 30_000)),
      encoding: "utf8",
      maxBuffer: 64 * 1024
    });
    if (result.error) {
      return { binary: bin, found: false, version: null, evidence: `binary probe failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return { binary: bin, found: false, version: null, evidence: `--version exited ${result.status}; binary unusable` };
    }
    const firstLine = String(result.stdout ?? "").split(/\r?\n/)[0].slice(0, 120);
    return { binary: bin, found: true, version: firstLine || "(no version text)", evidence: `--version exit 0 (${firstLine || "no version text"})` };
  } catch (error) {
    return { binary: bin, found: false, version: null, evidence: `binary probe threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface EngineCapability {
  engine: string;
  binary: EngineBinaryProbe;
  /** Profile/agent definition found by real name (null when none requested). */
  definitionFound: boolean | null;
  definitionPath: string | null;
  /** Auth is NEVER probed without a live call; this states the evidence limit. */
  authNote: string;
  ready: boolean;
  /** Exact blocker when not ready (missing binary, unknown profile, ...). */
  blocker: string | null;
}

/**
 * Capability probe for one engine: binary presence plus the requested
 * profile/agent definition. Auth is explicitly unverified without a live
 * call (preview/launch never performs one); a launch that fails for auth is
 * classified auth-problem and fails closed. Missing capability leaves the
 * engine INCOMPLETE: never substitute another engine.
 */
export function probeEngineCapability(
  engine: string,
  opts?: { profileOrAgent?: string; binary?: string }
): EngineCapability {
  const authNote = "auth is not probed without a live call (preview performs none); an unauthenticated launch fails closed as auth-problem, never as a substituted engine";
  if (engine === "codex") {
    const binary = probeEngineBinary(opts?.binary ?? resolveCodexBinary());
    const name = typeof opts?.profileOrAgent === "string" ? opts.profileOrAgent.trim() : "";
    if (!binary.found) {
      return {
        engine, binary, definitionFound: name ? false : null,
        definitionPath: null, authNote, ready: false,
        blocker: `codex binary missing (${binary.evidence}); install codex-cli to complete this engine`
      };
    }
    if (!name) {
      return {
        engine, binary, definitionFound: null, definitionPath: null, authNote, ready: false,
        blocker: "no Codex profile requested; an explicit real profile name is required"
      };
    }
    const resolved = describeCodexProfile(codexHomeDir(), name);
    if (!resolved.exists) {
      return {
        engine, binary, definitionFound: false, definitionPath: resolved.configured.profileConfigPath ?? null,
        authNote, ready: false,
        blocker: `unknown Codex profile ${JSON.stringify(name)}; pass a real existing profile`
      };
    }
    return {
      engine, binary, definitionFound: true,
      definitionPath: resolved.configured.profileConfigPath ?? null,
      authNote, ready: true, blocker: null
    };
  }
  if (engine === "opencode") {
    const binary = probeEngineBinary(opts?.binary ?? resolveOpenCodeBinary());
    const name = typeof opts?.profileOrAgent === "string" ? opts.profileOrAgent.trim() : "";
    if (!binary.found) {
      return {
        engine, binary, definitionFound: name ? false : null,
        definitionPath: null, authNote, ready: false,
        blocker: `opencode binary missing (${binary.evidence}); install opencode to complete this engine`
      };
    }
    if (!name) {
      return {
        engine, binary, definitionFound: null, definitionPath: null, authNote, ready: false,
        blocker: "no OpenCode agent requested; an explicit real agent name is required"
      };
    }
    const resolved = describeOpenCodeAgent(name);
    if (!resolved.exists) {
      return {
        engine, binary, definitionFound: false, definitionPath: resolved.definitionPath,
        authNote, ready: false,
        blocker: `unknown OpenCode agent ${JSON.stringify(name)}; pass a real existing agent`
      };
    }
    return {
      engine, binary, definitionFound: true, definitionPath: resolved.definitionPath,
      authNote, ready: true, blocker: null
    };
  }
  if (engine === "claude") {
    const binary = probeEngineBinary(opts?.binary ?? resolveClaudeBinary());
    const name = typeof opts?.profileOrAgent === "string" ? opts.profileOrAgent.trim() : "";
    if (!binary.found) {
      return {
        engine, binary, definitionFound: name ? false : null,
        definitionPath: null, authNote, ready: false,
        blocker: `claude binary missing (${binary.evidence}); install claude to complete this engine`
      };
    }
    if (!name) {
      return {
        engine, binary, definitionFound: null, definitionPath: null, authNote, ready: false,
        blocker: "no Claude agent requested; an explicit real agent name is required"
      };
    }
    const resolved = describeClaudeAgent(name);
    if (!resolved.exists) {
      return {
        engine, binary, definitionFound: false, definitionPath: resolved.definitionPath,
        authNote, ready: false,
        blocker: `unknown Claude agent ${JSON.stringify(name)}; pass a real existing agent`
      };
    }
    return {
      engine, binary, definitionFound: true, definitionPath: resolved.definitionPath,
      authNote, ready: true, blocker: null
    };
  }
  return {
    engine, binary: { binary: "(none)", found: false, version: null, evidence: "unknown engine" },
    definitionFound: false, definitionPath: null, authNote, ready: false,
    blocker: `unknown engine ${JSON.stringify(engine)}; must be codex|opencode|claude`
  };
}

export interface LaunchPreviewInput {
  engine: string;
  executable: string;
  /** Full argv with the worker prompt replaced by a bounded placeholder. */
  argvPreview: string[];
  promptChars: number;
  profile?: string;
  agent?: string;
  /** Model/effort WHERE resolvable from the real definition files (null = inherited, not substituted). */
  modelConfigured?: string | null;
  effortConfigured?: string | null;
  modelExplicit?: boolean;
  effortExplicit?: boolean;
  executionPolicy?: string | null;
  permissionMode?: string | null;
  workdir: string;
  delegationGroup: string;
  isCanary: boolean;
  timeoutMs: number;
  gateReason: string;
  capability: EngineCapability;
  /** Per-engine qualification marker (qualified codex/opencode/claude, each adjudicated independently). */
  qualification?: Record<string, unknown>;
}

/**
 * Resolved-launch preview (dry-run): shows the actual executable, argv
 * shape, profile/agent, model/effort WHERE resolvable from the real
 * definition files, execution policy, and working directory. The worker
 * prompt is NOT echoed (placeholder with length only); no secrets ever
 * appear (delegation carries none). CONFIGURED settings (from definition
 * files) are separated from RUNTIME-OBSERVED evidence (null before launch;
 * read_result carries it after). Engine-specific differences are stated
 * explicitly in engineNote; a profile is never replaced by a model flag.
 */
export function buildLaunchPreview(input: LaunchPreviewInput): Record<string, unknown> {
  const engineNote = input.engine === "codex"
    ? "codex launches via `codex exec --ephemeral --profile <real-name> -s <execution-policy>`; approval behavior inherits the selected profile; -s danger-full-access never implies --dangerously-bypass-approvals-and-sandbox (sandbox != bypass: the bypass flag rides only with a separate explicit bypass_approvals opt-in plus explicit danger); ephemeral runs persist no session so resume inherits nothing and follow-up is a labeled new attempt"
    : input.engine === "opencode"
      ? "opencode launches via `opencode run --standalone --model <explicit> --agent <real-name> --format json` (private server per turn; pre-standalone shared-service runs stay labeled, never silently converted); --session continues when the id is known and creates otherwise (first use of a minted id is creation); resume is verified via session list/export before any resumed label"
      : "claude launches via `claude -p --output-format json --agent <real-name>` with a stable --session-id (minted when omitted); only explicitly-passed --model/--effort/--permission-mode/--allowedTools appear, otherwise the agent/settings default governs; resume via --resume (full explicit-flag set) only after the session file is verified; Claude launch qualified by a bounded live probe (execution success 2026-10-05); the live --resume flag-honoring caveat stays stated, never assumed";
  return {
    engine: input.engine,
    executable: input.executable,
    argv_preview: input.argvPreview,
    prompt_chars: input.promptChars,
    prompt_note: "worker prompt summarized by length only in preview; the launch echoes the sanitized task length, never secrets (delegation carries none)",
    ...(input.profile ? { profile: input.profile } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    model_configured: input.modelConfigured ?? null,
    effort_configured: input.effortConfigured ?? null,
    model_explicit: Boolean(input.modelExplicit),
    effort_explicit: Boolean(input.effortExplicit),
    ...(input.executionPolicy ? { execution_policy: input.executionPolicy } : {}),
    ...(input.permissionMode ? { permission_mode: input.permissionMode } : {}),
    execution_policy_note: input.engine === "codex"
      ? "sandbox from the adjudicated per-run execution policy (explicit wins over profile); danger-full-access is explicit-only, never inherited or auto-escalated; the sandbox never implies --dangerously-bypass-approvals-and-sandbox (separate explicit bypass_approvals plus explicit danger required)"
      : "this engine keeps its own agent/profile permission semantics; Codex sandbox flags are never translated",
    ...(input.qualification ? { qualification: input.qualification } : {}),
    workdir: input.workdir,
    delegation_group: input.delegationGroup,
    is_canary: input.isCanary,
    timeout_ms: input.timeoutMs,
    gate_reason: input.gateReason,
    configured_vs_observed: "CONFIGURED (above) comes from the real profile/agent definition files. RUNTIME-OBSERVED evidence (exit state, tails, session identity, changed files) is null before launch and appears only in delegation_read_result after dispatch.",
    engine_note: engineNote,
    capability: {
      ready: input.capability.ready,
      binary: input.capability.binary.binary,
      binary_version: input.capability.binary.version,
      definition_path: input.capability.definitionPath,
      auth_note: input.capability.authNote,
      ...(input.capability.blocker ? { blocker: input.capability.blocker } : {})
    },
    overall_status: input.capability.ready
      ? "preview-complete (launch would dispatch; auth still fails closed at spawn when unauthenticated)"
      : "INCOMPLETE (capability missing; fix the blocker, never substitute another engine)",
    sensitive_omitted: true
  };
}

// ---------------------------------------------------------------------------
// Workdir change evidence (git-aware, bounded)
// ---------------------------------------------------------------------------

export interface WorkdirEvidence {
  kind: "git" | "snapshot" | "unavailable";
  changed: string[];
  truncated: boolean;
  reason?: string;
  /** Launch-time commit baseline (HEAD) when the workdir was a git repo. */
  baselineHead?: string | null;
  /** Current HEAD (null when the workdir is not a repo or HEAD is unreadable). */
  currentHead?: string | null;
  /** Worker commits since the launch baseline (repos only; bounded). */
  commits?: WorkdirCommitEvidence;
  /**
   * True when content-fingerprint coverage hit the 500-file bound (at launch
   * baseline or at read time): files beyond the bound are unattributed by
   * content. Never silently complete: consumers must treat unattributed
   * files as uncovered.
   */
  fingerprintsTruncated?: boolean;
  /** Fingerprint counts: baseline files hashed at launch vs now. */
  fingerprintCounts?: { baseline?: number; current?: number };
  /**
   * Files carried name-only (SHA-256 skipped because the file exceeds the
   * 256-KiB hash bound or was unreadable): content edits to these files are
   * unattributed. Count only; per-file reasons ride the baseline records.
   */
  nameOnlyCount?: number;
  /** Coverage-limit explanation when any bound bit (truncation/name-only). */
  coverageReason?: string;
}

/** Worker commits between the launch baseline HEAD and the current HEAD. */
export interface WorkdirCommitEvidence {
  base: string | null;
  head: string | null;
  /** Bounded `short-hash + subject` lines for commits after the baseline. */
  newCommits: string[];
  commitsTruncated: boolean;
  reason?: string;
}

/** Launch-time baseline for attributable change evidence. */
export interface WorkdirBaseline {
  /** Bounded relative-path listing (names only; content edits need fingerprints). */
  snapshot?: string[];
  /** Bounded content fingerprints for attributing edits to existing files. */
  fingerprints?: WorkdirFileFingerprint[];
  fingerprintsTruncated?: boolean;
  /** `git rev-parse HEAD` at launch (null with a reason when not a repo). */
  gitHead?: string | null;
  gitHeadReason?: string;
}

/** Bounded content fingerprint of one regular file under the workdir. */
export interface WorkdirFileFingerprint {
  path: string;
  /** SHA-256 hex when the file was small enough to hash; null with a reason otherwise (256-KiB bound or unreadable). */
  sha256: string | null;
  mtimeMs: number;
  reason?: string;
}

export const WORKDIR_FINGERPRINT_LIMIT = 500;
export const WORKDIR_FINGERPRINT_MAX_BYTES = 256 * 1024;

/** Bounded content fingerprints (regular files only; skips .git/node_modules). */
export function fingerprintWorkdirFiles(workdir: string, limit = WORKDIR_FINGERPRINT_LIMIT): { files: WorkdirFileFingerprint[]; truncated: boolean } {
  const files: WorkdirFileFingerprint[] = [];
  let truncated = false;
  const visit = (dir: string, rel: string): void => {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      if (entry === ".git" || entry === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      const abs = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(abs, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      let sha256: string | null = null;
      let reason: string | undefined;
      try {
        if (stat.size > WORKDIR_FINGERPRINT_MAX_BYTES) {
          reason = `file larger than ${WORKDIR_FINGERPRINT_MAX_BYTES} bytes; name-only baseline`;
        } else {
          sha256 = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
        }
      } catch {
        reason = "file unreadable at baseline; name-only baseline";
      }
      const record: WorkdirFileFingerprint = { path: relPath, sha256, mtimeMs: stat.mtimeMs };
      if (reason) record.reason = reason;
      files.push(record);
    }
  };
  try {
    if (!fs.statSync(workdir).isDirectory()) return { files: [], truncated: false };
  } catch {
    return { files: [], truncated: false };
  }
  visit(workdir, "");
  return { files, truncated };
}

/**
 * Capture the launch-time baseline sufficient for attributable change
 * evidence: a bounded listing snapshot, bounded content fingerprints (so
 * edits to existing files — including files git does not track — are
 * attributable), and the git commit baseline (HEAD) where the workdir is a
 * repo (so worker commits are attributable; `git status` alone cannot show
 * committed work). Never throws.
 */
export function captureWorkdirBaseline(workdir: string): WorkdirBaseline {
  const baseline: WorkdirBaseline = {};
  try {
    baseline.snapshot = snapshotWorkdirListing(workdir);
  } catch {
    baseline.snapshot = undefined;
  }
  try {
    const fingerprinted = fingerprintWorkdirFiles(workdir);
    baseline.fingerprints = fingerprinted.files;
    if (fingerprinted.truncated) baseline.fingerprintsTruncated = true;
  } catch {
    baseline.fingerprints = undefined;
  }
  const rev = runBoundedGit(workdir, ["rev-parse", "HEAD"]);
  const head = rev.text.trim().split(/\s+/)[0] ?? "";
  if (rev.ok && /^[0-9a-f]{40}$/i.test(head)) {
    baseline.gitHead = head;
  } else {
    baseline.gitHead = null;
    baseline.gitHeadReason = "workdir is not a git repo or HEAD is unreadable (no commit baseline; commits since launch are unattributed)";
  }
  return baseline;
}

/** Bounded mtime snapshot for the post-cancel quiescence probe. */
export interface WorkdirWriteSnapshot {
  files: Record<string, number>;
  truncated: boolean;
  reason?: string;
}

/** Capture relative-path -> mtimeMs for quiescence comparison. Never throws. */
export function snapshotWorkdirMtimes(workdir: string, limit = 2000): WorkdirWriteSnapshot {
  const files: Record<string, number> = {};
  let truncated = false;
  const visit = (dir: string, rel: string): void => {
    if (Object.keys(files).length >= limit) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (Object.keys(files).length >= limit) {
        truncated = true;
        return;
      }
      if (entry === ".git" || entry === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      const abs = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(abs, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      files[relPath] = stat.mtimeMs;
    }
  };
  try {
    if (!fs.statSync(workdir).isDirectory()) {
      return { files: {}, truncated: false, reason: "workdir is not a directory; quiescence unverifiable" };
    }
  } catch {
    return { files: {}, truncated: false, reason: "workdir unreadable; quiescence unverifiable" };
  }
  visit(workdir, "");
  return { files, truncated };
}

export interface PostCancelWrites {
  /** Bounded `+ added` / `- removed` / `~ modified` entries at/after cancel-complete. */
  continued: string[];
  truncated: boolean;
  checked: boolean;
  reason?: string;
}

/**
 * Post-cancel quiescence probe: rescan the workdir and report files added,
 * removed, or modified at/after cancel completion. Any such write means the
 * worker (or an orphan of it) kept executing after cancel: quiescence fails.
 * Removal counts: deleting after cancel is continued execution too. Never
 * throws; when the workdir cannot be read the probe is explicitly unchecked
 * (fail closed: no clean-halt claim).
 */
export function findPostCancelWrites(
  workdir: string,
  before: WorkdirWriteSnapshot,
  cancelDoneAtMs: number,
  limit = 50
): PostCancelWrites {
  if (before.reason && Object.keys(before.files).length === 0) {
    return { continued: [], truncated: false, checked: false, reason: before.reason };
  }
  const after = snapshotWorkdirMtimes(workdir);
  if (after.reason && Object.keys(after.files).length === 0) {
    return { continued: [], truncated: false, checked: false, reason: after.reason };
  }
  const continued: string[] = [];
  let truncated = false;
  const push = (entry: string): void => {
    if (continued.length >= limit) {
      truncated = true;
      return;
    }
    continued.push(entry);
  };
  for (const [relPath, mtime] of Object.entries(after.files)) {
    const prior = before.files[relPath];
    if (prior === undefined) {
      if (mtime >= cancelDoneAtMs) push(`+ ${relPath} (appeared after cancel)`);
      else push(`+ ${relPath} (appeared during cancel; unattributed)`);
    } else if (mtime >= cancelDoneAtMs && mtime !== prior) {
      push(`~ ${relPath} (modified after cancel)`);
    }
  }
  for (const relPath of Object.keys(before.files)) {
    if (!(relPath in after.files)) push(`- ${relPath} (removed after cancel)`);
  }
  return { continued, truncated, checked: true };
}

/** Baseline listing for non-repo workdirs (bounded, skips .git). */
export function snapshotWorkdirListing(workdir: string, limit = 2000): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string): void => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (out.length >= limit) return;
      if (entry === ".git" || entry === "node_modules") continue;
      const relPath = rel ? `${rel}/${entry}` : entry;
      out.push(relPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(path.join(dir, entry));
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(path.join(dir, entry), relPath);
    }
  };
  try {
    if (!fs.statSync(workdir).isDirectory()) return [];
  } catch {
    return [];
  }
  visit(workdir, "");
  return out;
}

/** Diff two baseline listings (bounded). */
export function diffWorkdirSnapshots(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((entry) => !beforeSet.has(entry)).slice(0, 200);
  const removed = before.filter((entry) => !afterSet.has(entry)).slice(0, 200);
  return { added, removed };
}

function runBoundedGit(workdir: string, argv: string[]): { ok: boolean; text: string } {
  try {
    const result = spawnSync("git", argv, {
      cwd: workdir,
      timeout: 10_000,
      encoding: "utf8",
      maxBuffer: 256 * 1024
    });
    if (result.error || result.status !== 0) return { ok: false, text: "" };
    return { ok: true, text: String(result.stdout ?? "").slice(0, 8000) };
  } catch {
    return { ok: false, text: "" };
  }
}

/**
 * Changed-file/diff evidence for a run workdir. Git-aware when the workdir
 * is a repo (status --porcelain, bounded, PLUS worker commits since the
 * launch commit baseline), otherwise a filesystem snapshot diff against the
 * launch-time baseline (added/removed by name, content edits by fingerprint
 * so edits to existing files are attributed). Bounded with an explicit
 * truncation flag, and the 500-file / 256-KiB fingerprint coverage limits
 * propagate (fingerprintsTruncated, fingerprintCounts, nameOnlyCount,
 * coverageReason). The baseline accepts the legacy bare-listing shape
 * (snapshot-only) or the full launch baseline from captureWorkdirBaseline.
 * Never throws.
 */
export function collectWorkdirEvidence(workdir: string, baseline?: string[] | WorkdirBaseline): WorkdirEvidence {
  const normalized: WorkdirBaseline = Array.isArray(baseline) ? { snapshot: baseline } : (baseline ?? {});
  try {
    const status = runBoundedGit(workdir, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.ok) {
      const lines = status.text.split(/\r?\n/).filter(Boolean);
      // Bare paths (legacy shape) plus code-aware sets: `??` carries no
      // content-change information, so a baseline-existing untracked file
      // whose content changed still earns a `~` attribution line.
      const changed = lines.map((line) => line.slice(3)).filter(Boolean).slice(0, 200);
      const flaggedModified = new Set<string>();
      const flaggedUntracked = new Set<string>();
      for (const line of lines) {
        const relPath = line.slice(3);
        if (!relPath) continue;
        if (line.slice(0, 2) === "??") flaggedUntracked.add(relPath);
        else flaggedModified.add(relPath);
      }
      const evidence: WorkdirEvidence = {
        kind: "git", changed, truncated: lines.length > changed.length
      };
      const rev = runBoundedGit(workdir, ["rev-parse", "HEAD"]);
      const head = rev.text.trim().split(/\s+/)[0] ?? "";
      evidence.currentHead = rev.ok && /^[0-9a-f]{40}$/i.test(head) ? head : null;
      evidence.baselineHead = normalized.gitHead ?? null;
      if (normalized.gitHead && evidence.currentHead) {
        if (normalized.gitHead === evidence.currentHead) {
          evidence.commits = { base: normalized.gitHead, head: evidence.currentHead, newCommits: [], commitsTruncated: false };
        } else {
          const log = runBoundedGit(workdir, ["log", "--format=%h %s", `${normalized.gitHead}..HEAD`, "--max-count=50"]);
          if (log.ok) {
            const newCommits = log.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50);
            const countOut = runBoundedGit(workdir, ["rev-list", "--count", `${normalized.gitHead}..HEAD`]);
            const count = Number(countOut.text.trim());
            evidence.commits = {
              base: normalized.gitHead, head: evidence.currentHead, newCommits,
              commitsTruncated: Number.isFinite(count) ? count > newCommits.length : false
            };
          } else {
            evidence.commits = {
              base: normalized.gitHead, head: evidence.currentHead, newCommits: [],
              commitsTruncated: false,
              reason: "git log for the baseline range failed; worker commits since launch are unattributed"
            };
          }
        }
      } else {
        evidence.commits = {
          base: normalized.gitHead ?? null, head: evidence.currentHead, newCommits: [],
          commitsTruncated: false,
          reason: normalized.gitHeadReason ?? "no launch commit baseline recorded; worker commits since launch are unattributed"
        };
      }
      // Attribute content edits git status cannot show: fingerprint
      // mismatches on paths without a tracked modification. Untracked (`??`)
      // paths still earn one when the baseline knew them with different
      // content (`??` alone cannot tell new-from-baseline from edited).
      // Coverage limits propagate: the 500-file bound (baseline or current
      // truncation) and the 256-KiB name-only files (sha256 null) are
      // reported, never silently complete.
      const baselineFingerprints = normalized.fingerprints ?? [];
      let currentFingerprintResult: { files: WorkdirFileFingerprint[]; truncated: boolean } | undefined;
      if (baselineFingerprints.length > 0) {
        const before = new Map(baselineFingerprints.map((entry) => [entry.path, entry.sha256]));
        currentFingerprintResult = fingerprintWorkdirFiles(workdir);
        const current = currentFingerprintResult;
        const extra: string[] = [];
        for (const entry of current.files) {
          if (flaggedModified.has(entry.path)) continue;
          if (flaggedUntracked.has(entry.path) && !before.has(entry.path)) continue;
          if (!before.has(entry.path)) continue;
          const prior = before.get(entry.path);
          if (prior && entry.sha256 && prior !== entry.sha256) {
            extra.push(`~ ${entry.path} (content changed)`);
            if (extra.length >= 50) break;
          }
        }
        if (extra.length > 0) {
          evidence.changed = [...evidence.changed, ...extra].slice(0, 200);
        }
      }
      {
        const baselineNameOnly = baselineFingerprints.filter((entry) => entry.sha256 === null).length;
        const currentNameOnly = (currentFingerprintResult?.files ?? []).filter((entry) => entry.sha256 === null).length;
        const fingerprintsTruncated = normalized.fingerprintsTruncated === true ||
          (currentFingerprintResult?.truncated === true);
        if (baselineFingerprints.length > 0 || currentFingerprintResult !== undefined) {
          evidence.fingerprintCounts = {
            ...(baselineFingerprints.length > 0 ? { baseline: baselineFingerprints.length } : {}),
            ...(currentFingerprintResult !== undefined ? { current: currentFingerprintResult.files.length } : {})
          };
        }
        const nameOnlyCount = currentFingerprintResult !== undefined ? currentNameOnly : baselineNameOnly;
        if (nameOnlyCount > 0) evidence.nameOnlyCount = nameOnlyCount;
        if (fingerprintsTruncated) evidence.fingerprintsTruncated = true;
        if (fingerprintsTruncated || nameOnlyCount > 0) {
          const parts: string[] = [];
          if (fingerprintsTruncated) {
            parts.push(`content fingerprints hit the ${WORKDIR_FINGERPRINT_LIMIT}-file bound (files beyond the bound are unattributed by content)`);
          }
          if (nameOnlyCount > 0) {
            parts.push(`${nameOnlyCount} file(s) carried name-only (SHA-256 skipped: larger than the 256-KiB hash bound or unreadable; content edits to these files are unattributed)`);
          }
          evidence.coverageReason = parts.join("; ");
        }
      }
      return evidence;
    }
    const after = snapshotWorkdirListing(workdir);
    if (!normalized.snapshot && !normalized.fingerprints) return { kind: "unavailable", changed: [], truncated: false, reason: "workdir is not a git repo and no launch baseline was recorded" };
    const { added, removed } = diffWorkdirSnapshots(normalized.snapshot ?? [], after);
    const changed = [...added.map((entry) => `+ ${entry}`), ...removed.map((entry) => `- ${entry}`)].slice(0, 200);
    const snapshotEvidence: WorkdirEvidence = { kind: "snapshot", changed, truncated: changed.length >= 200 };
    const snapshotBaselineFingerprints = normalized.fingerprints ?? [];
    if (snapshotBaselineFingerprints.length > 0) {
      const before = new Map(snapshotBaselineFingerprints.map((entry) => [entry.path, entry.sha256]));
      const current = fingerprintWorkdirFiles(workdir);
      for (const entry of current.files) {
        if (changed.length >= 200) break;
        if (!before.has(entry.path)) continue;
        const prior = before.get(entry.path);
        if (prior && entry.sha256 && prior !== entry.sha256) {
          changed.push(`~ ${entry.path} (content changed)`);
        }
      }
      snapshotEvidence.changed = changed;
      const currentNameOnly = current.files.filter((entry) => entry.sha256 === null).length;
      const fingerprintsTruncated = normalized.fingerprintsTruncated === true || current.truncated === true;
      snapshotEvidence.fingerprintCounts = { baseline: snapshotBaselineFingerprints.length, current: current.files.length };
      if (currentNameOnly > 0) snapshotEvidence.nameOnlyCount = currentNameOnly;
      if (fingerprintsTruncated) snapshotEvidence.fingerprintsTruncated = true;
      if (fingerprintsTruncated || currentNameOnly > 0) {
        const parts: string[] = [];
        if (fingerprintsTruncated) {
          parts.push(`content fingerprints hit the ${WORKDIR_FINGERPRINT_LIMIT}-file bound (files beyond the bound are unattributed by content)`);
        }
        if (currentNameOnly > 0) {
          parts.push(`${currentNameOnly} file(s) carried name-only (SHA-256 skipped: larger than the 256-KiB hash bound or unreadable; content edits to these files are unattributed)`);
        }
        snapshotEvidence.coverageReason = parts.join("; ");
      }
      return snapshotEvidence;
    }
    if (normalized.fingerprintsTruncated === true) {
      snapshotEvidence.fingerprintsTruncated = true;
      snapshotEvidence.coverageReason = `launch baseline content fingerprints hit the ${WORKDIR_FINGERPRINT_LIMIT}-file bound (files beyond the bound are unattributed by content)`;
    }
    return snapshotEvidence;
  } catch (error) {
    return { kind: "unavailable", changed: [], truncated: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
