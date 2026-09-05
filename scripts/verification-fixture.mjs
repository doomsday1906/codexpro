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
