// list-verification-jobs boundary check: the MCP transport envelope stays
// permissive (passthrough) while the strict runtime schema owns rejection.
// Malformed and unknown-key inputs must fail at runtime validation with a
// clean error that never echoes secret-looking values through SDK errors.
//
// Known-behaviour notes (documented, not changed — behaviour change was
// considered and rejected in favour of documentation):
// - list_verification_jobs is FULL tool-mode only: it is absent from both
//   STANDARD_TOOL_NAMES and MINIMAL_TOOL_NAMES in src/server.ts, so
//   shouldRegisterTool() registers it only when toolMode === 'full'. The
//   standard-mode absence assertion below pins this.
// - Managed verification descendant cleanup is Linux-only best effort:
//   VerificationJob.settleRootClose() in src/verificationOps.ts only walks,
//   signals, and escalates owned descendants when process.platform === 'linux';
//   on other platforms the job transitions directly with no descendant sweep
//   (best-effort/no-op cleanup there).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-list-jobs-boundary-'));
let client;
try {
  await fs.writeFile(path.join(tmp, 'probe.txt'), 'boundary probe\n', 'utf8');
  for (const args of [['init', '-q'], ['add', '.']]) {
    const staged = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
    assert.equal(staged.status, 0, `git ${args.join(' ')} failed: ${staged.stderr || staged.stdout}`);
  }
  const committed = spawnSync('git', ['-c', 'user.email=boundary@example.com', '-c', 'user.name=Boundary', 'commit', '-qm', 'boundary fixture'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(committed.status, 0, `git commit failed: ${committed.stderr || committed.stdout}`);

  client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'workspace', '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'workspace',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0'
    }
  });
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-list-jobs-boundary', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
  assert.notEqual(opened.isError, true, `open_current_workspace failed: ${resultText(opened)}`);
  const workspaceId = opened.structuredContent.workspace_id;
  assert.ok(workspaceId, 'open_current_workspace omitted workspace id');

  // 1. Valid input lists (empty) retained jobs.
  const valid = await client.request('tools/call', { name: 'list_verification_jobs', arguments: { workspace_id: workspaceId } });
  assert.notEqual(valid.isError, true, `valid list_verification_jobs failed: ${resultText(valid)}`);
  assert.ok(Array.isArray(valid.structuredContent.jobs), 'valid list_verification_jobs omitted jobs');

  // Secret-looking literals are assembled so the fixture never appears
  // literally in this script; the refusal/error envelopes must never echo them.
  const secretValue = ['-----BEGIN PRIVATE ', 'KEY-----'].join('') + '\nSYNTHETIC_BOUNDARY_BODY_9Z1\n-----END PRIVATE KEY-----';
  const secretMarker = 'SYNTHETIC_BOUNDARY_BODY_9Z1';

  // 2. Unknown keys pass the permissive transport envelope, then fail strict
  // runtime validation with a clean error naming only the caller key.
  const unknownKey = 'probe_extra_key';
  const unknown = await client.request('tools/call', {
    name: 'list_verification_jobs',
    arguments: { workspace_id: workspaceId, [unknownKey]: secretValue }
  });
  assert.equal(unknown.isError, true, 'unknown-key list_verification_jobs unexpectedly succeeded');
  assert.match(resultText(unknown), /Invalid arguments for list_verification_jobs/, 'unknown-key rejection did not come from runtime validation');
  assert.match(resultText(unknown), /nknown keys|nrecognized/i, 'unknown-key rejection omitted the strict unknown-keys cause');
  assert.ok(resultText(unknown).includes(unknownKey), 'unknown-key rejection hid the offending caller key');
  assert.equal(JSON.stringify(unknown).includes(secretValue), false, 'unknown-key rejection echoed the secret-looking value');
  assert.equal(JSON.stringify(unknown).includes(secretMarker), false, 'unknown-key rejection echoed the secret marker');

  // 3. Wrong types fail runtime validation without echo.
  const wrongType = await client.request('tools/call', {
    name: 'list_verification_jobs',
    arguments: { workspace_id: 12345, [unknownKey]: secretValue }
  });
  assert.equal(wrongType.isError, true, 'wrong-type list_verification_jobs unexpectedly succeeded');
  assert.match(resultText(wrongType), /Invalid arguments for list_verification_jobs/, 'wrong-type rejection did not come from runtime validation');
  assert.match(resultText(wrongType), /workspace_id/, 'wrong-type rejection omitted the offending field');
  assert.equal(JSON.stringify(wrongType).includes(secretMarker), false, 'wrong-type rejection echoed the secret marker');

  // 4. Missing workspace_id fails runtime validation.
  const missing = await client.request('tools/call', { name: 'list_verification_jobs', arguments: {} });
  assert.equal(missing.isError, true, 'missing workspace_id list_verification_jobs unexpectedly succeeded');
  assert.match(resultText(missing), /Invalid arguments for list_verification_jobs/, 'missing workspace_id rejection did not come from runtime validation');
  assert.match(resultText(missing), /workspace_id/, 'missing workspace_id rejection omitted the required field');

  console.log(`list-verification-jobs-boundary-smoke: PASS (${tmp})`);
} finally {
  client?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

// 5. Full-mode only: in STANDARD tool mode the tool is not registered at all
// (absent from STANDARD_TOOL_NAMES/MINIMAL_TOOL_NAMES), so the call fails as
// an unknown tool. Separate bounded server; same fixture shape as above.
{
  const tmpStandard = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-list-jobs-standard-'));
  let standardClient;
  try {
    await fs.writeFile(path.join(tmpStandard, 'probe.txt'), 'standard probe\n', 'utf8');
    for (const args of [['init', '-q'], ['add', '.']]) {
      const staged = spawnSync('git', args, { cwd: tmpStandard, encoding: 'utf8' });
      assert.equal(staged.status, 0, `git ${args.join(' ')} failed: ${staged.stderr || staged.stdout}`);
    }
    const committed = spawnSync('git', ['-c', 'user.email=standard@example.com', '-c', 'user.name=Standard', 'commit', '-qm', 'standard fixture'], { cwd: tmpStandard, encoding: 'utf8' });
    assert.equal(committed.status, 0, `git commit failed: ${committed.stderr || committed.stdout}`);

    standardClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmpStandard, '--allow-root', tmpStandard, '--bash', 'off', '--write', 'workspace', '--tool-mode', 'standard'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CODEXPRO_ROOT: tmpStandard,
        CODEXPRO_ALLOWED_ROOTS: tmpStandard,
        CODEXPRO_BASH_MODE: 'off',
        CODEXPRO_WRITE_MODE: 'workspace',
        CODEXPRO_TOOL_MODE: 'standard',
        CODEXPRO_TOOL_CARDS: '0'
      }
    });
    await standardClient.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codexpro-list-jobs-standard', version: '0.1.0' }
    });
    standardClient.notify('notifications/initialized');

    const openedStandard = await standardClient.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
    assert.notEqual(openedStandard.isError, true, `standard open_current_workspace failed: ${resultText(openedStandard)}`);
    const standardWorkspaceId = openedStandard.structuredContent.workspace_id;
    assert.ok(standardWorkspaceId, 'standard open_current_workspace omitted workspace id');

    let standardError = null;
    // Note: an unregistered tool surfaces as a normal result with isError
    // (MCP -32602 "Tool ... not found"), not as a JSON-RPC message.error.
    const standardCall = await standardClient.request('tools/call', { name: 'list_verification_jobs', arguments: { workspace_id: standardWorkspaceId } });
    assert.equal(standardCall.isError, true, 'list_verification_jobs unexpectedly succeeded in standard tool mode (it is full-mode only)');
    assert.match(resultText(standardCall), /not found|unknown tool/i, `standard-mode rejection was not a not-found error: ${resultText(standardCall).slice(0, 300)}`);
    console.log(`list-verification-jobs-standard-absence-smoke: PASS (${tmpStandard})`);
  } finally {
    standardClient?.close();
    await fs.rm(tmpStandard, { recursive: true, force: true });
  }
}
