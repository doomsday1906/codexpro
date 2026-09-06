#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { createCodexProServer } from "../dist/server.js";
import { PtyRunManager } from "../dist/ptyRunManager.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

console.log("# RepoConnect M010 TASK-006: Public MCP Contract & Schema Smoke");

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-pty-public-contract-"));
const realFixtureRoot = await fs.realpath(fixtureRoot);

await fs.writeFile(path.join(realFixtureRoot, "package.json"), JSON.stringify({ name: "contract-fixture" }, null, 2));
await fs.mkdir(path.join(realFixtureRoot, ".git"), { recursive: true });

async function createTestClient(extraArgv = [], serverOptions = {}) {
  const argv = [
    "--root", realFixtureRoot,
    "--host", "127.0.0.1",
    "--bash", "safe",
    "--write", "workspace",
    "--tool-mode", "full",
    ...extraArgv
  ];
  const config = loadConfig(argv);
  const server = createCodexProServer(config, serverOptions);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-smoke-client", version: "1.0.0" }, { capabilities: {} });

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport)
  ]);

  return { config, server, client, close: () => client.close() };
}

try {
  // Test 1: Full mode catalog and schema inspection
  console.log("Test 1: Full mode catalog contains exactly one PTY tool ('pty_run') with correct schema...");
  {
    const { client, close } = await createTestClient(["--tool-mode", "full"]);
    try {
      const listResult = await client.listTools();
      const toolNames = listResult.tools.map((t) => t.name);

      assert.ok(toolNames.includes("pty_run"), "pty_run must be registered in full mode");

      // Verify NO internal/other PTY tools are registered
      const forbiddenPtyNames = [
        "pty_start", "pty_wait", "pty_cancel", "pty_attach", "pty_resume", "pty_status",
        "pty_inspect", "pty_kill", "pty_spawn", "disposable_pty", "pty"
      ];
      for (const forbidden of forbiddenPtyNames) {
        assert.ok(!toolNames.includes(forbidden), `Forbidden tool '${forbidden}' must not be in tools/list`);
      }

      const ptyTool = listResult.tools.find((t) => t.name === "pty_run");
      assert.ok(ptyTool, "pty_run tool descriptor must exist");
      assert.equal(ptyTool.name, "pty_run");
      assert.ok(ptyTool.description?.includes("disposable pseudo-terminal"), "description must explain PTY runner");

      const schema = ptyTool.inputSchema;
      assert.equal(schema.type, "object");
      assert.ok(schema.properties.workspace_id, "schema must have workspace_id");
      assert.ok(schema.properties.argv, "schema must have argv");
      assert.ok(schema.properties.steps, "schema must have steps");
      assert.ok(schema.properties.cwd, "schema must have cwd");
      assert.ok(schema.properties.timeout_ms, "schema must have timeout_ms");
      assert.ok(schema.properties.session_id, "schema must have session_id");

      assert.ok(schema.required?.includes("workspace_id"), "workspace_id must be required");
      assert.ok(schema.required?.includes("argv"), "argv must be required");
      assert.ok(!schema.required?.includes("steps"), "steps must be optional");

      // Verify steps item schema
      assert.equal(schema.properties.steps.type, "array");
      const stepItemSchema = schema.properties.steps.items;
      assert.ok(stepItemSchema.properties.wait_for, "step item must have wait_for");
      assert.ok(stepItemSchema.properties.send, "step item must have send");
      assert.ok(stepItemSchema.properties.submit, "step item must have submit");
      assert.ok(stepItemSchema.properties.timeout_ms, "step item must have timeout_ms");
    } finally {
      await close();
    }
    console.log("  ✓ Full mode catalog & schema verified");
  }

  // Test 2: Standard mode catalog
  console.log("Test 2: Standard mode catalog contains 'pty_run'...");
  {
    const { client, close } = await createTestClient(["--tool-mode", "standard"]);
    try {
      const listResult = await client.listTools();
      const toolNames = listResult.tools.map((t) => t.name);
      assert.ok(toolNames.includes("pty_run"), "pty_run must be registered in standard mode");
    } finally {
      await close();
    }
    console.log("  ✓ Standard mode verified");
  }

  // Test 3: Minimal mode catalog excludes 'pty_run'
  console.log("Test 3: Minimal mode catalog excludes 'pty_run'...");
  {
    const { client, close } = await createTestClient(["--tool-mode", "minimal"]);
    try {
      const listResult = await client.listTools();
      const toolNames = listResult.tools.map((t) => t.name);
      assert.ok(!toolNames.includes("pty_run"), "pty_run must be excluded in minimal mode");
    } finally {
      await close();
    }
    console.log("  ✓ Minimal mode verified");
  }

  // Test 4: Bash mode off excludes 'pty_run'
  console.log("Test 4: Bash mode 'off' excludes 'pty_run' in both full and standard modes...");
  {
    const { client: fullClient, close: closeFull } = await createTestClient([
      "--tool-mode", "full",
      "--bash", "off"
    ]);
    try {
      const listResult = await fullClient.listTools();
      const toolNames = listResult.tools.map((t) => t.name);
      assert.ok(!toolNames.includes("pty_run"), "pty_run must be excluded when bashMode=off in full mode");
    } finally {
      await closeFull();
    }

    const { client: stdClient, close: closeStd } = await createTestClient([
      "--tool-mode", "standard",
      "--bash", "off"
    ]);
    try {
      const listResult = await stdClient.listTools();
      const toolNames = listResult.tools.map((t) => t.name);
      assert.ok(!toolNames.includes("pty_run"), "pty_run must be excluded when bashMode=off in standard mode");
    } finally {
      await closeStd();
    }
    console.log("  ✓ Bash mode off verified");
  }

  // Test 5: Connection test mode excludes 'pty_run'
  console.log("Test 5: Connection test mode excludes 'pty_run'...");
  {
    process.env.CODEXPRO_CONNECTION_TEST = "1";
    try {
      const { client, close } = await createTestClient(["--tool-mode", "full"]);
      try {
        const listResult = await client.listTools();
        const toolNames = listResult.tools.map((t) => t.name);
        assert.ok(!toolNames.includes("pty_run"), "pty_run must be hidden in connection test mode");
      } finally {
        await close();
      }
    } finally {
      delete process.env.CODEXPRO_CONNECTION_TEST;
    }
    console.log("  ✓ Connection test mode verified");
  }

  // Test 6: Supertool codexpro integration
  console.log("Test 6: Supertool codexpro list_actions and execution...");
  {
    const { client, close } = await createTestClient(["--tool-mode", "full", "--bash", "full"]);
    try {
      // 1. open workspace
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      assert.ok(!openResult.isError, "open_current_workspace must succeed");
      const wsId = openResult.structuredContent?.workspace_id;
      assert.ok(wsId, "workspace_id must be returned");

      // 2. list_actions from supertool
      const superList = await client.callTool({ name: "codexpro", arguments: { action: "list_actions" } });
      assert.ok(!superList.isError, "supertool list_actions must succeed");
      const actions = superList.structuredContent?.actions ?? [];
      assert.ok(actions.includes("pty_run"), "supertool actions must include 'pty_run'");

      // 3. invoke pty_run via supertool
      const superRun = await client.callTool({
        name: "codexpro",
        arguments: {
          action: "pty_run",
          args: {
            workspace_id: wsId,
            argv: ["node", "-e", "console.log('SUPERTOOL_PTY_OK')"]
          }
        }
      });
      assert.ok(!superRun.isError, "supertool invocation of pty_run must succeed");
      assert.equal(superRun.structuredContent?.state, "succeeded");
      assert.ok(superRun.structuredContent?.transcript?.includes("SUPERTOOL_PTY_OK"), "transcript must contain sentinel");
    } finally {
      await close();
    }
    console.log("  ✓ Supertool integration verified");
  }

  // Test 7: Unknown property rejection (strict schema validation via tool adapter)
  console.log("Test 7: Unknown property rejection returns clean tool error (not -32602 JSON-RPC crash)...");
  {
    const { client, close } = await createTestClient(["--tool-mode", "full", "--bash", "full"]);
    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      const wsId = openResult.structuredContent?.workspace_id;

      const hostileResult = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          argv: ["node", "-e", "console.log('should not run')"],
          unauthorized_hostile_envelope_field: "injected_value"
        }
      });
      assert.ok(hostileResult.isError, "Call with unknown properties must return an error result");
      const errorText = hostileResult.content?.find((c) => c.type === "text")?.text ?? "";
      assert.ok(
        errorText.includes("Unrecognized key(s) in object: 'unauthorized_hostile_envelope_field'") ||
        errorText.includes("unauthorized_hostile_envelope_field"),
        `Error text must specify unrecognized key: ${errorText}`
      );
    } finally {
      await close();
    }
    console.log("  ✓ Unknown property rejection verified");
  }

  // Test 8: Session guard enforcement
  console.log("Test 8: Session guard enforcement when requireBashSession=true...");
  {
    const sessionToken = "guard_session_secret_test_99";
    const { client, close } = await createTestClient([
      "--tool-mode", "full",
      "--bash", "full",
      "--require-bash-session",
      "--bash-session", sessionToken
    ]);
    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      const wsId = openResult.structuredContent?.workspace_id;

      // Call without session_id
      const missingSession = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          argv: ["node", "-e", "console.log('should fail missing session')"]
        }
      });
      assert.ok(missingSession.isError, "pty_run without session_id must fail when session guard is required");
      const missingText = missingSession.content?.find((c) => c.type === "text")?.text ?? "";
      assert.ok(missingText.toLowerCase().includes("session id is required") || missingText.includes("session_id"), `Error message must note session_id required: ${missingText}`);

      // Call with incorrect session_id
      const wrongSession = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          session_id: "wrong_session_token",
          argv: ["node", "-e", "console.log('should fail wrong session')"]
        }
      });
      assert.ok(wrongSession.isError, "pty_run with wrong session_id must fail");

      // Call with correct session_id
      const correctSession = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          session_id: sessionToken,
          argv: ["node", "-e", "console.log('SESSION_GUARD_OK')"]
        }
      });
      assert.ok(!correctSession.isError, "pty_run with valid session_id must succeed");
      assert.equal(correctSession.structuredContent?.state, "succeeded");
      assert.ok(correctSession.structuredContent?.transcript?.includes("SESSION_GUARD_OK"));
    } finally {
      await close();
    }
    console.log("  ✓ Session guard verified");
  }

  // Test 9: Ownership capability fail-closed behavior
  console.log("Test 9: Ownership capability fail-closed behavior via ptyRunManager injection...");
  {
    const customConfig = loadConfig([
      "--root", realFixtureRoot,
      "--host", "127.0.0.1",
      "--bash", "full",
      "--write", "workspace",
      "--tool-mode", "full"
    ]);
    const brokenManager = new PtyRunManager(customConfig, {
      ownershipCapabilityOverride: {
        supported: false,
        reason: "Kernel unshare CLONE_NEWUSER is blocked by admin security policy"
      }
    });
    const { client, close } = await createTestClient(
      ["--tool-mode", "full", "--bash", "full"],
      { ptyRunManager: brokenManager }
    );
    try {
      const openResult = await client.callTool({ name: "open_current_workspace", arguments: {} });
      const wsId = openResult.structuredContent?.workspace_id;

      const failClosedResult = await client.callTool({
        name: "pty_run",
        arguments: {
          workspace_id: wsId,
          argv: ["node", "-e", "console.log('should fail closed')"]
        }
      });
      assert.ok(failClosedResult.isError, "pty_run must fail closed when ownership capability is unsupported");
      const errText = failClosedResult.content?.find((c) => c.type === "text")?.text ?? "";
      assert.ok(
        errText.includes("ownership capability") || errText.includes("CLONE_NEWUSER") || errText.includes("blocked"),
        `Error text must explain capability failure: ${errText}`
      );
    } finally {
      await close();
    }
    console.log("  ✓ Ownership capability fail-closed verified");
  }

  console.log("\nALL PUBLIC CONTRACT SMOKE TESTS PASSED!");
} finally {
  await fs.rm(realFixtureRoot, { recursive: true, force: true }).catch(() => {});
}
