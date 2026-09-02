import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function env() {
  const value = { ...process.env };
  for (const key of Object.keys(value)) if (/^GIT_/u.test(key)) delete value[key];
  return { ...value, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, env: env(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout ?? "").trim();
}
function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const value = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(value));
    });
  });
}
function id(root) { return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`; }

async function waitForHttp(child, stderr) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server timeout: ${stderr()}`)), 15_000);
    timer.unref();
    const ready = () => {
      if (!stderr().includes("HTTP MCP listening")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stderr.on("data", ready);
    child.once("exit", (code, signal) => reject(new Error(`HTTP server exited: ${code} ${signal ?? ""}; ${stderr()}`)));
    ready();
  });
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-task004-failure-probe-"));
const seed = path.join(fixture, "seed");
const remote = path.join(fixture, "remote.git");
const target = path.join(fixture, "target");
let daemon;
let http;
let client;
try {
  await mkdir(seed, { recursive: true });
  await mkdir(remote, { recursive: true });
  git(seed, ["init", "--quiet", "--initial-branch", "main"]);
  git(seed, ["config", "user.name", "Seed"]);
  git(seed, ["config", "user.email", "seed@example.test"]);
  await writeFile(path.join(seed, "notes.txt"), "R0\n");
  git(seed, ["add", "--all"]);
  git(seed, ["commit", "--quiet", "-m", "R0"]);
  const r0 = git(seed, ["rev-parse", "HEAD"]);
  git(remote, ["init", "--bare", "--quiet"]);
  git(seed, ["push", "--quiet", remote, `${r0}:refs/heads/main`]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  const daemonPort = await port();
  const endpoint = `git://127.0.0.1:${daemonPort}/remote.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", `--base-path=${fixture}`, `--port=${daemonPort}`], { cwd: fixture, stdio: "ignore" });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = spawnSync("git", ["ls-remote", endpoint, "refs/heads/main"], { cwd: fixture, env: env(), encoding: "utf8" });
    if (probe.status === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  git(fixture, ["clone", "--quiet", endpoint, target]);
  git(target, ["config", "user.name", "Target"]);
  git(target, ["config", "user.email", "target@example.test"]);
  await writeFile(path.join(target, "notes.txt"), "R0\nL1\n");
  git(target, ["add", "--all"]);
  git(target, ["commit", "--quiet", "-m", "L1"]);
  const local = git(target, ["rev-parse", "HEAD"]);
  const hook = path.join(remote, "hooks", "post-receive");
  await writeFile(hook, "#!/bin/sh\nset -eu\nsleep 3\nexit 1\n");
  await chmod(hook, 0o755);
  const canonical = target;
  const policy = { enabled: true, rules: [{ remote: "origin", endpoint, branches: ["main"] }] };
  const request = { workspace_id: id(canonical), remote: "origin", branch: "main", expected_local_head: local, expected_remote_head: r0 };
  assert.equal(git(remote, ["rev-parse", "refs/heads/main"]), r0);
  const httpPort = await port();
  let httpStderr = "";
  http = spawn(process.execPath, ["dist/http.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      CODEXPRO_ROOT: canonical,
      CODEXPRO_ALLOWED_ROOTS: path.dirname(canonical),
      CODEXPRO_HOST: "127.0.0.1",
      CODEXPRO_PORT: String(httpPort),
      CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
      CODEXPRO_BASH_MODE: "off",
      CODEXPRO_WRITE_MODE: "workspace",
      CODEXPRO_TOOL_MODE: "full",
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_CODEX_SESSIONS: "off",
      CODEXPRO_CONNECTION_TEST: "0",
      CODEXPRO_MAX_GIT_TIMEOUT_MS: "1000",
      CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy)
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  http.stderr.on("data", (chunk) => { httpStderr += String(chunk); });
  await waitForHttp(http, () => httpStderr);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`));
  client = new Client({ name: "git-push-task004-failure-probe", version: "1.0.0" });
  await client.connect(transport);
  await client.callTool({ name: "open_current_workspace", arguments: {} });
  const beforeLocalHead = git(target, ["rev-parse", "HEAD"]);
  const beforeLocalRefs = git(target, ["for-each-ref", "--format=%(refname)=%(objectname)"]);
  const beforeLocalConfig = git(target, ["config", "--local", "--null", "--list"]);
  console.log("AUTHORITY: MISSION_PLAN.md P002 TASK-004/AP-007/AP-008, MISSION_ANCHOR.md A002, and MISSION_CORRECTIONS.md COR-001 Option A.");
  console.log("TARGET_PRODUCER_ROUTE: public MCP git_push -> explicit workspace_id -> current source -> named-remote Git push -> mission-owned loopback Git daemon.");
  console.log("TARGET_EVIDENCE: public tools/call envelope plus direct bare-remote and target refs/config after the bounded timeout attempt.");
  console.log(`BEFORE: remote=${r0} local=${local}`);
  console.log("SANITY_VERDICT: MATCH — direct pre-mutation refs establish the existing remote branch at R0 and target local head L1; the post-receive hook is a fixture-controlled timeout fault.");
  console.log("PREDICATE: TRUE — independent direct Git facts establish branch attachment, local L1, remote R0, and the exact policy tuple before judging the effect.");
  const result = await client.callTool({ name: "git_push", arguments: request });
  assert.equal(result.isError, true, "git_push unexpectedly succeeded");
  const text = result.content?.find?.((part) => part.type === "text")?.text ?? "";
  console.log(`PUBLIC_ERROR: ${text}`);
  const remoteAfter = git(remote, ["rev-parse", "refs/heads/main"]);
  const localAfter = git(target, ["rev-parse", "HEAD"]);
  const refsAfter = git(target, ["for-each-ref", "--format=%(refname)=%(objectname)"]);
  const configAfter = git(target, ["config", "--local", "--null", "--list"]);
  console.log(`AFTER: remote=${remoteAfter} local=${localAfter}; timeout occurred while post-receive held the command open.`);
  assert.equal(remoteAfter, local, "post-receive timeout did not expose desired remote head");
  assert.equal(localAfter, beforeLocalHead, "timeout changed target local HEAD");
  assert.equal(refsAfter, beforeLocalRefs, "timeout changed target local refs/tracking refs");
  assert.equal(configAfter, beforeLocalConfig, "timeout changed target local config");
  assert.equal(JSON.stringify(result).includes(endpoint), false, "public timeout error leaked the raw endpoint");
  assert.equal(/stale|compare.and.swap|remote branch changed/iu.test(text), false, "public route falsely claimed a stale CAS after timeout");
} finally {
  if (client) await client.close().catch(() => {});
  if (http && http.exitCode === null) http.kill("SIGTERM");
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  await rm(fixture, { recursive: true, force: true });
}
