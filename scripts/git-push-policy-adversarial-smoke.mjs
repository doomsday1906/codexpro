import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import {
  evaluateGitPushPolicy,
  inspectGitPushEndpoint,
  resolveEffectivePushEndpoint
} from "../dist/gitPushPolicy.js";
import {
  readWorkspaceProfile,
  sanitizeWorkspaceProfile,
  saveWorkspaceProfile
} from "../dist/profileStore.js";

const secret = "POLICY_ADVERSARIAL_SECRET_7X9";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-policy-adversarial-"));
const alternate = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-policy-alternate-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-policy-home-"));
const originalGitEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => /^GIT_/u.test(key))
);
for (const key of Object.keys(process.env)) {
  if (/^GIT_/u.test(key)) delete process.env[key];
}

function cleanGitEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^GIT_/u.test(key)) delete environment[key];
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...overrides
  });
  return environment;
}

function rawGit(root, args, env = {}) {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: root,
    env: cleanGitEnvironment(env),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture Git failed (${result.status}): ${result.stderr || result.stdout || result.error?.message || "unknown"}`);
  }
  return String(result.stdout ?? "").trim();
}

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertNoSecret(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  assert.equal(text.includes(secret), false, `${label} leaked the credential sentinel`);
}

function assertRejectedEndpoint(endpoint, expectedReason) {
  const result = inspectGitPushEndpoint(endpoint);
  assert.equal(result.ok, false, `${endpoint} was accepted as an endpoint`);
  if (expectedReason) assert.equal(result.reason, expectedReason, `${endpoint} rejection reason changed`);
  assertNoSecret(result, `${endpoint} endpoint diagnostic`);
}

try {
  // Build two real local Git repositories. The target has a credential-free
  // URL rewritten by its local insteadOf rule; the alternate and hostile
  // configs are only used as ambient-environment falsifiers.
  rawGit(fixture, ["init", "--quiet"]);
  rawGit(fixture, ["config", "remote.origin.url", "git-host:acme/repo.git"]);
  rawGit(fixture, ["config", "url.https://good.example/.insteadOf", "git-host:"]);
  rawGit(alternate, ["init", "--quiet"]);
  rawGit(alternate, ["config", "remote.origin.url", "https://ambient.example/alternate.git"]);

  // PASS 1: direct observable facts, before policy labels or test assertions.
  const directConfig = rawGit(fixture, ["config", "--local", "--get-all", "remote.origin.url"]);
  const directEffective = rawGit(fixture, ["remote", "get-url", "--push", "--all", "origin"]);
  const ambientCountEffective = rawGit(fixture, ["remote", "get-url", "--push", "--all", "origin"], {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_0: "https://ambient.example/injected.git"
  });
  const ambientDirEffective = rawGit(fixture, ["remote", "get-url", "--push", "--all", "origin"], {
    GIT_DIR: path.join(alternate, ".git")
  });
  console.log(`PLAIN_FACT: target local remote URL is ${directConfig}`);
  console.log(`PLAIN_FACT: target effective push endpoint is ${directEffective}`);
  console.log(`PLAIN_FACT: inherited GIT_CONFIG_COUNT changes the same Git query to ${ambientCountEffective}`);
  console.log(`PLAIN_FACT: inherited GIT_DIR changes the same Git query to ${ambientDirEffective}`);
  console.log("SANITY_VERDICT: MATCH (the target endpoint is directly observable as the credential-free rewritten HTTPS URL; ambient Git variables demonstrably select different data)");

  const safePolicy = {
    enabled: true,
    rules: [{ remote: "origin", endpoint: "https://good.example/acme/repo.git", branches: ["main", "feature/release"] }]
  };

  // Ordinary supported endpoint forms remain semantically distinct.
  const endpointForms = [
    ["https://host.example/org/repo.git", "https"],
    ["http://host.example/org/repo.git", "http"],
    ["ssh://git@host.example/org/repo.git", "ssh"],
    ["git://host.example/org/repo.git", "git"],
    ["git+ssh://git@host.example/org/repo.git", "git+ssh"],
    ["git@host.example:org/repo.git", "scp"],
    ["git@host.example:/org/repo.git", "scp"]
  ];
  const identities = endpointForms.map(([endpoint, style]) => {
    const result = inspectGitPushEndpoint(endpoint);
    assert.equal(result.ok, true, `${endpoint} was not accepted as a supported transport`);
    assert.equal(result.style, style, `${endpoint} was assigned the wrong transport style`);
    return result.identity;
  });
  assert.equal(new Set(identities).size, identities.length, "supported transport forms were conflated");
  assert.notEqual(identities.at(-2), identities.at(-1), "scp host:path and host:/path were conflated");

  for (const endpoint of [
    `/tmp/${secret}.git`,
    "file:///tmp/repo.git",
    "ext::ssh://host.example/repo.git",
    "helper::value",
    "ftp://host.example/repo.git",
    "https://user:password@host.example/repo.git",
    `https://user:${secret}@host.example/repo.git`,
    "https://host.example/repo.git?token=secret",
    "https://host.example/repo.git#secret",
    "ssh://git:password@host.example/repo.git",
    "host.example:"
  ]) {
    assertRejectedEndpoint(endpoint);
  }

  // Config/profile policy parsing rejects malformed or hostile values before
  // writing, and diagnostics never echo the endpoint credential.
  await withEnvironment({ CODEXPRO_HOME: home }, async () => {
    saveWorkspaceProfile(fixture, { gitPushPolicy: safePolicy });
    const savedBefore = readWorkspaceProfile(fixture).gitPushPolicy;
    assert.deepEqual(savedBefore, safePolicy);
    const hostilePolicy = {
      enabled: true,
      rules: [{ remote: "origin", endpoint: `https://user:${secret}@host.example/repo.git`, branches: ["main"] }]
    };
    assert.throws(
      () => saveWorkspaceProfile(fixture, { gitPushPolicy: hostilePolicy }),
      (error) => error instanceof Error && /Invalid configured Git push policy:/u.test(error.message) && !error.message.includes(secret)
    );
    assert.deepEqual(readWorkspaceProfile(fixture).gitPushPolicy, safePolicy, "policy parse failure mutated the saved profile");
    assertNoSecret(sanitizeWorkspaceProfile({ gitPushPolicy: hostilePolicy }), "profile sanitizer");

    const cli = spawnSync(process.execPath, [
      "scripts/codexpro.mjs", "settings", "set", "--root", fixture,
      "--git-push-policy", JSON.stringify(hostilePolicy)
    ], {
      cwd: path.resolve("."),
      env: cleanGitEnvironment({ CODEXPRO_HOME: home, CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1" }),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    assert.notEqual(cli.status, 0, "CLI accepted a credential-bearing policy");
    assertNoSecret(cli.stdout, "CLI hostile-policy stdout");
    assertNoSecret(cli.stderr, "CLI hostile-policy stderr");
    assert.deepEqual(readWorkspaceProfile(fixture).gitPushPolicy, safePolicy, "hostile CLI policy changed the saved profile");
  });

  // Absent policy is default-off and must not probe Git at all. A missing
  // executable is a call-count oracle only; no remote or helper is involved.
  const disabled = evaluateGitPushPolicy(fixture, undefined, "origin", "main", { gitBin: "/definitely/missing/git" });
  assert.deepEqual(disabled, { allowed: false, reason: "policy-disabled" });
  const wrongRemote = evaluateGitPushPolicy(fixture, safePolicy, "other", "main", { gitBin: "/definitely/missing/git" });
  assert.deepEqual(wrongRemote, { allowed: false, reason: "remote-or-branch-not-allowlisted" });
  const defaultConfig = await withEnvironment({
    CODEXPRO_ROOT: fixture,
    CODEXPRO_ALLOWED_ROOTS: fixture,
    CODEXPRO_GIT_PUSH_POLICY: undefined,
    CODEXPRO_HOME: home,
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
  }, () => loadConfig([]));
  assert.deepEqual(defaultConfig.gitPushPolicy, { enabled: false, rules: [] });

  // Exact remote + endpoint + branch only. Malformed values and globs never
  // reach endpoint resolution.
  for (const remote of ["other", "origin*", "origin?", "origin::helper", "-origin", " origin", "origin\n"]) {
    const decision = evaluateGitPushPolicy(fixture, safePolicy, remote, "main", { gitBin: "/definitely/missing/git" });
    assert.equal(decision.allowed, false, `hostile remote ${JSON.stringify(remote)} was allowed`);
    const expectedReason = remote === "other" ? "remote-or-branch-not-allowlisted" : "invalid-remote-or-branch";
    assert.equal(decision.reason, expectedReason, `remote ${JSON.stringify(remote)} returned an unexpected reason`);
  }
  for (const branch of ["release/*", "release?", "main~1", "main^", "main:other", "../main", "main..other", "-main", "main.lock", " main"]) {
    const decision = evaluateGitPushPolicy(fixture, safePolicy, "origin", branch, { gitBin: "/definitely/missing/git" });
    assert.equal(decision.allowed, false, `hostile branch ${JSON.stringify(branch)} was allowed`);
    assert.equal(decision.reason, "invalid-remote-or-branch");
  }

  // The effective endpoint must be derived from the target repository under
  // a sealed Git environment. Each poisoned raw query above is a falsifier;
  // none may substitute for the target endpoint used by policy evaluation.
  const poisonCases = [
    [
      "GIT_CONFIG_COUNT injection",
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.origin.pushurl",
        GIT_CONFIG_VALUE_0: "https://ambient.example/injected.git"
      }
    ],
    [
      "GIT_CONFIG_GLOBAL override",
      {
        GIT_CONFIG_GLOBAL: path.join(home, "global.gitconfig"),
        GIT_CONFIG_NOSYSTEM: "1"
      }
    ],
    [
      "GIT_CONFIG_SYSTEM override",
      {
        GIT_CONFIG_SYSTEM: path.join(home, "system.gitconfig"),
        GIT_CONFIG_NOSYSTEM: "0"
      }
    ],
    [
      "GIT_DIR override",
      { GIT_DIR: path.join(alternate, ".git") }
    ]
  ];
  await fs.writeFile(path.join(home, "global.gitconfig"), "[remote \"origin\"]\n\tpushurl = https://ambient.example/global.git\n", "utf8");
  await fs.writeFile(path.join(home, "system.gitconfig"), "[remote \"origin\"]\n\tpushurl = https://ambient.example/system.git\n", "utf8");
  const safeIdentity = "https://good.example/acme/repo.git";
  const ambientFailures = [];
  for (const [label, poison] of poisonCases) {
    const resolved = await withEnvironment(poison, () => resolveEffectivePushEndpoint(fixture, "origin"));
    console.log(`PLAIN_POLICY_FACT: repaired resolver returned ${resolved.ok ? resolved.identity : resolved.reason ?? "<no endpoint>"}`);
    if (!resolved.ok || resolved.identity !== safeIdentity) {
      ambientFailures.push({ label, resolved });
      continue;
    }
    const decision = await withEnvironment(poison, () => evaluateGitPushPolicy(fixture, safePolicy, "origin", "main"));
    if (!decision.allowed) ambientFailures.push({ label, decision });
  }
  assert.deepEqual(ambientFailures, [], "ambient Git environment changed effective endpoint resolution or policy authorization");
  const baselineResolved = resolveEffectivePushEndpoint(fixture, "origin");
  assert.equal(baselineResolved.identity, safeIdentity);

  console.log("TECHNICAL_RESULT: endpoint forms, exact tuple gates, malformed inputs, credential-safe diagnostics, profile/CLI nonmutation, default-off no-probe, and ambient Git falsifiers passed");
  console.log("PREDICATE: TRUE (the target local remote and rewritten endpoint were independently observed before evaluating the exact policy effect)");
} finally {
  for (const key of Object.keys(process.env)) {
    if (/^GIT_/u.test(key)) delete process.env[key];
  }
  Object.assign(process.env, originalGitEnvironment);
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(alternate, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}
