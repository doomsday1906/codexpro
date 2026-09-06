#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createCodexProServer } from "./server.js";
import { VerificationManager } from "./verificationOps.js";
import { PtyRunManager } from "./ptyRunManager.js";

const CODEXPRO_VERSION = "0.30.0";

function printHelp(): void {
  console.log(`CodexPro MCP stdio server

Usage:
  codexpro-mcp --root /path/to/repo [--allow-root /path]
  codexpro-mcp --version
  codexpro-mcp --help

Most users should run: codexpro start`);
}

export interface StdioShutdownOptions {
  verificationManager: VerificationManager;
  ptyRunManager: PtyRunManager;
  emergencyTimeoutMs?: number;
  exitFn?: (code: number) => void;
  logger?: { error: (msg: string) => void };
}

export function createStdioShutdownHandler(options: StdioShutdownOptions): (signal: string) => Promise<void> {
  let isClosing = false;
  const exit = options.exitFn ?? ((code: number) => process.exit(code));
  const logError = options.logger?.error ?? ((msg: string) => console.error(msg));
  const emergencyTimeoutMs = options.emergencyTimeoutMs ?? 5000;

  return async (signal: string): Promise<void> => {
    if (isClosing) return;
    isClosing = true;
    logError(`[CodexPro] Received ${signal}, closing managed verification jobs and cleaning active PTYs...`);

    const timer = setTimeout(() => {
      logError("[CodexPro] Emergency shutdown timeout expired before cleanup completed.");
      exit(1);
    }, emergencyTimeoutMs);
    timer.unref?.();

    let failed = false;
    const results = await Promise.allSettled([
      options.verificationManager.close(),
      options.ptyRunManager.close()
    ]);
    clearTimeout(timer);

    for (const res of results) {
      if (res.status === "rejected") {
        failed = true;
        const err = res.reason;
        logError(`[CodexPro] Error during stdio shutdown cleanup: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (failed) {
      exit(1);
    } else {
      exit(0);
    }
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN ??= "1";
  const config = loadConfig();
  const verificationManager = new VerificationManager(config);
  const ptyRunManager = new PtyRunManager(config);
  const cleanup = createStdioShutdownHandler({
    verificationManager,
    ptyRunManager
  });
  process.once("SIGINT", () => { void cleanup("SIGINT"); });
  process.once("SIGTERM", () => { void cleanup("SIGTERM"); });
  const server = createCodexProServer(config, { verificationManager, ptyRunManager });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
