import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectPythonAssignApprovals, collectPythonCallKeywordApprovals, PYTHON_PROVENANCE_MAX_BYTES } from './python-provenance.mjs';
import { hasSecretValue } from './redaction-policy.mjs';
import { approvalsForRecord, enrollProspectiveApproval, enrollSourceApproval, approvalRegistryPath, readApprovalRegistry } from './source-approvals.mjs';

const usage = 'node scripts/approve-source.mjs <absolute .py file> --expected-sha <sha256> --keywords token,work_token [--registry <file>] [--prospective-from <absolute .py file>]';

function readBoundedBuffer(canonical, boundMessage) {
  const fd = fs.openSync(canonical, 'r');
  let buffer;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > PYTHON_PROVENANCE_MAX_BYTES) throw new Error(boundMessage);
    buffer = Buffer.alloc(PYTHON_PROVENANCE_MAX_BYTES + 1);
    let count = 0;
    while (count <= PYTHON_PROVENANCE_MAX_BYTES) {
      const read = fs.readSync(fd, buffer, count, buffer.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count > PYTHON_PROVENANCE_MAX_BYTES) throw new Error(boundMessage);
    buffer = buffer.subarray(0, count);
  } finally { fs.closeSync(fd); }
  return buffer;
}

function readTextSource(canonical, boundMessage, textMessage) {
  const buffer = readBoundedBuffer(canonical, boundMessage);
  const source = buffer.toString('utf8');
  if (buffer.includes(0) || !Buffer.from(source).equals(buffer)) throw new Error(textMessage);
  return { buffer, source, sha256: createHash('sha256').update(buffer).digest('hex') };
}

// Reviewed constructs are parser-owned call keyword values plus parser-owned
// local assignment values (`AssignStatement Name = RHS` bound to the
// enclosing function scope). Both enroll as hash-only triples; the registry
// never holds literals.
function collectReviewedApprovals(sourceText, keywords) {
  const calls = collectPythonCallKeywordApprovals(sourceText, keywords);
  const assigns = collectPythonAssignApprovals(sourceText, keywords);
  return [...new Map([...calls, ...assigns]
    .map((entry) => [JSON.stringify(entry), entry])).values()];
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage + '\nOwner-only enrollment: allows unchanged exact string/None call values and parser-owned local assignment values (AssignStatement Name = RHS bound to file plus enclosing function), including f-strings with reference interpolations and static format specs; never rewrites source or exempts definite credentials.'
      + '\n--prospective-from reviews a distinct proposed file and binds its exact keyword/callee/value hash triples to the current base SHA, so a reviewed nonsecret patch is approvable before it is written. Existing entries are preserved by union; a stale base is refused.');
    return;
  }
  const [sourcePath, ...flags] = args;
  if (!sourcePath || sourcePath.length > 4096 || !path.isAbsolute(sourcePath) || !/\.py$/iu.test(sourcePath)) throw new Error(usage);
  const options = new Map();
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--expected-sha', '--keywords', '--registry', '--prospective-from'].includes(flags[i]) || !flags[i + 1] || options.has(flags[i])) throw new Error(usage);
    options.set(flags[i], flags[i + 1]);
  }
  if ((options.get('--registry') || '').length > 4096) throw new Error(usage);
  const prospectiveFrom = options.get('--prospective-from');
  if (prospectiveFrom !== undefined
    && (prospectiveFrom.length > 4096 || !path.isAbsolute(prospectiveFrom) || !/\.py$/iu.test(prospectiveFrom))) {
    throw new Error(usage);
  }
  const expected = options.get('--expected-sha');
  const keywords = (options.get('--keywords') || '').split(',');
  if (!/^[a-f0-9]{64}$/u.test(expected || '') || !keywords.length || keywords.length > 64
    || keywords.some((name) => name.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
      || !/(?:token|secret|password|api_?key|private_?key)/iu.test(name))) throw new Error(usage);
  const canonical = fs.realpathSync(sourcePath);
  const registry = options.get('--registry') || approvalRegistryPath();
  if (path.resolve(registry) === canonical) throw new Error('Registry must be separate from source.');
  const base = readTextSource(canonical,
    'Approval source exceeds the parser bound.',
    'Approval requires UTF-8 text.');
  if (base.sha256 !== expected) throw new Error('Source SHA does not match owner approval.');
  if (prospectiveFrom === undefined) {
    const entries = collectReviewedApprovals(base.source, keywords);
    if (!entries.length) throw new Error('No eligible string/None call keyword or assignment values.');
    if (hasSecretValue(base.source, { context: 'source', language: 'python', approvedCallKeywordValues: entries })) {
      throw new Error('Independent credential or unapproved source candidate remains; approval refused.');
    }
    enrollSourceApproval({ path: canonical, source_sha256: base.sha256, entries }, registry);
    console.log(JSON.stringify({ status: 'approved', path: canonical, source_sha256: base.sha256,
      approved_values: entries.length, registry: path.resolve(registry), source_modified: false }));
    return;
  }
  const proposedCanonical = fs.realpathSync(prospectiveFrom);
  if (proposedCanonical === canonical) {
    throw new Error('Prospective approval requires a distinct reviewed artifact; the proposed content is not yet in the source file.');
  }
  if (path.resolve(registry) === proposedCanonical) throw new Error('Registry must be separate from source.');
  const proposed = readTextSource(proposedCanonical,
    'Prospective approval source exceeds the parser bound.',
    'Prospective approval requires UTF-8 text.');
  const proposedEntries = collectReviewedApprovals(proposed.source, keywords);
  if (!proposedEntries.length) throw new Error('No eligible string/None call keyword or assignment values.');
  // The reviewed result must be nonsecret with exactly the proposed triples
  // exempted. Only bytes within an exact approved RHS are exempted; every
  // surrounding byte is still scanned.
  if (hasSecretValue(proposed.source, { context: 'source', language: 'python', approvedCallKeywordValues: proposedEntries })) {
    throw new Error('Independent credential or unapproved source candidate remains; approval refused.');
  }
  // The live base must itself hold no unapproved credential candidate under
  // the currently applicable entries plus the proposed triples. A dirty base
  // cannot receive a prospective patch.
  const record = readApprovalRegistry(registry).files.find((file) => file.path === canonical);
  const applicable = approvalsForRecord(record, base.sha256);
  const combined = [...new Map([...applicable, ...proposedEntries]
    .map((entry) => [JSON.stringify(entry), entry])).values()];
  if (hasSecretValue(base.source, { context: 'source', language: 'python', approvedCallKeywordValues: combined })) {
    throw new Error('Current source holds an unapproved credential candidate; approval refused.');
  }
  enrollProspectiveApproval({
    path: canonical,
    base_sha256: base.sha256,
    result_sha256: proposed.sha256,
    entries: proposedEntries
  }, registry);
  console.log(JSON.stringify({ status: 'approved', prospective: true, path: canonical,
    base_sha256: base.sha256, result_sha256: proposed.sha256,
    approved_values: proposedEntries.length, registry: path.resolve(registry), source_modified: false }));
}
try { main(process.argv.slice(2)); } catch (error) {
  console.error(error instanceof Error ? error.message : 'Source approval failed.');
  process.exitCode = 1;
}
