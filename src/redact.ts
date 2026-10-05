// The launcher is source-distributed alongside the compiled TypeScript. Keep
// one policy implementation so source and diagnostic routes cannot drift.
// @ts-ignore -- scripts/redaction-policy.mjs is intentionally plain ESM.
import * as policy from "../scripts/redaction-policy.mjs";
import { createHash } from "node:crypto";

const {
  hasSecretValue: policyHasSecretValue,
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
