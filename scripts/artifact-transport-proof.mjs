import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

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
      const msg = JSON.parse(line);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.child.stdin.write(encode(msg));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

function toolText(result) {
  return result.content?.find?.((part) => part.type === 'text')?.text ?? '';
}

async function expectToolError(client, name, args, pattern, label) {
  const result = await client.request('tools/call', { name, arguments: args });
  if (!result.isError) throw new Error(`${label}: ${name} unexpectedly succeeded`);
  const text = toolText(result);
  if (pattern && !pattern.test(text)) throw new Error(`${label}: error did not match ${pattern}: ${text}`);
  return text;
}

const passed = [];
function pass(label, detail = '') {
  passed.push(label);
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---- fixtures (temporary: use -> delete) ----
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-artifact-proof-'));
const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-artifact-outside-'));
const recordingDir = '/home/andrew/AgentWorkspace/evidence/threadmark/agent-operations-20260928/player-recording';
const mp4Name = 'ui-20260928T183008Z-233acccf-op-8964be82af2441cdb58cc89c471bfff8-video-20260928T183058726-127bccb6.mp4';
const mp4ExpectedSha = 'cb2b8e14c410be5241be00764c6c4b7cd5f9251e0ddfc72eacf05a6c130fd4d4';
const mp4ExpectedBytes = 709090;

const pixelBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
await fs.writeFile(path.join(tmp, 'pixel.png'), pixelBytes);
// Deterministic small binary incl. NUL + high bytes (no known magic => octet-stream fallback).
const fixtureBytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256));
await fs.writeFile(path.join(tmp, 'fixture.bin'), fixtureBytes);
// Tiny crafted ftyp/isom file => sniffed video/mp4 without needing the big MP4.
const miniMp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x01]),
  Buffer.from('isomiso2', 'ascii'),
  Buffer.from('payload-bytes-here-1234', 'ascii')
]);
await fs.writeFile(path.join(tmp, 'mini.mp4'), miniMp4);
await fs.mkdir(path.join(tmp, 'subdir'));
await fs.writeFile(path.join(outside, 'secret.bin'), Buffer.from([1, 2, 3, 4]));
let symlinkName = 'escape-link.bin';
try {
  await fs.symlink(path.join(outside, 'secret.bin'), path.join(tmp, symlinkName));
} catch (error) {
  if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  symlinkName = '';
}

const client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--allow-root', recordingDir, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    CODEXPRO_ROOT: tmp,
    CODEXPRO_ALLOWED_ROOTS: [tmp, recordingDir].join(path.delimiter),
    CODEXPRO_TOOL_CARDS: '0'
  }
});

try {
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'artifact-proof', version: '0.1.0' } });
  client.notify('notifications/initialized');

  // ---- discovery: read_artifact registered with the expected schema ----
  const tools = await client.request('tools/list', {});
  const names = tools.tools.map((t) => t.name);
  if (!names.includes('read_artifact')) throw new Error('read_artifact missing from tools/list');
  const schema = tools.tools.find((t) => t.name === 'read_artifact').inputSchema;
  for (const prop of ['workspace_id', 'path', 'max_bytes']) {
    if (!schema?.properties?.[prop]) throw new Error(`read_artifact schema missing ${prop}`);
  }
  pass('discovery:read_artifact-listed', `tools=${names.length}`);

  const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
  const ws = opened.structuredContent.workspace_id;

  async function readArtifact(args) {
    const result = await client.request('tools/call', { name: 'read_artifact', arguments: args });
    if (result.isError) throw new Error(`read_artifact failed: ${toolText(result)}`);
    return result;
  }

  // ---- A. existing image path still works (regression) ----
  const viewed = await client.request('tools/call', { name: 'view_image', arguments: { workspace_id: ws, path: 'pixel.png' } });
  const imagePart = viewed.content?.find?.((p) => p.type === 'image');
  if (!imagePart?.data || imagePart.mimeType !== 'image/png') throw new Error('view_image regression');
  pass('A:image-regression', 'view_image still returns native PNG content');

  // ---- B1. small ordinary binary fixture: exact bytes + MIME ----
  const bin = await readArtifact({ workspace_id: ws, path: 'fixture.bin' });
  const binRes = bin.content?.find?.((p) => p.type === 'resource');
  if (!binRes || binRes.resource.mimeType !== 'application/octet-stream') {
    throw new Error(`fixture MIME wrong: ${JSON.stringify(bin.structuredContent)}`);
  }
  const binDecoded = Buffer.from(binRes.resource.blob, 'base64');
  if (!binDecoded.equals(fixtureBytes)) throw new Error('fixture bytes differ');
  if (bin.structuredContent.bytes !== 4096 || bin.structuredContent.sha256 !== createHash('sha256').update(fixtureBytes).digest('hex')) {
    throw new Error('fixture metadata wrong');
  }
  if (toolText(bin).includes(binRes.resource.blob)) throw new Error('base64 leaked into text part');
  pass('B1:binary-fixture', 'exact 4096 bytes, application/octet-stream, no blob in text');

  // ---- B2. crafted ftyp sniff => video/mp4 ----
  const mini = await readArtifact({ workspace_id: ws, path: 'mini.mp4' });
  const miniRes = mini.content?.find?.((p) => p.type === 'resource');
  if (miniRes?.resource.mimeType !== 'video/mp4') throw new Error(`mini.mp4 MIME wrong: ${miniRes?.resource.mimeType}`);
  if (!Buffer.from(miniRes.resource.blob, 'base64').equals(miniMp4)) throw new Error('mini.mp4 bytes differ');
  pass('B2:sniff-ftyp', 'magic-byte video/mp4 on 47-byte input');

  // ---- C. retained real MP4 through the PUBLIC route ----
  const rec = await client.request('tools/call', { name: 'open_workspace', arguments: { root: recordingDir, include_tree: false } });
  const recWs = rec.structuredContent.workspace_id;
  const mp4 = await readArtifact({ workspace_id: recWs, path: mp4Name });
  const mp4Res = mp4.content?.find?.((p) => p.type === 'resource');
  if (mp4Res?.resource.mimeType !== 'video/mp4') throw new Error(`MP4 MIME wrong: ${mp4Res?.resource.mimeType}`);
  const mp4Decoded = Buffer.from(mp4Res.resource.blob, 'base64');
  const mp4Original = await fs.readFile(path.join(recordingDir, mp4Name));
  if (mp4Decoded.byteLength !== mp4ExpectedBytes || mp4Original.byteLength !== mp4ExpectedBytes) {
    throw new Error(`MP4 byte count wrong: got=${mp4Decoded.byteLength} file=${mp4Original.byteLength}`);
  }
  if (!mp4Decoded.equals(mp4Original)) throw new Error('MP4 bytes differ from retained original');
  const mp4Sha = createHash('sha256').update(mp4Decoded).digest('hex');
  if (mp4Sha !== mp4ExpectedSha || mp4.structuredContent.sha256 !== mp4ExpectedSha) {
    throw new Error(`MP4 sha mismatch: ${mp4Sha}`);
  }
  if (mp4.structuredContent.bytes !== mp4ExpectedBytes) throw new Error('MP4 metadata bytes wrong');
  pass('C:retained-mp4', `video/mp4, ${mp4Decoded.byteLength} bytes, sha ${mp4Sha.slice(0, 12)}…, exact identity`);

  // ---- negatives ----
  await expectToolError(client, 'read_artifact', { workspace_id: ws, path: 'no-such-file.bin' }, /File not found/, 'N1:missing');
  pass('N1:missing', 'honest File not found');
  await expectToolError(client, 'read_artifact', { workspace_id: ws, path: 'subdir' }, /Not a file/, 'N2:directory');
  pass('N2:directory', 'directories rejected');
  await expectToolError(client, 'read_artifact', { workspace_id: ws, path: '../outside.bin' }, /escapes workspace root/, 'N3:traversal');
  pass('N3:traversal', 'path traversal rejected');
  if (symlinkName) {
    await expectToolError(client, 'read_artifact', { workspace_id: ws, path: symlinkName }, /outside workspace root through a symlink/, 'N4:symlink-escape');
    pass('N4:symlink-escape', 'symlink escape rejected');
  } else {
    pass('N4:symlink-escape', 'skipped (symlinks unavailable on platform)');
  }
  await expectToolError(client, 'read_artifact', { workspace_id: recWs, path: mp4Name, max_bytes: 4096 }, /Artifact is too large \(709090 bytes\)/, 'N5:oversize');
  pass('N5:oversize', '709 KB artifact rejected under a 4096-byte bound');
  await expectToolError(client, 'read_artifact', { workspace_id: 'ws_000000000000000000000000', path: 'fixture.bin' }, /Unknown workspace_id/, 'N6:wrong-workspace');
  pass('N6:wrong-workspace', 'unknown workspace rejected');
  await expectToolError(client, 'read_artifact', { workspace_id: recWs, path: 'fixture.bin' }, /File not found/, 'N7:cross-workspace');
  pass('N7:cross-workspace', 'recording workspace cannot see tmp fixture');
  await expectToolError(client, 'read_artifact', { workspace_id: ws }, /Invalid|required/i, 'N8:malformed');
  pass('N8:malformed', 'missing path rejected');

  // ---- mode exposure: standard has it (ChatGPT-facing default), minimal does not ----
  async function listFor(mode) {
    const c = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe', '--tool-mode', mode], {
      cwd: path.resolve('.'),
      env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_TOOL_MODE: mode }
    });
    try {
      await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'artifact-proof-mode', version: '0.1.0' } });
      c.notify('notifications/initialized');
      const t = await c.request('tools/list', {});
      return t.tools.map((x) => x.name);
    } finally {
      c.close();
    }
  }
  const standardNames = await listFor('standard');
  if (!standardNames.includes('read_artifact') || !standardNames.includes('view_image')) {
    throw new Error('standard mode missing read_artifact/view_image');
  }
  pass('mode:standard', 'read_artifact exposed in default standard mode');
  const minimalNames = await listFor('minimal');
  if (minimalNames.includes('read_artifact')) throw new Error('minimal mode unexpectedly exposes read_artifact');
  pass('mode:minimal', 'read_artifact correctly absent from minimal mode');

  console.log(`\nARTIFACT_TRANSPORT_PROOF OK (${passed.length} checks)`);
} finally {
  client.close();
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
}
