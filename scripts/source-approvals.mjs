import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_BYTES = 1_048_576;
// One prospective binding authorizes a single reviewed base -> result
// transition for one canonical path. The bound keeps the registry small while
// a stale base (or an unreviewed result) keeps prospective triples out of
// scans instead of failing closed on registry size.
const MAX_PROSPECTIVE_PER_FILE = 64;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/u;
export const approvalRegistryPath = () => path.resolve(process.env.CODEXPRO_SOURCE_APPROVALS_FILE
  || path.join(os.homedir(), '.codexpro', 'source-approvals.json'));

function validateRegistry(value) {
  const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
  const validTriple = (entry) => exactKeys(entry, ['keyword_sha256', 'callee_sha256', 'value_sha256'])
    && Object.values(entry).every((item) => typeof item === 'string' && digest.test(item));
  if (!exactKeys(value, ['version', 'files']) || value.version !== 1
    || !Array.isArray(value.files) || value.files.length > 256) throw new Error('Invalid source approval registry.');
  const paths = new Set();
  for (const file of value.files) {
    const fileKeys = Object.hasOwn(file, 'prospective')
      ? ['path', 'source_sha256', 'entries', 'prospective']
      : ['path', 'source_sha256', 'entries'];
    if (!exactKeys(file, fileKeys) || typeof file.path !== 'string'
      || !path.isAbsolute(file.path) || file.path.length > 4096 || paths.has(file.path)
      || !digest.test(file.source_sha256) || !Array.isArray(file.entries) || file.entries.length > 2048) {
      throw new Error('Invalid source approval file entry.');
    }
    paths.add(file.path);
    for (const entry of file.entries) {
      if (!validTriple(entry)) throw new Error('Invalid source approval value entry.');
    }
    if (Object.hasOwn(file, 'prospective')) {
      if (!Array.isArray(file.prospective) || file.prospective.length > MAX_PROSPECTIVE_PER_FILE) {
        throw new Error('Invalid prospective source approval bindings.');
      }
      for (const item of file.prospective) {
        if (!exactKeys(item, ['base_sha256', 'result_sha256', 'entries'])
          || !digest.test(item.base_sha256) || !digest.test(item.result_sha256)
          || !Array.isArray(item.entries) || item.entries.length === 0 || item.entries.length > 2048
          || !item.entries.every(validTriple)) {
          throw new Error('Invalid prospective source approval binding.');
        }
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

const tripleKey = (entry) => `${entry.keyword_sha256}:${entry.callee_sha256}:${entry.value_sha256}`;

function unionTriples(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const entry of list ?? []) {
      const key = tripleKey(entry);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(entry);
      }
    }
  }
  return merged;
}

// Applicable triples for one registry record at one observed content digest.
// Retrospective entries stay unconditional (existing steady-state behavior);
// a prospective binding contributes only while the live bytes still equal its
// reviewed base (pre-apply) or its reviewed result (post-apply steady state).
// Anything else — a stale or drifted file — scans without those triples.
export function approvalsForRecord(record, currentDigest) {
  if (!record || typeof record !== 'object') return [];
  const merged = [...(Array.isArray(record.entries) ? record.entries : [])];
  if (typeof currentDigest === 'string') {
    for (const item of Array.isArray(record.prospective) ? record.prospective : []) {
      if ((item?.base_sha256 === currentDigest || item?.result_sha256 === currentDigest)
        && Array.isArray(item?.entries)) {
        merged.push(...item.entries);
      }
    }
  }
  return [...new Map(merged.map((entry) => [tripleKey(entry), entry])).values()];
}

export function loadCallKeywordApprovals(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return [];
  try {
    let canonical;
    try { canonical = fs.realpathSync(sourcePath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      canonical = path.join(fs.realpathSync(path.dirname(sourcePath)), path.basename(sourcePath));
    }
    const record = readApprovalRegistry().files.find((file) => file.path === canonical);
    if (!record) return [];
    if (!Array.isArray(record.prospective) || record.prospective.length === 0) return [...record.entries];
    let currentDigest;
    try {
      currentDigest = hash(fs.readFileSync(canonical));
    } catch {
      currentDigest = undefined;
    }
    return approvalsForRecord(record, currentDigest);
  } catch { return []; }
}

function mergeProspective(prior, next) {
  const merged = [];
  for (const item of [...(prior ?? []), ...(next ?? [])]) {
    if (!item || typeof item !== 'object') throw new Error('Invalid prospective source approval binding.');
    const at = merged.findIndex((candidate) => candidate.base_sha256 === item.base_sha256
      && candidate.result_sha256 === item.result_sha256);
    if (at >= 0) {
      merged[at] = { ...merged[at], entries: unionTriples(merged[at].entries, item.entries) };
    } else {
      merged.push({
        base_sha256: item.base_sha256,
        result_sha256: item.result_sha256,
        entries: unionTriples(item.entries)
      });
    }
  }
  if (merged.length > MAX_PROSPECTIVE_PER_FILE) {
    throw new Error('Source approval prospective bindings exceed their bound.');
  }
  return merged;
}

export function enrollSourceApproval(file, registryPath = approvalRegistryPath()) {
  registryPath = path.resolve(registryPath);
  if (Object.hasOwn(file ?? {}, 'prospective') && !Array.isArray(file.prospective)) {
    throw new Error('Invalid prospective source approval bindings.');
  }
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const lock = registryPath + '.lock';
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  const temporary = registryPath + '.' + randomUUID() + '.tmp';
  try {
    const registry = readApprovalRegistry(registryPath);
    const at = registry.files.findIndex((entry) => entry.path === file.path);
    const prior = at >= 0 ? registry.files[at] : undefined;
    // Merge/union: a re-enrollment adds triples and refreshes the base digest
    // but never replaces a wider enrollment with a narrower subset.
    const next = {
      path: file.path,
      source_sha256: file.source_sha256,
      entries: unionTriples(prior?.entries, file.entries)
    };
    const prospective = mergeProspective(prior?.prospective, file.prospective);
    if (prospective.length > 0) next.prospective = prospective;
    if (at >= 0) registry.files[at] = next;
    else registry.files.push(next);
    validateRegistry(registry);
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
    const serialized = JSON.stringify(registry, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Source approval registry exceeds its bound.');
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

// Prospective enrollment for a reviewed patch that is not yet written. The
// reviewed base digest is bound to source_sha256 (the same field retrospective
// enrollment uses) and to the prospective base binding; the exact proposed
// keyword/callee/value hash triples carry no literals. The live file must
// still equal the base when the registry commits, otherwise enrollment fails
// and the registry is untouched.
export function enrollProspectiveApproval(file, registryPath = approvalRegistryPath()) {
  const validTriple = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && Object.keys(entry).length === 3
    && ['keyword_sha256', 'callee_sha256', 'value_sha256']
      .every((key) => typeof entry[key] === 'string' && digest.test(entry[key]));
  if (!file || typeof file !== 'object'
    || typeof file.path !== 'string' || !path.isAbsolute(file.path) || file.path.length > 4096
    || typeof file.base_sha256 !== 'string' || !digest.test(file.base_sha256)
    || typeof file.result_sha256 !== 'string' || !digest.test(file.result_sha256)
    || !Array.isArray(file.entries) || file.entries.length === 0 || file.entries.length > 2048
    || !file.entries.every(validTriple)) {
    throw new Error('Invalid prospective source approval.');
  }
  enrollSourceApproval({
    path: file.path,
    source_sha256: file.base_sha256,
    entries: [],
    prospective: [{
      base_sha256: file.base_sha256,
      result_sha256: file.result_sha256,
      entries: file.entries
    }]
  }, registryPath);
}
