import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const GIT_REVIEW_TOOLS = [
  'git_resolve_ref',
  'git_merge_base',
  'git_log',
  'git_show_commit',
  'read_at_ref'
];
const DEFAULT_SENTINEL = 'DEFAULT_SENTINEL_7X9';
const TARGET_SENTINEL = 'TARGET_SENTINEL_7X9';
const COMMIT_SECRET = 'sk-live-mcp-surface-secret-1234567890';
const SOURCE_SECRET = 'PRIVATE_MCP_SURFACE_SECRET_7X9';

function gitEnvironment() {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true' };
  delete env.GIT_NO_REPLACE_OBJECTS;
  delete env.GIT_NO_LAZY_FETCH;
  delete env.GIT_CONFIG;
  return env;
}

function directGit(root, args, input) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: gitEnvironment(),
    input,
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw new Error(`fixture git failed: git ${args.join(' ')} status=${result.status} error=${result.error?.message ?? ''} stderr=${Buffer.from(result.stderr ?? '').toString('utf8')}`);
  }
  return Buffer.from(result.stdout ?? '');
}

function gitText(root, args) {
  return directGit(root, args).toString('utf8').trim();
}

function commitFixture(root, subject, body = '') {
  const args = ['-c', 'user.email=mcp-surface-smoke@example.test', '-c', 'user.name=MCP Surface Smoke', 'commit', '--quiet', '-m', subject];
  if (body) args.push('-m', body);
  directGit(root, args);
  return gitText(root, ['rev-parse', 'HEAD']);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function directCommit(root, sha) {
  const raw = directGit(root, ['cat-file', 'commit', sha]);
  const delimiter = raw.indexOf(Buffer.from('\n\n', 'utf8'));
  assert.ok(delimiter >= 0, `direct commit ${sha} had no message delimiter`);
  const headers = raw.subarray(0, delimiter).toString('utf8').split('\n');
  const treeSha = headers.find((line) => line.startsWith('tree '))?.slice(5);
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  assert.ok(treeSha, `direct commit ${sha} had no tree`);
  const messageBytes = raw.subarray(delimiter + 2);
  const decoded = messageBytes.toString('utf8');
  const newline = decoded.indexOf('\n');
  const subject = newline < 0 ? decoded.replace(/\r$/u, '') : decoded.slice(0, newline).replace(/\r$/u, '');
  let body = newline < 0 ? '' : decoded.slice(newline + 1);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  return {
    treeSha,
    parents,
    subject,
    body,
    messageBytes: messageBytes.byteLength,
    authorName: gitText(root, ['show', '-s', '--format=%an', sha]),
    authoredAt: gitText(root, ['show', '-s', '--format=%aI', sha]),
    committerName: gitText(root, ['show', '-s', '--format=%cn', sha]),
    committedAt: gitText(root, ['show', '-s', '--format=%cI', sha])
  };
}

function resolveSchema(root, schema) {
  let current = schema;
  const seen = new Set();
  while (current?.$ref) {
    assert.equal(typeof current.$ref, 'string');
    assert.ok(current.$ref.startsWith('#/'), `unsupported schema reference ${current.$ref}`);
    assert.equal(seen.has(current.$ref), false, `cyclic schema reference ${current.$ref}`);
    seen.add(current.$ref);
    current = current.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  }
  return current;
}

function resultText(result) {
  return result?.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result?.structuredContent ?? result);
}

function serialized(value) {
  return JSON.stringify(value) ?? '';
}

function assertNoRawLiterals(value, literals, label) {
  const text = serialized(value);
  for (const literal of literals) assert.equal(text.includes(literal), false, `${label} leaked ${literal}`);
}

class McpStdioClient {
  constructor(root, targetRoot, mode, toolCards) {
    this.stderr = '';
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    const allowedRoots = [root, path.dirname(targetRoot), targetRoot].join(path.delimiter);
    this.child = spawn(process.execPath, [
      'dist/stdio.js',
      '--root', root,
      '--allow-root', path.dirname(targetRoot),
      '--allow-root', targetRoot,
      '--bash', 'off',
      '--write', 'off',
      '--tool-mode', mode
    ], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CODEXPRO_ROOT: root,
        CODEXPRO_ALLOWED_ROOTS: allowedRoots,
        CODEXPRO_TOOL_CARDS: toolCards ? '1' : '0',
        CODEXPRO_CODEX_SESSIONS: 'off',
        CODEXPRO_BASH_MODE: 'off',
        CODEXPRO_WRITE_MODE: 'off'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => { this.stderr += String(chunk); });
    this.child.on('exit', (code, signal) => {
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
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
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
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr=${this.stderr}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      timer.unref();
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill('SIGTERM');
    });
  }
}

async function startClient(root, targetRoot, mode, toolCards) {
  const client = new McpStdioClient(root, targetRoot, mode, toolCards);
  const initialize = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'git-mcp-surface-smoke', version: '1.0.0' }
  });
  client.notify('notifications/initialized');
  return { client, initialize };
}

async function callTool(client, name, args) {
  try {
    const result = await client.request('tools/call', { name, arguments: args });
    return { result, protocolError: false, text: resultText(result) };
  } catch (error) {
    return { result: null, protocolError: true, text: error instanceof Error ? error.message : String(error) };
  }
}

function expectSuccess(out, label) {
  assert.equal(out.protocolError, false, `${label} returned a protocol error: ${out.text}`);
  assert.notEqual(out.result?.isError, true, `${label} failed: ${out.text}`);
  assert.ok(out.result?.structuredContent && typeof out.result.structuredContent === 'object', `${label} omitted structuredContent`);
  return out.result;
}

function expectError(out, label) {
  if (out.protocolError) return out.text;
  assert.equal(out.result?.isError, true, `${label} unexpectedly succeeded: ${out.text}`);
  return out.text;
}

function assertPublicEnvelope(data, workspaceId, canonicalRoot, label) {
  assert.equal(data.schema_version, 1, `${label} omitted schema_version=1`);
  assert.equal(data.workspace_id, workspaceId, `${label} returned wrong workspace_id`);
  assert.equal(data.root, canonicalRoot, `${label} returned wrong canonical root`);
}

function assertNoToolCards(tool, label) {
  const meta = tool?._meta ?? {};
  assert.equal(meta.ui, undefined, `${label} exposed widget ui metadata`);
  assert.equal(meta['openai/outputTemplate'], undefined, `${label} exposed an output template`);
}

async function repositorySnapshot(root) {
  const paths = ['HEAD', 'refs', 'reflogs', 'index', 'staged', 'unstaged', 'untracked', 'status', 'config', 'remotes'];
  const commands = {
    HEAD: ['rev-parse', '--verify', 'HEAD'],
    refs: ['for-each-ref', '--format=%(refname)%00%(objectname)%00'],
    reflogs: ['reflog', 'show', '--all', '--format=%H%x00%gD%x00%gs%x00'],
    index: ['ls-files', '--stage', '-z'],
    staged: ['diff', '--cached', '--binary', '--no-ext-diff'],
    unstaged: ['diff', '--binary', '--no-ext-diff'],
    untracked: ['ls-files', '--others', '--exclude-standard', '-z'],
    status: ['status', '--porcelain=v1', '--branch'],
    config: ['config', '--local', '--null', '--list'],
    remotes: ['remote', '-v']
  };
  const result = {};
  for (const key of paths) result[key] = directGit(root, commands[key]).toString('base64');
  return result;
}

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'codexpro-git-mcp-surface-'));
const defaultRoot = path.join(fixtureRoot, 'default-repo');
const targetParent = path.join(fixtureRoot, 'allowed-parent');
const targetRoot = path.join(targetParent, 'target-repo');
let firstClient;
let secondClient;
try {
  await mkdir(defaultRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });

  for (const root of [defaultRoot, targetRoot]) {
    directGit(root, ['init', '--quiet']);
    directGit(root, ['config', 'user.name', 'MCP Surface Fixture']);
    directGit(root, ['config', 'user.email', 'mcp-surface-fixture@example.test']);
    directGit(root, ['config', 'core.logAllRefUpdates', 'true']);
  }

  await writeFile(path.join(defaultRoot, 'default.txt'), `${DEFAULT_SENTINEL}\n`, 'utf8');
  directGit(defaultRoot, ['add', 'default.txt']);
  const defaultSha = commitFixture(defaultRoot, `default sentinel ${DEFAULT_SENTINEL}`);

  const rawSource = [
    'before historical source',
    '-----BEGIN PRIVATE KEY-----',
    SOURCE_SECRET,
    '-----END PRIVATE KEY-----',
    'after historical source',
    ''
  ].join('\n');
  await writeFile(path.join(targetRoot, 'history.txt'), rawSource, 'utf8');
  await writeFile(path.join(targetRoot, 'target.txt'), `${TARGET_SENTINEL} root\n`, 'utf8');
  directGit(targetRoot, ['add', 'history.txt', 'target.txt']);
  const targetRootSha = commitFixture(targetRoot, 'target root subject', `OPENAI_API_KEY=${COMMIT_SECRET}\nroot body exact`);
  await writeFile(path.join(targetRoot, 'target.txt'), `${TARGET_SENTINEL} tip\n`, 'utf8');
  directGit(targetRoot, ['add', 'target.txt']);
  const targetHeadSha = commitFixture(targetRoot, 'target tip subject', 'target tip body');

  const targetRootCommit = directCommit(targetRoot, targetRootSha);
  const targetHeadCommit = directCommit(targetRoot, targetHeadSha);
  const rawSourceBytes = Buffer.from(rawSource, 'utf8');
  const targetObjectFormat = gitText(targetRoot, ['rev-parse', '--show-object-format']);
  const directLogIds = gitText(targetRoot, ['rev-list', '--max-count=2', 'HEAD']).split('\n').filter(Boolean);
  const directMergeBase = gitText(targetRoot, ['merge-base', 'HEAD', 'HEAD~1']);
  const historyBlobSha = gitText(targetRoot, ['ls-tree', '-r', '--format=%(objectname)', targetRootSha, '--', 'history.txt']);
  const targetCanonicalRoot = await realpath(targetRoot);
  const defaultCanonicalRoot = await realpath(defaultRoot);

  // PASS 1: direct facts and the accepted A002/P002 authority are established
  // before any public-tool result is interpreted.
  assert.equal(defaultSha.length, 40);
  assert.equal(targetRootSha, directMergeBase);
  assert.deepEqual(directLogIds, [targetHeadSha, targetRootSha]);
  assert.equal(targetRootCommit.parents.length, 0);
  assert.deepEqual(targetHeadCommit.parents, [targetRootSha]);
  assert.equal(rawSourceBytes.includes(Buffer.from(SOURCE_SECRET, 'utf8')), true);
  assert.equal(targetRootCommit.body.includes(COMMIT_SECRET), true);
  console.log('AUTHORITY: A002 MISSION_ANCHOR/MISSION_PLAN P002 TASK-006 AP-009/AP-010 and AC-005/AC-006/AC-007 define the expected public outcome.');
  console.log(`TARGET_EVIDENCE: direct Git object database in disposable roots; default=${defaultCanonicalRoot}, target=${targetCanonicalRoot}; no production 8787 route used.`);
  console.log(`RAW_OBSERVATION: default HEAD=${defaultSha} contains only ${DEFAULT_SENTINEL}; target HEAD=${targetHeadSha}, parent/root=${targetRootSha}, direct merge-base=${directMergeBase}.`);
  console.log(`RAW_OBSERVATION: direct target log=${JSON.stringify(directLogIds)}, root parents=${JSON.stringify(targetRootCommit.parents)}, tip parents=${JSON.stringify(targetHeadCommit.parents)}, object format=${targetObjectFormat}.`);
  console.log(`RAW_OBSERVATION: history.txt raw bytes=${rawSourceBytes.byteLength}, raw source contains private-key marker/body, direct blob SHA=${historyBlobSha}; root commit raw message contains a secret-looking token.`);
  console.log('SANITY_VERDICT: MATCH — raw facts provide an unambiguous target-vs-default distinction and the exact commit/path/source invariants required by the accepted outcome.');
  console.log('PREDICATE: TRUE — target root is the direct merge-base and parent of target HEAD; history.txt exists only in the target root commit tree and its raw bytes contain the private-key body.');

  // Full mode exposure/schema/annotation proof, including cards opt-in.
  const fullSession = await startClient(defaultRoot, targetRoot, 'full', true);
  firstClient = fullSession.client;
  assert.match(String(fullSession.initialize?.instructions ?? ''), /explicit workspace_id/iu, 'server instructions omitted explicit workspace_id guidance');
  const fullListing = await firstClient.request('tools/list', {});
  const fullTools = fullListing.tools ?? [];
  const fullNames = fullTools.map((tool) => tool.name);
  const fullByName = new Map(fullTools.map((tool) => [tool.name, tool]));
  assert.deepEqual(
    GIT_REVIEW_TOOLS.filter((name) => !fullNames.includes(name)),
    [],
    `full mode omitted a Git review tool: ${fullNames.join(', ')}`
  );
  assert.deepEqual(fullNames.filter((name) => GIT_REVIEW_TOOLS.includes(name)).sort(), [...GIT_REVIEW_TOOLS].sort());
  for (const name of GIT_REVIEW_TOOLS) {
    const tool = fullByName.get(name);
    assert.ok(tool, `full mode did not expose ${name}`);
    assertNoToolCards(tool, name);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} is not read-only annotated`);
    assert.equal(tool.annotations?.destructiveHint, false, `${name} is destructively annotated`);
    assert.equal(tool.annotations?.openWorldHint, false, `${name} is open-world annotated`);
    const schema = resolveSchema(tool.inputSchema, tool.inputSchema);
    assert.equal(schema?.type, 'object', `${name} schema is not an object`);
    assert.equal(schema?.additionalProperties, false, `${name} schema accepts unknown keys`);
    assert.ok(schema?.required?.includes('workspace_id'), `${name} schema does not require workspace_id`);
    assert.equal(schema.properties?.workspace_id?.type, 'string', `${name} workspace_id schema is not string`);
  }
  console.log(`PASS exposure/schema/annotations: full mode exposes exactly ${GIT_REVIEW_TOOLS.join(', ')} among new Git tools; all require workspace_id, reject unknown keys, and have readOnly=true/destructive=false/openWorld=false.`);

  for (const mode of ['standard', 'minimal']) {
    const modeSession = await startClient(defaultRoot, targetRoot, mode, false);
    try {
      const listing = await modeSession.client.request('tools/list', {});
      const names = (listing.tools ?? []).map((tool) => tool.name);
      assert.equal(names.some((name) => GIT_REVIEW_TOOLS.includes(name)), false, `${mode} mode exposed a full-only Git review tool: ${names.join(', ')}`);
    } finally {
      await modeSession.client.close();
    }
  }
  console.log('PASS mode boundary: standard and minimal tools/list omit all five Git review tools.');

  // Initial ordinary MCP open obtains the stable target ID. The next process
  // is deliberately fresh and receives only the explicit deterministic ID.
  const opened = await callTool(firstClient, 'open_workspace', { path: targetRoot, include_tree: false });
  const openedResult = expectSuccess(opened, 'initial open_workspace');
  const openedData = openedResult.structuredContent;
  const workspaceId = openedData.workspace_id;
  assert.match(workspaceId, /^ws_[a-f0-9]{24}$/u);
  assert.equal(openedData.root, targetCanonicalRoot);
  await firstClient.close();
  firstClient = undefined;

  secondClient = (await startClient(defaultRoot, targetRoot, 'full', false)).client;
  const before = await repositorySnapshot(targetRoot);
  const explicitResolveResult = expectSuccess(
    await callTool(secondClient, 'git_resolve_ref', { workspace_id: workspaceId, ref: 'HEAD' }),
    'explicit git_resolve_ref'
  );
  const explicitResolve = explicitResolveResult.structuredContent;
  assertPublicEnvelope(explicitResolve, workspaceId, targetCanonicalRoot, 'git_resolve_ref');
  assert.equal(explicitResolve.full_sha, targetHeadSha);
  assert.equal(explicitResolve.short_sha, targetHeadSha.slice(0, 12));
  assert.equal(explicitResolve.object_format, targetObjectFormat);

  const explicitMergeResult = expectSuccess(
    await callTool(secondClient, 'git_merge_base', { workspace_id: workspaceId, left_ref: 'HEAD', right_ref: 'HEAD~1' }),
    'explicit git_merge_base'
  );
  const explicitMerge = explicitMergeResult.structuredContent;
  assertPublicEnvelope(explicitMerge, workspaceId, targetCanonicalRoot, 'git_merge_base');
  assert.equal(explicitMerge.object_format, targetObjectFormat);
  assert.deepEqual(explicitMerge.merge_bases, [directMergeBase]);
  assert.equal(explicitMerge.left_is_ancestor, false);
  assert.equal(explicitMerge.right_is_ancestor, true);
  assert.equal(explicitMerge.unrelated, false);
  assert.equal(explicitMerge.history_complete, true);

  const explicitLogResult = expectSuccess(
    await callTool(secondClient, 'git_log', { workspace_id: workspaceId, start_ref: 'HEAD', max_count: 1 }),
    'explicit git_log'
  );
  const explicitLog = explicitLogResult.structuredContent;
  assertPublicEnvelope(explicitLog, workspaceId, targetCanonicalRoot, 'git_log');
  assert.equal(explicitLog.start.full_sha, targetHeadSha);
  assert.equal(explicitLog.commits.length, 1);
  assert.equal(explicitLog.commits[0].full_sha, targetHeadSha);
  assert.equal(explicitLog.commits[0].short_sha, targetHeadSha.slice(0, 12));
  assert.deepEqual(explicitLog.commits[0].parents, [targetRootSha]);
  assert.equal(explicitLog.commits[0].subject, targetHeadCommit.subject);
  assert.equal(explicitLog.has_more, true);

  const explicitShowResult = expectSuccess(
    await callTool(secondClient, 'git_show_commit', { workspace_id: workspaceId, ref: targetRootSha }),
    'explicit git_show_commit'
  );
  const explicitShow = explicitShowResult.structuredContent;
  assertPublicEnvelope(explicitShow, workspaceId, targetCanonicalRoot, 'git_show_commit');
  assert.equal(explicitShow.ref.full_sha, targetRootSha);
  assert.equal(explicitShow.commit_sha, targetRootSha);
  assert.equal(explicitShow.object_format, targetObjectFormat);
  assert.equal(explicitShow.tree_sha, targetRootCommit.treeSha);
  assert.deepEqual(explicitShow.parents, targetRootCommit.parents);
  assert.equal(explicitShow.is_root, true);
  assert.equal(explicitShow.is_merge, false);
  assert.equal(explicitShow.author_name, targetRootCommit.authorName);
  assert.equal(explicitShow.authored_at, targetRootCommit.authoredAt);
  assert.equal(explicitShow.committer_name, targetRootCommit.committerName);
  assert.equal(explicitShow.committed_at, targetRootCommit.committedAt);
  assert.equal(explicitShow.subject, targetRootCommit.subject);
  assert.equal(explicitShow.message_bytes, targetRootCommit.messageBytes);
  assert.equal(explicitShow.message_truncated, false);
  assert.match(explicitShow.body, /\[REDACTED_SECRET\]/u, 'git_show_commit did not redact the secret-looking commit message');
  assertNoRawLiterals(explicitShowResult, [COMMIT_SECRET], 'git_show_commit complete public response');

  const explicitReadResult = expectSuccess(
    await callTool(secondClient, 'read_at_ref', { workspace_id: workspaceId, ref: targetRootSha, path: 'history.txt' }),
    'explicit read_at_ref'
  );
  const explicitRead = explicitReadResult.structuredContent;
  assertPublicEnvelope(explicitRead, workspaceId, targetCanonicalRoot, 'read_at_ref');
  assert.equal(explicitRead.ref.full_sha, targetRootSha);
  assert.equal(explicitRead.object_format, targetObjectFormat);
  assert.equal(explicitRead.commit_sha, targetRootSha);
  assert.equal(explicitRead.path, 'history.txt');
  assert.equal(explicitRead.git_mode, '100644');
  assert.equal(explicitRead.entry_kind, 'file');
  assert.equal(explicitRead.blob_sha, historyBlobSha);
  assert.equal(explicitRead.bytes, rawSourceBytes.byteLength);
  assert.equal(explicitRead.sha256, sha256(rawSourceBytes));
  assert.equal(explicitRead.start_line, 1);
  assert.equal(explicitRead.total_lines, rawSource.split('\n').length);
  assert.equal(explicitRead.end_line, explicitRead.total_lines);
  assert.equal(explicitRead.truncated, false);
  assert.match(explicitRead.text, /\[REDACTED_PRIVATE_KEY\]/u, 'read_at_ref did not preserve typed public source redaction');
  assertNoRawLiterals(explicitReadResult, [SOURCE_SECRET], 'read_at_ref complete public response');
  for (const [label, result] of [['resolve', explicitResolve], ['merge', explicitMerge], ['log', explicitLog], ['show', explicitShow], ['read', explicitRead]]) {
    assertNoRawLiterals(result, [DEFAULT_SENTINEL], `${label} explicit target response`);
  }
  console.log('PASS fresh-session explicit target: all five tools returned direct target commit/tree/blob truth with schema_version/root/workspace metadata; commit metadata was generically redacted and historical source retained typed redaction.');

  const omissionCalls = [
    ['git_resolve_ref', { ref: 'HEAD' }],
    ['git_merge_base', { left_ref: 'HEAD', right_ref: 'HEAD~1' }],
    ['git_log', { start_ref: 'HEAD', max_count: 1 }],
    ['git_show_commit', { ref: 'HEAD' }],
    ['read_at_ref', { ref: 'HEAD', path: 'default.txt' }]
  ];
  for (const [name, args] of omissionCalls) {
    const out = await callTool(secondClient, name, args);
    const error = expectError(out, `${name} omitted workspace_id`);
    assert.match(error, /workspace_id/iu, `${name} omission error did not identify workspace_id`);
    assertNoRawLiterals(out.result ?? { error }, [DEFAULT_SENTINEL, TARGET_SENTINEL], `${name} omission response`);
  }
  console.log('PASS missing-ID boundary: each fresh-session Git call rejected before default/session fallback; no default sentinel or target content was returned.');

  const unknownCalls = [
    ['git_resolve_ref', { workspace_id: workspaceId, ref: 'HEAD' }],
    ['git_merge_base', { workspace_id: workspaceId, left_ref: 'HEAD', right_ref: 'HEAD~1' }],
    ['git_log', { workspace_id: workspaceId, start_ref: 'HEAD', max_count: 1 }],
    ['git_show_commit', { workspace_id: workspaceId, ref: 'HEAD' }],
    ['read_at_ref', { workspace_id: workspaceId, ref: 'HEAD', path: 'history.txt' }]
  ];
  for (const [name, args] of unknownCalls) {
    const out = await callTool(secondClient, name, { ...args, unknown_key: 'reject-me' });
    const error = expectError(out, `${name} unknown key`);
    assert.match(error, /unknown|unrecognized|invalid arguments/iu, `${name} unknown-key error was not a schema rejection: ${error}`);
    assertNoRawLiterals(out.result ?? { error }, [DEFAULT_SENTINEL, TARGET_SENTINEL], `${name} unknown-key response`);
  }
  console.log('PASS strict unknown-key boundary: all five explicit schemas/handlers rejected an extra top-level key.');

  await secondClient.close();
  secondClient = undefined;
  const after = await repositorySnapshot(targetRoot);
  assert.deepEqual(after, before, 'public MCP Git calls changed target repository state');
  console.log('RAW_OBSERVATION: target HEAD, refs/reflogs, index, staged/unstaged/untracked state, local config, and remotes matched before/after public calls.');
  console.log('SANITY_VERDICT: MATCH — the public fresh-session reviewer calls preserved the direct target object identity and did not mutate the disposable repository.');
  console.log('GIT_MCP_SURFACE_SMOKE: PASS (AP-009/AP-010 focused public-surface proof).');
} finally {
  await firstClient?.close();
  await secondClient?.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
