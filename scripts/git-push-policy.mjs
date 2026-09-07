import { spawnSync } from "node:child_process";

const MAX_POLICY_RULES = 128;
const MAX_BRANCHES_PER_RULE = 128;
const MAX_BRANCH_PREFIXES_PER_RULE = 128;
const MAX_POLICY_VALUE_BYTES = 256 * 1024;
const MAX_ENDPOINT_BYTES = 4_096;
const MAX_REMOTE_BYTES = 256;
const MAX_BRANCH_BYTES = 256;
const DEFAULT_GIT_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh"]);
const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/u;
const HELPER_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*::/u;
const GLOB_TOKEN = /[*?\[\]]/u;
// These characters are rejected for namespace prefixes even when Git would
// accept them in a ref name. They are commonly used to spell regexes or
// refspec modifiers and have no place in a literal policy prefix.
const PREFIX_PATTERN_TOKEN = /[+$^()|{}]/u;
const PROTECTED_BRANCH_PREFIXES = new Set(["main/", "master/", "develop/", "trunk/", "head/", "refs/"]);
const RETIREMENT_RULE_KEYS = new Set(["branches", "branch_prefixes", "canonical_branches"]);
const PUBLICATION_RULE_KEYS = new Set(["remote", "endpoint", "branches", "branch_prefixes", "retirement"]);
const POLICY_KEYS = new Set(["enabled", "rules"]);

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

function branchPrefixName(value) {
  const prefix = boundedString(value, "branch_prefix", MAX_BRANCH_BYTES);
  if (
    !prefix.endsWith("/") ||
    prefix.length === 1 ||
    prefix.startsWith("/") ||
    prefix.endsWith("//") ||
    prefix.startsWith("+") ||
    GLOB_TOKEN.test(prefix) ||
    PREFIX_PATTERN_TOKEN.test(prefix)
  ) {
    invalidPolicy("branch_prefix must be a literal namespace prefix ending in '/'; globs, regexes, refspecs, and protected prefixes are not allowed.");
  }
  const base = prefix.slice(0, -1);
  // Reuse exact ref-name validation for every component before the required
  // namespace separator. This also rejects traversal, controls, and option
  // looking prefixes without inventing a second Git grammar.
  branchName(base);
  if ([...PROTECTED_BRANCH_PREFIXES].some((protectedPrefix) => prefix.toLowerCase().startsWith(protectedPrefix))) {
    invalidPolicy("branch_prefix may not authorize a canonical or protected branch namespace.");
  }
  return prefix;
}

function exactCanonicalBranches(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BRANCHES_PER_RULE) {
    invalidPolicy("retirement.canonical_branches must be a non-empty array.");
  }
  const branches = [];
  for (const rawBranch of value) {
    const branch = branchName(rawBranch);
    if (branches.includes(branch)) invalidPolicy("duplicate retirement canonical branch.");
    branches.push(branch);
  }
  return branches;
}

function normalizeRetirement(value) {
  if (!isRecord(value)) invalidPolicy("retirement must be an object.");
  for (const key of Object.keys(value)) {
    if (!RETIREMENT_RULE_KEYS.has(key)) invalidPolicy("retirement contains an unknown field.");
  }
  if (value.branches !== undefined && !Array.isArray(value.branches)) invalidPolicy("retirement.branches must be an array when provided.");
  if (value.branch_prefixes !== undefined && !Array.isArray(value.branch_prefixes)) invalidPolicy("retirement.branch_prefixes must be an array when provided.");
  const branches = [];
  for (const rawBranch of value.branches ?? []) {
    const branch = branchName(rawBranch);
    if (["main", "master", "develop", "trunk", "head"].includes(branch.toLowerCase()) || [...PROTECTED_BRANCH_PREFIXES].some((prefix) => branch.toLowerCase().startsWith(prefix))) {
      invalidPolicy("retirement target may not be canonical or protected.");
    }
    if (branches.includes(branch)) invalidPolicy("duplicate retirement exact branch.");
    branches.push(branch);
  }
  const branchPrefixes = [];
  for (const rawPrefix of value.branch_prefixes ?? []) {
    const prefix = branchPrefixName(rawPrefix);
    if (branchPrefixes.includes(prefix)) invalidPolicy("duplicate retirement branch_prefix.");
    branchPrefixes.push(prefix);
  }
  if (branches.length === 0 && branchPrefixes.length === 0) {
    invalidPolicy("retirement requires an exact branch or literal branch_prefix.");
  }
  const canonicalBranches = exactCanonicalBranches(value.canonical_branches);
  for (const branch of branches) {
    if (canonicalBranches.includes(branch)) invalidPolicy("retirement target overlaps a canonical branch.");
  }
  for (const prefix of branchPrefixes) {
    if (canonicalBranches.some((branch) => branch.startsWith(prefix))) {
      invalidPolicy("retirement target prefix overlaps a canonical branch.");
    }
  }
  for (const branch of branches) {
    if (branchPrefixes.some((prefix) => branch.startsWith(prefix))) {
      invalidPolicy("retirement exact branch overlaps a branch_prefix.");
    }
  }
  for (let index = 0; index < branchPrefixes.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < branchPrefixes.length; otherIndex += 1) {
      if (branchPrefixes[index].startsWith(branchPrefixes[otherIndex]) || branchPrefixes[otherIndex].startsWith(branchPrefixes[index])) {
        invalidPolicy("retirement branch_prefixes overlap.");
      }
    }
  }
  const result = { branches, canonical_branches: canonicalBranches };
  if (branchPrefixes.length > 0) result.branch_prefixes = branchPrefixes;
  return result;
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
  for (const key of Object.keys(value)) if (!POLICY_KEYS.has(key)) invalidPolicy("policy contains an unknown field.");
  const enabled = value.enabled === undefined ? false : value.enabled;
  if (typeof enabled !== "boolean") invalidPolicy("enabled must be boolean.");
  const rawRules = value.rules === undefined ? [] : value.rules;
  if (!Array.isArray(rawRules)) invalidPolicy("rules must be an array.");
  if (rawRules.length > MAX_POLICY_RULES) invalidPolicy(`rules may contain at most ${MAX_POLICY_RULES} entries.`);

  const rules = [];
  const seen = new Set();
  const seenPrefixesByRemote = new Map();
  const seenBranchesByRemote = new Map();
  for (const rawRule of rawRules) {
    if (!isRecord(rawRule)) invalidPolicy("each rule must be an object.");
    for (const key of Object.keys(rawRule)) {
      if (!PUBLICATION_RULE_KEYS.has(key)) invalidPolicy("rule contains an unknown field.");
    }
    const remote = remoteName(rawRule.remote);
    const endpoint = canonicalEndpoint(rawRule.endpoint);
    if (rawRule.branches !== undefined && !Array.isArray(rawRule.branches)) {
      invalidPolicy("branches must be an array when provided.");
    }
    if (Array.isArray(rawRule.branches) && rawRule.branches.length > MAX_BRANCHES_PER_RULE) {
      invalidPolicy(`each rule may contain at most ${MAX_BRANCHES_PER_RULE} branches.`);
    }
    const branches = [];
    for (const rawBranch of rawRule.branches ?? []) {
      const branch = branchName(rawBranch);
      if (branches.includes(branch)) invalidPolicy("duplicate exact branch in one rule.");
      const key = `${remote}\u0000${branch}`;
      if (seen.has(key)) invalidPolicy("duplicate remote and branch rule is ambiguous.");
      seen.add(key);
      branches.push(branch);
    }
    if (rawRule.branch_prefixes !== undefined && !Array.isArray(rawRule.branch_prefixes)) {
      invalidPolicy("branch_prefixes must be an array when provided.");
    }
    if (Array.isArray(rawRule.branch_prefixes) && rawRule.branch_prefixes.length === 0) {
      invalidPolicy("branch_prefixes must contain at least one literal prefix when provided.");
    }
    if (Array.isArray(rawRule.branch_prefixes) && rawRule.branch_prefixes.length > MAX_BRANCH_PREFIXES_PER_RULE) {
      invalidPolicy(`each rule may contain at most ${MAX_BRANCH_PREFIXES_PER_RULE} branch_prefixes.`);
    }
    const branchPrefixes = [];
    for (const rawPrefix of rawRule.branch_prefixes ?? []) {
      const prefix = branchPrefixName(rawPrefix);
      if (branchPrefixes.includes(prefix)) invalidPolicy("duplicate branch_prefix in one rule.");
      branchPrefixes.push(prefix);
    }
    if (branches.length === 0 && branchPrefixes.length === 0) {
      invalidPolicy("each rule must contain one or more exact branches or literal branch_prefixes.");
    }

    const remoteBranches = seenBranchesByRemote.get(remote) ?? [];
    const remotePrefixes = seenPrefixesByRemote.get(remote) ?? [];
    for (const branch of branches) {
      if (remotePrefixes.some((prefix) => branch.startsWith(prefix))) {
        invalidPolicy("exact branch overlaps a branch_prefix for the same remote and is ambiguous.");
      }
    }
    for (const prefix of branchPrefixes) {
      if (branches.some((branch) => branch.startsWith(prefix))) {
        invalidPolicy("exact branch overlaps a branch_prefix in the same rule and is ambiguous.");
      }
      if (remoteBranches.some((branch) => branch.startsWith(prefix))) {
        invalidPolicy("branch_prefix overlaps an exact branch for the same remote and is ambiguous.");
      }
      if (remotePrefixes.some((other) => prefix.startsWith(other) || other.startsWith(prefix))) {
        invalidPolicy("branch_prefixes overlap for the same remote and are ambiguous.");
      }
    }
    for (let index = 0; index < branchPrefixes.length; index += 1) {
      for (let otherIndex = index + 1; otherIndex < branchPrefixes.length; otherIndex += 1) {
        const prefix = branchPrefixes[index];
        const other = branchPrefixes[otherIndex];
        if (prefix.startsWith(other) || other.startsWith(prefix)) {
          invalidPolicy("branch_prefixes overlap for the same remote and are ambiguous.");
        }
      }
    }
    seenBranchesByRemote.set(remote, [...remoteBranches, ...branches]);
    seenPrefixesByRemote.set(remote, [...remotePrefixes, ...branchPrefixes]);

    const normalizedRule = { remote, endpoint, branches };
    if (rawRule.branch_prefixes !== undefined) normalizedRule.branch_prefixes = branchPrefixes;
    if (rawRule.retirement !== undefined) normalizedRule.retirement = normalizeRetirement(rawRule.retirement);
    rules.push(normalizedRule);
  }

  if (enabled && rules.length === 0) invalidPolicy("an enabled policy requires at least one branch rule.");
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

function sanitizedBranchPrefixes(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_BRANCH_PREFIXES_PER_RULE).map((prefix) =>
    typeof prefix === "string" && prefix && !CONTROL_OR_WHITESPACE.test(prefix) ? prefix.slice(0, MAX_BRANCH_BYTES) : "<invalid>"
  );
}

function sanitizedRetirement(value) {
  if (!isRecord(value)) return { branches: [], canonical_branches: [] };
  return {
    branches: sanitizedBranches(value.branches),
    ...(Array.isArray(value.branch_prefixes) ? { branch_prefixes: sanitizedBranchPrefixes(value.branch_prefixes) } : {}),
    canonical_branches: sanitizedBranches(value.canonical_branches)
  };
}

export function sanitizeGitPushPolicy(value) {
  if (!isRecord(value)) return defaultGitPushPolicy();
  const enabled = value.enabled === true;
  const rawRules = Array.isArray(value.rules) ? value.rules.slice(0, MAX_POLICY_RULES) : [];
  return {
    enabled,
    rules: rawRules.map((rule) => {
      const safeRule = {
        remote: sanitizedRemote(rule?.remote),
        endpoint: sanitizedEndpoint(rule?.endpoint),
        branches: sanitizedBranches(rule?.branches)
      };
      if (Array.isArray(rule?.branch_prefixes)) safeRule.branch_prefixes = sanitizedBranchPrefixes(rule.branch_prefixes);
      if (rule?.retirement !== undefined) safeRule.retirement = sanitizedRetirement(rule.retirement);
      return safeRule;
    })
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
  const matches = normalized.rules.filter((rule) =>
    rule.remote === safeRemote && (
      rule.branches.includes(safeBranch) ||
      (rule.branch_prefixes ?? []).some((prefix) => safeBranch.startsWith(prefix))
    )
  );
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

export function evaluateGitRetirementPolicy(repoRoot, policy, remote, branch, options = {}) {
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
  const matches = normalized.rules.filter((rule) => {
    const retirement = rule.retirement;
    return rule.remote === safeRemote && retirement !== undefined && (
      retirement.branches.includes(safeBranch) ||
      (retirement.branch_prefixes ?? []).some((prefix) => safeBranch.startsWith(prefix))
    );
  });
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
    canonical_branches: matches[0].retirement.canonical_branches,
    rule: matches[0]
  };
}

export const resolveGitPushPolicy = evaluateGitPushPolicy;
export const isGitPushPolicyAllowed = evaluateGitPushPolicy;
