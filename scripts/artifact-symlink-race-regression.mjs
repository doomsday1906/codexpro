#!/usr/bin/env node
// Public read_artifact regression for bounded/magic-byte reads and swaps that
// occur after PathGuard has resolved a regular in-workspace path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const importLocal = (name) => import(pathToFileURL(path.join(ROOT, 'dist', name)));
const [{ loadConfig }, { createCodexProServer }, { PathGuard }, { Client }, { InMemoryTransport }] = await Promise.all([
  importLocal('config.js'), importLocal('server.js'), importLocal('guard.js'),
  import(pathToFileURL(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'))),
  import(pathToFileURL(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js')))
]);

const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-artifact-race-'));
const root = path.join(temporary, 'workspace');
const outside = path.join(temporary, 'outside');
await fsp.mkdir(root);
await fsp.mkdir(outside);
const originalBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const outsideBytes = Buffer.from('OUTSIDE-SECRET');
await fsp.writeFile(path.join(root, 'image.bin'), originalBytes);
await fsp.writeFile(path.join(root, 'limited.bin'), Buffer.alloc(4097, 7));
await fsp.writeFile(path.join(outside, 'secret.bin'), outsideBytes);
await fsp.mkdir(path.join(root, 'nested'));
await fsp.writeFile(path.join(root, 'nested', 'final.bin'), originalBytes);
await fsp.symlink(path.join(root, 'image.bin'), path.join(root, 'image-alias.bin'));
await fsp.mkdir(path.join(outside, 'nested'));
await fsp.writeFile(path.join(outside, 'nested', 'final.bin'), outsideBytes);
await fsp.writeFile(path.join(root, 'handle.bin'), originalBytes);

const config = loadConfig(['--root', root]);
const server = createCodexProServer(config);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'artifact-symlink-race-regression', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
const call = (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root });
assert.equal(opened.isError, undefined, `open_workspace failed: ${JSON.stringify(opened)}`);
const workspaceId = opened.structuredContent.workspace_id;
const read = (filePath, max_bytes) => call('read_artifact', {
  workspace_id: workspaceId, path: filePath, ...(max_bytes === undefined ? {} : { max_bytes })
});
const assertRefused = async (result, label) => {
  assert.equal(result.isError, true, `${label} unexpectedly succeeded`);
  assert(!result.content?.some((item) => item.type === 'resource'), `${label} returned artifact bytes`);
};
const withPlatform = async (value, body) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value });
  try { return await body(); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
};

const originalResolve = PathGuard.prototype.resolve;
let swapAfterResolve = null;
PathGuard.prototype.resolve = function (workspace, inputPath, options) {
  const resolved = originalResolve.call(this, workspace, inputPath, options);
  if (swapAfterResolve?.inputPath === inputPath) swapAfterResolve.swap(resolved);
  return resolved;
};

try {
  // Stable public-route read: magic bytes override the misleading .bin suffix.
  const stable = await read('image.bin');
  assert.equal(stable.isError, undefined, `stable read failed: ${JSON.stringify(stable)}`);
  const resource = stable.content.find((item) => item.type === 'resource').resource;
  assert.equal(resource.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(resource.blob, 'base64'), originalBytes);
  assert.equal(stable.structuredContent.bytes, originalBytes.length);
  assert.equal(stable.structuredContent.sha256, createHash('sha256').update(originalBytes).digest('hex'));

  // Existing in-workspace symlink aliases remain readable via the canonical
  // target, while a missing target stays a refusal with no resource bytes.
  const alias = await read('image-alias.bin');
  assert.equal(alias.isError, undefined, `in-workspace alias read failed: ${JSON.stringify(alias)}`);
  assert.deepEqual(Buffer.from(alias.content.find((item) => item.type === 'resource').resource.blob, 'base64'), originalBytes);
  const missing = await read('missing.bin');
  await assertRefused(missing, 'missing artifact read');
  assert.match(missing.structuredContent?.error ?? missing.content?.[0]?.text ?? '', /File not found/,
    'missing artifact should preserve the public File not found error contract');

  // The public per-call cap is applied before returning any bytes.
  await assertRefused(await read('limited.bin', 4096), 'over-limit artifact read');

  // Replace a just-resolved file with an outside symlink. The final open must
  // refuse it, even though PathGuard already approved the old regular file.
  const finalPath = path.join(root, 'final-race.bin');
  const finalSaved = `${finalPath}.saved`;
  await fsp.writeFile(finalPath, originalBytes);
  swapAfterResolve = {
    inputPath: 'final-race.bin',
    swap: () => {
      fs.renameSync(finalPath, finalSaved);
      fs.symlinkSync(path.join(outside, 'secret.bin'), finalPath);
    }
  };
  await assertRefused(await read('final-race.bin'), 'post-resolution final-component symlink swap');
  swapAfterResolve = null;
  await fsp.unlink(finalPath);
  await fsp.rename(finalSaved, finalPath);

  // Repeat at an intermediate directory component.
  const nestedPath = path.join(root, 'nested');
  const nestedSaved = path.join(root, 'nested.saved');
  swapAfterResolve = {
    inputPath: 'nested/final.bin',
    swap: () => {
      fs.renameSync(nestedPath, nestedSaved);
      fs.symlinkSync(path.join(outside, 'nested'), nestedPath);
    }
  };
  await assertRefused(await read('nested/final.bin'), 'post-resolution intermediate-component symlink swap');
  swapAfterResolve = null;
  await fsp.unlink(nestedPath);
  await fsp.rename(nestedSaved, nestedPath);

  // Swap the final pathname immediately after open returns. A correct reader
  // consumes the already-open descriptor and returns the original inode bytes.
  const originalOpen = fsp.open;
  let replacedAfterOpen = false;
  fsp.open = async function (...args) {
    const handle = await originalOpen.apply(this, args);
    const openPath = String(args[0]);
    if (!replacedAfterOpen && (openPath.endsWith('/handle.bin') || openPath.endsWith('\\handle.bin'))) {
      replacedAfterOpen = true;
      const handlePath = path.join(root, 'handle.bin');
      fs.renameSync(handlePath, `${handlePath}.saved`);
      fs.symlinkSync(path.join(outside, 'secret.bin'), handlePath);
    }
    return handle;
  };
  let afterOpen;
  try {
    afterOpen = await read('handle.bin');
  } finally {
    fsp.open = originalOpen;
  }
  assert(replacedAfterOpen, 'test did not intercept the guarded final open');
  assert.equal(afterOpen.isError, undefined, `same-handle read failed: ${JSON.stringify(afterOpen)}`);
  const afterOpenResource = afterOpen.content.find((item) => item.type === 'resource').resource;
  assert.deepEqual(Buffer.from(afterOpenResource.blob, 'base64'), originalBytes,
    'read followed the substituted pathname instead of consuming the opened handle');
  await fsp.unlink(path.join(root, 'handle.bin'));
  await fsp.rename(path.join(root, 'handle.bin.saved'), path.join(root, 'handle.bin'));

  // Simulate the non-Linux implementation on this host. It must retain normal
  // alias reads, reject post-resolution swaps, and refuse a pathname swapped
  // immediately after open rather than returning bytes from an unverified fd.
  await withPlatform('win32', async () => {
    const fallbackAlias = await read('image-alias.bin');
    assert.equal(fallbackAlias.isError, undefined, `fallback alias read failed: ${JSON.stringify(fallbackAlias)}`);
    assert.deepEqual(Buffer.from(fallbackAlias.content.find((item) => item.type === 'resource').resource.blob, 'base64'), originalBytes);

    const fallbackFinal = path.join(root, 'fallback-final.bin');
    const fallbackSaved = `${fallbackFinal}.saved`;
    await fsp.writeFile(fallbackFinal, originalBytes);
    swapAfterResolve = {
      inputPath: 'fallback-final.bin',
      swap: () => {
        fs.renameSync(fallbackFinal, fallbackSaved);
        fs.symlinkSync(path.join(outside, 'secret.bin'), fallbackFinal);
      }
    };
    await assertRefused(await read('fallback-final.bin'), 'fallback post-resolution final symlink swap');
    swapAfterResolve = null;
    await fsp.unlink(fallbackFinal);
    await fsp.rename(fallbackSaved, fallbackFinal);

    const nestedPath = path.join(root, 'nested');
    const nestedSaved = path.join(root, 'nested.fallback-saved');
    swapAfterResolve = {
      inputPath: 'nested/final.bin',
      swap: () => {
        fs.renameSync(nestedPath, nestedSaved);
        fs.symlinkSync(path.join(outside, 'nested'), nestedPath);
      }
    };
    await assertRefused(await read('nested/final.bin'), 'fallback post-resolution intermediate symlink swap');
    swapAfterResolve = null;
    await fsp.unlink(nestedPath);
    await fsp.rename(nestedSaved, nestedPath);

    const fallbackHandle = path.join(root, 'fallback-handle.bin');
    await fsp.writeFile(fallbackHandle, originalBytes);
    const originalFallbackOpen = fsp.open;
    let replacedFallbackAfterOpen = false;
    fsp.open = async function (...args) {
      const handle = await originalFallbackOpen.apply(this, args);
      if (!replacedFallbackAfterOpen && String(args[0]) === fallbackHandle) {
        replacedFallbackAfterOpen = true;
        fs.renameSync(fallbackHandle, `${fallbackHandle}.saved`);
        fs.symlinkSync(path.join(outside, 'secret.bin'), fallbackHandle);
      }
      return handle;
    };
    let fallbackRace;
    try { fallbackRace = await read('fallback-handle.bin'); }
    finally { fsp.open = originalFallbackOpen; }
    assert(replacedFallbackAfterOpen, 'fallback test did not intercept the final open');
    await assertRefused(fallbackRace, 'fallback pathname replacement immediately after open');
    await fsp.unlink(fallbackHandle);
    await fsp.rename(`${fallbackHandle}.saved`, fallbackHandle);

    // Stronger fallback race: the open follows an outside symlink, then the
    // attacker restores the original pathname before post-open path checks.
    // Only comparing the opened handle's identity with the pre-open inode
    // catches this case.
    const identityPath = path.join(root, 'fallback-identity.bin');
    await fsp.writeFile(identityPath, originalBytes);
    const identitySaved = `${identityPath}.saved`;
    const identityOpen = fsp.open;
    let openedOutsideInode = false;
    fsp.open = async function (...args) {
      if (String(args[0]) !== identityPath) return identityOpen.apply(this, args);
      fs.renameSync(identityPath, identitySaved);
      fs.symlinkSync(path.join(outside, 'secret.bin'), identityPath);
      let handle;
      try {
        handle = await identityOpen.apply(this, args);
      } finally {
        fs.unlinkSync(identityPath);
        fs.renameSync(identitySaved, identityPath);
      }
      openedOutsideInode = true;
      return handle;
    };
    let identityRace;
    try { identityRace = await read('fallback-identity.bin'); }
    finally { fsp.open = identityOpen; }
    assert(openedOutsideInode, 'fallback identity test did not open through the substituted symlink');
    await assertRefused(identityRace, 'fallback outside inode opened then path restored before validation');
    assert.deepEqual(await fsp.readFile(identityPath), originalBytes, 'fallback race did not restore the in-workspace fixture');
  });
  console.log('PASS: public read_artifact stable bytes/MIME, size cap, missing/alias behavior, final/intermediate swap refusal, Linux same-handle read, and simulated non-Linux fallback refusal');
} finally {
  PathGuard.prototype.resolve = originalResolve;
  await client.close();
  await server.close();
  await fsp.rm(temporary, { recursive: true, force: true });
}
