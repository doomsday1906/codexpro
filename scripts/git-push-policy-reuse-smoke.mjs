import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import {
  readWorkspaceProfile,
  sanitizeWorkspaceProfile,
  saveWorkspaceProfile
} from "../dist/profileStore.js";

const repoRoot = path.resolve(".");
const secret = "POLICY_REUSE_SECRET_7X9";

function cleanEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CODEXPRO_GIT_PUSH_POLICY;
  delete environment.CODEXPRO_ROOT;
  delete environment.CODEXPRO_ALLOWED_ROOTS;
  delete environment.CODEXPRO_HTTP_TOKEN;
  delete environment.CODEBASE_BRIDGE_HTTP_TOKEN;
  Object.assign(environment, overrides);
  return environment;
}

function runCli(home, args, overrides = {}) {
  const result = spawnSync(process.execPath, ["scripts/codexpro.mjs", ...args], {
    cwd: repoRoot,
    env: cleanEnvironment({
      CODEXPRO_HOME: home,
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
      ...overrides
    }),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    ...result,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function assertNoSecret(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  assert.equal(text.includes(secret), false, `${label} leaked the ambient credential sentinel`);
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
  constructor(root, home) {
    this.child = spawn(process.execPath, ["dist/stdio.js"], {
      cwd: repoRoot,
      env: cleanEnvironment({
        CODEXPRO_HOME: home,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: root,
        CODEXPRO_BASH_MODE: "off",
        CODEXPRO_WRITE_MODE: "off",
        CODEXPRO_TOOL_MODE: "full",
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
      }),
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

const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-policy-source-"));
const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-policy-target-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-policy-reuse-home-"));
const sourcePolicy = {
  enabled: true,
  rules: [{ remote: "origin", endpoint: "https://good.example/acme/source.git", branches: ["main"] }]
};
const targetPolicy = {
  enabled: true,
  rules: [{ remote: "origin", endpoint: "https://good.example/acme/target.git", branches: ["release"] }]
};
const hostileAmbientPolicy = {
  enabled: true,
  rules: [{ remote: "origin", endpoint: `https://user:${secret}@ambient.example/injected.git`, branches: ["main"] }]
};

try {
  await withEnvironment({ CODEXPRO_HOME: home }, async () => {
    saveWorkspaceProfile(sourceRoot, { tunnel: "none", gitPushPolicy: sourcePolicy });
  });

  const sourceBefore = await withEnvironment({ CODEXPRO_HOME: home }, () => readWorkspaceProfile(sourceRoot));
  assert.deepEqual(sourceBefore.gitPushPolicy, sourcePolicy, "source profile did not retain its configured policy");
  assertNoSecret(sanitizeWorkspaceProfile(sourceBefore), "source profile diagnostic");

  // An ambient policy is deliberately present in the copy process. It is not
  // a dedicated target flag and must not become persisted target authority.
  const firstCopy = runCli(home, [
    "settings", "use", "--from-root", sourceRoot, "--root", targetRoot
  ], { CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(hostileAmbientPolicy) });
  assert.equal(firstCopy.status, 0, `generic profile reuse failed: ${firstCopy.stderr || firstCopy.stdout}`);
  assertNoSecret(firstCopy.stdout, "generic reuse output");
  assertNoSecret(firstCopy.stderr, "generic reuse diagnostics");

  const targetAfterGenericCopy = await withEnvironment({ CODEXPRO_HOME: home }, () => readWorkspaceProfile(targetRoot));
  const targetDiagnosticAfterGenericCopy = sanitizeWorkspaceProfile(targetAfterGenericCopy);
  console.log(`RAW_OBSERVATION: source profile has enabled policy for ${sourceBefore.gitPushPolicy.rules[0].endpoint}`);
  console.log(`RAW_OBSERVATION: target profile after generic reuse has gitPushPolicy=${String(targetAfterGenericCopy.gitPushPolicy)}`);
  assert.equal(targetAfterGenericCopy.gitPushPolicy, undefined, "generic reuse copied source remote-write policy into target");
  assertNoSecret(targetDiagnosticAfterGenericCopy, "target profile diagnostic after generic reuse");

  const defaultConfig = await withEnvironment({
    CODEXPRO_ROOT: targetRoot,
    CODEXPRO_ALLOWED_ROOTS: targetRoot,
    CODEXPRO_GIT_PUSH_POLICY: undefined,
    CODEXPRO_HOME: home,
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
  }, () => loadConfig([]));
  assert.deepEqual(defaultConfig.gitPushPolicy, { enabled: false, rules: [] }, "target default did not remain policy-off");

  const client = new StdioClient(targetRoot, home);
  try {
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "codexpro-git-push-policy-reuse-smoke", version: "0.1.0" }
    });
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list");
    const toolNames = listed.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes("git_push"), false, "generic reuse exposed git_push in default-off target runtime");
    const serverConfig = await client.request("tools/call", { name: "server_config", arguments: {} });
    assert.equal(serverConfig.isError, undefined, `target server_config failed: ${JSON.stringify(serverConfig)}`);
    assert.deepEqual(serverConfig.structuredContent.gitPushPolicy, { enabled: false, rules: [] }, "target runtime did not resolve default-off policy");
    assertNoSecret(serverConfig, "target server_config diagnostic");
  } finally {
    await client.close();
  }

  const explicitCopy = runCli(home, [
    "settings", "use", "--from-root", sourceRoot, "--root", targetRoot,
    "--git-push-policy", JSON.stringify(targetPolicy)
  ]);
  assert.equal(explicitCopy.status, 0, `explicit target policy reuse failed: ${explicitCopy.stderr || explicitCopy.stdout}`);
  assertNoSecret(explicitCopy.stdout, "explicit target reuse output");
  assertNoSecret(explicitCopy.stderr, "explicit target reuse diagnostics");
  const targetAfterExplicitCopy = await withEnvironment({ CODEXPRO_HOME: home }, () => readWorkspaceProfile(targetRoot));
  assert.deepEqual(targetAfterExplicitCopy.gitPushPolicy, targetPolicy, "dedicated target policy input was not saved exactly");

  const secondCopy = runCli(home, [
    "settings", "use", "--from-root", sourceRoot, "--root", targetRoot
  ], { CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(hostileAmbientPolicy) });
  assert.equal(secondCopy.status, 0, `generic profile reuse over existing target policy failed: ${secondCopy.stderr || secondCopy.stdout}`);
  assertNoSecret(secondCopy.stdout, "existing target reuse output");
  assertNoSecret(secondCopy.stderr, "existing target reuse diagnostics");
  const targetAfterPreservingCopy = await withEnvironment({ CODEXPRO_HOME: home }, () => readWorkspaceProfile(targetRoot));
  assert.deepEqual(targetAfterPreservingCopy.gitPushPolicy, targetPolicy, "generic reuse overwrote target-owned policy");

  const sourceAfter = await withEnvironment({ CODEXPRO_HOME: home }, () => readWorkspaceProfile(sourceRoot));
  assert.deepEqual(sourceAfter.gitPushPolicy, sourcePolicy, "generic reuse mutated source policy");
  assertNoSecret(sanitizeWorkspaceProfile(sourceAfter), "source profile diagnostic after reuse");

  const shown = runCli(home, ["settings", "show", "--root", targetRoot]);
  assert.equal(shown.status, 0, `target profile display failed: ${shown.stderr || shown.stdout}`);
  assert.match(shown.stdout, /Git push policy enabled \(1 rule\)/u, "saved target policy did not remain visible in profile display");
  assertNoSecret(shown.stdout, "target profile display");

  console.log("RAW_OBSERVATION: generic reuse left the target profile without a policy; the default target runtime reported disabled policy and no git_push; an explicit target policy was then saved and survived a later unrelated reuse.");
  console.log("SANITY_VERDICT: MATCH (direct source/target profile readback, target runtime response, and CLI output match the accepted reuse boundary)");
  console.log("PREDICATE: TRUE (target absence was directly observed before evaluating its default-off runtime effect)");
} finally {
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}
