// The launcher is source-distributed alongside the compiled TypeScript. Keep
// one policy implementation so source and diagnostic routes cannot drift.
// @ts-ignore -- scripts/redaction-policy.mjs is intentionally plain ESM.
import * as policy from "../scripts/redaction-policy.mjs";

const {
  hasSecretValue: policyHasSecretValue,
  hasSecretValueInUnifiedDiff: policyHasSecretValueInUnifiedDiff,
  redactDiagnosticText: policyRedactDiagnosticText,
  redactSearchQuery: policyRedactSearchQuery,
  redactSensitiveText: policyRedactSensitiveText,
  redactSensitiveTextPreservingLines: policyRedactSensitiveTextPreservingLines,
  redactUnifiedDiff: policyRedactUnifiedDiff,
  sourceLanguageForPath: policySourceLanguageForPath,
  truncateUtf8: policyTruncateUtf8
} = policy;

export type RedactionContext = "source" | "diagnostic";
export type SourceLanguage = "python";
export type RedactionOptions = { context?: RedactionContext; language?: SourceLanguage };

export function sourceLanguageForPath(filePath: string): SourceLanguage | undefined {
  return policySourceLanguageForPath(filePath);
}

export function hasSecretValue(text: string, options: RedactionOptions | RedactionContext = {}): boolean {
  return policyHasSecretValue(text, options);
}

export function hasSecretValueInUnifiedDiff(
  text: string,
  languageForPath?: (path: string | undefined) => SourceLanguage | undefined
): boolean {
  return policyHasSecretValueInUnifiedDiff(text, { languageForPath });
}

export function redactSensitiveText(text: string, options: RedactionOptions | RedactionContext = {}): string {
  return policyRedactSensitiveText(text, options);
}

export function redactSensitiveTextPreservingLines(text: string, options: RedactionOptions | RedactionContext = {}): string {
  return policyRedactSensitiveTextPreservingLines(text, options);
}

export function redactUnifiedDiff(
  text: string,
  languageForPath?: (path: string | undefined) => SourceLanguage | undefined
): string {
  return policyRedactUnifiedDiff(text, { languageForPath });
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
