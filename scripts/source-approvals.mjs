import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES = 1_048_576;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/u;
export const approvalRegistryPath = () => path.resolve(process.env.CODEXPRO_SOURCE_APPROVALS_FILE
  || path.join(os.homedir(), '.codexpro', 'source-approvals.json'));

function validateRegistry(value) {
  const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  if (!exactKeys(value, ['version', 'files']) || value.version !== 1
    || !Array.isArray(value.files) || value.files.length > 256) throw new Error('Invalid source approval registry.');
  const paths = new Set();
  for (const file of value.files) {
    if (!exactKeys(file, ['path', 'source_sha256', 'entries']) || typeof file.path !== 'string'
      || !path.isAbsolute(file.path) || file.path.length > 4096 || paths.has(file.path)
      || !digest.test(file.source_sha256) || !Array.isArray(file.entries) || file.entries.length > 2048) {
      throw new Error('Invalid source approval file entry.');
    }
    paths.add(file.path);
    for (const entry of file.entries) {
      if (!exactKeys(entry, ['keyword_sha256', 'callee_sha256', 'value_sha256'])
        || !Object.values(entry).every((value) => typeof value === 'string' && digest.test(value))) {
        throw new Error('Invalid source approval value entry.');
      }
    }
  }
  return value;
}

export function readApprovalRegistry(registryPath = approvalRegistryPath()) {
  let fd;
  try {
    fd = fs.openSync(registryPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, files: [] };
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Source approval registry exceeds its bound.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count <= MAX_BYTES) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > MAX_BYTES) throw new Error('Source approval registry exceeds its bound.');
    return validateRegistry(JSON.parse(buffer.subarray(0, count).toString('utf8')));
  } finally { fs.closeSync(fd); }
}

export function loadCallKeywordApprovals(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return [];
  try {
    let canonical;
    try { canonical = fs.realpathSync(sourcePath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      canonical = path.join(fs.realpathSync(path.dirname(sourcePath)), path.basename(sourcePath));
    }
    return readApprovalRegistry().files.find((file) => file.path === canonical)?.entries ?? [];
  } catch { return []; }
}

export function enrollSourceApproval(file, registryPath = approvalRegistryPath()) {
  registryPath = path.resolve(registryPath);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const lock = registryPath + '.lock';
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  const temporary = registryPath + '.' + randomUUID() + '.tmp';
  try {
    const registry = readApprovalRegistry(registryPath);
    registry.files = registry.files.filter((entry) => entry.path !== file.path);
    registry.files.push(file);
    validateRegistry(registry);
    const serialized = JSON.stringify(registry, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Source approval registry exceeds its bound.');
    const sourceFd = fs.openSync(file.path, 'r');
    let sourceBuffer;
    try {
      const sourceStat = fs.fstatSync(sourceFd);
      if (!sourceStat.isFile() || sourceStat.size > 2_000_000) throw new Error('Source changed during approval.');
      sourceBuffer = Buffer.alloc(2_000_001);
      let count = 0;
      while (count < sourceBuffer.length) {
        const read = fs.readSync(sourceFd, sourceBuffer, count, sourceBuffer.length - count, count);
        if (!read) break;
        count += read;
      }
      if (count > 2_000_000) throw new Error('Source changed during approval.');
      sourceBuffer = sourceBuffer.subarray(0, count);
    } finally { fs.closeSync(sourceFd); }
    if (hash(sourceBuffer) !== file.source_sha256) throw new Error('Source changed during approval; retry with its current SHA.');
    fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, registryPath);
  } finally {
    try {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } finally {
      try { fs.closeSync(lockFd); } finally { fs.unlinkSync(lock); }
    }
  }
}

