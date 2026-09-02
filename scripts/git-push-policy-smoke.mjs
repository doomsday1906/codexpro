import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateGitPushPolicy,
  inspectGitPushEndpoint,
  normalizeGitPushPolicy,
  resolveEffectivePushEndpoint,
  sanitizeGitPushPolicy
} from "../dist/gitPushPolicy.js";
import { loadConfig } from "../dist/config.js";
import {
  readWorkspaceProfile,
  sanitizeWorkspaceProfile,
  saveWorkspaceProfile
} from "../dist/profileStore.js";

const repoRoot = path.resolve(".");
const secret = "POLICY_SECRET_SENTINEL_7X9";

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function assertNoSecret(value, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
  assert.equal(serialized.includes(secret), false, `${label} leaked the hostile endpoint credential`);
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

class StdioClient {
  constructor(root, env = {}) {
    this.child = spawn(process.execPath, ["dist/stdio.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_BASH_MODE: "off",
        CODEXPRO_WRITE_MODE: "off",
        CODEXPRO_TOOL_MODE: "full",
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.buffer = "";
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (chunk) => this.#onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`stdio server exited ${code}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      this.child.once("close", resolve);
      this.child.kill("SIGTERM");
    });
  }
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-policy-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-policy-home-"));
try {
  git(fixture, ["init", "--quiet"]);
  git(fixture, ["config", "remote.origin.url", "github:acme/repo.git"]);
  git(fixture, ["config", "url.https://github.com/.insteadOf", "github:"]);

  const safePolicy = {
    enabled: true,
    rules: [{ remote: "origin", endpoint: "https://github.com/acme/repo.git", branches: ["main", "feature/release"] }]
  };
  assert.deepEqual(normalizeGitPushPolicy(safePolicy), safePolicy, "safe policy normalization changed its exact shape");

  const defaultConfig = await withEnvironment({
    CODEXPRO_ROOT: fixture,
    CODEXPRO_ALLOWED_ROOTS: fixture,
    CODEXPRO_GIT_PUSH_POLICY: undefined,
    CODEXPRO_HOME: home,
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
  }, () => loadConfig([]));
  assert.deepEqual(defaultConfig.gitPushPolicy, { enabled: false, rules: [] }, "absent policy did not remain default-off");

  const enabledConfig = await withEnvironment({
    CODEXPRO_ROOT: fixture,
    CODEXPRO_ALLOWED_ROOTS: fixture,
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(safePolicy),
    CODEXPRO_HOME: home,
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
  }, () => loadConfig([]));
  assert.deepEqual(enabledConfig.gitPushPolicy, safePolicy, "configured policy did not survive config loading");

  const effective = resolveEffectivePushEndpoint(fixture, "origin");
  assert.equal(effective.ok, true, `effective endpoint resolution failed: ${JSON.stringify(effective)}`);
  assert.equal(effective.identity, safePolicy.rules[0].endpoint, "Git insteadOf rewriting was not resolved");
  git(fixture, ["config", "remote.pushrewrite.url", "push-alias:acme/repo.git"]);
  git(fixture, ["config", "url.ssh://git@github.com/.pushInsteadOf", "push-alias:"]);
  const pushInsteadOf = resolveEffectivePushEndpoint(fixture, "pushrewrite");
  assert.equal(pushInsteadOf.ok, true, `effective pushInsteadOf resolution failed: ${JSON.stringify(pushInsteadOf)}`);
  assert.equal(pushInsteadOf.identity, "ssh://git@github.com/acme/repo.git", "Git pushInsteadOf rewriting was not resolved");
  assert.equal(evaluateGitPushPolicy(fixture, safePolicy, "origin", "main").allowed, true, "exact allow rule was rejected");
  assert.equal(evaluateGitPushPolicy(fixture, safePolicy, "origin", "feature/release").allowed, true, "second exact branch was rejected");
  assert.equal(evaluateGitPushPolicy(fixture, safePolicy, "upstream", "main").allowed, false, "wrong remote was allowed");
  assert.equal(evaluateGitPushPolicy(fixture, safePolicy, "origin", "release/*").allowed, false, "glob branch was allowed");

  git(fixture, ["config", "remote.origin.pushurl", "https://other.example/acme/repo.git"]);
  const substituted = evaluateGitPushPolicy(fixture, safePolicy, "origin", "main");
  assert.equal(substituted.allowed, false, "endpoint substitution after policy creation was allowed");
  assert.equal(substituted.reason, "effective-endpoint-not-allowlisted");
  git(fixture, ["config", "--unset-all", "remote.origin.pushurl"]);

  git(fixture, ["config", "--add", "remote.origin.pushurl", "https://github.com/acme/repo.git"]);
  git(fixture, ["config", "--add", "remote.origin.pushurl", "https://mirror.example/acme/repo.git"]);
  const multiple = resolveEffectivePushEndpoint(fixture, "origin");
  assert.equal(multiple.ok, false, "multiple effective push URLs were accepted");
  assert.equal(multiple.reason, "ambiguous-multiple-effective-push-endpoints");
  git(fixture, ["config", "--unset-all", "remote.origin.pushurl"]);

  const hostileEndpoint = `https://user:${secret}@github.com/acme/repo.git`;
  assert.equal(inspectGitPushEndpoint(hostileEndpoint).ok, false, "credential-bearing endpoint was accepted by endpoint parser");
  assertNoSecret(inspectGitPushEndpoint(hostileEndpoint), "endpoint rejection");
  assert.throws(
    () => normalizeGitPushPolicy({ enabled: true, rules: [{ remote: "origin", endpoint: hostileEndpoint, branches: ["main"] }] }),
    (error) => error instanceof Error && /Invalid configured Git push policy/u.test(error.message) && !error.message.includes(secret)
  );
  for (const endpoint of ["/tmp/repo.git", "file:///tmp/repo.git", "ext::ssh://host/repo.git", "helper::value"]) {
    assert.equal(inspectGitPushEndpoint(endpoint).ok, false, `${endpoint} was accepted as a target endpoint`);
  }

  git(fixture, ["config", "remote.origin.pushurl", hostileEndpoint]);
  const hostileResolution = resolveEffectivePushEndpoint(fixture, "origin");
  assert.equal(hostileResolution.ok, false, "credential-bearing effective endpoint was accepted");
  assertNoSecret(hostileResolution, "effective endpoint diagnostic");
  git(fixture, ["config", "--unset-all", "remote.origin.pushurl"]);

  const hostileProfile = {
    gitPushPolicy: { enabled: true, rules: [{ remote: "origin", endpoint: hostileEndpoint, branches: ["main"] }] }
  };
  const safeProfileDiagnostic = sanitizeWorkspaceProfile(hostileProfile);
  assertNoSecret(safeProfileDiagnostic, "profile diagnostic");
  assert.equal(safeProfileDiagnostic.gitPushPolicy.rules[0].endpoint, "<redacted>");

  await withEnvironment({ CODEXPRO_HOME: home }, async () => {
    saveWorkspaceProfile(fixture, { gitPushPolicy: safePolicy });
    const saved = readWorkspaceProfile(fixture);
    assert.deepEqual(saved.gitPushPolicy, safePolicy, "profile did not preserve the exact policy shape");
    assertNoSecret(sanitizeWorkspaceProfile(saved), "saved profile diagnostic");

    assert.throws(
      () => saveWorkspaceProfile(fixture, { gitPushPolicy: hostileProfile.gitPushPolicy }),
      (error) => error instanceof Error && /Invalid configured Git push policy:/u.test(error.message) && !error.message.includes(secret)
    );
    assert.deepEqual(readWorkspaceProfile(fixture).gitPushPolicy, safePolicy, "rejected hostile profile changed the saved policy");

    const cliPolicyJson = JSON.stringify(safePolicy);
    const cliSet = spawnSync(process.execPath, ["scripts/codexpro.mjs", "settings", "set", "--root", fixture, "--git-push-policy", cliPolicyJson], {
      cwd: repoRoot,
      env: { ...process.env, CODEXPRO_HOME: home, CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1" },
      encoding: "utf8"
    });
    assert.equal(cliSet.status, 0, `CLI profile save failed: ${cliSet.stderr || cliSet.stdout}`);
    assertNoSecret(cliSet.stdout, "CLI profile-save output");
    assert.deepEqual(readWorkspaceProfile(fixture).gitPushPolicy, safePolicy, "CLI profile save changed the exact policy shape");

    const cliShow = spawnSync(process.execPath, ["scripts/codexpro.mjs", "settings", "show", "--root", fixture], {
      cwd: repoRoot,
      env: { ...process.env, CODEXPRO_HOME: home },
      encoding: "utf8"
    });
    assert.equal(cliShow.status, 0, `CLI profile load failed: ${cliShow.stderr || cliShow.stdout}`);
    assert.match(cliShow.stdout, /Git push policy enabled \(1 rule\)/u, "CLI profile load did not expose the saved policy state");
    assertNoSecret(cliShow.stdout, "CLI profile-load output");
  });

  const client = new StdioClient(fixture, { CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(safePolicy) });
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codexpro-git-push-policy-smoke", version: "0.1.0" }
    });
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list");
    const toolNames = listed.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("git_push"), false, "TASK-003 public git_push appeared in TASK-002");
    assert.equal(toolNames.includes("server_config"), true, "server_config disappeared from full mode");

    const serverConfig = await client.request("tools/call", { name: "server_config", arguments: {} });
    assert.equal(serverConfig.isError, undefined, `server_config failed: ${JSON.stringify(serverConfig)}`);
    assert.equal(serverConfig.structuredContent.gitPushPolicy.enabled, true, "server_config omitted enabled policy state");
    assertNoSecret(serverConfig, "server_config diagnostic");

    const inventory = await client.request("tools/call", {
      name: "codexpro_inventory",
      arguments: { include_global_skills: false, include_mcp_servers: false, max_skills: 1 }
    });
    assert.equal(inventory.isError, undefined, `inventory failed: ${JSON.stringify(inventory)}`);
    assert.equal(inventory.structuredContent.git_push_policy.enabled, true, "inventory omitted policy state");
    assertNoSecret(inventory, "inventory diagnostic");
  } finally {
    await client.close();
  }

  console.log("RAW_OBSERVATION: absent policy resolved to disabled; rewritten effective endpoint matched the exact HTTPS rule; wrong remote/branch, substitution, multiple push URLs, credentials, local/file/helper endpoints, and glob branches were rejected; git_push was absent from full-mode tools.");
  console.log("SANITY_VERDICT: MATCH (direct local-Git/config/profile/MCP observations satisfy AP-003/AP-004 policy invariants)");
  console.log("PREDICATE: TRUE (the policy-enabled config and exact local Git remote were independently observed before evaluating allow/deny effects)");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}
