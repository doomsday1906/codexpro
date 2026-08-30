import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitReadOnly } from "./gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { validateHistoricalPath } from "./historicalPath.js";
import { GitRefResolutionError, resolveGitRef, type GitObjectFormat, type GitReviewRef } from "./gitReviewRef.js";
import { extractDiffFileBlocks, redactUnifiedDiff, sourceLanguageForPath } from "./redact.js";

/** Configuration consumed by the machine-safe historical metadata operation. */
export type GitDiffRangeConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes"> &
  Partial<Pick<CodexProConfig, "maxReadBytes">> & {
    /** Optional operation-local capture ceiling used by focused callers/tests. */
    readonly maxMetadataBytes?: number;
    /** Optional operation-local patch-fragment capture ceiling used by focused callers/tests. */
    readonly maxPatchFragmentBytes?: number;
  };

export type GitDiffRangeStatus = "A" | "C" | "D" | "M" | "R" | "T" | "U" | "X" | "B";

export type GitDiffRangeFailureReason =
  | "invalid-input"
  | "invalid-limit"
  | "object-format-mismatch"
  | "metadata-overflow"
  | "timeout"
  | "missing-object"
  | "execution"
  | "malformed-name-status"
  | "malformed-numstat"
  | "metadata-mismatch"
  | "path-encoding"
  | "numeric-overflow"
  | "patch-timeout"
  | "patch-missing-object"
  | "patch-execution"
  | "patch-encoding"
  | "patch-fragment-mismatch"
  | "patch-fragment-malformed";

const FAILURE_MESSAGES: Record<GitDiffRangeFailureReason, string> = {
  "invalid-input": "Historical Git diff range input is invalid.",
  "invalid-limit": "Historical Git diff range limit is invalid.",
  "object-format-mismatch": "Historical Git diff range refs use different object formats.",
  "metadata-overflow": "Historical Git diff metadata exceeded its bounded capture limit.",
  timeout: "Historical Git diff metadata timed out.",
  "missing-object": "Historical Git diff range object is unavailable locally.",
  execution: "Historical Git diff metadata execution failed.",
  "malformed-name-status": "Git returned malformed name-status metadata.",
  "malformed-numstat": "Git returned malformed numstat metadata.",
  "metadata-mismatch": "Git changed-file metadata streams did not correlate.",
  "path-encoding": "Git returned a path that is not valid UTF-8.",
  "numeric-overflow": "Git returned a numstat value outside the safe bounded range.",
  "patch-timeout": "Historical Git diff patch acquisition timed out.",
  "patch-missing-object": "Historical Git diff patch object is unavailable locally.",
  "patch-execution": "Historical Git diff patch acquisition failed during Git execution.",
  "patch-encoding": "Git returned patch bytes that are not valid UTF-8.",
  "patch-fragment-mismatch": "Git patch output did not identify the requested changed-file record.",
  "patch-fragment-malformed": "Git returned a malformed historical patch fragment."
};

/**
 * Constant-message, JSON-safe failure for the historical metadata operation.
 * Caller refs, paths, Git diagnostics, and raw producer bytes are never kept
 * on this error. Facts contain only bounded numeric context.
 */
export class GitDiffRangeError extends CodexProError {
  readonly reason: GitDiffRangeFailureReason;
  readonly facts: Readonly<Record<string, number>>;

  constructor(reason: GitDiffRangeFailureReason, facts: Readonly<Record<string, number>> = {}) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitDiffRangeError";
    this.reason = reason;
    this.facts = { ...facts };
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      reason: this.reason,
      facts: this.facts
    };
  }
}

// Operation-oriented alias for consumers that distinguish the metadata
// parser from the later public git_diff_range orchestration.
export { GitDiffRangeError as GitDiffMetadataError };

export interface GitDiffRangeIdentity {
  readonly base: GitReviewRef;
  readonly head: GitReviewRef;
  readonly objectFormat: GitObjectFormat;
  readonly path?: string;
}

export interface GitDiffRangeIdentityOptions {
  readonly baseRef: string;
  readonly headRef: string;
  readonly path?: unknown;
}

export interface GitChangedFileMetadata {
  readonly status: GitDiffRangeStatus;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly similarity: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface GitDiffRangeMetadataOptions extends GitDiffRangeIdentityOptions {
  /** Public returned metadata prefix. Defaults to 100 and is bounded at 200. */
  readonly maxFiles?: number;
  /** Internal complete-producer capture ceiling. */
  readonly metadataMaxBytes?: number;
}

export interface GitDiffRangeMetadataResult {
  readonly identity: GitDiffRangeIdentity;
  /** Complete eligible records, retained for downstream patch orchestration. */
  readonly eligibleChangedFiles: readonly GitChangedFileMetadata[];
  /** Public bounded prefix of eligibleChangedFiles. */
  readonly changedFiles: readonly GitChangedFileMetadata[];
  readonly changedFileCount: number;
  readonly eligibleChangedFileCount: number;
  readonly returnedFileCount: number;
  readonly changedFilesTruncated: boolean;
  readonly blockedFilesOmitted: number;
  readonly renameCopyDetectionComplete: boolean;
  readonly warnings: readonly string[];
}

export interface GitDiffRangePatchOptions extends GitDiffRangeMetadataOptions {
  /** Request patch acquisition. Defaults to true. */
  readonly includePatch?: unknown;
  /** Public UTF-8 patch budget. Defaults to 60,000 and is bounded at 100,000. */
  readonly maxPatchBytes?: unknown;
  /** Explicit unified-diff context line count. Defaults to 3 and is bounded at 20. */
  readonly contextLines?: unknown;
  /** Optional bounded raw acquisition ceiling for each complete fragment. */
  readonly patchFragmentMaxBytes?: unknown;
  /** Internal spelling retained for focused callers that use the config name. */
  readonly maxPatchFragmentBytes?: unknown;
}

export interface GitDiffRangePatchOnlyOptions {
  readonly includePatch?: unknown;
  readonly maxPatchBytes?: unknown;
  readonly contextLines?: unknown;
  readonly patchFragmentMaxBytes?: unknown;
  readonly maxPatchFragmentBytes?: unknown;
}

export interface GitDiffRangePatchOmissionCounts {
  /** Whole metadata records blocked before patch eligibility. */
  readonly blocked: number;
  /** Returned metadata records whose Git producer truth is binary. */
  readonly binary: number;
  /** Returned text records that could not fit the remaining public budget. */
  readonly budget: number;
  /** Returned text records at the first bounded acquisition overflow and its deterministic suffix. */
  readonly tooLarge: number;
  /** Eligible metadata records beyond the returned max_files prefix. */
  readonly fileLimit: number;
  /** Returned text records omitted because patch generation was disabled. */
  readonly disabled: number;
}

export interface GitDiffRangePatchResult extends GitDiffRangeMetadataResult {
  /** Complete redacted patch fragments concatenated in metadata order. */
  readonly patch: string;
  readonly patchRequested: boolean;
  readonly patchIncluded: boolean;
  readonly patchTruncated: boolean;
  /** Final public redacted UTF-8 byte count, never a raw-byte count. */
  readonly patchBytes: number;
  readonly patchLimit: number;
  readonly patchFilesIncluded: number;
  /** Sum of patchOmissionCounts; every raw metadata record is classified once. */
  readonly patchFilesOmitted: number;
  readonly patchOmissionCounts: GitDiffRangePatchOmissionCounts;
}

interface RawPath {
  readonly bytes: Buffer;
  readonly text: string;
}

interface RawNameStatusRecord {
  readonly status: GitDiffRangeStatus;
  readonly oldPath: RawPath | null;
  readonly newPath: RawPath | null;
  readonly similarity: number | null;
}

interface RawNumstatRecord {
  /** Normal A/M/D/T records carry one path; rename/copy carries no path here. */
  readonly path: RawPath | null;
  readonly oldPath: RawPath | null;
  readonly newPath: RawPath | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const DEFAULT_MAX_FILES = 100;
const MAX_FILES = 200;
const MAX_METADATA_CAPTURE_BYTES = 2_000_000;
const DEFAULT_MAX_PATCH_BYTES = 60_000;
const MAX_PATCH_BYTES = 100_000;
const DEFAULT_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 20;
const MAX_PATCH_FRAGMENT_CAPTURE_BYTES = 2_000_000;
const STATUS_CODES = new Set<GitDiffRangeStatus>(["A", "C", "D", "M", "R", "T", "U", "X", "B"]);

function operationError(reason: GitDiffRangeFailureReason, facts: Readonly<Record<string, number>> = {}): GitDiffRangeError {
  return new GitDiffRangeError(reason, facts);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateRefInput(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw operationError("invalid-input");
}

function validateMaxFiles(value: unknown): number {
  const maxFiles = value === undefined ? DEFAULT_MAX_FILES : value;
  if (!positiveSafeInteger(maxFiles) || maxFiles > MAX_FILES) throw operationError("invalid-limit");
  return maxFiles;
}

function metadataCaptureLimit(config: GitDiffRangeConfig, requested: number | undefined): number {
  const outputLimit = config.maxOutputBytes;
  if (!positiveSafeInteger(outputLimit)) throw operationError("invalid-limit");
  const configuredReadLimit = config.maxReadBytes;
  if (configuredReadLimit !== undefined && !positiveSafeInteger(configuredReadLimit)) {
    throw operationError("invalid-limit");
  }
  const runnerCeiling = Math.max(outputLimit, configuredReadLimit ?? 0);
  const limit = requested ?? config.maxMetadataBytes ?? configuredReadLimit ?? outputLimit;
  if (!positiveSafeInteger(limit) || limit > MAX_METADATA_CAPTURE_BYTES || limit > runnerCeiling) {
    throw operationError("invalid-limit");
  }
  return limit;
}

interface ValidatedPatchOptions {
  readonly includePatch: boolean;
  readonly maxPatchBytes: number;
  readonly contextLines: number;
  readonly patchFragmentMaxBytes: number;
}

function patchFragmentCaptureLimit(config: GitDiffRangeConfig, requested: unknown): number {
  const outputLimit = config.maxOutputBytes;
  if (!positiveSafeInteger(outputLimit)) throw operationError("invalid-limit");
  const configuredReadLimit = config.maxReadBytes;
  if (configuredReadLimit !== undefined && !positiveSafeInteger(configuredReadLimit)) {
    throw operationError("invalid-limit");
  }
  const runnerCeiling = Math.max(outputLimit, configuredReadLimit ?? 0);
  const configuredLimit = config.maxPatchFragmentBytes ?? configuredReadLimit ?? outputLimit;
  const limit = requested === undefined ? configuredLimit : requested;
  if (
    !positiveSafeInteger(limit)
    || limit > MAX_PATCH_FRAGMENT_CAPTURE_BYTES
    || limit > runnerCeiling
  ) {
    throw operationError("invalid-limit");
  }
  return limit;
}

function validatePatchOptions(
  config: GitDiffRangeConfig,
  options: GitDiffRangePatchOnlyOptions | undefined
): ValidatedPatchOptions {
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options))) {
    throw operationError("invalid-input");
  }
  const includePatch = options?.includePatch === undefined ? true : options.includePatch;
  if (typeof includePatch !== "boolean") throw operationError("invalid-input");

  const maxPatchBytes = options?.maxPatchBytes === undefined ? DEFAULT_MAX_PATCH_BYTES : options.maxPatchBytes;
  if (!nonNegativeSafeInteger(maxPatchBytes) || maxPatchBytes > MAX_PATCH_BYTES) {
    throw operationError("invalid-limit");
  }

  const contextLines = options?.contextLines === undefined ? DEFAULT_CONTEXT_LINES : options.contextLines;
  if (!nonNegativeSafeInteger(contextLines) || contextLines > MAX_CONTEXT_LINES) {
    throw operationError("invalid-limit");
  }

  const requestedFragmentLimit = options?.patchFragmentMaxBytes ?? options?.maxPatchFragmentBytes;
  const patchFragmentMaxBytes = patchFragmentCaptureLimit(config, requestedFragmentLimit);
  return { includePatch, maxPatchBytes, contextLines, patchFragmentMaxBytes };
}

function splitNulRecords(bytes: Buffer, kind: "name-status" | "numstat"): Buffer[] {
  if (bytes.byteLength === 0) return [];
  if (bytes.at(-1) !== 0) {
    throw operationError(kind === "name-status" ? "malformed-name-status" : "malformed-numstat", {
      bytes: bytes.byteLength
    });
  }

  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(Buffer.from(bytes.subarray(start, index)));
    start = index + 1;
  }
  if (start !== bytes.byteLength) {
    throw operationError(kind === "name-status" ? "malformed-name-status" : "malformed-numstat", {
      bytes: bytes.byteLength,
      fields: fields.length
    });
  }
  return fields;
}

function decodePath(bytes: Buffer, kind: "name-status" | "numstat"): RawPath {
  if (bytes.byteLength === 0) {
    throw operationError(kind === "name-status" ? "malformed-name-status" : "malformed-numstat", {
      bytes: bytes.byteLength
    });
  }
  try {
    return { bytes: Buffer.from(bytes), text: UTF8_FATAL.decode(bytes) };
  } catch {
    throw operationError("path-encoding", { bytes: bytes.byteLength });
  }
}

function decodeStatus(bytes: Buffer): string {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw operationError("malformed-name-status", { bytes: bytes.byteLength });
  }
}

function parseSimilarity(status: string): { status: GitDiffRangeStatus; similarity: number | null } | undefined {
  const match = /^([ACDMRTUXB])(\d{0,3})$/u.exec(status);
  if (!match) return undefined;
  const code = match[1] as GitDiffRangeStatus;
  const scoreText = match[2];
  if ((code === "R" || code === "C") && scoreText.length === 0) return undefined;
  if (code !== "R" && code !== "C" && scoreText.length > 0) return undefined;
  if (scoreText.length === 0) return { status: code, similarity: null };
  const score = Number(scoreText);
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) return undefined;
  return { status: code, similarity: score };
}

function parseNameStatus(bytes: Buffer): RawNameStatusRecord[] {
  const fields = splitNulRecords(bytes, "name-status");
  const records: RawNameStatusRecord[] = [];
  let index = 0;
  while (index < fields.length) {
    const statusText = decodeStatus(fields[index]);
    const parsedStatus = parseSimilarity(statusText);
    if (!parsedStatus || !STATUS_CODES.has(parsedStatus.status)) {
      throw operationError("malformed-name-status", { bytes: bytes.byteLength, records: records.length });
    }
    index += 1;
    if (parsedStatus.status === "R" || parsedStatus.status === "C") {
      if (index + 1 >= fields.length) {
        throw operationError("malformed-name-status", { bytes: bytes.byteLength, records: records.length });
      }
      const oldPath = decodePath(fields[index], "name-status");
      const newPath = decodePath(fields[index + 1], "name-status");
      index += 2;
      records.push({ ...parsedStatus, oldPath, newPath });
      continue;
    }

    if (index >= fields.length) {
      throw operationError("malformed-name-status", { bytes: bytes.byteLength, records: records.length });
    }
    const path = decodePath(fields[index], "name-status");
    index += 1;
    if (parsedStatus.status === "A") {
      records.push({ ...parsedStatus, oldPath: null, newPath: path });
    } else if (parsedStatus.status === "D") {
      records.push({ ...parsedStatus, oldPath: path, newPath: null });
    } else {
      records.push({ ...parsedStatus, oldPath: path, newPath: path });
    }
  }
  return records;
}

function parseNumstatValue(bytes: Buffer): number | null {
  if (bytes.byteLength === 1 && bytes[0] === 0x2d) return null;
  if (bytes.byteLength === 0) throw operationError("malformed-numstat", { bytes: bytes.byteLength });

  let value = 0;
  for (const byte of bytes) {
    if (byte < 0x30 || byte > 0x39) throw operationError("malformed-numstat", { bytes: bytes.byteLength });
    const digit = byte - 0x30;
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
      throw operationError("numeric-overflow", { bytes: bytes.byteLength });
    }
    value = value * 10 + digit;
  }
  return value;
}

function parseNumstat(bytes: Buffer): RawNumstatRecord[] {
  const fields = splitNulRecords(bytes, "numstat");
  const records: RawNumstatRecord[] = [];
  let index = 0;
  while (index < fields.length) {
    const record = fields[index];
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      throw operationError("malformed-numstat", { bytes: bytes.byteLength, records: records.length });
    }
    const additions = parseNumstatValue(record.subarray(0, firstTab));
    const deletions = parseNumstatValue(record.subarray(firstTab + 1, secondTab));
    const pathField = record.subarray(secondTab + 1);

    if (pathField.byteLength > 0) {
      const path = decodePath(pathField, "numstat");
      if (additions === null || deletions === null) {
        if (additions !== null || deletions !== null) {
          throw operationError("malformed-numstat", { bytes: bytes.byteLength, records: records.length });
        }
        records.push({ path, oldPath: null, newPath: null, additions: null, deletions: null, binary: true });
      } else {
        records.push({ path, oldPath: null, newPath: null, additions, deletions, binary: false });
      }
      index += 1;
      continue;
    }

    // Detected rename/copy records have an empty path in the tab-delimited
    // field, followed by old and new path fields as separate NUL records.
    if (index + 2 >= fields.length) {
      throw operationError("malformed-numstat", { bytes: bytes.byteLength, records: records.length });
    }
    const oldPath = decodePath(fields[index + 1], "numstat");
    const newPath = decodePath(fields[index + 2], "numstat");
    if (additions === null || deletions === null) {
      if (additions !== null || deletions !== null) {
        throw operationError("malformed-numstat", { bytes: bytes.byteLength, records: records.length });
      }
      records.push({ path: null, oldPath, newPath, additions: null, deletions: null, binary: true });
    } else {
      records.push({ path: null, oldPath, newPath, additions, deletions, binary: false });
    }
    index += 3;
  }
  return records;
}

function samePath(left: RawPath | null, right: RawPath | null): boolean {
  if (left === null || right === null) return left === right;
  return left.bytes.equals(right.bytes);
}

function correlateMetadata(
  nameStatus: readonly RawNameStatusRecord[],
  numstat: readonly RawNumstatRecord[],
  byteFacts: { readonly nameStatusBytes: number; readonly numstatBytes: number }
): GitChangedFileMetadata[] {
  if (nameStatus.length !== numstat.length) {
    throw operationError("metadata-mismatch", {
      nameStatusRecords: nameStatus.length,
      numstatRecords: numstat.length,
      nameStatusBytes: byteFacts.nameStatusBytes,
      numstatBytes: byteFacts.numstatBytes
    });
  }

  return nameStatus.map((entry, index) => {
    const stats = numstat[index];
    const renameOrCopy = entry.status === "R" || entry.status === "C";
    const pathsMatch = renameOrCopy
      ? stats.path === null && samePath(entry.oldPath, stats.oldPath) && samePath(entry.newPath, stats.newPath)
      : stats.path !== null && stats.oldPath === null && stats.newPath === null && samePath(
          stats.path,
          entry.status === "D" ? entry.oldPath : entry.newPath
        );
    if (!pathsMatch) {
      throw operationError("metadata-mismatch", { record: index });
    }
    return {
      status: entry.status,
      oldPath: entry.oldPath?.text ?? null,
      newPath: entry.newPath?.text ?? null,
      similarity: entry.similarity,
      additions: stats.additions,
      deletions: stats.deletions,
      binary: stats.binary
    };
  });
}

function isBlockedRecord(
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  record: GitChangedFileMetadata
): boolean {
  return (
    (record.oldPath !== null && guard.isBlockedRelativePath(record.oldPath)) ||
    (record.newPath !== null && guard.isBlockedRelativePath(record.newPath))
  );
}

function hasRenameCopyWarning(bytes: Buffer): boolean {
  // This is only a bounded internal classifier. Never expose stderr itself:
  // Git may include hostile path text in diagnostics.
  const text = bytes.toString("utf8").toLowerCase();
  return (
    text.includes("rename detection was skipped") ||
    text.includes("copy detection was skipped") ||
    text.includes("exhaustive rename detection") ||
    /rename detection[^\n]*incomplete/u.test(text) ||
    /copy detection[^\n]*incomplete/u.test(text) ||
    text.includes("renamelimit")
  );
}

function metadataDiffArgs(identity: GitDiffRangeIdentity, format: "name-status" | "numstat"): string[] {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--find-copies=50%",
    "-z",
    format === "name-status" ? "--name-status" : "--numstat",
    identity.base.fullSha,
    identity.head.fullSha
  ];
  if (identity.path !== undefined) args.push("--", `:(literal)${identity.path}`);
  return args;
}

function quoteGitHeaderPath(value: string, quoteHighBytes: boolean): string {
  const bytes = Buffer.from(value, "utf8");
  let needsQuotes = false;
  for (const byte of bytes) {
    if (byte < 0x20 || byte === 0x22 || byte === 0x5c || byte === 0x7f || (quoteHighBytes && byte >= 0x80)) {
      needsQuotes = true;
      break;
    }
  }
  if (!needsQuotes) return value;

  let encoded = '"';
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    if (byte < 0x80) {
      if (byte === 0x07) encoded += "\\a";
      else if (byte === 0x08) encoded += "\\b";
      else if (byte === 0x09) encoded += "\\t";
      else if (byte === 0x0a) encoded += "\\n";
      else if (byte === 0x0b) encoded += "\\v";
      else if (byte === 0x0c) encoded += "\\f";
      else if (byte === 0x0d) encoded += "\\r";
      else if (byte === 0x22) encoded += '\\"';
      else if (byte === 0x5c) encoded += "\\\\";
      else if (byte < 0x20 || byte === 0x7f) encoded += `\\${byte.toString(8).padStart(3, "0")}`;
      else encoded += String.fromCharCode(byte);
      index += 1;
      continue;
    }

    const leading = byte;
    const sequenceLength = leading >= 0xf0 ? 4 : leading >= 0xe0 ? 3 : leading >= 0xc0 ? 2 : 1;
    const sequence = bytes.subarray(index, index + sequenceLength);
    if (quoteHighBytes || sequence.length !== sequenceLength) {
      for (const sequenceByte of sequence) {
        encoded += `\\${sequenceByte.toString(8).padStart(3, "0")}`;
      }
    } else {
      encoded += sequence.toString("utf8");
    }
    index += sequence.length;
  }
  return `${encoded}"`;
}

function patchHeaderPathForms(path: string): readonly [string, string][] {
  const oldPrefix = `a/${path}`;
  const newPrefix = `b/${path}`;
  return [
    [quoteGitHeaderPath(oldPrefix, false), quoteGitHeaderPath(newPrefix, false)],
    [quoteGitHeaderPath(oldPrefix, true), quoteGitHeaderPath(newPrefix, true)]
  ];
}

function patchHeaderMatchesRecord(source: string, record: GitChangedFileMetadata): boolean {
  const lineEnd = source.indexOf("\n");
  const firstLine = (lineEnd < 0 ? source : source.slice(0, lineEnd)).replace(/\r$/u, "");
  if (!firstLine.startsWith("diff --git ")) return false;

  // `diff --git` retains both sides for add/delete records, while the
  // unified ---/+++ headers use /dev/null for the absent side. The metadata
  // record therefore supplies the same path for both header sides when one
  // side is absent.
  const oldPath = record.oldPath ?? record.newPath;
  const newPath = record.newPath ?? record.oldPath;
  if (oldPath === null || newPath === null) return false;
  const oldForms = patchHeaderPathForms(oldPath);
  const newForms = patchHeaderPathForms(newPath);
  const expectedPairs: readonly [string, string][] = [
    [oldForms[0][0], newForms[0][1]],
    [oldForms[1][0], newForms[1][1]]
  ];
  return expectedPairs.some(([oldToken, newToken]) => firstLine === `diff --git ${oldToken} ${newToken}`);
}

function comparablePatchPath(value: string): string {
  // The existing redaction policy canonicalizes header-side backslashes for
  // cross-platform source routing. Metadata remains byte-faithful; compare a
  // normalized corroborating side only after the exact raw header matched.
  return value.replaceAll("\\", "/");
}

function patchFragmentHasNoPathMetadata(source: string): boolean {
  // Mode-only/type-only fragments legitimately have no ---/+++ or
  // rename/copy side records. They are still correlated by the exact
  // `diff --git` header above. If a fragment carries any path metadata but
  // that metadata failed validation, fail closed instead of trusting only a
  // header that could be adjacent to a contradictory block.
  const firstHunk = source.search(/^@@\s/mu);
  const headerRegion = source.slice(0, firstHunk < 0 ? source.length : firstHunk);
  return !/(?:^---\s|^\+\+\+\s|^rename (?:from|to)\s|^copy (?:from|to)\s)/mu.test(headerRegion);
}

function patchPathspecs(record: GitChangedFileMetadata): readonly string[] {
  const paths = [record.oldPath, record.newPath].filter((value): value is string => value !== null);
  const unique = [...new Set(paths)];
  if (unique.length === 0) throw operationError("patch-fragment-mismatch");
  return unique.map((path) => `:(literal)${path}`);
}

function patchDiffArgs(
  identity: GitDiffRangeIdentity,
  record: GitChangedFileMetadata,
  contextLines: number
): string[] {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    `-U${contextLines}`,
    "--find-renames=50%",
    "--find-copies=50%",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    identity.base.fullSha,
    identity.head.fullSha,
    "--"
  ];
  // Git has no --no-binary switch. Deliberately omit --binary (which enables
  // applyable binary payloads) and skip records already marked binary by the
  // machine-safe metadata producer.
  args.push(...patchPathspecs(record));
  return args;
}

function missingObject(error: GitExecutionError): boolean {
  if (error.failure !== "exit") return false;
  const stderr = error.result.copyStderrBytes().toString("utf8").toLowerCase();
  return /(?:bad object|not a valid object|unknown revision|ambiguous argument|missing object|object .* not found|does not exist)/u.test(
    stderr
  );
}

function mapMetadataExecutionFailure(error: unknown): GitDiffRangeError {
  if (error instanceof GitDiffRangeError) return error;
  if (error instanceof GitExecutionError) {
    if (error.failure === "stdout-overflow" || error.failure === "stderr-overflow") {
      return operationError("metadata-overflow", {
        stdoutBytes: error.result.toJSON().stdoutBytes,
        stderrBytes: error.result.toJSON().stderrBytes
      });
    }
    if (error.failure === "timeout") return operationError("timeout");
    if (missingObject(error)) return operationError("missing-object");
  }
  return operationError("execution");
}

async function runMetadataProducer(
  config: GitDiffRangeConfig,
  workspace: Workspace,
  args: readonly string[],
  captureLimit: number
): Promise<{ readonly bytes: Buffer; readonly stderr: Buffer }> {
  try {
    const result = await runGitReadOnly(config, workspace, args, { stdoutMaxBytes: captureLimit });
    return { bytes: result.copyStdoutBytes(), stderr: result.copyStderrBytes() };
  } catch (error) {
    throw mapMetadataExecutionFailure(error);
  }
}

interface PatchProducerResult {
  readonly text?: string;
  readonly tooLarge: boolean;
}

async function runPatchProducer(
  config: GitDiffRangeConfig,
  workspace: Workspace,
  args: readonly string[],
  captureLimit: number,
  recordIndex: number
): Promise<PatchProducerResult> {
  let result: Awaited<ReturnType<typeof runGitReadOnly>>;
  try {
    result = await runGitReadOnly(config, workspace, args, { stdoutMaxBytes: captureLimit });
  } catch (error) {
    if (error instanceof GitExecutionError) {
      const facts = {
        record: recordIndex,
        stdoutBytes: error.result.toJSON().stdoutBytes,
        stderrBytes: error.result.toJSON().stderrBytes
      };
      // The bounded runner retains only a prefix on overflow. Never parse or
      // redact that prefix: the complete fragment is unavailable, so the
      // caller receives a truthful too-large omission instead.
      if (error.failure === "stdout-overflow") return { tooLarge: true };
      if (error.failure === "timeout") throw operationError("patch-timeout", facts);
      if (missingObject(error)) throw operationError("patch-missing-object", facts);
      throw operationError("patch-execution", facts);
    }
    throw operationError("patch-execution", { record: recordIndex });
  }

  if (result.stdoutOverflow) return { tooLarge: true };
  const bytes = result.copyStdoutBytes();
  try {
    return { text: UTF8_FATAL.decode(bytes), tooLarge: false };
  } catch {
    throw operationError("patch-encoding", { record: recordIndex, bytes: bytes.byteLength });
  }
}

interface SelectedPatchFragment {
  readonly source: string;
  /** A type change can be one metadata record represented by two Git blocks. */
  readonly blockCount: number;
}

function patchBlockMatchesRecord(
  block: ReturnType<typeof extractDiffFileBlocks>[number],
  record: GitChangedFileMetadata
): boolean {
  if (!block.pathDiscoveryValid) return patchFragmentHasNoPathMetadata(block.source);
  const oldMatch = record.oldPath === null
    ? !block.oldPresent
    : block.oldPresent
      && block.oldPath !== undefined
      && comparablePatchPath(block.oldPath) === comparablePatchPath(record.oldPath);
  const newMatch = record.newPath === null
    ? !block.newPresent
    : block.newPresent
      && block.newPath !== undefined
      && comparablePatchPath(block.newPath) === comparablePatchPath(record.newPath);
  return oldMatch && newMatch;
}

function selectPatchFragment(
  text: string,
  record: GitChangedFileMetadata,
  recordIndex: number
): SelectedPatchFragment {
  if (text.length === 0) throw operationError("patch-fragment-mismatch", { record: recordIndex });

  let blocks: readonly ReturnType<typeof extractDiffFileBlocks>[number][];
  try {
    blocks = extractDiffFileBlocks(text);
  } catch {
    throw operationError("patch-fragment-malformed", { record: recordIndex, bytes: Buffer.byteLength(text, "utf8") });
  }

  const candidates = blocks.filter((block) => !block.ambiguous && patchHeaderMatchesRecord(block.source, record));
  const matching = candidates.filter((block) => patchBlockMatchesRecord(block, record));
  if (matching.length === 1) {
    const fragment = matching[0].source;
    if (!fragment.startsWith("diff --git ")) {
      throw operationError("patch-fragment-malformed", { record: recordIndex });
    }
    if (/^GIT binary patch$/mu.test(fragment) || /^Binary files /mu.test(fragment)) {
      throw operationError("patch-fragment-malformed", { record: recordIndex });
    }
    return { source: fragment, blockCount: 1 };
  }

  // Git renders a mode/type transition as one metadata `T` record but may
  // emit an adjacent delete block followed by an add block for that same
  // path. Correlate exactly that pair; never join arbitrary neighboring
  // records merely because their headers happen to share a path.
  const typeChangePair = record.status === "T"
    && record.oldPath !== null
    && record.oldPath === record.newPath
    && candidates.length === 2
    && matching.length === 0
    ? candidates.filter((block) => patchBlockMatchesRecord(block, {
      ...record,
      newPath: null
    })).filter((block) => block.oldPresent && !block.newPresent).concat(
      candidates.filter((block) => patchBlockMatchesRecord(block, {
        ...record,
        oldPath: null
      })).filter((block) => !block.oldPresent && block.newPresent)
    )
    : [];
  if (typeChangePair.length === 2) {
    const ordered = [...typeChangePair].sort((left, right) => left.start - right.start);
    if (ordered[0].end === ordered[1].start) {
      const fragment = text.slice(ordered[0].start, ordered[1].end);
      if (!fragment.startsWith("diff --git ")) {
        throw operationError("patch-fragment-malformed", { record: recordIndex });
      }
      if (/^GIT binary patch$/mu.test(fragment) || /^Binary files /mu.test(fragment)) {
        throw operationError("patch-fragment-malformed", { record: recordIndex });
      }
      return { source: fragment, blockCount: 2 };
    }
  }

  if (matching.length !== 1) {
    throw operationError("patch-fragment-mismatch", {
      record: recordIndex,
      blocks: blocks.length,
      matches: matching.length
    });
  }

  throw operationError("patch-fragment-mismatch", { record: recordIndex });
}

function redactCompletePatchFragment(fragment: SelectedPatchFragment, recordIndex: number): string {
  let redacted: string;
  try {
    redacted = redactUnifiedDiff(fragment.source, sourceLanguageForPath);
  } catch {
    throw operationError("patch-fragment-malformed", {
      record: recordIndex,
      bytes: Buffer.byteLength(fragment.source, "utf8")
    });
  }

  let blocks: readonly ReturnType<typeof extractDiffFileBlocks>[number][];
  try {
    blocks = extractDiffFileBlocks(redacted);
  } catch {
    throw operationError("patch-fragment-malformed", { record: recordIndex });
  }
  // Redaction is allowed to change payload byte length, but never its file
  // boundary. This check prevents a policy regression from turning a complete
  // fragment into a partial/multi-file public patch.
  if (blocks.length !== fragment.blockCount || blocks.some((block) => block.ambiguous) || blocks.map((block) => block.source).join("") !== redacted) {
    throw operationError("patch-fragment-malformed", {
      record: recordIndex,
      blocks: blocks.length,
      bytes: Buffer.byteLength(redacted, "utf8")
    });
  }
  return redacted;
}

/**
 * Resolve each range endpoint once and expose only immutable full object IDs
 * for downstream metadata/patch commands. The optional path is validated as a
 * historical repository-tree path and is never resolved through the checkout.
 */
export async function resolveGitDiffRangeIdentity(
  config: GitDiffRangeConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitDiffRangeIdentityOptions
): Promise<GitDiffRangeIdentity> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw operationError("invalid-input");
  validateRefInput(options.baseRef);
  validateRefInput(options.headRef);

  let canonicalPath: string | undefined;
  if (options.path !== undefined) canonicalPath = validateHistoricalPath(guard, options.path);

  let base: GitReviewRef;
  let head: GitReviewRef;
  try {
    [base, head] = await Promise.all([
      resolveGitRef(config, workspace, options.baseRef),
      resolveGitRef(config, workspace, options.headRef)
    ]);
  } catch (error) {
    if (error instanceof GitRefResolutionError) throw error;
    throw operationError("execution");
  }
  if (base.objectFormat !== head.objectFormat) throw operationError("object-format-mismatch");
  return {
    base,
    head,
    objectFormat: base.objectFormat,
    ...(canonicalPath === undefined ? {} : { path: canonicalPath })
  };
}

/** Alias retained for operation-oriented internal consumers. */
export const resolveGitDiffRange = resolveGitDiffRangeIdentity;

/**
 * Acquire and correlate complete machine-safe changed-file metadata from the
 * real local Git producers. Counts are computed only after both bounded
 * streams parse completely; blocked records are removed as whole records and
 * maxFiles affects only the returned eligible prefix.
 */
export async function collectGitDiffRangeMetadata(
  config: GitDiffRangeConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitDiffRangeMetadataOptions
): Promise<GitDiffRangeMetadataResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw operationError("invalid-input");
  const maxFiles = validateMaxFiles(options.maxFiles);
  const captureLimit = metadataCaptureLimit(config, options.metadataMaxBytes);
  const identity = await resolveGitDiffRangeIdentity(config, guard, workspace, options);

  const [nameStatusProducer, numstatProducer] = await Promise.all([
    runMetadataProducer(config, workspace, metadataDiffArgs(identity, "name-status"), captureLimit),
    runMetadataProducer(config, workspace, metadataDiffArgs(identity, "numstat"), captureLimit)
  ]);
  const nameStatus = parseNameStatus(nameStatusProducer.bytes);
  const numstat = parseNumstat(numstatProducer.bytes);
  const completeRecords = correlateMetadata(nameStatus, numstat, {
    nameStatusBytes: nameStatusProducer.bytes.byteLength,
    numstatBytes: numstatProducer.bytes.byteLength
  });

  const eligibleChangedFiles: GitChangedFileMetadata[] = [];
  let blockedFilesOmitted = 0;
  for (const record of completeRecords) {
    if (isBlockedRecord(guard, record)) {
      blockedFilesOmitted += 1;
      continue;
    }
    eligibleChangedFiles.push(record);
  }

  const changedFiles = eligibleChangedFiles.slice(0, maxFiles);
  const renameCopyDetectionComplete = !hasRenameCopyWarning(nameStatusProducer.stderr) && !hasRenameCopyWarning(numstatProducer.stderr);
  const warnings = renameCopyDetectionComplete ? [] : ["Git rename/copy detection reported an incomplete result."];
  return {
    identity,
    eligibleChangedFiles,
    changedFiles,
    changedFileCount: completeRecords.length,
    eligibleChangedFileCount: eligibleChangedFiles.length,
    returnedFileCount: changedFiles.length,
    changedFilesTruncated: changedFiles.length < eligibleChangedFiles.length,
    blockedFilesOmitted,
    renameCopyDetectionComplete,
    warnings
  };
}

function patchOmissionWarning(
  counts: GitDiffRangePatchOmissionCounts,
  patchRequested: boolean,
  patchTruncated: boolean
): string[] {
  const warnings: string[] = [];
  if (counts.blocked > 0) warnings.push("Blocked changed records were omitted from patch evidence.");
  if (counts.fileLimit > 0) warnings.push("Patch evidence omits records beyond the max_files prefix.");
  if (counts.binary > 0) warnings.push("Binary changed records were omitted from patch payload.");
  if (!patchRequested && counts.disabled > 0) warnings.push("Patch generation was disabled by request.");
  if (patchTruncated && counts.budget > 0) {
    warnings.push("Patch evidence stopped before the next complete fragment at the public byte limit.");
  }
  if (patchTruncated && counts.tooLarge > 0) {
    warnings.push("Patch evidence stopped at a fragment beyond the bounded acquisition limit.");
  }
  return warnings;
}

function patchCountSum(counts: GitDiffRangePatchOmissionCounts): number {
  return counts.blocked
    + counts.binary
    + counts.budget
    + counts.tooLarge
    + counts.fileLimit
    + counts.disabled;
}

/**
 * Generate a patch from already-acquired, complete metadata. This route never
 * resolves refs and therefore every content command uses the identity SHAs
 * captured by collectGitDiffRangeMetadata.
 */
export async function collectGitDiffRangePatchForMetadata(
  config: GitDiffRangeConfig,
  _guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  metadata: GitDiffRangeMetadataResult,
  options: GitDiffRangePatchOnlyOptions = {}
): Promise<GitDiffRangePatchResult> {
  const validated = validatePatchOptions(config, options);
  const counts = {
    blocked: metadata.blockedFilesOmitted,
    binary: 0,
    budget: 0,
    tooLarge: 0,
    fileLimit: Math.max(0, metadata.eligibleChangedFileCount - metadata.changedFiles.length),
    disabled: 0
  };
  let patch = "";
  let patchFilesIncluded = 0;
  let patchTruncated = false;
  let stopped: "budget" | "tooLarge" | undefined;

  const changedFiles = metadata.changedFiles;
  for (let index = 0; index < changedFiles.length; index += 1) {
    const record = changedFiles[index];
    if (record.binary) {
      counts.binary += 1;
      continue;
    }

    if (!validated.includePatch) {
      counts.disabled += 1;
      continue;
    }

    if (stopped !== undefined) {
      counts[stopped] += 1;
      continue;
    }

    const remaining = validated.maxPatchBytes - Buffer.byteLength(patch, "utf8");
    if (remaining <= 0) {
      counts.budget += 1;
      patchTruncated = true;
      stopped = "budget";
      continue;
    }

    const producer = await runPatchProducer(
      config,
      workspace,
      patchDiffArgs(metadata.identity, record, validated.contextLines),
      validated.patchFragmentMaxBytes,
      index
    );
    if (producer.tooLarge) {
      // Prefix semantics: once one complete fragment cannot be acquired, no
      // later fragment is probed. Every remaining text record is classified
      // under the same bounded stop reason, while binaries remain binary.
      counts.tooLarge += 1;
      patchTruncated = true;
      stopped = "tooLarge";
      continue;
    }

    const fragment = selectPatchFragment(producer.text ?? "", record, index);
    const redacted = redactCompletePatchFragment(fragment, index);
    const redactedBytes = Buffer.byteLength(redacted, "utf8");
    if (redactedBytes > remaining) {
      counts.budget += 1;
      patchTruncated = true;
      stopped = "budget";
      continue;
    }

    patch += redacted;
    patchFilesIncluded += 1;
  }

  const patchBytes = Buffer.byteLength(patch, "utf8");
  const patchOmissionCounts: GitDiffRangePatchOmissionCounts = { ...counts };
  const patchFilesOmitted = patchCountSum(patchOmissionCounts);
  const expectedClassified = metadata.changedFileCount;
  if (patchFilesIncluded + patchFilesOmitted !== expectedClassified) {
    // Metadata is an internal contract. Do not return mutually inconsistent
    // omission facts if a future producer changes that contract.
    throw operationError("metadata-mismatch", {
      changedFileCount: metadata.changedFileCount,
      patchFilesIncluded,
      patchFilesOmitted
    });
  }

  const warnings = [
    ...metadata.warnings,
    ...patchOmissionWarning(patchOmissionCounts, validated.includePatch, patchTruncated)
  ];
  return {
    ...metadata,
    patch,
    patchRequested: validated.includePatch,
    patchIncluded: patch.length > 0,
    patchTruncated,
    patchBytes,
    patchLimit: validated.maxPatchBytes,
    patchFilesIncluded,
    patchFilesOmitted,
    patchOmissionCounts,
    warnings: [...new Set(warnings)]
  };
}

function isMetadataResult(value: unknown): value is GitDiffRangeMetadataResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<GitDiffRangeMetadataResult>;
  return Boolean(candidate.identity && Array.isArray(candidate.changedFiles) && Array.isArray(candidate.eligibleChangedFiles));
}

/**
 * Combined metadata + complete-fragment patch operation. Validation occurs
 * before any Git command; the patch phase consumes only captured metadata
 * identity/records and never resolves caller refs a second time.
 */
export async function collectGitDiffRangePatch(
  config: GitDiffRangeConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitDiffRangePatchOptions
): Promise<GitDiffRangePatchResult>;
export async function collectGitDiffRangePatch(
  config: GitDiffRangeConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  metadata: GitDiffRangeMetadataResult,
  options?: GitDiffRangePatchOnlyOptions
): Promise<GitDiffRangePatchResult>;
export async function collectGitDiffRangePatch(
  config: GitDiffRangeConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  input: GitDiffRangePatchOptions | GitDiffRangeMetadataResult,
  patchOptions?: GitDiffRangePatchOnlyOptions
): Promise<GitDiffRangePatchResult> {
  if (isMetadataResult(input)) {
    return collectGitDiffRangePatchForMetadata(config, guard, workspace, input, patchOptions);
  }
  const validated = validatePatchOptions(config, input);
  const metadata = await collectGitDiffRangeMetadata(config, guard, workspace, input);
  return collectGitDiffRangePatchForMetadata(config, guard, workspace, metadata, validated);
}

/** Alias retained for later integrated git_diff_range orchestration. */
export const gitDiffRangeMetadata = collectGitDiffRangeMetadata;

/** Alias retained for operation-oriented patch consumers. */
export const gitDiffRangePatch = collectGitDiffRangePatch;

/**
 * Public-domain changed-file record. The operation internals deliberately use
 * camelCase names, while the MCP result contract is locked to snake_case.
 */
export interface GitDiffRangeChangedFile {
  readonly status: GitDiffRangeStatus;
  readonly old_path: string | null;
  readonly new_path: string | null;
  readonly similarity: number | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

/**
 * Exact structured result domain for the integrated historical range
 * operation. Internal producer-only fields such as eligibleChangedFiles and
 * renameCopyDetectionComplete are intentionally not part of this type.
 */
export interface GitDiffRangeResult {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly root: string;
  readonly comparison_mode: "direct-two-tree";
  readonly object_format: GitObjectFormat;
  readonly base_ref_input: string;
  readonly base_commit_sha: string;
  readonly head_ref_input: string;
  readonly head_commit_sha: string;
  readonly path?: string;
  readonly changed_file_count: number;
  readonly eligible_changed_file_count: number;
  readonly returned_file_count: number;
  readonly changed_files_truncated: boolean;
  readonly blocked_files_omitted: number;
  readonly changed_files: readonly GitDiffRangeChangedFile[];
  readonly patch: string;
  readonly patch_requested: boolean;
  readonly patch_included: boolean;
  readonly patch_truncated: boolean;
  readonly patch_bytes: number;
  readonly patch_limit: number;
  readonly patch_files_included: number;
  readonly patch_files_omitted: number;
  readonly patch_omission_counts: {
    readonly blocked: number;
    readonly binary: number;
    readonly budget: number;
    readonly too_large: number;
    readonly file_limit: number;
    readonly disabled: number;
  };
  readonly warnings: readonly string[];
}

/** Alias for callers that use the operation-oriented result name. */
export type GitDiffRangeStructuredResult = GitDiffRangeResult;

/**
 * Project the already-proven metadata and patch engine into the locked public
 * structured contract. The engine remains the sole producer of changed-file
 * and patch truth; this layer only adds workspace context and renames fields.
 */
export async function gitDiffRange(
  config: GitDiffRangeConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitDiffRangePatchOptions
): Promise<GitDiffRangeResult> {
  const result = await collectGitDiffRangePatch(config, guard, workspace, options);
  const warnings = result.changedFilesTruncated
    ? [...result.warnings, "Changed-file metadata was truncated to the max_files prefix."]
    : [...result.warnings];
  return {
    schema_version: 1,
    workspace_id: workspace.id,
    root: workspace.root,
    comparison_mode: "direct-two-tree",
    object_format: result.identity.objectFormat,
    base_ref_input: result.identity.base.input,
    base_commit_sha: result.identity.base.fullSha,
    head_ref_input: result.identity.head.input,
    head_commit_sha: result.identity.head.fullSha,
    ...(result.identity.path === undefined ? {} : { path: result.identity.path }),
    changed_file_count: result.changedFileCount,
    eligible_changed_file_count: result.eligibleChangedFileCount,
    returned_file_count: result.returnedFileCount,
    changed_files_truncated: result.changedFilesTruncated,
    blocked_files_omitted: result.blockedFilesOmitted,
    changed_files: result.changedFiles.map((record) => ({
      status: record.status,
      old_path: record.oldPath,
      new_path: record.newPath,
      similarity: record.similarity,
      additions: record.additions,
      deletions: record.deletions,
      binary: record.binary
    })),
    patch: result.patch,
    patch_requested: result.patchRequested,
    patch_included: result.patchIncluded,
    patch_truncated: result.patchTruncated,
    patch_bytes: result.patchBytes,
    patch_limit: result.patchLimit,
    patch_files_included: result.patchFilesIncluded,
    patch_files_omitted: result.patchFilesOmitted,
    patch_omission_counts: {
      blocked: result.patchOmissionCounts.blocked,
      binary: result.patchOmissionCounts.binary,
      budget: result.patchOmissionCounts.budget,
      too_large: result.patchOmissionCounts.tooLarge,
      file_limit: result.patchOmissionCounts.fileLimit,
      disabled: result.patchOmissionCounts.disabled
    },
    warnings: [...new Set(warnings)]
  };
}

/** Alias retained for callers that use the collect-oriented operation name. */
export const collectGitDiffRange = gitDiffRange;
