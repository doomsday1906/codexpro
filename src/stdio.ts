#!/usr/bin/env node
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
  const cleanup = () => {
    Promise.all([
      verificationManager.close().catch(() => {}),
      ptyRunManager.close().catch(() => {})
    ]).finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  const server = createCodexProServer(config, { verificationManager, ptyRunManager });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
