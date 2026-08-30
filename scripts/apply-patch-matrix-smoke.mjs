import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// This is a target-behavior test.  The producer is Git, the route is the real
// MCP apply_patch tool, and the expected files come from an independent Git
// producer repository rather than from the implementation under test.
class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
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

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
}

function resultText(result) {
  return result?.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result?.structuredContent);
}

function runGit(cwd, args, input = undefined, extraEnv = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv }
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result;
}

async function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

async function writeArtifact(root, relativePath, content) {
  const target = path.join(root, 'artifacts', relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

async function initRepo(root, files, options = {}) {
  await fs.mkdir(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    await writeFile(root, relativePath, content);
    const mode = options.fileModes?.[relativePath];
    if (!Number.isInteger(mode)) continue;
    await fs.chmod(path.join(root, relativePath), mode);
  }
  runGit(root, ['init', '-q']);
  runGit(root, ['config', 'user.name', 'CodexPro apply matrix']);
  runGit(root, ['config', 'user.email', 'codexpro-apply-matrix@example.invalid']);
  runGit(root, ['config', 'core.quotePath', options.quotePath === false ? 'false' : 'true']);
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '--allow-empty', '-qm', 'matrix baseline']);
}

async function snapshotWorkspace(root) {
  const result = new Map();
  async function visit(directory, prefix = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relativePath === '.git' || relativePath.startsWith('.git/')) continue;
      const absolutePath = path.join(directory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (stat.isSymbolicLink()) {
        result.set(relativePath, { kind: 'symlink', target: await fs.readlink(absolutePath), mode: stat.mode & 0o7777 });
      } else if (stat.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        result.set(relativePath, { kind: 'file', bytes: bytes.toString('base64'), mode: stat.mode & 0o7777 });
      } else {
        result.set(relativePath, { kind: 'other', mode: stat.mode & 0o7777 });
      }
    }
  }
  await visit(root);
  return result;
}

async function rawDirectoryEntries(root) {
  const entries = await fs.readdir(root, { encoding: 'buffer' });
  return entries.filter((entry) => entry.toString('utf8') !== '.git').map((entry) => entry.toString('hex')).sort();
}

function gitIndexState(root) {
  const result = spawnSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root,
    encoding: null,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ls-files --stage failed in ${root}: ${result.stderr?.toString() || result.error?.message}`);
  }
  return result.stdout;
}

function snapshotJson(snapshot) {
  return JSON.stringify([...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedModeSnapshot(sourceSnapshot, targetSnapshot, modeTolerancePaths) {
  if (!Array.isArray(modeTolerancePaths) || modeTolerancePaths.length === 0) return sourceSnapshot;
  const normalized = new Map(sourceSnapshot);
  for (const relativePath of modeTolerancePaths) {
    const sourceEntry = sourceSnapshot.get(relativePath);
    const targetEntry = targetSnapshot.get(relativePath);
    if (!sourceEntry || !targetEntry) continue;
    if (sourceEntry.kind !== targetEntry.kind) continue;
    if (sourceEntry.kind === 'file') {
      normalized.set(relativePath, { ...sourceEntry, mode: targetEntry.mode });
    } else if (sourceEntry.kind === 'symlink' || sourceEntry.kind === 'other') {
      normalized.set(relativePath, { ...sourceEntry, mode: targetEntry.mode });
    }
  }
  return normalized;
}

function canonicalDiff(root, staged = false) {
  const args = [
    '-c', 'core.autocrlf=false', '-c', 'core.filemode=true', '-c', 'core.quotepath=true',
    'diff', ...(staged ? ['--cached'] : []), '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--binary',
    '--src-prefix=a/', '--dst-prefix=b/', '--find-renames', '--find-copies', '--find-copies-harder'
  ];
  return runGit(root, args).stdout;
}

function parseNumstat(output) {
  const records = String(output).split('\0');
  if (records.at(-1) === '') records.pop();
  const entries = [];
  const paths = [];
  let additions = 0;
  let deletions = 0;
  for (let index = 0; index < records.length; index += 1) {
    const firstTab = records[index].indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : records[index].indexOf('\t', firstTab + 1);
    const add = firstTab < 0 ? '' : records[index].slice(0, firstTab);
    const del = secondTab < 0 ? '' : records[index].slice(firstTab + 1, secondTab);
    const target = secondTab < 0 ? '' : records[index].slice(secondTab + 1);
    if (target) {
      entries.push({ additions: add, deletions: del, path: target });
      paths.push(target);
    } else {
      entries.push({ additions: add, deletions: del, path: records[index + 2] });
      paths.push(records[index + 1], records[index + 2]);
      index += 2;
    }
    additions += add === '-' ? 0 : Number(add);
    deletions += del === '-' ? 0 : Number(del);
  }
  return { paths, additions, deletions, records: entries };
}

function preflightEvidence(root, patch) {
  const result = spawnSync('git', ['apply', '--check', '--numstat', '-z', '--verbose', '--whitespace=nowarn'], {
    cwd: root,
    input: patch,
    encoding: 'utf8',
    env: { ...process.env }
  });
  if (result.error) throw result.error;
  const reverse = spawnSync('git', ['apply', '--reverse', '--numstat', '-z', '--whitespace=nowarn'], {
    cwd: root,
    input: patch,
    encoding: 'utf8',
    env: { ...process.env }
  });
  if (reverse.error) throw reverse.error;
  return {
    ...result,
    numstat: result.status === 0 ? parseNumstat(result.stdout) : null,
    reverse,
    reverseNumstat: reverse.status === 0 ? parseNumstat(reverse.stdout) : null
  };
}

function actualNumstat(root, staged = false) {
  return parseNumstat(runGit(root, [
    '-c', 'core.autocrlf=false', '-c', 'core.filemode=true', '-c', 'core.quotepath=true',
    'diff', ...(staged ? ['--cached'] : []), '--numstat', '-z', '--no-ext-diff', '--no-textconv', '--find-renames', '--find-copies', '--find-copies-harder'
  ]).stdout);
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function responseOrderFromPreflight(preflight) {
  const reverse = [...(preflight.reverseNumstat?.records ?? [])].reverse();
  const paths = [];
  for (const [index, forward] of (preflight.numstat?.records ?? []).entries()) {
    const oldPath = reverse[index]?.path;
    if (oldPath && oldPath !== forward.path && !paths.includes(oldPath)) paths.push(oldPath);
    if (!paths.includes(forward.path)) paths.push(forward.path);
  }
  return paths;
}

async function openWorkspace(client, root) {
  const opened = await client.request('tools/call', { name: 'open_workspace', arguments: { root, include_tree: false } });
  assert.notEqual(opened.isError, true, `open_workspace failed: ${resultText(opened)}`);
  return opened.structuredContent.workspace_id;
}

async function generatedCase(client, suiteRoot, label, files, mutate, expectedIdentities, options = {}) {
  const caseRoot = path.join(suiteRoot, label);
  const producer = path.join(caseRoot, 'producer');
  const target = path.join(caseRoot, 'target');
  await initRepo(producer, files, options);
  await initRepo(target, files, options);
  await mutate(producer);
  runGit(producer, ['add', '-A']);
  const patch = canonicalDiff(producer, true);
  assert.ok(patch, `${label} producer emitted no patch`);
  const expected = await snapshotWorkspace(producer);
  const before = await snapshotWorkspace(target);
  const targetHeadBefore = runGit(target, ['rev-parse', 'HEAD']).stdout.trim();
  const preflight = preflightEvidence(target, patch);
  assert.equal(preflight.status, 0, `${label} independent Git preflight failed: ${preflight.stderr}`);
  assert.ok(preflight.numstat.paths.length, `${label} independent preflight omitted paths`);
  // `--numstat -z` emits only the new side for rename/copy pairs; quoted
  // paths may also be octal-escaped in the verbose human stream. The raw
  // preflight itself is the evidence boundary, while the exact identity set
  // is proven independently by the producer snapshot and returned paths.
  assert.match(String(preflight.stderr), /Checking patch /, `${label} preflight omitted Git's path check`);
  if (preflight.reverseNumstat) {
    assert.deepEqual(
      sortedUnique([...preflight.numstat.paths, ...preflight.reverseNumstat.paths]),
      sortedUnique(expectedIdentities),
      `${label} forward/reverse Git preflight did not establish every expected identity`
    );
  } else {
    assert.ok(expectedIdentities.every((item) => preflight.numstat.paths.includes(item) || patch.includes(item)), `${label} preflight omitted an identity`);
  }
  const workspaceId = await openWorkspace(client, target);
  const response = await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: workspaceId, patch } });
  assert.notEqual(response.isError, true, `${label} apply_patch failed: ${resultText(response)}`);
  const structured = response.structuredContent;
  assert.deepEqual(sortedUnique(structured.paths ?? []), sortedUnique(expectedIdentities), `${label} returned paths do not identify the Git objects`);
  const expectedResponseOrder = options.expectedResponseOrder === 'direct-preflight'
    ? responseOrderFromPreflight(preflight)
    : options.expectedResponseOrder;
  if (expectedResponseOrder) {
    assert.deepEqual(structured.paths, expectedResponseOrder, `${label} changed Git producer identity order`);
  }
  const after = await snapshotWorkspace(target);
  if (expectedIdentities.length > 1) {
    console.log(`RAW ${label}: response.paths=${JSON.stringify(structured.paths)} filesystem.entries=${JSON.stringify([...after.keys()].sort())}`);
  }
  const expectedForComparison = normalizedModeSnapshot(expected, after, options.modeTolerancePaths);
  assert.equal(snapshotJson(after), snapshotJson(expectedForComparison), `${label} real filesystem differs from the independent Git producer result`);
  assert.equal(runGit(target, ['rev-parse', 'HEAD']).stdout.trim(), targetHeadBefore, `${label} real apply changed HEAD`);
  // Untracked create/copy targets are not present in an unstaged `git diff`.
  // Stage only in this disposable target to ask Git for the complete direct
  // result, then restore the index without touching the worktree.
  runGit(target, ['add', '-A']);
  const actualDiff = canonicalDiff(target, true);
  const actual = actualNumstat(target, true);
  const actualIndex = gitIndexState(target);
  runGit(target, ['reset', '-q']);
  assert.equal(structured.diff, actualDiff, `${label} returned diff differs from direct Git result`);
  assert.equal(structured.additions, actual.additions, `${label} returned additions differ from Git numstat`);
  assert.equal(structured.deletions, actual.deletions, `${label} returned deletions differ from Git numstat`);
  assert.equal(structured.changed, Boolean(actualDiff.trim()), `${label} changed flag disagrees with direct filesystem diff`);
  return { patch, target, producer, response, expected, before, after, actual, actualDiff, preflight, actualIndex };
}

async function rejectedCase(client, suiteRoot, label, files, patchFactory, expectedPattern) {
  const caseRoot = path.join(suiteRoot, label);
  const target = path.join(caseRoot, 'target');
  await initRepo(target, files);
  const before = await snapshotWorkspace(target);
  const patch = await patchFactory(target);
  const workspaceId = await openWorkspace(client, target);
  const response = await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: workspaceId, patch } });
  assert.equal(response.isError, true, `${label} unexpectedly succeeded: ${resultText(response)}`);
  if (expectedPattern) assert.match(resultText(response), expectedPattern, `${label} error did not identify the expected failure`);
  assert.equal(snapshotJson(await snapshotWorkspace(target)), snapshotJson(before), `${label} rejection changed workspace bytes/types`);
  return { patch, target, response };
}

const expectedAuthority = 'current user launcher: Git preflight paths/counts, exact simulation, locked repeat, real Git apply, and byte-preserving rejection.';
console.log(`PASS 1 EXPECTED FACTS: real Git object paths/filesystem effects; rejection means unchanged bytes. Authority: ${expectedAuthority}`);
console.log('TARGET_EVIDENCE: real local Git preflight/apply plus target filesystem and MCP response; fixtures are input only.');

const suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-apply-matrix-'));
let client;
const matrix = [];
try {
  client = new McpStdioClient('node', ['dist/stdio.js', '--root', suiteRoot, '--allow-root', suiteRoot, '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: { ...process.env, CODEXPRO_ROOT: suiteRoot, CODEXPRO_ALLOWED_ROOTS: suiteRoot, CODEXPRO_WRITE_MODE: 'workspace' }
  });
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codexpro-apply-patch-matrix', version: '0.1.0' } });
  client.notify('notifications/initialized');

  const oneFile = { 'ordinary.txt': 'alpha\nbeta\nomega\n' };
  await generatedCase(client, suiteRoot, 'A-ordinary-modification', oneFile, async (root) => writeFile(root, 'ordinary.txt', 'alpha\nBETA\nomega\n'), ['ordinary.txt']);
  matrix.push('A');

  await generatedCase(client, suiteRoot, 'B-create', {}, async (root) => writeFile(root, 'created.txt', 'created\n'), ['created.txt']);
  matrix.push('B');

  await generatedCase(client, suiteRoot, 'C-delete', { 'deleted.txt': 'remove me\n' }, async (root) => fs.unlink(path.join(root, 'deleted.txt')), ['deleted.txt']);
  matrix.push('C');

  await generatedCase(client, suiteRoot, 'D-multi-file', { 'one.txt': 'one\n', 'two.txt': 'two\n', 'keep.txt': 'keep\n' }, async (root) => {
    await writeFile(root, 'one.txt', 'ONE\n');
    await writeFile(root, 'two.txt', 'TWO\n');
  }, ['one.txt', 'two.txt']);
  matrix.push('D');

  const mixedRecords = await generatedCase(client, suiteRoot, 'MIXED-RECORDS', {
    'mixed-modify.txt': 'modify before\n',
    'mixed-delete.txt': 'delete me\n',
    'mixed-rename-old.txt': 'rename me\n',
    'mixed-copy-source.txt': 'copy me\n',
    'mixed-keep.txt': 'keep me\n'
  }, async (root) => {
    await writeFile(root, 'mixed-modify.txt', 'modify after\n');
    await fs.unlink(path.join(root, 'mixed-delete.txt'));
    await fs.rename(path.join(root, 'mixed-rename-old.txt'), path.join(root, 'mixed-rename-new.txt'));
    await fs.copyFile(path.join(root, 'mixed-copy-source.txt'), path.join(root, 'mixed-copy-new.txt'));
    await writeFile(root, 'mixed-create.txt', 'create me\n');
  }, [
    'mixed-modify.txt', 'mixed-delete.txt', 'mixed-rename-old.txt', 'mixed-rename-new.txt',
    'mixed-copy-source.txt', 'mixed-copy-new.txt', 'mixed-create.txt'
  ], { expectedResponseOrder: 'direct-preflight' });
  assert.equal(mixedRecords.preflight.numstat.records.length, mixedRecords.preflight.reverseNumstat.records.length, 'mixed records changed Git forward/reverse record count');
  for (const [index, forward] of mixedRecords.preflight.numstat.records.entries()) {
    const reverse = mixedRecords.preflight.reverseNumstat.records.slice().reverse()[index];
    assert.equal(forward.additions, reverse.deletions, `mixed record ${index} did not swap forward additions/reverse deletions`);
    assert.equal(forward.deletions, reverse.additions, `mixed record ${index} did not swap forward deletions/reverse additions`);
  }
  matrix.push('MIXED-RECORDS');

  const binaryCase = await generatedCase(client, suiteRoot, 'BINARY-PATCH', {
    'payload.bin': Buffer.from([0x00, 0x01, 0x7f, 0xff, 0x0a])
  }, async (root) => writeFile(root, 'payload.bin', Buffer.from([0x00, 0x02, 0x7f, 0xfe, 0x0a])), ['payload.bin']);
  assert.equal(binaryCase.response.structuredContent.additions, 0, 'binary patch reported textual additions instead of Git - count');
  assert.equal(binaryCase.response.structuredContent.deletions, 0, 'binary patch reported textual deletions instead of Git - count');
  matrix.push('BINARY');

  const executableCase = await generatedCase(client, suiteRoot, 'EXECUTABLE-MODE', {
    'executable.sh': '#!/bin/sh\nexit 0\n'
  }, async (root) => fs.chmod(path.join(root, 'executable.sh'), 0o755), ['executable.sh'], {
    fileModes: { 'executable.sh': 0o644 },
    modeTolerancePaths: ['executable.sh']
  });
  const executableOracleRoot = path.join(suiteRoot, 'EXECUTABLE-MODE', 'oracle-direct-git');
  await initRepo(executableOracleRoot, {
    'executable.sh': '#!/bin/sh\nexit 0\n'
  }, {
    fileModes: { 'executable.sh': 0o644 }
  });
  runGit(executableOracleRoot, ['apply', '--index', '--whitespace=nowarn'], executableCase.patch);
  const executableOracle = await snapshotWorkspace(executableOracleRoot);
  assert.equal(snapshotJson(executableCase.after), snapshotJson(executableOracle), 'EXECUTABLE-MODE direct Git oracle snapshot diverged');
  const executableCaseMode = (await fs.lstat(path.join(executableCase.target, 'executable.sh'))).mode & 0o7777;
  const executableOracleMode = (await fs.lstat(path.join(executableOracleRoot, 'executable.sh'))).mode & 0o7777;
  console.log(`RAW EXECUTABLE-MODE: mcp=0${executableCaseMode.toString(8).padStart(4, '0')} direct-git=0${executableOracleMode.toString(8).padStart(4, '0')}`);
  assert.equal(executableCaseMode, executableOracleMode, 'EXECUTABLE-MODE final physical mode did not match direct Git result');
  const executableIndexMode = executableCase.actualIndex.toString().trim().split('\n')[0]?.split(/\s+/)[0];
  assert.equal(executableIndexMode, '100755', 'executable mode patch did not produce Git index mode 100755');
  matrix.push('EXECUTABLE-MODE');

  await generatedCase(client, suiteRoot, 'E-rename', { 'rename-old.txt': 'rename content\n' }, async (root) => fs.rename(path.join(root, 'rename-old.txt'), path.join(root, 'rename-new.txt')), ['rename-old.txt', 'rename-new.txt']);
  matrix.push('E');

  await generatedCase(client, suiteRoot, 'F-copy', { 'copy-source.txt': 'copy content\n' }, async (root) => fs.copyFile(path.join(root, 'copy-source.txt'), path.join(root, 'copy-dest.txt')), ['copy-source.txt', 'copy-dest.txt']);
  matrix.push('F');

  const quotedSource = 'g\\old\t"é.txt';
  const quotedRenameDest = 'g-renamed.txt';
  await generatedCase(client, suiteRoot, 'G-rename-literal-backslash-source', { [quotedSource]: 'quoted source\n' }, async (root) => fs.rename(path.join(root, quotedSource), path.join(root, quotedRenameDest)), [quotedSource, quotedRenameDest]);
  matrix.push('G');

  const quotedDestination = 'h\\new\t"é.txt';
  await generatedCase(client, suiteRoot, 'H-rename-literal-backslash-destination', { 'h-old.txt': 'quoted destination\n' }, async (root) => fs.rename(path.join(root, 'h-old.txt'), path.join(root, quotedDestination)), ['h-old.txt', quotedDestination]);
  matrix.push('H');

  const quotedCopyDestination = 'i\\copy\t"é.txt';
  const quotedCopySource = 'i\\source\t"é.txt';
  await generatedCase(client, suiteRoot, 'I-copy-literal-backslash', { [quotedCopySource]: 'quoted copy\n' }, async (root) => fs.copyFile(path.join(root, quotedCopySource), path.join(root, quotedCopyDestination)), [quotedCopySource, quotedCopyDestination]);
  matrix.push('I');

  const leadingName = ' leading-space.txt';
  const trailingName = 'trailing-space.txt ';
  const arrowName = 'ordinary => arrow.txt';
  await generatedCase(client, suiteRoot, 'PATH-EXACT-ORDINARY', {
    [leadingName]: 'leading before\n',
    [trailingName]: 'trailing before\n',
    [arrowName]: 'arrow before\n'
  }, async (root) => {
    await writeFile(root, leadingName, 'leading after\n');
    await writeFile(root, trailingName, 'trailing after\n');
    await writeFile(root, arrowName, 'arrow after\n');
  }, [leadingName, trailingName, arrowName]);
  matrix.push('PATH-EXACT-ORDINARY');

  const arrowRenameSource = 'arrow source => old.txt';
  const arrowRenameDestination = 'arrow destination => new.txt';
  await generatedCase(client, suiteRoot, 'PATH-EXACT-RENAME-ARROW', {
    [arrowRenameSource]: 'arrow rename\n'
  }, async (root) => fs.rename(path.join(root, arrowRenameSource), path.join(root, arrowRenameDestination)), [arrowRenameSource, arrowRenameDestination], { expectedResponseOrder: [arrowRenameSource, arrowRenameDestination] });
  matrix.push('PATH-EXACT-RENAME-ARROW');

  const arrowCopySource = 'arrow copy => source.txt';
  const arrowCopyDestination = 'arrow copy => destination.txt';
  await generatedCase(client, suiteRoot, 'PATH-EXACT-COPY-ARROW', {
    [arrowCopySource]: 'arrow copy\n'
  }, async (root) => fs.copyFile(path.join(root, arrowCopySource), path.join(root, arrowCopyDestination)), [arrowCopySource, arrowCopyDestination], { expectedResponseOrder: [arrowCopySource, arrowCopyDestination] });
  matrix.push('PATH-EXACT-COPY-ARROW');

  // POSIX treats a backslash as an ordinary filename byte. Establish the two
  // physically distinct objects before interpreting any apply result: the
  // literal-backslash file and the slash-separated nested file have distinct
  // lstat identities even though the source-policy compatibility reader can
  // render both as the same slash spelling.
  const twinLiteral = 'twin/same\\name.py';
  const twinSlash = 'twin/same/name.py';
  const twinFiles = {
    [twinLiteral]: 'class Literal:\n',
    [twinSlash]: 'class Slash:\n'
  };
  const twinFactsRoot = path.join(suiteRoot, 'TWIN-PATHS', 'facts-target');
  await initRepo(twinFactsRoot, twinFiles);
  const twinLiteralFact = await fs.lstat(path.join(twinFactsRoot, twinLiteral));
  const twinSlashFact = await fs.lstat(path.join(twinFactsRoot, twinSlash));
  assert.equal(twinLiteralFact.isFile(), true, 'twin literal-backslash path is not a regular file');
  assert.equal(twinSlashFact.isFile(), true, 'twin slash-separated path is not a regular file');
  assert.notEqual(`${twinLiteralFact.dev}:${twinLiteralFact.ino}`, `${twinSlashFact.dev}:${twinSlashFact.ino}`, 'twin paths resolved to one physical object');
  console.log(`PASS 1 RAW TWIN OBJECTS: ${twinLiteral} and ${twinSlash} are two distinct POSIX regular files (dev:ino ${twinLiteralFact.dev}:${twinLiteralFact.ino} vs ${twinSlashFact.dev}:${twinSlashFact.ino}).`);
  await writeArtifact(suiteRoot, 'TWIN-PATHS/pass1-distinct-lstat.json', `${JSON.stringify({
    literal: { path: twinLiteral, dev: twinLiteralFact.dev, ino: twinLiteralFact.ino, kind: twinLiteralFact.isFile() ? 'file' : 'other' },
    slash: { path: twinSlash, dev: twinSlashFact.dev, ino: twinSlashFact.ino, kind: twinSlashFact.isFile() ? 'file' : 'other' }
  }, null, 2)}\n`);

  const twinBaitLiteral = 'class Literal:\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n';
  const twinBaitSlash = 'class Slash:\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n';
  const twinLiteralCase = await generatedCase(client, suiteRoot, 'TWIN-PATHS-A-literal-backslash-only', twinFiles, async (root) => {
    await writeFile(root, twinLiteral, twinBaitLiteral);
  }, [twinLiteral], { expectedResponseOrder: [twinLiteral] });
  assert.equal(await fs.readFile(path.join(twinLiteralCase.target, twinLiteral), 'utf8'), twinBaitLiteral, 'twin A literal file did not change');
  assert.equal(await fs.readFile(path.join(twinLiteralCase.target, twinSlash), 'utf8'), twinFiles[twinSlash], 'twin A slash file changed unexpectedly');
  assert.deepEqual(twinLiteralCase.response.structuredContent.paths, [twinLiteral], 'twin A response path was not the literal-backslash identity');
  for (const [name, value] of [
    ['raw-input.patch', twinLiteralCase.patch],
    ['producer-canonical.diff', twinLiteralCase.patch],
    ['target-canonical.diff', twinLiteralCase.actualDiff],
    ['producer-snapshot.json', snapshotJson(twinLiteralCase.expected)],
    ['target-before.json', snapshotJson(twinLiteralCase.before)],
    ['target-after.json', snapshotJson(twinLiteralCase.after)],
    ['mcp-response.json', `${JSON.stringify(twinLiteralCase.response, null, 2)}\n`]
  ]) await writeArtifact(suiteRoot, `TWIN-PATHS/A-${name}`, value);
  matrix.push('TWIN-A');

  const twinSlashCase = await generatedCase(client, suiteRoot, 'TWIN-PATHS-B-slash-only', twinFiles, async (root) => {
    await writeFile(root, twinSlash, twinBaitSlash);
  }, [twinSlash], { expectedResponseOrder: [twinSlash] });
  assert.equal(await fs.readFile(path.join(twinSlashCase.target, twinSlash), 'utf8'), twinBaitSlash, 'twin B slash file did not change');
  assert.equal(await fs.readFile(path.join(twinSlashCase.target, twinLiteral), 'utf8'), twinFiles[twinLiteral], 'twin B literal-backslash file changed unexpectedly');
  assert.deepEqual(twinSlashCase.response.structuredContent.paths, [twinSlash], 'twin B response path was not the slash-separated identity');
  for (const [name, value] of [
    ['raw-input.patch', twinSlashCase.patch],
    ['producer-canonical.diff', twinSlashCase.patch],
    ['target-canonical.diff', twinSlashCase.actualDiff],
    ['producer-snapshot.json', snapshotJson(twinSlashCase.expected)],
    ['target-before.json', snapshotJson(twinSlashCase.before)],
    ['target-after.json', snapshotJson(twinSlashCase.after)],
    ['mcp-response.json', `${JSON.stringify(twinSlashCase.response, null, 2)}\n`]
  ]) await writeArtifact(suiteRoot, `TWIN-PATHS/B-${name}`, value);
  matrix.push('TWIN-B');

  // Both records are Git-applicable, but the Python-lawful bait must not gain
  // parser authority through the lossy slash alias when the two identities
  // are simultaneously present. The direct MCP outcome is TARGET_EVIDENCE,
  // judged against the launcher's expected behavior; independent predicate
  // evidence is the preceding Git/lstat identity proof. It must fail closed,
  // preserve both files, and never echo bait.
  const twinBothRoot = path.join(suiteRoot, 'TWIN-PATHS-C-both');
  const twinBothProducer = path.join(twinBothRoot, 'producer');
  const twinBothTarget = path.join(twinBothRoot, 'target');
  await initRepo(twinBothProducer, twinFiles);
  await initRepo(twinBothTarget, twinFiles);
  await writeFile(twinBothProducer, twinLiteral, twinBaitLiteral);
  await writeFile(twinBothProducer, twinSlash, twinBaitSlash);
  runGit(twinBothProducer, ['add', '-A']);
  const twinBothPatch = canonicalDiff(twinBothProducer, true);
  const twinBothPreflight = preflightEvidence(twinBothTarget, twinBothPatch);
  assert.equal(twinBothPreflight.status, 0, `twin C independent Git preflight failed: ${twinBothPreflight.stderr}`);
  const twinBothBefore = await snapshotWorkspace(twinBothTarget);
  const twinBothIndexBefore = gitIndexState(twinBothTarget);
  const twinBothResult = await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: await openWorkspace(client, twinBothTarget), patch: twinBothPatch }
  });
  assert.equal(twinBothResult.isError, true, `twin C granted parser authority or applied ambiguous paths: ${resultText(twinBothResult)}`);
  assert.match(resultText(twinBothResult), /Secret-looking content is blocked|source|policy|blocked/i, 'twin C did not fail closed at source policy');
  assert.equal(JSON.stringify(twinBothResult).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'twin C echoed source-policy bait');
  assert.equal(snapshotJson(await snapshotWorkspace(twinBothTarget)), snapshotJson(twinBothBefore), 'twin C source-policy rejection mutated either path');
  assert.deepEqual(gitIndexState(twinBothTarget), twinBothIndexBefore, 'twin C source-policy rejection changed the target index');
  for (const [name, value] of [
    ['raw-input.patch', twinBothPatch],
    ['producer-canonical.diff', twinBothPatch],
    ['git-preflight-stdout.txt', twinBothPreflight.stdout],
    ['git-preflight-stderr.txt', twinBothPreflight.stderr],
    ['target-before.json', snapshotJson(twinBothBefore)],
    ['target-after.json', snapshotJson(await snapshotWorkspace(twinBothTarget))],
    ['mcp-response.json', `${JSON.stringify(twinBothResult, null, 2)}\n`]
  ]) await writeArtifact(suiteRoot, `TWIN-PATHS/C-${name}`, value);
  matrix.push('TWIN-C-POLICY');

  const invalidUtf8Target = path.join(suiteRoot, 'INVALID-UTF8-PATH', 'target');
  const invalidUtf8NameBytes = Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0x2d, 0xff, 0x2e, 0x74, 0x78, 0x74]);
  const invalidUtf8Path = Buffer.concat([Buffer.from(invalidUtf8Target), Buffer.from('/'), invalidUtf8NameBytes]);
  await fs.mkdir(invalidUtf8Target, { recursive: true });
  runGit(invalidUtf8Target, ['init', '-q']);
  runGit(invalidUtf8Target, ['config', 'user.name', 'CodexPro apply matrix']);
  runGit(invalidUtf8Target, ['config', 'user.email', 'codexpro-apply-matrix@example.invalid']);
  runGit(invalidUtf8Target, ['config', 'core.quotePath', 'true']);
  await fs.writeFile(invalidUtf8Path, 'before\n');
  runGit(invalidUtf8Target, ['add', '-A']);
  runGit(invalidUtf8Target, ['commit', '--allow-empty', '-qm', 'matrix baseline']);
  const invalidUtf8Patch = [
    'diff --git "a/invalid-\\377.txt" "b/invalid-\\377.txt"',
    '--- "a/invalid-\\377.txt"',
    '+++ "b/invalid-\\377.txt"',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    ''
  ].join('\n');
  const invalidBeforeNames = await rawDirectoryEntries(invalidUtf8Target);
  const invalidGitPreflight = spawnSync('git', ['apply', '--check', '--numstat', '-z', '--verbose', '--whitespace=nowarn'], {
    cwd: invalidUtf8Target,
    input: invalidUtf8Patch,
    encoding: null,
    env: { ...process.env }
  });
  assert.equal(invalidGitPreflight.status, 0, `invalid UTF-8 independent Git preflight could not name the byte path: ${invalidGitPreflight.stderr?.toString()}`);
  assert.equal(invalidGitPreflight.stdout.includes(0xff), true, 'invalid UTF-8 independent Git preflight did not expose the raw path byte');
  const invalidWorkspace = await openWorkspace(client, invalidUtf8Target);
  const invalidResult = await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: invalidWorkspace, patch: invalidUtf8Patch } });
  assert.equal(invalidResult.isError, true, `invalid UTF-8 path unexpectedly succeeded: ${resultText(invalidResult)}`);
  assert.match(resultText(invalidResult), /UTF-8|utf-8|lossless|malformed|path/i, 'invalid UTF-8 path did not fail closed with a bounded path/encoding error');
  assert.deepEqual(await rawDirectoryEntries(invalidUtf8Target), invalidBeforeNames, 'invalid UTF-8 rejection changed raw directory entries');
  assert.equal(await fs.readFile(invalidUtf8Path, 'utf8'), 'before\n', 'invalid UTF-8 rejection changed the byte-named file');
  const replacementNameHex = Buffer.from('invalid-�.txt').toString('hex');
  assert.equal((await rawDirectoryEntries(invalidUtf8Target)).includes(replacementNameHex), false, 'invalid UTF-8 rejection created a replacement-character target');
  await writeArtifact(suiteRoot, 'INVALID-UTF8-PATH/raw-input.patch', invalidUtf8Patch);
  await writeArtifact(suiteRoot, 'INVALID-UTF8-PATH/git-preflight-stdout.bin', invalidGitPreflight.stdout);
  await writeArtifact(suiteRoot, 'INVALID-UTF8-PATH/git-preflight-stderr.bin', invalidGitPreflight.stderr);
  await writeArtifact(suiteRoot, 'INVALID-UTF8-PATH/mcp-response.json', `${JSON.stringify(invalidResult, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'INVALID-UTF8-PATH/directory-before.json', `${JSON.stringify(invalidBeforeNames, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'INVALID-UTF8-PATH/directory-after.json', `${JSON.stringify(await rawDirectoryEntries(invalidUtf8Target), null, 2)}\n`);
  matrix.push('INVALID-UTF8-PATH');

  const headerSource = 'class Header:\n    payload = """\n--- header-looking.txt\n+++ header-looking.txt\n"""\n';
  await generatedCase(client, suiteRoot, 'L-header-shaped-content', { 'header-shaped.py': headerSource }, async (root) => writeFile(root, 'header-shaped.py', headerSource.replaceAll('header-looking.txt', 'header-changed.txt')), ['header-shaped.py']);
  matrix.push('L');

  const mCase = await generatedCase(client, suiteRoot, 'M-ignored-surplus-input', { 'surplus.txt': 'before\n' }, async (root) => writeFile(root, 'surplus.txt', 'after\n'), ['surplus.txt']);
  const mPatch = `${mCase.patch}\nnew file mode 120000\nACTUAL_LITERAL_SECRET_7X9\n`;
  // Re-run M against a pristine target with the exact surplus input. Git
  // accepts the extra textual line but does not apply it; canonical output
  // and the source-policy route must therefore never report that bait.
  const mTarget = path.join(suiteRoot, 'M-ignored-surplus-input-exact', 'target');
  await initRepo(mTarget, { 'surplus.txt': 'before\n' }, { fileModes: { 'surplus.txt': 0o644 } });
  const mBefore = await snapshotWorkspace(mTarget);
  assert.equal(mBefore.get('surplus.txt')?.mode, 0o644, 'M-case target baseline mode was not exactly 0644');
  const mWorkspace = await openWorkspace(client, mTarget);
  const mPreflight = preflightEvidence(mTarget, mPatch);
  assert.equal(mPreflight.status, 0, `M independent Git preflight failed: ${mPreflight.stderr}`);
  const mResult = await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: mWorkspace, patch: mPatch } });
  assert.notEqual(mResult.isError, true, `M apply_patch rejected Git-accepted surplus input: ${resultText(mResult)}`);
  const mAfter = await snapshotWorkspace(mTarget);
  const mOracleRoot = path.join(suiteRoot, 'M-ignored-surplus-input-exact', 'oracle-direct-git');
  await initRepo(mOracleRoot, { 'surplus.txt': 'before\n' }, { fileModes: { 'surplus.txt': 0o644 } });
  runGit(mOracleRoot, ['apply', '--index', '--whitespace=nowarn'], mPatch);
  const mOracle = await snapshotWorkspace(mOracleRoot);
  assert.equal((await fs.readFile(path.join(mTarget, 'surplus.txt'), 'utf8')), 'after\n', 'M extra line became file content');
  const mCaseMode = (await fs.lstat(path.join(mTarget, 'surplus.txt'))).mode & 0o7777;
  const mOracleMode = (await fs.lstat(path.join(mOracleRoot, 'surplus.txt'))).mode & 0o7777;
  console.log(`RAW M-ignored-surplus-input: mcp=0${mCaseMode.toString(8).padStart(4, '0')} direct-git=0${mOracleMode.toString(8).padStart(4, '0')}`);
  assert.equal(snapshotJson(mAfter), snapshotJson(mOracle), 'M ignored symlink-mode line changed the regular target snapshot');
  assert.equal(snapshotJson(mAfter).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'M surplus source-policy bait reached target filesystem');
  assert.equal(JSON.stringify(mResult).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'M ignored surplus input was echoed in MCP response');
  assert.equal(mResult.structuredContent.diff.includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'M ignored surplus input reached canonical returned diff');
  assert.equal(mPatch.includes('new file mode 120000'), true, 'M raw input omitted the ignored mode-shaped line');
  const mProducerDiff = canonicalDiff(mCase.producer, true);
  const mProducerNumstat = actualNumstat(mCase.producer, true);
  runGit(mTarget, ['add', '-A']);
  const mTargetDiff = canonicalDiff(mTarget, true);
  const mTargetNumstat = actualNumstat(mTarget, true);
  runGit(mTarget, ['reset', '-q']);
  assert.equal(mResult.structuredContent.diff, mProducerDiff, 'M returned diff differs from independent producer Git diff');
  assert.equal(mResult.structuredContent.diff, mTargetDiff, 'M returned diff differs from independent target Git diff');
  assert.equal(mResult.structuredContent.additions, mProducerNumstat.additions, 'M additions differ from producer Git numstat');
  assert.equal(mResult.structuredContent.deletions, mProducerNumstat.deletions, 'M deletions differ from producer Git numstat');
  assert.equal(mResult.structuredContent.additions, mTargetNumstat.additions, 'M additions differ from target Git numstat');
  assert.equal(mResult.structuredContent.deletions, mTargetNumstat.deletions, 'M deletions differ from target Git numstat');
  assert.equal(mProducerDiff.includes('new file mode 120000'), false, 'M independent producer canonical diff preserved ignored mode text');
  assert.equal(mTargetDiff.includes('new file mode 120000'), false, 'M independent target canonical diff preserved ignored mode text');
  await writeArtifact(suiteRoot, 'M-ignored-surplus-input/raw-input.patch', mPatch);
  await writeArtifact(suiteRoot, 'M-ignored-surplus-input/producer-canonical.diff', mProducerDiff);
  await writeArtifact(suiteRoot, 'M-ignored-surplus-input/target-canonical.diff', mTargetDiff);
  await writeArtifact(suiteRoot, 'M-ignored-surplus-input/producer-numstat.json', `${JSON.stringify(mProducerNumstat, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'M-ignored-surplus-input/target-numstat.json', `${JSON.stringify(mTargetNumstat, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'M-ignored-surplus-input/mcp-response.json', `${JSON.stringify(mResult, null, 2)}\n`);
  assert.equal(snapshotJson(mBefore).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'M baseline unexpectedly contained bait');
  matrix.push('M');

  const nPatch = [
    'diff --git a/repeated.txt b/repeated.txt',
    '--- a/repeated.txt',
    '--- a/repeated.txt',
    '+++ b/repeated.txt',
    '+++ b/repeated.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after',
    ''
  ].join('\n');
  // N is expected to be accepted by Git, while the duplicate header lines
  // remain absent from the canonical result.
  const nTarget = path.join(suiteRoot, 'N-repeated-headers-exact', 'target');
  await initRepo(nTarget, { 'repeated.txt': 'before\n' });
  const nBefore = await snapshotWorkspace(nTarget);
  const nPreflight = preflightEvidence(nTarget, nPatch);
  assert.equal(nPreflight.status, 0, `N independent Git preflight failed: ${nPreflight.stderr}`);
  const nWorkspace = await openWorkspace(client, nTarget);
  const nResult = await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: nWorkspace, patch: nPatch } });
  assert.notEqual(nResult.isError, true, `N repeated headers rejected: ${resultText(nResult)}`);
  assert.deepEqual(nResult.structuredContent.paths, ['repeated.txt'], 'N returned repeated header as a path');
  assert.equal((await fs.readFile(path.join(nTarget, 'repeated.txt'), 'utf8')), 'after\n', 'N did not apply the Git result');
  assert.equal(nResult.structuredContent.diff.includes('--- a/repeated.txt\n--- a/repeated.txt'), false, 'N canonical diff preserved duplicate old header');
  assert.equal(nResult.structuredContent.diff.includes('+++ b/repeated.txt\n+++ b/repeated.txt'), false, 'N canonical diff preserved duplicate new header');
  assert.equal(snapshotJson(nBefore).includes('after'), false, 'N baseline unexpectedly contained applied content');
  matrix.push('N');

  const oPatch = [
    'diff --git a/malformed.txt b/malformed.txt',
    '--- a/malformed.txt',
    '+++ b/malformed.txt',
    '@@ -1,not-a-count +1,1 @@',
    '-before',
    '+after',
    'ACTUAL_LITERAL_SECRET_7X9',
    ''
  ].join('\n');
  const o = await rejectedCase(client, suiteRoot, 'O-malformed', { 'malformed.txt': 'before\n' }, async () => oPatch, /(?:malformed|patch|hunk|failed|error)/i);
  assert.equal(JSON.stringify(o.response).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'O preflight diagnostics leaked raw sensitive input');
  matrix.push('O');

  const pythonFiles = {
    'lawful.py': 'class Lawful:\n    token: Token[str]\n',
    'lawful.pyi': 'class LawfulStub:\n    token: Token[str]\n',
    'lawful.pyw': 'class LawfulWindows:\n    token: Token[str]\n',
    'mirror.txt': 'class Mirror:\n    value: str\n'
  };
  await generatedCase(client, suiteRoot, 'python-gating-lawful', pythonFiles, async (root) => {
    await writeFile(root, 'lawful.py', `${pythonFiles['lawful.py']}    safe = True\n`);
    await writeFile(root, 'lawful.pyi', `${pythonFiles['lawful.pyi']}    safe: bool\n`);
    await writeFile(root, 'lawful.pyw', `${pythonFiles['lawful.pyw']}    safe = True\n`);
    await writeFile(root, 'mirror.txt', `${pythonFiles['mirror.txt']}    safe = True\n`);
  }, ['lawful.py', 'lawful.pyi', 'lawful.pyw', 'mirror.txt']);
  matrix.push('PYTHON-LAWFUL');
  await rejectedCase(client, suiteRoot, 'python-gating-hostile-pyi', { 'hostile.pyi': 'class Hostile:\n    token: Token[str]\n' }, async (root) => {
    const patchRoot = path.join(path.dirname(root), 'producer');
    await initRepo(patchRoot, { 'hostile.pyi': 'class Hostile:\n    token: Token[str]\n' });
    await writeFile(patchRoot, 'hostile.pyi', 'class Hostile:\n    token = ACTUAL_LITERAL_SECRET_7X9\n');
    runGit(patchRoot, ['add', '-A']);
    return canonicalDiff(patchRoot, true);
  }, /Secret-looking content is blocked|source|patch/i);
  matrix.push('PYTHON-HOSTILE');

  const blockedRenamePatch = async (root) => {
    const producer = path.join(path.dirname(root), 'producer');
    await initRepo(producer, { 'safe.txt': 'safe\n' });
    await fs.rename(path.join(producer, 'safe.txt'), path.join(producer, '.env'));
    runGit(producer, ['add', '-A']);
    return canonicalDiff(producer, true);
  };
  await rejectedCase(client, suiteRoot, 'blocked-rename-identity', { 'safe.txt': 'safe\n' }, blockedRenamePatch, /blocked/i);
  matrix.push('BLOCKED-RENAME');
  const blockedCopyPatch = async (root) => {
    const producer = path.join(path.dirname(root), 'producer');
    await initRepo(producer, { 'safe.txt': 'safe\n' });
    await fs.copyFile(path.join(producer, 'safe.txt'), path.join(producer, '.env'));
    runGit(producer, ['add', '-A']);
    return canonicalDiff(producer, true);
  };
  await rejectedCase(client, suiteRoot, 'blocked-copy-identity', { 'safe.txt': 'safe\n' }, blockedCopyPatch, /blocked/i);
  matrix.push('BLOCKED-COPY');

  if (process.platform !== 'win32') {
    const semanticSymlinkRoot = path.join(suiteRoot, 'SEMANTIC-SYMLINK');
    const symlinkProducer = path.join(semanticSymlinkRoot, 'producer');
    const symlinkSimulation = path.join(semanticSymlinkRoot, 'simulation');
    const symlinkTarget = path.join(semanticSymlinkRoot, 'target');
    await initRepo(symlinkProducer, {});
    await fs.symlink('/tmp/target-not-used', path.join(symlinkProducer, 'semantic-link'));
    runGit(symlinkProducer, ['add', '-A']);
    const semanticSymlinkPatch = canonicalDiff(symlinkProducer, true);
    assert.match(semanticSymlinkPatch, /new file mode 120000/, 'independent Git producer did not emit semantic symlink mode');
    await initRepo(symlinkSimulation, {});
    const simApply = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.filemode=true', '-c', 'core.symlinks=false', 'apply', '--index', '--whitespace=nowarn'], {
      cwd: symlinkSimulation,
      input: semanticSymlinkPatch,
      encoding: null,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
    });
    assert.equal(simApply.status, 0, `independent core.symlinks=false Git simulation rejected semantic symlink: ${simApply.stderr?.toString()}`);
    const simIndex = gitIndexState(symlinkSimulation).toString('utf8');
    assert.match(simIndex, /120000 [0-9a-f]{40} 0\tsemantic-link\0/, 'independent simulation index did not preserve semantic symlink mode 120000');
    const simLink = await fs.lstat(path.join(symlinkSimulation, 'semantic-link'));
    assert.equal(simLink.isSymbolicLink() || simLink.isFile(), true, 'independent simulation did not materialize a Git target entry');
    console.log(`RAW SEMANTIC-SYMLINK: producer emitted mode 120000; core.symlinks=false simulation index retained mode 120000 and worktree kind=${simLink.isSymbolicLink() ? 'symlink' : 'regular-file'}.`);

    await initRepo(symlinkTarget, {});
    const symlinkBefore = await snapshotWorkspace(symlinkTarget);
    const symlinkIndexBefore = gitIndexState(symlinkTarget);
    const symlinkWorkspace = await openWorkspace(client, symlinkTarget);
    const symlinkResult = await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: symlinkWorkspace, patch: semanticSymlinkPatch }
    });
    assert.equal(symlinkResult.isError, true, `semantic symlink patch unexpectedly succeeded: ${resultText(symlinkResult)}`);
    assert.match(resultText(symlinkResult), /symlink/i, 'semantic symlink rejection did not identify the blocked mode');
    const symlinkAfter = await snapshotWorkspace(symlinkTarget);
    assert.equal(snapshotJson(symlinkAfter), snapshotJson(symlinkBefore), 'semantic symlink rejection changed target filesystem');
    assert.deepEqual(gitIndexState(symlinkTarget), symlinkIndexBefore, 'semantic symlink rejection changed target index');
    await assert.rejects(fs.lstat(path.join(symlinkTarget, 'semantic-link')), (error) => error?.code === 'ENOENT', 'semantic symlink rejection created a target path');
    await writeArtifact(suiteRoot, 'SEMANTIC-SYMLINK/producer.patch', semanticSymlinkPatch);
    await writeArtifact(suiteRoot, 'SEMANTIC-SYMLINK/simulation-ls-files-stage.bin', gitIndexState(symlinkSimulation));
    await writeArtifact(suiteRoot, 'SEMANTIC-SYMLINK/simulation-apply-stderr.bin', simApply.stderr);
    await writeArtifact(suiteRoot, 'SEMANTIC-SYMLINK/rejection-response.json', `${JSON.stringify(symlinkResult, null, 2)}\n`);
    await writeArtifact(suiteRoot, 'SEMANTIC-SYMLINK/target-before.json', snapshotJson(symlinkBefore));
    await writeArtifact(suiteRoot, 'SEMANTIC-SYMLINK/target-after.json', snapshotJson(symlinkAfter));
    matrix.push('SYMLINK');
  }

  const simpleTarget = path.join(suiteRoot, 'traditional-simple', 'target');
  await initRepo(simpleTarget, { 'simple.txt': 'old\n' });
  const simplePatch = ['--- simple.txt', '+++ simple.txt', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const simpleWorkspace = await openWorkspace(client, simpleTarget);
  const simpleResult = await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: simpleWorkspace, patch: simplePatch } });
  assert.notEqual(simpleResult.isError, true, `traditional simple patch failed: ${resultText(simpleResult)}`);
  assert.equal(await fs.readFile(path.join(simpleTarget, 'simple.txt'), 'utf8'), 'new\n', 'traditional simple patch changed wrong bytes');
  matrix.push('TRADITIONAL');

  // Two same-object writers must serialize. The loser has a second Git
  // preflight under the lock and must fail before real mutation.
  const raceTarget = path.join(suiteRoot, 'race', 'target');
  await initRepo(raceTarget, { 'race.txt': 'base\n' });
  const raceWorkspace = await openWorkspace(client, raceTarget);
  const raceOne = ['diff --git a/race.txt b/race.txt', '--- a/race.txt', '+++ b/race.txt', '@@ -1 +1 @@', '-base', '+winner-one', ''].join('\n');
  const raceTwo = ['diff --git a/race.txt b/race.txt', '--- a/race.txt', '+++ b/race.txt', '@@ -1 +1 @@', '-base', '+winner-two', ''].join('\n');
  const raceResults = await Promise.all([
    client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: raceWorkspace, patch: raceOne } }),
    client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: raceWorkspace, patch: raceTwo } })
  ]);
  assert.equal(raceResults.filter((result) => result.isError !== true).length, 1, `race did not produce one winner: ${JSON.stringify(raceResults)}`);
  assert.equal(raceResults.filter((result) => result.isError === true).length, 1, `race did not reject the stale loser: ${JSON.stringify(raceResults)}`);
  const raceLoser = raceResults.find((result) => result.isError === true);
  assert.match(resultText(raceLoser), /retry/i, `race stale loser did not ask caller to retry: ${JSON.stringify(raceLoser)}`);
  const raceFinal = await fs.readFile(path.join(raceTarget, 'race.txt'), 'utf8');
  assert.ok(raceFinal === 'winner-one\n' || raceFinal === 'winner-two\n', `race produced partial bytes: ${raceFinal}`);
  matrix.push('RACE');

  // Real target apply remains on the target repository while simulation must
  // clear inherited Git routing variables. A simulation that obeys this
  // hostile GIT_DIR/GIT_WORK_TREE pair would mutate target HEAD or apply the
  // patch early, both directly observable below.
  const envTargetA = path.join(suiteRoot, 'git-env-isolation', 'target-a');
  const envTargetB = path.join(suiteRoot, 'git-env-isolation', 'target-b-unrelated');
  const envProducer = path.join(suiteRoot, 'git-env-isolation', 'producer');
  await initRepo(envTargetA, { 'env.txt': 'before\n' });
  await initRepo(envTargetB, { 'unrelated.txt': 'B must remain byte-identical\n' });
  await initRepo(envProducer, { 'env.txt': 'before\n' });
  await writeFile(envProducer, 'env.txt', 'after\n');
  runGit(envProducer, ['add', '-A']);
  const envPatch = canonicalDiff(envProducer, true);
  const envExpectedA = await snapshotWorkspace(envProducer);
  const envBeforeA = await snapshotWorkspace(envTargetA);
  const envBeforeB = await snapshotWorkspace(envTargetB);
  const envHeadA = runGit(envTargetA, ['rev-parse', 'HEAD']).stdout.trim();
  const envHeadB = runGit(envTargetB, ['rev-parse', 'HEAD']).stdout.trim();
  const isolatedClient = new McpStdioClient('node', ['dist/stdio.js', '--root', suiteRoot, '--allow-root', suiteRoot, '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: suiteRoot,
      CODEXPRO_ALLOWED_ROOTS: suiteRoot,
      CODEXPRO_WRITE_MODE: 'workspace',
      GIT_DIR: path.join(envTargetB, '.git'),
      GIT_WORK_TREE: envTargetB,
      GIT_INDEX_FILE: path.join(envTargetB, '.git', 'hostile-index'),
      GIT_COMMON_DIR: path.join(envTargetB, '.git'),
      GIT_OBJECT_DIRECTORY: path.join(envTargetB, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(envTargetB, '.git', 'objects'),
      GIT_NAMESPACE: 'hostile-namespace',
      GIT_ATTR_SOURCE: 'HEAD',
      GIT_PREFIX: 'hostile-prefix/',
      GIT_CONFIG: path.join(envTargetB, '.git', 'config')
    }
  });
  await isolatedClient.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codexpro-apply-git-env-isolation', version: '0.1.0' } });
  isolatedClient.notify('notifications/initialized');
  const envWorkspace = await openWorkspace(isolatedClient, envTargetA);
  const envResult = await isolatedClient.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: envWorkspace, patch: envPatch } });
  assert.notEqual(envResult.isError, true, `inherited Git env redirected target apply/simulation: ${resultText(envResult)}`);
  assert.equal(snapshotJson(await snapshotWorkspace(envTargetA)), snapshotJson(envExpectedA), 'inherited Git env did not produce target A filesystem result');
  assert.equal(runGit(envTargetA, ['rev-parse', 'HEAD']).stdout.trim(), envHeadA, 'simulation changed target A HEAD through inherited Git env');
  assert.equal(snapshotJson(await snapshotWorkspace(envTargetB)), snapshotJson(envBeforeB), 'inherited Git env changed unrelated target B filesystem');
  assert.equal(runGit(envTargetB, ['rev-parse', 'HEAD']).stdout.trim(), envHeadB, 'inherited Git env changed unrelated target B HEAD');
  assert.equal(snapshotJson(envBeforeA).includes('after'), false, 'target A baseline unexpectedly contained the applied result');
  await writeArtifact(suiteRoot, 'GIT-ENV-ISOLATION/mcp-response.json', `${JSON.stringify(envResult, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'GIT-ENV-ISOLATION/raw-input.patch', envPatch);
  await writeArtifact(suiteRoot, 'GIT-ENV-ISOLATION/target-a-before.json', `${snapshotJson(envBeforeA)}\n`);
  await writeArtifact(suiteRoot, 'GIT-ENV-ISOLATION/target-a-after.json', `${snapshotJson(await snapshotWorkspace(envTargetA))}\n`);
  await writeArtifact(suiteRoot, 'GIT-ENV-ISOLATION/target-b-before.json', `${snapshotJson(envBeforeB)}\n`);
  await writeArtifact(suiteRoot, 'GIT-ENV-ISOLATION/target-b-after.json', `${snapshotJson(await snapshotWorkspace(envTargetB))}\n`);
  isolatedClient.close();
  matrix.push('GIT-ENV-ISOLATION');

  // Handoff mode is a separate route: generic source writes are not exposed,
  // the literal-backslash filename is not treated as a context path, and the
  // ordinary slash path remains represented in the real context artifact.
  const handoffRoot = path.join(suiteRoot, 'handoff');
  await initRepo(handoffRoot, {});
  const handoffClient = new McpStdioClient('node', ['dist/stdio.js', '--root', suiteRoot, '--allow-root', suiteRoot, '--write', 'handoff'], {
    cwd: path.resolve('.'),
    env: { ...process.env, CODEXPRO_ROOT: suiteRoot, CODEXPRO_ALLOWED_ROOTS: suiteRoot, CODEXPRO_CONTEXT_DIR: '.ai-bridge' }
  });
  await handoffClient.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codexpro-apply-handoff-paths', version: '0.1.0' } });
  handoffClient.notify('notifications/initialized');
  const handoffTools = await handoffClient.request('tools/list', {});
  const handoffNames = handoffTools.tools.map((tool) => tool.name);
  assert.equal(handoffNames.includes('apply_patch'), false, 'handoff mode exposed generic apply_patch');
  const outsideLiteral = '.ai-bridge\\outside.txt';
  const insideLiteral = '.ai-bridge/inside.txt';
  const handoff = await handoffClient.request('tools/call', {
    name: 'handoff_to_agent',
    arguments: { workspace_id: await openWorkspace(handoffClient, handoffRoot), agent: 'tester', title: 'path probe', plan: `Outside: ${outsideLiteral}\nInside: ${insideLiteral}\n` }
  });
  assert.notEqual(handoff.isError, true, `handoff route failed: ${resultText(handoff)}`);
  const handoffPlanPath = path.join(handoffRoot, '.ai-bridge', 'current-plan.md');
  const handoffPlan = await fs.readFile(handoffPlanPath, 'utf8');
  assert.equal(handoffPlan.includes(insideLiteral), true, 'handoff did not write the ordinary context artifact');
  assert.equal(await fs.access(path.join(handoffRoot, outsideLiteral)).then(() => true).catch((error) => error?.code === 'ENOENT'), true, 'literal-backslash path gained context-directory permission');
  const handoffFilesystem = await snapshotWorkspace(handoffRoot);
  assert.equal(handoffFilesystem.has('.ai-bridge/current-plan.md'), true, 'handoff report omitted the real context artifact');
  assert.equal([...handoffFilesystem.keys()].some((entry) => entry === outsideLiteral), false, 'handoff created a literal-backslash root file');
  await writeArtifact(suiteRoot, 'HANDOFF-PATHS/tool-list.json', `${JSON.stringify({ apply_patch_present: handoffNames.includes('apply_patch'), tools: handoffNames }, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'HANDOFF-PATHS/handoff-response.json', `${JSON.stringify(handoff, null, 2)}\n`);
  await writeArtifact(suiteRoot, 'HANDOFF-PATHS/filesystem-entries.json', `${JSON.stringify([...handoffFilesystem.keys()].sort(), null, 2)}\n`);
  await writeArtifact(suiteRoot, 'HANDOFF-PATHS/current-plan.md', handoffPlan);
  console.log('HANDOFF_REPORT: apply_patch absent; handoff_to_agent wrote .ai-bridge/current-plan.md; no literal-backslash root file. This is a separate handoff route and does not prove apply_patch PathGuard authorization.');
  handoffClient.close();
  matrix.push('J-K-HANDOFF');

  console.log(`ACCEPTANCE_MATRIX: ${matrix.join(', ')} PASS`);
  console.log('PASS 1 SANITY: direct fixture filesystem/result facts matched the accepted launcher invariants.');
  console.log('SANITY_VERDICT: MATCH');
  console.log('PREDICATE: TRUE for J: literal backslash is a POSIX root filename, independently verified by exact path distinction; permission result matched FALSE.');
  console.log(`OS_TARGET_EVIDENCE: POSIX direct evidence exercised; Windows target behavior is UNPROVEN on this host.`);
  console.log(`ARTIFACT_ROOT: ${path.join(suiteRoot, 'artifacts')}`);
  console.log(`apply-patch-matrix-smoke: PASS (${suiteRoot})`);
} catch (error) {
  console.error(`apply-patch-matrix-smoke: FAIL after [${matrix.join(', ')}]`);
  console.error(error?.stack || error);
  console.error(`RAW_ARTIFACT_ROOT: ${suiteRoot}`);
  process.exitCode = 1;
} finally {
  client?.close();
}
