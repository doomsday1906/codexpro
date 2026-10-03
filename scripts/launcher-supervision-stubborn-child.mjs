#!/usr/bin/env node
import fs from 'node:fs';

const [pidPath, termPath] = process.argv.slice(2);
if (!pidPath || !termPath) {
  throw new Error('expected PID and termination marker paths');
}

fs.writeFileSync(pidPath, String(process.pid));
process.on('SIGTERM', () => {
  fs.appendFileSync(termPath, `${Date.now()} SIGTERM\n`);
});
setInterval(() => {}, 1_000);
