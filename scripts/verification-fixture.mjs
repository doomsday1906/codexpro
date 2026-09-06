#!/usr/bin/env node
// Bounded verification test fixture for RepoConnect M009 tests.
// Provides a lawful finite verification execution target without --watch.

const args = process.argv.slice(2);

let sleepMs = 30000;
const sleepIdx = args.indexOf('--sleep');
if (sleepIdx !== -1 && args[sleepIdx + 1]) {
  sleepMs = parseInt(args[sleepIdx + 1], 10);
}

let exitCode = 0;
const exitIdx = args.indexOf('--exit');
if (exitIdx !== -1 && args[exitIdx + 1]) {
  exitCode = parseInt(args[exitIdx + 1], 10);
  if (sleepIdx === -1) {
    sleepMs = 0;
  }
}

const stdoutIdx = args.indexOf('--stdout');
if (stdoutIdx !== -1 && args[stdoutIdx + 1]) {
  const count = parseInt(args[stdoutIdx + 1], 10);
  if (!isNaN(count)) {
    process.stdout.write('X'.repeat(count));
  } else {
    process.stdout.write(args[stdoutIdx + 1]);
  }
}

const stderrIdx = args.indexOf('--stderr');
if (stderrIdx !== -1 && args[stderrIdx + 1]) {
  const count = parseInt(args[stderrIdx + 1], 10);
  if (!isNaN(count)) {
    process.stderr.write('Y'.repeat(count));
  } else {
    process.stderr.write(args[stderrIdx + 1]);
  }
}

const credIdx = args.indexOf('--emit-credentials');
if (credIdx !== -1 && args[credIdx + 1]) {
  const count = parseInt(args[credIdx + 1], 10);
  for (let i = 0; i < count; i++) {
    process.stdout.write('secret=abc\n');
  }
}

const utf8Idx = args.indexOf('--emit-utf8');
if (utf8Idx !== -1 && args[utf8Idx + 1]) {
  const count = parseInt(args[utf8Idx + 1], 10);
  for (let i = 0; i < count; i++) {
    process.stdout.write('🌟🌟🌟\n');
  }
}

const prefixCredIdx = args.indexOf('--emit-prefix-credential');
if (prefixCredIdx !== -1 && args[prefixCredIdx + 1] && args[prefixCredIdx + 2]) {
  const label = args[prefixCredIdx + 1];
  const val = args[prefixCredIdx + 2];
  process.stdout.write(`${label}=${val}\n`);
}

const chunkCredIdx = args.indexOf('--emit-chunk-credential');
if (chunkCredIdx !== -1 && args[chunkCredIdx + 1] && args[chunkCredIdx + 2]) {
  const label = args[chunkCredIdx + 1];
  const val = args[chunkCredIdx + 2];
  const filler = args[chunkCredIdx + 3] ? parseInt(args[chunkCredIdx + 3], 10) : 0;
  process.stdout.write(`${label}=`);
  process.stdout.write(`${val}\n`);
  if (filler > 0) {
    process.stdout.write('F'.repeat(filler) + '\n');
  }
}

const authIdx = args.indexOf('--emit-authorization');
if (authIdx !== -1 && args[authIdx + 1]) {
  const authVal = args[authIdx + 1];
  const filler = args[authIdx + 2] ? parseInt(args[authIdx + 2], 10) : 0;
  process.stdout.write(`Authorization: Bearer ${authVal}\n`);
  if (filler > 0) {
    process.stdout.write('F'.repeat(filler) + '\n');
  }
}

const privKeyIdx = args.indexOf('--emit-private-key');
if (privKeyIdx !== -1 && args[privKeyIdx + 1]) {
  const count = parseInt(args[privKeyIdx + 1], 10);
  process.stdout.write('-----BEGIN RSA PRIVATE KEY-----\n');
  for (let i = 0; i < count; i++) {
    process.stdout.write(`MIIEowIBAAKCAQEA0tC3F5Yfakekeymaterialline${i}\n`);
  }
  process.stdout.write('-----END RSA PRIVATE KEY-----\n');
  process.stdout.write('normal trailing output line\n');
}

const unclosedKeyIdx = args.indexOf('--emit-unclosed-private-key');
if (unclosedKeyIdx !== -1 && args[unclosedKeyIdx + 1]) {
  const count = parseInt(args[unclosedKeyIdx + 1], 10);
  process.stdout.write('-----BEGIN RSA PRIVATE KEY-----\n');
  for (let i = 0; i < count; i++) {
    process.stdout.write(`MIIEowIBAAKCAQEA0tC3F5Yfakeunclosedkeymaterialline${i}\n`);
  }
}

const overlongCredIdx = args.indexOf('--emit-overlong-credential');
if (overlongCredIdx !== -1) {
  let label = 'MY_CUSTOM_SECRET_KEY';
  let val = 'syntheticordinarysecret999';
  let prefixLen = 2030;
  let suffixLen = 2500;
  if (args[overlongCredIdx + 1]?.includes('=')) {
    const eqIdx = args[overlongCredIdx + 1].indexOf('=');
    label = args[overlongCredIdx + 1].slice(0, eqIdx);
    val = args[overlongCredIdx + 1].slice(eqIdx + 1);
    prefixLen = args[overlongCredIdx + 2] ? parseInt(args[overlongCredIdx + 2], 10) : 2030;
    suffixLen = args[overlongCredIdx + 3] ? parseInt(args[overlongCredIdx + 3], 10) : 2500;
  } else if (args[overlongCredIdx + 1] && !args[overlongCredIdx + 1].startsWith('-') && args[overlongCredIdx + 2] && !args[overlongCredIdx + 2].startsWith('-')) {
    label = args[overlongCredIdx + 1];
    val = args[overlongCredIdx + 2];
    prefixLen = args[overlongCredIdx + 3] ? parseInt(args[overlongCredIdx + 3], 10) : 2030;
    suffixLen = args[overlongCredIdx + 4] ? parseInt(args[overlongCredIdx + 4], 10) : 2500;
  }
  process.stdout.write('A'.repeat(prefixLen) + ' ' + label + '=' + val + ' ' + 'B'.repeat(suffixLen));
}

const overlongAuthIdx = args.indexOf('--emit-overlong-authorization');
if (overlongAuthIdx !== -1) {
  let val = 'syntheticauthsecret789';
  let prefixLen = 2030;
  let suffixLen = 2500;
  if (args[overlongAuthIdx + 1] && !args[overlongAuthIdx + 1].startsWith('-')) {
    const raw = args[overlongAuthIdx + 1];
    const match = raw.match(/Authorization:\s*Bearer\s+(.*)/i);
    val = match ? match[1] : raw;
    prefixLen = args[overlongAuthIdx + 2] ? parseInt(args[overlongAuthIdx + 2], 10) : 2030;
    suffixLen = args[overlongAuthIdx + 3] ? parseInt(args[overlongAuthIdx + 3], 10) : 2500;
  }
  process.stdout.write('A'.repeat(prefixLen) + ' Authorization: Bearer ' + val + ' ' + 'B'.repeat(suffixLen));
}

const overlongRepeatedIdx = args.indexOf('--emit-overlong-repeated');
if (overlongRepeatedIdx !== -1) {
  const extractVal = (arg, defaultVal) => {
    if (!arg || arg.startsWith('-')) return defaultVal;
    if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
    const m = arg.match(/Authorization:\s*Bearer\s+(.*)/i);
    if (m) return m[1];
    return arg;
  };
  const val1 = extractVal(args[overlongRepeatedIdx + 1], 'repeatedsecretone111');
  const val2 = extractVal(args[overlongRepeatedIdx + 2], 'repeatedsecrettwo222');
  const val3 = extractVal(args[overlongRepeatedIdx + 3], 'repeatedsecretthree333');
  process.stdout.write('A'.repeat(2030) + ' MY_TOKEN1=' + val1 + ' ' + 'B'.repeat(3000));
  process.stdout.write('C'.repeat(1000) + ' Authorization: Bearer ' + val2 + '\n' + 'D'.repeat(3000));
  process.stdout.write('E'.repeat(1000) + ' ADMIN_PASSWORD=' + val3 + ' ' + 'F'.repeat(4000));
}

const longGapIdx = args.indexOf('--emit-long-gap-credential');
if (longGapIdx !== -1) {
  let gap = 5000;
  if (args[longGapIdx + 1] && !args[longGapIdx + 1].startsWith('-')) {
    gap = parseInt(args[longGapIdx + 1], 10);
  }
  const label = 'MY_LONG_GAP_TOKEN';
  const val = 'syntheticlonggapsecret999';
  process.stdout.write(label);
  process.stdout.write(' '.repeat(gap));
  process.stdout.write('=' + val);
}

const incompQuotedIdx = args.indexOf('--emit-incomplete-quoted');
if (incompQuotedIdx !== -1) {
  let bodyLen = 5000;
  if (args[incompQuotedIdx + 1] && !args[incompQuotedIdx + 1].startsWith('-')) {
    bodyLen = parseInt(args[incompQuotedIdx + 1], 10);
  }
  const label = 'MY_QUOTED_SECRET';
  const val = 'syntheticquotedsecret999';
  process.stdout.write(label + '="');
  process.stdout.write('X'.repeat(bodyLen));
  process.stdout.write(val + '"');
}

const authLongGapIdx = args.indexOf('--emit-auth-long-gap');
if (authLongGapIdx !== -1) {
  let gap = 5000;
  if (args[authLongGapIdx + 1] && !args[authLongGapIdx + 1].startsWith('-')) {
    gap = parseInt(args[authLongGapIdx + 1], 10);
  }
  const val = 'syntheticauthlonggap999';
  process.stdout.write('Authorization' + ' '.repeat(gap) + ': Bearer ' + val);
}

const suppRecovIdx = args.indexOf('--emit-suppression-recovery');
if (suppRecovIdx !== -1) {
  let normalText = 'NORMAL_OBSERVABLE_OUTPUT_LINE_AFTER_RECOVERY';
  if (args[suppRecovIdx + 1] && !args[suppRecovIdx + 1].startsWith('-')) {
    normalText = args[suppRecovIdx + 1];
  }
  process.stdout.write('A'.repeat(5000) + ' SECRET_IN_OVERLONG=secretval123 ' + 'B'.repeat(1000) + '\n');
  process.stdout.write(normalText + '\n');
}

if (sleepMs <= 0) {
  process.exit(exitCode);
}

const timer = setTimeout(() => {
  process.exit(exitCode);
}, sleepMs);

process.on('SIGTERM', () => {
  clearTimeout(timer);
  process.exit(0);
});
process.on('SIGINT', () => {
  clearTimeout(timer);
  process.exit(0);
});
