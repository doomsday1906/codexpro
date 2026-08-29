import { TextDecoder } from "node:util";
import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitReadOnly } from "./gitOps.js";
import { CodexProError, type PathGuard, type Workspace } from "./guard.js";
import { validateHistoricalPath } from "./historicalPath.js";
import { GitRefResolutionError, resolveGitRef, type GitObjectFormat, type GitReviewRef } from "./gitReviewRef.js";

export type GitHistoryConfig = Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes"> &
  Partial<Pick<CodexProConfig, "maxReadBytes">>;

export type GitHistoryOperation = "merge-base" | "log" | "show-commit";

export type GitHistoryFailureReason =
  | "ref-resolution"
  | "invalid-input"
  | "invalid-path"
  | "invalid-limit"
  | "execution"
  | "missing-object"
  | "malformed-output"
  | "malformed-record"
  | "stdout-overflow"
  | "shallow-state"
  | "commit-headers-too-large"
  | "malformed-commit"
  | "invalid-object-size"
  | "message-prefix-incomplete"
  | "unsupported-encoding"
  | "malformed-encoding"
  | "metadata-mismatch";

/**
 * Constant-message, JSON-safe failure for the historical operation layer.
 * Raw Git streams, refs, paths, commit messages, and buffers never become
 * fields on this error. Numeric facts are deliberately optional and bounded
 * by the caller's operation limits.
 */
export class GitHistoryOperationError extends CodexProError {
  readonly operation: GitHistoryOperation;
  readonly reason: GitHistoryFailureReason;
  readonly facts: Readonly<Record<string, number>>;

  constructor(operation: GitHistoryOperation, reason: GitHistoryFailureReason, facts: Readonly<Record<string, number>> = {}) {
    super(`Git history ${operation} failed (${reason}).`);
    this.name = "GitHistoryOperationError";
    this.operation = operation;
    this.reason = reason;
    this.facts = { ...facts };
  }

  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      operation: this.operation,
      reason: this.reason,
      facts: this.facts
    };
  }
}

export interface GitMergeBaseResult {
  readonly left: GitReviewRef;
  readonly right: GitReviewRef;
  readonly objectFormat: GitObjectFormat;
  readonly mergeBases: readonly string[];
  readonly leftIsAncestor: boolean | null;
  readonly rightIsAncestor: boolean | null;
  readonly unrelated: boolean | null;
  readonly historyComplete: boolean;
}

export interface GitLogCommit {
  readonly fullSha: string;
  readonly shortSha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committedAt: string;
  readonly subject: string;
}

export interface GitStructuredLogOptions {
  readonly startRef?: string;
  readonly path?: unknown;
  readonly maxCount?: number;
}

export interface GitStructuredLogResult {
  readonly start: GitReviewRef;
  readonly commits: readonly GitLogCommit[];
  readonly hasMore: boolean;
  readonly maxCount: number;
  readonly path?: string;
}

export interface GitShowCommitResult extends GitReviewRef {
  readonly treeSha: string;
  readonly parents: readonly string[];
  readonly isRoot: boolean;
  readonly isMerge: boolean;
  readonly authorName: string;
  readonly authoredAt: string;
  readonly committerName: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
  readonly messageBytes: number;
  readonly messageTruncated: boolean;
}

const LOG_FORMAT = "%H%x00%P%x00%an%x00%aI%x00%cn%x00%cI%x00%s";
const SHOW_FORMAT = "%H%x00%T%x00%P%x00%an%x00%aI%x00%cn%x00%cI%x00";
const SHORT_SHA_LENGTH = 12;
const MESSAGE_PREVIEW_HARD_LIMIT = 60_000;

const UTF8_FATAL = (): TextDecoder => new TextDecoder("utf-8", { fatal: true });

function operationError(
  operation: GitHistoryOperation,
  reason: GitHistoryFailureReason,
  facts: Readonly<Record<string, number>> = {}
): GitHistoryOperationError {
  return new GitHistoryOperationError(operation, reason, facts);
}

function configInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function oidPattern(objectFormat: GitObjectFormat): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/iu : /^[0-9a-f]{64}$/iu;
}

function parseOidText(text: string, objectFormat: GitObjectFormat): string | undefined {
  const normalized = text.toLowerCase();
  return oidPattern(objectFormat).test(normalized) ? normalized : undefined;
}

function decodeUtf8(operation: GitHistoryOperation, bytes: Uint8Array, reason: GitHistoryFailureReason = "malformed-output"): string {
  try {
    return UTF8_FATAL().decode(bytes);
  } catch {
    throw operationError(operation, reason, { bytes: bytes.byteLength });
  }
}

function isEmptyOutput(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) return false;
  }
  return true;
}

function failureReason(error: unknown): GitHistoryFailureReason {
  if (!(error instanceof GitExecutionError)) return "execution";
  if (error.failure === "stdout-overflow") return "stdout-overflow";
  if (error.failure === "exit") {
    const stderr = error.result.copyStderrBytes().toString("utf8").toLowerCase();
    if (
      /(?:bad object|not a valid object|unknown revision|ambiguous argument|missing object|object .* not found|does not exist)/u.test(
        stderr
      )
    ) {
      return "missing-object";
    }
  }
  return "execution";
}

function throwGitFailure(operation: GitHistoryOperation, error: unknown, fallback: GitHistoryFailureReason = "execution"): never {
  if (error instanceof GitHistoryOperationError) throw error;
  throw operationError(operation, error instanceof GitExecutionError ? failureReason(error) : fallback);
}

function parseOidLines(operation: GitHistoryOperation, bytes: Uint8Array, objectFormat: GitObjectFormat): string[] {
  const text = decodeUtf8(operation, bytes);
  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const normalizedLines = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (normalizedLines.some((line) => line.length === 0)) {
    throw operationError(operation, "malformed-output", { bytes: bytes.byteLength });
  }

  const seen = new Set<string>();
  for (const line of normalizedLines) {
    const oid = parseOidText(line, objectFormat);
    if (!oid) throw operationError(operation, "malformed-output", { bytes: bytes.byteLength });
    seen.add(oid);
  }
  return [...seen].sort();
}

function parseParents(operation: GitHistoryOperation, text: string, objectFormat: GitObjectFormat): string[] {
  if (text === "") return [];
  const parts = text.split(" ");
  if (parts.some((part) => part.length === 0)) throw operationError(operation, "malformed-output", { bytes: text.length });
  const parents = parts.map((part) => parseOidText(part, objectFormat));
  if (parents.some((parent) => parent === undefined)) throw operationError(operation, "malformed-output", { bytes: text.length });
  return parents as string[];
}

function splitExplicitNulRecord(operation: GitHistoryOperation, bytes: Uint8Array, fieldsPerRecord: number): Buffer[] {
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0) {
    throw operationError(operation, "malformed-record", { bytes: bytes.byteLength });
  }
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(Buffer.from(bytes.slice(start, index)));
    start = index + 1;
  }
  if (start !== bytes.byteLength || fields.length !== fieldsPerRecord) {
    throw operationError(operation, "malformed-record", { bytes: bytes.byteLength });
  }
  return fields;
}

function stripFormatTerminalLineEnding(bytes: Uint8Array): Uint8Array {
  // `git show --format=...%x00` emits the requested terminal NUL followed by
  // its normal display line ending. Keep the framing exact while admitting
  // that one command-level line ending (and its CRLF spelling).
  if (bytes.length >= 2 && bytes.at(-1) === 0x0a && bytes.at(-2) === 0x00) return bytes.slice(0, -1);
  if (bytes.length >= 3 && bytes.at(-1) === 0x0a && bytes.at(-2) === 0x0d && bytes.at(-3) === 0x00) return bytes.slice(0, -2);
  return bytes;
}

function parseLogRecords(operation: GitHistoryOperation, bytes: Uint8Array, objectFormat: GitObjectFormat): GitLogCommit[] {
  // `git log -z` uses one NUL as the record terminator. Because the fixed
  // format has six explicit separators, that terminator is also the seventh
  // field separator; there is no additional empty token after each record.
  if (bytes.byteLength === 0) return [];
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0) continue;
    fields.push(Buffer.from(bytes.slice(start, index)));
    start = index + 1;
  }
  if (start !== bytes.byteLength || fields.length === 0 || fields.length % 7 !== 0) {
    throw operationError(operation, "malformed-record", { bytes: bytes.byteLength });
  }
  const records: Buffer[][] = [];
  for (let offset = 0; offset < fields.length; offset += 7) records.push(fields.slice(offset, offset + 7));
  return records.map((record) => {
    if (record.length !== 7) throw operationError(operation, "malformed-record", { bytes: bytes.byteLength });
    const commitText = decodeUtf8(operation, record[0]);
    const fullSha = parseOidText(commitText, objectFormat);
    if (!fullSha) throw operationError(operation, "malformed-record", { bytes: record[0].byteLength });
    const parents = parseParents(operation, decodeUtf8(operation, record[1]), objectFormat);
    return {
      fullSha,
      shortSha: fullSha.slice(0, SHORT_SHA_LENGTH),
      parents,
      authorName: decodeUtf8(operation, record[2]),
      authoredAt: decodeUtf8(operation, record[3]),
      committerName: decodeUtf8(operation, record[4]),
      committedAt: decodeUtf8(operation, record[5]),
      subject: decodeUtf8(operation, record[6])
    };
  });
}

function shallowState(operation: GitHistoryOperation, bytes: Uint8Array): boolean {
  const text = decodeUtf8(operation, bytes);
  const record = text.endsWith("\n") ? text.slice(0, -1).replace(/\r$/u, "") : text;
  if (record === "true") return true;
  if (record === "false") return false;
  throw operationError(operation, "shallow-state", { bytes: bytes.byteLength });
}

async function runAndCapture(
  operation: GitHistoryOperation,
  config: GitHistoryConfig,
  workspace: Workspace,
  args: readonly string[],
  options?: { readonly stdoutMaxBytes?: number }
) {
  try {
    return await runGitReadOnly(config, workspace, args, options);
  } catch (error) {
    throwGitFailure(operation, error);
  }
}

async function runAncestorCheck(
  operation: GitHistoryOperation,
  config: GitHistoryConfig,
  workspace: Workspace,
  ancestor: string,
  descendant: string,
  shallow: boolean
): Promise<boolean | null> {
  try {
    await runGitReadOnly(config, workspace, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitExecutionError && error.failure === "exit") {
      const result = error.result;
      if (isEmptyOutput(result.copyStdoutBytes()) && isEmptyOutput(result.copyStderrBytes())) return shallow ? null : false;
    }
    throwGitFailure(operation, error);
  }
}

/** Resolve one historical review ref without changing the accepted ref primitive. */
export async function gitResolveRef(
  config: Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes">,
  workspace: Workspace,
  rawRef: string
): Promise<GitReviewRef> {
  return resolveGitRef(config, workspace, rawRef);
}

/** Resolve two refs once, then inspect only immutable full object IDs. */
export async function gitMergeBase(
  config: GitHistoryConfig,
  workspace: Workspace,
  leftRef: string,
  rightRef: string
): Promise<GitMergeBaseResult> {
  const operation: GitHistoryOperation = "merge-base";
  let left: GitReviewRef;
  let right: GitReviewRef;
  try {
    left = await resolveGitRef(config, workspace, leftRef);
    right = await resolveGitRef(config, workspace, rightRef);
  } catch (error) {
    if (error instanceof GitRefResolutionError) throw error;
    throwGitFailure(operation, error, "ref-resolution");
  }
  if (left.objectFormat !== right.objectFormat) throw operationError(operation, "malformed-output");

  const shallowResult = await runAndCapture(operation, config, workspace, ["rev-parse", "--is-shallow-repository"]);
  const shallow = shallowState(operation, shallowResult.copyStdoutBytes());

  let mergeBases: string[];
  try {
    const mergeBaseResult = await runGitReadOnly(config, workspace, ["merge-base", "--all", left.fullSha, right.fullSha]);
    mergeBases = parseOidLines(operation, mergeBaseResult.copyStdoutBytes(), left.objectFormat);
  } catch (error) {
    if (
      error instanceof GitExecutionError &&
      error.failure === "exit" &&
      isEmptyOutput(error.result.copyStdoutBytes()) &&
      isEmptyOutput(error.result.copyStderrBytes())
    ) {
      mergeBases = [];
    } else {
      throwGitFailure(operation, error);
    }
  }

  const [leftIsAncestor, rightIsAncestor] = await Promise.all([
    runAncestorCheck(operation, config, workspace, left.fullSha, right.fullSha, shallow),
    runAncestorCheck(operation, config, workspace, right.fullSha, left.fullSha, shallow)
  ]);
  const historyComplete = !shallow;
  return {
    left,
    right,
    objectFormat: left.objectFormat,
    mergeBases,
    leftIsAncestor,
    rightIsAncestor,
    unrelated: mergeBases.length === 0 ? (historyComplete ? true : null) : false,
    historyComplete
  };
}

/** Read fixed NUL-delimited commit records, resolving the start ref once. */
export async function gitLogStructured(
  config: GitHistoryConfig,
  guard: Pick<PathGuard, "isBlockedRelativePath">,
  workspace: Workspace,
  options: GitStructuredLogOptions = {}
): Promise<GitStructuredLogResult> {
  const operation: GitHistoryOperation = "log";
  const maxCount = options.maxCount === undefined ? 20 : options.maxCount;
  if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 100) throw operationError(operation, "invalid-limit");

  let canonicalPath: string | undefined;
  if (options.path !== undefined) {
    try {
      canonicalPath = validateHistoricalPath(guard, options.path);
    } catch {
      throw operationError(operation, "invalid-path");
    }
  }

  const startRef = options.startRef ?? "HEAD";
  let start: GitReviewRef;
  try {
    start = await resolveGitRef(config, workspace, startRef);
  } catch (error) {
    if (error instanceof GitRefResolutionError) throw error;
    throwGitFailure(operation, error, "ref-resolution");
  }

  const args = [
    "-c",
    "i18n.logOutputEncoding=UTF-8",
    "log",
    "-z",
    "--no-patch",
    "--no-decorate",
    "--no-notes",
    "--no-show-signature",
    `--max-count=${maxCount + 1}`,
    `--format=${LOG_FORMAT}`,
    start.fullSha
  ];
  if (canonicalPath !== undefined) args.push("--", `:(literal)${canonicalPath}`);

  const result = await runAndCapture(operation, config, workspace, args);
  const records = parseLogRecords(operation, result.copyStdoutBytes(), start.objectFormat);
  const hasMore = records.length > maxCount;
  return {
    start,
    commits: hasMore ? records.slice(0, maxCount) : records,
    hasMore,
    maxCount,
    ...(canonicalPath === undefined ? {} : { path: canonicalPath })
  };
}

interface CommitHeaderInfo {
  readonly treeSha?: string;
  readonly parents: readonly string[];
  readonly encoding?: string;
}

function indexOfDoubleLineFeed(bytes: Uint8Array): number {
  for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) return index;
  }
  return -1;
}

function headerKey(bytes: Uint8Array): string | undefined {
  try {
    const key = UTF8_FATAL().decode(bytes);
    return /^[A-Za-z][A-Za-z0-9-]*$/u.test(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

function parseCommitHeaders(
  operation: GitHistoryOperation,
  bytes: Uint8Array,
  objectFormat: GitObjectFormat
): CommitHeaderInfo {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    if (index !== bytes.byteLength && bytes[index] !== 0x0a) continue;
    lines.push(bytes.slice(start, index));
    start = index + 1;
  }
  if (lines.length === 0 || lines.some((line) => line.byteLength === 0)) {
    throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
  }

  let currentKey: string | undefined;
  let treeSha: string | undefined;
  const parents: string[] = [];
  let encoding: string | undefined;
  for (const line of lines) {
    if (line[0] === 0x20) {
      if (!currentKey) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
      continue;
    }
    const space = line.indexOf(0x20);
    if (space <= 0) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
    const key = headerKey(line.slice(0, space));
    if (!key) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
    currentKey = key;
    const value = line.slice(space + 1);
    if (key === "tree") {
      if (treeSha !== undefined) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
      const parsed = parseOidText(decodeUtf8(operation, value, "malformed-commit"), objectFormat);
      if (!parsed) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
      treeSha = parsed;
    } else if (key === "parent") {
      const parsed = parseOidText(decodeUtf8(operation, value, "malformed-commit"), objectFormat);
      if (!parsed) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
      parents.push(parsed);
    } else if (key === "encoding") {
      if (encoding !== undefined || value.byteLength === 0) throw operationError(operation, "malformed-encoding", { bytes: bytes.byteLength });
      encoding = decodeUtf8(operation, value, "malformed-encoding");
      if (!/^[^\u0000-\u0020\u007f]+$/u.test(encoding)) throw operationError(operation, "malformed-encoding", { bytes: value.byteLength });
    }
  }
  if (treeSha === undefined) throw operationError(operation, "malformed-commit", { bytes: bytes.byteLength });
  return { treeSha, parents, encoding };
}

function parseObjectSize(operation: GitHistoryOperation, bytes: Uint8Array): number {
  const text = decodeUtf8(operation, bytes, "invalid-object-size");
  if (!/^\d+(?:\r?\n)?$/u.test(text)) throw operationError(operation, "invalid-object-size", { bytes: bytes.byteLength });
  const numericText = text.endsWith("\n") ? text.slice(0, -1).replace(/\r$/u, "") : text;
  const value = Number(numericText);
  if (!Number.isSafeInteger(value) || value < 0) throw operationError(operation, "invalid-object-size", { bytes: bytes.byteLength });
  return value;
}

function messageDecoder(operation: GitHistoryOperation, encoding: string | undefined, bytes: Uint8Array): TextDecoder {
  try {
    return new TextDecoder(encoding ?? "utf-8", { fatal: true });
  } catch {
    throw operationError(operation, "unsupported-encoding", { bytes: bytes.byteLength });
  }
}

function splitSubjectBody(decoded: string): { readonly subject: string; readonly body: string } {
  const newline = decoded.indexOf("\n");
  if (newline < 0) return { subject: decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded, body: "" };
  const subjectRaw = decoded.slice(0, newline);
  const subject = subjectRaw.endsWith("\r") ? subjectRaw.slice(0, -1) : subjectRaw;
  let body = decoded.slice(newline + 1);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { subject, body };
}

/** Read fixed commit metadata and an exact, bounded commit-message preview. */
export async function gitShowCommit(
  config: GitHistoryConfig,
  workspace: Workspace,
  rawRef: string
): Promise<GitShowCommitResult> {
  const operation: GitHistoryOperation = "show-commit";
  let resolved: GitReviewRef;
  try {
    resolved = await resolveGitRef(config, workspace, rawRef);
  } catch (error) {
    if (error instanceof GitRefResolutionError) throw error;
    throwGitFailure(operation, error, "ref-resolution");
  }

  const metadataResult = await runAndCapture(operation, config, workspace, [
    "-c",
    "i18n.logOutputEncoding=UTF-8",
    "show",
    "--no-patch",
    "--no-notes",
    "--no-show-signature",
    `--format=${SHOW_FORMAT}`,
    resolved.fullSha
  ]);
  const metadataBytes = stripFormatTerminalLineEnding(metadataResult.copyStdoutBytes());
  const metadataFields = splitExplicitNulRecord(operation, metadataBytes, 7);
  if (metadataFields.length !== 7) {
    throw operationError(operation, "malformed-record", { bytes: metadataBytes.byteLength });
  }
  const [commitBytes, treeBytes, parentsBytes, authorBytes, authoredAtBytes, committerBytes, committedAtBytes] = metadataFields;
  const metadataCommit = parseOidText(decodeUtf8(operation, commitBytes), resolved.objectFormat);
  const treeSha = parseOidText(decodeUtf8(operation, treeBytes), resolved.objectFormat);
  if (!metadataCommit || !treeSha || metadataCommit !== resolved.fullSha) {
    throw operationError(operation, "metadata-mismatch", { bytes: metadataBytes.byteLength });
  }
  const parents = parseParents(operation, decodeUtf8(operation, parentsBytes), resolved.objectFormat);

  const rawCaptureCeiling = Math.max(
    configInteger(config.maxReadBytes, configInteger(config.maxOutputBytes, 0)),
    configInteger(config.maxOutputBytes, 0)
  );
  const maxOutputBytes = configInteger(config.maxOutputBytes, 0);
  const messagePreviewLimit = Math.min(MESSAGE_PREVIEW_HARD_LIMIT, maxOutputBytes, Math.floor(rawCaptureCeiling / 2));
  const headerBudget = rawCaptureCeiling - messagePreviewLimit;

  const sizeResult = await runAndCapture(operation, config, workspace, ["cat-file", "-s", resolved.fullSha]);
  const objectSize = parseObjectSize(operation, sizeResult.copyStdoutBytes());
  const expectedCaptureBytes = Math.min(objectSize, rawCaptureCeiling);

  let objectBytes: Buffer;
  let captureOverflow = false;
  try {
    const objectResult = await runGitReadOnly(
      config,
      workspace,
      ["cat-file", "commit", resolved.fullSha],
      { stdoutMaxBytes: rawCaptureCeiling }
    );
    objectBytes = objectResult.copyStdoutBytes();
    captureOverflow = objectResult.stdoutOverflow;
  } catch (error) {
    if (
      error instanceof GitExecutionError &&
      error.failure === "stdout-overflow" &&
      objectSize > rawCaptureCeiling
    ) {
      objectBytes = error.result.copyStdoutBytes();
      captureOverflow = true;
    } else {
      throwGitFailure(operation, error);
    }
  }
  if (objectBytes.byteLength < expectedCaptureBytes) {
    throw operationError(operation, "message-prefix-incomplete", { bytes: objectBytes.byteLength, expected: expectedCaptureBytes });
  }
  if (!captureOverflow && objectSize > rawCaptureCeiling) {
    throw operationError(operation, "message-prefix-incomplete", { bytes: objectBytes.byteLength, expected: expectedCaptureBytes });
  }

  const delimiterIndex = indexOfDoubleLineFeed(objectBytes);
  if (delimiterIndex < 0) {
    throw operationError(operation, objectSize > rawCaptureCeiling ? "commit-headers-too-large" : "malformed-commit", {
      bytes: objectBytes.byteLength,
      limit: headerBudget
    });
  }
  const delimiterEnd = delimiterIndex + 2;
  if (delimiterEnd > headerBudget) {
    throw operationError(operation, "commit-headers-too-large", { bytes: delimiterEnd, limit: headerBudget });
  }
  const headers = parseCommitHeaders(operation, objectBytes.slice(0, delimiterIndex), resolved.objectFormat);
  if (headers.treeSha !== treeSha || headers.parents.length !== parents.length || headers.parents.some((parent, index) => parent !== parents[index])) {
    throw operationError(operation, "metadata-mismatch", { bytes: delimiterEnd });
  }

  const messageBytes = objectSize - delimiterEnd;
  if (messageBytes < 0) throw operationError(operation, "malformed-commit", { bytes: objectSize, delimiter: delimiterEnd });
  const messageTruncated = messageBytes > messagePreviewLimit;
  const previewBytesWanted = Math.min(messageBytes, messagePreviewLimit);
  const previewStart = delimiterEnd;
  const previewEnd = previewStart + previewBytesWanted;
  if (objectBytes.byteLength < previewEnd) {
    throw operationError(operation, "message-prefix-incomplete", { bytes: objectBytes.byteLength, expected: previewEnd });
  }

  const previewBytes = objectBytes.slice(previewStart, previewEnd);
  const decoder = messageDecoder(operation, headers.encoding, previewBytes);
  let decodedPreview: string;
  try {
    decodedPreview = decoder.decode(previewBytes, { stream: messageTruncated });
  } catch {
    throw operationError(operation, "malformed-encoding", { bytes: previewBytes.byteLength });
  }
  const { subject, body } = splitSubjectBody(decodedPreview);
  return {
    ...resolved,
    treeSha,
    parents,
    isRoot: parents.length === 0,
    isMerge: parents.length > 1,
    authorName: decodeUtf8(operation, authorBytes),
    authoredAt: decodeUtf8(operation, authoredAtBytes),
    committerName: decodeUtf8(operation, committerBytes),
    committedAt: decodeUtf8(operation, committedAtBytes),
    subject,
    body,
    messageBytes,
    messageTruncated
  };
}

// Clear aliases for callers that prefer operation-oriented names.
export const resolveHistoricalCommit = gitResolveRef;
export const mergeHistoricalBases = gitMergeBase;
export const structuredGitLog = gitLogStructured;
export const showHistoricalCommit = gitShowCommit;
