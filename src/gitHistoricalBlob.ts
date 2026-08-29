import { createHash } from "node:crypto";
import type { CodexProConfig } from "./config.js";
import { projectPublicSourceText, type ReadFileResult } from "./fsOps.js";
import { GitExecutionError, runGitReadOnly } from "./gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { validateHistoricalPath } from "./historicalPath.js";
import { GitRefResolutionError, resolveGitRef, type GitObjectFormat, type GitReviewRef } from "./gitReviewRef.js";

export type GitHistoricalBlobConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes" | "maxReadBytes">;

export interface GitHistoricalBlobOptions {
  readonly ref: string;
  readonly path: unknown;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly maxBytes?: number;
}

export type HistoricalBlobEntryKind = "file" | "symlink";

export type HistoricalBlobFailureReason =
  | "invalid-input"
  | "invalid-path"
  | "blocked-path"
  | "invalid-range"
  | "invalid-max-bytes"
  | "ref-resolution"
  | "missing-path"
  | "malformed-entry"
  | "invalid-object-id"
  | "invalid-object-size"
  | "directory"
  | "gitlink"
  | "type-mismatch"
  | "oversized"
  | "execution"
  | "timeout"
  | "stdout-overflow"
  | "blob-size-mismatch"
  | "binary"
  | "projection"
  | "range-too-large";

const FAILURE_MESSAGES: Record<HistoricalBlobFailureReason, string> = {
  "invalid-input": "Historical blob input is invalid.",
  "invalid-path": "Historical blob path is invalid.",
  "blocked-path": "Historical blob path is blocked by safety rules.",
  "invalid-range": "Historical blob line range is invalid.",
  "invalid-max-bytes": "Historical blob max_bytes must be a positive integer.",
  "ref-resolution": "Historical blob ref could not be resolved.",
  "missing-path": "Historical blob path was not present in the requested tree.",
  "malformed-entry": "Git returned a malformed historical tree entry.",
  "invalid-object-id": "Git returned an invalid historical object ID.",
  "invalid-object-size": "Git returned an invalid historical object size.",
  directory: "Historical path is a directory.",
  gitlink: "Historical path is a gitlink.",
  "type-mismatch": "Historical tree entry type is not supported.",
  oversized: "Historical blob exceeds the configured read limit.",
  execution: "Historical blob Git execution failed.",
  timeout: "Historical blob Git execution timed out.",
  "stdout-overflow": "Historical blob Git output exceeded its bound.",
  "blob-size-mismatch": "Historical blob byte count did not match Git metadata.",
  binary: "Historical blob is binary.",
  projection: "Historical blob source projection failed.",
  "range-too-large": "Historical blob line range exceeds the byte limit."
};

/**
 * Constant-message, JSON-safe failure for the historical blob operation.
 * Only a bounded reason and numeric facts are retained; caller inputs and
 * Git/source streams are deliberately never stored on this error.
 */
export class HistoricalBlobError extends CodexProError {
  readonly reason: HistoricalBlobFailureReason;
  readonly facts: Readonly<Record<string, number>>;

  constructor(reason: HistoricalBlobFailureReason, facts: Readonly<Record<string, number>> = {}) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "HistoricalBlobError";
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

export { HistoricalBlobError as GitHistoricalBlobError };

export interface GitHistoricalBlobResult extends ReadFileResult {
  readonly ref: GitReviewRef;
  readonly commitSha: string;
  readonly gitMode: string;
  readonly entryKind: HistoricalBlobEntryKind;
  readonly blobSha: string;
}

interface HistoricalTreeEntry {
  readonly mode: string;
  readonly type: "blob" | "tree" | "commit";
  readonly oid: string;
  readonly size: number | undefined;
  readonly entryKind?: HistoricalBlobEntryKind;
}

function failure(reason: HistoricalBlobFailureReason, facts: Readonly<Record<string, number>> = {}): HistoricalBlobError {
  return new HistoricalBlobError(reason, facts);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateLineOption(value: unknown): void {
  if (value !== undefined && !isPositiveInteger(value)) throw failure("invalid-range");
}

interface ValidatedHistoricalBlobOptions {
  /** Whole-blob ceiling: configured for ranges, requested/configured for full reads. */
  readonly acquisitionMaxBytes: number;
  /** The bounded budget passed to the shared projector. */
  readonly projectionMaxBytes: number;
}

function validateOptions(
  config: GitHistoricalBlobConfig,
  options: GitHistoricalBlobOptions
): ValidatedHistoricalBlobOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw failure("invalid-input");
  if (typeof options.ref !== "string" || options.ref.length === 0) throw failure("invalid-input");
  validateLineOption(options.startLine);
  validateLineOption(options.endLine);
  if (options.startLine !== undefined && options.endLine !== undefined && options.endLine < options.startLine) {
    throw failure("invalid-range");
  }

  if (!isPositiveInteger(config.maxReadBytes)) throw failure("invalid-max-bytes");
  if (options.maxBytes !== undefined && !isPositiveInteger(options.maxBytes)) throw failure("invalid-max-bytes");
  const projectionMaxBytes = Math.min(options.maxBytes ?? config.maxReadBytes, config.maxReadBytes);
  const hasRange = options.startLine !== undefined || options.endLine !== undefined;
  const acquisitionMaxBytes = hasRange ? config.maxReadBytes : projectionMaxBytes;
  if (!isPositiveInteger(projectionMaxBytes)) throw failure("invalid-max-bytes");
  return { acquisitionMaxBytes, projectionMaxBytes };
}

function objectIdPattern(objectFormat: GitObjectFormat): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/u : /^[0-9a-f]{64}$/u;
}

function isMissingObjectError(error: GitExecutionError): boolean {
  if (error.failure !== "exit") return false;
  const stderr = error.result.copyStderrBytes().toString("utf8").toLowerCase();
  return /(?:bad object|not a valid object|unknown revision|ambiguous argument|missing object|object .* not found|does not exist)/u.test(
    stderr
  );
}

function executionFailure(error: unknown): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof GitExecutionError) {
    const facts = {
      stdoutBytes: error.result.toJSON().stdoutBytes,
      stderrBytes: error.result.toJSON().stderrBytes
    };
    if (error.failure === "timeout") return failure("timeout", facts);
    if (error.failure === "stdout-overflow") return failure("stdout-overflow", facts);
    if (isMissingObjectError(error)) return failure("execution", facts);
    return failure("execution", facts);
  }
  return failure("execution");
}

async function runHistoricalGit(
  config: GitHistoricalBlobConfig,
  workspace: Workspace,
  args: readonly string[]
) {
  try {
    return await runGitReadOnly(config, workspace, args);
  } catch (error) {
    throw executionFailure(error);
  }
}

function parseObjectSize(sizeText: string): number | undefined {
  if (sizeText === "-") return undefined;
  if (!/^\d+$/u.test(sizeText)) throw failure("invalid-object-size");
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0) throw failure("invalid-object-size");
  return size;
}

function parseTreeEntry(bytes: Buffer, canonicalPath: string, objectFormat: GitObjectFormat): HistoricalTreeEntry {
  if (bytes.byteLength === 0) throw failure("missing-path");
  const nul = bytes.indexOf(0);
  if (nul < 0 || bytes.lastIndexOf(0) !== nul || nul !== bytes.byteLength - 1) {
    throw failure("malformed-entry", { bytes: bytes.byteLength });
  }

  const record = bytes.subarray(0, nul);
  const tab = record.indexOf(0x09);
  if (tab < 0) throw failure("malformed-entry", { bytes: bytes.byteLength });
  const metadata = record.subarray(0, tab).toString("utf8");
  const returnedPath = record.subarray(tab + 1);
  const expectedPath = Buffer.from(canonicalPath, "utf8");
  if (!returnedPath.equals(expectedPath)) throw failure("malformed-entry", { bytes: returnedPath.byteLength });

  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]+) +(-|[0-9]+)$/u.exec(metadata);
  if (!match) throw failure("malformed-entry", { bytes: metadata.length });
  const [, mode, type, oid, sizeText] = match;
  if (!objectIdPattern(objectFormat).test(oid)) throw failure("invalid-object-id", { bytes: oid.length });
  const size = parseObjectSize(sizeText);

  if (type === "blob") {
    if (size === undefined) throw failure("invalid-object-size");
    if (mode === "100644" || mode === "100755") return { mode, type, oid, size, entryKind: "file" };
    if (mode === "120000") return { mode, type, oid, size, entryKind: "symlink" };
    throw failure("type-mismatch");
  }
  if (size !== undefined) throw failure("malformed-entry", { bytes: size });
  if (mode === "040000" && type === "tree") throw failure("directory");
  if (mode === "160000" && type === "commit") throw failure("gitlink");
  throw failure("type-mismatch");
}

function mapPathFailure(error: unknown): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof CodexProError && error.message === "Historical repository path is blocked by safety rules.") {
    return failure("blocked-path");
  }
  return failure("invalid-path");
}

function mapProjectionFailure(error: unknown): HistoricalBlobError {
  if (error instanceof HistoricalBlobError) return error;
  if (error instanceof CodexProError && error.message.startsWith("Selected line range is too large.")) {
    return failure("range-too-large");
  }
  return failure("projection");
}

/**
 * Read one complete text blob from an immutable commit tree. Ref resolution,
 * tree lookup, and blob acquisition are all local read-only Git operations;
 * the historical path is never resolved through the current filesystem.
 */
export async function readAtRef(
  config: GitHistoricalBlobConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitHistoricalBlobOptions
): Promise<GitHistoricalBlobResult> {
  const validatedOptions = validateOptions(config, options);

  let resolved: GitReviewRef;
  try {
    resolved = await resolveGitRef(config, workspace, options.ref);
  } catch (error) {
    if (error instanceof HistoricalBlobError) throw error;
    if (error instanceof GitRefResolutionError) throw failure("ref-resolution");
    throw executionFailure(error);
  }

  let canonicalPath: string;
  try {
    canonicalPath = validateHistoricalPath(guard, options.path);
  } catch (error) {
    throw mapPathFailure(error);
  }

  const treeEntryResult = await runHistoricalGit(config, workspace, [
    "ls-tree",
    "-z",
    "-l",
    "--full-tree",
    resolved.fullSha,
    "--",
    `:(literal)${canonicalPath}`
  ]);
  const entry = parseTreeEntry(treeEntryResult.copyStdoutBytes(), canonicalPath, resolved.objectFormat);
  if (entry.size === undefined || entry.entryKind === undefined) throw failure("type-mismatch");
  if (entry.size > validatedOptions.acquisitionMaxBytes) {
    throw failure("oversized", { advertised: entry.size, limit: validatedOptions.acquisitionMaxBytes });
  }

  let blobResult;
  try {
    blobResult = await runGitReadOnly(config, workspace, ["cat-file", "blob", entry.oid], {
      stdoutMaxBytes: entry.size
    });
  } catch (error) {
    throw executionFailure(error);
  }
  if (blobResult.stdoutOverflow) {
    throw failure("stdout-overflow", { advertised: entry.size });
  }
  const blobBytes = blobResult.copyStdoutBytes();
  if (blobBytes.byteLength !== entry.size) {
    throw failure("blob-size-mismatch", { actual: blobBytes.byteLength, advertised: entry.size });
  }
  if (blobBytes.includes(0)) throw failure("binary", { bytes: blobBytes.byteLength });

  const blobSha = createHash("sha256").update(blobBytes).digest("hex");
  const decodedText = blobBytes.toString("utf8");
  let projected: ReadFileResult;
  try {
    projected = projectPublicSourceText({
      logicalPath: canonicalPath,
      text: decodedText,
      bytes: blobBytes.byteLength,
      sha256: blobSha,
      startLine: options.startLine,
      endLine: options.endLine,
      maxBytes: validatedOptions.projectionMaxBytes
    });
  } catch (error) {
    throw mapProjectionFailure(error);
  }

  return {
    ...projected,
    ref: resolved,
    commitSha: resolved.fullSha,
    path: canonicalPath,
    gitMode: entry.mode,
    entryKind: entry.entryKind,
    blobSha: entry.oid
  };
}

// Operation-oriented aliases keep the internal primitive easy to consume
// while the public `read_at_ref` registration remains a later task.
export const gitHistoricalBlob = readAtRef;
export const readHistoricalBlob = readAtRef;
export const gitReadAtRef = readAtRef;
