#!/usr/bin/env node
// Disposable verification lifecycle fixture. Arguments are bounded numeric controls only.
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
function numberArg(name, fallback = 0, max = 60_000) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

const delayMs = numberArg("--delay-ms");
const runMs = numberArg("--run-ms");
const detachedChildMs = numberArg("--detached-child-ms");
const stdoutBytes = numberArg("--stdout-bytes", 0, 1_000_000);
const exitRaw = numberArg("--exit", 0, 255);
const exitCode = exitRaw;
const detachedIgnoreTerm = args.includes("--detached-ignore-term");
const detachedSeparate = args.includes("--detached-separate");
const pidFileIndex = args.indexOf("--detached-pid-file");
const detachedPidFile =
  pidFileIndex >= 0 && pidFileIndex + 1 < args.length ? String(args[pidFileIndex + 1]).slice(0, 512) : "";

if (stdoutBytes > 0) process.stdout.write("X".repeat(stdoutBytes));
if (detachedChildMs > 0 && process.platform !== "win32") {
  const ignoreSnippet = detachedIgnoreTerm ? `process.on('SIGTERM', () => {});` : ``;
  const childCode = `${ignoreSnippet}setTimeout(() => { try { process.stdout.write("detached-child-complete\\n"); } catch {} process.exit(0); }, ${detachedChildMs});`;
  const stdioMode = detachedSeparate ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"];
  const child = spawn(process.execPath, ["-e", childCode], {
    detached: true,
    stdio: stdioMode
  });
  if (detachedPidFile) {
    try {
      fs.writeFileSync(detachedPidFile, String(child.pid ?? ""), "utf8");
    } catch {}
  }
  try {
    child.unref();
  } catch {}
  process.stdout.write("detached-child-started\\n");
}
if (delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  process.stdout.write("delayed-output-marker\\n");
}
if (runMs > 0) await new Promise((resolve) => setTimeout(resolve, runMs));
process.exitCode = exitCode;
