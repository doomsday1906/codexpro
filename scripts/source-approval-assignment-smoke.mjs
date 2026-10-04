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
  const commit = spawnSync('git', ['-c', 'user.email=assignment-approval-smoke@example.com', '-c', 'user.name=Assignment Approval Smoke', 'commit', '-m', 'assignment approval smoke fixture'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-assignment-approval-'));
const registryPath = path.join(tmp, 'source-approvals.json');
process.env.CODEXPRO_SOURCE_APPROVALS_FILE = registryPath;
const { loadCallKeywordApprovals } = await import('./source-approvals.mjs');
const { PYTHON_ASSIGN_SCOPE_PREFIX } = await import('./python-provenance.mjs');

let client;
try {
  // Three consumer-side reproductions as local fixtures. Every proposed RHS
  // is a reviewed nonsecret marker that ordinary scanning refuses until an
  // owner approves its exact (target, enclosing-function, RHS) triple.
  // (a) world-process profiling locals in distinct function scopes.
  const fileA = 'world_profiling.py';
  const absA = path.join(tmp, fileA);
  const baseA = [
    'def profile_process(n, token_ref):',
    '    send(token=token_ref)',
    '',
    'def profile_cursor(token_ref):',
    '    send(token=token_ref)',
    ''
  ].join('\n');
  const proposedA = [
    'def profile_process(n, token_ref):',
    '    send(token=token_ref)',
    "    work_token = f'profile_process_{n}'",
    '',
    'def profile_cursor(token_ref):',
    '    send(token=token_ref)',
    "    work_token = 'profile_cursor_seed'",
    ''
  ].join('\n');
  // (b) successor pin update with token locals mirroring lines 1115/1356.
  const fileB = 'successor_pin.py';
  const absB = path.join(tmp, fileB);
  const baseB = [
    'def pin_primary(token_ref):',
    '    send(token=token_ref)',
    '',
    'def pin_secondary(token_ref):',
    '    send(token=token_ref)',
    ''
  ].join('\n');
  const proposedB = [
    'def pin_primary(token_ref):',
    '    send(token=token_ref)',
    "    token = 'successor_pin_primary_1115'",
    '',
    'def pin_secondary(token_ref):',
    '    send(token=token_ref)',
    "    token = 'successor_pin_secondary_1356'",
    ''
  ].join('\n');
  // (c) routes_game.py payload/timing/expected markers.
  const fileC = 'routes_game.py';
  const absC = path.join(tmp, fileC);
  const baseC = [
    'def build_payload(marker_ref):',
    '    send(token=marker_ref)',
    ''
  ].join('\n');
  const proposedC = [
    'def build_payload(marker_ref):',
    '    send(token=marker_ref)',
    "    payload_token = 'payload_marker_alpha'",
    "    timing_token = 'timing_marker_beta'",
    "    expected_token = 'expected_marker_gamma'",
    ''
  ].join('\n');
  // (d) pointer_escape.py exact chained .replace shapes mirroring the lane
  // line-1115 family (JSON-pointer escape on a str(ref) base plus a bare
  // reference-base chain). Parser-owned Call nodes only; exact RHS bytes
  // are hashed, never substituted.
  const fileD = 'pointer_escape.py';
  const absD = path.join(tmp, fileD);
  const baseD = [
    'def collect_refs(key_ref):',
    '    send(token=key_ref)',
    '',
    'def render_label(label_ref):',
    '    send(token=label_ref)',
    ''
  ].join('\n');
  const proposedD = [
    'def collect_refs(key_ref):',
    '    send(token=key_ref)',
    '    escape_token = str(key_ref).replace("~", "~0").replace("/", "~1")',
    '',
    'def render_label(label_ref):',
    '    send(token=label_ref)',
    "    label_token = label_ref.replace('_', ' ').replace('-', ' ')",
    ''
  ].join('\n');

  const keywords = 'token,work_token,payload_token,timing_token,expected_token';
  const keywordsD = `${keywords},escape_token,label_token`;
  const approvedLiterals = ['profile_process_', 'profile_cursor_seed',
    'successor_pin_primary_1115', 'successor_pin_secondary_1356',
    'payload_marker_alpha', 'timing_marker_beta', 'expected_marker_gamma'];
  // Exact lane-shape RHS slices: the hash-only registry must never hold them.
  const approvedRhsD = ['str(key_ref).replace("~", "~0").replace("/", "~1")',
    "label_ref.replace('_', ' ').replace('-', ' ')"];
  for (const [label, source] of [['baseA', baseA], ['proposedA', proposedA],
    ['baseB', baseB], ['proposedB', proposedB], ['baseC', baseC], ['proposedC', proposedC],
    ['baseD', baseD], ['proposedD', proposedD]]) {
    assertPythonAstAccepted(source, `assignment fixture ${label}`);
  }
  for (const [label, source] of [['baseA', baseA], ['baseB', baseB], ['baseC', baseC], ['baseD', baseD]]) {
    assert.equal(hasSecretValue(source, { context: 'source', language: 'python' }), false, `${label} was classified as hostile`);
  }
  for (const [label, source] of [['proposedA', proposedA], ['proposedB', proposedB], ['proposedC', proposedC]]) {
    assert.equal(hasSecretValue(source, { context: 'source', language: 'python' }), true, `${label} was not refused without approval`);
  }

  await fs.writeFile(absA, baseA, { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(absB, baseB, { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(absC, baseC, { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(absD, baseD, { encoding: 'utf8', flag: 'wx' });
  gitFixture(tmp);

  // Seed a 22-entry retrospective enrollment for file A so every prospective
  // enrollment must prove merge/union preservation instead of replacement.
  const canonicalA = await fs.realpath(absA);
  const canonicalB = await fs.realpath(absB);
  const canonicalC = await fs.realpath(absC);
  const canonicalD = await fs.realpath(absD);
  const seedTriples = Array.from({ length: 22 }, (_, index) => ({
    keyword_sha256: sha256(`assignment-seed-key-${index}`),
    callee_sha256: sha256(`assignment-seed-callee-${index}`),
    value_sha256: sha256(`assignment-seed-value-${index}`)
  }));
  const baseShaA = sha256(baseA);
  await fs.writeFile(registryPath, `${JSON.stringify({ version: 1, files: [{ path: canonicalA, source_sha256: baseShaA, entries: seedTriples }] }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

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

  const reviewDir = path.join(tmp, 'review');
  await fs.mkdir(reviewDir, { recursive: true });
  const reviewA = path.join(reviewDir, 'world_profiling.proposed.py');
  const reviewB = path.join(reviewDir, 'successor_pin.proposed.py');
  const reviewC = path.join(reviewDir, 'routes_game.proposed.py');
  const reviewD = path.join(reviewDir, 'pointer_escape.proposed.py');
  await fs.writeFile(reviewA, proposedA, 'utf8');
  await fs.writeFile(reviewB, proposedB, 'utf8');
  await fs.writeFile(reviewC, proposedC, 'utf8');
  await fs.writeFile(reviewD, proposedD, 'utf8');

  const enrollOne = (absolutePath, baseSha, reviewPath, expectedCount, label, keywordSet = keywords) => {
    const before = snapshot(absolutePath);
    return before.then((sourceBefore) => {
      const enroll = runApprove([absolutePath, '--expected-sha', baseSha, '--keywords', keywordSet,
        '--prospective-from', reviewPath, '--registry', registryPath]);
      assert.equal(enroll.error?.code ?? null, null, `${label} approve-source could not start`);
      assert.equal(enroll.status, 0, `${label} approve-source failed: ${enroll.stderr || enroll.stdout}`);
      expectNoRawLiterals({ stdout: enroll.stdout, stderr: enroll.stderr }, approvedLiterals, `${label} owner approval command`);
      expectNoRawLiterals({ stdout: enroll.stdout, stderr: enroll.stderr }, approvedRhsD, `${label} owner approval command (replace-chain RHS)`);
      const receipt = JSON.parse(enroll.stdout);
      assert.equal(receipt.status, 'approved', `${label} omitted its approved status`);
      assert.equal(receipt.prospective, true, `${label} omitted its prospective marker`);
      assert.equal(receipt.approved_values, expectedCount, `${label} approved an unexpected triple count`);
      assert.equal(receipt.source_modified, false, `${label} reported a source mutation`);
      return snapshot(absolutePath).then((after) => {
        assert.deepEqual(after, sourceBefore, `${label} enrollment changed source bytes or metadata`);
      });
    });
  };

  await enrollOne(absA, baseShaA, reviewA, 2, 'world-profiling');
  await enrollOne(absB, sha256(baseB), reviewB, 2, 'successor-pin');
  await enrollOne(absC, sha256(baseC), reviewC, 3, 'routes-game');
  // (d) exact chained .replace eligibility: prospective enrollment alone
  // cannot help an ineligible shape — the parser must accept it. Before the
  // isApprovalRhs extension this enrolled zero triples ('No eligible...').
  await enrollOne(absD, sha256(baseD), reviewD, 2, 'pointer-escape', keywordsD);

  // (e) ineligible .replace variants stay fail-closed: kwargs, count arg,
  // literal base, opaque uppercase/digit base, and trailing .strip() enroll
  // nothing even prospectively.
  const fileE = 'replace_rejects.py';
  const absE = path.join(tmp, fileE);
  const baseE = ['def bad_shapes(v):', '    send(token=v)', ''].join('\n');
  const reviewE = path.join(reviewDir, 'replace_rejects.proposed.py');
  const proposedE = ['def bad_shapes(v):', '    send(token=v)',
    "    a_token = str(v).replace(':', ' ').replace('_', ' ').strip()",
    "    b_token = v.replace('a', 'b', 1)",
    "    c_token = v.replace(old='a', new='b')",
    "    d_token = 'lit'.replace('a', 'b')",
    "    e_token = AB12CD34.replace('a', 'b')",
    ''].join('\n');
  assertPythonAstAccepted(proposedE, 'reject fixture');
  await fs.writeFile(absE, baseE, 'utf8');
  await fs.writeFile(reviewE, proposedE, 'utf8');
  const rejectE = runApprove([absE, '--expected-sha', sha256(baseE),
    '--keywords', 'token,a_token,b_token,c_token,d_token,e_token',
    '--prospective-from', reviewE, '--registry', registryPath]);
  assert.notEqual(rejectE.status, 0, 'ineligible .replace variants must not enroll');
  assert.match(rejectE.stderr || rejectE.stdout, /No eligible/, 'ineligible shapes must fail on eligibility, not later');

  const registry = JSON.parse((await fs.readFile(registryPath)).toString('utf8'));
  assert.equal(registry.version, 1, 'registry schema version changed');
  assert.equal(registry.files.length, 4, 'enrollment changed the enrolled file count');
  const recordA = registry.files.find((file) => file.path === canonicalA);
  assert.equal(recordA.entries.length, 22, 'enrollment widened retrospective entries instead of only adding a prospective binding');
  const seedKeys = new Set(seedTriples.map((entry) => JSON.stringify(entry)));
  for (const entry of recordA.entries) seedKeys.delete(JSON.stringify(entry));
  assert.equal(seedKeys.size, 0, 'enrollment dropped prior approved entries instead of merging');
  const scopeHash = (scope) => sha256(`${PYTHON_ASSIGN_SCOPE_PREFIX}${scope}`);
  const expectedA = [
    { keyword: 'work_token', scope: 'profile_process', value: "f'profile_process_{n}'" },
    { keyword: 'work_token', scope: 'profile_cursor', value: "'profile_cursor_seed'" }
  ].map((row) => ({ keyword_sha256: sha256(row.keyword), callee_sha256: scopeHash(row.scope), value_sha256: sha256(row.value) }));
  const expectedB = [
    { keyword: 'token', scope: 'pin_primary', value: "'successor_pin_primary_1115'" },
    { keyword: 'token', scope: 'pin_secondary', value: "'successor_pin_secondary_1356'" }
  ].map((row) => ({ keyword_sha256: sha256(row.keyword), callee_sha256: scopeHash(row.scope), value_sha256: sha256(row.value) }));
  const expectedC = [
    { keyword: 'payload_token', scope: 'build_payload', value: "'payload_marker_alpha'" },
    { keyword: 'timing_token', scope: 'build_payload', value: "'timing_marker_beta'" },
    { keyword: 'expected_token', scope: 'build_payload', value: "'expected_marker_gamma'" }
  ].map((row) => ({ keyword_sha256: sha256(row.keyword), callee_sha256: scopeHash(row.scope), value_sha256: sha256(row.value) }));
  const expectedD = [
    { keyword: 'escape_token', scope: 'collect_refs', value: 'str(key_ref).replace("~", "~0").replace("/", "~1")' },
    { keyword: 'label_token', scope: 'render_label', value: "label_ref.replace('_', ' ').replace('-', ' ')" }
  ].map((row) => ({ keyword_sha256: sha256(row.keyword), callee_sha256: scopeHash(row.scope), value_sha256: sha256(row.value) }));
  for (const [record, expected, label] of [[recordA, expectedA, 'world-profiling'],
    [registry.files.find((file) => file.path === canonicalB), expectedB, 'successor-pin'],
    [registry.files.find((file) => file.path === canonicalC), expectedC, 'routes-game'],
    [registry.files.find((file) => file.path === canonicalD), expectedD, 'pointer-escape']]) {
    assert.equal(record.prospective?.length, 1, `${label} omitted its base/result binding`);
    assert.deepEqual(record.prospective[0].entries.map((entry) => JSON.stringify(entry)).sort(),
      expected.map((entry) => JSON.stringify(entry)).sort(), `${label} enrolled a different (target, function, RHS) triple set`);
  }
  expectNoRawLiterals(registry, approvedLiterals, 'hash-only assignment registry');
  expectNoRawLiterals(registry, approvedRhsD, 'hash-only replace-chain registry');
  assert.equal(loadCallKeywordApprovals(absA).length, 24, 'file A triples did not apply at the reviewed base');
  assert.equal(loadCallKeywordApprovals(absB).length, 2, 'file B triples did not apply at the reviewed base');
  assert.equal(loadCallKeywordApprovals(absC).length, 3, 'file C triples did not apply at the reviewed base');
  assert.equal(loadCallKeywordApprovals(absD).length, 2, 'file D triples did not apply at the reviewed base');
  console.log('PASS assignment enrollment binds file plus enclosing function plus target plus exact RHS bytes and preserves the 22-entry union');
  console.log('PASS exact chained .replace enrollment binds file plus scope plus reference-base RHS bytes (hash-only) and ineligible variants stay fail-closed');

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
    clientInfo: { name: 'codexpro-assignment-approval-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');
  const opened = assertToolSuccess(await client.request('tools/call', {
    name: 'open_current_workspace', arguments: { include_tree: false }
  }), 'assignment open_current_workspace');
  const workspaceId = opened.structuredContent.workspace_id;
  assert.ok(workspaceId, 'assignment workspace omitted its id');

  // (a) ordinary MCP edit applies the reviewed world-profiling patch in one
  // reviewed base -> result transition (a split edit would rest at an
  // intermediate digest where the prospective binding is inapplicable).
  const anchorA = '    send(token=token_ref)\n\ndef profile_cursor(token_ref):\n    send(token=token_ref)';
  const replacementA = `    send(token=token_ref)\n    work_token = f'profile_process_{n}'\n\ndef profile_cursor(token_ref):\n    send(token=token_ref)\n    work_token = 'profile_cursor_seed'`;
  const editA = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: { workspace_id: workspaceId, path: fileA, old_text: anchorA, new_text: replacementA, expected_replacements: 1 }
  }), 'approved assignment edit (world-profiling)');
  assert.equal(await fs.readFile(absA, 'utf8'), proposedA, 'approved world-profiling edit changed unexpected bytes');
  assert.equal(editA.structuredContent.sha256, sha256(proposedA), 'approved edit returned a different resulting hash');
  console.log('PASS ordinary MCP edit applies the reviewed world-profiling assignment patch');

  // (b) ordinary MCP write applies the reviewed successor-pin patch.
  const writeB = assertToolSuccess(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: fileB, content: proposedB }
  }), 'approved assignment write (successor-pin)');
  assert.equal(await fs.readFile(absB, 'utf8'), proposedB, 'approved write changed unexpected bytes');
  assert.equal(writeB.structuredContent.sha256, sha256(proposedB), 'approved write returned a different resulting hash');
  console.log('PASS ordinary MCP write applies the reviewed successor-pin assignment patch');

  // (c) ordinary MCP apply_patch applies the reviewed routes-game patch.
  await fs.writeFile(absC, proposedC, 'utf8');
  const gitDiff = spawnSync('git', ['diff', '--no-ext-diff', '--unified=3', '--', fileC], { cwd: tmp, encoding: 'utf8' });
  assert.equal(gitDiff.status, 0, `routes-game Git diff failed: ${gitDiff.stderr || gitDiff.stdout}`);
  await fs.writeFile(absC, baseC, 'utf8');
  const patchC = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: gitDiff.stdout }
  }), 'approved assignment apply_patch (routes-game)');
  assert.deepEqual(patchC.structuredContent.paths, [fileC], 'approved apply_patch changed an unexpected path');
  assert.equal(await fs.readFile(absC, 'utf8'), proposedC, 'approved apply_patch changed unexpected bytes');
  console.log('PASS ordinary MCP apply_patch applies the reviewed routes-game assignment patch');

  // (d) ordinary MCP write applies the reviewed pointer-escape patch: the
  // exact chained .replace RHS bytes enrolled above flow through the
  // ordinary route with file/scope/RHS binding intact.
  const writeD = assertToolSuccess(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: fileD, content: proposedD }
  }), 'approved assignment write (pointer-escape)');
  assert.equal(await fs.readFile(absD, 'utf8'), proposedD, 'approved write changed unexpected bytes');
  assert.equal(writeD.structuredContent.sha256, sha256(proposedD), 'approved write returned a different resulting hash');
  console.log('PASS ordinary MCP write applies the reviewed pointer-escape replace-chain patch');

  // Changed/unapproved values are refused with the file unchanged.
  const beforeDrift = await snapshot(absA);
  const driftRefusal = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: { workspace_id: workspaceId, path: fileA, old_text: "    work_token = 'profile_cursor_seed'", new_text: "    work_token = 'changed_unapproved'", expected_replacements: 1 }
  }), 'changed-value assignment edit');
  assert.match(resultText(driftRefusal), /Secret-looking content is blocked/);
  assert.deepEqual(await snapshot(absA), beforeDrift, 'changed-value refusal changed bytes, hash, inode, size, or mtime');
  console.log('PASS changed assignment values are refused with the file unchanged');

  // Actual credential patterns are refused even beside approved markers.
  const skMarker = `sk-${'X'.repeat(20)}`;
  const beforeCred = await snapshot(absB);
  const credRefusal = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: { workspace_id: workspaceId, path: fileB, old_text: "    token = 'successor_pin_primary_1115'", new_text: `    token = '${skMarker}'`, expected_replacements: 1 }
  }), 'real-credential assignment edit');
  assert.match(resultText(credRefusal), /Secret-looking content is blocked/);
  expectNoRawLiterals(credRefusal, [skMarker], 'real-credential refusal');
  assert.deepEqual(await snapshot(absB), beforeCred, 'credential refusal changed bytes, hash, inode, size, or mtime');
  console.log('PASS actual credential patterns are refused with the file unchanged');

  // .env paths remain blocked regardless of Python approvals.
  const envPath = 'assignment.env';
  const beforeEnv = await snapshot(absC);
  const envRefusal = assertToolError(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: envPath, content: 'TOKEN=profile_cursor_seed\n' }
  }), '.env write');
  assert.match(resultText(envRefusal), /Secret-looking content is blocked/);
  assert.deepEqual(await snapshot(absC), beforeEnv, '.env refusal touched an unrelated approved file');
  console.log('PASS .env paths remain blocked regardless of Python approvals');

  // Out-of-scope content at the reviewed result is refused with proof unchanged.
  const beforeScope = await snapshot(absC);
  const scopeRefusal = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: { workspace_id: workspaceId, path: fileC, old_text: "    expected_token = 'expected_marker_gamma'", new_text: "    expected_token = 'expected_marker_gamma'\n    send(password='scope_drift_literal')", expected_replacements: 1 }
  }), 'out-of-scope assignment edit');
  assert.match(resultText(scopeRefusal), /Secret-looking content is blocked/);
  assert.deepEqual(await snapshot(absC), beforeScope, 'out-of-scope refusal changed bytes, hash, inode, size, or mtime');
  console.log('PASS out-of-scope content is refused at the reviewed result with the file unchanged');

  // A stale base refuses even the reviewed result with the file unchanged.
  await fs.writeFile(absA, `${proposedA}# drift\n`, 'utf8');
  assert.equal(loadCallKeywordApprovals(absA).length, 22, 'stale base still admitted prospective triples');
  const staleBefore = await snapshot(absA);
  const staleWrite = assertToolError(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: fileA, content: proposedA }
  }), 'stale base write of the reviewed result');
  assert.match(resultText(staleWrite), /Secret-looking content is blocked/);
  assert.deepEqual(await snapshot(absA), staleBefore, 'stale refusal changed bytes, hash, inode, size, or mtime');
  console.log('PASS stale base refuses the reviewed result with the file unchanged');

  console.log('SOURCE_APPROVAL_ASSIGNMENT_MATRIX: owner CLI hash-only enrollment of (target, function, RHS) triples with 22-entry union preservation; exact chained .replace eligibility (reference/str(ref) base, plain string args, parser-owned only) with ineligible variants fail-closed; approve-then-edit, approve-then-write, and approve-then-apply_patch through the ordinary MCP route; changed-value, real-credential, .env, out-of-scope, and stale-base refusals with unchanged file identity');
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
          closeTimer = setTimeout(() => reject(new Error('assignment approval stdio server did not exit after stdin close')), 10000);
        })
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
    client.close();
  }
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log('source-approval-assignment-smoke: PASS (approve-then-edit/write/apply_patch through ordinary MCP routes including the replace-chain file; changed, credential, .env, out-of-scope, and stale refusals unchanged; ineligible replace variants fail-closed; 22-entry union preserved)');
