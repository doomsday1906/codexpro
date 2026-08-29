import type { CodexProConfig } from "./config.js";
import { GitExecutionError, runGitReadOnly } from "./gitOps.js";
import { CodexProError, type Workspace } from "./guard.js";

export type GitObjectFormat = "sha1" | "sha256";

export interface GitReviewRef {
  readonly input: string;
  readonly objectFormat: GitObjectFormat;
  readonly fullSha: string;
  readonly shortSha: string;
}

export type GitRefResolutionFailure =
  | "invalid-input"
  | "unsupported-object-format"
  | "malformed-object-format"
  | "unresolvable"
  | "malformed-output"
  | "execution";

const MAX_RAW_REF_BYTES = 512;
const SHORT_SHA_LENGTH = 12;

const FAILURE_MESSAGES: Record<GitRefResolutionFailure, string> = {
  "invalid-input": "Git ref input is invalid.",
  "unsupported-object-format": "Repository object format is unsupported.",
  "malformed-object-format": "Git returned malformed object-format output.",
  unresolvable: "Git ref could not be resolved to a commit.",
  "malformed-output": "Git returned malformed commit-resolution output.",
  execution: "Git ref resolution failed during Git execution."
};

/**
 * Bounded public-facing failure for the immutable ref primitive. Git's raw
 * streams and the caller's ref are intentionally not retained on this error.
 */
export class GitRefResolutionError extends CodexProError {
  constructor(readonly reason: GitRefResolutionFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "GitRefResolutionError";
  }
}

function invalidRawRef(rawRef: unknown): boolean {
  if (typeof rawRef !== "string" || rawRef.length === 0) return true;
  if (Buffer.byteLength(rawRef, "utf8") > MAX_RAW_REF_BYTES) return true;
  if (rawRef.trim() !== rawRef) return true;
  if (/[\u0000-\u001f\u007f]/u.test(rawRef)) return true;
  return rawRef.startsWith("-");
}

function objectFormatFromOutput(stdout: string): GitObjectFormat | undefined {
  if (stdout === "sha1" || stdout === "sha1\n" || stdout === "sha1\r\n") return "sha1";
  if (stdout === "sha256" || stdout === "sha256\n" || stdout === "sha256\r\n") return "sha256";
  return undefined;
}

function isUnsupportedObjectFormatOutput(stdout: string): boolean {
  const record = oneOutputRecord(stdout);
  return record !== undefined && /^sha[0-9]+$/u.test(record);
}

function oneOutputRecord(stdout: string): string | undefined {
  if (stdout.endsWith("\n")) {
    const withoutLineFeed = stdout.slice(0, -1);
    return withoutLineFeed.endsWith("\r") ? withoutLineFeed.slice(0, -1) : withoutLineFeed;
  }
  return stdout.includes("\r") ? undefined : stdout;
}

function resolvedShaFromOutput(stdout: string, objectFormat: GitObjectFormat): string | undefined {
  const length = objectFormat === "sha1" ? 40 : 64;
  const record = oneOutputRecord(stdout);
  if (record === undefined || record.length !== length || !/^[0-9a-f]+$/iu.test(record)) return undefined;
  return record.toLowerCase();
}

/**
 * Resolve one caller commit-ish to immutable local identity. Object-format
 * discovery is separate from the one revision resolution; no Git call is
 * made for the locally derived short SHA.
 */
export async function resolveGitRef(
  config: Pick<CodexProConfig, "maxGitTimeoutMs" | "maxOutputBytes">,
  workspace: Workspace,
  rawRef: string
): Promise<GitReviewRef> {
  if (invalidRawRef(rawRef)) throw new GitRefResolutionError("invalid-input");

  let objectFormatOutput: Awaited<ReturnType<typeof runGitReadOnly>>;
  try {
    objectFormatOutput = await runGitReadOnly(config, workspace, ["rev-parse", "--show-object-format=storage"]);
  } catch {
    throw new GitRefResolutionError("execution");
  }

  const objectFormat = objectFormatFromOutput(objectFormatOutput.stdout);
  if (!objectFormat) {
    if (isUnsupportedObjectFormatOutput(objectFormatOutput.stdout)) {
      throw new GitRefResolutionError("unsupported-object-format");
    }
    throw new GitRefResolutionError("malformed-object-format");
  }

  let resolutionOutput: Awaited<ReturnType<typeof runGitReadOnly>>;
  try {
    resolutionOutput = await runGitReadOnly(config, workspace, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${rawRef}^{commit}`
    ]);
  } catch (error) {
    if (error instanceof GitExecutionError && error.failure === "exit") {
      throw new GitRefResolutionError("unresolvable");
    }
    throw new GitRefResolutionError("execution");
  }

  const fullSha = resolvedShaFromOutput(resolutionOutput.stdout, objectFormat);
  if (!fullSha) throw new GitRefResolutionError("malformed-output");

  return {
    input: rawRef,
    objectFormat,
    fullSha,
    shortSha: fullSha.slice(0, SHORT_SHA_LENGTH)
  };
}
