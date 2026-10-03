import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectPythonCallKeywordApprovals, PYTHON_PROVENANCE_MAX_BYTES } from './python-provenance.mjs';
import { hasSecretValue } from './redaction-policy.mjs';
import { enrollSourceApproval, approvalRegistryPath } from './source-approvals.mjs';

const usage = 'node scripts/approve-source.mjs <absolute .py file> --expected-sha <sha256> --keywords token,work_token [--registry <file>]';
function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage + '\nOwner-only enrollment: allows unchanged exact string/None call values, including f-strings with reference interpolations and static format specs; never rewrites source or exempts definite credentials.');
    return;
  }
  const [sourcePath, ...flags] = args;
  if (!sourcePath || sourcePath.length > 4096 || !path.isAbsolute(sourcePath) || !/\.py$/iu.test(sourcePath)) throw new Error(usage);
  const options = new Map();
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--expected-sha', '--keywords', '--registry'].includes(flags[i]) || !flags[i + 1] || options.has(flags[i])) throw new Error(usage);
    options.set(flags[i], flags[i + 1]);
  }
  if ((options.get('--registry') || '').length > 4096) throw new Error(usage);
  const expected = options.get('--expected-sha');
  const keywords = (options.get('--keywords') || '').split(',');
  if (!/^[a-f0-9]{64}$/u.test(expected || '') || !keywords.length || keywords.length > 64
    || keywords.some((name) => name.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      || !/(?:token|secret|password|api_?key|private_?key)/iu.test(name))) throw new Error(usage);
  const canonical = fs.realpathSync(sourcePath);
  const fd = fs.openSync(canonical, 'r');
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > PYTHON_PROVENANCE_MAX_BYTES) throw new Error('Approval source exceeds the parser bound.');
    buffer = Buffer.alloc(PYTHON_PROVENANCE_MAX_BYTES + 1);
    let count = 0;
    while (count <= PYTHON_PROVENANCE_MAX_BYTES) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > PYTHON_PROVENANCE_MAX_BYTES) throw new Error('Approval source exceeds the parser bound.');
    buffer = buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) throw new Error('Source SHA does not match owner approval.');
  const source = buffer.toString('utf8');
  if (buffer.includes(0) || !Buffer.from(source).equals(buffer)) throw new Error('Approval requires UTF-8 text.');
  const entries = collectPythonCallKeywordApprovals(source, keywords);
  if (!entries.length) throw new Error('No eligible string/None call keyword values.');
  if (hasSecretValue(source, { context: 'source', language: 'python', approvedCallKeywordValues: entries })) {
    throw new Error('Independent credential or unapproved source candidate remains; approval refused.');
  }
  const registry = options.get('--registry') || approvalRegistryPath();
  if (path.resolve(registry) === canonical) throw new Error('Registry must be separate from source.');
  enrollSourceApproval({ path: canonical, source_sha256: actual, entries }, registry);
  console.log(JSON.stringify({ status: 'approved', path: canonical, source_sha256: actual,
    approved_values: entries.length, registry: path.resolve(registry), source_modified: false }));
}
try { main(process.argv.slice(2)); } catch (error) {
  console.error(error instanceof Error ? error.message : 'Source approval failed.');
  process.exitCode = 1;
}
