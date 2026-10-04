import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  hasSecretValue
} = await import('../dist/redact.js');

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
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
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
  return result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
}

function assertToolSuccess(result, label) {
  assert.notEqual(result.isError, true, `${label} failed: ${resultText(result)}`);
  return result;
}

function assertToolError(result, label) {
  assert.equal(result.isError, true, `${label} unexpectedly succeeded: ${resultText(result)}`);
  return result;
}

function numbered(text, startLine = 1) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`).join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function expectNoRawLiterals(value, literals, label) {
  const serialized = JSON.stringify(value) ?? '';
  for (const literal of literals) {
    assert.equal(serialized.includes(literal), false, `${label} leaked ${literal} in its serialized response`);
  }
}

function assertPythonAstAccepted(source, label) {
  const result = spawnSync(
    'python3',
    ['-c', 'import ast, sys; ast.parse(sys.stdin.read(), filename="fixture.py", mode="exec")'],
    { input: source, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `${label} was not accepted by ast.parse: ${result.stderr || result.stdout}`);
}

function gitFixture(root) {
  for (const args of [['init'], ['config', 'core.quotePath', 'true'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  const commit = spawnSync('git', ['-c', 'user.email=prospective-approval-smoke@example.com', '-c', 'user.name=Prospective Approval Smoke', 'commit', '-m', 'prospective approval smoke fixture'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-prospective-approval-'));
const registryPath = path.join(tmp, 'source-approvals.json');
process.env.CODEXPRO_SOURCE_APPROVALS_FILE = registryPath;
const { loadCallKeywordApprovals } = await import('./source-approvals.mjs');

let client;
try {
  // Harmless nonsecret fixture shapes. The base is lawful references only; the
  // reviewed patch adds one f-string call value with a reference interpolation
  // and one plain string call value. Both are parser-owned approval candidates
  // that ordinary scanning refuses until an owner approves them.
  const relativePath = 'prospective-widget.py';
  const absolutePath = path.join(tmp, relativePath);
  const siblingRelativePath = 'prospective-unapproved.py';
  const siblingAbsolutePath = path.join(tmp, siblingRelativePath);
  const reviewRelativePath = path.join('review', 'prospective-widget.proposed.py');
  const reviewAbsolutePath = path.join(tmp, reviewRelativePath);
  const baseSource = [
    'def run(n, token_ref):',
    '    send(token=token_ref)',
    ''
  ].join('\n');
  const addedLines = [
    "    send(work_token=f'profile_process_{n}')",
    "    client.session.send(work_token='profile_cursor_seed')"
  ];
  const proposedSource = [
    'def run(n, token_ref):',
    '    send(token=token_ref)',
    ...addedLines,
    ''
  ].join('\n');
  const approvedLiterals = ['profile_process_', 'profile_cursor_seed'];
  const baseSha256 = sha256(baseSource);
  const resultSha256 = sha256(proposedSource);
  assertPythonAstAccepted(baseSource, 'prospective base fixture');
  assertPythonAstAccepted(proposedSource, 'prospective proposed fixture');
  assert.equal(hasSecretValue(baseSource, { context: 'source', language: 'python' }), false, 'prospective base fixture was classified as hostile');
  assert.equal(hasSecretValue(proposedSource, { context: 'source', language: 'python' }), true, 'prospective patch was not refused without approval');

  await fs.writeFile(absolutePath, baseSource, { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(siblingAbsolutePath, baseSource, { encoding: 'utf8', flag: 'wx' });
  gitFixture(tmp);

  // Seed a 22-entry retrospective enrollment for the fixture path so the
  // prospective enrollment must prove merge/union preservation instead of a
  // narrower replace.
  const canonical = await fs.realpath(absolutePath);
  const seedTriples = Array.from({ length: 22 }, (_, index) => ({
    keyword_sha256: sha256(`prospective-seed-key-${index}`),
    callee_sha256: sha256(`prospective-seed-callee-${index}`),
    value_sha256: sha256(`prospective-seed-value-${index}`)
  }));
  await fs.writeFile(registryPath, `${JSON.stringify({ version: 1, files: [{ path: canonical, source_sha256: baseSha256, entries: seedTriples }] }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.mkdir(path.dirname(reviewAbsolutePath), { recursive: true });
  await fs.writeFile(reviewAbsolutePath, proposedSource, { encoding: 'utf8', flag: 'wx' });

  const snapshot = async (target) => {
    const bytes = await fs.readFile(target);
    const stat = await fs.stat(target, { bigint: true });
    return {
      bytes: bytes.toString('base64'),
      sha256: sha256(bytes.toString('utf8')),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString()
    };
  };
  const approvalCommand = path.resolve('scripts/codexpro.mjs');
  const runApprove = (extraArgs) => spawnSync(process.execPath, [
    approvalCommand,
    'approve-source',
    ...extraArgs
  ], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 });

  const sourceBeforeEnroll = await snapshot(absolutePath);
  const enroll = runApprove([absolutePath, '--expected-sha', baseSha256, '--keywords', 'token,work_token',
    '--prospective-from', reviewAbsolutePath, '--registry', registryPath]);
  assert.equal(enroll.error?.code ?? null, null, 'prospective approve-source could not start');
  assert.equal(enroll.status, 0, `prospective approve-source failed: ${enroll.stderr || enroll.stdout}`);
  expectNoRawLiterals({ stdout: enroll.stdout, stderr: enroll.stderr }, approvedLiterals, 'prospective owner approval command');
  const enrollReceipt = JSON.parse(enroll.stdout);
  assert.equal(enrollReceipt.status, 'approved', 'prospective enrollment omitted its approved status');
  assert.equal(enrollReceipt.prospective, true, 'prospective enrollment omitted its prospective marker');
  assert.equal(enrollReceipt.path, canonical, 'prospective enrollment did not bind the canonical exact path');
  assert.equal(enrollReceipt.base_sha256, baseSha256, 'prospective enrollment omitted the reviewed base digest');
  assert.equal(enrollReceipt.result_sha256, resultSha256, 'prospective enrollment omitted the reviewed result digest');
  assert.equal(enrollReceipt.approved_values, 2, 'prospective enrollment approved an unexpected triple count');
  assert.equal(enrollReceipt.source_modified, false, 'prospective enrollment reported a source mutation');
  assert.deepEqual(await snapshot(absolutePath), sourceBeforeEnroll, 'prospective enrollment changed source bytes or metadata');

  const enrolledRegistryBytes = await fs.readFile(registryPath);
  const enrolledRegistry = JSON.parse(enrolledRegistryBytes.toString('utf8'));
  assert.equal(enrolledRegistry.version, 1, 'prospective registry schema version changed');
  assert.equal(enrolledRegistry.files.length, 1, 'prospective enrollment changed the enrolled file count');
  const enrolledFile = enrolledRegistry.files[0];
  assert.equal(enrolledFile.path, canonical, 'prospective enrollment did not bind the canonical exact path');
  assert.equal(enrolledFile.source_sha256, baseSha256, 'prospective enrollment did not bind the base digest to source_sha256');
  const seedKeys = new Set(seedTriples.map((entry) => JSON.stringify(entry)));
  for (const entry of enrolledFile.entries) seedKeys.delete(JSON.stringify(entry));
  assert.equal(seedKeys.size, 0, 'prospective enrollment dropped prior approved entries instead of merging');
  assert.equal(enrolledFile.entries.length, 22, 'prospective enrollment widened retrospective entries instead of only adding a prospective binding');
  assert.equal(enrolledFile.prospective?.length, 1, 'prospective enrollment omitted its base/result binding');
  const binding = enrolledFile.prospective[0];
  assert.equal(binding.base_sha256, baseSha256, 'prospective binding omitted the reviewed base digest');
  assert.equal(binding.result_sha256, resultSha256, 'prospective binding omitted the reviewed result digest');
  const expectedTriples = [
    { keyword: 'work_token', callee: 'send', value: "f'profile_process_{n}'" },
    { keyword: 'work_token', callee: 'client.session.send', value: "'profile_cursor_seed'" }
  ].map((row) => ({
    keyword_sha256: sha256(row.keyword),
    callee_sha256: sha256(row.callee),
    value_sha256: sha256(row.value)
  }));
  const expectedKeys = expectedTriples.map((entry) => JSON.stringify(entry)).sort();
  assert.deepEqual(binding.entries.map((entry) => JSON.stringify(entry)).sort(), expectedKeys, 'prospective binding enrolled a different keyword/callee/value triple set');
  expectNoRawLiterals(enrolledRegistry, approvedLiterals, 'hash-only prospective registry');
  assert.equal(loadCallKeywordApprovals(absolutePath).length, 24, 'prospective triples did not apply at the reviewed base');
  console.log('PASS prospective enrollment binds canonical path plus base/result digests plus exact hash triples and preserves 22 prior entries');

  const staleEnrollBefore = await snapshot(absolutePath);
  const staleRegistryBefore = await fs.readFile(registryPath);
  const staleEnroll = runApprove([absolutePath, '--expected-sha', '0'.repeat(64), '--keywords', 'token,work_token',
    '--prospective-from', reviewAbsolutePath, '--registry', registryPath]);
  assert.notEqual(staleEnroll.status, 0, 'stale expected base SHA was accepted');
  assert.deepEqual(await snapshot(absolutePath), staleEnrollBefore, 'stale enrollment changed source bytes or metadata');
  assert.deepEqual(await fs.readFile(registryPath), staleRegistryBefore, 'stale enrollment changed the registry');
  console.log('PASS stale expected base SHA is refused without touching source or registry');

  client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'workspace', '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'workspace',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0',
      CODEXPRO_ANALYSIS: '1',
      CODEXPRO_SOURCE_APPROVALS_FILE: registryPath
    }
  });
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-prospective-approval-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  const opened = assertToolSuccess(await client.request('tools/call', {
    name: 'open_current_workspace', arguments: { include_tree: false }
  }), 'prospective open_current_workspace');
  const workspaceId = opened.structuredContent.workspace_id;
  assert.ok(workspaceId, 'prospective workspace omitted its id');

  const anchor = '    send(token=token_ref)';
  const approvedInsertion = `${anchor}\n${addedLines.join('\n')}`;
  assertPythonAstAccepted(baseSource.replace(anchor, approvedInsertion), 'prospective MCP edit candidate');

  // Without approval the same approved-shape content is refused and the file
  // keeps its exact bytes, hash, inode, size, and mtime.
  const siblingBefore = await snapshot(siblingAbsolutePath);
  const siblingRefusal = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: siblingRelativePath,
      old_text: anchor,
      new_text: approvedInsertion,
      expected_replacements: 1
    }
  }), 'unenrolled approved-shape edit');
  assert.match(resultText(siblingRefusal), /Secret-looking content is blocked/);
  expectNoRawLiterals(siblingRefusal, approvedLiterals, 'unenrolled approved-shape refusal');
  assert.deepEqual(await snapshot(siblingAbsolutePath), siblingBefore, 'unenrolled refusal changed bytes, hash, inode, size, or mtime');
  console.log('PASS the same patch content is refused without approval with the file unchanged');

  // The prospectively approved patch applies through the ordinary MCP edit
  // route even though it was never written out of band.
  const approvedEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: relativePath,
      old_text: anchor,
      new_text: approvedInsertion,
      expected_replacements: 1
    }
  }), 'prospectively approved ordinary MCP edit');
  assert.equal(await fs.readFile(absolutePath, 'utf8'), proposedSource, 'approved edit changed unexpected bytes');
  assert.equal(approvedEdit.structuredContent.sha256, resultSha256, 'approved edit returned a different resulting hash');
  assert.deepEqual(await fs.readFile(registryPath), enrolledRegistryBytes, 'approved MCP edit rewrote enrollment metadata');
  console.log('PASS approve-then-edit applies the reviewed patch through the ordinary MCP route');

  // The same reviewed transition also applies through the ordinary
  // apply_patch route from a real Git-produced patch.
  const gitDiff = spawnSync('git', ['diff', '--no-ext-diff', '--unified=3', '--', relativePath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(gitDiff.status, 0, `prospective Git diff failed: ${gitDiff.stderr || gitDiff.stdout}`);
  assert.equal(gitDiff.stdout.includes(`a/${relativePath}`) && gitDiff.stdout.includes(`b/${relativePath}`), true, 'Git patch omitted its exact old/new path');
  await fs.writeFile(absolutePath, baseSource, 'utf8');
  assert.equal(loadCallKeywordApprovals(absolutePath).length, 24, 'prospective triples did not rebind after restoring the reviewed base');
  const approvedPatch = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: gitDiff.stdout }
  }), 'prospectively approved ordinary apply_patch');
  assert.deepEqual(approvedPatch.structuredContent.paths, [relativePath], 'approved apply_patch changed an unexpected path');
  assert.equal(await fs.readFile(absolutePath, 'utf8'), proposedSource, 'approved apply_patch changed unexpected bytes');
  assert.deepEqual(await fs.readFile(registryPath), enrolledRegistryBytes, 'approved apply_patch rewrote enrollment metadata');
  console.log('PASS approve-then-apply_patch applies the reviewed Git patch through the ordinary MCP route');

  // Content outside the approved scope is still refused at the reviewed
  // result, with the file provably unchanged.
  const driftLiteral = 'scope_drift_literal';
  const driftLine = `    send(password='${driftLiteral}')`;
  assertPythonAstAccepted(`${proposedSource}${driftLine}\n`, 'out-of-scope refusal candidate');
  const resultBeforeDrift = await snapshot(absolutePath);
  const driftRefusal = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: relativePath,
      old_text: addedLines[1],
      new_text: `${addedLines[1]}\n${driftLine}`,
      expected_replacements: 1
    }
  }), 'out-of-scope approved-file edit');
  assert.match(resultText(driftRefusal), /Secret-looking content is blocked/);
  expectNoRawLiterals(driftRefusal, [...approvedLiterals, driftLiteral], 'out-of-scope refusal');
  assert.deepEqual(await snapshot(absolutePath), resultBeforeDrift, 'out-of-scope refusal changed bytes, hash, inode, size, or mtime');
  console.log('PASS out-of-scope content is refused at the reviewed result with the file unchanged');

  // Ordinary lawful bytes around the approved RHS still flow.
  const resultPlusNote = `${proposedSource}    # ordinary note\n`;
  assertPythonAstAccepted(resultPlusNote, 'lawful neighboring edit candidate');
  const notedEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: relativePath,
      old_text: addedLines[1],
      new_text: `${addedLines[1]}\n    # ordinary note`,
      expected_replacements: 1
    }
  }), 'lawful neighboring ordinary MCP edit');
  assert.equal(await fs.readFile(absolutePath, 'utf8'), resultPlusNote, 'lawful neighboring edit changed unexpected bytes');
  assert.equal(notedEdit.structuredContent.sha256, sha256(resultPlusNote), 'lawful neighboring edit returned a different resulting hash');
  console.log('PASS lawful neighboring bytes still flow around the exact approved RHS');

  // A stale base refuses even the reviewed result: the live bytes equal
  // neither the reviewed base nor the reviewed result, so the prospective
  // triples stay out of the scan and the file keeps its exact identity.
  const staleSource = `${resultPlusNote}# drift\n`;
  await fs.writeFile(absolutePath, staleSource, 'utf8');
  assert.equal(loadCallKeywordApprovals(absolutePath).length, 22, 'stale base still admitted prospective triples');
  const staleBefore = await snapshot(absolutePath);
  const staleWrite = assertToolError(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: relativePath, content: proposedSource }
  }), 'stale base write of the reviewed result');
  assert.match(resultText(staleWrite), /Secret-looking content is blocked/);
  expectNoRawLiterals(staleWrite, approvedLiterals, 'stale base refusal');
  assert.deepEqual(await snapshot(absolutePath), staleBefore, 'stale refusal changed bytes, hash, inode, size, or mtime');
  assert.deepEqual(await fs.readFile(registryPath), enrolledRegistryBytes, 'stale refusal rewrote enrollment metadata');
  console.log('PASS stale base refuses the reviewed result with the file unchanged');
  await fs.writeFile(absolutePath, resultPlusNote, 'utf8');

  // After the transition lands, ordinary retrospective enrollment folds the
  // steady-state triples into the unconditional entries while keeping every
  // prior entry and the prospective binding intact.
  const steadyEnroll = runApprove([absolutePath, '--expected-sha', sha256(resultPlusNote), '--keywords', 'token,work_token',
    '--registry', registryPath]);
  assert.equal(steadyEnroll.error?.code ?? null, null, 'steady-state approve-source could not start');
  assert.equal(steadyEnroll.status, 0, `steady-state approve-source failed: ${steadyEnroll.stderr || steadyEnroll.stdout}`);
  const steadyRegistry = JSON.parse((await fs.readFile(registryPath)).toString('utf8'));
  const steadyFile = steadyRegistry.files.find((file) => file.path === canonical);
  assert.ok(steadyFile, 'steady-state enrollment dropped the fixture path');
  assert.equal(steadyFile.entries.length, 24, 'steady-state enrollment did not union the reviewed triples with the 22 prior entries');
  const steadyKeys = new Set(steadyFile.entries.map((entry) => JSON.stringify(entry)));
  for (const seed of seedTriples) assert.equal(steadyKeys.has(JSON.stringify(seed)), true, 'steady-state enrollment dropped a prior approved entry');
  for (const key of expectedKeys) assert.equal(steadyKeys.has(key), true, 'steady-state enrollment dropped a reviewed triple');
  assert.equal(steadyFile.prospective?.length, 1, 'steady-state enrollment dropped the prospective binding');
  assert.equal(steadyFile.source_sha256, sha256(resultPlusNote), 'steady-state enrollment omitted the current source hash');
  expectNoRawLiterals(steadyRegistry, approvedLiterals, 'hash-only steady-state registry');
  const finalSource = `${resultPlusNote}    # steady\n`;
  const finalEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: relativePath,
      old_text: '    # ordinary note',
      new_text: '    # ordinary note\n    # steady',
      expected_replacements: 1
    }
  }), 'post-enrollment ordinary MCP edit');
  assert.equal(await fs.readFile(absolutePath, 'utf8'), finalSource, 'post-enrollment edit changed unexpected bytes');
  assert.equal(finalEdit.structuredContent.sha256, sha256(finalSource), 'post-enrollment edit returned a different resulting hash');
  const finalRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read', arguments: { workspace_id: workspaceId, path: relativePath }
  }), 'post-enrollment approved source read');
  assert.equal(finalRead.structuredContent.text, numbered(finalSource), 'post-enrollment read changed exact source bytes');
  for (const literal of approvedLiterals) assert.equal(JSON.stringify(finalRead).includes(literal), true, 'post-enrollment read omitted an enrolled literal');
  expectNoRawLiterals(steadyRegistry, approvedLiterals, 'final hash-only registry');
  console.log('PASS steady-state enrollment unions reviewed triples and ordinary editing continues');

  console.log('SOURCE_APPROVAL_PROSPECTIVE_MATRIX: prospective owner CLI hash-only enrollment with 22-entry union preservation; approve-then-edit and approve-then-apply_patch through the ordinary MCP route; unenrolled, out-of-scope, and stale-base refusals with unchanged file identity; steady-state union continuation');
} finally {
  if (client) {
    let closeTimer;
    const childExit = client.child.exitCode !== null || client.child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => client.child.once('exit', resolve));
    client.child.stdin.end();
    try {
      await Promise.race([
        childExit,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('prospective approval stdio server did not exit after stdin close')), 10000);
        })
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
    client.close();
  }
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('source-approval-prospective-smoke: PASS (prospective approve-then-apply through ordinary MCP edit/apply_patch; unenrolled, out-of-scope, and stale refusals unchanged; 22-entry union preserved)');
