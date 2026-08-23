// The launcher is source-distributed alongside the compiled TypeScript. Keep
// one policy implementation so source and diagnostic routes cannot drift.
// @ts-ignore -- scripts/redaction-policy.mjs is intentionally plain ESM.
import * as policy from "../scripts/redaction-policy.mjs";

const {
  hasSecretValue: policyHasSecretValue,
  redactDiagnosticText: policyRedactDiagnosticText,
  redactSensitiveText: policyRedactSensitiveText,
  truncateUtf8: policyTruncateUtf8
} = policy;

export type RedactionContext = "source" | "diagnostic";

export function hasSecretValue(text: string, options: { context?: RedactionContext } | RedactionContext = {}): boolean {
  return policyHasSecretValue(text, options);
}

export function redactSensitiveText(text: string, options: { context?: RedactionContext } | RedactionContext = {}): string {
  return policyRedactSensitiveText(text, options);
}

export function redactDiagnosticText(text: string): string {
  return policyRedactDiagnosticText(text);
}

export function truncateUtf8(text: string, maxBytes: number, suffix = ""): string {
  return policyTruncateUtf8(text, maxBytes, suffix);
}

export function redactStructured<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactStructured(item, depth + 1);
  }
  return out as T;
}
