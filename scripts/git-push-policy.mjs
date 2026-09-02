import { spawnSync } from "node:child_process";

const MAX_POLICY_RULES = 128;
const MAX_BRANCHES_PER_RULE = 128;
const MAX_POLICY_VALUE_BYTES = 256 * 1024;
const MAX_ENDPOINT_BYTES = 4_096;
const MAX_REMOTE_BYTES = 256;
const MAX_BRANCH_BYTES = 256;
const DEFAULT_GIT_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh"]);
const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/u;
const HELPER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*::/u;
const GLOB_TOKEN = /[*?\[\]]/u;

export function defaultGitPushPolicy() {
  return { enabled: false, rules: [] };
}

function invalidPolicy(message) {
  throw new Error(`Invalid configured Git push policy: ${message}`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, field, maxBytes) {
  if (typeof value !== "string") invalidPolicy(`${field} must be a string.`);
  if (!value || value.trim() !== value || Buffer.byteLength(value, "utf8") > maxBytes || CONTROL_OR_WHITESPACE.test(value)) {
    invalidPolicy(`${field} must be a bounded, whitespace-free value.`);
  }
  return value;
}

function remoteName(value) {
  const remote = boundedString(value, "remote", MAX_REMOTE_BYTES);
  if (remote.startsWith("-") || GLOB_TOKEN.test(remote) || remote.includes("::")) {
    invalidPolicy("remote must be an exact non-helper name.");
  }
  return remote;
}

function branchName(value) {
  const branch = boundedString(value, "branch", MAX_BRANCH_BYTES);
  const components = branch.split("/");
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.includes("~") ||
    branch.includes("^") ||
    branch.includes(":") ||
    branch.includes("\\") ||
    branch === "@" ||
    branch === "." ||
    branch === ".." ||
    GLOB_TOKEN.test(branch) ||
    components.some((component) => component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"))
  ) {
    invalidPolicy("branch must be one exact branch name; globs and invalid ref forms are not allowed.");
  }
  return branch;
}

function endpointFailure(raw, reason) {
  const diagnostic = typeof raw === "string" && (
    reason === "credential-bearing-endpoint" ||
    (/^(?:https?|ssh|git|git\+ssh):\/\//iu.test(raw) &&
      (raw.includes("@") || /[?&](?:token|password|passwd|secret|key)=/iu.test(raw)))
  ) ? "<redacted>" : "<invalid>";
  return { ok: false, reason, diagnostic };
}

function parseEndpoint(value) {
  if (typeof value !== "string") return endpointFailure(value, "invalid-endpoint");
  const raw = value;
  if (
    !raw ||
    raw.trim() !== raw ||
    Buffer.byteLength(raw, "utf8") > MAX_ENDPOINT_BYTES ||
    CONTROL_OR_WHITESPACE.test(raw)
  ) {
    return endpointFailure(raw, "invalid-endpoint");
  }
  if (HELPER_SCHEME.test(raw)) return endpointFailure(raw, "disallowed-remote-helper");
  if (/^file:/iu.test(raw)) return endpointFailure(raw, "disallowed-file-endpoint");

  const schemeMatch = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):/u);
  if (schemeMatch && raw.slice(schemeMatch[0].length, schemeMatch[0].length + 2) === "//") {
    const scheme = schemeMatch[1].toLowerCase();
    if (!DEFAULT_GIT_SCHEMES.has(scheme)) return endpointFailure(raw, "disallowed-endpoint-scheme");
    let url;
    try {
      url = new URL(raw);
    } catch {
      return endpointFailure(raw, "invalid-endpoint");
    }
    if (url.protocol.slice(0, -1).toLowerCase() !== scheme || !url.hostname || !url.pathname || url.pathname === "/") {
      return endpointFailure(raw, "invalid-endpoint");
    }
    if (url.search || url.hash) return endpointFailure(raw, "credential-bearing-endpoint");
    if (scheme === "http" || scheme === "https") {
      if (url.username || url.password) return endpointFailure(raw, "credential-bearing-endpoint");
    } else if (url.password) {
      return endpointFailure(raw, "credential-bearing-endpoint");
    }
    const user = url.username ? `${url.username}@` : "";
    const host = url.host.toLowerCase();
    return {
      ok: true,
      identity: `${scheme}://${user}${host}${url.pathname}`,
      style: scheme
    };
  }

  if (schemeMatch) return endpointFailure(raw, "disallowed-local-or-helper-endpoint");

  // Git's scp-like transport is intentionally kept distinct from URL forms.
  // In particular, host:path and host:/path can have different SSH path
  // semantics, so normalizing either into an URL would conflate targets.
  const scp = raw.match(/^(?:([^@/:\\\s]+)@)?([^:/\\\s]+):(.+)$/u);
  if (scp && scp[3]) {
    const user = scp[1] ? `${scp[1]}@` : "";
    const host = scp[2].toLowerCase();
    return { ok: true, identity: `scp://${user}${host}:${scp[3]}`, style: "scp" };
  }

  return endpointFailure(raw, "disallowed-local-endpoint");
}

export function inspectGitPushEndpoint(value) {
  return parseEndpoint(value);
}

function canonicalEndpoint(value) {
  const parsed = parseEndpoint(value);
  if (!parsed.ok) invalidPolicy(`endpoint is ${parsed.reason}.`);
  return parsed.identity;
}

function normalizePolicyObject(value) {
  if (!isRecord(value)) invalidPolicy("policy must be an object.");
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== "boolean") invalidPolicy("enabled must be boolean.");
  const rawRules = value.rules === undefined ? [] : value.rules;
  if (!Array.isArray(rawRules)) invalidPolicy("rules must be an array.");
  if (rawRules.length > MAX_POLICY_RULES) invalidPolicy(`rules may contain at most ${MAX_POLICY_RULES} entries.`);

  const rules = [];
  const seen = new Set();
  for (const rawRule of rawRules) {
    if (!isRecord(rawRule)) invalidPolicy("each rule must be an object.");
    const remote = remoteName(rawRule.remote);
    const endpoint = canonicalEndpoint(rawRule.endpoint);
    if (!Array.isArray(rawRule.branches) || rawRule.branches.length === 0) {
      invalidPolicy("each rule must contain one or more exact branches.");
    }
    if (rawRule.branches.length > MAX_BRANCHES_PER_RULE) {
      invalidPolicy(`each rule may contain at most ${MAX_BRANCHES_PER_RULE} branches.`);
    }
    const branches = [];
    for (const rawBranch of rawRule.branches) {
      const branch = branchName(rawBranch);
      if (branches.includes(branch)) invalidPolicy("duplicate exact branch in one rule.");
      const key = `${remote}\u0000${branch}`;
      if (seen.has(key)) invalidPolicy("duplicate remote and branch rule is ambiguous.");
      seen.add(key);
      branches.push(branch);
    }
    rules.push({ remote, endpoint, branches });
  }

  if (enabled && rules.length === 0) invalidPolicy("an enabled policy requires at least one exact rule.");
  return { enabled, rules };
}

export function normalizeGitPushPolicy(value) {
  if (value === undefined || value === null || value === "") return defaultGitPushPolicy();
  if (typeof value === "string") {
    try {
      if (Buffer.byteLength(value, "utf8") > MAX_POLICY_VALUE_BYTES) invalidPolicy("JSON value is too large.");
      return normalizePolicyObject(JSON.parse(value));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Invalid configured Git push policy:")) throw error;
      invalidPolicy("JSON value could not be parsed.");
    }
  }
  return normalizePolicyObject(value);
}

export function parseGitPushPolicy(value) {
  if (value === undefined || value === null || value === "") return defaultGitPushPolicy();
  if (typeof value === "string" && ["off", "disabled", "false"].includes(value.trim().toLowerCase())) {
    return defaultGitPushPolicy();
  }
  return normalizeGitPushPolicy(value);
}

export function serializeGitPushPolicy(value) {
  return JSON.stringify(normalizeGitPushPolicy(value));
}

function sanitizedEndpoint(value) {
  if (typeof value !== "string") return "<invalid>";
  const parsed = parseEndpoint(value);
  if (parsed.ok) return parsed.identity;
  if (
    /^(?:https?|ssh|git|git\+ssh):\/\//iu.test(value) &&
    (value.includes("@") || /[?&](?:token|password|passwd|secret|key)=/iu.test(value))
  ) {
    return "<redacted>";
  }
  return parsed.reason === "credential-bearing-endpoint" ? "<redacted>" : "<invalid>";
}

function sanitizedRemote(value) {
  if (typeof value !== "string" || !value || CONTROL_OR_WHITESPACE.test(value)) return "<invalid>";
  return value.slice(0, MAX_REMOTE_BYTES);
}

function sanitizedBranches(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_BRANCHES_PER_RULE).map((branch) =>
    typeof branch === "string" && branch && !CONTROL_OR_WHITESPACE.test(branch) ? branch.slice(0, MAX_BRANCH_BYTES) : "<invalid>"
  );
}

export function sanitizeGitPushPolicy(value) {
  if (!isRecord(value)) return defaultGitPushPolicy();
  const enabled = value.enabled === true;
  const rawRules = Array.isArray(value.rules) ? value.rules.slice(0, MAX_POLICY_RULES) : [];
  return {
    enabled,
    rules: rawRules.map((rule) => ({
      remote: sanitizedRemote(rule?.remote),
      endpoint: sanitizedEndpoint(rule?.endpoint),
      branches: sanitizedBranches(rule?.branches)
    }))
  };
}

export function summarizeGitPushPolicy(value) {
  const safe = sanitizeGitPushPolicy(value);
  return {
    enabled: safe.enabled,
    rule_count: safe.rules.length,
    branch_count: safe.rules.reduce((total, rule) => total + rule.branches.length, 0)
  };
}

function safeRemoteForGit(value) {
  try {
    return remoteName(value);
  } catch {
    return null;
  }
}

function sealedGitEnvironment() {
  // Match the existing Git mutation runner's trust boundary: preserve the
  // ordinary process environment (including auth sockets), but never inherit
  // Git's caller-controlled routing/config/object/ref/replacement/prompt or
  // trace variables. Leaving the config-path variables unset preserves the
  // trusted system/global/local Git config hierarchy and its url rewrite
  // rules. Fixed values prevent this read-only query from prompting, paging,
  // lazily fetching, replacing objects, or taking incidental locks.
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(key) && value !== undefined) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    NO_COLOR: "1",
    LC_ALL: "C",
    LANG: "C"
  });
  return environment;
}

export function resolveEffectivePushEndpoint(repoRoot, remote, options = {}) {
  const safeRemote = safeRemoteForGit(remote);
  if (!safeRemote || typeof repoRoot !== "string" || !repoRoot) {
    return { ok: false, reason: "invalid-remote-or-repository" };
  }
  const gitBin = typeof options.gitBin === "string" && options.gitBin ? options.gitBin : "git";
  const timeout = Number.isInteger(options.timeoutMs) ? Math.max(1_000, Math.min(options.timeoutMs, 300_000)) : 60_000;
  let result;
  try {
    result = spawnSync(gitBin, [
      "--no-replace-objects",
      "--no-pager",
      "-c",
      "color.ui=false",
      "-C",
      repoRoot,
      "remote",
      "get-url",
      "--push",
      "--all",
      safeRemote
    ], {
      encoding: "utf8",
      env: sealedGitEnvironment(),
      timeout,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      shell: false
    });
  } catch {
    return { ok: false, reason: "effective-endpoint-unavailable" };
  }
  if (result.error || result.status !== 0) return { ok: false, reason: "effective-endpoint-unavailable" };
  const endpoints = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (endpoints.length === 0) return { ok: false, reason: "zero-effective-push-endpoints" };
  if (endpoints.length !== 1) {
    return {
      ok: false,
      reason: "ambiguous-multiple-effective-push-endpoints",
      endpoint_count: endpoints.length,
      endpoints: endpoints.map(sanitizedEndpoint)
    };
  }
  const parsed = parseEndpoint(endpoints[0]);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, endpoint: sanitizedEndpoint(endpoints[0]) };
  }
  return { ok: true, endpoint: parsed.identity, identity: parsed.identity, style: parsed.style };
}

export function evaluateGitPushPolicy(repoRoot, policy, remote, branch, options = {}) {
  let normalized;
  try {
    normalized = normalizeGitPushPolicy(policy);
  } catch {
    return { allowed: false, reason: "invalid-policy" };
  }
  if (!normalized.enabled) return { allowed: false, reason: "policy-disabled" };
  let safeRemote;
  let safeBranch;
  try {
    safeRemote = remoteName(remote);
    safeBranch = branchName(branch);
  } catch {
    return { allowed: false, reason: "invalid-remote-or-branch" };
  }
  const matches = normalized.rules.filter((rule) => rule.remote === safeRemote && rule.branches.includes(safeBranch));
  if (matches.length !== 1) return { allowed: false, reason: matches.length === 0 ? "remote-or-branch-not-allowlisted" : "ambiguous-policy-rule" };
  const effective = resolveEffectivePushEndpoint(repoRoot, safeRemote, options);
  if (!effective.ok) return { allowed: false, reason: effective.reason, endpoint: effective.endpoint };
  if (effective.identity !== matches[0].endpoint) {
    return { allowed: false, reason: "effective-endpoint-not-allowlisted", endpoint: effective.identity };
  }
  return {
    allowed: true,
    remote: safeRemote,
    branch: safeBranch,
    endpoint: effective.identity,
    rule: matches[0]
  };
}

export const resolveGitPushPolicy = evaluateGitPushPolicy;
export const isGitPushPolicyAllowed = evaluateGitPushPolicy;
