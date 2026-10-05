import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { redactDiagnosticText, truncateUtf8 } from "./redact.js";

/**
 * Tool-call diagnostics. One line per call on stderr when
 * CODEXPRO_LOG_TOOL_CALLS=1 or CODEXPRO_LOG_REQUESTS=1; calls slower than
 * CODEXPRO_LOG_SLOW_MS (default 10000, 0 disables) are always logged. With
 * CODEXPRO_LOG_FILE set, every logged call is also appended there as JSON.
 *
 * Lines carry timings, bounded counts and an allowlisted argument summary.
 * Free-text arguments (queries, file contents, patches, commands) are
 * reduced to their length. Error text is limited to its redacted, truncated
 * first line.
 */

type FactValue = string | number | boolean;

interface ToolTrace {
  phases: Array<[string, number]>;
  facts: Record<string, FactValue>;
}

const traces = new AsyncLocalStorage<ToolTrace>();
let inFlight = 0;

const MAX_PHASES = 32;
const MAX_FACTS = 32;
const MAX_ARG_VALUE_BYTES = 160;
const MAX_ERROR_BYTES = 400;

// Scalar arguments that identify scope or mode and are safe to log verbatim
// (after diagnostic redaction and truncation).
const LOGGED_ARG_KEYS = new Set([
  "action",
  "workspace_id",
  "path",
  "root",
  "glob",
  "intent",
  "regex",
  "include_hidden",
  "includeHidden",
  "include_tests",
  "includeTests",
  "max_results",
  "maxResults",
  "engine",
  "mode",
  "depth",
  "max_depth",
  "limit",
  "offset",
  "start_line",
  "end_line"
]);

// Free-text arguments summarized by length only.
const LENGTH_ONLY_ARG_KEYS = new Set(["query", "symbol", "pattern", "content", "patch", "command", "prompt", "text", "message"]);

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

export function toolCallLoggingEnabled(): boolean {
  return envFlag("CODEXPRO_LOG_TOOL_CALLS") || envFlag("CODEXPRO_LOG_REQUESTS");
}

function slowThresholdMs(): number {
  const raw = process.env.CODEXPRO_LOG_SLOW_MS;
  if (raw === undefined || raw.trim() === "") return 10_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
}

/** Time one named phase of the current tool call (no-op outside a call). */
export async function tracePhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const trace = traces.getStore();
  if (!trace) return fn();
  const started = Date.now();
  try {
    return await fn();
  } finally {
    if (trace.phases.length < MAX_PHASES) trace.phases.push([name, Date.now() - started]);
  }
}

/** Record a bounded scalar fact (count, cache state) for the current call. */
export function traceFact(key: string, value: FactValue): void {
  const trace = traces.getStore();
  if (!trace) return;
  if (key in trace.facts || Object.keys(trace.facts).length < MAX_FACTS) trace.facts[key] = value;
}

function summarizeValue(value: unknown): FactValue | undefined {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return truncateUtf8(redactDiagnosticText(value), MAX_ARG_VALUE_BYTES, "…");
  return undefined;
}

export function summarizeToolArgs(args: unknown): Record<string, FactValue> {
  const summary: Record<string, FactValue> = {};
  if (!args || typeof args !== "object") return summary;
  const visit = (record: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(record)) {
      if (Object.keys(summary).length >= MAX_FACTS) return;
      if (key === "args" && prefix === "" && value && typeof value === "object" && !Array.isArray(value)) {
        visit(value as Record<string, unknown>, "args.");
      } else if (LENGTH_ONLY_ARG_KEYS.has(key)) {
        if (typeof value === "string") summary[`${prefix}${key}_len`] = value.length;
      } else if (LOGGED_ARG_KEYS.has(key)) {
        const summarized = summarizeValue(value);
        if (summarized !== undefined) summary[`${prefix}${key}`] = summarized;
      } else if (Array.isArray(value)) {
        summary[`${prefix}${key}_count`] = value.length;
      }
    }
  };
  visit(args as Record<string, unknown>, "");
  return summary;
}

function formatPairs(record: Record<string, FactValue>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`)
    .join(" ");
}

function errorText(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (raw === undefined) return undefined;
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  return truncateUtf8(redactDiagnosticText(firstLine), MAX_ERROR_BYTES, "…");
}

function appendLogFile(entry: Record<string, unknown>): void {
  const file = process.env.CODEXPRO_LOG_FILE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics must never fail the tool call.
  }
}

/**
 * Run one tool call under a trace and log it when logging is enabled or the
 * call is slow. `statusOf` classifies the handler's result.
 */
export async function runLoggedToolCall<T>(
  name: string,
  args: unknown,
  run: () => Promise<T>,
  statusOf: (result: T) => { status: "ok" | "error"; error?: unknown }
): Promise<T> {
  const started = Date.now();
  const concurrent = inFlight;
  inFlight += 1;
  const trace: ToolTrace = { phases: [], facts: {} };
  let outcome: { status: "ok" | "error"; error?: unknown } = { status: "error" };
  try {
    const result = await traces.run(trace, run);
    outcome = statusOf(result);
    return result;
  } catch (error) {
    outcome = { status: "error", error };
    throw error;
  } finally {
    inFlight -= 1;
    emit(name, args, started, concurrent, trace, outcome);
  }
}

function emit(
  name: string,
  args: unknown,
  started: number,
  concurrent: number,
  trace: ToolTrace,
  outcome: { status: "ok" | "error"; error?: unknown }
): void {
  try {
    const ms = Date.now() - started;
    const slowMs = slowThresholdMs();
    const slow = slowMs > 0 && ms >= slowMs;
    if (!toolCallLoggingEnabled() && !slow) return;
    const argSummary = summarizeToolArgs(args);
    const error = outcome.status === "error" ? errorText(outcome.error) : undefined;
    const parts = [`[CodexProTool] ${name} ${outcome.status} ${ms}ms`];
    if (slow) parts.push("SLOW");
    if (concurrent > 0) parts.push(`concurrent=${concurrent}`);
    if (Object.keys(argSummary).length) parts.push(`args{${formatPairs(argSummary)}}`);
    if (trace.phases.length) parts.push(`phases{${trace.phases.map(([phase, phaseMs]) => `${phase}=${phaseMs}ms`).join(" ")}}`);
    if (Object.keys(trace.facts).length) parts.push(`facts{${formatPairs(trace.facts)}}`);
    if (error) parts.push(`error=${JSON.stringify(error)}`);
    console.error(parts.join(" "));
    appendLogFile({
      t: new Date(started).toISOString(),
      tool: name,
      status: outcome.status,
      ms,
      slow,
      concurrent,
      args: argSummary,
      phases: Object.fromEntries(trace.phases),
      facts: trace.facts,
      ...(error ? { error } : {})
    });
  } catch {
    // Diagnostics must never fail the tool call.
  }
}
