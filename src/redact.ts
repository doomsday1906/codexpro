// The launcher is source-distributed alongside the compiled TypeScript. Keep
// one policy implementation so source and diagnostic routes cannot drift.
// @ts-ignore -- scripts/redaction-policy.mjs is intentionally plain ESM.
import * as policy from "../scripts/redaction-policy.mjs";

const {
  hasSecretValue: policyHasSecretValue,
  redactDiagnosticText: policyRedactDiagnosticText,
  redactSearchQuery: policyRedactSearchQuery,
  redactSensitiveText: policyRedactSensitiveText,
  redactSensitiveTextPreservingLines: policyRedactSensitiveTextPreservingLines,
  truncateUtf8: policyTruncateUtf8
} = policy;

export type RedactionContext = "source" | "diagnostic";

export function hasSecretValue(text: string, options: { context?: RedactionContext } | RedactionContext = {}): boolean {
  return policyHasSecretValue(text, options);
}

export function redactSensitiveText(text: string, options: { context?: RedactionContext } | RedactionContext = {}): string {
  return policyRedactSensitiveText(text, options);
}

export function redactSensitiveTextPreservingLines(text: string, options: { context?: RedactionContext } | RedactionContext = {}): string {
  return policyRedactSensitiveTextPreservingLines(text, options);
}

export function redactDiagnosticText(text: string): string {
  return policyRedactDiagnosticText(text);
}

export function redactSearchQuery(query: string, safeMatchTexts: string[] = []): string {
  return policyRedactSearchQuery(query, safeMatchTexts);
}

type RedactStructuredOptions = { context?: RedactionContext };

export function redactStructured<T>(value: T, optionsOrDepth: RedactStructuredOptions | number = {}, depth = 0): T {
  const context = typeof optionsOrDepth === "number" ? "source" : optionsOrDepth.context ?? "source";
  const currentDepth = typeof optionsOrDepth === "number" ? optionsOrDepth : depth;
  if (currentDepth > 8) return value;
  if (typeof value === "string") return redactSensitiveText(value, { context }) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, { context }, currentDepth + 1)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactStructured(item, { context }, currentDepth + 1);
  }
  return out as T;
}

export function redactDiagnosticStructured<T>(value: T): T {
  return redactStructured(value, { context: "diagnostic" });
}

export function truncateUtf8(text: string, maxBytes: number, suffix = ""): string {
  return policyTruncateUtf8(text, maxBytes, suffix);
}
