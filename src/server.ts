import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { WorkspaceManager, PathGuard, CodexProError, type Workspace } from "./guard.js";
import { processIsAlive, readRuntimeConnection, readRuntimeFailure } from "./profileStore.js";
import { repoTree, readPublicTextFile, readTextFile, writeTextFile, editTextFile, ensureAiBridge, withFileWriteLocks, type ReadFileResult } from "./fsOps.js";
import { viewWorkspaceImage } from "./imageOps.js";
import { importAttachmentFile } from "./importOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import { gitDiff, gitDiffStatus, gitLog, gitStatus } from "./gitOps.js";
import { gitDiffRange } from "./gitDiffRange.js";
import { gitLogStructured, gitMergeBase, gitResolveRef, gitShowCommit } from "./gitHistoryOps.js";
import { readAtRef } from "./gitHistoricalBlob.js";
import { GIT_COMMIT_MAX_MESSAGE_BYTES, GIT_COMMIT_MAX_PATH_BYTES, GIT_COMMIT_MAX_PATHS, gitCommit } from "./gitCommit.js";
import { readAiBridgeContext, readCodexContext, workspaceSummary } from "./workspaceOps.js";
import { buildProContext, exportProContext } from "./proContext.js";
import { codexproInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { hasSecretValueInUnifiedDiff, redactDiagnosticStructured, redactDiagnosticText, redactSensitiveText, redactStructured, redactUnifiedDiff, sourceLanguageForPath, truncateUtf8 } from "./redact.js";
import { inspectWorkspace, invalidateWorkspaceAnalysis, reviewWorkspaceChanges } from "./analysis/index.js";

const STRUCTURED_STRING_MAX_CHARS = 30_000;
const RUNTIME_STATUS_FAILURE_DETAIL_MAX_BYTES = 2_048;
// read_many owns a smaller aggregate response contract than the single-read
// path. maxOutputBytes is not a universal read cap, but it remains the outer
// configured ceiling when it is lower than this tool's own maximum.
const READ_MANY_MAX_ITEMS = 32;
const READ_MANY_MIN_TOTAL_BYTES = 4_000;
const READ_MANY_DEFAULT_MAX_TOTAL_BYTES = 60_000;
const READ_MANY_MAX_TOTAL_BYTES = 100_000;
const READ_MANY_RESPONSE_FRAMING_RESERVE_BYTES = 1_024;
const READ_MANY_MAX_PATH_CHARS = 2_000;
const READ_MANY_MAX_ERROR_CHARS = 512;

const REVIEW_REF_MAX_BYTES = 512;
const REVIEW_PATH_MAX_BYTES = 4_096;
const REVIEW_MAX_COUNT = 100;
const REVIEW_DEFAULT_MAX_COUNT = 20;

const REVIEW_WORKSPACE_ID_SCHEMA = z.string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value, "workspace_id must not have surrounding whitespace.")
  .describe("Explicit workspace id from open_current_workspace or open_workspace.");

const REVIEW_REF_SCHEMA = z.string()
  .min(1)
  .max(REVIEW_REF_MAX_BYTES)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= REVIEW_REF_MAX_BYTES &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !value.startsWith("-"),
    "ref must be a bounded commit-ish without controls, surrounding whitespace, or option-looking input."
  )
  .describe("Bounded local commit-ish such as HEAD, a branch, tag, SHA, or HEAD~1.");

const REVIEW_PATH_SCHEMA = z.string()
  .min(1)
  .max(REVIEW_PATH_MAX_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= REVIEW_PATH_MAX_BYTES,
    `path must be at most ${REVIEW_PATH_MAX_BYTES} UTF-8 bytes.`
  )
  .describe("Historical repository-tree path; it need not exist in the current checkout.");

const REVIEW_LINE_SCHEMA = z.number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const GIT_RESOLVE_REF_ARGUMENTS_SCHEMA = z.object({
  workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
  ref: REVIEW_REF_SCHEMA
}).strict();

const GIT_MERGE_BASE_ARGUMENTS_SCHEMA = z.object({
  workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
  left_ref: REVIEW_REF_SCHEMA,
  right_ref: REVIEW_REF_SCHEMA
}).strict();

const GIT_LOG_ARGUMENTS_SCHEMA = z.object({
  workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
  start_ref: REVIEW_REF_SCHEMA.default("HEAD"),
  path: REVIEW_PATH_SCHEMA.optional(),
  max_count: z.number().int().min(1).max(REVIEW_MAX_COUNT).default(REVIEW_DEFAULT_MAX_COUNT)
}).strict();

const GIT_SHOW_COMMIT_ARGUMENTS_SCHEMA = z.object({
  workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
  ref: REVIEW_REF_SCHEMA
}).strict();

const GIT_DIFF_RANGE_ARGUMENTS_SCHEMA = z.object({
  workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
  base_ref: REVIEW_REF_SCHEMA,
  head_ref: REVIEW_REF_SCHEMA,
  path: REVIEW_PATH_SCHEMA.optional(),
  include_patch: z.boolean().default(true),
  max_files: z.number().int().min(1).max(200).default(100),
  max_patch_bytes: z.number().int().min(0).max(100_000).default(60_000),
  context_lines: z.number().int().min(0).max(20).default(3)
}).strict();

const GIT_DIFF_RANGE_FIELD_NAMES = new Set([
  "workspace_id",
  "base_ref",
  "head_ref",
  "path",
  "include_patch",
  "max_files",
  "max_patch_bytes",
  "context_lines"
]);

function boundedGitDiffRangeValidationError(issues: readonly z.ZodIssue[]): z.ZodError {
  const safeIssues: z.ZodIssue[] = [];
  const seenMessages = new Set<string>();
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      if (!seenMessages.has("Unknown keys are not allowed.")) {
        safeIssues.push({ code: "custom", path: [], message: "Unknown keys are not allowed." });
        seenMessages.add("Unknown keys are not allowed.");
      }
      continue;
    }

    const field = issue.path.length === 1 && typeof issue.path[0] === "string" && GIT_DIFF_RANGE_FIELD_NAMES.has(issue.path[0])
      ? issue.path[0]
      : undefined;
    const message = field === "workspace_id" && issue.code === "invalid_type" && issue.received === "undefined"
      ? "Workspace id is required."
      : field
        ? "Invalid value."
        : "Schema constraints were not satisfied.";
    const path = field ? [field] : [];
    const key = `${path.join(".")}:${message}`;
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);
    safeIssues.push({ code: "custom", path, message });
  }

  if (safeIssues.length === 0) {
    safeIssues.push({ code: "custom", path: [], message: "Schema constraints were not satisfied." });
  }
  return new z.ZodError(safeIssues);
}

// Keep the strict schema for runtime rejection, but discard Zod's raw issue
// payload before validateToolArgs can format a public diagnostic. In
// particular, unrecognized_keys carries caller-controlled property names.
const GIT_DIFF_RANGE_RUNTIME_SCHEMA = z.object(GIT_DIFF_RANGE_ARGUMENTS_SCHEMA.shape).strict();
const rawGitDiffRangeSafeParse = GIT_DIFF_RANGE_RUNTIME_SCHEMA.safeParse.bind(GIT_DIFF_RANGE_RUNTIME_SCHEMA);
GIT_DIFF_RANGE_RUNTIME_SCHEMA.safeParse = ((args: unknown) => {
  const parsed = rawGitDiffRangeSafeParse(args);
  return parsed.success
    ? parsed
    : { success: false, error: boundedGitDiffRangeValidationError(parsed.error.issues) };
}) as typeof GIT_DIFF_RANGE_RUNTIME_SCHEMA.safeParse;
const rawGitDiffRangeSafeParseAsync = GIT_DIFF_RANGE_RUNTIME_SCHEMA.safeParseAsync.bind(GIT_DIFF_RANGE_RUNTIME_SCHEMA);
GIT_DIFF_RANGE_RUNTIME_SCHEMA.safeParseAsync = (async (args: unknown) => {
  const parsed = await rawGitDiffRangeSafeParseAsync(args);
  return parsed.success
    ? parsed
    : { success: false, error: boundedGitDiffRangeValidationError(parsed.error.issues) };
}) as typeof GIT_DIFF_RANGE_RUNTIME_SCHEMA.safeParseAsync;

// The MCP SDK uses the published Zod object for both tools/list conversion
// and transport-level tools/call validation. Keep a bounded, permissive
// envelope at that boundary so caller-controlled unknown key names cannot be
// copied into an SDK validation error. The strict schemas above remain the
// runtime source of truth and are applied by registerCodexTool.
const GIT_RESOLVE_REF_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  ref: z.unknown().optional()
}).passthrough();
const GIT_RESOLVE_REF_PUBLIC_SCHEMA = z.object(GIT_RESOLVE_REF_ARGUMENTS_SCHEMA.shape).strict();
GIT_RESOLVE_REF_PUBLIC_SCHEMA.safeParse = ((args: unknown) => GIT_RESOLVE_REF_TRANSPORT_SCHEMA.safeParse(args)) as typeof GIT_RESOLVE_REF_PUBLIC_SCHEMA.safeParse;
GIT_RESOLVE_REF_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => GIT_RESOLVE_REF_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof GIT_RESOLVE_REF_PUBLIC_SCHEMA.safeParseAsync;

const GIT_MERGE_BASE_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  left_ref: z.unknown().optional(),
  right_ref: z.unknown().optional()
}).passthrough();
const GIT_MERGE_BASE_PUBLIC_SCHEMA = z.object(GIT_MERGE_BASE_ARGUMENTS_SCHEMA.shape).strict();
GIT_MERGE_BASE_PUBLIC_SCHEMA.safeParse = ((args: unknown) => GIT_MERGE_BASE_TRANSPORT_SCHEMA.safeParse(args)) as typeof GIT_MERGE_BASE_PUBLIC_SCHEMA.safeParse;
GIT_MERGE_BASE_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => GIT_MERGE_BASE_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof GIT_MERGE_BASE_PUBLIC_SCHEMA.safeParseAsync;

const GIT_LOG_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  start_ref: z.unknown().optional(),
  path: z.unknown().optional(),
  max_count: z.unknown().optional()
}).passthrough();
const GIT_LOG_PUBLIC_SCHEMA = z.object(GIT_LOG_ARGUMENTS_SCHEMA.shape).strict();
GIT_LOG_PUBLIC_SCHEMA.safeParse = ((args: unknown) => GIT_LOG_TRANSPORT_SCHEMA.safeParse(args)) as typeof GIT_LOG_PUBLIC_SCHEMA.safeParse;
GIT_LOG_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => GIT_LOG_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof GIT_LOG_PUBLIC_SCHEMA.safeParseAsync;

const GIT_SHOW_COMMIT_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  ref: z.unknown().optional()
}).passthrough();
const GIT_SHOW_COMMIT_PUBLIC_SCHEMA = z.object(GIT_SHOW_COMMIT_ARGUMENTS_SCHEMA.shape).strict();
GIT_SHOW_COMMIT_PUBLIC_SCHEMA.safeParse = ((args: unknown) => GIT_SHOW_COMMIT_TRANSPORT_SCHEMA.safeParse(args)) as typeof GIT_SHOW_COMMIT_PUBLIC_SCHEMA.safeParse;
GIT_SHOW_COMMIT_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => GIT_SHOW_COMMIT_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof GIT_SHOW_COMMIT_PUBLIC_SCHEMA.safeParseAsync;

const GIT_DIFF_RANGE_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  base_ref: z.unknown().optional(),
  head_ref: z.unknown().optional(),
  path: z.unknown().optional(),
  include_patch: z.unknown().optional(),
  max_files: z.unknown().optional(),
  max_patch_bytes: z.unknown().optional(),
  context_lines: z.unknown().optional()
}).passthrough();
const GIT_DIFF_RANGE_PUBLIC_SCHEMA = z.object(GIT_DIFF_RANGE_ARGUMENTS_SCHEMA.shape).strict();
GIT_DIFF_RANGE_PUBLIC_SCHEMA.safeParse = ((args: unknown) => GIT_DIFF_RANGE_TRANSPORT_SCHEMA.safeParse(args)) as typeof GIT_DIFF_RANGE_PUBLIC_SCHEMA.safeParse;
GIT_DIFF_RANGE_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => GIT_DIFF_RANGE_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof GIT_DIFF_RANGE_PUBLIC_SCHEMA.safeParseAsync;

const GIT_COMMIT_PATH_SCHEMA = z.string()
  .min(1)
  .max(GIT_COMMIT_MAX_PATH_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= GIT_COMMIT_MAX_PATH_BYTES,
    `path must be at most ${GIT_COMMIT_MAX_PATH_BYTES} UTF-8 bytes.`
  );

const GIT_COMMIT_ARGUMENTS_SCHEMA = z.object({
  workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
  paths: z.array(GIT_COMMIT_PATH_SCHEMA)
    .min(1)
    .max(GIT_COMMIT_MAX_PATHS)
    .describe(`One to ${GIT_COMMIT_MAX_PATHS} explicit repository-relative file or symlink identities.`),
  message: z.string()
    .min(1)
    .max(GIT_COMMIT_MAX_MESSAGE_BYTES)
    .refine(
      (value) => Buffer.byteLength(value, "utf8") <= GIT_COMMIT_MAX_MESSAGE_BYTES,
      `message must be at most ${GIT_COMMIT_MAX_MESSAGE_BYTES} UTF-8 bytes.`
    )
    .refine((value) => value.trim().length > 0, "message must not be empty.")
    .refine((value) => !value.includes("\u0000"), "message must not contain NUL."),
  expected_head: z.string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu, "expected_head must be a full commit SHA.")
    .describe("Exact full current commit SHA; ref names and abbreviated SHAs are rejected.")
}).strict();

const GIT_COMMIT_FIELD_NAMES = new Set(["workspace_id", "paths", "message", "expected_head"]);

function boundedGitCommitValidationError(issues: readonly z.ZodIssue[]): z.ZodError {
  const safeIssues: z.ZodIssue[] = [];
  const seenMessages = new Set<string>();
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      if (!seenMessages.has("Unknown keys are not allowed.")) {
        safeIssues.push({ code: "custom", path: [], message: "Unknown keys are not allowed." });
        seenMessages.add("Unknown keys are not allowed.");
      }
      continue;
    }

    const field = issue.path.length > 0 && typeof issue.path[0] === "string" && GIT_COMMIT_FIELD_NAMES.has(issue.path[0])
      ? issue.path[0]
      : undefined;
    const message = field === "workspace_id" && issue.code === "invalid_type" && issue.received === "undefined"
      ? "Workspace id is required."
      : field
        ? "Invalid value."
        : "Schema constraints were not satisfied.";
    const path = field ? [field] : [];
    const key = `${path.join(".")}:${message}`;
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);
    safeIssues.push({ code: "custom", path, message });
  }

  if (safeIssues.length === 0) {
    safeIssues.push({ code: "custom", path: [], message: "Schema constraints were not satisfied." });
  }
  return new z.ZodError(safeIssues);
}

// The SDK uses the published Zod object for both tools/list conversion and
// transport-level tools/call validation. Keep this boundary permissive so
// hostile unknown key names/values never enter an SDK-generated error; the
// strict runtime schema above remains the source of truth in the handler.
const GIT_COMMIT_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  paths: z.unknown().optional(),
  message: z.unknown().optional(),
  expected_head: z.unknown().optional()
}).passthrough();
const GIT_COMMIT_PUBLIC_SCHEMA = z.object(GIT_COMMIT_ARGUMENTS_SCHEMA.shape).strict();
const rawGitCommitSafeParse = GIT_COMMIT_ARGUMENTS_SCHEMA.safeParse.bind(GIT_COMMIT_ARGUMENTS_SCHEMA);
GIT_COMMIT_ARGUMENTS_SCHEMA.safeParse = ((args: unknown) => {
  const parsed = rawGitCommitSafeParse(args);
  return parsed.success
    ? parsed
    : { success: false, error: boundedGitCommitValidationError(parsed.error.issues) };
}) as typeof GIT_COMMIT_ARGUMENTS_SCHEMA.safeParse;
const rawGitCommitSafeParseAsync = GIT_COMMIT_ARGUMENTS_SCHEMA.safeParseAsync.bind(GIT_COMMIT_ARGUMENTS_SCHEMA);
GIT_COMMIT_ARGUMENTS_SCHEMA.safeParseAsync = (async (args: unknown) => {
  const parsed = await rawGitCommitSafeParseAsync(args);
  return parsed.success
    ? parsed
    : { success: false, error: boundedGitCommitValidationError(parsed.error.issues) };
}) as typeof GIT_COMMIT_ARGUMENTS_SCHEMA.safeParseAsync;
GIT_COMMIT_PUBLIC_SCHEMA.safeParse = ((args: unknown) => GIT_COMMIT_TRANSPORT_SCHEMA.safeParse(args)) as typeof GIT_COMMIT_PUBLIC_SCHEMA.safeParse;
GIT_COMMIT_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => GIT_COMMIT_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof GIT_COMMIT_PUBLIC_SCHEMA.safeParseAsync;

const READ_AT_REF_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional(),
  ref: z.unknown().optional(),
  path: z.unknown().optional(),
  start_line: z.unknown().optional(),
  end_line: z.unknown().optional(),
  max_bytes: z.unknown().optional()
}).passthrough();

function readAtRefArgumentsSchema(maxReadBytes: number) {
  const boundedMaxReadBytes = Math.max(1, Math.floor(maxReadBytes));
  return z.object({
    workspace_id: REVIEW_WORKSPACE_ID_SCHEMA,
    ref: REVIEW_REF_SCHEMA,
    path: REVIEW_PATH_SCHEMA,
    start_line: REVIEW_LINE_SCHEMA.optional(),
    end_line: REVIEW_LINE_SCHEMA.optional(),
    max_bytes: z.number().int().min(1).max(boundedMaxReadBytes).optional()
  }).strict();
}

function readAtRefPublicSchemas(maxReadBytes: number) {
  const runtimeSchema = readAtRefArgumentsSchema(maxReadBytes);
  const publicSchema = z.object(runtimeSchema.shape).strict();
  publicSchema.safeParse = ((args: unknown) => READ_AT_REF_TRANSPORT_SCHEMA.safeParse(args)) as typeof publicSchema.safeParse;
  publicSchema.safeParseAsync = ((args: unknown) => READ_AT_REF_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof publicSchema.safeParseAsync;
  return { publicSchema, runtimeSchema };
}

const READ_MANY_ITEM_SCHEMA = z.object({
  path: z.string()
    .min(1)
    .max(READ_MANY_MAX_PATH_CHARS)
    .refine((value) => value.trim().length > 0, "path must not be empty"),
  start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
  end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
  max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
}).strict();

const READ_MANY_ARGUMENTS_SCHEMA = z.object({
  workspace_id: z.string().optional().describe("Workspace id for the entire batch from open_workspace. Per-item workspace ids are not accepted."),
  items: z.array(READ_MANY_ITEM_SCHEMA)
    .min(1)
    .max(READ_MANY_MAX_ITEMS)
    .describe(`Non-empty ordered batch of at most ${READ_MANY_MAX_ITEMS} text-file reads.`),
  max_total_bytes: z.number().int().min(READ_MANY_MIN_TOTAL_BYTES).max(READ_MANY_MAX_TOTAL_BYTES).optional().describe(`Hard serialized response budget in bytes. Default: ${READ_MANY_DEFAULT_MAX_TOTAL_BYTES}; minimum: ${READ_MANY_MIN_TOTAL_BYTES}; maximum: ${READ_MANY_MAX_TOTAL_BYTES}.`)
}).strict();

// The MCP SDK validates tool arguments before invoking the handler. Keep this
// transport envelope permissive so high-cardinality unknown keys cannot be
// expanded into an SDK-generated validation result. READ_MANY_ARGUMENTS_SCHEMA
// below remains the strict source of truth and is formatted by RepoConnect.
const READ_MANY_TRANSPORT_SCHEMA = z.object({
  workspace_id: z.unknown().optional().describe("Workspace id for the entire batch from open_workspace."),
  items: z.unknown().optional().describe(`Ordered batch of at most ${READ_MANY_MAX_ITEMS} text-file reads.`),
  max_total_bytes: z.unknown().optional().describe(`Serialized response budget in bytes. Default: ${READ_MANY_DEFAULT_MAX_TOTAL_BYTES}; minimum: ${READ_MANY_MIN_TOTAL_BYTES}; maximum: ${READ_MANY_MAX_TOTAL_BYTES}.`)
}).passthrough();

// The SDK uses one schema for both tools/list JSON conversion and tools/call
// validation. Publish the strict shape while delegating SDK validation to the
// permissive transport envelope; RepoConnect then applies the bounded strict
// READ_MANY_ARGUMENTS_SCHEMA parser in the handler path.
const READ_MANY_PUBLIC_SCHEMA = z.object(READ_MANY_ARGUMENTS_SCHEMA.shape).strict();
READ_MANY_PUBLIC_SCHEMA.safeParse = ((args: unknown) => READ_MANY_TRANSPORT_SCHEMA.safeParse(args)) as typeof READ_MANY_PUBLIC_SCHEMA.safeParse;
READ_MANY_PUBLIC_SCHEMA.safeParseAsync = ((args: unknown) => READ_MANY_TRANSPORT_SCHEMA.safeParseAsync(args)) as typeof READ_MANY_PUBLIC_SCHEMA.safeParseAsync;

type ReadManyItem = z.infer<typeof READ_MANY_ITEM_SCHEMA>;
type ReadManyArguments = z.infer<typeof READ_MANY_ARGUMENTS_SCHEMA>;

type ReadManyResult =
  | { index: number; path: string; ok: true; result: ReadFileResult }
  | { index: number; path: string; ok: false; error: string };

// Public source bodies are redacted against the complete file before they are
// placed in a response. Keep that body as an explicit typed exception to the
// generic response pass; all paths, hashes, framing, errors, and other
// metadata continue through recursive redaction. Text responses use typed
// segments so a body is protected at the exact construction site rather than
// by searching for a duplicate value in the finished response.
type PublicSourceBody = { readonly kind: "public-source-body"; readonly text: string };
type PublicTextNormal = { readonly kind: "normal"; readonly text: string };
type PublicTextSegment = PublicTextNormal | PublicSourceBody;
type PublicSourceField = { readonly path: readonly (string | number)[]; readonly body: PublicSourceBody };
type TextResultOptions = {
  readonly sourceFields?: readonly PublicSourceField[];
};

function publicSourceBody(text: string): PublicSourceBody {
  return { kind: "public-source-body", text };
}

function redactPublicTextSegments(text: string | readonly PublicTextSegment[]): string {
  const segments: readonly PublicTextSegment[] = typeof text === "string"
    ? [{ kind: "normal", text }]
    : text;
  let output = "";
  let normalText = "";
  const flushNormal = () => {
    if (!normalText) return;
    output += redactSensitiveText(normalText);
    normalText = "";
  };
  for (const segment of segments) {
    if (segment.kind === "public-source-body") {
      flushNormal();
      output += segment.text;
    } else {
      normalText += segment.text;
    }
  }
  flushNormal();
  return output;
}

function samePublicSourcePath(left: readonly (string | number)[], right: readonly (string | number)[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function redactStructuredPreservingSourceFields(
  value: unknown,
  fields: readonly PublicSourceField[],
  path: readonly (string | number)[] = [],
  depth = 0
): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  const sourceField = fields.find((field) => samePublicSourcePath(field.path, path));
  if (sourceField && typeof value === "string") return value;
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => redactStructuredPreservingSourceFields(item, fields, [...path, index], depth + 1));
  }
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactStructuredPreservingSourceFields(item, fields, [...path, key], depth + 1);
  }
  return out;
}

function boundedReadManyError(error: unknown): string {
  const value = errorText(error);
  if (value.length <= READ_MANY_MAX_ERROR_CHARS) return value;
  return `${value.slice(0, READ_MANY_MAX_ERROR_CHARS - 20)}...[error truncated]`;
}

function boundedReadManyValidationError(issues: readonly z.ZodIssue[]): CodexProError {
  const categories = new Set<string>();
  for (const issue of issues) {
    switch (issue.code) {
      case "unrecognized_keys":
        categories.add("unexpected keys");
        break;
      case "invalid_type":
        categories.add("invalid field types");
        break;
      case "too_small":
        categories.add("values below allowed limits");
        break;
      case "too_big":
        categories.add("values above allowed limits");
        break;
      default:
        categories.add("schema constraints");
        break;
    }
  }
  const summary = categories.size > 0 ? [...categories].join(", ") : "schema constraints";
  return new CodexProError(`Invalid arguments for read_many: ${summary}. Unknown keys and invalid values are rejected.`);
}

function parseReadManyArguments(args: unknown): ReadManyArguments {
  const parsed = READ_MANY_ARGUMENTS_SCHEMA.safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  throw boundedReadManyValidationError(parsed.error.issues);
}

function readManyText(workspace: Workspace, results: ReadManyResult[], maxTotalBytes: number): readonly PublicTextSegment[] {
  const parts: Array<string | PublicSourceBody> = [
    "# Read Many",
    "",
    `Workspace: ${workspace.root}`,
    `Items returned: ${results.length}`,
    `Aggregate response budget: ${maxTotalBytes} bytes`,
    ""
  ];
  for (const item of results) {
    if (item.ok) {
      parts.push(
        `- [${item.index}] ${item.path}: ok; ${item.result.startLine}-${item.result.endLine} of ${item.result.totalLines} lines, ${item.result.bytes} file bytes.`,
        "",
        `## Item ${item.index}: ${item.path}`,
        "",
        "```text",
        publicSourceBody(item.result.text),
        "```"
      );
    } else {
      parts.push(`- [${item.index}] ${item.path}: error; ${item.error}`);
    }
  }

  const segments: PublicTextSegment[] = [];
  let normal = "";
  let hasPreviousPart = false;
  const flushNormal = () => {
    if (!normal) return;
    segments.push({ kind: "normal", text: normal });
    normal = "";
  };
  for (const part of parts) {
    if (typeof part === "string") {
      normal += `${hasPreviousPart ? "\n" : ""}${part}`;
    } else {
      if (hasPreviousPart) normal += "\n";
      flushNormal();
      segments.push(part);
    }
    hasPreviousPart = true;
  }
  flushNormal();
  return segments;
}

function readManyResponse(workspace: Workspace, results: ReadManyResult[], maxTotalBytes: number): any {
  const sourceFields: PublicSourceField[] = [];
  for (const item of results) {
    if (!item.ok) continue;
    const body = publicSourceBody(item.result.text);
    sourceFields.push({ path: ["results", item.index, "result", "text"], body });
  }
  return textResult(readManyText(workspace, results, maxTotalBytes), {
    workspace_id: workspace.id,
    root: workspace.root,
    max_items: READ_MANY_MAX_ITEMS,
    max_total_bytes: maxTotalBytes,
    item_count: results.length,
    results
  }, {}, { sourceFields });
}

function serializedReadManyResponseBytes(response: any): number {
  const structured = response?.structuredContent && typeof response.structuredContent === "object"
    ? response.structuredContent
    : {};
  const tagged = {
    ...response,
    structuredContent: {
      codexpro_tool: "read_many",
      codexpro_title: "Read Many",
      ...structured
    }
  };
  return Buffer.byteLength(JSON.stringify(tagged), "utf8");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return redactDiagnosticText(`${error.name}: ${error.message}`);
  return redactDiagnosticText(String(error));
}

function compactStructuredContent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= STRUCTURED_STRING_MAX_CHARS) return value as T;
    return `${value.slice(0, STRUCTURED_STRING_MAX_CHARS)}\n...[structured field truncated to ${STRUCTURED_STRING_MAX_CHARS} chars]` as T;
  }
  if (Array.isArray(value)) return value.map((item) => compactStructuredContent(item, depth + 1)) as T;
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = compactStructuredContent(item, depth + 1);
  }
  return out as T;
}

function textResult(
  text: string | readonly PublicTextSegment[],
  structuredContent: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
  options: TextResultOptions = {}
): any {
  return {
    content: [{ type: "text", text: redactPublicTextSegments(text) }],
    // Only the explicitly identified source body fields bypass the second
    // source-context pass; every other structured field remains recursive.
    // Public read/read_many pass no custom _meta, so MCP metadata stays the
    // existing caller-owned envelope while their structured payload is safe.
    structuredContent: options.sourceFields?.length
      ? redactStructuredPreservingSourceFields(structuredContent, options.sourceFields)
      : redactStructured(structuredContent),
    _meta: meta
  };
}

function restoreSearchMatchText(safeMatches: unknown, sourceMatches: unknown, sourceLineOnly = false): unknown {
  if (!Array.isArray(safeMatches) || !Array.isArray(sourceMatches)) return safeMatches;
  return safeMatches.map((safeMatch, index) => {
    const sourceMatch = sourceMatches[index];
    if (!safeMatch || typeof safeMatch !== "object" || !sourceMatch || typeof sourceMatch !== "object") return safeMatch;
    // `built-in analysis` is the source-line producer; import extraction and
    // other relationship producers emit derived text that must stay wrapped.
    if (sourceLineOnly && (sourceMatch as { source?: unknown }).source !== "built-in analysis") return safeMatch;
    const sourceText = (sourceMatch as { text?: unknown }).text;
    return typeof sourceText === "string" ? { ...(safeMatch as Record<string, unknown>), text: sourceText } : safeMatch;
  });
}

function preserveSearchMatchText(response: any, result: any): any {
  // Search redacts each matched line against its complete source file. A
  // second isolated-line pass would erase lawful `credential: identifier`
  // references, so retain only the already-safe match text while leaving
  // paths and other structured fields under the generic redaction pass.
  const structured = response?.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return response;
  structured.matches = restoreSearchMatchText(structured.matches, result.matches);

  const analysis = structured.analysis;
  if (analysis && typeof analysis === "object" && !Array.isArray(analysis) && result.analysis) {
    analysis.matches = restoreSearchMatchText(analysis.matches, result.analysis.matches, true);
    if (analysis.groups && typeof analysis.groups === "object" && !Array.isArray(analysis.groups)) {
      for (const [group, sourceMatches] of Object.entries(result.analysis.groups ?? {})) {
        analysis.groups[group] = restoreSearchMatchText(analysis.groups[group], sourceMatches, true);
      }
    }
  }

  if (Array.isArray(response.content)) {
    const safeMatches = Array.isArray(structured.matches) ? structured.matches : [];
    response.content = response.content.map((part: any) => {
      if (!part || part.type !== "text") return part;
      const text = safeMatches
        .map((match: any) => `${match.path}:${match.line}: ${match.text}`)
        .join("\n") || "No matches.";
      return { ...part, text };
    });
  }
  return response;
}

function diagnosticResult(result: any): any {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const safe = { ...result };
  if (Array.isArray(safe.content)) {
    safe.content = safe.content.map((part: any) => {
      if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
      return { ...part, text: redactDiagnosticText(part.text) };
    });
  }
  if ("structuredContent" in safe) safe.structuredContent = redactDiagnosticStructured(safe.structuredContent);
  if ("_meta" in safe) safe._meta = redactDiagnosticStructured(safe._meta);
  return safe;
}

function diagnosticTextResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return diagnosticResult({
    content: [{ type: "text", text }],
    structuredContent,
    _meta: meta
  });
}

function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function bashTextResult(config: CodexProConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured CodexPro card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

function errorResult(error: unknown): any {
  const message = errorText(error);
  return {
    isError: true,
    ...diagnosticTextResult(message, { error: message })
  };
}

function publicGitReviewRef(ref: {
  input: string;
  objectFormat: string;
  fullSha: string;
  shortSha: string;
}): Record<string, unknown> {
  return {
    input_ref: ref.input,
    object_format: ref.objectFormat,
    full_sha: ref.fullSha,
    short_sha: ref.shortSha
  };
}

function publicGitLogCommit(commit: {
  fullSha: string;
  shortSha: string;
  parents: readonly string[];
  authorName: string;
  authoredAt: string;
  committerName: string;
  committedAt: string;
  subject: string;
}): Record<string, unknown> {
  return {
    full_sha: commit.fullSha,
    short_sha: commit.shortSha,
    parents: commit.parents,
    author_name: commit.authorName,
    authored_at: commit.authoredAt,
    committer_name: commit.committerName,
    committed_at: commit.committedAt,
    subject: commit.subject
  };
}

function validateToolArgs(name: string, options: Record<string, unknown>, args: unknown): any {
  const inputSchema = options.runtimeInputSchema ?? options.inputSchema;
  if (
    inputSchema &&
    typeof inputSchema === "object" &&
    !Array.isArray(inputSchema) &&
    typeof (inputSchema as { safeParse?: unknown }).safeParse === "function"
  ) {
    const parsed = (inputSchema as z.ZodTypeAny).safeParse(args ?? {});
    if (parsed.success) return parsed.data;
    const details = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
      .join("; ");
    throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
  }
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args ?? {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value && typeof (value as { safeParse?: unknown }).safeParse === "function") {
      shape[key] = value as z.ZodTypeAny;
    }
  }
  if (!Object.keys(shape).length) return {};
  const parsed = z.object(shape).safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
  throw new CodexProError(`Invalid arguments for ${name}: ${details}`);
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  const tagged = {
    codexpro_tool: name,
    codexpro_title: options.title ?? name,
    ...base
  };
  const meta = (options._meta as Record<string, unknown> | undefined) ?? {};
  result.structuredContent = meta.ui || meta["openai/outputTemplate"] ? compactStructuredContent(tagged) : tagged;
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

const TOOL_CARD_RENDER_TOOL_NAMES = new Set<string>([
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "show_changes",
  "git_status",
  "handoff_to_agent",
  "handoff_to_codex",
  "bash"
]);

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

function usesToolCard(config: CodexProConfig, name: string): boolean {
  return config.toolCards && TOOL_CARD_RENDER_TOOL_NAMES.has(name);
}

function descriptorOptionsForConfig(config: CodexProConfig, name: string, options: Record<string, unknown>): Record<string, unknown> {
  if (usesToolCard(config, name)) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.CODEXPRO_LOG_TOOL_CALLS === "1" || process.env.CODEXPRO_LOG_REQUESTS === "1";
}

function logToolCall(name: string, status: "ok" | "error", started: number): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[CodexProTool] ${name} ${status} ${Date.now() - started}ms`);
}

function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
  if (config.connectionTest) return;
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error("Unsupported MCP SDK: CodexPro widgets require registerResource.");
  }

  const registerUri = (uri: string, name: string): void => {
    s.registerResource(
      name,
      uri,
      {
        title: "CodexPro Tool Card",
        description: "Compact visual renderer for CodexPro workspace orientation, source changes, and handoffs.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                domain: config.widgetDomain,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": "Renders CodexPro workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": config.widgetDomain,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "codexpro-tool-card");
  for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
    registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
  }
}

type CodexToolHandler = (args: any) => Promise<any> | any;

const SUPERTOOL_NAME = "codexpro";
const SUPERTOOL_ACTION_ALIASES: Record<string, string> = {
  actions: "list_actions",
  config: "server_config",
  self_test: "codexpro_self_test",
  inventory: "codexpro_inventory",
  open: "open_current_workspace",
  snapshot: "workspace_snapshot",
  changes: "show_changes",
  handoff_poll: "wait_for_handoff",
  pro_export: "export_pro_context",
  agent_handoff: "handoff_to_agent",
  codex_handoff: "handoff_to_codex"
};

const registeredToolHandlersByServer = new WeakMap<object, Map<string, CodexToolHandler>>();

function rememberRegisteredToolHandler(server: McpServer, name: string, handler: CodexToolHandler): void {
  const key = server as object;
  const handlers = registeredToolHandlersByServer.get(key) ?? new Map<string, CodexToolHandler>();
  if (!registeredToolHandlersByServer.has(key)) registeredToolHandlersByServer.set(key, handlers);
  handlers.set(name, handler);
}

function registeredToolHandler(server: McpServer, name: string): CodexToolHandler | undefined {
  return registeredToolHandlersByServer.get(server as object)?.get(name);
}

function normalizeSupertoolAction(value: unknown): string {
  const raw = String(value ?? "list_actions").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return SUPERTOOL_ACTION_ALIASES[normalized] ?? normalized;
}


function isContextPath(config: CodexProConfig, relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/").replace(/^\.\//, "");
  const contextDir = config.contextDir.replace(/^\.\//, "").replace(/\/$/, "");
  return normalized === contextDir || normalized.startsWith(`${contextDir}/`);
}

function assertWriteToolAllowed(config: CodexProConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  if (config.writeMode === "handoff" && isContextPath(config, relPath)) return;
  if (config.writeMode === "handoff") {
    throw new CodexProError(
      `Source writes are disabled because CODEXPRO_WRITE_MODE=handoff. ` +
        `Use handoff_to_agent or handoff_to_codex, or write/edit/apply_patch only inside ${config.contextDir}/.`
    );
  }
  throw new CodexProError("write/edit/apply_patch tools are disabled because CODEXPRO_WRITE_MODE=off. handoff_to_agent and handoff_to_codex are still available for planning.");
}

function registerToolCompat(
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any) => {
    const started = Date.now();
    try {
      const result = tagToolResult(await handler(args ?? {}), name, options);
      logToolCall(name, result?.isError ? "error" : "ok", started);
      return result;
    } catch (error) {
      const result = tagToolResult(errorResult(error), name, options);
      logToolCall(name, "error", started);
      return result;
    }
  };

  const { runtimeInputSchema: _runtimeInputSchema, ...descriptorOptions } = options;
  const securitySchemes = [{ type: "noauth" }];
  const fullOptions: Record<string, unknown> = {
    securitySchemes,
    ...descriptorOptions,
    _meta: {
      securitySchemes,
      ...(descriptorOptions._meta as Record<string, unknown> | undefined)
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "runtime_status",
  "codexpro_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "read_many",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "show_changes"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "inspect_workspace",
  "tree",
  "search",
  "load_skill",
  "view_image",
  "read_handoff",
  "wait_for_handoff",
  "export_pro_context",
  "handoff_to_agent"
] as const;

const FULL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "runtime_status",
  "codexpro_self_test",
  "codexpro_inventory",
  "load_skill",
  "list_workspaces",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "tree",
  "search",
  "read",
  "read_many",
  "view_image",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "bash",
  "git_resolve_ref",
  "git_merge_base",
  "git_log",
  "git_show_commit",
  "read_at_ref",
  "git_diff_range",
  "git_commit",
  "git_status",
  "git_diff",
  "show_changes",
  "read_handoff",
  "wait_for_handoff",
  "codex_context",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
] as const;

const CONNECTION_TEST_HIDDEN_TOOLS = new Set<string>([
  SUPERTOOL_NAME,
  "codexpro_self_test",
  "write",
  "edit",
  "apply_patch",
  "import_file",
  "git_commit",
  "bash",
  "export_pro_context",
  "handoff_to_agent",
  "handoff_to_codex"
]);

function codexSessionToolNames(config: CodexProConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function toolNamesForMode(config: CodexProConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  if (config.bashMode === "off") {
    const bashIndex = names.indexOf("bash");
    if (bashIndex !== -1) names.splice(bashIndex, 1);
  }
  if (config.writeMode !== "workspace") {
    for (const writeTool of ["write", "edit", "apply_patch", "import_file", "git_commit"]) {
      const toolIndex = names.indexOf(writeTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (config.writeMode === "handoff" && !names.includes("handoff_to_agent")) names.push("handoff_to_agent");
  if (!config.analysisEnabled) {
    const analysisIndex = names.indexOf("inspect_workspace");
    if (analysisIndex !== -1) names.splice(analysisIndex, 1);
  }
  if (config.connectionTest) {
    for (const hiddenTool of CONNECTION_TEST_HIDDEN_TOOLS) {
      const toolIndex = names.indexOf(hiddenTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);
const registeredToolNamesByServer = new WeakMap<object, string[]>();

function rememberRegisteredTool(server: McpServer, name: string): void {
  const key = server as object;
  const names = registeredToolNamesByServer.get(key) ?? [];
  if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
  if (!names.includes(name)) names.push(name);
}

function registeredToolNames(server: McpServer): string[] {
  return [...(registeredToolNamesByServer.get(server as object) ?? [])];
}

function shouldRegisterTool(config: CodexProConfig, name: string): boolean {
  if (config.connectionTest && CONNECTION_TEST_HIDDEN_TOOLS.has(name)) return false;
  if (name === "bash" && config.bashMode === "off") return false;
  if ((name === "write" || name === "edit" || name === "apply_patch" || name === "import_file") && config.writeMode !== "workspace") return false;
  if (name === "git_commit" && (config.toolMode !== "full" || config.writeMode !== "workspace")) return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if (name === "inspect_workspace" && !config.analysisEnabled) return false;
  if (name === "handoff_to_agent" && config.writeMode === "handoff") return true;
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

function registerCodexTool(
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
): void {
  if (!shouldRegisterTool(config, name)) return;
  const validatedHandler: CodexToolHandler = (args) => handler(validateToolArgs(name, options, args));
  registerToolCompat(server, name, descriptorOptionsForConfig(config, name, options), validatedHandler);
  rememberRegisteredTool(server, name);
  rememberRegisteredToolHandler(server, name, validatedHandler);
}

function serverInstructions(config: CodexProConfig): string {
  const editInstruction =
    config.connectionTest
      ? "5. Connection test mode is read-only. Write, patch, export, and handoff-writing tools are unavailable."
      : config.writeMode === "workspace"
      ? "5. Edit source files with write/edit/apply_patch. After edits, call show_changes once for git status, diff stats, and review diff."
      : config.writeMode === "handoff"
        ? "5. Source writes are disabled and generic write/edit/apply_patch tools are unavailable. Use handoff_to_agent/handoff_to_codex for plans."
        : "5. Write/edit/apply_patch tools are disabled. Do not attempt direct file writes; use handoff or context export workflows instead.";
  const bashInstruction =
    config.bashMode === "off"
      ? "6. Bash is disabled and the bash tool is unavailable. Do not attempt shell commands."
      : "6. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.";

  return [
    "CodexPro connects ChatGPT to explicitly allowed local development workspaces.",
    "",
    "Preferred workflow:",
    "1. Start with open_current_workspace. Use open_workspace only when the user gives a different allowed root or asks to switch projects; session-selected workspace is reliable only when the client preserves the same MCP session.",
    "2. For correctness-sensitive Git tools (git_commit, git_resolve_ref, git_merge_base, git_log, git_show_commit, read_at_ref, git_diff_range), always pass the explicit workspace_id returned by open_current_workspace/open_workspace.",
    "3. Follow any AGENTS.md-style instructions returned by the workspace open call before editing files.",
    "4. Inspect with tree, search, and read. Do not use bash for git status, git diff, cat, sed, grep, rg, find, ls, or file reading.",
    editInstruction,
    bashInstruction,
    "7. Keep tool calls minimal. Prefer one targeted search plus show_changes instead of repeated broad inspection calls.",
    config.codexSessions !== "off"
      ? `8. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `9. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `9. Bash session label for this server is "${config.bashSessionId}".`
        : "",
    "",
    `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, write=${config.writeMode}.`
  ].filter(Boolean).join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function sourceDiffBlock(diff: string): readonly PublicTextSegment[] {
  return [
    { kind: "normal", text: "\n\n```diff\n" },
    publicSourceBody(diff),
    { kind: "normal", text: "\n```" }
  ];
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

function reviewCheckpointKey(workspace: Workspace, options: { path?: string; staged: boolean }): string {
  return `${workspace.id}\0${options.path ?? ""}\0${options.staged ? "staged" : "unstaged"}`;
}

function reviewFingerprint(status: string, diff: string): string {
  return createHash("sha256").update(status).update("\0").update(diff).digest("hex");
}

async function untrackedReviewFingerprint(config: CodexProConfig, guard: PathGuard, workspace: Workspace, changedFiles: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const line of changedFiles) {
    const match = line.match(/^\?\?\s+(.+)$/);
    if (!match) continue;
    const relPath = match[1];
    hash.update(relPath).update("\0");
    try {
      const resolved = guard.resolve(workspace, relPath);
      const stat = await fsp.stat(resolved.absPath);
      hash.update(String(stat.size)).update("\0").update(String(Math.floor(stat.mtimeMs))).update("\0");
      if (stat.isFile() && stat.size <= config.maxReadBytes) {
        hash.update(await fsp.readFile(resolved.absPath));
      }
    } catch (error) {
      hash.update(errorText(error));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

type GitApplyNumstat = { additions: string; deletions: string; path: string };
type GitApplyPathPair = {
  additions: string;
  deletions: string;
  oldPath: string;
  newPath: string;
};
type GitApplyPreflight = {
  numstat: GitApplyNumstat[];
  reverseNumstat: GitApplyNumstat[];
  pairs: GitApplyPathPair[];
  verbose: Buffer;
};
type ValidatedPatchPath = { gitPath: string; absPath: string; relPath: string };
type GitCommandResult = { status: number | null; error?: Error; stdout?: Buffer; stderr?: Buffer };
type SimulatedPatch = {
  rawDiff: string;
  numstat: GitApplyNumstat[];
  additions: number;
  deletions: number;
  changed: boolean;
};
type ValidatedSimulation = SimulatedPatch & { diff: string };

function decodeGitQuotedPath(pathText: string): string {
  const input = pathText.startsWith('"') && pathText.endsWith('"') ? pathText.slice(1, -1) : pathText;
  let decoded = "";
  let escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (!escapedBytes.length) return;
    decoded += Buffer.from(escapedBytes).toString("utf8");
    escapedBytes = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\") {
      flushEscapedBytes();
      decoded += char;
      continue;
    }
    i += 1;
    const escaped = input[i];
    if (escaped === undefined) throw new CodexProError(`Invalid quoted Git path: ${pathText}`);
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let j = 0; j < 2 && i + 1 < input.length && /[0-7]/.test(input[i + 1]); j += 1) {
        i += 1;
        octal += input[i];
      }
      escapedBytes.push(Number.parseInt(octal, 8));
    } else {
      flushEscapedBytes();
      decoded += ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  flushEscapedBytes();
  return decoded;
}

function gitMachineBytes(output: Buffer | string): Buffer {
  return Buffer.isBuffer(output) ? Buffer.from(output) : Buffer.from(output, "utf8");
}

function decodeGitMachineUtf8(output: Buffer | string): string {
  const bytes = gitMachineBytes(output);
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new CodexProError("Git returned non-lossless UTF-8 machine output.");
  }
  return value;
}

function parseGitNumstat(output: Buffer | string): GitApplyNumstat[] {
  const text = decodeGitMachineUtf8(output);
  if (!text) return [];
  if (!text.endsWith("\0")) throw new CodexProError("Git returned malformed apply numstat output.");
  const entries = text.slice(0, -1).split("\0");
  const records: GitApplyNumstat[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) throw new CodexProError("Git returned malformed apply numstat output.");
    const firstTab = entry.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : entry.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      throw new CodexProError("Git returned malformed apply numstat output.");
    }
    const additions = entry.slice(0, firstTab);
    const deletions = entry.slice(firstTab + 1, secondTab);
    const pathValue = entry.slice(secondTab + 1);
    if (!/^\d+$/.test(additions) && additions !== "-") throw new CodexProError("Git returned malformed apply numstat output.");
    if (!/^\d+$/.test(deletions) && deletions !== "-") throw new CodexProError("Git returned malformed apply numstat output.");
    if (pathValue) {
      // `-z` deliberately returns path bytes without Git's quote-and-escape
      // display layer. Preserve every backslash and quote as a filename byte.
      records.push({ additions, deletions, path: pathValue });
      continue;
    }
    // Git's `diff --numstat -z` represents a detected rename/copy as an
    // empty path field followed by old and new paths in two NUL records.
    const oldPath = entries[index + 1];
    const newPath = entries[index + 2];
    if (!oldPath || !newPath) throw new CodexProError("Git returned malformed apply numstat output.");
    records.push({ additions, deletions, path: newPath });
    index += 2;
  }
  return records;
}

function pairGitApplyNumstat(forward: GitApplyNumstat[], reverse: GitApplyNumstat[]): GitApplyPathPair[] {
  if (!forward.length || forward.length !== reverse.length) {
    throw new CodexProError("Git apply preflight returned mismatched path/count output.");
  }
  const reverseInApplyOrder = [...reverse].reverse();
  return forward.map((entry, index) => {
    const reverseEntry = reverseInApplyOrder[index];
    if (
      entry.additions !== reverseEntry.deletions ||
      entry.deletions !== reverseEntry.additions
    ) {
      throw new CodexProError("Git apply preflight returned mismatched path/count output.");
    }
    return {
      additions: entry.additions,
      deletions: entry.deletions,
      oldPath: reverseEntry.path,
      newPath: entry.path
    };
  });
}

function applyReportPaths(report: GitApplyPreflight): string[] {
  const paths: string[] = [];
  const add = (value: string | undefined) => {
    if (value && !paths.includes(value)) paths.push(value);
  };
  // Forward numstat names the effective destination. Reverse numstat names
  // the source for a rename/copy; its records are paired in reverse order.
  // Preserve that producer identity order without normalizing any path text.
  for (const entry of report.pairs) {
    if (entry.oldPath !== entry.newPath) add(entry.oldPath);
    add(entry.newPath);
  }
  return paths;
}

function applyGitEnvironment(isolated = false): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C", NO_COLOR: "1" };
  // Apply-related Git calls must remain rooted at their explicit cwd. Remove
  // inherited repository/index/attribute routing and config injection keys
  // for both real and disposable repositories.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_ATTR_SOURCE",
    "GIT_PREFIX",
    "GIT_CONFIG"
  ]) delete environment[key];
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete environment[key];
  }
  if (isolated) {
    const nullConfigPath = process.platform === "win32" ? "NUL" : "/dev/null";
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_CONFIG_SYSTEM = nullConfigPath;
    environment.GIT_CONFIG_GLOBAL = nullConfigPath;
  }
  return environment;
}

function runApplyGit(cwd: string, args: string[], input: string | undefined, maxOutputBytes: number, isolated = false): GitCommandResult {
  return spawnSync("git", args, {
    cwd,
    input,
    encoding: null,
    maxBuffer: maxOutputBytes,
    env: applyGitEnvironment(isolated)
  }) as unknown as GitCommandResult;
}

function gitOutputText(output: Buffer | string | undefined): string {
  if (output === undefined) return "";
  return Buffer.isBuffer(output) ? output.toString("utf8") : output;
}

function gitCommandFailure(result: GitCommandResult, fallback: string): string {
  const detail = gitOutputText(result.stderr).trim() || gitOutputText(result.stdout).trim() || result.error?.message || fallback;
  return redactDiagnosticText(detail).slice(0, 4_096);
}

function assertApplyGitSuccess(result: GitCommandResult, fallback: string): void {
  if (result.error || result.status !== 0) throw new CodexProError(gitCommandFailure(result, fallback));
}

function runApplyPreflight(config: CodexProConfig, workspace: Workspace, patch: string): GitApplyPreflight {
  const result = runApplyGit(
    workspace.root,
    ["apply", "--check", "--numstat", "-z", "--verbose", "--whitespace=nowarn"],
    patch,
    config.maxOutputBytes
  );
  if (result.error || result.status !== 0) {
    throw new CodexProError(gitCommandFailure(result, "git apply preflight failed"));
  }
  const verbose = gitMachineBytes(result.stderr ?? Buffer.alloc(0));
  const reverseResult = runApplyGit(
    workspace.root,
    ["apply", "--numstat", "-z", "--reverse", "--whitespace=nowarn"],
    patch,
    config.maxOutputBytes
  );
  if (reverseResult.error || reverseResult.status !== 0) {
    throw new CodexProError(gitCommandFailure(reverseResult, "git apply reverse preflight failed"));
  }
  try {
    const numstat = parseGitNumstat(result.stdout ?? Buffer.alloc(0));
    const reverseNumstat = parseGitNumstat(reverseResult.stdout ?? Buffer.alloc(0));
    const pairs = pairGitApplyNumstat(numstat, reverseNumstat);
    return { numstat, reverseNumstat, pairs, verbose };
  } catch (error) {
    throw new CodexProError("Git apply preflight returned malformed path/count output.");
  }
}

function sameApplyPreflight(left: GitApplyPreflight, right: GitApplyPreflight): boolean {
  return (
    JSON.stringify({ numstat: left.numstat, reverseNumstat: left.reverseNumstat, pairs: left.pairs }) ===
      JSON.stringify({ numstat: right.numstat, reverseNumstat: right.reverseNumstat, pairs: right.pairs }) &&
    left.verbose.equals(right.verbose)
  );
}

function validateApplyPaths(config: CodexProConfig, guard: PathGuard, workspace: Workspace, report: GitApplyPreflight): ValidatedPatchPath[] {
  const paths = applyReportPaths(report);
  if (!paths.length) throw new CodexProError("Patch must include at least one Git-identified file path.");
  return paths.map((gitPath) => {
    const resolved = guard.resolve(workspace, gitPath, { forWrite: true });
    assertWriteToolAllowed(config, resolved.relPath);
    return { gitPath, absPath: resolved.absPath, relPath: resolved.relPath };
  });
}

function sameValidatedApplyPaths(left: ValidatedPatchPath[], right: ValidatedPatchPath[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function policyPathMatches(recordPath: string, policyPath: string): boolean {
  if (recordPath === policyPath) return true;
  // The existing source-policy diff reader historically treats a quoted
  // backslash as a separator while extracting a header. Match that lossy
  // representation only here, after the real Git path has passed PathGuard;
  // this is never used to resolve, block, or lock a filesystem path.
  const backslash = String.fromCharCode(92);
  let recordIndex = 0;
  let usedCompatibilityAlias = false;
  for (const policyCharacter of policyPath) {
    const recordCharacter = recordPath[recordIndex];
    if (policyCharacter === "/" && recordCharacter === backslash) {
      recordIndex += 1;
      usedCompatibilityAlias = true;
      continue;
    }
    if (recordCharacter !== policyCharacter) return false;
    recordIndex += 1;
  }
  return usedCompatibilityAlias && recordIndex === recordPath.length;
}

function languageForValidatedPaths(records: ValidatedPatchPath[]): (pathHint: string | undefined) => "python" | undefined {
  return (pathHint: string | undefined) => {
    if (typeof pathHint !== "string") return undefined;
    const matches = records.filter((record) => policyPathMatches(record.gitPath, pathHint) || policyPathMatches(record.relPath, pathHint));
    if (matches.length !== 1) return undefined;
    return sourceLanguageForPath(matches[0].relPath);
  };
}

function simulationPath(root: string, gitPath: string): string {
  const parts = gitPath.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw new CodexProError("Git returned an unsafe apply path.");
  }
  const candidate = path.join(root, ...parts);
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") {
    throw new CodexProError("Git returned an unsafe apply path.");
  }
  return candidate;
}

async function populateSimulation(root: string, records: ValidatedPatchPath[]): Promise<void> {
  const destinations = new Map<string, string>();
  for (const record of records) {
    let stat;
    try {
      stat = await fsp.lstat(record.absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new CodexProError("Symlink patches are blocked from apply_patch.");
    if (!stat.isFile()) continue;

    const destination = simulationPath(root, record.gitPath);
    const prior = destinations.get(destination);
    if (prior && prior !== record.absPath) throw new CodexProError("Git apply paths resolve ambiguously.");
    destinations.set(destination, record.absPath);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(record.absPath, destination);
    await fsp.chmod(destination, stat.mode & 0o7777);
  }
}

function numstatCount(value: string): number {
  return value === "-" ? 0 : Number(value);
}

function summarizeNumstat(numstat: GitApplyNumstat[]): { additions: number; deletions: number } {
  return numstat.reduce(
    (summary, entry) => ({
      additions: summary.additions + numstatCount(entry.additions),
      deletions: summary.deletions + numstatCount(entry.deletions)
    }),
    { additions: 0, deletions: 0 }
  );
}

function assertNoSimulatedSymlinkIndex(output: Buffer | string): void {
  const bytes = gitMachineBytes(output);
  if (!bytes.length) return;
  let start = 0;
  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);
    if (end < 0 || end === start) throw new CodexProError("Git simulation returned malformed index output.");
    const record = bytes.subarray(start, end);
    if (record.length < 7 || record[6] !== 0x20) {
      throw new CodexProError("Git simulation returned malformed index output.");
    }
    const mode = record.subarray(0, 6).toString("ascii");
    if (!/^\d{6}$/.test(mode)) throw new CodexProError("Git simulation returned malformed index output.");
    if (mode === "120000") throw new CodexProError("Symlink patches are blocked from apply_patch.");
    start = end + 1;
  }
}

async function simulateWorkspacePatch(config: CodexProConfig, records: ValidatedPatchPath[], patch: string): Promise<SimulatedPatch> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexpro-apply-"));
  try {
    await populateSimulation(root, records);
    assertApplyGitSuccess(runApplyGit(root, ["init", "-q"], undefined, config.maxOutputBytes, true), "git simulation init failed");
    assertApplyGitSuccess(runApplyGit(root, ["-c", "core.autocrlf=false", "-c", "core.filemode=true", "add", "--all", "--force"], undefined, config.maxOutputBytes, true), "git simulation baseline staging failed");
    assertApplyGitSuccess(
      runApplyGit(root, ["-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", "user.name=CodexPro", "-c", "user.email=codexpro@invalid", "commit", "--allow-empty", "--no-verify", "-m", "CodexPro apply_patch baseline"], undefined, config.maxOutputBytes, true),
      "git simulation baseline commit failed"
    );
    assertApplyGitSuccess(
      runApplyGit(root, ["-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", "core.symlinks=false", "apply", "--index", "--whitespace=nowarn"], patch, config.maxOutputBytes, true),
      "git simulation apply failed"
    );
    const indexResult = runApplyGit(
      root,
      ["ls-files", "--stage", "-z"],
      undefined,
      config.maxOutputBytes,
      true
    );
    assertApplyGitSuccess(indexResult, "git simulation index inspection failed");
    assertNoSimulatedSymlinkIndex(indexResult.stdout ?? Buffer.alloc(0));

    const diffResult = runApplyGit(
      root,
      ["-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", "core.quotepath=true", "diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "--binary", "--src-prefix=a/", "--dst-prefix=b/", "--find-renames", "--find-copies", "--find-copies-harder"],
      undefined,
      config.maxOutputBytes,
      true
    );
    assertApplyGitSuccess(diffResult, "git simulation canonical diff failed");
    const numstatResult = runApplyGit(
      root,
      ["-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", "core.quotepath=true", "diff", "--cached", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--find-copies-harder"],
      undefined,
      config.maxOutputBytes,
      true
    );
    assertApplyGitSuccess(numstatResult, "git simulation canonical numstat failed");
    const numstat = parseGitNumstat(numstatResult.stdout ?? "");
    const summary = summarizeNumstat(numstat);
    const rawDiff = gitOutputText(diffResult.stdout);
    return {
      rawDiff,
      numstat,
      additions: summary.additions,
      deletions: summary.deletions,
      changed: Boolean(rawDiff.trim())
    };
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    throw new CodexProError("Git apply simulation failed.");
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function validateSimulatedSource(simulated: SimulatedPatch, records: ValidatedPatchPath[]): ValidatedSimulation {
  const languageForPath = languageForValidatedPaths(records);
  try {
    if (hasSecretValueInUnifiedDiff(simulated.rawDiff, languageForPath)) {
      throw new CodexProError("Secret-looking content is blocked from apply_patch. Use placeholders such as [REDACTED_SECRET].");
    }
    return { ...simulated, diff: redactUnifiedDiff(simulated.rawDiff, languageForPath) };
  } catch (error) {
    if (error instanceof CodexProError) throw error;
    throw new CodexProError("Canonical Git diff source validation failed.");
  }
}

async function applyWorkspacePatch(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): Promise<{ paths: string[]; stdout: string; stderr: string; diff: string; additions: number; deletions: number; changed: boolean }> {
  if (!patch.trim()) throw new CodexProError("patch is required.");
  if (Buffer.byteLength(patch, "utf8") > config.maxWriteBytes) {
    throw new CodexProError(`Patch is too large. Limit: ${config.maxWriteBytes} bytes.`);
  }

  // Git is the first path/count authority. Do not classify source bytes or
  // inspect patch grammar until this read-only preflight has succeeded.
  const firstPreflight = runApplyPreflight(config, workspace, patch);
  const firstRecords = validateApplyPaths(config, guard, workspace, firstPreflight);

  return withFileWriteLocks(firstRecords.map((record) => record.absPath), async () => {
    let lockedPreflight: GitApplyPreflight;
    try {
      lockedPreflight = runApplyPreflight(config, workspace, patch);
    } catch {
      throw new CodexProError("Patch preflight changed while waiting for its write locks; retry.");
    }
    if (!sameApplyPreflight(firstPreflight, lockedPreflight)) {
      throw new CodexProError("Patch preflight changed while waiting for its write locks; retry.");
    }
    const lockedRecords = validateApplyPaths(config, guard, workspace, lockedPreflight);
    if (!sameValidatedApplyPaths(firstRecords, lockedRecords)) {
      throw new CodexProError("Patch path identities changed while waiting for its write locks; retry.");
    }

    const lockedSimulation = await simulateWorkspacePatch(config, lockedRecords, patch);
    const lockedValidated = validateSimulatedSource(lockedSimulation, lockedRecords);

    const applied = runApplyGit(workspace.root, ["apply", "--whitespace=nowarn"], patch, config.maxOutputBytes);
    if (applied.error || applied.status !== 0) {
      throw new CodexProError(gitCommandFailure(applied, "git apply failed"));
    }
    return {
      paths: applyReportPaths(lockedPreflight),
      stdout: redactDiagnosticText(String(applied.stdout ?? "").trim()),
      stderr: redactDiagnosticText(String(applied.stderr ?? "").trim()),
      diff: lockedValidated.diff,
      additions: lockedValidated.additions,
      deletions: lockedValidated.deletions,
      changed: lockedValidated.changed
    };
  });
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "(no output)" && !line.startsWith("##"));
}

function changedPathsFromStatus(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    let raw: string;
    if (line.startsWith("?? ")) raw = line.slice(3).trim();
    else if (line.includes("\t")) raw = line.split("\t").pop()?.trim() ?? "";
    else if (/^.{2}\s/.test(line)) raw = line.slice(3).trim();
    else continue;
    if (raw.includes(" -> ")) raw = raw.split(" -> ").pop() ?? raw;
    const decoded = decodeGitQuotedPath(raw);
    if (decoded && !paths.includes(decoded)) paths.push(decoded);
  }
  return paths;
}

function jsonlEvent(event: string, data: Record<string, unknown>): string {
  return JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

function normalizeAgentId(value: unknown): string {
  const agent = cleanOneLine(value, "custom", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(agent)) {
    throw new CodexProError("agent must use only lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  return agent;
}

function displayAgentName(agent: string, agentName?: unknown): string {
  const explicit = cleanOneLine(agentName, "", 80);
  if (explicit) return explicit;
  if (agent === "codex") return "Codex";
  if (agent === "opencode") return "OpenCode";
  if (agent === "pi") return "Pi";
  return agent;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function agentCommandHint(agent: string, planPath: string, model?: string): string {
  const modelArg = model ? ` --model ${shellQuote(model)}` : " --model '<provider/model>'";
  const quotedPlanPath = shellQuote(planPath);
  if (agent === "opencode") return `opencode run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "pi") return `pi run${modelArg} "$(cat ${quotedPlanPath})"`;
  if (agent === "codex") return `Read ${planPath} and execute it in small, reviewable steps.`;
  return `Run your local implementation agent manually with ${planPath} as the task input.`;
}

async function readRawTextFileBounded(config: CodexProConfig, guard: PathGuard, workspace: Workspace, filePath: string): Promise<string> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, config.maxReadBytes);
  return fsp.readFile(resolved.absPath, "utf8");
}

function buildAgentPlanBody(options: {
  title: string;
  plan: string;
  workspace: Workspace;
  agent: string;
  agentName: string;
  model?: string;
  statusPath: string;
  diffPath: string;
  executionLogPath: string;
}): string {
  const modelLine = options.model ? `Model: ${options.model}\n` : "";
  return `# ${options.title}

Updated: ${new Date().toISOString()}
Workspace: ${options.workspace.root}
Target agent: ${options.agentName} (${options.agent})
${modelLine}
## Plan

${options.plan.trim()}

## Implementation contract

- Work from this plan in small, reviewable steps.
- Keep edits scoped to the requested task and existing project conventions.
- Run focused verification before handing work back.
- Update ${options.statusPath} with files touched, checks run, results, blockers, and review notes.
- Save the final review diff to ${options.diffPath} when practical.
- Append notable execution events to ${options.executionLogPath} when the implementation agent supports logging.
`;
}

async function writeAgentHandoff(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: {
    agent: string;
    agentName?: string;
    model?: string;
    title: string;
    plan: string;
    append: boolean;
    eventName: string;
  }
): Promise<{
  agent: string;
  agentName: string;
  model?: string;
  title: string;
  planPath: string;
  statusPath: string;
  diffPath: string;
  logPath: string;
  executionLogPath: string;
  prompt: string;
  writeResult: Awaited<ReturnType<typeof writeTextFile>>;
}> {
  await ensureAiBridge(config, guard, workspace);
  const agent = normalizeAgentId(options.agent);
  const agentName = displayAgentName(agent, options.agentName);
  const model = options.model ? cleanOneLine(options.model, "", 120) : undefined;
  const plan = String(options.plan ?? "").trim();
  if (!plan) throw new CodexProError("plan must not be empty.");
  const planPath = `${config.contextDir}/current-plan.md`;
  const statusPath = `${config.contextDir}/agent-status.md`;
  const legacyCodexStatusPath = `${config.contextDir}/codex-status.md`;
  const diffPath = `${config.contextDir}/implementation-diff.patch`;
  const logPath = `${config.contextDir}/session-log.jsonl`;
  const executionLogPath = `${config.contextDir}/execution-log.jsonl`;
  const body = buildAgentPlanBody({
    title: options.title,
    plan,
    workspace,
    agent,
    agentName,
    model,
    statusPath,
    diffPath,
    executionLogPath
  });

  let content = body;
  if (options.append) {
    const raw = await readRawTextFileBounded(config, guard, workspace, planPath);
    content = `${raw.trimEnd()}\n\n---\n\n${body}`;
  }

  const writeResult = await writeTextFile(config, guard, workspace, planPath, content, { createDirs: true, overwrite: true });
  const event = {
    agent,
    agent_name: agentName,
    model,
    title: options.title,
    plan_path: planPath,
    status_path: statusPath,
    diff_path: diffPath
  };
  const logResolved = guard.resolve(workspace, logPath, { forWrite: true });
  const executionLogResolved = guard.resolve(workspace, executionLogPath, { forWrite: true });
  await fsp.appendFile(logResolved.absPath, jsonlEvent(options.eventName, event), "utf8");
  await fsp.appendFile(executionLogResolved.absPath, jsonlEvent(options.eventName, event), "utf8");

  const promptLines = [
    `Read ${planPath} and execute it in small, reviewable steps.`,
    `After each meaningful change, update ${statusPath} with files touched, checks run, results, blockers, and the next review focus.`,
    `Before review, write the final diff to ${diffPath} when practical.`,
    agentCommandHint(agent, planPath, model)
  ];
  if (agent === "codex") {
    promptLines.splice(2, 0, `For legacy Codex handoffs, mirror key status notes to ${legacyCodexStatusPath} if your workflow expects that file.`);
  }
  const prompt = promptLines.join("\n");

  return {
    agent,
    agentName,
    model,
    title: options.title,
    planPath,
    statusPath,
    diffPath,
    logPath,
    executionLogPath,
    prompt,
    writeResult
  };
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const GIT_COMMIT_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };
const HANDOFF_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: false, idempotentHint: false };

function boundedRuntimeFailureDetail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redactDiagnosticText(String(value));
  return truncateUtf8(redacted, RUNTIME_STATUS_FAILURE_DETAIL_MAX_BYTES, `\n...[runtime failure detail truncated to ${RUNTIME_STATUS_FAILURE_DETAIL_MAX_BYTES} bytes]`);
}

function runtimeStatusPayload(config: CodexProConfig): Record<string, unknown> {
  let runtime: ReturnType<typeof readRuntimeConnection> = {};
  try {
    runtime = readRuntimeConnection(config.defaultRoot);
  } catch {
    runtime = {};
  }

  let failure: ReturnType<typeof readRuntimeFailure> = null;
  try {
    failure = readRuntimeFailure(config.defaultRoot);
  } catch {
    failure = null;
  }

  const persistedLauncherPid = typeof runtime.pid === "number" ? runtime.pid : null;
  const persistedHttpPid = typeof runtime.runtimePid === "number" ? runtime.runtimePid : null;
  const isHttpChild = persistedHttpPid === process.pid || process.env.CODEXPRO_RUNTIME_KIND === "http";
  // A durable record becomes current-run metadata only when it identifies this
  // HTTP child and its actual live launcher parent. A live PID by itself is not
  // ownership proof (it may belong to an unrelated process or a reused PID).
  const runtimeOwnedByCurrentHttpProcess = isHttpChild
    && persistedHttpPid === process.pid
    && persistedLauncherPid === process.ppid
    && processIsAlive(process.ppid);
  const trustedRuntime = runtimeOwnedByCurrentHttpProcess ? runtime : {};
  const launcherPid = runtimeOwnedByCurrentHttpProcess ? persistedLauncherPid : null;
  const launcherMatchesParent = launcherPid !== null && launcherPid === process.ppid;
  const launcherStatus = launcherPid === null
    ? "unknown"
    : launcherMatchesParent && processIsAlive(launcherPid)
      ? "running"
      : "unknown";
  const tunnelPid = typeof trustedRuntime.tunnelPid === "number" ? trustedRuntime.tunnelPid : null;
  const tunnelType = String(trustedRuntime.tunnel ?? process.env.CODEXPRO_TUNNEL ?? "unknown");
  const tunnelStatus = tunnelPid !== null && launcherMatchesParent
    ? processIsAlive(tunnelPid) ? "running" : "stopped"
    : launcherMatchesParent && trustedRuntime.tunnel
      ? String(trustedRuntime.tunnelStatus ?? "unknown")
      : "unknown";
  const startedAt = typeof trustedRuntime.startedAt === "string" && trustedRuntime.startedAt ? trustedRuntime.startedAt : null;
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const uptimeSeconds = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
    : Math.max(0, Math.floor(process.uptime()));
  const currentRunId = typeof trustedRuntime.runId === "string" && trustedRuntime.runId ? trustedRuntime.runId : null;
  const failureRunId = typeof failure?.runId === "string" && failure.runId ? failure.runId : null;
  const failureRelation = failure
    ? currentRunId && failureRunId === currentRunId ? "current" : "previous"
    : "none";
  const lastFailure = failure
    ? {
        run_id: failureRunId,
        component: String(failure.component ?? "unknown"),
        event: String(failure.event ?? "unknown"),
        phase: String(failure.phase ?? "unknown"),
        failed_at: failure.failedAt ?? null,
        exit_code: failure.exitCode ?? null,
        signal: failure.signal ?? null,
        detail: boundedRuntimeFailureDetail(failure.detail),
        launcher_pid: failure.launcherPid ?? null,
        http_pid: failure.httpPid ?? null,
        tunnel_pid: failure.tunnelPid ?? null,
        tunnel: failure.tunnel ?? null,
        relation_to_current_run: failureRelation
      }
    : null;

  return {
    health: "healthy",
    runtime_source: isHttpChild ? "live_http_process" : "live_mcp_process",
    process: {
      role: isHttpChild ? "http_child" : "mcp_process",
      pid: process.pid,
      status: "running"
    },
    launcher: {
      pid: launcherPid,
      status: launcherStatus
    },
    http_child: {
      pid: isHttpChild ? process.pid : null,
      status: isHttpChild ? "running" : "unknown"
    },
    tunnel: {
      type: tunnelType,
      pid: tunnelPid,
      status: tunnelStatus
    },
    run_id: currentRunId,
    startup_timestamp: startedAt,
    uptime_seconds: uptimeSeconds,
    endpoint: `http://${config.host}:${config.port}/mcp`,
    mode: process.env.CODEXPRO_MODE ?? "unknown",
    headless: typeof trustedRuntime.headless === "boolean" ? trustedRuntime.headless : null,
    last_failure: lastFailure,
    last_failure_relation: failureRelation
  };
}

export function createCodexProServer(config: CodexProConfig): McpServer {
  const workspaces = new WorkspaceManager(config);
  const reviewCheckpoints = new Map<string, string>();
  const guard = new PathGuard(config);
  const readAtRefSchemas = readAtRefPublicSchemas(config.maxReadBytes);
  const server = new McpServer({ name: "CodexPro", version: "0.30.0" }, { instructions: serverInstructions(config) });
  registeredToolNamesByServer.set(server as object, []);
  registerToolCardResource(server, config);

  registerCodexTool(
    config,
    server,
    SUPERTOOL_NAME,
    {
      title: "CodexPro Supertool",
      description:
        "Stable wrapper for advanced ChatGPT connector setups. Pass action plus args to call an already-registered CodexPro tool without changing the visible schema; it cannot call tools disabled by the current mode.",
      inputSchema: {
        action: z.string().optional().describe("Action or registered tool name. Use list_actions to see what this server mode allows."),
        args: z.record(z.any()).optional().describe("Arguments for the selected action. Same shape as the wrapped CodexPro tool.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro supertool action...",
        "openai/toolInvocation/invoked": "CodexPro supertool action complete"
      }
    },
    async (args) => {
      const action = normalizeSupertoolAction(args.action);
      const names = registeredToolNames(server).filter((name) => name !== SUPERTOOL_NAME);
      if (action === "list_actions" || action === "help") {
        const text = [
          "# CodexPro Supertool",
          "",
          "Use `codexpro` only when a stable wrapper is useful for ChatGPT connector caching or custom workflows. The explicit tools remain the preferred default because they give clearer descriptions and validation.",
          "",
          "## Available actions",
          "",
          names.length ? names.map((name) => `- ${name}`).join("\n") : "- none",
          "",
          "## Usage",
          "",
          "```json",
          JSON.stringify({ action: "search", args: { workspace_id: "ws_...", query: "needle", path: "src" } }, null, 2),
          "```"
        ].join("\n");
        return textResult(text, {
          actions: names,
          action_count: names.length,
          aliases: SUPERTOOL_ACTION_ALIASES,
          tool_mode: config.toolMode,
          bash_mode: config.bashMode,
          write_mode: config.writeMode
        });
      }

      if (action === SUPERTOOL_NAME) {
        throw new CodexProError("codexpro cannot call itself. Use action=list_actions to inspect available wrapped actions.");
      }

      const handler = registeredToolHandler(server, action);
      if (!handler) {
        throw new CodexProError(
          `CodexPro action is not available in the current mode: ${action}. ` +
            "Call codexpro with action=list_actions, or restart CodexPro with a broader tool mode if that action should be exposed."
        );
      }

      const childArgs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? args.args
          : {};
      let result: any;
      try {
        result = await handler(childArgs);
      } catch (error) {
        result = errorResult(error);
      }
      if (result && typeof result === "object") {
        const structured = result.structuredContent;
        result.structuredContent = {
          codexpro_tool: action,
          codexpro_title: action,
          codexpro_super_action: action,
          wrapped_tool: action,
          ...(structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {})
        };
      }
      return result;
    }
  );

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show CodexPro server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro server config...",
        "openai/toolInvocation/invoked": "CodexPro server config ready"
      }
    },
    async () => {
      const safeConfig = {
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        toolCards: config.toolCards,
        connectionTest: config.connectionTest,
        analysisEnabled: config.analysisEnabled,
        analysisLimits: config.analysisLimits,
        inheritEnv: config.inheritEnv,
        contextDir: config.contextDir,
        maxReadBytes: config.maxReadBytes,
        maxWriteBytes: config.maxWriteBytes,
        maxImportBytes: config.maxImportBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length
      };
      return textResult(`# CodexPro Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "runtime_status",
    {
      title: "Runtime Status",
      description: "Read-only live CodexPro process status plus one bounded sanitized last-failure record. It never restarts or changes runtime state.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading CodexPro runtime status...",
        "openai/toolInvocation/invoked": "CodexPro runtime status ready"
      }
    },
    async () => {
      const status = runtimeStatusPayload(config);
      const text = [
        "# CodexPro Runtime Status",
        "",
        `Health: ${status.health}`,
        `HTTP child: ${JSON.stringify(status.http_child)}`,
        `Launcher: ${JSON.stringify(status.launcher)}`,
        `Tunnel: ${JSON.stringify(status.tunnel)}`,
        `Endpoint: ${status.endpoint}`,
        `Run: ${status.run_id ?? "unknown"}`,
        `Uptime: ${status.uptime_seconds} seconds`,
        `Last failure: ${status.last_failure_relation}`,
        status.last_failure ? JSON.stringify(status.last_failure, null, 2) : "No durable failure record."
      ].join("\n");
      return textResult(text, status);
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_self_test",
    {
      title: "CodexPro Self Test",
      description:
        "Run one controlled, local-only CodexPro diagnostic. It checks modes, expected tools, workspace access, skills, git, safe bash policy, selected-only Pro context, and optional .ai-bridge write/edit probe without touching source files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        write_probe: z.boolean().optional().describe("Create/edit only .ai-bridge/codexpro-self-test.md. Default: true."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        pro_context_probe: z.boolean().optional().describe("Build a selected-only Pro context bundle in memory without writing pro-context.md. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running CodexPro self-test...",
        "openai/toolInvocation/invoked": "CodexPro self-test complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const filesTouched: string[] = [];
      const probePath = `${config.contextDir}/codexpro-self-test.md`;

      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check(
        "http auth",
        "pass",
        config.authToken
          ? "token configured"
          : config.requireHttpToken
            ? "token required when serving HTTP"
            : "token auth explicitly disabled"
      );
      const expectedTools = toolNamesForMode(config).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );

      try {
        const inventory = await codexproInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const status = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(status);
        const changed = gitFailed ? 0 : changedStatusLines(status).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? status : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.write_probe, true)) {
        if (config.writeMode === "off") {
          check("write/edit probe", "warn", "skipped because CODEXPRO_WRITE_MODE=off");
        } else {
          try {
            assertWriteToolAllowed(config, probePath);
            const content = [
              "# CodexPro Self Test",
              "",
              `Updated: ${new Date().toISOString()}`,
              `Workspace: ${workspace.root}`,
              "marker: before",
              ""
            ].join("\n");
            await writeTextFile(config, guard, workspace, probePath, content, { createDirs: true, overwrite: true });
            await editTextFile(config, guard, workspace, probePath, "marker: before", "marker: after", { expectedReplacements: 1 });
            const readBack = await readTextFile(config, guard, workspace, probePath, { maxBytes: 20_000 });
            if (!readBack.text.includes("marker: after")) throw new CodexProError("self-test edit marker was not found after edit.");
            const scopedStatus = gitStatus(config, workspace, guard, probePath);
            const scopedFiles = changedStatusLines(scopedStatus);
            filesTouched.push(probePath);
            check(
              "write/edit probe",
              scopedFiles.length && scopedFiles.every((line) => line.includes(probePath)) ? "pass" : "warn",
              scopedFiles.length ? `path-scoped status: ${scopedFiles.join(", ")}` : "path-scoped status clean after write/edit"
            );
          } catch (error) {
            check("write/edit probe", "fail", errorText(error));
          }
        }
      } else {
        check("write/edit probe", "warn", "skipped by request");
      }

      if (parseBool(args.pro_context_probe, true)) {
        try {
          if (!filesTouched.includes(probePath)) {
            check("selected-only pro context", "warn", "skipped because write probe did not create the selected file");
          } else {
            const context = await buildProContext(config, guard, workspace, {
              title: "CodexPro Self Test Context",
              selectedPaths: [probePath],
              includeImportantFiles: false,
              includeChangedFiles: false,
              includeDiff: false,
              includeAiBridge: false,
              maxFiles: 4,
              maxTotalBytes: 80_000
            });
            const exactOnly = context.filesIncluded.length === 1 && context.filesIncluded[0] === probePath;
            check(
              "selected-only pro context",
              exactOnly ? "pass" : "fail",
              exactOnly ? `included only ${probePath}` : `included ${context.filesIncluded.join(", ") || "no files"}`
            );
          }
        } catch (error) {
          check("selected-only pro context", "fail", errorText(error));
        }
      } else {
        check("selected-only pro context", "warn", "skipped by request");
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check(
        "terms boundary",
        "pass",
        "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute remote/local agents from MCP"
      );

      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const text = [
        "# CodexPro Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}${config.bashSessionId ? `, bash_session=${config.bashSessionId}${config.requireBashSession ? " required" : ""}` : ""}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`),
        "",
        "## Terms Boundary",
        "",
        "CodexPro exposes local repo tools to the ChatGPT session the user controls. It does not provide models, proxy model access, resell access, modify quotas, bypass limits, or run local implementation agents through remote MCP tools."
      ].join("\n");

      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        status,
        passed,
        warned,
        failed,
        duration_ms: Date.now() - started,
        expected_tools: expectedTools,
        expected_tool_count: expectedTools.length,
        registered_tools: actualTools,
        registered_tool_count: actualTools.length,
        bash_mode: config.bashMode,
        bash_session_id: config.bashSessionId ?? null,
        require_bash_session: config.requireBashSession,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        files_touched: filesTouched,
        checks,
        terms_boundary: {
          local_workspace_bridge: true,
          provides_models: false,
          proxies_model_access: false,
          bypasses_quotas: false,
          remote_agent_execution: false
        }
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "codexpro_inventory",
    {
      title: "CodexPro Inventory",
      description:
        "List CodexPro modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to list. Default: 120.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading CodexPro inventory...",
        "openai/toolInvocation/invoked": "CodexPro inventory ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const inventory = await codexproInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 120, 1, 500)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        name: z.string().describe("Exact skill name from skill_inventory or codexpro_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source override. Without it, the highest-precedence skill is loaded."),
        path: z.string().optional().describe("Optional exact sanitized path override for diagnostics or an explicitly selected suppressed duplicate."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: auto when source/path is not workspace."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to scan while resolving the requested skill. Default: 500."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      const includeGlobalDefault =
        args.source === undefined ||
        (args.source !== undefined && args.source !== "workspace") ||
        Boolean(requestedPath && !requestedPath.startsWith("$WORKSPACE/"));
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: requestedPath,
        includeGlobal: parseBool(args.include_global_skills, includeGlobalDefault),
        maxSkills: limitInt(args.max_skills, 500, 1, 500),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List workspaces opened in this MCP session and identify the currently selected workspace.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing CodexPro workspaces...",
        "openai/toolInvocation/invoked": "CodexPro workspaces listed"
      }
    },
    async () => {
      const selectedWorkspaceId = workspaces.currentWorkspaceId();
      const current = workspaces.listWorkspaces();
      const text = current
        .map((workspace) => `- ${workspace.id} — ${workspace.root}${workspace.id === selectedWorkspaceId ? " (selected)" : ""} (opened ${workspace.openedAt})`)
        .join("\n");
      return textResult(text, {
        workspaces: current,
        count: current.length,
        selected_workspace_id: selectedWorkspaceId
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Open and select the configured default workspace for this MCP session. Use this to return to the launch workspace after switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current CodexPro workspace...",
        "openai/toolInvocation/invoked": "Current CodexPro workspace opened"
      }
    },
    async (args) => {
      const workspace = workspaces.selectDefaultWorkspace();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        selected_workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open and select an allowed local project for this MCP session. Later tool calls may omit workspace_id to use this selection.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use CODEXPRO_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false."),
        bootstrap_context: z.boolean().optional().describe("Deprecated and ignored. Use handoff_to_agent to create .ai-bridge files.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening CodexPro workspace...",
        "openai/toolInvocation/invoked": "CodexPro workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new CodexProError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = workspaces.openWorkspace(args.root ?? args.path);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false),
        bootstrapContext: false
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        selected_workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, .ai-bridge context, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      const ai = await readAiBridgeContext(config, guard, workspace);
      const text = `${summary.text}\n\n## AI handoff context\n\n${ai.text}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        ai_context_files: ai.files,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "inspect_workspace",
    {
      title: "Inspect Workspace",
      description: "Build a bounded repository map with languages, project types, entrypoints, areas, symbols, relationships, and coverage warnings.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional workspace-relative area to emphasize. Default: entire workspace."),
        max_files: z.number().int().min(1).max(100000).optional().describe("Maximum returned file records. Default: 300."),
        include_symbols: z.boolean().optional().describe("Include symbols in structured output. Default: true."),
        include_relationships: z.boolean().optional().describe("Include relationships in structured output. Default: true."),
        max_symbols: z.number().int().min(1).max(100000).optional().describe("Maximum returned symbols. Analysis remains bounded by server config."),
        max_relationships: z.number().int().min(1).max(250000).optional().describe("Maximum returned relationships. Analysis remains bounded by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Inspecting workspace analysis...",
        "openai/toolInvocation/invoked": "Workspace analysis ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      if (args.path) guard.resolve(workspace, args.path);
      const result = await inspectWorkspace(config, guard, workspace);
      const prefix = typeof args.path === "string" && args.path.trim()
        ? guard.resolve(workspace, args.path).relPath.replace(/^\.\/?$/, "")
        : "";
      const inScope = (filePath: string) => !prefix || filePath === prefix || filePath.startsWith(`${prefix}/`);
      const areaInScope = (areaPath: string) => !prefix || areaPath === "." || inScope(areaPath) || prefix.startsWith(`${areaPath}/`);
      const cardWorkspaceAnalysis = usesToolCard(config, "inspect_workspace");
      const fileLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_files, 300, 1, config.analysisLimits.maxInventoryFiles);
      const symbolLimit = cardWorkspaceAnalysis ? 80 : limitInt(args.max_symbols, 500, 1, config.analysisLimits.maxSymbols);
      const relationshipLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_relationships, 800, 1, config.analysisLimits.maxRelationships);
      const scopedFiles = result.files.filter((file) => inScope(file.path));
      const scopedSymbols = result.symbols.filter((symbol) => inScope(symbol.path));
      const scopedRelationships = result.relationships.filter((relationship) => inScope(relationship.from) || inScope(relationship.to));
      const files = scopedFiles.slice(0, fileLimit);
      const symbols = args.include_symbols === false
        ? []
        : scopedSymbols.slice(0, symbolLimit);
      const relationships = args.include_relationships === false
        ? []
        : scopedRelationships.slice(0, relationshipLimit);
      const outputLimited = files.length < scopedFiles.length ||
        (args.include_symbols !== false && symbols.length < scopedSymbols.length) ||
        (args.include_relationships !== false && relationships.length < scopedRelationships.length);
      const outputWarnings = [
        ...result.warnings,
        ...(outputLimited ? ["Structured output was limited. Use path or max_* arguments to request a narrower or larger result."] : [])
      ];
      const text = [
        "# Workspace Analysis",
        "",
        `Workspace: ${workspace.root}`,
        `Projects: ${result.projectTypes.join(", ") || "unknown"}`,
        `Languages: ${result.languages.join(", ") || "unknown"}`,
        `Entrypoints: ${result.entrypoints.filter(inScope).join(", ") || "none detected"}`,
        `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files analyzed, ${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships${result.coverage.truncated ? " (partial)" : ""}`,
        `Returned: ${files.length} files, ${symbols.length} symbols, ${relationships.length} relationships`,
        ...(outputWarnings.length ? ["", "## Warnings", "", ...outputWarnings.map((warning) => `- ${warning}`)] : [])
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? ".",
        languages: result.languages,
        project_types: result.projectTypes,
        entrypoints: result.entrypoints.filter(inScope),
        important_files: result.importantFiles.filter(inScope),
        areas: result.areas.filter((area) => areaInScope(area.path)),
        files,
        symbols,
        relationships,
        coverage: result.coverage,
        warnings: outputWarnings,
        output_limited: outputLimited,
        returned: { files: files.length, symbols: symbols.length, relationships: relationships.length },
        cache: result.cache
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Requires ripgrep. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config."),
        intent: z.enum(["auto", "text", "symbol", "references", "impact"]).optional().describe("Optional structured search intent. Omit for legacy lexical behavior."),
        symbol: z.string().optional().describe("Optional symbol query. Uses repository analysis and overrides query text."),
        include_tests: z.boolean().optional().describe("Include related tests in structured results. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults),
        intent: args.intent,
        symbol: args.symbol,
        includeTests: args.include_tests === undefined ? undefined : parseBool(args.include_tests, false)
      });
      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        matches: result.matches,
        truncated: result.truncated,
        used: result.used
      };
      if (result.analysis) structured.analysis = result.analysis;
      return preserveSearchMatchText(textResult(result.text, structured), result);
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit/apply_patch unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum file bytes. Capped by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await readPublicTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const body = publicSourceBody(result.text);
      const text = [
        {
          kind: "normal" as const,
          text: `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\n\n\`\`\`text\n`
        },
        body,
        { kind: "normal" as const, text: "\n\`\`\`" }
      ] as const;
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result }, {}, {
        sourceFields: [{ path: ["text"], body }]
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_many",
    {
      title: "Read Many",
      description: `Read 1-${READ_MANY_MAX_ITEMS} bounded text files in input order by composing read. Each item may set start_line, end_line, and max_bytes using read's semantics. Item failures are isolated with {index,path,error}; the request has a ${READ_MANY_DEFAULT_MAX_TOTAL_BYTES}-byte default and ${READ_MANY_MAX_TOTAL_BYTES}-byte maximum serialized response budget including a ${READ_MANY_RESPONSE_FRAMING_RESERVE_BYTES}-byte framing reserve (lowered by maxOutputBytes when configured).`,
      inputSchema: READ_MANY_PUBLIC_SCHEMA,
      runtimeInputSchema: READ_MANY_TRANSPORT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading multiple files...",
        "openai/toolInvocation/invoked": "Multiple files read"
      }
    },
    async (args) => {
      const validatedArgs = parseReadManyArguments(args);
      const workspace = workspaces.getWorkspace(validatedArgs.workspace_id);
      const configuredMaxTotalBytes = Math.min(READ_MANY_MAX_TOTAL_BYTES, config.maxOutputBytes);
      const requestedMaxTotalBytes = validatedArgs.max_total_bytes ?? Math.min(READ_MANY_DEFAULT_MAX_TOTAL_BYTES, configuredMaxTotalBytes);
      if (requestedMaxTotalBytes > configuredMaxTotalBytes) {
        throw new CodexProError(`max_total_bytes (${requestedMaxTotalBytes}) exceeds the configured read_many response limit (${configuredMaxTotalBytes} bytes).`);
      }

      const results: ReadManyResult[] = [];
      for (const [index, item] of validatedArgs.items.entries()) {
        let result: ReadManyResult;
        try {
          const readResult = await readPublicTextFile(config, guard, workspace, item.path, {
            startLine: item.start_line,
            endLine: item.end_line,
            maxBytes: item.max_bytes
          });
          result = { index, path: item.path, ok: true, result: readResult };
        } catch (error) {
          result = { index, path: item.path, ok: false, error: boundedReadManyError(error) };
        }

        const candidateResults = [...results, result];
        const candidate = readManyResponse(workspace, candidateResults, requestedMaxTotalBytes);
        if (serializedReadManyResponseBytes(candidate) + READ_MANY_RESPONSE_FRAMING_RESERVE_BYTES > requestedMaxTotalBytes) {
          throw new CodexProError(`read_many aggregate response exceeds max_total_bytes (${requestedMaxTotalBytes} bytes); no items were omitted.`);
        }
        results.push(result);
      }

      return readManyResponse(workspace, results, requestedMaxTotalBytes);
    }
  );

  registerCodexTool(
    config,
    server,
    "view_image",
    {
      title: "View Image",
      description: "Inspect a PNG, JPEG, GIF, or WebP image from the active workspace. Returns native MCP image content plus dimensions and SHA-256.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("Image path relative to workspace root."),
        max_bytes: z.number().int().min(4096).max(2000000).optional().describe("Maximum image bytes. Default: at least 1 MB, capped at 2 MB.")
      },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await viewWorkspaceImage(config, guard, workspace, args.path, args.max_bytes);
      const dimensions = result.width && result.height ? `${result.width}x${result.height}` : "unknown";
      return {
        content: [
          {
            type: "text",
            text: `Image: ${result.path}\nType: ${result.mimeType}\nDimensions: ${dimensions}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}`
          },
          { type: "image", data: result.data, mimeType: result.mimeType }
        ],
        structuredContent: redactStructured({
          workspace_id: workspace.id,
          root: workspace.root,
          path: result.path,
          mime_type: result.mimeType,
          width: result.width ?? null,
          height: result.height ?? null,
          bytes: result.bytes,
          sha256: result.sha256
        })
      };
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. New files use an atomic rename; existing files retain their inode and metadata. Returns a unified diff; pass the SHA from read when overwriting shared files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails instead of overwriting if another session changed the file.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
        createDirs: args.create_dirs !== false,
        overwrite: args.overwrite !== false,
        expectedSha256: args.expected_sha256
      });
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const diffBody = publicSourceBody(result.diff.diff);
      const text: readonly PublicTextSegment[] = [
        {
          kind: "normal",
          text: `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}`
        },
        ...sourceDiffBlock(result.diff.diff)
      ];
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      }, {}, { sourceFields: [{ path: ["diff"], body: diffBody }] });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement while retaining the existing file inode and metadata. Returns a unified diff; pass the SHA from read to reject stale multi-session edits.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 from read. Fails if another session changed the file.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
        replaceAll: parseBool(args.replace_all, false),
        expectedReplacements: args.expected_replacements,
        expectedSha256: args.expected_sha256
      });
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const diffBody = publicSourceBody(result.diff.diff);
      const text: readonly PublicTextSegment[] = [
        {
          kind: "normal",
          text: `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}`
        },
        ...sourceDiffBlock(result.diff.diff)
      ];
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      }, {}, { sourceFields: [{ path: ["diff"], body: diffBody }] });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply one unified diff patch inside the workspace. Paths are validated before applying. Prefer edit for tiny replacements and apply_patch for multi-file diffs.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        patch: z.string().describe("Unified diff patch to apply. File paths must stay inside the workspace and avoid blocked paths.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying patch...",
        "openai/toolInvocation/invoked": "Patch applied"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await applyWorkspacePatch(config, guard, workspace, String(args.patch ?? ""));
      if (result.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text: PublicTextSegment[] = [{
        kind: "normal",
        text: `# Apply Patch\n\nPaths: ${result.paths.join(", ")}\nDiff stats: +${result.additions} -${result.deletions}`
      }];
      if (result.stderr) text.push({ kind: "normal", text: `\nstderr: ${result.stderr}` });
      const diffBody = result.diff ? publicSourceBody(result.diff) : undefined;
      if (result.diff) text.push(...sourceDiffBlock(result.diff));
      else text.push({ kind: "normal", text: "\n\nNo diff output." });
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        paths: result.paths,
        stdout: result.stdout,
        stderr: result.stderr,
        additions: result.additions,
        deletions: result.deletions,
        changed: result.changed,
        diff: result.diff
      }, {}, diffBody ? { sourceFields: [{ path: ["diff"], body: diffBody }] } : {});
    }
  );

  registerCodexTool(
    config,
    server,
    "import_file",
    {
      title: "Import Attachment File",
      description:
        "Import a ChatGPT Apps SDK attachment into the workspace. Accepts only a platform file object with download_url and file_id. Not a general URL downloader. Overwrite is off by default.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        file: z
          .object({
            download_url: z.string().describe("Temporary HTTPS download URL provided by ChatGPT."),
            file_id: z.string().describe("ChatGPT file id for this attachment."),
            mime_type: z.string().optional().describe("Optional MIME type declared by ChatGPT."),
            file_name: z.string().optional().describe("Optional original file name declared by ChatGPT.")
          })
          .describe("ChatGPT Apps SDK file reference from openai/fileParams."),
        destination: z.string().describe("Destination path relative to the workspace root."),
        overwrite: z.boolean().optional().describe("Replace an existing destination file. Default: false."),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional().describe("Optional SHA-256 of the attachment bytes. Import fails on mismatch.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/fileParams": ["file"],
        "openai/toolInvocation/invoking": "Importing attachment...",
        "openai/toolInvocation/invoked": "Attachment imported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.destination, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await importAttachmentFile(config, guard, workspace, {
        file: args.file,
        destination: String(args.destination ?? ""),
        overwrite: args.overwrite === true,
        expectedSha256: args.expected_sha256
      });
      invalidateWorkspaceAnalysis(workspace.id);
      const text = [
        "# Import File",
        "",
        `Path: ${result.path}`,
        `Bytes: ${result.bytes}`,
        `SHA-256: ${result.sha256}`,
        `Declared MIME: ${result.declared_mime_type ?? "unknown"}`,
        `Detected MIME: ${result.detected_mime_type ?? "unknown"}`,
        `MIME status: ${result.mime_type_status}`,
        `Verified: ${result.verified}`,
        `Overwritten: ${result.overwritten}`
      ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        declared_mime_type: result.declared_mime_type,
        detected_mime_type: result.detected_mime_type,
        mime_type_status: result.mime_type_status,
        sha256: result.sha256,
        verified: result.verified,
        file_id: result.file_id,
        file_name: result.file_name,
        overwritten: result.overwritten
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted verification command in the workspace, such as tests, build, lint, typecheck, or a project script. Do not use for git status/diff or file inspection; use show_changes, tree, search, and read instead. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z
          .number()
          .int()
          .min(1000)
          .max(config.maxBashTimeoutMs)
          .optional()
          .describe(`Timeout in milliseconds. Default: 30000. Max: ${config.maxBashTimeoutMs}.`)
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await runBash(config, guard, workspace, String(args.command ?? ""), {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id
      });
      const text = bashTextResult(config, result);
      return diagnosticTextResult(text, { workspace_id: workspace.id, root: workspace.root, ...result, bash_session_id: result.bashSessionId ?? null });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_commit",
    {
      title: "Git Commit",
      description: `Create one ordinary local commit for exactly the named file or symlink identities in an explicitly supplied workspace, only when expected_head is the exact current full commit SHA. Unrelated staged, unstaged, and untracked work is preserved; hooks and configured Git policy remain enabled; no remote operations are performed. Available only in full tool mode with CODEXPRO_WRITE_MODE=workspace.`,
      inputSchema: GIT_COMMIT_PUBLIC_SCHEMA,
      runtimeInputSchema: GIT_COMMIT_ARGUMENTS_SCHEMA,
      annotations: GIT_COMMIT_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Creating local Git commit...",
        "openai/toolInvocation/invoked": "Local Git commit created"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await gitCommit(config, guard, workspace, args);
      const text = [
        "# Git Commit",
        "",
        `Workspace: ${result.root}`,
        `Branch: ${result.branch}`,
        `Old HEAD: ${result.old_head}`,
        `New HEAD: ${result.new_head}`,
        `Paths committed: ${result.committed_path_count}/${result.requested_path_count}`
      ].join("\n");
      return textResult(text, { ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_resolve_ref",
    {
      title: "Resolve Git Ref",
      description: "Resolve one bounded local Git commit-ish to an immutable full commit identity without changing repository state or contacting remotes.",
      inputSchema: GIT_RESOLVE_REF_PUBLIC_SCHEMA,
      runtimeInputSchema: GIT_RESOLVE_REF_ARGUMENTS_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Resolving Git ref...",
        "openai/toolInvocation/invoked": "Git ref resolved"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = await gitResolveRef(config, workspace, args.ref);
      const text = [
        "# Resolve Git Ref",
        "",
        `Workspace: ${workspace.root}`,
        `Input ref: ${resolved.input}`,
        `Object format: ${resolved.objectFormat}`,
        `Commit: ${resolved.fullSha}`,
        `Short commit: ${resolved.shortSha}`
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        ...publicGitReviewRef(resolved)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_merge_base",
    {
      title: "Git Merge Base",
      description: "Resolve two local Git refs once and return all best merge bases plus truthful ancestor and incomplete-history state.",
      inputSchema: GIT_MERGE_BASE_PUBLIC_SCHEMA,
      runtimeInputSchema: GIT_MERGE_BASE_ARGUMENTS_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Computing Git merge bases...",
        "openai/toolInvocation/invoked": "Git merge bases ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await gitMergeBase(config, workspace, args.left_ref, args.right_ref);
      const text = [
        "# Git Merge Base",
        "",
        `Workspace: ${workspace.root}`,
        `Left ref: ${result.left.input} (${result.left.fullSha})`,
        `Right ref: ${result.right.input} (${result.right.fullSha})`,
        `Merge bases: ${result.mergeBases.length ? result.mergeBases.join(", ") : "none"}`,
        `Left is ancestor: ${result.leftIsAncestor === null ? "unknown" : result.leftIsAncestor}`,
        `Right is ancestor: ${result.rightIsAncestor === null ? "unknown" : result.rightIsAncestor}`,
        `Unrelated: ${result.unrelated === null ? "unknown" : result.unrelated}`,
        `History complete: ${result.historyComplete}`
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        object_format: result.objectFormat,
        left: publicGitReviewRef(result.left),
        right: publicGitReviewRef(result.right),
        merge_bases: result.mergeBases,
        left_is_ancestor: result.leftIsAncestor,
        right_is_ancestor: result.rightIsAncestor,
        unrelated: result.unrelated,
        history_complete: result.historyComplete
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_log",
    {
      title: "Git Log",
      description: "Read a bounded structured local Git history from one immutable starting ref, optionally filtered by a validated historical repository-tree path.",
      inputSchema: GIT_LOG_PUBLIC_SCHEMA,
      runtimeInputSchema: GIT_LOG_ARGUMENTS_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading structured Git history...",
        "openai/toolInvocation/invoked": "Structured Git history ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await gitLogStructured(config, guard, workspace, {
        startRef: args.start_ref,
        path: args.path,
        maxCount: args.max_count
      });
      const commits = result.commits.map(publicGitLogCommit);
      const text = [
        "# Git Log",
        "",
        `Workspace: ${workspace.root}`,
        `Start ref: ${result.start.input} (${result.start.fullSha})`,
        `Path: ${result.path ?? "all paths"}`,
        `Commits returned: ${result.commits.length}`,
        `Has more: ${result.hasMore}`,
        "",
        ...result.commits.map((commit) =>
          `- ${commit.fullSha} ${commit.authoredAt} ${commit.authorName}: ${commit.subject}`
        )
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        start: publicGitReviewRef(result.start),
        commits,
        has_more: result.hasMore,
        max_count: result.maxCount,
        ...(result.path === undefined ? {} : { path: result.path })
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_show_commit",
    {
      title: "Show Git Commit",
      description: "Read bounded local Git commit metadata and message text for one immutable ref; it does not produce a patch or first-parent diff.",
      inputSchema: GIT_SHOW_COMMIT_PUBLIC_SCHEMA,
      runtimeInputSchema: GIT_SHOW_COMMIT_ARGUMENTS_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading Git commit...",
        "openai/toolInvocation/invoked": "Git commit ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await gitShowCommit(config, workspace, args.ref);
      const text = [
        "# Git Commit",
        "",
        `Workspace: ${workspace.root}`,
        `Ref: ${result.input} (${result.fullSha})`,
        `Tree: ${result.treeSha}`,
        `Parents: ${result.parents.length ? result.parents.join(", ") : "none"}`,
        `Root: ${result.isRoot}`,
        `Merge: ${result.isMerge}`,
        `Author: ${result.authorName} (${result.authoredAt})`,
        `Committer: ${result.committerName} (${result.committedAt})`,
        `Subject: ${result.subject}`,
        `Message bytes: ${result.messageBytes}${result.messageTruncated ? " (truncated)" : ""}`,
        "",
        "## Body",
        "",
        result.body
      ].join("\n");
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        ref: publicGitReviewRef(result),
        commit_sha: result.fullSha,
        object_format: result.objectFormat,
        tree_sha: result.treeSha,
        parents: result.parents,
        is_root: result.isRoot,
        is_merge: result.isMerge,
        author_name: result.authorName,
        authored_at: result.authoredAt,
        committer_name: result.committerName,
        committed_at: result.committedAt,
        subject: result.subject,
        body: result.body,
        message_bytes: result.messageBytes,
        message_truncated: result.messageTruncated
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_at_ref",
    {
      title: "Read File at Git Ref",
      description: "Read a bounded text blob from an immutable historical Git tree path without checkout or symlink dereference; source text uses the existing public-read redaction boundary.",
      inputSchema: readAtRefSchemas.publicSchema,
      runtimeInputSchema: readAtRefSchemas.runtimeSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading historical source...",
        "openai/toolInvocation/invoked": "Historical source ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await readAtRef(config, guard, workspace, {
        ref: args.ref,
        path: args.path,
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: args.max_bytes
      });
      const body = publicSourceBody(result.text);
      const text = [
        {
          kind: "normal" as const,
          text: [
            "# Read Historical File",
            "",
            `Workspace: ${workspace.root}`,
            `Ref: ${result.ref.input} (${result.commitSha})`,
            `Path: ${result.path}`,
            `Git mode: ${result.gitMode}`,
            `Entry kind: ${result.entryKind}`,
            `Lines: ${result.startLine}-${result.endLine} of ${result.totalLines}`,
            `Bytes: ${result.bytes}`,
            `Blob SHA: ${result.blobSha}`,
            `SHA-256: ${result.sha256}`,
            `Truncated: ${result.truncated}`,
            "",
            "```text"
          ].join("\n")
        },
        body,
        { kind: "normal" as const, text: "\n```" }
      ] as const;
      return textResult(text, {
        schema_version: 1,
        workspace_id: workspace.id,
        root: workspace.root,
        ref: publicGitReviewRef(result.ref),
        object_format: result.ref.objectFormat,
        commit_sha: result.commitSha,
        path: result.path,
        git_mode: result.gitMode,
        entry_kind: result.entryKind,
        blob_sha: result.blobSha,
        text: result.text,
        start_line: result.startLine,
        end_line: result.endLine,
        total_lines: result.totalLines,
        bytes: result.bytes,
        sha256: result.sha256,
        truncated: result.truncated
      }, {}, {
        sourceFields: [{ path: ["text"], body }]
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace status",
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff_range",
    {
      title: "Git Diff Range",
      description: "Compare two exact local Git commit trees and return bounded changed-file metadata with redacted complete patch evidence.",
      inputSchema: GIT_DIFF_RANGE_PUBLIC_SCHEMA,
      runtimeInputSchema: GIT_DIFF_RANGE_RUNTIME_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Reading historical Git range...",
        "openai/toolInvocation/invoked": "Historical Git range ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await gitDiffRange(config, guard, workspace, {
        baseRef: args.base_ref,
        headRef: args.head_ref,
        path: args.path,
        includePatch: args.include_patch,
        maxFiles: args.max_files,
        maxPatchBytes: args.max_patch_bytes,
        contextLines: args.context_lines
      });
      const patchBody = publicSourceBody(result.patch);
      const warningText = result.warnings.length > 0
        ? result.warnings.map((warning) => `- ${warning}`).join("\n")
        : "None";
      const patchText = result.patch_requested
        ? `${result.patch_included ? "included" : "empty"}; ${result.patch_bytes} bytes of ${result.patch_limit}; ${result.patch_files_included} files included, ${result.patch_files_omitted} omitted${result.patch_truncated ? "; truncated" : ""}`
        : `disabled; ${result.patch_files_omitted} omitted`;
      const text = [
        "# Git Diff Range",
        "",
        `Workspace: ${workspace.root}`,
        `Comparison: ${result.comparison_mode}`,
        `Base: ${result.base_ref_input} (${result.base_commit_sha})`,
        `Head: ${result.head_ref_input} (${result.head_commit_sha})`,
        `Path: ${result.path ?? "all paths"}`,
        `Changed files: ${result.changed_file_count} total, ${result.eligible_changed_file_count} eligible, ${result.returned_file_count} returned${result.changed_files_truncated ? " (truncated)" : ""}`,
        `Blocked records omitted: ${result.blocked_files_omitted}`,
        `Patch: ${patchText}`,
        "",
        "Warnings:",
        warningText
      ].join("\n");
      return textResult(text, { ...result }, {}, {
        sourceFields: [{ path: ["patch"], body: patchBody }]
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const diffBody = !diffError && includeDiff ? publicSourceBody(rawDiff) : undefined;
      const text: string | readonly PublicTextSegment[] = diffError
        ? diffError
        : includeDiff
        ? [{ kind: "public-source-body", text: rawDiff }]
        : [
            {
              kind: "normal",
              text: [
                "# Git Diff",
                "",
                `Workspace: ${workspace.root}`,
                `Path: ${args.path ?? "workspace diff"}`,
                `Staged: ${parseBool(args.staged, false)}`,
                `Diff stats: +${stats.additions} -${stats.deletions}`,
                "",
                "Raw diff omitted by include_diff=false."
              ].join("\n")
            }
          ];
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      }, {}, diffBody ? { sourceFields: [{ path: ["diff"], body: diffBody }] } : {});
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true."),
        since: z.enum(["last_shown", "workspace"]).optional().describe("Use last_shown to suppress unchanged repeated reviews. Default: last_shown."),
        mark_reviewed: z.boolean().optional().describe("Update the last-shown review checkpoint after this call. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const staged = parseBool(args.staged, false);
      const normalizedScopedPath = scopedPath?.trim() ? guard.resolve(workspace, scopedPath).relPath : undefined;
      const status = normalizeGitOutput(gitDiffStatus(config, guard, workspace, normalizedScopedPath, staged));
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, normalizedScopedPath, staged));
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const diff = diffError ? "" : rawDiff;
      const stats = diffStats(diff);
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const untrackedFingerprint = statusError ? "" : await untrackedReviewFingerprint(config, guard, workspace, changedFiles);
      const since = args.since === "workspace" ? "workspace" : "last_shown";
      const markReviewed = parseBool(args.mark_reviewed, true);
      const checkpointKey = reviewCheckpointKey(workspace, { path: normalizedScopedPath, staged });
      const fingerprint = reviewFingerprint(status, `${diff}\0${untrackedFingerprint}`);
      const checkpointHit = includeDiff && since === "last_shown" && reviewCheckpoints.get(checkpointKey) === fingerprint;
      const checkpointWritten = markReviewed && includeDiff;
      if (checkpointWritten) reviewCheckpoints.set(checkpointKey, fingerprint);
      const responseDiff = checkpointHit ? "" : includeDiff ? diff : "";
      const responseStats = checkpointHit ? { additions: 0, deletions: 0, changed: false } : stats;
      const changedPaths = statusError ? [] : changedPathsFromStatus(changedFiles);
      let analysis: Record<string, unknown> | undefined;
      if (config.analysisEnabled && changedPaths.length && !checkpointHit) {
        try {
          const impact = await reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
          analysis = {
            schema_version: impact.schemaVersion,
            changed_paths: impact.changedPaths,
            affected_areas: impact.affectedAreas,
            dependent_files: impact.dependentFiles,
            related_tests: impact.relatedTests,
            risk_signals: impact.riskSignals,
            recommended_commands: impact.recommendedCommands,
            coverage: impact.coverage,
            warnings: impact.warnings,
            cache: impact.cache
          };
        } catch (error) {
          analysis = {
            schema_version: 1,
            changed_paths: changedPaths,
            affected_areas: [],
            dependent_files: [],
            related_tests: [],
            risk_signals: [],
            recommended_commands: [],
            warnings: [`Change analysis unavailable: ${errorText(error)}`]
          };
        }
      }
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : checkpointHit
          ? "- No changes since last shown review."
          : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : "- No changed files.";
      const diffText = checkpointHit
        ? "\n\nNo new diff since last shown review."
        : includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
            : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const analysisText = analysis
        ? `\n\n## Analysis\n\nAffected areas: ${(analysis.affected_areas as string[]).join(", ") || "none"}\nRisks: ${((analysis.risk_signals as Array<{ label?: string }>) ?? []).map((risk) => risk.label).filter(Boolean).join(", ") || "none"}\nRelated tests: ${((analysis.related_tests as Array<{ path?: string }>) ?? []).map((file) => file.path).filter(Boolean).join(", ") || "none"}`
        : "";
      const text: PublicTextSegment[] = [{
        kind: "normal",
        text: `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${responseStats.additions} -${responseStats.deletions}`
      }];
      if (checkpointHit || !includeDiff || diffError || !diff) {
        text.push({ kind: "normal", text: diffText });
      } else {
        text.push(...sourceDiffBlock(diff));
      }
      if (analysisText) text.push({ kind: "normal", text: analysisText });
      const responseDiffBody = responseDiff ? publicSourceBody(responseDiff) : undefined;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        changed_files: checkpointHit ? [] : changedFiles,
        staged,
        include_diff: includeDiff,
        additions: responseStats.additions,
        deletions: responseStats.deletions,
        changed: !statusError && (checkpointHit ? false : changedFiles.length > 0 || responseStats.changed),
        diff: responseDiff,
        review_since: since,
        review_marked: checkpointWritten,
        review_checkpoint_hit: checkpointHit,
        ...(analysis ? { analysis } : {})
      }, {}, responseDiffBody ? { sourceFields: [{ path: ["diff"], body: responseDiffBody }] } : {});
    }
  );

  registerCodexTool(
    config,
    server,
    "read_handoff",
    {
      title: "Read Handoff",
      description: "Read the shared .ai-bridge planning files used for ChatGPT-to-agent coordination.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading agent handoff context...",
        "openai/toolInvocation/invoked": "Agent handoff context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const context = await readAiBridgeContext(config, guard, workspace);
      return textResult(context.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        files: context.files,
        file_count: context.files.length,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "wait_for_handoff",
    {
      title: "Wait For Handoff",
      description:
        "Read-only long-poll of the local handoff run state so ChatGPT can stay the planner/reviewer while a local executor runs. Reads .ai-bridge/handoff-run-state.json and returns the run status plus status/diff/log/test excerpts. It never starts processes or runs shell commands; it only observes local handoff state written by execute-handoff/watch-handoff/loop-handoff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        plan_hash: z.string().optional().describe("Expected current-plan.md hash. If set, only a terminal run with this plan_hash counts as completed."),
        since_iteration: z.number().int().min(0).optional().describe("Only treat a run with iteration greater than this as the awaited completion."),
        max_wait_seconds: z.number().int().min(1).max(60).optional().describe("Maximum seconds to long-poll before returning the current state. Default: 20."),
        poll_ms: z.number().int().min(250).max(5000).optional().describe("Poll interval in milliseconds. Default: 1000."),
        include_diff: z.boolean().optional().describe("Include the implementation diff excerpt when completed. Default: true."),
        include_log_excerpt: z.boolean().optional().describe("Include the tail of execution-log.jsonl when completed. Default: true."),
        include_tests: z.boolean().optional().describe("Include the loop-tests.txt excerpt when completed. Default: true.")
      },
      annotations: { ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Waiting for local handoff result...",
        "openai/toolInvocation/invoked": "Local handoff state ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const maxWaitSeconds = limitInt(args.max_wait_seconds, 20, 1, 60);
      const pollMs = limitInt(args.poll_ms, 1000, 250, 5000);
      const includeDiff = parseBool(args.include_diff, true);
      const includeLog = parseBool(args.include_log_excerpt, true);
      const includeTests = parseBool(args.include_tests, true);
      const expectedPlanHash =
        typeof args.plan_hash === "string" && args.plan_hash.trim() ? args.plan_hash.trim() : undefined;
      const sinceIteration =
        Number.isFinite(Number(args.since_iteration)) && args.since_iteration !== undefined
          ? Math.floor(Number(args.since_iteration))
          : undefined;

      const stateRel = `${config.contextDir}/handoff-run-state.json`;
      const contextPrefix = `${config.contextDir.replace(/\/+$/, "")}/`;
      const terminalStates = new Set(["completed", "failed", "timed_out"]);

      const readState = async (): Promise<Record<string, any> | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, stateRel);
          const parsed = JSON.parse(raw);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      };

      const isAwaited = (state: Record<string, any> | undefined): boolean =>
        Boolean(
          state &&
            terminalStates.has(state.state) &&
            (!expectedPlanHash || state.plan_hash === expectedPlanHash) &&
            (sinceIteration === undefined || (typeof state.iteration === "number" && state.iteration > sinceIteration))
        );

      const deadline = Date.now() + maxWaitSeconds * 1000;
      let state = await readState();
      while (Date.now() < deadline && !isAwaited(state)) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        state = await readState();
      }

      const awaitedTerminal = isAwaited(state);
      const awaitedCompleted = awaitedTerminal && state?.state === "completed";
      const planHashMismatch = Boolean(expectedPlanHash && state && state.plan_hash !== expectedPlanHash);
      const reportedState = awaitedTerminal
        ? String(state?.state)
        : state
          ? state.state === "running" || planHashMismatch || sinceIteration !== undefined
            ? "running"
            : String(state.state)
          : "unknown";

      const excerpt = async (rel: string, maxChars: number, tailLines?: number): Promise<string | undefined> => {
        try {
          const raw = await readRawTextFileBounded(config, guard, workspace, rel);
          const body = tailLines
            ? raw.split(/\r?\n/).filter(Boolean).slice(-tailLines).join("\n")
            : raw;
          const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n...[excerpt truncated]` : body;
          return redactSensitiveText(trimmed);
        } catch {
          return undefined;
        }
      };
      const bridgeArtifact = (value: unknown, fallback: string): string => {
        const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
        const normalized = path.posix.normalize(raw.split(path.sep).join("/")).replace(/^\.\//, "");
        return normalized.startsWith(contextPrefix) ? normalized : fallback;
      };

      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        state: reportedState,
        awaited_completed: awaitedCompleted,
        awaited_terminal: awaitedTerminal,
        succeeded: awaitedCompleted,
        state_file: stateRel,
        ...(state ? { run_state: state.state } : {}),
        ...(typeof state?.iteration === "number" ? { iteration: state.iteration } : {}),
        ...(state?.plan_hash ? { plan_hash: state.plan_hash } : {}),
        ...(expectedPlanHash ? { expected_plan_hash: expectedPlanHash, plan_hash_mismatch: planHashMismatch } : {}),
        ...(state && "exit_code" in state ? { exit_code: state.exit_code } : {}),
        ...(state && "timed_out" in state ? { timed_out: state.timed_out } : {}),
        ...(state?.started_at ? { started_at: state.started_at } : {}),
        ...(state?.finished_at ? { finished_at: state.finished_at } : {}),
        ...(state?.executor ? { executor: state.executor } : {}),
        ...(state?.model ? { model: state.model } : {}),
        ...(awaitedTerminal ? {} : { next_poll_after_seconds: Math.max(1, Math.ceil(pollMs / 1000)) })
      };

      if (awaitedTerminal) {
        const statusFile = bridgeArtifact(state?.status_file, `${config.contextDir}/agent-status.md`);
        const diffFile = bridgeArtifact(state?.diff_file, `${config.contextDir}/implementation-diff.patch`);
        const logFile = bridgeArtifact(state?.log_file, `${config.contextDir}/execution-log.jsonl`);
        const testsFile = bridgeArtifact(state?.tests_file, `${config.contextDir}/loop-tests.txt`);
        structured.status_file = statusFile;
        structured.diff_file = diffFile;
        structured.log_file = logFile;
        const status = await excerpt(statusFile, 6_000);
        if (status) structured.status_excerpt = status;
        if (includeDiff) {
          const diff = await excerpt(diffFile, 12_000);
          if (diff) structured.diff_excerpt = diff;
        }
        if (includeLog) {
          const log = await excerpt(logFile, 6_000, 20);
          if (log) structured.log_excerpt = log;
        }
        if (includeTests) {
          const tests = await excerpt(testsFile, 4_000);
          if (tests) {
            structured.tests_file = testsFile;
            structured.tests_excerpt = tests;
          }
        }
      }

      const summary = !state
        ? `No handoff run state found at ${stateRel}. Start a run with handoff_to_agent + local execute-handoff/watch-handoff, then call wait_for_handoff again.`
        : awaitedTerminal
          ? `Handoff run ${state.state} (iteration ${state.iteration ?? 1}, exit ${state.exit_code ?? "null"}).`
          : planHashMismatch
            ? `Executor has not completed the expected plan yet (last known run plan_hash=${state.plan_hash ?? "unknown"}). Still waiting.`
            : `Handoff run is ${state.state}. Re-poll after ~${Math.max(1, Math.ceil(pollMs / 1000))}s.`;

      const lines = [
        "# Wait For Handoff",
        "",
        summary,
        "",
        `State file: ${stateRel}`,
        ...(state?.plan_hash ? [`Plan hash: ${state.plan_hash}`] : []),
        ...(awaitedTerminal && structured.status_excerpt ? ["", "## Status", "", `\`\`\`text\n${structured.status_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.diff_excerpt ? ["", "## Diff", "", `\`\`\`diff\n${structured.diff_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.tests_excerpt ? ["", "## Tests", "", `\`\`\`text\n${structured.tests_excerpt}\n\`\`\``] : []),
        ...(awaitedTerminal && structured.log_excerpt ? ["", "## Log tail", "", `\`\`\`text\n${structured.log_excerpt}\n\`\`\``] : [])
      ];
      return textResult(lines.join("\n"), structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "codex_context",
    {
      title: "Codex Context",
      description:
        "Load Codex-style workspace context in one call: AGENTS instructions for a target path, .ai-bridge handoff files, and optional git status/diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        target_path: z.string().optional().describe("Workspace-relative file or directory whose AGENTS instruction chain should be loaded. Default: ."),
        include_ai_bridge: z.boolean().optional().describe("Include .ai-bridge plan, agent status, diff, decisions, questions, and execution log. Default: true."),
        include_git: z.boolean().optional().describe("Include git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include full git diff. Default: false for speed/noise."),
        max_agent_bytes: z.number().int().min(1000).max(200000).optional().describe("Maximum bytes per AGENTS file. Default: 60000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading Codex context...",
        "openai/toolInvocation/invoked": "Codex context ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const context = await readCodexContext(config, guard, workspace, {
        targetPath: args.target_path,
        includeAiBridge: args.include_ai_bridge,
        includeGit: args.include_git,
        includeDiff: parseBool(args.include_diff, false),
        maxAgentBytes: args.max_agent_bytes
      });
      return textResult(context.text, {
        workspace_id: context.workspaceId,
        root: context.root,
        target_path: context.targetPath,
        agents_files: context.agentsFiles,
        ai_context_files: context.aiContextFiles,
        included_git_status: context.gitStatus !== undefined,
        included_git_diff: context.gitDiff !== undefined,
        preview: previewText(context.text)
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "export_pro_context",
    {
      title: "Export Pro Context",
      description:
        "Create .ai-bridge/pro-context.md with repo tree, git state, selected files, and handoff context for high-context ChatGPT planning without live MCP tool calls.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        title: z.string().optional().describe("Markdown title for the context bundle."),
        selected_paths: z.array(z.string()).optional().describe("Specific workspace-relative files to include."),
        extra_globs: z.array(z.string()).optional().describe("Additional workspace-relative glob patterns to include, for example src/**/*.ts."),
        include_important_files: z.boolean().optional().describe("Auto-include important root config/docs such as AGENTS.md, README.md, and package.json. Default: true."),
        include_changed_files: z.boolean().optional().describe("Auto-include currently changed files from git status. Default: true."),
        include_diff: z.boolean().optional().describe("Include the current git diff. Default: true."),
        include_ai_bridge: z.boolean().optional().describe("Include existing .ai-bridge planning files. Default: true."),
        max_depth: z.number().int().min(1).max(6).optional().describe("Repository tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(80).optional().describe("Maximum file contents to include. Default: 24."),
        max_file_bytes: z.number().int().min(1000).max(250000).optional().describe("Maximum bytes per included file. Default: 60000."),
        max_total_bytes: z.number().int().min(20000).max(2000000).optional().describe("Maximum bytes in the generated bundle.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Exporting Pro context...",
        "openai/toolInvocation/invoked": "Pro context exported"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await exportProContext(config, guard, workspace, {
        title: args.title,
        selectedPaths: args.selected_paths,
        extraGlobs: args.extra_globs,
        includeImportantFiles: args.include_important_files,
        includeChangedFiles: args.include_changed_files,
        includeDiff: args.include_diff,
        includeAiBridge: args.include_ai_bridge,
        maxDepth: args.max_depth,
        maxFiles: args.max_files,
        maxFileBytes: args.max_file_bytes,
        maxTotalBytes: args.max_total_bytes
      });
      const text = `# Export Pro Context\n\nWrote ${result.path}.\nBytes: ${result.bytes}\nFiles included: ${result.filesIncluded.length}\nFiles skipped: ${result.filesSkipped.length}\nTruncated: ${result.truncated}\n\nPaste ${result.path} into a high-context planning model when MCP tools are unavailable, then save the returned plan with codexpro pro-apply.`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        bytes: result.bytes,
        files_included: result.filesIncluded,
        files_skipped: result.filesSkipped,
        truncated: result.truncated
      });
    }
  );

  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read. It selects the newest page by default, returns that page chronologically, and reads the file in blocks instead of loading the full JSONL. Memory use still scales with the largest individual JSONL record scanned.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            direction: z.enum(["head", "tail"]).optional().describe("Page direction. tail selects the newest page and is the default; head reads from the start. Messages inside each page are returned chronologically."),
            cursor: z.number().int().min(0).optional().describe("Opaque byte cursor returned as next_cursor or resume_cursor by a previous page. Reuse it only with the same session and direction. Omit for the newest tail page or the first head page."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum returned transcript content bytes. Default: 80000."),
            exclude_tool_outputs: z.boolean().optional().describe("Exclude function_call_output messages. Default: false."),
            max_tool_output_bytes: z.number().int().min(0).max(400000).optional().describe("Maximum bytes retained per tool output before it is truncated. Default: 20000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            direction: args.direction,
            cursor: args.cursor,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes,
            excludeToolOutputs: args.exclude_tool_outputs,
            maxToolOutputBytes: args.max_tool_output_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            direction: result.direction,
            cursor: result.cursor,
            resume_cursor: result.resume_cursor,
            next_cursor: result.next_cursor ?? null,
            has_more: result.has_more,
            source_size_bytes: result.source_size_bytes,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  registerCodexTool(
    config,
    server,
    "handoff_to_agent",
    {
      title: "Handoff To Agent",
      description:
        "Write .ai-bridge/current-plan.md for Codex, OpenCode, Pi, or another local implementation agent. This only creates handoff files; it does not execute local agent commands.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        agent: z.string().optional().describe("Target agent id, for example codex, opencode, pi, or custom. Default: custom."),
        agent_name: z.string().optional().describe("Human-readable agent name for custom agents."),
        model: z.string().optional().describe("Optional model identifier to include in the handoff plan."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for the local agent."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing agent handoff plan...",
        "openai/toolInvocation/invoked": "Agent handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: args.agent ?? "custom",
        agentName: args.agent_name,
        model: args.model,
        title: cleanOneLine(args.title, "Agent implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_agent"
      });

      const text = `# Handoff To Agent

Agent: ${result.agentName} (${result.agent})
${result.model ? `Model: ${result.model}\n` : ""}Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Execution log: ${result.executionLogPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Agent prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        model: result.model,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "handoff_to_codex",
    {
      title: "Handoff To Codex",
      description: "Compatibility wrapper for handoff_to_agent with agent=codex.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use the workspace selected for this MCP session."),
        title: z.string().optional().describe("Short task title."),
        plan: z.string().describe("Detailed implementation plan for Codex."),
        append: z.boolean().optional().describe("Append to existing current-plan.md instead of overwriting. Default: false.")
      },
      annotations: HANDOFF_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing Codex handoff plan...",
        "openai/toolInvocation/invoked": "Codex handoff plan written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await writeAgentHandoff(config, guard, workspace, {
        agent: "codex",
        title: cleanOneLine(args.title, "Codex implementation plan"),
        plan: String(args.plan ?? ""),
        append: parseBool(args.append, false),
        eventName: "handoff_to_codex"
      });
      const text = `# Handoff To Codex

Wrote ${result.planPath}.
Status path: ${result.statusPath}
Diff path: ${result.diffPath}
Diff stats: +${result.writeResult.diff.additions} -${result.writeResult.diff.deletions}

Codex prompt:

\`\`\`text
${result.prompt}
\`\`\`${diffBlock(result.writeResult.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agent: result.agent,
        agent_name: result.agentName,
        plan_path: result.planPath,
        status_path: result.statusPath,
        diff_path: result.diffPath,
        log_path: result.logPath,
        execution_log_path: result.executionLogPath,
        additions: result.writeResult.diff.additions,
        deletions: result.writeResult.diff.deletions,
        diff: result.writeResult.diff.diff
      });
    }
  );

  return server;
}
