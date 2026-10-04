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

/** Build the OpenCode canary argv (opencode run route; no Codex flags). */
export function buildOpenCodeCanaryArgv(model: string, prompt: string, sessionId?: string): string[] {
  if (sessionId) {
    return ["run", "--session", sessionId, "--model", model, "--format", "json", prompt];
  }
  return ["run", "--model", model, "--format", "json", prompt];
}

/**
 * Build the OpenCode resume argv. `--session <id>` continues the session
 * when the id is known, otherwise it CREATES a new session under that id
 * (installed CLI semantics): first use of a minted id is creation, later
 * uses are true resume. Callers must say which one it is.
 */
export function buildOpenCodeResumeArgv(sessionId: string, model: string, prompt: string): string[] {
  return ["run", "--session", sessionId, "--model", model, "--format", "json", prompt];
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
  route: "opencode run --session <session-id> --model <model> --format json <prompt>",
  sessionSubcommands: ["list", "delete", "export", "import"],
  noNativeResumeSubcommand: true,
  createsIfMissing: true,
  note: "--session continues the session when the id is known, otherwise creates it; first use of a minted id is creation, later uses are true resume. One active turn per session id is enforced."
} as const;

export function newOpenCodeSessionId(): string {
  return `ses_${createHash("sha256").update(`${Date.now()}:${process.pid}:${Math.random()}`).digest("hex").slice(0, 16)}`;
}

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
    : "Stay within the original task's scope: create, modify, or delete no file unless the original task explicitly authorized it.";
  const prefix = `Follow-up continuation (attempt ${input.attemptN}) for input request ${input.requestId}.`;
  const questionsFull = questionLines.length > 0 ? questionLines.join(" | ") : "(none listed)";
  // Budget questions separately so a pathological question list cannot push
  // the answer out: cap questions at 4 KiB (multibyte-safe), base gets the rest.
  const MAX_QUESTIONS_BYTES = 4_096;
  let questionsText = truncateUtf8(questionsFull, MAX_QUESTIONS_BYTES, "...[questions truncated]");
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
 * NOTE: async with real sleeps (never a blocking busy-wait): the event loop
 * must turn so the kernel reaps our signalled children; otherwise they linger
 * as same-identity zombies and every liveness check lies. Timeout paths use
 * the non-blocking signalOwnedTree instead and finalize on close/settle.
 */
export async function cancelOwnedTree(rootPid: number, rootStartTime: string | undefined, graceMs = 2000): Promise<CancelTreeResult> {
  const discovered = collectOwnedTree(rootPid, rootStartTime);
  if (discovered.staleRoot) {
    return { signalled: [], remaining: [], cleanupFinished: true, staleRoot: true };
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
  return { signalled, remaining, cleanupFinished: remaining.length === 0, staleRoot: false };
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
