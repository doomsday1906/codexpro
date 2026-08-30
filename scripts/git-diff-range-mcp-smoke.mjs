import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

// This proof owns only disposable test fixtures and public-behavior assertions.
// The accepted outcome is MISSION_ANCHOR A001 LAW-001/LAW-016/LAW-017 and
// MISSION_PLAN P001 TASK-005 AP-009/AP-010. The raw Git producer is consulted
// before any MCP result is interpreted; the redaction-policy module is a
// supporting oracle for expected public patch bytes, not target evidence.
const DEFAULT_SENTINEL = "DEFAULT_MCP_RANGE_SENTINEL_7X9";
const TARGET_SENTINEL = "TARGET_MCP_RANGE_SENTINEL_7X9";
const ADD_SECRET = "ACTUAL_LITERAL_SECRET_7X9";
const DELETE_SECRET = "DELETED_LITERAL_SECRET_8Y4";
const CONTEXT_SECRET = "CONTEXT_LITERAL_SECRET_9Z5";
const HOSTILE_KEY = "OPENAI_API_KEY_UNKNOWN_PROPERTY_7X9";
const HOSTILE_VALUE = "sk-hostile-mcp-envelope-secret-7X9";

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-git-diff-range-mcp-"));
const defaultRoot = path.join(fixtureRoot, "default-repo");
const targetParent = path.join(fixtureRoot, "allowed-parent");
const targetRoot = path.join(targetParent, "nested-target-repo");

function gitEnv() {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true"
  };
  for (const key of [
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_ATTR_SOURCE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_NO_LAZY_FETCH"
  ]) delete env[key];
  return env;
}

function directGit(root, args, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    env: gitEnv(),
    input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(root, args, input) {
  const result = directGit(root, args, input);
  assert.equal(result.error, undefined, `fixture Git failed to start: git ${args.join(" ")}`);
  assert.equal(result.status, 0, `fixture Git failed: git ${args.join(" ")}\n${result.stderr.toString("utf8")}`);
  return result.stdout;
}

function gitText(root, args) {
  return mustGit(root, args).toString("utf8").trim();
}

async function initRepo(root) {
  await mkdir(root, { recursive: true });
  mustGit(root, ["init", "--quiet"]);
  mustGit(root, ["config", "user.name", "MCP Historical Range Smoke"]);
  mustGit(root, ["config", "user.email", "mcp-historical-range-smoke@example.invalid"]);
  mustGit(root, ["config", "core.logAllRefUpdates", "true"]);
}

async function commitAll(root, subject) {
  mustGit(root, ["add", "--all"]);
  mustGit(root, ["commit", "--quiet", "-m", subject]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function directRangePatch(root, baseRef, headRef) {
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--patch",
    "-U3",
    "--find-renames=50%",
    "--find-copies=50%",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    baseRef,
    headRef,
    "--",
    ":(literal)target-range.txt"
  ];
  return directGit(root, args);
}

async function fileDigest(filePath) {
  try {
    const bytes = await readFile(filePath);
    return { exists: true, bytes: bytes.length, sha256: await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest("hex")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function repositorySnapshot(root) {
  const commandArgs = {
    head: ["rev-parse", "--verify", "HEAD"],
    branch: ["symbolic-ref", "--short", "-q", "HEAD"],
    refs: ["for-each-ref", "--format=%(refname)%00%(objectname)%00"],
    reflogs: ["reflog", "show", "--all", "--format=%H%x00%gD%x00%gs%x00"],
    index: ["ls-files", "--stage", "-z"],
    staged: ["diff", "--cached", "--binary", "--no-ext-diff"],
    unstaged: ["diff", "--binary", "--no-ext-diff"],
    untracked: ["ls-files", "--others", "--exclude-standard", "-z"],
    status: ["status", "--porcelain=v1", "-z"],
    config: ["config", "--local", "--null", "--list"],
    remotes: ["remote", "-v"],
    worktrees: ["worktree", "list", "--porcelain"]
  };
  const commands = {};
  for (const [name, args] of Object.entries(commandArgs)) {
    const result = directGit(root, args);
    assert.equal(result.error, undefined, `snapshot Git failed to start for ${name}`);
    assert.equal(result.status, 0, `snapshot Git failed for ${name}`);
    commands[name] = { stdout: result.stdout.toString("base64"), stderr: result.stderr.toString("base64") };
  }
  return {
    commands,
    files: {
      "target-range.txt": await fileDigest(path.join(root, "target-range.txt")),
      ".git/index": await fileDigest(path.join(root, ".git", "index")),
      ".git/HEAD": await fileDigest(path.join(root, ".git", "HEAD"))
    }
  };
}

function resolveSchema(root, schema) {
  let current = schema;
  const seen = new Set();
  while (current?.$ref) {
    assert.equal(typeof current.$ref, "string");
    assert.ok(current.$ref.startsWith("#/"), `unsupported schema reference ${current.$ref}`);
    assert.equal(seen.has(current.$ref), false, `cyclic schema reference ${current.$ref}`);
    seen.add(current.$ref);
    current = current.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  return current;
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function valuesAtPaths(value, wanted, pathParts = []) {
  const found = [];
  if (wanted(value, pathParts)) found.push({ path: pathParts, value });
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      value.forEach((item, index) => found.push(...valuesAtPaths(item, wanted, [...pathParts, index])));
    } else {
      for (const [key, item] of Object.entries(value)) found.push(...valuesAtPaths(item, wanted, [...pathParts, key]));
    }
  }
  return found;
}

function assertNoLiterals(value, literals, label) {
  const text = serialized(value);
  for (const literal of literals) assert.equal(text.includes(literal), false, `${label} leaked ${literal}`);
}

function assertNoHostileResponse(call, label) {
  const response = call.response;
  assert.equal(call.raw.includes(HOSTILE_KEY), false, `${label} response JSON echoed hostile property name`);
  assert.equal(call.raw.includes(HOSTILE_VALUE), false, `${label} response JSON echoed hostile property value`);
  assertNoLiterals(response?.result?.content, [HOSTILE_KEY, HOSTILE_VALUE], `${label} content`);
  assertNoLiterals(response?.result?.structuredContent, [HOSTILE_KEY, HOSTILE_VALUE], `${label} structuredContent`);
  assertNoLiterals(response?.result?._meta, [HOSTILE_KEY, HOSTILE_VALUE], `${label} _meta`);
  assertNoLiterals(response?.error?.message, [HOSTILE_KEY, HOSTILE_VALUE], `${label} protocol error.message`);
  assertNoLiterals(response?.error?.data, [HOSTILE_KEY, HOSTILE_VALUE], `${label} protocol error.data`);
}

class RawStdioClient {
  constructor(defaultWorkspaceRoot, allowedTargetRoot, mode) {
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    const allowedRoots = [defaultWorkspaceRoot, path.dirname(allowedTargetRoot), allowedTargetRoot].join(path.delimiter);
    this.child = spawn(process.execPath, [
      "dist/stdio.js",
      "--root", defaultWorkspaceRoot,
      "--allow-root", path.dirname(allowedTargetRoot),
      "--allow-root", allowedTargetRoot,
      "--bash", "off",
      "--write", "off",
      "--tool-mode", mode
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        CODEXPRO_ROOT: defaultWorkspaceRoot,
        CODEXPRO_ALLOWED_ROOTS: allowedRoots,
        CODEXPRO_TOOL_CARDS: "0",
        CODEXPRO_CODEX_SESSIONS: "off",
        CODEXPRO_BASH_MODE: "off",
        CODEXPRO_WRITE_MODE: "off"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`MCP server exited code=${code} signal=${signal}; stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw.trim()) continue;
      let response;
      try {
        response = JSON.parse(raw);
      } catch (error) {
        for (const { reject, timer } of this.pending.values()) {
          clearTimeout(timer);
          reject(new Error(`invalid JSON-RPC response: ${error instanceof Error ? error.message : String(error)}`));
        }
        this.pending.clear();
        continue;
      }
      if (!response.id || !this.pending.has(response.id)) continue;
      const { resolve, timer } = this.pending.get(response.id);
      clearTimeout(timer);
      this.pending.delete(response.id);
      resolve({ response, raw });
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`)), 15_000);
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
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}

async function startClient(defaultWorkspaceRoot, mode) {
  const client = new RawStdioClient(defaultWorkspaceRoot, targetRoot, mode);
  const initialize = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "git-diff-range-mcp-smoke", version: "1.0.0" }
  });
  client.notify("notifications/initialized");
  return { client, initialize };
}

async function callTool(client, name, args) {
  return client.request("tools/call", { name, arguments: args });
}

function successResult(call, label) {
  assert.equal(call.response?.error, undefined, `${label} returned protocol error: ${serialized(call.response?.error)}`);
  assert.ok(call.response?.result, `${label} omitted JSON-RPC result`);
  assert.notEqual(call.response.result.isError, true, `${label} returned tool error: ${serialized(call.response.result)}`);
  assert.ok(Array.isArray(call.response.result.content), `${label} omitted content`);
  assert.ok(call.response.result.structuredContent && typeof call.response.result.structuredContent === "object", `${label} omitted structuredContent`);
  return call.response.result;
}

function errorResult(call, label) {
  assert.equal(call.response?.error, undefined, `${label} unexpectedly returned protocol error: ${serialized(call.response?.error)}`);
  assert.ok(call.response?.result, `${label} omitted JSON-RPC result`);
  assert.equal(call.response.result.isError, true, `${label} unexpectedly succeeded: ${serialized(call.response.result)}`);
  return call.response.result;
}

async function main() {
  let firstClient;
  let secondClient;
  const defaultRootB = path.join(fixtureRoot, "default-repo-b");
  try {
    await initRepo(defaultRoot);
    await initRepo(defaultRootB);
    await initRepo(targetRoot);

    await writeFile(path.join(defaultRoot, "default.txt"), `${DEFAULT_SENTINEL} base\n`, "utf8");
    const defaultBaseSha = await commitAll(defaultRoot, "default range base");
    await writeFile(path.join(defaultRoot, "default.txt"), `${DEFAULT_SENTINEL} head\n`, "utf8");
    const defaultHeadSha = await commitAll(defaultRoot, "default range head");

    await writeFile(path.join(defaultRootB, "default-b.txt"), `${DEFAULT_SENTINEL} B base\n`, "utf8");
    const defaultBBaseSha = await commitAll(defaultRootB, "default B range base");
    await writeFile(path.join(defaultRootB, "default-b.txt"), `${DEFAULT_SENTINEL} B head\n`, "utf8");
    const defaultBHeadSha = await commitAll(defaultRootB, "default B range head");

    const baseText = [
      "target anchor line",
      `DELETE_TOKEN = "${DELETE_SECRET}"`,
      `password = "${CONTEXT_SECRET}"`,
      "target trailing line",
      ""
    ].join("\n");
    const headText = [
      "target anchor line",
      `ADD_TOKEN = "${ADD_SECRET}"`,
      `password = "${CONTEXT_SECRET}"`,
      `target sentinel = "${TARGET_SENTINEL}"`,
      "target trailing line",
      ""
    ].join("\n");
    await writeFile(path.join(targetRoot, "target-range.txt"), baseText, "utf8");
    const targetBaseSha = await commitAll(targetRoot, "target range base");
    await writeFile(path.join(targetRoot, "target-range.txt"), headText, "utf8");
    const targetHeadSha = await commitAll(targetRoot, "target range head");

    const targetCanonicalRoot = await realpath(targetRoot);
    const defaultBCanonicalRoot = await realpath(defaultRootB);
    const targetObjectFormat = gitText(targetRoot, ["rev-parse", "--show-object-format"]);
    const directTargetName = directGit(targetRoot, [
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--find-copies=50%", "-z", "--name-status", "HEAD~1", "HEAD", "--", ":(literal)target-range.txt"
    ]);
    const directTargetNumstat = directGit(targetRoot, [
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--find-copies=50%", "-z", "--numstat", "HEAD~1", "HEAD", "--", ":(literal)target-range.txt"
    ]);
    const directPatch = directRangePatch(targetRoot, "HEAD~1", "HEAD");
    assert.equal(directTargetName.status, 0, "direct target name-status producer failed");
    assert.equal(directTargetNumstat.status, 0, "direct target numstat producer failed");
    assert.equal(directPatch.status, 0, "direct target patch producer failed");
    const directNameBytes = directTargetName.stdout;
    const directNumstatText = directTargetNumstat.stdout.toString("utf8");
    const directPatchText = directPatch.stdout.toString("utf8");
    assert.equal(directNameBytes.toString("utf8"), "M\0target-range.txt\0", "direct name-status did not yield one exact target record");
    const numstatMatch = /^(\d+)\t(\d+)\ttarget-range\.txt\0$/u.exec(directNumstatText);
    assert.ok(numstatMatch, `direct numstat did not yield one exact target record: ${JSON.stringify(directNumstatText)}`);
    assert.ok(directPatchText.startsWith("diff --git a/target-range.txt b/target-range.txt\n"), "direct patch lacked target header");
    assert.equal(directPatchText.includes(ADD_SECRET), true, "direct raw target patch lacked addition secret");
    assert.equal(directPatchText.includes(DELETE_SECRET), true, "direct raw target patch lacked deletion secret");
    assert.equal(directPatchText.includes(CONTEXT_SECRET), true, "direct raw target patch lacked context secret");
    assert.equal(directPatchText.includes(TARGET_SENTINEL), true, "direct raw target patch lacked target sentinel");
    assert.equal(directPatchText.includes(DEFAULT_SENTINEL), false, "direct raw target patch contained default sentinel");
    const { redactUnifiedDiff } = await import("./redaction-policy.mjs");
    const expectedRedactedPatch = redactUnifiedDiff(directPatchText);
    assert.equal(expectedRedactedPatch.includes(ADD_SECRET), false, "supporting redaction oracle retained addition secret");
    assert.equal(expectedRedactedPatch.includes(DELETE_SECRET), false, "supporting redaction oracle retained deletion secret");
    assert.equal(expectedRedactedPatch.includes(CONTEXT_SECRET), false, "supporting redaction oracle retained context secret");

    // PASS 1: exact authority and raw observable facts precede MCP results.
    console.log("AUTHORITY: MISSION_ANCHOR.md A001 LAW-001/L AW-016/L AW-017 and AC-007/AC-009; MISSION_PLAN.md P001 TASK-005 AP-009/AP-010.");
    console.log("EXPECTED_RESULT_AUTHORITY: the accepted public contract above; scripts/redaction-policy.mjs is SUPPORTING_ORACLE only for deterministic redacted patch bytes.");
    console.log(`TARGET_PRODUCER: direct local Git object database in nested target ${targetCanonicalRoot}; MCP route is disposable stdio only, with no TCP/8787 or production process access.`);
    console.log(`RAW_OBSERVATION: default-B HEAD=${defaultBHeadSha} (base=${defaultBBaseSha}) differs from target HEAD=${targetHeadSha} (base=${targetBaseSha}); target object format=${targetObjectFormat}.`);
    console.log(`RAW_OBSERVATION: direct target name-status=M target-range.txt; numstat additions=${numstatMatch[1]} deletions=${numstatMatch[2]}; raw patch bytes=${directPatch.stdout.byteLength}, with distinct target sentinel and secret-bearing addition/deletion/context lines.`);
    console.log("TARGET_EVIDENCE: direct Git name-status/numstat/patch bytes and commit identities. SUPPORTING_ORACLE: accepted redaction-policy implementation computes expected public patch bytes.");
    console.log("SANITY_VERDICT: MATCH — raw target and default facts provide a direct workspace distinction and a secret-bearing patch whose expected public form is bounded and redacted.");
    console.log("PREDICATE: TRUE — direct target HEAD~1 and HEAD resolve to the recorded target base/head SHAs, and the target patch producer independently contains the required changed-file/sentinel facts.");

    // Session A opens the nested target and then ends. Only its explicit ID is
    // carried into the fresh B session.
    ({ client: firstClient } = await startClient(defaultRoot, "full"));
    const opened = await callTool(firstClient, "open_workspace", { path: targetRoot, include_tree: false });
    const openedResult = successResult(opened, "session A open_workspace");
    const openedData = openedResult.structuredContent;
    const workspaceId = openedData.workspace_id;
    assert.match(workspaceId, /^ws_[a-f0-9]{24}$/u, "open_workspace did not return a deterministic workspace ID");
    assert.equal(openedData.root, targetCanonicalRoot, "session A opened the wrong root");
    await firstClient.close();
    firstClient = undefined;
    console.log(`PASS session A: nested target opened and saved explicit workspace_id ${workspaceId}; client/server ended before fresh session B.`);

    // AP-009: full publication and standard/minimal omission.
    for (const mode of ["standard", "minimal"]) {
      const session = await startClient(defaultRootB, mode);
      try {
        const listing = await session.client.request("tools/list", {});
        const names = (listing.response.result?.tools ?? []).map((tool) => tool.name);
        assert.equal(names.includes("git_diff_range"), false, `${mode} tools/list exposed full-only git_diff_range`);
      } finally {
        await session.client.close();
      }
    }
    secondClient = (await startClient(defaultRootB, "full")).client;
    const fullListingCall = await secondClient.request("tools/list", {});
    const fullTools = fullListingCall.response.result?.tools ?? [];
    const rangeTools = fullTools.filter((tool) => tool.name === "git_diff_range");
    assert.equal(rangeTools.length, 1, `full tools/list exposed git_diff_range ${rangeTools.length} times`);
    const rangeTool = rangeTools[0];
    const schema = resolveSchema(rangeTool.inputSchema, rangeTool.inputSchema);
    assert.equal(schema.type, "object", "git_diff_range schema is not an object");
    assert.equal(schema.additionalProperties, false, "git_diff_range schema allows unknown properties");
    assert.deepEqual([...schema.required].sort(), ["base_ref", "head_ref", "workspace_id"], "git_diff_range required fields drifted");
    assert.deepEqual(Object.keys(schema.properties).sort(), ["base_ref", "context_lines", "head_ref", "include_patch", "max_files", "max_patch_bytes", "path", "workspace_id"], "git_diff_range property set drifted");
    const property = (name) => resolveSchema(schema, schema.properties[name]);
    assert.equal(property("workspace_id").type, "string");
    assert.equal(property("base_ref").type, "string");
    assert.equal(property("head_ref").type, "string");
    assert.equal(property("path").type, "string");
    assert.equal(property("include_patch").type, "boolean");
    assert.equal(property("include_patch").default, true);
    assert.equal(property("max_files").type, "integer");
    assert.equal(property("max_files").minimum, 1);
    assert.equal(property("max_files").maximum, 200);
    assert.equal(property("max_files").default, 100);
    assert.equal(property("max_patch_bytes").type, "integer");
    assert.equal(property("max_patch_bytes").minimum, 0);
    assert.equal(property("max_patch_bytes").maximum, 100_000);
    assert.equal(property("max_patch_bytes").default, 60_000);
    assert.equal(property("context_lines").type, "integer");
    assert.equal(property("context_lines").minimum, 0);
    assert.equal(property("context_lines").maximum, 20);
    assert.equal(property("context_lines").default, 3);
    assert.equal(rangeTool.annotations?.readOnlyHint, true);
    assert.equal(rangeTool.annotations?.destructiveHint, false);
    assert.equal(rangeTool.annotations?.openWorldHint, false);
    assert.equal(rangeTool._meta?.ui, undefined, "git_diff_range published tool card ui metadata");
    assert.equal(rangeTool._meta?.["openai/outputTemplate"], undefined, "git_diff_range published output template");
    console.log("PASS AP-009: full tools/list exposes exactly one git_diff_range; strict schema bounds/defaults, annotations, and no-card metadata match the accepted contract; standard/minimal omit it.");

    // The snapshot starts after session selection and before any target calls.
    const before = await repositorySnapshot(targetRoot);
    const explicitCall = await callTool(secondClient, "git_diff_range", { workspace_id: workspaceId, base_ref: "HEAD~1", head_ref: "HEAD" });
    const explicitResult = successResult(explicitCall, "fresh-session explicit git_diff_range");
    const structured = explicitResult.structuredContent;
    const businessKeys = [
      "base_commit_sha", "base_ref_input", "blocked_files_omitted", "changed_file_count", "changed_files", "changed_files_truncated", "comparison_mode", "eligible_changed_file_count", "head_commit_sha", "head_ref_input", "object_format", "patch", "patch_bytes", "patch_files_included", "patch_files_omitted", "patch_included", "patch_limit", "patch_omission_counts", "patch_requested", "patch_truncated", "returned_file_count", "root", "schema_version", "warnings", "workspace_id"
    ];
    assert.deepEqual(Object.keys(structured).sort(), ["codexpro_title", "codexpro_tool", ...businessKeys].sort(), "git_diff_range structured contract key set drifted");
    assert.equal(structured.codexpro_tool, "git_diff_range");
    assert.equal(structured.schema_version, 1);
    assert.equal(structured.workspace_id, workspaceId);
    assert.equal(structured.root, targetCanonicalRoot);
    assert.equal(structured.comparison_mode, "direct-two-tree");
    assert.equal(structured.object_format, targetObjectFormat);
    assert.equal(structured.base_ref_input, "HEAD~1");
    assert.equal(structured.base_commit_sha, targetBaseSha);
    assert.equal(structured.head_ref_input, "HEAD");
    assert.equal(structured.head_commit_sha, targetHeadSha);
    assert.equal(structured.changed_file_count, 1);
    assert.equal(structured.eligible_changed_file_count, 1);
    assert.equal(structured.returned_file_count, 1);
    assert.equal(structured.changed_files_truncated, false);
    assert.equal(structured.blocked_files_omitted, 0);
    assert.deepEqual(structured.changed_files, [{ status: "M", old_path: "target-range.txt", new_path: "target-range.txt", similarity: null, additions: Number(numstatMatch[1]), deletions: Number(numstatMatch[2]), binary: false }]);
    assert.equal(structured.patch, expectedRedactedPatch);
    assert.equal(structured.patch_requested, true);
    assert.equal(structured.patch_included, true);
    assert.equal(structured.patch_truncated, false);
    assert.equal(structured.patch_bytes, Buffer.byteLength(expectedRedactedPatch, "utf8"));
    assert.equal(structured.patch_limit, 60_000);
    assert.equal(structured.patch_files_included, 1);
    assert.equal(structured.patch_files_omitted, 0);
    assert.deepEqual(structured.patch_omission_counts, { binary: 0, blocked: 0, budget: 0, disabled: 0, file_limit: 0, too_large: 0 });
    assert.deepEqual(structured.warnings, []);
    assert.equal(Object.hasOwn(structured, "path"), false);
    assert.equal(explicitResult._meta?.ui, undefined);
    assert.equal(explicitResult._meta?.["openai/outputTemplate"], undefined);

    // Patch identity is checked by exact object path, not by naive substring
    // counting of repeated diff fragments.
    const patchLocations = valuesAtPaths(explicitResult, (value, pathParts) => value === expectedRedactedPatch).map(({ path: pathParts }) => pathParts.join("."));
    assert.deepEqual(patchLocations, ["structuredContent.patch"], "patch appeared at an unexpected envelope location or more than once");
    assert.equal((explicitCall.raw.match(/"patch":/gu) ?? []).length, 1, "complete response contained more than one exact patch field");
    assert.equal(serialized(explicitResult.content).includes(expectedRedactedPatch), false, "human content duplicated the full patch");
    assert.equal(serialized(explicitResult._meta).includes(expectedRedactedPatch), false, "_meta duplicated the full patch");
    assert.equal(serialized(explicitResult.content).includes(ADD_SECRET), false, "human content leaked addition secret");
    assert.equal(serialized(explicitResult._meta).includes(ADD_SECRET), false, "_meta leaked addition secret");
    assertNoLiterals(explicitCall.response, [ADD_SECRET, DELETE_SECRET, CONTEXT_SECRET, DEFAULT_SENTINEL], "complete explicit response");
    assert.equal(serialized(explicitResult.content).includes(TARGET_SENTINEL), false, "human content duplicated the target patch sentinel");
    assert.equal(explicitResult.content.some((part) => typeof part?.text === "string" && part.text.includes(TARGET_SENTINEL)), false, "human content exposed patch sentinel");
    assert.equal(structured.patch.includes(TARGET_SENTINEL), true, "structured patch omitted target sentinel");
    assert.equal(structured.patch.includes(DEFAULT_SENTINEL), false, "structured patch used default-workspace sentinel");
    console.log("PASS fresh-session explicit target: B used only saved target workspace_id despite distinct default-B; exact refs/counts/file/patch truth matched direct Git and patch occurred only at structuredContent.patch with redaction.");

    // Missing workspace_id must reject even though default-B has valid HEAD~1
    // and HEAD refs. This is the fallback falsifier and error-envelope proof.
    const missingBefore = await repositorySnapshot(targetRoot);
    const missingCall = await callTool(secondClient, "git_diff_range", { base_ref: "HEAD~1", head_ref: "HEAD" });
    const missingResult = errorResult(missingCall, "missing workspace_id");
    const missingText = serialized(missingResult);
    assert.match(missingText, /workspace_id/iu, "missing-ID error did not identify workspace_id");
    assert.equal(missingText.includes(DEFAULT_SENTINEL), false, "missing-ID call fell back to default-B workspace");
    assert.equal(missingText.includes(TARGET_SENTINEL), false, "missing-ID call returned target content");
    assert.equal(missingResult.structuredContent?.error?.includes?.(DEFAULT_SENTINEL) ?? false, false);
    assert.equal(missingResult.structuredContent?.error?.includes?.(TARGET_SENTINEL) ?? false, false);
    const missingAfter = await repositorySnapshot(targetRoot);
    assert.deepEqual(missingAfter, missingBefore, "missing-ID validation changed target repository state");
    console.log("PASS missing workspace_id: validation returned an error before fallback could use valid default-B refs; target snapshot stayed unchanged and no target/default sentinel appeared.");

    // A hostile unknown key is supplied through the real MCP transport. Its
    // name and value must be absent from every returned/result/protocol field.
    const hostileCall = await callTool(secondClient, "git_diff_range", {
      workspace_id: workspaceId,
      base_ref: "HEAD~1",
      head_ref: "HEAD",
      [HOSTILE_KEY]: HOSTILE_VALUE
    });
    const hostileResult = errorResult(hostileCall, "hostile unknown property");
    assert.match(serialized(hostileResult), /unknown|unrecognized|invalid arguments/iu, "hostile unknown-property error was not a bounded schema rejection");
    assertNoHostileResponse(hostileCall, "hostile unknown property");
    console.log(`RAW_ENVELOPE: hostile unknown-key response keys=${Object.keys(hostileCall.response).sort().join(",")}; result keys=${Object.keys(hostileCall.response.result).sort().join(",")}; serialized=${hostileCall.raw}`);
    console.log("PASS hostile unknown property: runtime rejection returned no hostile key/value in content, structuredContent, _meta, protocol error.message, error.data, or complete response JSON.");

    const after = await repositorySnapshot(targetRoot);
    assert.deepEqual(after, before, "fresh-session public calls changed target repository state");
    console.log("RAW_OBSERVATION: target HEAD/branch, refs, reflogs, index, staged/unstaged/untracked state, relevant bytes, local config/remotes, and worktree registrations matched before/after public calls.");
    console.log("SANITY_VERDICT: MATCH — direct target facts remain physically unchanged and the fresh public result retains target identity rather than default-B identity.");
    console.log("EVIDENCE_CONFLICT: none observed between raw Git target evidence and public MCP result.");
    console.log("GIT_DIFF_RANGE_MCP_SMOKE: PASS (TASK-005 AP-009/AP-010 proof only; final acceptance remains with Execution Root/Hestia).");
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await main();
