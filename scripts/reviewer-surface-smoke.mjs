import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const REVIEW_TOOLS = [
  "git_resolve_ref",
  "git_merge_base",
  "git_log",
  "git_show_commit",
  "read_at_ref"
];

const DEFAULT_SENTINEL = "DEFAULT_REVIEW_SURFACE_SENTINEL_7X9";
const SOURCE_SECRET = "PRIVATE_REVIEW_SOURCE_SECRET_7X9";
const COMMIT_SECRET = "sk-review-surface-commit-secret-7X9";
const BODY_SECRET = "ghp_review_surface_body_secret_7X9";
const ERROR_SECRET = "invalid-review-surface-ref-secret-7X9";
const BLOCKED_SECRET = "ENV_REVIEW_SURFACE_SECRET_7X9";
const BINARY_SECRET = "BINARY_REVIEW_SURFACE_SECRET_7X9";
const OVERSIZED_SECRET = "OVERSIZED_REVIEW_SURFACE_SECRET_7X9";
const HOSTILE_UNKNOWN_KEY = "OPENAI_API_KEY=sk-unknown-key-name-review-surface-7X9";

async function pathExists(absolutePath) {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function gitEnv() {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true"
  };
  delete env.GIT_CONFIG;
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_NO_LAZY_FETCH;
  delete env.GIT_SHALLOW_FILE;
  delete env.GIT_TRACE;
  delete env.GIT_TRACE2;
  delete env.GIT_TRACE2_EVENT;
  delete env.GIT_TRACE_PERFORMANCE;
  return env;
}

function directGit(root, args, options = {}) {
  const env = gitEnv();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("git", args, {
    cwd: root,
    env,
    input: options.input,
    encoding: "buffer",
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? ""),
    status: result.status,
    signal: result.signal,
    error: result.error
  };
}

function mustGit(root, args, options = {}) {
  const result = directGit(root, args, options);
  if (result.error || result.status !== 0) {
    throw new Error(
      `fixture git failed: git ${args.join(" ")} status=${result.status} ` +
      `error=${result.error?.message ?? ""} stderr=${result.stderr.toString("utf8")}`
    );
  }
  return result;
}

function gitText(root, args) {
  return mustGit(root, args).stdout.toString("utf8").trim();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function commitWorkingTree(root, subject, body = "") {
  mustGit(root, ["add", "-A"]);
  const message = body ? `${subject}\n\n${body}` : subject;
  mustGit(root, ["-c", "user.name=Reviewer Surface", "-c", "user.email=reviewer-surface@example.test", "commit", "--quiet", "-m", message]);
  return gitText(root, ["rev-parse", "HEAD"]);
}

function commitTree(root, tree, parents, message) {
  const args = ["commit-tree", tree];
  for (const parent of parents) args.push("-p", parent);
  return mustGit(root, args, { input: Buffer.from(message, "utf8") }).stdout.toString("ascii").trim();
}

function directTreeEntries(root, commit) {
  const bytes = mustGit(root, ["ls-tree", "-r", "-z", "-l", commit, "--"]).stdout;
  const entries = new Map();
  for (const record of bytes.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    assert.ok(tab > 0, `malformed direct tree record: ${record}`);
    const [mode, type, oid, sizeText] = record.slice(0, tab).trim().split(/\s+/u);
    assert.ok(mode && type && oid && sizeText !== undefined, `malformed direct tree metadata: ${record}`);
    entries.set(record.slice(tab + 1), {
      mode,
      type,
      oid,
      size: sizeText === "-" ? undefined : Number(sizeText)
    });
  }
  return entries;
}

function directCommit(root, commit) {
  const raw = mustGit(root, ["cat-file", "commit", commit]).stdout;
  const delimiter = raw.indexOf(Buffer.from("\n\n", "utf8"));
  assert.ok(delimiter >= 0, `commit ${commit} has no message delimiter`);
  const headers = raw.subarray(0, delimiter).toString("utf8").split("\n");
  const treeSha = headers.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  assert.ok(treeSha);
  const messageBytes = raw.subarray(delimiter + 2);
  const decoded = messageBytes.toString("utf8");
  const newline = decoded.indexOf("\n");
  const subject = newline < 0 ? decoded.replace(/\r$/u, "") : decoded.slice(0, newline).replace(/\r$/u, "");
  let body = newline < 0 ? "" : decoded.slice(newline + 1);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);
  return { treeSha, parents, subject, body, messageBytes: messageBytes.byteLength, raw };
}

function directLogIds(root, commit, maxCount = 100) {
  return gitText(root, ["rev-list", `--max-count=${maxCount}`, commit]).split("\n").filter(Boolean);
}

function directParents(root, commit) {
  return gitText(root, ["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1);
}

function directEntryBlob(root, entry) {
  return mustGit(root, ["cat-file", "blob", entry.oid]).stdout;
}

function numberLines(bytes, startLine = 1) {
  const lines = bytes.toString("utf8").replace(/\r\n/gu, "\n").split("\n");
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n");
}

function resolveSchema(root, schema) {
  let current = schema;
  const seen = new Set();
  while (current?.$ref) {
    assert.equal(typeof current.$ref, "string");
    assert.ok(current.$ref.startsWith("#/"));
    assert.equal(seen.has(current.$ref), false);
    seen.add(current.$ref);
    current = current.$ref.slice(2).split("/").reduce((value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  return current;
}

function serialized(value) {
  return JSON.stringify(value) ?? "";
}

function assertNoRaw(value, literals, label) {
  const text = serialized(value);
  for (const literal of literals) assert.equal(text.includes(literal), false, `${label} leaked raw literal ${literal}`);
}

function assertHostileEnvelope(result, literals, label) {
  assertNoRaw(result, literals, `${label} complete response`);
  const envelope = result?.result ?? result;
  assertNoRaw(envelope, literals, `${label} MCP result`);
  assertNoRaw(envelope?.content, literals, `${label} content`);
  assertNoRaw(envelope?.structuredContent, literals, `${label} structuredContent`);
  assertNoRaw(envelope?._meta, literals, `${label} _meta`);
  assertNoRaw(result?.text, literals, `${label} protocol text`);
}

function resultText(result) {
  return result?.content?.find?.((part) => part.type === "text")?.text ?? serialized(result?.structuredContent ?? result);
}

class McpStdioClient {
  constructor(defaultRoot, targetParent, targetRoot, mode, environment = {}) {
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    const env = {
      ...process.env,
      CODEXPRO_ROOT: defaultRoot,
      CODEXPRO_ALLOWED_ROOTS: [targetParent, targetRoot].join(path.delimiter),
      CODEXPRO_TOOL_CARDS: "0",
      CODEXPRO_CODEX_SESSIONS: "off",
      CODEXPRO_BASH_MODE: "off",
      CODEXPRO_WRITE_MODE: "off",
      CODEXPRO_MAX_READ_BYTES: "4000"
    };
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    this.child = spawn(process.execPath, [
      "dist/stdio.js",
      "--root", defaultRoot,
      "--allow-root", targetParent,
      "--allow-root", targetRoot,
      "--bash", "off",
      "--write", "off",
      "--tool-mode", mode
    ], {
      cwd: path.resolve("."),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.child.stderr.on("data", (chunk) => { this.stderr += String(chunk); });
    this.child.on("exit", (code, signal) => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`server exited code=${code} signal=${signal}; stderr=${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`)), 20_000);
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

async function startClient(defaultRoot, targetParent, targetRoot, mode, environment = {}) {
  const client = new McpStdioClient(defaultRoot, targetParent, targetRoot, mode, environment);
  const initialize = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "reviewer-surface-smoke", version: "1.0.0" }
  });
  client.notify("notifications/initialized");
  return { client, initialize };
}

async function callTool(client, name, args) {
  try {
    const result = await client.request("tools/call", { name, arguments: args });
    return { protocolError: false, result, text: resultText(result) };
  } catch (error) {
    return { protocolError: true, result: null, text: error instanceof Error ? error.message : String(error) };
  }
}

function expectSuccess(output, label) {
  assert.equal(output.protocolError, false, `${label} returned protocol error: ${output.text}`);
  assert.notEqual(output.result?.isError, true, `${label} failed: ${output.text}`);
  assert.ok(output.result?.structuredContent && typeof output.result.structuredContent === "object", `${label} omitted structuredContent`);
  return output.result;
}

function expectError(output, label) {
  if (output.protocolError) return output.text;
  assert.equal(output.result?.isError, true, `${label} unexpectedly succeeded: ${output.text}`);
  return output.text;
}

function assertPublicEnvelope(data, workspaceId, canonicalRoot, label) {
  assert.equal(data.schema_version, 1, `${label} omitted schema_version=1`);
  assert.equal(data.workspace_id, workspaceId, `${label} returned wrong workspace_id`);
  assert.equal(data.root, canonicalRoot, `${label} returned wrong root`);
}

function processSnapshotOn8787() {
  const result = spawnSync("ss", ["-ltnp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error || result.status !== 0) return "unavailable";
  return result.stdout.split("\n").filter((line) => /:8787(?:\s|$)/u.test(line)).join("\n");
}

async function pathState(root, relativePath) {
  const absolute = path.join(root, relativePath);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return { kind: "symlink", target: await readlink(absolute) };
    if (info.isFile()) {
      const bytes = await readFile(absolute);
      return { kind: "file", bytes: bytes.byteLength, sha256: sha256(bytes) };
    }
    return { kind: info.isDirectory() ? "directory" : "other", mode: info.mode };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

async function repositorySnapshot(root) {
  const tracked = mustGit(root, ["ls-files", "-z"]).stdout.toString("utf8").split("\0").filter(Boolean);
  const trackedState = {};
  for (const relativePath of tracked) trackedState[relativePath] = await pathState(root, relativePath);
  const trackedSymlinkTargets = Object.fromEntries(
    Object.entries(trackedState)
      .filter(([, state]) => state.kind === "symlink")
      .map(([relativePath, state]) => [relativePath, state.target])
  );
  const untrackedPaths = mustGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.toString("utf8").split("\0").filter(Boolean);
  const untrackedState = {};
  for (const relativePath of untrackedPaths) untrackedState[relativePath] = await pathState(root, relativePath);
  const raw = {
    head: mustGit(root, ["rev-parse", "--verify", "HEAD"]).stdout.toString("utf8"),
    branch: mustGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout.toString("utf8"),
    refs: mustGit(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00"]).stdout.toString("base64"),
    reflogs: mustGit(root, ["reflog", "show", "--all", "--format=%H%x00%gD%x00%gs%x00"]).stdout.toString("base64"),
    index: mustGit(root, ["ls-files", "--stage", "-z"]).stdout.toString("base64"),
    staged: mustGit(root, ["diff", "--cached", "--binary", "--no-ext-diff"]).stdout.toString("base64"),
    unstaged: mustGit(root, ["diff", "--binary", "--no-ext-diff"]).stdout.toString("base64"),
    untracked: untrackedState,
    status: mustGit(root, ["status", "--porcelain=v1", "--branch"]).stdout.toString("base64"),
    config: mustGit(root, ["config", "--local", "--null", "--list"]).stdout.toString("base64"),
    remotes: mustGit(root, ["remote", "-v"]).stdout.toString("base64"),
    tracked: trackedState
  };
  return {
    headSha: raw.head.trim(),
    symbolicBranch: raw.branch.trim(),
    refsFingerprint: sha256(Buffer.from(raw.refs, "base64")),
    reflogsFingerprint: sha256(Buffer.from(raw.reflogs, "base64")),
    indexFingerprint: sha256(Buffer.from(raw.index, "base64")),
    stagedFingerprint: sha256(Buffer.from(raw.staged, "base64")),
    unstagedFingerprint: sha256(Buffer.from(raw.unstaged, "base64")),
    untrackedFileList: Object.keys(untrackedState),
    untrackedContentFingerprint: sha256(Buffer.from(JSON.stringify(untrackedState), "utf8")),
    trackedContentFingerprint: sha256(Buffer.from(JSON.stringify(trackedState), "utf8")),
    trackedSymlinkTargets,
    configFingerprint: sha256(Buffer.from(raw.config, "base64")),
    remotesFingerprint: sha256(Buffer.from(raw.remotes, "base64")),
    statusFingerprint: sha256(Buffer.from(raw.status, "base64"))
  };
}

const production8787Before = processSnapshotOn8787();
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "codexpro-reviewer-surface-"));
const defaultRoot = path.join(fixtureRoot, "default-repository");
const targetParent = path.join(fixtureRoot, "allowed-parent");
const targetRoot = path.join(targetParent, "nested-target-repository");
let firstClient;
let secondClient;

try {
  await mkdir(defaultRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  for (const root of [defaultRoot, targetRoot]) {
    mustGit(root, ["init", "--quiet"]);
    mustGit(root, ["config", "user.name", "Reviewer Surface Fixture"]);
    mustGit(root, ["config", "user.email", "reviewer-surface-fixture@example.test"]);
    mustGit(root, ["config", "core.logAllRefUpdates", "true"]);
  }
  mustGit(targetRoot, ["config", "remote.origin.url", "https://hostile.invalid/reviewer-surface-secret"]);

  await writeFile(path.join(defaultRoot, "default-only.txt"), `${DEFAULT_SENTINEL}\n`, "utf8");
  const defaultSha = commitWorkingTree(defaultRoot, `default ${DEFAULT_SENTINEL}`);

  const deletedBytes = Buffer.from("deleted historical π content\n", "utf8");
  const oldRenameBytes = Buffer.from("renamed historical old content\n", "utf8");
  const unicodeBytes = Buffer.from("Unicode π and spaces\n", "utf8");
  const privateBytes = Buffer.from([
    "before historical source",
    "-----BEGIN PRIVATE KEY-----",
    SOURCE_SECRET,
    "-----END PRIVATE KEY-----",
    "after historical source",
    ""
  ].join("\n"), "utf8");
  const binaryBytes = Buffer.concat([Buffer.from(BINARY_SECRET, "utf8"), Buffer.from([0x00, 0xff, 0x00])]);
  const oversizedBytes = Buffer.from(`${OVERSIZED_SECRET}\n${"O".repeat(4_200)}`, "utf8");
  const rangeBytes = Buffer.from(["range first", "range second", "R".repeat(240), ""].join("\n"), "utf8");
  const rootSubject = `review root OPENAI_API_KEY=${COMMIT_SECRET}`;
  const rootBody = `Authorization: Bearer ${BODY_SECRET}\nroot body exact\n`;
  const rootDeletedPath = "deleted old π.txt";
  const oldRenamePath = "old name.txt";
  const newRenamePath = "renamed old.txt";
  const unicodePath = "unicode space π.txt";
  const leadingDashPath = "-leading historical.txt";
  const hiddenPath = ".hidden-history.txt";
  const symlinkPath = "historical-link";
  const symlinkTargetPath = "symlink-target.txt";
  const rangePath = "range-budget.txt";
  const tabPath = "tab\tname.txt";
  const newlinePath = "newline\nname.txt";

  await writeFile(path.join(targetRoot, rootDeletedPath), deletedBytes);
  await writeFile(path.join(targetRoot, oldRenamePath), oldRenameBytes);
  await writeFile(path.join(targetRoot, unicodePath), unicodeBytes);
  await writeFile(path.join(targetRoot, leadingDashPath), "leading dash historical\n", "utf8");
  await writeFile(path.join(targetRoot, hiddenPath), "hidden historical content\n", "utf8");
  await writeFile(path.join(targetRoot, "private.txt"), privateBytes);
  await writeFile(path.join(targetRoot, ".env"), `${BLOCKED_SECRET}=do-not-return\n`, "utf8");
  await writeFile(path.join(targetRoot, "credentials.pem"), `-----BEGIN PRIVATE KEY-----\n${BLOCKED_SECRET}\n-----END PRIVATE KEY-----\n`, "utf8");
  await writeFile(path.join(targetRoot, "binary.bin"), binaryBytes);
  await writeFile(path.join(targetRoot, "oversized.txt"), oversizedBytes);
  await writeFile(path.join(targetRoot, rangePath), rangeBytes);
  await writeFile(path.join(targetRoot, symlinkTargetPath), `SYMLINK_TARGET_SECRET_7X9\n`, "utf8");
  await writeFile(path.join(targetRoot, tabPath), "tab path direct fixture\n", "utf8");
  await writeFile(path.join(targetRoot, newlinePath), "newline path direct fixture\n", "utf8");
  await symlink(symlinkTargetPath, path.join(targetRoot, symlinkPath));
  const rootSha = commitWorkingTree(targetRoot, rootSubject, rootBody);
  mustGit(targetRoot, ["tag", "root-lightweight", rootSha]);
  mustGit(targetRoot, ["tag", "--annotate", "root-annotated", "--message", "annotated root", rootSha]);

  mustGit(targetRoot, ["rm", "--quiet", "--", rootDeletedPath]);
  mustGit(targetRoot, ["mv", "--", oldRenamePath, newRenamePath]);
  await writeFile(path.join(targetRoot, "linear.txt"), "ordinary linear history\n", "utf8");
  const linearSha = commitWorkingTree(targetRoot, "ordinary linear subject", "ordinary linear body\n");
  mustGit(targetRoot, ["branch", "linear", linearSha]);

  mustGit(targetRoot, ["checkout", "-b", "side"]);
  await writeFile(path.join(targetRoot, "side.txt"), "divergent side history\n", "utf8");
  const sideSha = commitWorkingTree(targetRoot, "divergent side subject", "side body\n");
  mustGit(targetRoot, ["branch", "side-tip", sideSha]);

  mustGit(targetRoot, ["checkout", "-b", "main", linearSha]);
  await writeFile(path.join(targetRoot, "main.txt"), "divergent main history\n", "utf8");
  const mainSha = commitWorkingTree(targetRoot, "divergent main subject", "main body\n");
  mustGit(targetRoot, ["branch", "main-tip", mainSha]);
  mustGit(targetRoot, ["merge", "--no-ff", "side", "-m", "merge review subject\n\nmerge body exact\n"]);
  const mergeSha = gitText(targetRoot, ["rev-parse", "HEAD"]);
  mustGit(targetRoot, ["branch", "merge-tip", mergeSha]);

  // Construct multiple best merge bases and an unrelated root in the local
  // object database. These are fixture operations, never reviewer calls.
  const linearTree = gitText(targetRoot, ["rev-parse", `${linearSha}^{tree}`]);
  const crissA = commitTree(targetRoot, linearTree, [linearSha], "criss A\n");
  const crissB = commitTree(targetRoot, linearTree, [linearSha], "criss B\n");
  const crissLeft = commitTree(targetRoot, linearTree, [crissA, crissB], "criss left\n");
  const crissRight = commitTree(targetRoot, linearTree, [crissB, crissA], "criss right\n");
  mustGit(targetRoot, ["update-ref", "refs/heads/criss-left", crissLeft]);
  mustGit(targetRoot, ["update-ref", "refs/heads/criss-right", crissRight]);
  const unrelated = commitTree(targetRoot, linearTree, [], "unrelated review root\n");
  mustGit(targetRoot, ["update-ref", "refs/heads/unrelated", unrelated]);
  mustGit(targetRoot, ["branch", "moving", rootSha]);

  const targetCanonicalRoot = await realpath(targetRoot);
  const defaultCanonicalRoot = await realpath(defaultRoot);
  const rootCommit = directCommit(targetRoot, rootSha);
  const mergeCommit = directCommit(targetRoot, mergeSha);
  const rootEntries = directTreeEntries(targetRoot, rootSha);
  const mergeEntries = directTreeEntries(targetRoot, mergeSha);
  const directBases = gitText(targetRoot, ["merge-base", "--all", "main-tip", "side-tip"]).split("\n").filter(Boolean);
  const directCrissBases = gitText(targetRoot, ["merge-base", "--all", "criss-left", "criss-right"]).split("\n").filter(Boolean).sort();
  const directRootLog = directLogIds(targetRoot, rootSha);
  const directMergeLog = directLogIds(targetRoot, mergeSha);
  const targetObjectFormat = gitText(targetRoot, ["rev-parse", "--show-object-format"]);
  const deletedEntry = rootEntries.get(rootDeletedPath);
  const oldRenameEntry = rootEntries.get(oldRenamePath);
  const renamedEntry = mergeEntries.get(newRenamePath);
  const privateEntry = rootEntries.get("private.txt");
  const symlinkEntry = rootEntries.get(symlinkPath);
  const binaryEntry = rootEntries.get("binary.bin");
  const oversizedEntry = rootEntries.get("oversized.txt");
  const rangeEntry = rootEntries.get(rangePath);
  assert.ok(deletedEntry && oldRenameEntry && renamedEntry && privateEntry && symlinkEntry && binaryEntry && oversizedEntry && rangeEntry);
  assert.equal(rootEntries.has(rootDeletedPath), true);
  assert.equal(mergeEntries.has(rootDeletedPath), false);
  assert.equal(rootEntries.has(oldRenamePath), true);
  assert.equal(mergeEntries.has(oldRenamePath), false);
  assert.equal(mergeEntries.has(newRenamePath), true);
  assert.equal(symlinkEntry.mode, "120000");
  assert.equal(symlinkEntry.type, "blob");
  assert.equal(binaryEntry.type, "blob");
  assert.equal(directEntryBlob(targetRoot, privateEntry).includes(Buffer.from(SOURCE_SECRET, "utf8")), true);
  assert.deepEqual(directEntryBlob(targetRoot, symlinkEntry), Buffer.from(symlinkTargetPath, "utf8"));
  assert.deepEqual(directEntryBlob(targetRoot, binaryEntry), binaryBytes);
  assert.equal(directEntryBlob(targetRoot, oversizedEntry).includes(Buffer.from(OVERSIZED_SECRET, "utf8")), true);
  assert.deepEqual(directEntryBlob(targetRoot, rangeEntry), rangeBytes);
  assert.equal(rangeBytes.byteLength <= 4_000, true);
  assert.equal(rootCommit.parents.length, 0);
  assert.equal(mergeCommit.parents.length, 2);
  assert.deepEqual(directBases, [linearSha]);
  assert.deepEqual(directCrissBases, [crissA, crissB].sort());
  assert.equal(rootCommit.subject, rootSubject);
  assert.equal(rootCommit.body, rootBody);
  assert.equal(mergeCommit.subject, "merge review subject");
  assert.equal(mergeCommit.body, "merge body exact\n");
  assert.equal(directMergeLog[0], mergeSha);
  assert.equal(directRootLog[0], rootSha);
  assert.equal(defaultSha.length, 40);

  // Establish the inherited-Git-environment hazard directly before any
  // public MCP process is started. The shallow file must truncate history,
  // and each requested trace variable must create a real artifact. Those
  // direct-oracle artifacts are removed before the target snapshot.
  const directLogArgs = ["rev-list", "--max-count=100", mergeSha];
  const directHistoryResult = directGit(targetRoot, directLogArgs);
  assert.equal(directHistoryResult.status, 0);
  const directHistoryIds = directHistoryResult.stdout.toString("utf8").trim().split("\n").filter(Boolean);
  assert.deepEqual(directHistoryIds, directMergeLog);
  const hostileShallowPath = path.join(fixtureRoot, "hostile-shallow-file");
  const traceDir = path.join(targetRoot, ".reviewer-direct-traces");
  const tracePaths = {
    GIT_TRACE: path.join(traceDir, "git-trace.log"),
    GIT_TRACE2: path.join(traceDir, "git-trace2.log"),
    GIT_TRACE2_EVENT: path.join(traceDir, "git-trace2-event.log"),
    GIT_TRACE_PERFORMANCE: path.join(traceDir, "git-trace-performance.log")
  };
  await writeFile(hostileShallowPath, `${linearSha}\n`, "utf8");
  const shallowResult = directGit(targetRoot, directLogArgs, { env: { GIT_SHALLOW_FILE: hostileShallowPath } });
  assert.equal(shallowResult.status, 0, shallowResult.stderr.toString("utf8"));
  const shallowHistoryIds = shallowResult.stdout.toString("utf8").trim().split("\n").filter(Boolean);
  assert.equal(shallowHistoryIds.length < directHistoryIds.length, true);
  assert.equal(shallowHistoryIds.includes(rootSha), false);
  assert.equal(shallowHistoryIds.includes(linearSha), true);
  await mkdir(traceDir, { recursive: true });
  for (const [variable, tracePath] of Object.entries(tracePaths)) {
    const traced = directGit(targetRoot, directLogArgs, { env: { [variable]: tracePath } });
    assert.equal(traced.status, 0, `${variable}: ${traced.stderr.toString("utf8")}`);
    assert.equal(await pathExists(tracePath), true, `${variable} did not create a trace artifact`);
    assert.equal((await readFile(tracePath)).byteLength > 0, true, `${variable} trace artifact was empty`);
  }
  console.log(`RAW_OBSERVATION: direct Git with GIT_SHALLOW_FILE=${hostileShallowPath} returned ${shallowHistoryIds.length}/${directHistoryIds.length} merge-tip commits and omitted root; each GIT_TRACE* path produced non-empty bytes.`);
  console.log("PREDICATE: TRUE — hostile inherited Git environment independently causes shallow-history truncation and trace-file writes before MCP interpretation.");
  await rm(traceDir, { recursive: true, force: true });
  // Preserve a writable, snapshot-visible destination directory for the
  // hostile public child. Direct trace files are gone, but an unsealed child
  // must still be able to recreate each file for the negative assertion.
  await mkdir(traceDir, { recursive: true });
  assert.equal(await pathExists(traceDir), true);
  for (const tracePath of Object.values(tracePaths)) assert.equal(await pathExists(tracePath), false);
  const hostileGitEnvironment = { GIT_SHALLOW_FILE: hostileShallowPath, ...tracePaths };

  console.log("AUTHORITY: A002 MISSION_ANCHOR + P002 MISSION_PLAN TASK-007/AP-011/AP-012 and AC-001..AC-007 define the expected reviewer outcome.");
  console.log(`TARGET_PRODUCER/ROUTE: fresh ordinary MCP stdio server processes in full/standard/minimal modes, five public tools, target=${targetCanonicalRoot}, nested under allowed parent; no production 8787 route.`);
  console.log(`TARGET_EVIDENCE: direct Git object database/filesystem fixture observations plus complete serialized MCP response envelopes and native commands.`);
  console.log(`RAW_OBSERVATION: default HEAD=${defaultSha} contains ${DEFAULT_SENTINEL}; target root=${rootSha}, linear=${linearSha}, side=${sideSha}, main=${mainSha}, merge=${mergeSha}, object-format=${targetObjectFormat}.`);
  console.log(`RAW_OBSERVATION: root parents=${JSON.stringify(rootCommit.parents)}, merge parents=${JSON.stringify(mergeCommit.parents)}, unique base=${JSON.stringify(directBases)}, criss-cross bases=${JSON.stringify(directCrissBases)}, unrelated=${unrelated}.`);
  console.log(`RAW_OBSERVATION: deleted/renamed historical entries are root-only; symlink mode/type=${symlinkEntry.mode}/${symlinkEntry.type} and raw target bytes are ${symlinkTargetPath}; binary has NUL; oversized bytes=${oversizedEntry.size}.`);
  console.log(`RAW_OBSERVATION: raw private source contains ${SOURCE_SECRET}; raw root subject/body contain secret-looking literals; .env/credentials contain ${BLOCKED_SECRET}; tab/newline names are present in the direct tree.`);
  console.log("PREDICATE: TRUE — direct Git/tree facts establish every target condition before interpreting any public response: root/linear/divergent/merge, tags, old paths, source secret, blocked paths, symlink, binary, oversized, dirty-state capacity, and hostile messages.");
  console.log("SANITY_VERDICT: MATCH — raw target facts and accepted authority agree on the required public observable distinctions; implementation labels and test verdicts have not been used as raw evidence.");

  // A moving branch is resolved once before it moves. The later target proof
  // uses only this captured full identity, while the branch movement remains
  // fixture setup outside the immutable before/after window.
  const fullSession = await startClient(defaultRoot, targetParent, targetRoot, "full");
  firstClient = fullSession.client;
  const firstListing = await firstClient.request("tools/list", {});
  const firstNames = (firstListing.tools ?? []).map((tool) => tool.name);
  for (const name of REVIEW_TOOLS) assert.equal(firstNames.includes(name), true, `full mode omitted ${name}`);
  const firstByName = new Map((firstListing.tools ?? []).map((tool) => [tool.name, tool]));
  for (const name of REVIEW_TOOLS) {
    const tool = firstByName.get(name);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} missing readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name} destructive annotation changed`);
    assert.equal(tool.annotations?.openWorldHint, false, `${name} openWorld annotation changed`);
    const schema = resolveSchema(firstListing, tool.inputSchema);
    assert.equal(schema.type, "object", `${name} schema is not object`);
    assert.equal(schema.additionalProperties, false, `${name} accepts unknown keys`);
    assert.ok(schema.required.includes("workspace_id"), `${name} does not require workspace_id`);
    assert.equal(schema.properties.workspace_id.type, "string", `${name} workspace_id is not string`);
  }
  assert.match(String(fullSession.initialize?.instructions ?? ""), /explicit workspace_id/iu);
  console.log("PASS full exposure/schema: all five tools present with required workspace_id, strict objects, and read-only annotations.");
  await firstClient.close();
  firstClient = undefined;

  for (const mode of ["standard", "minimal"]) {
    const session = await startClient(defaultRoot, targetParent, targetRoot, mode);
    try {
      const listing = await session.client.request("tools/list", {});
      const names = (listing.tools ?? []).map((tool) => tool.name);
      assert.equal(names.some((name) => REVIEW_TOOLS.includes(name)), false, `${mode} exposed full-only reviewer tool`);
    } finally {
      await session.client.close();
    }
  }
  console.log("PASS mode boundary: standard and minimal omit all five reviewer tools.");

  const openingSession = await startClient(defaultRoot, targetParent, targetRoot, "full");
  firstClient = openingSession.client;
  const opened = expectSuccess(await callTool(firstClient, "open_workspace", { path: targetRoot, include_tree: false }), "open target workspace");
  const workspaceId = opened.structuredContent.workspace_id;
  assert.match(workspaceId, /^ws_[a-f0-9]{24}$/u);
  assert.equal(opened.structuredContent.root, targetCanonicalRoot);
  const movingBefore = gitText(targetRoot, ["rev-parse", "moving"]);
  const movingResolved = expectSuccess(await callTool(firstClient, "git_resolve_ref", { workspace_id: workspaceId, ref: "moving" }), "resolve moving branch before move").structuredContent;
  assert.equal(movingResolved.full_sha, movingBefore);
  await firstClient.close();
  firstClient = undefined;
  mustGit(targetRoot, ["update-ref", "refs/heads/moving", mergeSha]);
  assert.equal(gitText(targetRoot, ["rev-parse", "moving"]), mergeSha);

  // Create the required dirty state only after all fixture refs/content are
  // complete. No reviewer tool call occurs between this snapshot pair except
  // the public calls below.
  await writeFile(path.join(targetRoot, newRenamePath), "unstaged unrelated modification\n", "utf8");
  await writeFile(path.join(targetRoot, "main.txt"), "staged unrelated modification\n", "utf8");
  mustGit(targetRoot, ["add", "--", "main.txt"]);
  await writeFile(path.join(targetRoot, "untracked unrelated.txt"), "untracked unrelated content\n", "utf8");
  const dirtyStatus = mustGit(targetRoot, ["status", "--porcelain=v1", "--branch"]).stdout.toString("utf8");
  const dirtyStaged = mustGit(targetRoot, ["diff", "--cached", "--binary", "--no-ext-diff"]).stdout.toString("utf8");
  const dirtyUnstaged = mustGit(targetRoot, ["diff", "--binary", "--no-ext-diff"]).stdout.toString("utf8");
  const dirtyUntracked = mustGit(targetRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).stdout.toString("utf8");
  assert.match(dirtyStatus, /main\.txt/u);
  assert.match(dirtyStatus, /renamed old\.txt/u);
  assert.match(dirtyStatus, /untracked unrelated\.txt/u);
  assert.match(dirtyStaged, /staged unrelated modification/u);
  assert.match(dirtyUnstaged, /unstaged unrelated modification/u);
  assert.equal(dirtyUntracked.includes("untracked unrelated.txt\0"), true);
  console.log("RAW_OBSERVATION: dirty fixture directly shows one staged tracked modification, one unstaged tracked modification, and one untracked file before reviewer calls.");
  console.log("PREDICATE: TRUE — dirty/staged/unstaged/untracked state is independently established from raw Git status/diff/list output.");
  const before = await repositorySnapshot(targetRoot);
  assert.equal(await pathExists(traceDir), true, "hostile trace destination directory missing before snapshot");
  for (const tracePath of Object.values(tracePaths)) assert.equal(await pathExists(tracePath), false, `hostile trace destination was not empty before snapshot: ${tracePath}`);
  secondClient = (await startClient(defaultRoot, targetParent, targetRoot, "full", hostileGitEnvironment)).client;

  const targetLiterals = [DEFAULT_SENTINEL];
  const resolveHeadOut = await callTool(secondClient, "git_resolve_ref", { workspace_id: workspaceId, ref: "HEAD" });
  const resolveHeadResult = expectSuccess(resolveHeadOut, "explicit HEAD resolve");
  const resolveHead = resolveHeadResult.structuredContent;
  assertPublicEnvelope(resolveHead, workspaceId, targetCanonicalRoot, "git_resolve_ref");
  assert.equal(resolveHead.full_sha, mergeSha);
  assert.equal(resolveHead.short_sha, mergeSha.slice(0, 12));
  assert.equal(resolveHead.object_format, targetObjectFormat);
  assertHostileEnvelope(resolveHeadResult, targetLiterals, "resolve target");

  for (const [ref, expected] of [["root-lightweight", rootSha], ["root-annotated", rootSha], [rootSha, rootSha]]) {
    const result = expectSuccess(await callTool(secondClient, "git_resolve_ref", { workspace_id: workspaceId, ref }), `resolve ${ref}`).structuredContent;
    assert.equal(result.full_sha, expected);
    assert.equal(result.object_format, targetObjectFormat);
  }
  const capturedResolve = expectSuccess(await callTool(secondClient, "git_resolve_ref", { workspace_id: workspaceId, ref: movingBefore }), "resolve captured moving SHA").structuredContent;
  assert.equal(capturedResolve.full_sha, movingBefore);
  console.log("PASS ref identity: HEAD, full SHA, lightweight tag, annotated tag, and captured pre-move SHA resolve to direct object IDs.");

  const divergent = expectSuccess(await callTool(secondClient, "git_merge_base", { workspace_id: workspaceId, left_ref: "main-tip", right_ref: "side-tip" }), "divergent merge base").structuredContent;
  assertPublicEnvelope(divergent, workspaceId, targetCanonicalRoot, "divergent merge base");
  assert.deepEqual(divergent.merge_bases, directBases);
  assert.equal(divergent.left_is_ancestor, false);
  assert.equal(divergent.right_is_ancestor, false);
  assert.equal(divergent.unrelated, false);
  assert.equal(divergent.history_complete, true);
  const ancestor = expectSuccess(await callTool(secondClient, "git_merge_base", { workspace_id: workspaceId, left_ref: "linear", right_ref: "merge-tip" }), "ancestor merge base").structuredContent;
  assert.deepEqual(ancestor.merge_bases, [linearSha]);
  assert.equal(ancestor.left_is_ancestor, true);
  assert.equal(ancestor.right_is_ancestor, false);
  const criss = expectSuccess(await callTool(secondClient, "git_merge_base", { workspace_id: workspaceId, left_ref: "criss-left", right_ref: "criss-right" }), "criss-cross merge base").structuredContent;
  assert.deepEqual([...criss.merge_bases].sort(), directCrissBases);
  const unrelatedResult = expectSuccess(await callTool(secondClient, "git_merge_base", { workspace_id: workspaceId, left_ref: "unrelated", right_ref: "merge-tip" }), "unrelated merge base").structuredContent;
  assert.deepEqual(unrelatedResult.merge_bases, []);
  assert.equal(unrelatedResult.unrelated, true);
  assertHostileEnvelope({ structuredContent: divergent }, targetLiterals, "merge base target");
  console.log("PASS merge-base truth: divergent, ancestor, multiple-best-base criss-cross, and unrelated histories retained direct results.");

  assert.equal(await pathExists(traceDir), true, "hostile trace destination directory missing before public call");
  for (const tracePath of Object.values(tracePaths)) assert.equal(await pathExists(tracePath), false, `trace path was not clean before public call: ${tracePath}`);
  const logOutput = await callTool(secondClient, "git_log", { workspace_id: workspaceId, start_ref: "merge-tip", max_count: 100 });
  const logResult = expectSuccess(logOutput, "structured merge log");
  const log = logResult.structuredContent;
  assertPublicEnvelope(log, workspaceId, targetCanonicalRoot, "git_log");
  assert.equal(log.start.full_sha, mergeSha);
  assert.deepEqual(log.commits.map((commit) => commit.full_sha), directMergeLog);
  assert.deepEqual(log.commits.map((commit) => commit.full_sha), directHistoryIds);
  assert.deepEqual(log.commits[0].parents, directParents(targetRoot, mergeSha));
  assert.equal(log.commits.some((commit) => commit.full_sha === rootSha), true);
  assert.equal(log.commits.some((commit) => commit.subject.includes(COMMIT_SECRET)), false);
  assertHostileEnvelope(logResult, [COMMIT_SECRET, BODY_SECRET, DEFAULT_SENTINEL], "git_log hostile messages");
  assert.equal(await pathExists(traceDir), true, "hostile trace destination directory disappeared during public call");
  for (const tracePath of Object.values(tracePaths)) assert.equal(await pathExists(tracePath), false, `public Git call created hostile trace artifact: ${tracePath}`);
  console.log("PASS sealed Git environment: the same hostile shallow/trace variables yielded complete direct-equivalent public history and zero trace-file writes.");
  const oldPathLog = expectSuccess(await callTool(secondClient, "git_log", { workspace_id: workspaceId, start_ref: "root-lightweight", path: `./${rootDeletedPath}`, max_count: 20 }), "old deleted path log").structuredContent;
  assert.equal(oldPathLog.path, rootDeletedPath);
  assert.deepEqual(oldPathLog.commits.map((commit) => commit.full_sha), [rootSha]);
  const renamePathLog = expectSuccess(await callTool(secondClient, "git_log", { workspace_id: workspaceId, start_ref: "merge-tip", path: newRenamePath, max_count: 20 }), "renamed path log").structuredContent;
  assert.equal(renamePathLog.path, newRenamePath);
  assert.equal(renamePathLog.commits.some((commit) => commit.full_sha === linearSha), true);
  console.log("PASS structured log: merge ancestry, commit metadata redaction, old deleted path, and renamed path filtering match direct history.");

  const shownRootOut = await callTool(secondClient, "git_show_commit", { workspace_id: workspaceId, ref: rootSha });
  const shownRootResult = expectSuccess(shownRootOut, "show root commit");
  const shownRoot = shownRootResult.structuredContent;
  assertPublicEnvelope(shownRoot, workspaceId, targetCanonicalRoot, "git_show_commit");
  assert.equal(shownRoot.commit_sha, rootSha);
  assert.equal(shownRoot.tree_sha, rootCommit.treeSha);
  assert.deepEqual(shownRoot.parents, []);
  assert.equal(shownRoot.is_root, true);
  assert.equal(shownRoot.is_merge, false);
  assert.equal(shownRoot.subject.includes(COMMIT_SECRET), false);
  assert.equal(shownRoot.body.includes(BODY_SECRET), false);
  assert.match(`${shownRoot.subject}\n${shownRoot.body}`, /\[REDACTED_SECRET\]/u);
  assert.equal(shownRoot.message_bytes, rootCommit.messageBytes);
  assert.equal(shownRoot.message_truncated, false);
  assertHostileEnvelope(shownRootResult, [COMMIT_SECRET, BODY_SECRET, DEFAULT_SENTINEL], "git_show_commit hostile message");
  const shownMerge = expectSuccess(await callTool(secondClient, "git_show_commit", { workspace_id: workspaceId, ref: mergeSha }), "show merge commit").structuredContent;
  assert.deepEqual(shownMerge.parents, mergeCommit.parents);
  assert.equal(shownMerge.is_merge, true);
  assert.equal(shownMerge.subject, mergeCommit.subject);
  assert.equal(shownMerge.body, mergeCommit.body);
  console.log("PASS commit surface: root/merge shape and metadata match raw commits; secret-looking subject/body values are redacted in every envelope field.");

  const rootBlobSha = rootEntries.get(rootDeletedPath).oid;
  const readCases = [
    [rootDeletedPath, deletedBytes],
    [oldRenamePath, oldRenameBytes],
    [unicodePath, unicodeBytes],
    [leadingDashPath, Buffer.from("leading dash historical\n", "utf8")],
    [hiddenPath, Buffer.from("hidden historical content\n", "utf8")]
  ];
  for (const [relativePath, bytes] of readCases) {
    const output = await callTool(secondClient, "read_at_ref", { workspace_id: workspaceId, ref: rootSha, path: relativePath });
    const result = expectSuccess(output, `read historical ${relativePath}`);
    const data = result.structuredContent;
    assertPublicEnvelope(data, workspaceId, targetCanonicalRoot, `read ${relativePath}`);
    assert.equal(data.commit_sha, rootSha);
    assert.equal(data.path, relativePath);
    assert.equal(data.bytes, bytes.byteLength);
    assert.equal(data.sha256, sha256(bytes));
    assert.equal(data.text, numberLines(bytes));
    assert.equal(data.truncated, false);
  }
  const privateOutput = await callTool(secondClient, "read_at_ref", { workspace_id: workspaceId, ref: rootSha, path: "private.txt" });
  const privateResult = expectSuccess(privateOutput, "read redacted private source");
  assert.match(privateResult.structuredContent.text, /\[REDACTED_PRIVATE_KEY\]/u);
  assert.equal(privateResult.structuredContent.text.includes(SOURCE_SECRET), false);
  assert.equal(privateResult.structuredContent.blob_sha, privateEntry.oid);
  assert.equal(privateResult.structuredContent.bytes, privateBytes.byteLength);
  assert.equal(privateResult.structuredContent.sha256, sha256(privateBytes));
  assertHostileEnvelope(privateResult, [SOURCE_SECRET, DEFAULT_SENTINEL], "read private source");
  assert.equal(rootBlobSha, deletedEntry.oid);
  const symlinkResult = expectSuccess(await callTool(secondClient, "read_at_ref", { workspace_id: workspaceId, ref: rootSha, path: symlinkPath }), "read historical symlink").structuredContent;
  assert.equal(symlinkResult.entry_kind, "symlink");
  assert.equal(symlinkResult.git_mode, "120000");
  assert.equal(symlinkResult.text, numberLines(Buffer.from(symlinkTargetPath, "utf8")));
  assert.equal(symlinkResult.text.includes("SYMLINK_TARGET_SECRET_7X9"), false);
  console.log("PASS historical source: deleted/renamed/Unicode/space/leading-dash/hidden paths, complete metadata, typed source redaction, and symlink target-text semantics match direct tree facts.");

  const selectedRangeBytes = Buffer.from("range second", "utf8");
  const selectedRangeText = numberLines(selectedRangeBytes, 2);
  const selectedRangeBudget = Buffer.byteLength(selectedRangeText, "utf8");
  assert.equal(rangeBytes.byteLength > selectedRangeBudget, true);
  assert.equal(rangeBytes.byteLength <= 4_000, true);
  console.log(`RAW_OBSERVATION: direct range blob bytes=${rangeBytes.byteLength} (within configured 4000-byte acquisition limit), numbered line-2 frame bytes=${selectedRangeBudget}; direct blob SHA-256=${sha256(rangeBytes)}.`);
  console.log("PREDICATE: TRUE — direct blob bytes independently establish that the complete file exceeds the requested range budget while the selected numbered frame fits exactly.");
  const rangeOutput = await callTool(secondClient, "read_at_ref", {
    workspace_id: workspaceId,
    ref: rootSha,
    path: rangePath,
    start_line: 2,
    end_line: 2,
    max_bytes: selectedRangeBudget
  });
  const rangeResult = expectSuccess(rangeOutput, "historical range at exact framed budget");
  const rangeData = rangeResult.structuredContent;
  assertPublicEnvelope(rangeData, workspaceId, targetCanonicalRoot, "historical range");
  assert.equal(rangeData.commit_sha, rootSha);
  assert.equal(rangeData.path, rangePath);
  assert.equal(rangeData.text, selectedRangeText);
  assert.equal(rangeData.start_line, 2);
  assert.equal(rangeData.end_line, 2);
  assert.equal(rangeData.total_lines, 4);
  assert.equal(rangeData.bytes, rangeBytes.byteLength);
  assert.equal(rangeData.sha256, sha256(rangeBytes));
  assert.equal(rangeData.blob_sha, rangeEntry.oid);
  assert.equal(rangeData.truncated, true);
  assertHostileEnvelope(rangeResult, [DEFAULT_SENTINEL, SOURCE_SECRET, COMMIT_SECRET], "historical range");
  const tooSmallRangeOutput = await callTool(secondClient, "read_at_ref", {
    workspace_id: workspaceId,
    ref: rootSha,
    path: rangePath,
    start_line: 2,
    end_line: 2,
    max_bytes: selectedRangeBudget - 1
  });
  expectError(tooSmallRangeOutput, "historical range below framed budget");
  assertHostileEnvelope(tooSmallRangeOutput, [DEFAULT_SENTINEL, SOURCE_SECRET, COMMIT_SECRET], "historical range below budget");
  console.log("PASS historical range budget: exact numbered-frame bytes succeed with full blob/hash metadata, while one byte less fails.");

  const hostilePathCases = [
    ["blocked .env", ".env", BLOCKED_SECRET],
    ["blocked credential PEM", "credentials.pem", BLOCKED_SECRET],
    ["binary", "binary.bin", BINARY_SECRET],
    ["oversized", "oversized.txt", OVERSIZED_SECRET],
    ["missing old path at merge", rootDeletedPath, rootDeletedPath],
    ["tab control path", tabPath, tabPath],
    ["newline control path", newlinePath, newlinePath]
  ];
  for (const [label, relativePath, literal] of hostilePathCases) {
    const output = await callTool(secondClient, "read_at_ref", { workspace_id: workspaceId, ref: label === "missing old path at merge" ? mergeSha : rootSha, path: relativePath });
    expectError(output, label);
    assertHostileEnvelope(output, [literal, BLOCKED_SECRET, BINARY_SECRET, OVERSIZED_SECRET, DEFAULT_SENTINEL], label);
  }
  console.log("PASS hostile path/type cases: blocked .env/credential, binary, oversized, absent old path, and control-name validator failures are bounded and leak-free.");

  const capturedLog = expectSuccess(await callTool(secondClient, "git_log", { workspace_id: workspaceId, start_ref: movingBefore, max_count: 1 }), "captured moving log").structuredContent;
  assert.equal(capturedLog.start.full_sha, movingBefore);
  assert.equal(capturedLog.commits[0].full_sha, rootSha);
  const capturedShow = expectSuccess(await callTool(secondClient, "git_show_commit", { workspace_id: workspaceId, ref: movingBefore }), "captured moving show").structuredContent;
  assert.equal(capturedShow.commit_sha, rootSha);
  const capturedRead = expectSuccess(await callTool(secondClient, "read_at_ref", { workspace_id: workspaceId, ref: movingBefore, path: rootDeletedPath })).structuredContent;
  assert.equal(capturedRead.commit_sha, rootSha);
  assert.equal(capturedRead.text, numberLines(deletedBytes));
  console.log("PASS moving-ref downstream identity: after moving branch to merge, captured full SHA still returns original root log/commit/deleted file.");

  const invalidRefOutput = await callTool(secondClient, "git_resolve_ref", { workspace_id: workspaceId, ref: ERROR_SECRET });
  expectError(invalidRefOutput, "invalid hostile ref");
  assertHostileEnvelope(invalidRefOutput, [ERROR_SECRET, DEFAULT_SENTINEL, SOURCE_SECRET, COMMIT_SECRET], "invalid ref error");
  const missingPathOutput = await callTool(secondClient, "read_at_ref", { workspace_id: workspaceId, ref: rootSha, path: `missing-${ERROR_SECRET}.txt` });
  expectError(missingPathOutput, "missing hostile path");
  assertHostileEnvelope(missingPathOutput, [ERROR_SECRET, DEFAULT_SENTINEL, SOURCE_SECRET], "missing path error");
  console.log("PASS hostile response envelope: source, commit, invalid-ref, missing-path, blocked-path, binary, and oversized literals are absent from content/structuredContent/_meta/complete result.");

  const omissionCalls = [
    ["git_resolve_ref", { ref: "HEAD" }],
    ["git_merge_base", { left_ref: "HEAD", right_ref: "HEAD~1" }],
    ["git_log", { start_ref: "HEAD", max_count: 1 }],
    ["git_show_commit", { ref: "HEAD" }],
    ["read_at_ref", { ref: "HEAD", path: "default-only.txt" }]
  ];
  for (const [name, args] of omissionCalls) {
    const output = await callTool(secondClient, name, args);
    const errorText = expectError(output, `${name} omitted workspace_id`);
    assert.match(errorText, /workspace_id/iu, `${name} omission did not identify workspace_id`);
    assertHostileEnvelope(output, [DEFAULT_SENTINEL, SOURCE_SECRET, COMMIT_SECRET], `${name} omission`);
  }
  console.log("PASS missing-ID boundary: every reviewer tool fails before default workspace fallback in a fresh MCP session.");

  const unknownCalls = [
    ["git_resolve_ref", { workspace_id: workspaceId, ref: "HEAD" }],
    ["git_merge_base", { workspace_id: workspaceId, left_ref: "HEAD", right_ref: "HEAD~1" }],
    ["git_log", { workspace_id: workspaceId, start_ref: "HEAD", max_count: 1 }],
    ["git_show_commit", { workspace_id: workspaceId, ref: "HEAD" }],
    ["read_at_ref", { workspace_id: workspaceId, ref: "HEAD", path: rootDeletedPath }]
  ];
  for (const [name, args] of unknownCalls) {
    const output = await callTool(secondClient, name, { ...args, [HOSTILE_UNKNOWN_KEY]: "ignored" });
    const errorText = expectError(output, `${name} unknown key`);
    assert.match(errorText, /unknown|unrecognized|invalid arguments/iu, `${name} unknown-key error was not schema rejection`);
    assertHostileEnvelope(output, [HOSTILE_UNKNOWN_KEY, DEFAULT_SENTINEL, SOURCE_SECRET, COMMIT_SECRET], `${name} unknown key`);
  }
  console.log("PASS strict argument boundary: each reviewer schema rejects a raw secret-looking unknown property name without exposing it in protocol text/content/structuredContent/_meta/complete result.");

  await secondClient.close();
  secondClient = undefined;
  const after = await repositorySnapshot(targetRoot);
  assert.deepEqual(after, before, "public reviewer calls changed repository state");
  console.log("RAW_OBSERVATION: before/after HEAD+branch, refs, reflogs, index, staged diff, unstaged diff, untracked file list/content, tracked relevant content, local config, remotes, and status fingerprints are identical.");
  console.log("SANITY_VERDICT: MATCH — direct filesystem/Git snapshot evidence shows no public reviewer mutation.");
  assert.equal(processSnapshotOn8787(), production8787Before, "production 127.0.0.1:8787 listener changed");
  console.log("PASS production isolation: 127.0.0.1:8787 listener snapshot unchanged.");
  console.log("AP-011: PASS — hostile/redaction, historical path/type, mode/session, and immutable-repository matrices.");
  console.log("AP-012: SUPPORTING — this dedicated reviewer gate passed; aggregate/stress/release native results are reported by the caller.");
  console.log("REVIEWER_SURFACE_SMOKE: PASS (target public MCP trust-contract proof; not final acceptance).");
} finally {
  await firstClient?.close();
  await secondClient?.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
