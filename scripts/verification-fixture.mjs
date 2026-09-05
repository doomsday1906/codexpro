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
