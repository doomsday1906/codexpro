import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitReadOnly } from "./gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { validateHistoricalPath } from "./historicalPath.js";
import { GitRefResolutionError, resolveGitRef, type GitObjectFormat, type GitReviewRef } from "./gitReviewRef.js";

/** Configuration consumed by the machine-safe historical metadata operation. */
export type GitDiffRangeConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes"> &
  Partial<Pick<CodexProConfig, "maxReadBytes">> & {
    /** Optional operation-local capture ceiling used by focused callers/tests. */
    readonly maxMetadataBytes?: number;
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
  | "numeric-overflow";

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
  "numeric-overflow": "Git returned a numstat value outside the safe bounded range."
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
const STATUS_CODES = new Set<GitDiffRangeStatus>(["A", "C", "D", "M", "R", "T", "U", "X", "B"]);

function operationError(reason: GitDiffRangeFailureReason, facts: Readonly<Record<string, number>> = {}): GitDiffRangeError {
  return new GitDiffRangeError(reason, facts);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

/** Alias retained for later integrated git_diff_range orchestration. */
export const gitDiffRangeMetadata = collectGitDiffRangeMetadata;
