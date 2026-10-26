// The launcher is source-distributed alongside the compiled TypeScript. Keep
// one policy implementation so source and diagnostic routes cannot drift.
// @ts-ignore -- scripts/redaction-policy.mjs is intentionally plain ESM.
import * as policy from "../scripts/redaction-policy.mjs";
import { createHash } from "node:crypto";

const {
  hasSecretValue: policyHasSecretValue,
  scanSecretValues: policyScanSecretValues,
  hasSecretValueInUnifiedDiff: policyHasSecretValueInUnifiedDiff,
  redactDiagnosticText: policyRedactDiagnosticText,
  redactSearchQuery: policyRedactSearchQuery,
  redactSensitiveText: policyRedactSensitiveText,
  redactSensitiveTextPreservingLines: policyRedactSensitiveTextPreservingLines,
  redactUnifiedDiff: policyRedactUnifiedDiff,
  extractDiffFileBlocks: policyExtractDiffFileBlocks,
  sourceLanguageForPath: policySourceLanguageForPath,
  truncateUtf8: policyTruncateUtf8,
  createPrivateKeyScanner: policyCreatePrivateKeyScanner
} = policy;

export interface SecretScanResult {
  readonly spans: readonly { readonly start: number; readonly end: number }[];
  readonly complete: boolean;
}

export interface PrivateKeyScanner {
  push(input?: string, final?: boolean): string;
  spans(): readonly { readonly start: number; readonly end: number }[];
  reset(): void;
}

export function createPrivateKeyScanner(): PrivateKeyScanner {
  return policyCreatePrivateKeyScanner();
}

export type RedactionContext = "source" | "diagnostic";
export type SourceLanguage = "python";
export type RedactionOptions = { context?: RedactionContext; language?: SourceLanguage; sourcePath?: string };

export type DiffFileBlock = {
  readonly source: string;
  readonly start: number;
  readonly end: number;
  readonly ambiguous: boolean;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly oldValid: boolean;
  readonly newValid: boolean;
  readonly oldKnown: boolean;
  readonly newKnown: boolean;
  readonly oldPresent: boolean;
  readonly newPresent: boolean;
  readonly pathDiscoveryValid: boolean;
  readonly paths: readonly string[];
};

export function extractDiffFileBlocks(text: string): readonly DiffFileBlock[] {
  return policyExtractDiffFileBlocks(text) as readonly DiffFileBlock[];
}

export function sourceLanguageForPath(filePath: string | undefined): SourceLanguage | undefined {
  return policySourceLanguageForPath(filePath);
}

export function hasSecretValue(text: string, options: RedactionOptions | RedactionContext = {}): boolean {
  return policyHasSecretValue(text, options);
}

export function scanSecretValues(text: string, options: RedactionOptions | RedactionContext = {}): SecretScanResult {
  return policyScanSecretValues(text, options) as SecretScanResult;
}

export function hasSecretValueInUnifiedDiff(
  text: string,
  languageForPath?: (path: string | undefined) => SourceLanguage | undefined,
  sourcePathForPath?: (path: string | undefined) => string | undefined
): boolean {
  return policyHasSecretValueInUnifiedDiff(text, { languageForPath, sourcePathForPath });
}

export function redactSensitiveText(text: string, options: RedactionOptions | RedactionContext = {}): string {
  return policyRedactSensitiveText(text, options);
}

export interface JsonTextRedactionResult {
  readonly text: string;
  readonly changed: boolean;
  readonly omittedNestedValues: boolean;
}

function normalizedFieldName(key: string): string {
  return key.replace(/[^a-z\d]/giu, "").toLowerCase();
}

function isCredentialFieldName(key: string): boolean {
  const normalized = normalizedFieldName(key);
  return normalized.includes("authorization") || normalized.includes("secret") ||
    normalized.includes("password") || normalized.includes("passwd") ||
    normalized.includes("privatekey") || normalized.includes("apikey") ||
    normalized.includes("accesskey") || normalized.includes("passphrase") ||
    normalized.includes("passcode") || normalized.includes("pwd") || normalized === "pass" ||
    normalized.includes("jwt") || normalized.includes("mfa") ||
    normalized.includes("credential") || normalized.includes("bearer") ||
    normalized.includes("token") || normalized.includes("cookie") ||
    normalized.includes("session") ||
    normalized.includes("signature") || normalized.includes("otp") ||
    (normalized.startsWith("auth") && !normalized.startsWith("author")) || normalized.endsWith("auth");
}

function isNumericUsageMetric(key: string, value: unknown): boolean {
  return typeof value === "number" && /^(?:tokens|tokencount)$/u.test(normalizedFieldName(key));
}

function jsonValueEnd(text: string, start: number): number {
  while (/\s/u.test(text[start] ?? "")) start += 1;
  const first = text[start];
  if (first === '"' || first === "'") {
    for (let index = start + 1; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === first) return index + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    const stack = [first === "{" ? "}" : "]"];
    let inString = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (char === "\\") index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") stack.push("}");
      else if (char === "[") stack.push("]");
      else if (char === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) return index + 1;
      }
    }
    return text.length;
  }
  let end = start;
  while (end < text.length && !/[,}\]\r\n]/u.test(text[end])) end += 1;
  return end;
}

function redactCredentialFieldsInText(text: string): string {
  const field = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([A-Za-z_$][A-Za-z\d_$-]*))\s*:/gu;
  const replacements: { start: number; end: number }[] = [];
  let coveredUntil = 0;
  for (let match = field.exec(text); match; match = field.exec(text)) {
    if (match.index < coveredUntil) continue;
    let key = match[1] ?? match[2] ?? match[3] ?? "";
    if (match[1] !== undefined) try { key = JSON.parse(`"${key}"`); } catch {}
    if (!isCredentialFieldName(key)) continue;
    const valueStart = field.lastIndex;
    const valueEnd = jsonValueEnd(text, valueStart);
    const rawValue = text.slice(valueStart, valueEnd).trim();
    const metric = /^(?:tokens|tokencount)$/u.test(normalizedFieldName(key)) &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(rawValue);
    if (metric) continue;
    replacements.push({ start: valueStart, end: valueEnd });
    coveredUntil = Math.max(valueEnd, valueStart);
  }
  if (replacements.length === 0) return text;
  let result = text;
  for (const span of replacements.reverse()) {
    result = `${result.slice(0, span.start)}"[REDACTED_SECRET]"${result.slice(span.end)}`;
  }
  return result;
}

function redactDiagnosticPreservingMetrics(text: string): string {
  const metrics: { field: string; placeholder: string }[] = [];
  const metricField = /(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([A-Za-z_$][A-Za-z\d_$-]*))\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/gu;
  const protectedText = text.replace(metricField, (field, doubleKey: string | undefined, singleKey: string | undefined, bareKey: string | undefined) => {
    let key = doubleKey ?? singleKey ?? bareKey ?? "";
    if (doubleKey !== undefined) try { key = JSON.parse(`"${key}"`); } catch {}
    if (!/^(?:tokens|tokencount)$/u.test(normalizedFieldName(key))) return field;
    let placeholder = `__AW_NUMERIC_USAGE_${metrics.length}__`;
    while (text.includes(placeholder)) placeholder += "_";
    metrics.push({ field, placeholder });
    return placeholder;
  });
  const safe = policyRedactDiagnosticText(redactCredentialFieldsInText(protectedText));
  const restored = metrics.reduce((value, metric) => value.replace(metric.placeholder, metric.field), safe);
  return restored.replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9._~+/-]+=*)/giu, "Bearer [REDACTED_SECRET]");
}

/** Redact a complete JSON value without turning its replacement into invalid JSON. */
export function redactJsonText(text: string, options: RedactionOptions | RedactionContext = {}): JsonTextRedactionResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  let changed = false;
  let omittedNestedValues = false;
  const redactValue = (value: unknown, depth: number): unknown => {
    if (depth > 8) {
      changed = true;
      omittedNestedValues = true;
      return "[REDACTED_SECRET]";
    }
    if (typeof value === "string") {
      const safe = redactSensitiveText(value, options).replace(/\bBearer\s+(?:"[^"]*"|'[^']*'|[A-Za-z0-9._~+/-]+=*)/giu, "Bearer [REDACTED_SECRET]");
      if (safe !== value) changed = true;
      return safe;
    }
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
    if (value && typeof value === "object") {
      const output: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        const safeKey = redactSensitiveText(key, options);
        const secretKey = safeKey !== key;
        const tokenMetric = isNumericUsageMetric(key, item);
        const secretField = isCredentialFieldName(key) && !tokenMetric;
        const outputKey = secretKey ? "[REDACTED_SECRET]" : key;
        let uniqueKey = outputKey;
        for (let suffix = 2; Object.hasOwn(output, uniqueKey); suffix += 1) {
          uniqueKey = `${outputKey}_${suffix}`;
        }
        if (secretKey) changed = true;
        if (secretField) {
          changed = true;
          output[uniqueKey] = "[REDACTED_SECRET]";
        } else {
          output[uniqueKey] = redactValue(item, depth + 1);
        }
      }
      return output;
    }
    return value;
  };

  const safeText = JSON.stringify(redactValue(parsed, 0));
  return { text: safeText, changed: changed || safeText !== text, omittedNestedValues };
}

// Line-preserving source redaction is a pure function of (text, options) and
// the dominant cost of search/analysis: every query re-redacted the same
// unchanged files during scanning and hydration. Results for non-trivial
// texts are memoized by content digest, bounded by retained bytes.
// Only option shapes whose output is a pure function of (text, context,
// language) are memoized: a sourcePath pulls live approval-registry state,
// and the remaining policy options are caller-supplied overrides.
const REDACTION_MEMO_MIN_CHARS = 1024;
const REDACTION_MEMO_MAX_CHARS = 64 * 1024 * 1024;
const redactionMemo = new Map<string, string>();
let redactionMemoChars = 0;

function redactionMemoKey(text: string, options: RedactionOptions | RedactionContext): string | undefined {
  if (typeof options === "string") return `${options}\0\0${createHash("sha256").update(text).digest("hex")}`;
  if (!options || typeof options !== "object") return undefined;
  for (const key of Object.keys(options)) {
    if (key !== "context" && key !== "language") return undefined;
  }
  return `${options.context ?? ""}\0${options.language ?? ""}\0${createHash("sha256").update(text).digest("hex")}`;
}

export function redactSensitiveTextPreservingLines(text: string, options: RedactionOptions | RedactionContext = {}): string {
  if (typeof text !== "string" || text.length < REDACTION_MEMO_MIN_CHARS || text.length > REDACTION_MEMO_MAX_CHARS / 4) {
    return policyRedactSensitiveTextPreservingLines(text, options);
  }
  const key = redactionMemoKey(text, options);
  if (key === undefined) return policyRedactSensitiveTextPreservingLines(text, options);
  const cached = redactionMemo.get(key);
  if (cached !== undefined) {
    redactionMemo.delete(key);
    redactionMemo.set(key, cached);
    return cached;
  }
  const redacted: string = policyRedactSensitiveTextPreservingLines(text, options);
  redactionMemo.set(key, redacted);
  redactionMemoChars += redacted.length;
  for (const [oldKey, oldValue] of redactionMemo) {
    if (redactionMemoChars <= REDACTION_MEMO_MAX_CHARS) break;
    redactionMemo.delete(oldKey);
    redactionMemoChars -= oldValue.length;
  }
  return redacted;
}

/** Describe a blocked source candidate without echoing matched content. */
export function sourceSafetyRefusalMessage(
  operation: "write" | "edit" | "apply_patch",
  filePath: string,
  source: string,
  redacted: string,
  coordinate: "source line" | "patch line" = "source line"
): string {
  const sourceLines = String(source ?? "").split(/\r\n|\n|\r/u);
  const redactedLines = String(redacted ?? "").split(/\r\n|\n|\r/u);
  const lineNumbers: number[] = [];
  if (sourceLines.length === redactedLines.length) {
    for (let index = 0; index < sourceLines.length; index += 1) {
      if (sourceLines[index] !== redactedLines[index]) lineNumbers.push(index + 1);
    }
  }

  const shownLines = lineNumbers.slice(0, 12).join(", ");
  const overflow = lineNumbers.length > 12 ? `, +${lineNumbers.length - 12} more` : "";
  const location = lineNumbers.length > 0
    ? `${coordinate}(s) ${shownLines}${overflow}`
    : `${coordinate}(s) unavailable (line-preserving evidence unavailable)`;
  // The diagnostic stays generic on purpose: the detector reports only a
  // boolean, never a rule name, so no rule identity is claimed here. Only the
  // sanitized path and bounded physical line numbers are disclosed; matched
  // content is never echoed.
  const safePath = redactDiagnosticText(String(filePath ?? ""))
    .replace(/[\r\n]/gu, " ")
    .slice(0, 512) || "<unknown>";
  return `Secret-looking content is blocked from ${operation}. Use placeholders such as [REDACTED_SECRET] in handoff files. Path ${safePath}; ${location}; matched content omitted.`;
}
export function redactUnifiedDiff(
  text: string,
  languageForPath?: (path: string | undefined) => SourceLanguage | undefined,
  sourcePathForPath?: (path: string | undefined) => string | undefined
): string {
  return policyRedactUnifiedDiff(text, { languageForPath, sourcePathForPath });
}

/** Redact a unified diff while preserving hunk line cardinality. */
export function redactUnifiedDiffPreservingLines(
  text: string,
  languageForPath?: (path: string | undefined) => SourceLanguage | undefined
): string {
  const blocks = extractDiffFileBlocks(text);
  return blocks.map((block) => {
    const oldLanguage = block.oldPresent && block.pathDiscoveryValid
      ? languageForPath?.(block.oldPath)
      : undefined;
    const newLanguage = block.newPresent && block.pathDiscoveryValid
      ? languageForPath?.(block.newPath)
      : undefined;
    return policyRedactSensitiveTextPreservingLines(block.source, {
      context: "source",
      oldLanguage,
      newLanguage
    });
  }).join("");
}

export function redactDiagnosticText(text: string): string {
  const json = redactJsonText(text, "diagnostic");
  if (json) return json.text;
  return redactDiagnosticPreservingMetrics(text);
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
