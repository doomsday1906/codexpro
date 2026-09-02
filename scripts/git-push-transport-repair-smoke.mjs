import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GIT_PUSH_FIXED_OPTIONS } from "../dist/gitPush.js";

const REPO_ROOT = path.resolve(".");
const BRANCH = "main";
const REF = `refs/heads/${BRANCH}`;
const SECRET = "TASK004_TRANSPORT_SECRET_7X9";
const RECEIVEPACK_SENTINEL = "TASK004_RECEIVEPACK_SENTINEL_7X9";
const CONFIG_RACE_SENTINEL = "TASK004_CONFIG_RACE_SENTINEL_7X9";
const CONFIG_PATH_SENTINEL = "TASK004_CONFIG_PATH_SENTINEL_7X9";
const CONFIG_VALUE_SENTINEL = "TASK004_CONFIG_VALUE_SENTINEL_7X9";
const CONFIG_CREDENTIAL_SENTINEL = "TASK004_CONFIG_CREDENTIAL_SENTINEL_7X9";

function cleanGitEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/u.test(key)) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...overrides
  };
}

function gitResult(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    input: options.input === undefined ? undefined : Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input)),
    env: cleanGitEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function git(cwd, args, options = {}) {
  const result = gitResult(cwd, args, options);
  if (result.error || result.status !== 0) {
    const stderr = Buffer.from(result.stderr ?? "").toString("utf8");
    throw new Error(`fixture git failed (${result.status}): ${args.join(" ")} ${stderr.slice(0, 400)}`);
  }
  return Buffer.from(result.stdout ?? "");
}

function gitText(cwd, args, options = {}) {
  return git(cwd, args, options).toString("utf8").trim();
}

function initRepo(root, name) {
  git(root, ["init", "--quiet", "--initial-branch", BRANCH]);
  git(root, ["config", "user.name", name]);
  git(root, ["config", "user.email", `${name.toLowerCase().replaceAll(" ", "-")}@example.test`]);
  git(root, ["config", "core.logAllRefUpdates", "true"]);
}

function commit(root, message) {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "--message", message]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function workspaceId(root) {
  return `ws_${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
}

function refs(root) {
  return gitText(root, ["for-each-ref", "--format=%(refname)=%(objectname)"]);
}

function head(root) {
  return gitText(root, ["rev-parse", REF]);
}

function remoteHead(root, remote) {
  const output = gitText(root, ["ls-remote", "--refs", "--heads", "--", remote, REF]);
  const [value, ref] = output.split("\t");
  assert.equal(ref, REF, `remote observation returned an unexpected ref for ${remote}`);
  assert.match(value, /^[0-9a-f]{40}$/iu, "remote observation was not a full SHA-1");
  return value.toLowerCase();
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => listener.close(resolve));
  assert.ok(port > 0, "failed to reserve loopback port");
  return port;
}

async function waitForDaemon(endpoint, daemon) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = gitResult(REPO_ROOT, ["ls-remote", endpoint, REF]);
    if (result.status === 0 && String(result.stdout ?? "").endsWith(`\t${REF}\n`)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`loopback git daemon did not become observable (exit=${daemon.exitCode})`);
}

function parseEnvelope(capture) {
  const body = capture?.body ?? "";
  if (!body.trim()) return undefined;
  if (capture.contentType?.includes("application/json")) return JSON.parse(body);
  const events = [...body.matchAll(/^data:\s*(.+)$/gmu)].map((match) => match[1]).filter(Boolean);
  return events.length ? JSON.parse(events.at(-1)) : undefined;
}

function captureFetch(captures) {
  return async (input, init = {}) => {
    const response = await fetch(input, init);
    const body = await response.clone().text().catch(() => "");
    captures.push({
      method: init.method ?? "GET",
      requestBody: typeof init.body === "string" ? init.body : "",
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body
    });
    return response;
  };
}

async function connect(url) {
  const captures = [];
  const client = new Client({ name: "git-push-transport-repair-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: captureFetch(captures) });
  await client.connect(transport);
  return { client, transport, captures };
}

async function close(session) {
  if (!session) return;
  await session.transport.terminateSession().catch(() => {});
  await session.client.close().catch(() => {});
}

async function call(session, name, args) {
  const start = session.captures.length;
  let result;
  let error;
  try {
    result = await session.client.callTool({ name, arguments: args });
  } catch (caught) {
    error = caught;
  }
  const calls = session.captures.slice(start).filter((capture) => {
    if (capture.method !== "POST" || !capture.requestBody) return false;
    try {
      const request = JSON.parse(capture.requestBody);
      return request.method === "tools/call" && request.params?.name === name;
    } catch {
      return false;
    }
  });
  const last = calls.at(-1);
  return { result, error, rawEnvelope: parseEnvelope(last), rawBody: last?.body ?? "" };
}

function resultText(output) {
  return output?.result?.content?.find?.((part) => part.type === "text")?.text
    ?? JSON.stringify(output?.result ?? output?.rawEnvelope ?? output?.error);
}

function expectSuccess(output, label) {
  assert.equal(output.error, undefined, `${label} threw: ${output.error?.message ?? output.error}`);
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} omitted JSON-RPC envelope`);
  assert.ok(output.rawEnvelope?.result, `${label} omitted result`);
  assert.notEqual(output.result?.isError, true, `${label} failed: ${resultText(output)}`);
  return output.result;
}

function expectError(output, label) {
  assert.equal(output.rawEnvelope?.jsonrpc, "2.0", `${label} omitted JSON-RPC envelope`);
  if (output.error) return output;
  assert.equal(output.result?.isError, true, `${label} unexpectedly succeeded: ${resultText(output)}`);
  return output;
}

function assertSafe(value, label, disallowedValues) {
  const body = JSON.stringify(value) ?? "";
  for (const valueToReject of [SECRET, ...disallowedValues]) {
    assert.equal(body.includes(valueToReject), false, `${label} leaked sensitive transport value`);
  }
}

async function withHttpServer({ defaultRoot, allowedRoots, policy, environment = {}, forbiddenOutput = [] }, callback) {
  const port = await freePort();
  const env = {
    ...process.env,
    CODEXPRO_ROOT: defaultRoot,
    CODEXPRO_ALLOWED_ROOTS: allowedRoots.join(path.delimiter),
    CODEXPRO_HOST: "127.0.0.1",
    CODEXPRO_PORT: String(port),
    CODEXPRO_ALLOW_NO_HTTP_TOKEN: "1",
    CODEXPRO_BASH_MODE: "off",
    CODEXPRO_WRITE_MODE: "workspace",
    CODEXPRO_TOOL_MODE: "full",
    CODEXPRO_TOOL_CARDS: "0",
    CODEXPRO_CODEX_SESSIONS: "off",
    CODEXPRO_CONNECTION_TEST: "0",
    CODEXPRO_GIT_PUSH_POLICY: JSON.stringify(policy),
    ...environment
  };
  delete env.CODEXPRO_HTTP_TOKEN;
  delete env.CODEBASE_BRIDGE_HTTP_TOKEN;
  delete env.CODEXPRO_REQUIRE_HTTP_TOKEN;
  delete env.CODEXPRO_TUNNEL_MODE;
  const child = spawn(process.execPath, ["dist/http.js"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HTTP server timeout\n${stderr.slice(0, 500)}`)), 15_000);
    timer.unref();
    child.stderr.on("data", () => {
      if (stderr.includes("HTTP MCP listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code} ${signal ?? ""}`));
    });
  });
  try {
    await listening;
    return await callback(`http://127.0.0.1:${port}/mcp`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 5_000).unref();
    });
    for (const forbidden of forbiddenOutput) {
      assert.equal(stderr.includes(forbidden), false, "server diagnostics exposed a synthetic config sentinel");
    }
  }
}

const fixture = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-push-transport-"));
const goodRoot = path.join(fixture, "good.git");
const evilRoot = path.join(fixture, "evil.git");
const raceGoodRoot = path.join(fixture, "race-good.git");
const raceEvilRoot = path.join(fixture, "race-evil.git");
const seedRoot = path.join(fixture, "seed");
const evilSeedRoot = path.join(fixture, "evil-seed");
const raceTargetRoot = path.join(fixture, "race-target");
const raceHome = path.join(fixture, CONFIG_PATH_SENTINEL);
const raceInclude = path.join(raceHome, "include-" + CONFIG_PATH_SENTINEL + ".conf");
const raceWriterFired = path.join(fixture, "config-source-race-result");
const targetRoot = path.join(fixture, "target");
const receivePackPath = path.join(fixture, "sentinel-receive-pack");
const receivePackFired = path.join(fixture, "receive-pack-fired");
const configRaceFired = path.join(fixture, "config-race-result");
let daemon;
let session;

try {
  await writeFile(receivePackPath, `#!/bin/sh\nprintf '%s\\n' '${RECEIVEPACK_SENTINEL}' > '${receivePackFired}'\nexit 99\n`, "utf8");
  await chmod(receivePackPath, 0o755);
  await mkdir(goodRoot, { recursive: true });
  await mkdir(evilRoot, { recursive: true });
  await mkdir(raceGoodRoot, { recursive: true });
  await mkdir(raceEvilRoot, { recursive: true });
  await mkdir(seedRoot, { recursive: true });
  await mkdir(evilSeedRoot, { recursive: true });
  initRepo(seedRoot, "Good Seed");
  await writeFile(path.join(seedRoot, "notes.txt"), "R0\n", "utf8");
  const r0 = commit(seedRoot, "R0");
  initRepo(evilSeedRoot, "Evil Seed");
  await writeFile(path.join(evilSeedRoot, "notes.txt"), "E0\n", "utf8");
  const e0 = commit(evilSeedRoot, "E0");

  git(goodRoot, ["init", "--bare", "--quiet"]);
  git(evilRoot, ["init", "--bare", "--quiet"]);
  git(raceGoodRoot, ["init", "--bare", "--quiet"]);
  git(raceEvilRoot, ["init", "--bare", "--quiet"]);
  git(seedRoot, ["push", "--quiet", goodRoot, `${r0}:${REF}`]);
  git(evilSeedRoot, ["push", "--quiet", evilRoot, `${e0}:${REF}`]);
  git(seedRoot, ["push", "--quiet", raceGoodRoot, `${r0}:${REF}`]);
  git(seedRoot, ["push", "--quiet", raceEvilRoot, `${r0}:${REF}`]);
  git(goodRoot, ["symbolic-ref", "HEAD", REF]);
  git(evilRoot, ["symbolic-ref", "HEAD", REF]);
  git(raceGoodRoot, ["symbolic-ref", "HEAD", REF]);
  git(raceEvilRoot, ["symbolic-ref", "HEAD", REF]);

  const port = await freePort();
  const goodEndpoint = `git://127.0.0.1:${port}/good.git`;
  const evilEndpoint = `git://127.0.0.1:${port}/evil.git`;
  daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", "--enable=receive-pack", "--verbose", `--base-path=${fixture}`, `--port=${port}`], {
    cwd: fixture,
    stdio: ["ignore", "ignore", "ignore"]
  });
  await waitForDaemon(goodEndpoint, daemon);
  git(REPO_ROOT, ["clone", "--quiet", goodEndpoint, targetRoot]);
  git(targetRoot, ["config", "user.name", "Transport Target"]);
  git(targetRoot, ["config", "user.email", "transport-target@example.test"]);
  git(targetRoot, ["remote", "set-url", "origin", "ALIAS:"]);
  git(targetRoot, ["config", `url.${goodEndpoint}.insteadOf`, "ALIAS:"]);
  git(targetRoot, ["config", `url.${evilEndpoint}.insteadOf`, goodEndpoint]);
  await writeFile(path.join(targetRoot, "notes.txt"), "R0\nL1\n", "utf8");
  const l1 = commit(targetRoot, "L1");
  const targetCanonical = targetRoot;
  const targetWorkspaceId = workspaceId(targetCanonical);
  const policy = { enabled: true, rules: [{ remote: "origin", endpoint: goodEndpoint, branches: [BRANCH] }] };
  const request = {
    workspace_id: targetWorkspaceId,
    remote: "origin",
    branch: BRANCH,
    expected_local_head: l1,
    expected_remote_head: r0
  };

  assert.ok(GIT_PUSH_FIXED_OPTIONS.includes("--receive-pack=git-receive-pack"), "fixed default receive-pack control is missing");
  const returnedGood = gitText(targetRoot, ["remote", "get-url", "--push", "--all", "origin"]);
  assert.equal(returnedGood, goodEndpoint, "named remote did not resolve to the authorized GOOD endpoint");
  assert.equal(remoteHead(targetRoot, "origin"), r0, "named remote preflight route did not reach GOOD");
  assert.equal(remoteHead(targetRoot, returnedGood), e0, "a returned GOOD URL did not demonstrate the chained EVIL rewrite");
  assert.equal(head(goodRoot), r0, "GOOD did not start at R0");
  assert.equal(head(evilRoot), e0, "EVIL did not start at its distinct E0");
  console.log("RAW_OBSERVATION: named origin resolves and observes GOOD at R0; passing that returned URL as a fresh Git repository argument observes distinct EVIL at E0.");
  console.log("SANITY_VERDICT: MATCH — independent loopback refs establish the chained-rewrite route split before mutation.");
  console.log("PREDICATE: TRUE — GOOD/EVIL are distinct physical bare remotes, and the named route is independently observed at the expected old head.");

  git(targetRoot, ["config", "remote.origin.receivepack", receivePackPath]);
  await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [path.dirname(targetCanonical)], policy }, async (url) => {
    session = await connect(url);
    expectSuccess(await call(session, "open_current_workspace", {}), "open transport target workspace");
    const receivePackError = expectError(await call(session, "git_push", request), "non-default receive-pack rejection");
    assert.match(resultText(receivePackError), /default/u, "receive-pack rejection lacked bounded default-control truth");
    assertSafe(receivePackError, "receive-pack error", [goodEndpoint, evilEndpoint, receivePackPath]);
    await close(session);
    session = undefined;
  });
  assert.equal((await readFile(receivePackFired).catch(() => null)), null, "configured sentinel receive-pack executed");
  assert.equal(head(goodRoot), r0, "receive-pack rejection mutated GOOD");
  assert.equal(head(evilRoot), e0, "receive-pack rejection mutated EVIL");
  console.log("RAW_OBSERVATION: configured sentinel receive-pack was rejected before network mutation; GOOD remained R0 and EVIL remained E0.");
  console.log("SANITY_VERDICT: MATCH — direct bare-repository refs and absent sentinel establish fail-closed receive-pack policy.");

  git(targetRoot, ["config", "--unset-all", "remote.origin.receivepack"]);
  const hookPath = path.join(targetRoot, ".git", "hooks", "pre-push");
  await writeFile(hookPath, `#!/bin/sh\nset -eu\nif git config remote.origin.pushurl '${evilEndpoint}'; then\n  printf '%s\\n' 'writer-succeeded' > '${configRaceFired}'\n  exit 1\nfi\nprintf '%s\\n' 'writer-failed' > '${configRaceFired}'\nexit 0\n`, "utf8");
  await chmod(hookPath, 0o755);

  await withHttpServer({ defaultRoot: targetCanonical, allowedRoots: [path.dirname(targetCanonical)], policy }, async (url) => {
    session = await connect(url);
    expectSuccess(await call(session, "open_current_workspace", {}), "reopen transport target workspace");
    const success = expectSuccess(await call(session, "git_push", request), "named-remote chained-route push");
    assert.deepEqual(success.structuredContent, {
      codexpro_tool: "git_push",
      codexpro_title: "Git Push",
      schema_version: 1,
      workspace_id: targetWorkspaceId,
      root: targetCanonical,
      remote: "origin",
      branch: BRANCH,
      destination_ref: REF,
      source_head: l1,
      expected_remote_head: r0,
      remote_head: l1,
      push_attempts: 1
    });
    assertSafe(success, "successful transport result", [goodEndpoint, evilEndpoint, receivePackPath]);
    await close(session);
    session = undefined;
  });

  assert.equal((await readFile(configRaceFired, "utf8")).trim(), "writer-failed", "ordinary git config writer did not fail inside the protected window");
  assert.equal(head(goodRoot), l1, "named-remote push did not update GOOD to L1");
  assert.equal(head(evilRoot), e0, "named-remote push incorrectly mutated EVIL");
  assert.equal(remoteHead(targetRoot, "origin"), l1, "post-observation named route did not reach GOOD");
  assert.equal(gitText(targetRoot, ["rev-parse", `refs/remotes/origin/${BRANCH}`]), l1, "native named-remote tracking ref was not preserved");
  assert.equal(refs(goodRoot), `refs/heads/${BRANCH}=${l1}`, "GOOD acquired an unrelated ref");
  assert.equal(refs(evilRoot), `refs/heads/${BRANCH}=${e0}`, "EVIL acquired an unrelated ref");
  assert.equal(gitResult(targetRoot, ["config", "--local", "--get", "remote.origin.pushurl"]).status, 1, "config race writer changed pushurl despite lock");
  assert.equal(gitText(targetRoot, ["remote", "get-url", "--push", "--all", "origin"]), goodEndpoint, "cooperative config race changed the authorized endpoint");
  assert.equal((await readFile(path.join(targetRoot, ".git", "config.lock")).catch(() => null)), null, "Git push config lock was left behind");
  console.log("RAW_OBSERVATION: one named-remote push changed GOOD R0->L1; EVIL stayed E0; post-observation and native refs/remotes/origin/main report L1; the cooperative git config writer recorded writer-failed and pushurl stayed absent.");
  console.log("SANITY_VERDICT: MATCH — physical GOOD/EVIL refs, tracking ref, config, and hook sentinel establish one route across preflight, push, and post-observation.");
  console.log("CONFIG_RACE: PASS — native config.lock protected final validation, named-remote mutation, and post-observation; raw same-UID pathname replacement remains outside this cooperative boundary.");
  console.log("RECEIVEPACK: PASS — configured non-default receive-pack was rejected; fixed git-receive-pack preserved ordinary loopback push behavior.");

  // Exercise the complete cooperative source set: a writable global file and
  // an active included file are both locked while the named-remote hook tries
  // to redirect GOOD to a distinct EVIL endpoint through ordinary git config.
  await mkdir(raceHome, { recursive: true });
  await writeFile(raceInclude, `[codexpro.synthetic]\n\tvalue = ${CONFIG_VALUE_SENTINEL}\n\tcredential = ${CONFIG_CREDENTIAL_SENTINEL}\n`, "utf8");
  const raceGlobal = path.join(raceHome, ".gitconfig");
  const raceGoodEndpoint = `git://127.0.0.1:${port}/race-good.git`;
  const raceEvilEndpoint = `git://127.0.0.1:${port}/race-evil.git`;
  git(REPO_ROOT, ["clone", "--quiet", raceGoodEndpoint, raceTargetRoot]);
  git(raceTargetRoot, ["config", "user.name", "Config Source Race Target"]);
  git(raceTargetRoot, ["config", "user.email", "config-source-race@example.test"]);
  git(raceTargetRoot, ["config", "--local", "include.path", raceInclude]);
  await writeFile(path.join(raceTargetRoot, "notes.txt"), "R0\nL1\n", "utf8");
  const raceLocalHead = commit(raceTargetRoot, "L1");
  const raceWorkspaceId = workspaceId(raceTargetRoot);
  const racePolicy = { enabled: true, rules: [{ remote: "origin", endpoint: raceGoodEndpoint, branches: [BRANCH] }] };
  const raceRequest = {
    workspace_id: raceWorkspaceId,
    remote: "origin",
    branch: BRANCH,
    expected_local_head: raceLocalHead,
    expected_remote_head: r0
  };
  const raceLocalConfig = path.join(raceTargetRoot, ".git", "config");
  const raceLocalConfigBefore = await readFile(raceLocalConfig);
  const raceIncludeBefore = await readFile(raceInclude);
  const raceHookPath = path.join(raceTargetRoot, ".git", "hooks", "pre-push");
  const raceHook = [
    "#!/bin/sh",
    "set +e",
    `git config --global url.${raceEvilEndpoint}.insteadOf ${raceGoodEndpoint}`,
    "global_status=$?",
    `git config --file '${raceInclude}' url.${raceEvilEndpoint}.insteadOf ${raceGoodEndpoint}`,
    "include_status=$?",
    `printf 'global=%s include=%s %s\\n' \"$global_status\" \"$include_status\" '${CONFIG_RACE_SENTINEL}' > '${raceWriterFired}'`,
    "exit 0",
    ""
  ].join("\n");
  await writeFile(raceHookPath, raceHook, "utf8");
  await chmod(raceHookPath, 0o755);

  await withHttpServer({
    defaultRoot: raceTargetRoot,
    allowedRoots: [path.dirname(raceTargetRoot)],
    policy: racePolicy,
    environment: {
      HOME: raceHome,
      XDG_CONFIG_HOME: path.join(fixture, "race-xdg")
    },
    forbiddenOutput: [CONFIG_PATH_SENTINEL, CONFIG_VALUE_SENTINEL, CONFIG_CREDENTIAL_SENTINEL]
  }, async (url) => {
    session = await connect(url);
    expectSuccess(await call(session, "open_current_workspace", {}), "open config-source race workspace");
    const success = expectSuccess(await call(session, "git_push", raceRequest), "global-and-include config-source race push");
    assertSafe(success, "config-source race result", [raceGoodEndpoint, raceEvilEndpoint, raceHome, raceInclude, CONFIG_PATH_SENTINEL, CONFIG_VALUE_SENTINEL, CONFIG_CREDENTIAL_SENTINEL]);
    await close(session);
    session = undefined;
  });

  assert.match((await readFile(raceWriterFired, "utf8")).trim(), new RegExp(`^global=[1-9][0-9]* include=[1-9][0-9]* ${CONFIG_RACE_SENTINEL}$`), "ordinary global/include writers did not fail under their native locks");
  assert.equal(head(raceGoodRoot), raceLocalHead, "global/include race changed GOOD unexpectedly");
  assert.equal(head(raceEvilRoot), r0, "global/include race redirected the push to EVIL");
  assert.equal(remoteHead(raceTargetRoot, "origin"), raceLocalHead, "post-observation route did not remain on GOOD");
  assert.equal(gitText(raceTargetRoot, ["rev-parse", `refs/remotes/origin/${BRANCH}`]), raceLocalHead, "native named-remote tracking ref was not preserved in source-set race");
  assert.equal(await readFile(raceGlobal).catch(() => null), null, "global config writer created the protected absent target");
  assert.equal((await readFile(raceLocalConfig)).equals(raceLocalConfigBefore), true, "source-set race changed the repository config");
  assert.equal((await readFile(raceInclude)).equals(raceIncludeBefore), true, "active include writer changed the protected source");
  assert.equal(refs(raceGoodRoot), `refs/heads/${BRANCH}=${raceLocalHead}`, "GOOD acquired an unrelated ref in source-set race");
  assert.equal(refs(raceEvilRoot), `refs/heads/${BRANCH}=${r0}`, "EVIL acquired an unrelated ref in source-set race");
  for (const lockPath of [
    path.join(raceTargetRoot, ".git", "config.lock"),
    `${raceGlobal}.lock`,
    `${raceInclude}.lock`
  ]) {
    assert.equal(await readFile(lockPath).catch(() => null), null, "config-source lock residue remained after push");
  }
  console.log("RAW_OBSERVATION: with GOOD and EVIL both physically at R0, synchronized ordinary git config --global (absent target) and --file(active-include) writers recorded nonzero status; GOOD alone advanced to L1, EVIL remained R0, tracking remained L1, repository/include config stayed byte-identical, the global target stayed absent, and all three lock paths were absent.");
  console.log("SANITY_VERDICT: MATCH — direct loopback refs, source bytes, writer statuses, tracking ref, and lock census establish the complete cooperative source-set boundary.");
  console.log("CONFIG_SOURCE_RACE: PASS — repository, global, and active-include native config locks covered final validation, named-remote push, hook, route recheck, and post-observation; raw same-UID pathname replacement remains outside the cooperative boundary.");
  console.log("GIT_PUSH_TRANSPORT_REPAIR_SMOKE: PASS");
} finally {
  await close(session);
  if (daemon && daemon.exitCode === null) daemon.kill("SIGTERM");
  await rm(fixture, { recursive: true, force: true });
}
