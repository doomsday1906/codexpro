import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateGitPromotePolicy,
  inspectGitPromoteEndpoint,
  normalizeGitPromotePolicy,
  resolveEffectivePromoteEndpoint,
  sanitizeGitPromotePolicy
} from "../dist/gitPromotePolicy.js";
import { loadConfig } from "../dist/config.js";

const repoRoot = path.resolve(".");
const secret = "PROMOTE_POLICY_SECRET_7X9";

function git(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function assertNoSecret(value, label) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  assert.equal(s.includes(secret), false, `${label} leaked`);
}

async function withEnv(values, cb) {
  const prev = new Map();
  for (const [k, v] of Object.entries(values)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return await cb();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
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
        CODEXPRO_WRITE_MODE: "workspace",
        CODEXPRO_TOOL_MODE: "full",
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (c) => this.#onData(String(c)));
    this.child.on("exit", (code) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`stdio exited ${code}`));
      }
      this.pending.clear();
    });
  }
  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const i = this.buffer.indexOf("\n");
      if (i < 0) return;
      const line = this.buffer.slice(0, i).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (!msg.id || !this.pending.has(msg.id)) continue;
      const p = this.pending.get(msg.id);
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }
  request(method, params = {}) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  async close() {
    if (this.child.exitCode !== null) return;
    await new Promise((resolve) => {
      this.child.once("close", resolve);
      this.child.kill("SIGTERM");
    });
  }
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-promote-policy-"));
const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-git-promote-policy-home-"));
try {
  git(fixture, ["init", "--quiet"]);
  git(fixture, ["config", "remote.origin.url", "github:acme/repo.git"]);
  git(fixture, ["config", "url.https://github.com/.insteadOf", "github:"]);

  const safePolicy = {
    enabled: true,
    rules: [{ remote: "origin", endpoint: "https://github.com/acme/repo.git", branches: ["main"] }]
  };
  assert.deepEqual(normalizeGitPromotePolicy(safePolicy), safePolicy);

  const defaultConfig = await withEnv({
    CODEXPRO_ROOT: fixture,
    CODEXPRO_ALLOWED_ROOTS: fixture,
    CODEXPRO_GIT_PROMOTE_POLICY: undefined,
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
  }, () => loadConfig([]));
  assert.deepEqual(defaultConfig.gitPromotePolicy, { enabled: false, rules: [] });

  const enabledConfig = await withEnv({
    CODEXPRO_ROOT: fixture,
    CODEXPRO_ALLOWED_ROOTS: fixture,
    CODEXPRO_GIT_PROMOTE_POLICY: JSON.stringify(safePolicy),
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1"
  }, () => loadConfig([]));
  assert.deepEqual(enabledConfig.gitPromotePolicy, safePolicy);

  const effective = resolveEffectivePromoteEndpoint(fixture, "origin");
  assert.equal(effective.ok, true);
  assert.equal(effective.identity, safePolicy.rules[0].endpoint);
  assert.equal(evaluateGitPromotePolicy(fixture, safePolicy, "origin", "main").allowed, true);
  assert.equal(evaluateGitPromotePolicy(fixture, safePolicy, "origin", "feature").allowed, false);

  const hostileEndpoint = `https://user:${secret}@github.com/acme/repo.git`;
  assert.equal(inspectGitPromoteEndpoint(hostileEndpoint).ok, false);
  assertNoSecret(inspectGitPromoteEndpoint(hostileEndpoint), "endpoint");
  assert.throws(
    () => normalizeGitPromotePolicy({ enabled: true, rules: [{ remote: "origin", endpoint: hostileEndpoint, branches: ["main"] }] }),
    (e) => e instanceof Error && /Invalid configured Git promote policy/u.test(e.message) && !e.message.includes(secret)
  );
  for (const endpoint of ["/tmp/repo.git", "file:///tmp/repo.git", "ext::ssh://host/repo.git"]) {
    assert.equal(inspectGitPromoteEndpoint(endpoint).ok, false, `${endpoint} accepted`);
  }

  // Push-only permission does not imply promote: evaluate with push policy shape must not pass promote check.
  const pushOnly = { enabled: true, rules: [{ remote: "origin", endpoint: "https://github.com/acme/repo.git", branches: ["feature-x"] }] };
  assert.equal(evaluateGitPromotePolicy(fixture, pushOnly, "origin", "main").allowed, false, "push-only branches leaked into promote");

  // Tool visibility: push enabled alone must not expose git_promote; promote enabled alone must expose it without git_push.
  const pushClient = new StdioClient(fixture, {
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify({ enabled: true, rules: [{ remote: "origin", endpoint: "https://github.com/acme/repo.git", branches: ["feature-x"] }] }),
    CODEXPRO_GIT_PROMOTE_POLICY: JSON.stringify({ enabled: false, rules: [] })
  });
  try {
    await pushClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "promote-policy", version: "0.1.0" } });
    pushClient.notify("notifications/initialized");
    const listed = await pushClient.request("tools/list");
    const names = listed.tools.map((t) => t.name);
    assert.equal(names.includes("git_push"), true, "push should be visible with push policy");
    assert.equal(names.includes("git_promote"), false, "promote must not appear with push-only permission");
  } finally {
    await pushClient.close();
  }

  const promoteClient = new StdioClient(fixture, {
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify({ enabled: false, rules: [] }),
    CODEXPRO_GIT_PROMOTE_POLICY: JSON.stringify(safePolicy)
  });
  try {
    await promoteClient.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "promote-policy", version: "0.1.0" } });
    promoteClient.notify("notifications/initialized");
    const listed = await promoteClient.request("tools/list");
    const names = listed.tools.map((t) => t.name);
    assert.equal(names.includes("git_promote"), true, "promote should be visible with promote policy");
    assert.equal(names.includes("git_push"), false, "push must not appear with promote-only permission");
    const tool = listed.tools.find((t) => t.name === "git_promote");
    assert.deepEqual(Object.keys(tool.inputSchema?.properties ?? {}).sort(), ["branch", "expected_remote_head", "remote", "source_commit", "workspace_id"].sort());
  } finally {
    await promoteClient.close();
  }

  console.log("RAW_OBSERVATION: promote policy evaluates exact canonical branches; hostile/file endpoints rejected; push-only does not grant promote; tool visibility separates push vs promote.");
  console.log("SANITY_VERDICT: MATCH");
  console.log("PROMOTE_POLICY: PASS");
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}
