import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type PathGuard, type Workspace, type WorkspaceManager, WORKSPACE_ID_PATTERN, isWorkspaceId } from "./guard.js";
import { assertBashSession, SAFE_ALLOWED_PREFIXES, SAFE_BLOCKED_PATTERNS } from "./bashOps.js";

/**
 * Frozen limits for RepoConnect M010 Disposable PTY Runner (A001 / P001).
 */
export const PTY_LIMITS = Object.freeze({
  minOverallTimeoutMs: 1_000,
  defaultOverallTimeoutMs: 30_000,
  hardMaxOverallTimeoutMs: 60_000,
  maxStepsCount: 16,
  defaultStepTimeoutMs: 10_000,
  maxStepTimeoutMs: 30_000,
  minStepTimeoutMs: 100,
  maxArgvCount: 64,
  maxArgvElementBytes: 1024,
  maxTotalArgvBytes: 8192,
  maxWaitForBytes: 512,
  maxSendBytes: 2048,
  maxTotalSendBytes: 8192,
  maxActivePtys: 2,
  hardOutputCeilingBytes: 1024 * 1024, // 1 MiB
  fixedCols: 80,
  fixedRows: 24
});

/**
 * Obvious persistent and open-ended terminal / session programs forbidden even in full mode (LAW-006).
 */
export const BLOCKED_SHELLS = new Set<string>([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "nu",
  "cmd",
  "powershell",
  "pwsh"
]);

export const BLOCKED_MULTIPLEXERS = new Set<string>([
  "tmux",
  "screen"
]);

export const BLOCKED_REMOTE_SESSIONS = new Set<string>([
  "ssh",
  "mosh",
  "telnet"
]);

export const BLOCKED_EDITORS_PAGERS = new Set<string>([
  "vi",
  "vim",
  "nvim",
  "emacs",
  "nano",
  "less",
  "more",
  "top",
  "htop"
]);

/** Single scripted interaction step shape. */
export interface PtyStepInput {
  wait_for: string;
  send?: string;
  submit?: boolean;
  timeout_ms?: number;
}

/** Public pty_run input envelope. */
export interface PtyRunInput {
  workspace_id: string;
  argv: string[];
  steps?: PtyStepInput[];
  cwd?: string;
  timeout_ms?: number;
  session_id?: string;
}

/** Validated and resolved pty_run request ready for admission / future spawn. */
export interface ValidatedPtyRunRequest {
  workspaceId: string;
  workspaceRoot: string;
  cwd: string;
  argv: string[];
  steps: PtyStepInput[];
  timeoutMs: number;
  sessionId?: string;
}

/**
 * Extract normalized executable basename from an executable path/command.
 * Strips directory prefixes and common Windows executable extensions.
 */
export function extractExecutableBasename(executable: string): string {
  const trimmed = executable.trim();
  const segments = trimmed.split(/[/\\]+/).filter(Boolean);
  const rawBase = segments.length > 0 ? segments[segments.length - 1] : trimmed;
  const stripped = rawBase.replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
  return stripped.toLowerCase();
}

/**
 * Check whether argv targets an obvious persistent program or open-ended REPL.
 * Even in CODEXPRO_BASH_MODE=full, persistent terminal surfaces are forbidden.
 */
export function assertNotPersistentProgram(argv: string[]): void {
  if (!argv || argv.length === 0) {
    throw new CodexProError("argv must contain at least 1 element.");
  }
  const executable = argv[0];
  const base = extractExecutableBasename(executable);

  if (BLOCKED_SHELLS.has(base)) {
    throw new CodexProError(`Persistent/session shell execution is forbidden in pty_run: '${executable}'.`);
  }
  if (BLOCKED_MULTIPLEXERS.has(base)) {
    throw new CodexProError(`Terminal multiplexer execution is forbidden in pty_run: '${executable}'.`);
  }
  if (BLOCKED_REMOTE_SESSIONS.has(base)) {
    throw new CodexProError(`Remote interactive session execution is forbidden in pty_run: '${executable}'.`);
  }
  if (BLOCKED_EDITORS_PAGERS.has(base)) {
    throw new CodexProError(`Open-ended terminal editor or pager execution is forbidden in pty_run: '${executable}'.`);
  }

  // Interactive REPL entry checks for generic runtimes
  if (base === "node" || base === "nodejs" || base === "bun" || base === "deno") {
    if (argv.length === 1) {
      throw new CodexProError(`Interactive REPL execution is forbidden in pty_run: '${executable}'. Provide a bounded script file or command.`);
    }
    const hasInteractiveFlag = argv.slice(1).some((arg) => arg === "-i" || arg === "--interactive");
    const hasEval = argv.slice(1).some((arg) => arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print");
    const hasPositionalScript = argv.slice(1).some((arg) => !arg.startsWith("-"));
    if (hasInteractiveFlag && !hasEval && !hasPositionalScript) {
      throw new CodexProError(`Interactive REPL flag is forbidden in pty_run: '${argv.join(" ")}'. Provide a bounded script file or command.`);
    }
    if (!hasEval && !hasPositionalScript) {
      throw new CodexProError(`Interactive REPL execution is forbidden in pty_run: '${argv.join(" ")}'. Provide a bounded script file or command.`);
    }
  }

  if (/^python(?:\d+(?:\.\d+)?)?$/i.test(base) || base === "py") {
    if (argv.length === 1) {
      throw new CodexProError(`Interactive REPL execution is forbidden in pty_run: '${executable}'. Provide a bounded script file, module, or command.`);
    }
    const hasInteractiveFlag = argv.slice(1).some((arg) => arg === "-i" || arg === "--interactive");
    if (hasInteractiveFlag) {
      throw new CodexProError(`Interactive REPL flag '-i' is forbidden in pty_run: '${argv.join(" ")}'.`);
    }
    const hasCommandOrModule = argv.slice(1).some((arg) => arg === "-c" || arg === "-m");
    const hasPositionalScript = argv.slice(1).some((arg) => !arg.startsWith("-"));
    if (!hasCommandOrModule && !hasPositionalScript) {
      throw new CodexProError(`Interactive REPL execution is forbidden in pty_run: '${argv.join(" ")}'. Provide a bounded script file, module, or command.`);
    }
  }

  if (base === "irb") {
    throw new CodexProError(`Interactive REPL execution is forbidden in pty_run: '${executable}'.`);
  }
}

/** Allowed package script name regex for npm/pnpm/yarn/bun run <script>. */
const ALLOWED_PACKAGE_SCRIPT_NAME_REGEX =
  /^(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*$/;

/** Pre-tokenized allowed command prefixes for safe mode matching. */
const TOKENIZED_ALLOWED_PREFIXES: string[][] = SAFE_ALLOWED_PREFIXES.map((prefix) =>
  prefix.trim().split(/\s+/)
);

/**
 * Check whether argv satisfies safe Bash authority (CODEXPRO_BASH_MODE=safe).
 */
export function assertSafeArgv(argv: string[]): void {
  // 1. Prefix allowlist match
  let matchedPrefix = false;

  for (const prefixTokens of TOKENIZED_ALLOWED_PREFIXES) {
    if (argv.length >= prefixTokens.length) {
      let match = true;
      for (let i = 0; i < prefixTokens.length; i++) {
        if (argv[i] !== prefixTokens[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        matchedPrefix = true;
        break;
      }
    }
  }

  if (!matchedPrefix) {
    // Check package manager run <script> pattern
    const pkgManagers = new Set(["npm", "pnpm", "yarn", "bun"]);
    if (argv.length >= 3 && pkgManagers.has(argv[0]) && argv[1] === "run") {
      const scriptName = argv[2];
      if (ALLOWED_PACKAGE_SCRIPT_NAME_REGEX.test(scriptName)) {
        matchedPrefix = true;
      }
    }
  }

  if (!matchedPrefix) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${argv.join(" ")}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }

  // 2. Adversarial argument safety checks against SAFE_BLOCKED_PATTERNS
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Shell metacharacters are forbidden in safe mode
    if (/[;&|<>`$]/.test(arg)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${argv.join(" ")}\n` +
          `Argument contains forbidden shell metacharacter: '${arg}'.`
      );
    }

    // Path safety: block absolute paths, home paths, and parent directory traversal
    if (arg.startsWith("/") || arg.startsWith("\\") || /^[A-Za-z]:[/\\]/.test(arg)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${argv.join(" ")}\n` +
          `Argument contains forbidden absolute path: '${arg}'. Arguments must be workspace-relative.`
      );
    }
    if (arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${argv.join(" ")}\n` +
          `Argument contains forbidden home path: '${arg}'. Arguments must be workspace-relative.`
      );
    }
    if (/(^|[/\\])\.\.([/\\]|$)/.test(arg)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${argv.join(" ")}\n` +
          `Argument contains forbidden parent directory traversal: '${arg}'.`
      );
    }

    // Blocked flags
    const lower = arg.toLowerCase();
    if (
      lower === "--no-index" ||
      lower === "--fix" ||
      lower.startsWith("--fix=") ||
      lower === "-exec" ||
      lower === "-execdir" ||
      lower === "-delete" ||
      lower === "-ok" ||
      lower === "-okdir" ||
      lower === "-fprint" ||
      lower === "-fprintf" ||
      lower === "-fls" ||
      lower === "--output" ||
      lower.startsWith("--output=")
    ) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${argv.join(" ")}\n` +
          `Argument '${arg}' is blocked by safe policy.`
      );
    }

    // Sensitive files and blocked patterns
    for (const pattern of SAFE_BLOCKED_PATTERNS) {
      if (pattern.test(arg) || pattern.test(` ${arg} `)) {
        throw new CodexProError(
          `Command is blocked in CODEXPRO_BASH_MODE=safe: ${argv.join(" ")}\n` +
            `Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos.`
        );
      }
    }
  }

  // Double-layer check against the reconstructed string
  const reconstructed = argv.join(" ");
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(reconstructed)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${reconstructed}\n` +
          `Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos.`
      );
    }
  }
}

/**
 * Validate direct argv under the active Bash authority (LAW-005).
 */
export function assertPtyBashAuthority(config: CodexProConfig, argv: string[]): void {
  if (config.bashMode === "off") {
    throw new CodexProError("pty_run is disabled because bash is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "safe") {
    assertSafeArgv(argv);
    return;
  }
  if (config.bashMode === "full") {
    assertNotPersistentProgram(argv);
    return;
  }
  throw new CodexProError(`Unknown bashMode: '${config.bashMode}'.`);
}

/**
 * Validate direct argv array bounds and character exclusions.
 */
export function validatePtyArgv(argv: unknown, bashMode: CodexProConfig["bashMode"]): string[] {
  if (!Array.isArray(argv)) {
    throw new CodexProError("argv must be an array of strings.");
  }
  if (argv.length === 0) {
    throw new CodexProError("argv must contain at least 1 element (the executable).");
  }
  if (argv.length > PTY_LIMITS.maxArgvCount) {
    throw new CodexProError(`argv must not exceed ${PTY_LIMITS.maxArgvCount} elements (got ${argv.length}).`);
  }

  let totalBytes = 0;
  const validated: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") {
      throw new CodexProError(`argv[${i}] must be a string.`);
    }
    const byteLength = Buffer.byteLength(arg, "utf8");
    if (byteLength > PTY_LIMITS.maxArgvElementBytes) {
      throw new CodexProError(`argv[${i}] exceeds maximum length of ${PTY_LIMITS.maxArgvElementBytes} bytes (got ${byteLength} bytes).`);
    }
    if (arg.includes("\0")) {
      throw new CodexProError(`argv[${i}] contains forbidden NUL character.`);
    }
    if (/[\r\n]/.test(arg)) {
      throw new CodexProError(`argv[${i}] contains forbidden CR or LF newline characters.`);
    }
    totalBytes += byteLength;
    validated.push(arg);
  }

  if (totalBytes > PTY_LIMITS.maxTotalArgvBytes) {
    throw new CodexProError(`Total argv payload exceeds maximum of ${PTY_LIMITS.maxTotalArgvBytes} bytes (got ${totalBytes} bytes).`);
  }

  if (validated[0].trim().length === 0) {
    throw new CodexProError("Executable argv[0] must not be empty or whitespace.");
  }

  return validated;
}

const ALLOWED_STEP_KEYS = new Set(["wait_for", "send", "submit", "timeout_ms"]);

/**
 * Validate scripted interaction steps (LAW-007).
 */
export function validatePtySteps(steps: unknown): PtyStepInput[] | undefined {
  if (steps === undefined || steps === null) return undefined;
  if (!Array.isArray(steps)) {
    throw new CodexProError("steps must be an array of step objects.");
  }
  if (steps.length > PTY_LIMITS.maxStepsCount) {
    throw new CodexProError(`steps must not exceed ${PTY_LIMITS.maxStepsCount} steps (got ${steps.length}).`);
  }

  let totalSendBytes = 0;
  const validatedSteps: PtyStepInput[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      throw new CodexProError(`Step at index ${i} must be an object.`);
    }

    // Strict unknown field rejection within each step
    for (const key of Object.keys(step)) {
      if (!ALLOWED_STEP_KEYS.has(key)) {
        throw new CodexProError(`Step at index ${i} contains forbidden unknown field: '${key}'.`);
      }
    }

    const typedStep = step as Record<string, unknown>;

    // wait_for is mandatory
    if (typeof typedStep.wait_for !== "string" || typedStep.wait_for.length === 0) {
      throw new CodexProError(`Step at index ${i} must have a non-empty 'wait_for' string.`);
    }
    const waitForBytes = Buffer.byteLength(typedStep.wait_for, "utf8");
    if (waitForBytes > PTY_LIMITS.maxWaitForBytes) {
      throw new CodexProError(`Step at index ${i} 'wait_for' exceeds maximum length of ${PTY_LIMITS.maxWaitForBytes} bytes (got ${waitForBytes} bytes).`);
    }
    // Reject control characters, newlines, ESC, C0, DEL
    if (/[\x00-\x1f\x7f]/.test(typedStep.wait_for)) {
      throw new CodexProError(`Step at index ${i} 'wait_for' contains forbidden control characters, newlines, or escape sequences.`);
    }

    // send is optional
    let validatedSend: string | undefined = undefined;
    if (typedStep.send !== undefined && typedStep.send !== null) {
      if (typeof typedStep.send !== "string") {
        throw new CodexProError(`Step at index ${i} 'send' must be a string.`);
      }
      const sendBytes = Buffer.byteLength(typedStep.send, "utf8");
      if (sendBytes > PTY_LIMITS.maxSendBytes) {
        throw new CodexProError(`Step at index ${i} 'send' exceeds maximum length of ${PTY_LIMITS.maxSendBytes} bytes (got ${sendBytes} bytes).`);
      }
      if (/[\x00-\x1f\x7f]/.test(typedStep.send)) {
        throw new CodexProError(`Step at index ${i} 'send' contains forbidden control characters, newlines, or escape sequences.`);
      }
      totalSendBytes += sendBytes;
      if (totalSendBytes > PTY_LIMITS.maxTotalSendBytes) {
        throw new CodexProError(`Total caller send payload across all steps exceeds maximum of ${PTY_LIMITS.maxTotalSendBytes} bytes (got ${totalSendBytes} bytes).`);
      }
      validatedSend = typedStep.send;
    }

    // submit is optional boolean
    let validatedSubmit: boolean | undefined = undefined;
    if (typedStep.submit !== undefined && typedStep.submit !== null) {
      if (typeof typedStep.submit !== "boolean") {
        throw new CodexProError(`Step at index ${i} 'submit' must be a boolean.`);
      }
      validatedSubmit = typedStep.submit;
    }

    // step timeout_ms is optional integer
    let validatedStepTimeout: number | undefined = undefined;
    if (typedStep.timeout_ms !== undefined && typedStep.timeout_ms !== null) {
      if (
        typeof typedStep.timeout_ms !== "number" ||
        !Number.isInteger(typedStep.timeout_ms) ||
        typedStep.timeout_ms < PTY_LIMITS.minStepTimeoutMs ||
        typedStep.timeout_ms > PTY_LIMITS.maxStepTimeoutMs
      ) {
        throw new CodexProError(
          `Step at index ${i} 'timeout_ms' must be an integer between ${PTY_LIMITS.minStepTimeoutMs} ms and ${PTY_LIMITS.maxStepTimeoutMs} ms.`
        );
      }
      validatedStepTimeout = typedStep.timeout_ms;
    }

    validatedSteps.push({
      wait_for: typedStep.wait_for,
      send: validatedSend,
      submit: validatedSubmit,
      timeout_ms: validatedStepTimeout ?? PTY_LIMITS.defaultStepTimeoutMs
    });
  }

  return validatedSteps;
}

/**
 * Resolve overall timeout (LAW-012).
 * Schema-rejects out-of-range or non-integer values; caps at config.maxBashTimeoutMs.
 */
export function resolvePtyTimeout(timeoutMs: unknown, config: CodexProConfig): number {
  const effectiveMax = Math.min(PTY_LIMITS.hardMaxOverallTimeoutMs, config.maxBashTimeoutMs);
  if (timeoutMs === undefined || timeoutMs === null) {
    return Math.min(PTY_LIMITS.defaultOverallTimeoutMs, effectiveMax);
  }
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs)) {
    throw new CodexProError("timeout_ms must be an integer.");
  }
  if (timeoutMs < PTY_LIMITS.minOverallTimeoutMs || timeoutMs > effectiveMax) {
    throw new CodexProError(
      `timeout_ms must be between ${PTY_LIMITS.minOverallTimeoutMs} ms and ${effectiveMax} ms (got ${timeoutMs}).`
    );
  }
  return timeoutMs;
}

const ALLOWED_PTY_RUN_TOP_LEVEL_KEYS = new Set([
  "workspace_id",
  "argv",
  "steps",
  "cwd",
  "timeout_ms",
  "session_id"
]);

// --- Zod schemas for public / schema verification ---

export const PTY_STEP_ARGUMENTS_SCHEMA = z.object({
  wait_for: z.string()
    .min(1, "wait_for is required and must not be empty.")
    .max(512, "wait_for must not exceed 512 characters.")
    .refine(
      (v) => Buffer.byteLength(v, "utf8") <= PTY_LIMITS.maxWaitForBytes,
      `wait_for must not exceed ${PTY_LIMITS.maxWaitForBytes} UTF-8 bytes.`
    )
    .refine(
      (v) => !/[\x00-\x1f\x7f]/.test(v),
      "wait_for must contain only printable textual input; control characters and escape sequences are forbidden."
    )
    .describe("Literal prompt fragment to wait for before proceeding. Matching is exact substring only."),
  send: z.string()
    .max(2048, "send must not exceed 2048 characters.")
    .refine(
      (v) => Buffer.byteLength(v, "utf8") <= PTY_LIMITS.maxSendBytes,
      `send must not exceed ${PTY_LIMITS.maxSendBytes} UTF-8 bytes.`
    )
    .refine(
      (v) => !/[\x00-\x1f\x7f]/.test(v),
      "send must contain only printable textual input; control characters and escape sequences are forbidden."
    )
    .optional()
    .describe("Optional bounded printable text to send to the PTY stdin once wait_for matches."),
  submit: z.boolean()
    .optional()
    .describe("If true, appends one server-owned Enter event after sending optional text. Default: false."),
  timeout_ms: z.number()
    .int("step timeout_ms must be an integer.")
    .min(PTY_LIMITS.minStepTimeoutMs, `step timeout_ms must be at least ${PTY_LIMITS.minStepTimeoutMs} ms.`)
    .max(PTY_LIMITS.maxStepTimeoutMs, `step timeout_ms must not exceed ${PTY_LIMITS.maxStepTimeoutMs} ms.`)
    .optional()
    .describe(`Per-step timeout in milliseconds. Default: ${PTY_LIMITS.defaultStepTimeoutMs}; max: ${PTY_LIMITS.maxStepTimeoutMs}.`)
}).strict();

export const PTY_RUN_ARGUMENTS_SCHEMA = z.object({
  workspace_id: z.string()
    .regex(/^ws_[0-9a-f]{24}$/u, "workspace_id must match the deterministic workspace ID grammar.")
    .describe("Mandatory explicit workspace id from open_workspace. Ambient or session-selected workspace fallback is forbidden."),
  argv: z.array(
    z.string()
      .refine((arg) => Buffer.byteLength(arg, "utf8") <= PTY_LIMITS.maxArgvElementBytes, `argv element must not exceed ${PTY_LIMITS.maxArgvElementBytes} UTF-8 bytes.`)
      .refine((arg) => !/[\x00\r\n]/.test(arg), "argv elements must not contain NUL or newline characters.")
  )
    .min(1, "argv must contain at least 1 element (the executable).")
    .max(PTY_LIMITS.maxArgvCount, `argv must not exceed ${PTY_LIMITS.maxArgvCount} elements.`)
    .describe("Direct executable plus arguments array. Never a shell command string."),
  steps: z.array(PTY_STEP_ARGUMENTS_SCHEMA)
    .max(PTY_LIMITS.maxStepsCount, `steps must not exceed ${PTY_LIMITS.maxStepsCount} steps.`)
    .optional()
    .describe("Optional fixed ordered script of prompt/response interactions declared before spawn."),
  cwd: z.string()
    .max(1024)
    .optional()
    .describe("Working directory relative to workspace root. Must be workspace-relative."),
  timeout_ms: z.number()
    .int("timeout_ms must be an integer.")
    .min(PTY_LIMITS.minOverallTimeoutMs, `timeout_ms must be at least ${PTY_LIMITS.minOverallTimeoutMs} ms.`)
    .max(PTY_LIMITS.hardMaxOverallTimeoutMs, `timeout_ms must not exceed ${PTY_LIMITS.hardMaxOverallTimeoutMs} ms.`)
    .optional()
    .describe(`Overall PTY execution timeout in milliseconds. Default: ${PTY_LIMITS.defaultOverallTimeoutMs}; hard max: ${PTY_LIMITS.hardMaxOverallTimeoutMs}.`),
  session_id: z.string()
    .max(64)
    .optional()
    .describe("Bash session id required when CODEXPRO_REQUIRE_BASH_SESSION=1 is configured.")
}).strict();

export const PTY_RUN_PUBLIC_SCHEMA = z.object(PTY_RUN_ARGUMENTS_SCHEMA.shape).strict();

/**
 * Validate all pty_run input parameters against schemas, limits, Bash authority,
 * session guard, and PathGuard cwd rules.
 * Does NOT spawn or allocate any PTY handles (TASK-002 scope).
 */
export async function validatePtyRunInput(
  rawInput: unknown,
  config: CodexProConfig,
  options: {
    guard?: PathGuard;
    workspaces?: WorkspaceManager;
  } = {}
): Promise<ValidatedPtyRunRequest> {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    throw new CodexProError("pty_run input must be a valid JSON object.");
  }

  // Strict unknown key rejection (LAW-008, LAW-009, AP-005)
  for (const key of Object.keys(rawInput)) {
    if (!ALLOWED_PTY_RUN_TOP_LEVEL_KEYS.has(key)) {
      throw new CodexProError(
        `Unknown field '${key}' is rejected. pty_run accepts only workspace_id, argv, steps, cwd, timeout_ms, session_id.`
      );
    }
  }

  // Zod schema parse
  const parseResult = PTY_RUN_ARGUMENTS_SCHEMA.safeParse(rawInput);
  if (!parseResult.success) {
    const issue = parseResult.error.issues[0];
    const pathStr = issue.path.join(".");
    throw new CodexProError(`Schema validation failed at '${pathStr}': ${issue.message}`);
  }

  const input = parseResult.data;

  // 1. Mandatory workspace_id (LAW-003)
  if (!input.workspace_id) {
    throw new CodexProError("workspace_id is required for pty_run. Ambient or session-selected workspace fallback is forbidden.");
  }
  if (!isWorkspaceId(input.workspace_id)) {
    throw new CodexProError(`Invalid workspace_id: '${input.workspace_id}'. Must match deterministic format 'ws_<24 hex chars>'.`);
  }

  let resolvedWorkspace: Workspace;
  if (options.workspaces) {
    // Explicit workspace_id only - no ambient fallback
    resolvedWorkspace = options.workspaces.getWorkspace(input.workspace_id);
  } else {
    // Structural validation without active manager
    resolvedWorkspace = {
      id: input.workspace_id,
      root: config.defaultRoot,
      openedAt: new Date().toISOString()
    };
  }

  // 2. Guarded cwd (LAW-003)
  let resolvedCwdAbs: string;
  if (options.guard) {
    const resolvedCwd = options.guard.resolve(resolvedWorkspace, input.cwd ?? ".");
    resolvedCwdAbs = resolvedCwd.absPath;
  } else {
    resolvedCwdAbs = input.cwd ?? ".";
  }

  // 3. Bash session guard (LAW-005)
  const sessionId = assertBashSession(config, input.session_id);

  // 4. Direct argv validation and Bash authority (LAW-004, LAW-005, LAW-006)
  const validatedArgv = validatePtyArgv(input.argv, config.bashMode);
  assertPtyBashAuthority(config, validatedArgv);

  // 5. Scripted steps validation (LAW-007)
  const validatedSteps = validatePtySteps(input.steps) ?? [];

  // 6. Overall timeout resolution (LAW-012)
  const timeoutMs = resolvePtyTimeout(input.timeout_ms, config);

  return {
    workspaceId: resolvedWorkspace.id,
    workspaceRoot: resolvedWorkspace.root,
    cwd: resolvedCwdAbs,
    argv: validatedArgv,
    steps: validatedSteps,
    timeoutMs,
    sessionId
  };
}
