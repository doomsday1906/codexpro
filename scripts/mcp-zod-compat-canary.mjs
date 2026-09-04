#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createCodexProServer } from "../dist/server.js";
import { loadConfig } from "../dist/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Verify exact baseline versions
const sdkPkg = JSON.parse(readFileSync(resolve(ROOT, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
const zodPkg = JSON.parse(readFileSync(resolve(ROOT, "node_modules/zod/package.json"), "utf8"));

assert.equal(sdkPkg.version, "1.30.0", `@modelcontextprotocol/sdk version must be 1.30.0; found ${sdkPkg.version}`);
assert.equal(zodPkg.version, "3.25.76", `zod version must be 3.25.76; found ${zodPkg.version}`);

async function runCanary({ falsify = false } = {}) {
  // --- Section 1: Public tool input schema / catalog generation ---
  const config = {
    ...loadConfig(),
    allowedDirs: [ROOT]
  };
  const server = createCodexProServer(config);
  const client = new Client({ name: "mcp-zod-canary-client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);

  const toolList = await client.listTools();
  assert.ok(toolList.tools.length >= 20, `Expected at least 20 tools registered; found ${toolList.tools.length}`);

  // Inspect schema structure of representative tools
  const treeTool = toolList.tools.find((t) => t.name === "tree");
  assert.ok(treeTool, "tree tool must be registered");
  assert.equal(treeTool.inputSchema.type, "object");
  assert.ok(treeTool.inputSchema.properties.max_depth, "tree must declare max_depth");
  assert.equal(treeTool.inputSchema.properties.max_depth.type, "integer");
  assert.equal(treeTool.inputSchema.properties.max_depth.minimum, 1);
  assert.equal(treeTool.inputSchema.properties.max_depth.maximum, 12);

  const readTool = toolList.tools.find((t) => t.name === "read");
  assert.ok(readTool, "read tool must be registered");
  assert.ok(readTool.inputSchema.required?.includes("path"), "read must require path");

  const serverConfigTool = toolList.tools.find((t) => t.name === "server_config");
  assert.ok(serverConfigTool, "server_config tool must be registered");

  // --- Section 2: Valid runtime call acceptance ---
  const configRes = await client.callTool({
    name: "server_config",
    arguments: {}
  });
  assert.equal(configRes.isError, undefined, "server_config must succeed");
  assert.ok(configRes.content?.[0]?.text?.includes("CodexPro Server Config"), "server_config output valid");

  const treeRes = await client.callTool({
    name: "tree",
    arguments: { max_depth: 1 }
  });
  assert.equal(treeRes.isError, undefined, "tree with valid max_depth must succeed");
  assert.ok(treeRes.content?.[0]?.text?.includes("docs"), "tree output contains docs");

  // --- Section 3: Representative invalid-shape rejection ---
  // A) Missing required field
  const missingPathRes = await client.callTool({
    name: "read",
    arguments: {}
  });
  assert.equal(missingPathRes.isError, true, "read missing required path must fail validation");
  assert.match(missingPathRes.content[0].text, /Required at path|Input validation error/);

  // B) Type mismatch
  const typeMismatchRes = await client.callTool({
    name: "tree",
    arguments: { max_depth: "not-a-number" }
  });
  assert.equal(typeMismatchRes.isError, true, "tree max_depth type mismatch must fail validation");
  assert.match(typeMismatchRes.content[0].text, /Expected number, received string at max_depth/);

  // C) Range constraint violation
  const rangeViolationRes = await client.callTool({
    name: "tree",
    arguments: { max_depth: 99 }
  });
  assert.equal(rangeViolationRes.isError, true, "tree max_depth out of range must fail validation");
  assert.match(rangeViolationRes.content[0].text, /Number must be less than or equal to 12 at max_depth/);

  // --- Section 4: Pure McpServer + Zod schema generator & validator verification ---
  const pureServer = new McpServer({ name: "pure-canary", version: "1.0.0" });
  pureServer.tool("canary_probe", "Probe tool for zod validation", {
    name: z.string().min(2),
    kind: z.enum(["alpha", "beta"]),
    // Controlled falsifier: in falsify mode, inject a real schema definition mismatch
    // (registering limit as string instead of integer) to prove that the canary's
    // schema inspection and validation assertions detect schema/runtime incompatibility.
    limit: falsify
      ? z.string()
      : z.number().int().min(1).max(50).default(10),
    tags: z.array(z.string()).optional()
  }, async (args) => {
    return { content: [{ type: "text", text: `ok:${args.name}:${args.kind}:${args.limit}` }] };
  });

  const pureClient = new Client({ name: "pure-client", version: "1.0.0" }, { capabilities: {} });
  const [pureClientTransport, pureServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    pureServer.connect(pureServerTransport),
    pureClient.connect(pureClientTransport)
  ]);

  const pureTools = await pureClient.listTools();
  const probeTool = pureTools.tools.find((t) => t.name === "canary_probe");
  assert.ok(probeTool, "pure canary_probe tool must be registered");
  assert.deepEqual(probeTool.inputSchema.properties.kind.enum, ["alpha", "beta"]);

  // Schema generation verification: detects schema generation incompatibility
  assert.equal(
    probeTool.inputSchema.properties.limit.type,
    "integer",
    `Schema generation incompatibility: expected limit type to be "integer", received "${probeTool.inputSchema.properties.limit.type}"`
  );
  assert.equal(probeTool.inputSchema.properties.limit.minimum, 1);
  assert.equal(probeTool.inputSchema.properties.limit.maximum, 50);
  assert.equal(probeTool.inputSchema.properties.limit.default, 10);

  // Valid pure call acceptance: detects runtime argument/schema validation incompatibility
  const validPure = await pureClient.callTool({
    name: "canary_probe",
    arguments: { name: "test", kind: "alpha", limit: 20 }
  });
  assert.equal(validPure.isError, undefined, "Valid runtime call must succeed without validation error");
  assert.equal(validPure.content[0].text, "ok:test:alpha:20");

  // Invalid pure call: enum mismatch
  const invalidEnum = await pureClient.callTool({
    name: "canary_probe",
    arguments: { name: "test", kind: "invalid-kind" }
  });
  assert.equal(invalidEnum.isError, true, "Invalid enum call must fail validation");
  assert.match(invalidEnum.content[0].text, /Invalid enum value|Input validation error/);
}

// Verify that canary assertions detect controlled schema/runtime incompatibility
async function verifyFalsifier() {
  let caught = null;
  try {
    await runCanary({ falsify: true });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "Controlled schema/runtime incompatibility was not detected by canary!");
  assert.equal(caught.name, "AssertionError", `Expected AssertionError but received ${caught.name}`);
  assert.match(
    caught.message,
    /Schema generation incompatibility|expected limit type/i,
    `AssertionError must reflect schema incompatibility detection; received: ${caught.message}`
  );
  return {
    detected: true,
    error_name: caught.name,
    error_message: caught.message
  };
}

const isDirect = Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  const isFalsifyMode = process.argv.includes("--falsify");
  if (isFalsifyMode) {
    console.log("Running in controlled falsifier mode (injecting schema/runtime incompatibility)...");
    // Directly invoke runCanary({ falsify: true }) WITHOUT catching, so process terminates with non-zero exit code and AssertionError
    await runCanary({ falsify: true });
  } else {
    await runCanary();
    const falsifierReport = await verifyFalsifier();
    console.log(JSON.stringify({
      mcp_sdk_version: sdkPkg.version,
      zod_version: zodPkg.version,
      schema_generation: "PASS",
      valid_runtime_call: "PASS",
      invalid_shape_rejection: "PASS",
      controlled_falsifier_detected: "PASS",
      falsifier_failure_mode: falsifierReport.error_message,
      gates: {
        "AP-007": "PASS",
        "AP-008": "PASS"
      }
    }, null, 2));
    console.log("✓ MCP SDK 1.30.0 / Zod 3.25.76 compatibility canary passed");
  }
}

export { runCanary, verifyFalsifier };
