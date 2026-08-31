import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const authToken = 'M004_WORKSPACE_DIAGNOSTIC_AUTH_4e6c9a1b';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-m004-workspace-diagnostic-'));
const nestedTarget = path.join(root, 'nested-target');
const configuredOnlyRoot = path.join(root, 'configured-only');
await fs.mkdir(nestedTarget, { recursive: true });
await fs.mkdir(configuredOnlyRoot, { recursive: true });
await fs.writeFile(path.join(root, 'default-marker.txt'), 'default workspace marker\n', 'utf8');
await fs.writeFile(path.join(nestedTarget, 'target-marker.txt'), 'target workspace marker\n', 'utf8');
await fs.writeFile(path.join(configuredOnlyRoot, 'configured-marker.txt'), 'configured workspace marker\n', 'utf8');

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

git(['init', '--quiet']);
git(['config', 'user.email', 'm004-workspace-diagnostic@example.invalid']);
git(['config', 'user.name', 'M004 Workspace Diagnostic']);
git(['add', '-A']);
git(['commit', '--quiet', '-m', 'workspace diagnostic fixture']);

process.env.CODEXPRO_ROOT = root;
process.env.CODEXPRO_ALLOWED_ROOTS = [root, configuredOnlyRoot].join(path.delimiter);
process.env.CODEXPRO_HOST = '127.0.0.1';
process.env.CODEXPRO_TOOL_MODE = 'full';
process.env.CODEXPRO_BASH_MODE = 'off';
process.env.CODEXPRO_WRITE_MODE = 'off';
process.env.CODEXPRO_TOOL_CARDS = '0';
process.env.CODEXPRO_HTTP_TOKEN = authToken;
process.env.CODEXPRO_ALLOW_NO_HTTP_TOKEN = '0';

const { loadConfig } = await import('../dist/config.js');
const { createCodexProHttpApp } = await import('../dist/http.js');

const config = {
  ...loadConfig(),
  defaultRoot: await fs.realpath(root),
  allowedRoots: [await fs.realpath(root), await fs.realpath(configuredOnlyRoot)],
  host: '127.0.0.1',
  authToken,
  requireHttpToken: true,
  toolMode: 'full',
  bashMode: 'off',
  writeMode: 'off'
};

function workspaceIdForRoot(realRoot) {
  return `ws_${createHash('sha256').update(realRoot).digest('hex').slice(0, 24)}`;
}

const realRoot = await fs.realpath(root);
const realNestedTarget = await fs.realpath(nestedTarget);
const realConfiguredOnlyRoot = await fs.realpath(configuredOnlyRoot);
const targetId = workspaceIdForRoot(realNestedTarget);
const defaultId = workspaceIdForRoot(realRoot);
const configuredOnlyId = workspaceIdForRoot(realConfiguredOnlyRoot);
const unknownId = 'ws_000000000000000000000000';
const invalidId = 'not-a-workspace-id';

function authHeaders() {
  return {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${authToken}`
  };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

async function listen(app) {
  const port = await getFreePort();
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  return { listener, url: `http://127.0.0.1:${port}/mcp` };
}

async function closeListener(listener) {
  if (!listener) return;
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

async function connectClient(url, name) {
  const client = new Client({ name, version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: authHeaders() }
  });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result)}`);
  assert(result.structuredContent && typeof result.structuredContent === 'object', `${name} omitted structured content`);
  return result.structuredContent;
}

function frozenSnapshot(snapshot, label) {
  assert.equal(Object.isFrozen(snapshot), true, `${label} snapshot must be frozen`);
  assert.equal(Object.isFrozen(snapshot.sessionOpened), true, `${label} sessionOpened must be frozen`);
  assert.equal(Object.isFrozen(snapshot.processKnown), true, `${label} processKnown must be frozen`);
  assert(Object.isFrozen(snapshot.configuredDefault), `${label} configuredDefault must be frozen`);
  if (snapshot.selected) assert(Object.isFrozen(snapshot.selected), `${label} selected must be frozen`);
  for (const descriptor of snapshot.sessionOpened) {
    assert(Object.isFrozen(descriptor), `${label} session descriptor must be frozen`);
  }
  if (snapshot.requestedWorkspace) {
    assert(Object.isFrozen(snapshot.requestedWorkspace), `${label} requested descriptor must be frozen`);
  }
  assert.deepEqual(Object.keys(snapshot.processKnown).sort(), ['stale', 'valid'], `${label} processKnown must expose counts only`);
  assert.throws(() => {
    snapshot.processKnown.valid += 1;
  }, TypeError, `${label} processKnown accepted mutation`);
  assert.throws(() => {
    snapshot.sessionOpened.push(snapshot.configuredDefault);
  }, TypeError, `${label} sessionOpened accepted mutation`);
}

function logicalSessionState(snapshot) {
  return {
    configuredDefault: snapshot.configuredDefault,
    selected: snapshot.selected,
    sessionOpened: snapshot.sessionOpened,
    processKnown: snapshot.processKnown
  };
}

async function filesystemAndGitState() {
  const entries = [];
  async function visit(absPath, relativePath) {
    const stat = await fs.lstat(absPath);
    const real = await fs.realpath(absPath).catch(() => null);
    const item = {
      path: relativePath,
      type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
      real,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs
    };
    if (stat.isFile()) {
      item.sha256 = createHash('sha256').update(await fs.readFile(absPath)).digest('hex');
    }
    entries.push(item);
    if (!stat.isDirectory()) return;
    const names = (await fs.readdir(absPath)).filter((name) => name !== '.git').sort();
    for (const name of names) await visit(path.join(absPath, name), path.join(relativePath, name));
  }
  await visit(root, '.');
  return {
    entries,
    gitStatus: git(['status', '--porcelain=v1', '--untracked-files=all']),
    head: git(['rev-parse', 'HEAD']).trim()
  };
}

function snapshotState(snapshot) {
  return JSON.parse(JSON.stringify(logicalSessionState(snapshot)));
}

async function diagnosticProbe(reader, workspaceId, label) {
  const before = reader.getSnapshot();
  frozenSnapshot(before, `${label} before`);
  const beforePhysical = await filesystemAndGitState();
  const requested = reader.getSnapshot(workspaceId);
  frozenSnapshot(requested, `${label} requested`);
  const after = reader.getSnapshot();
  frozenSnapshot(after, `${label} after`);
  const afterPhysical = await filesystemAndGitState();
  assert.deepEqual(snapshotState(after), snapshotState(before), `${label} changed session/process workspace state`);
  assert.deepEqual(afterPhysical, beforePhysical, `${label} changed filesystem or Git state`);
  return requested;
}

const readers = [];
const app = createCodexProHttpApp(config, {
  onWorkspaceDiagnosticReader: (reader) => readers.push(reader)
});
const { listener, url } = await listen(app);
let clientA;
let clientB;

try {
  clientA = await connectClient(url, 'm004-workspace-diagnostic-a');
  assert.equal(readers.length, 1, 'A initialize did not create one real workspace diagnostic reader');
  const readerA = readers[0];

  const openA = await callTool(clientA, 'open_workspace', { root: nestedTarget, include_tree: false });
  assert.equal(openA.workspace_id, targetId, 'A open_workspace returned an unexpected target id');
  assert.equal(openA.selected_workspace_id, targetId, 'A ordinary open_workspace output did not establish selection');
  const listA = await callTool(clientA, 'list_workspaces');
  assert.equal(listA.selected_workspace_id, targetId, 'A list_workspaces lost its selected target');
  assert.deepEqual(listA.workspaces.map((workspace) => workspace.id), [targetId], 'A list_workspaces did not expose only its opened target');
  const selectedA = await diagnosticProbe(readerA, targetId, 'A selected target');
  assert.equal(selectedA.requestedWorkspace.classification, 'selected_session_workspace');
  assert.equal(selectedA.requestedWorkspace.root, realNestedTarget);
  assert.equal(selectedA.selected.id, targetId);
  assert.deepEqual(selectedA.sessionOpened.map((workspace) => workspace.id), [targetId]);

  clientB = await connectClient(url, 'm004-workspace-diagnostic-b');
  assert.equal(readers.length, 2, 'B initialize did not create a second real workspace diagnostic reader');
  const readerB = readers[1];
  assert.notEqual(readerA, readerB, 'A/B sessions share a workspace diagnostic reader');

  // This is the only B observation before an ordinary tool call. It proves
  // the configured default is reportable without creating B selection/opened state.
  const initialB = readerB.getSnapshot();
  frozenSnapshot(initialB, 'B initial');
  assert(initialB.configuredDefault, 'B initial snapshot omitted configured default');
  assert.equal(initialB.configuredDefault.id, defaultId);
  assert.equal(initialB.configuredDefault.root, realRoot);
  assert.equal(initialB.selected, null, 'B initial snapshot selected a workspace');
  assert.deepEqual(initialB.sessionOpened, [], 'B initial snapshot opened a workspace');
  assert.equal(JSON.stringify(initialB).includes(targetId), false, 'B initial snapshot leaked A target id outside a requested probe');
  assert.equal(JSON.stringify(initialB.processKnown).includes(realNestedTarget), false, 'B processKnown emitted a root');

  const listBBeforeDiagnostic = await callTool(clientB, 'list_workspaces');
  assert.equal(listBBeforeDiagnostic.selected_workspace_id, defaultId, 'B ordinary list did not select configured default');
  assert.deepEqual(listBBeforeDiagnostic.workspaces.map((workspace) => workspace.id), [defaultId]);
  const processKnownTarget = await diagnosticProbe(readerB, targetId, 'B process-known target');
  assert.equal(processKnownTarget.requestedWorkspace.classification, 'process_known_reconstructible');
  assert.equal(processKnownTarget.requestedWorkspace.root, realNestedTarget);
  assert.equal(processKnownTarget.selected.id, defaultId, 'B process-known probe changed ambient selection');
  assert.deepEqual(processKnownTarget.sessionOpened.map((workspace) => workspace.id), [defaultId], 'B process-known probe opened A target');
  assert.equal(processKnownTarget.sessionOpened.some((workspace) => workspace.id === targetId), false);
  assert.equal(processKnownTarget.processKnown.valid, 2, 'B process-known aggregate did not count A target and B default');
  assert.equal(processKnownTarget.processKnown.stale, 0);
  assert.equal(JSON.stringify(processKnownTarget.processKnown).includes(targetId), false);
  assert.equal(JSON.stringify(processKnownTarget.processKnown).includes(realNestedTarget), false);
  const listBAfterDiagnostic = await callTool(clientB, 'list_workspaces');
  assert.deepEqual(listBAfterDiagnostic, listBBeforeDiagnostic, 'B ordinary list changed after process-known diagnostic probe');

  const readB = await callTool(clientB, 'read', { workspace_id: targetId, path: 'target-marker.txt' });
  assert.equal(readB.workspace_id, targetId, 'B explicit read did not target A workspace');
  assert.equal(readB.root, realNestedTarget);
  assert.match(readB.text, /target workspace marker/);
  const listBAfterRead = await callTool(clientB, 'list_workspaces');
  assert.equal(listBAfterRead.selected_workspace_id, defaultId, 'B explicit read changed ambient selection');
  assert.deepEqual(listBAfterRead.workspaces.map((workspace) => workspace.id).sort(), [defaultId, targetId].sort());
  const openedB = await diagnosticProbe(readerB, targetId, 'B session-opened target');
  assert.equal(openedB.requestedWorkspace.classification, 'session_opened');
  assert.equal(openedB.requestedWorkspace.root, realNestedTarget);
  assert.equal(openedB.selected.id, defaultId);
  assert.deepEqual(openedB.sessionOpened.map((workspace) => workspace.id).sort(), [defaultId, targetId].sort());

  const configuredProbe = await diagnosticProbe(readerB, configuredOnlyId, 'configured-only root');
  assert.equal(configuredProbe.requestedWorkspace.classification, 'configured_allowed_root_reconstructible');
  assert.equal(configuredProbe.requestedWorkspace.root, realConfiguredOnlyRoot);
  assert.equal(configuredProbe.sessionOpened.some((workspace) => workspace.id === configuredOnlyId), false);
  assert.equal(configuredProbe.processKnown.valid, 2, 'configured-only diagnostic probe registered a process root');

  await fs.rm(nestedTarget, { recursive: true, force: true });
  const staleTarget = await diagnosticProbe(readerB, targetId, 'deleted process-known target');
  assert.equal(staleTarget.requestedWorkspace.classification, 'stale_or_revoked');
  assert.equal(staleTarget.requestedWorkspace.root, null);
  assert.equal(staleTarget.selected.id, defaultId, 'stale probe changed B ambient selection');
  assert.deepEqual(staleTarget.sessionOpened.map((workspace) => workspace.id), [defaultId], 'stale probe retained invalid target as opened');
  assert.equal(staleTarget.processKnown.valid, 1);
  assert.equal(staleTarget.processKnown.stale, 1);

  await fs.rm(configuredOnlyRoot, { recursive: true, force: true });
  const staleConfigured = await diagnosticProbe(readerB, configuredOnlyId, 'deleted configured-only root');
  assert.equal(staleConfigured.requestedWorkspace.classification, 'stale_or_revoked');
  assert.equal(staleConfigured.requestedWorkspace.root, null);
  assert.equal(staleConfigured.selected.id, defaultId);
  assert.deepEqual(staleConfigured.sessionOpened.map((workspace) => workspace.id), [defaultId]);

  const unknown = await diagnosticProbe(readerB, unknownId, 'unknown id');
  assert.equal(unknown.requestedWorkspace.classification, 'unknown_or_invalid');
  assert.equal(unknown.requestedWorkspace.root, null);
  assert.equal(unknown.requestedWorkspace.id, unknownId);
  const invalid = await diagnosticProbe(readerB, invalidId, 'invalid id');
  assert.equal(invalid.requestedWorkspace.classification, 'unknown_or_invalid');
  assert.equal(invalid.requestedWorkspace.root, null);
  assert.equal(invalid.requestedWorkspace.id, invalidId);

  console.log(JSON.stringify({
    target: {
      producer: 'createCodexProHttpApp -> real StreamableHTTPClientTransport/ServerTransport -> createCodexProServer',
      actual_http_sessions: 2,
      same_process: true,
      target_id: targetId,
      target_root: realNestedTarget
    },
    acceptance: {
      AP_005: 'PASS',
      AP_006: 'PASS'
    },
    classifications: {
      selected_session_workspace: selectedA.requestedWorkspace.classification,
      process_known_reconstructible: processKnownTarget.requestedWorkspace.classification,
      session_opened: openedB.requestedWorkspace.classification,
      configured_allowed_root_reconstructible: configuredProbe.requestedWorkspace.classification,
      stale_or_revoked_deleted_process_root: staleTarget.requestedWorkspace.classification,
      stale_or_revoked_deleted_configured_root: staleConfigured.requestedWorkspace.classification,
      unknown_or_invalid_valid_id: unknown.requestedWorkspace.classification,
      unknown_or_invalid_bad_id: invalid.requestedWorkspace.classification
    },
    negative_proofs: {
      B_initial_selected_null: initialB.selected === null,
      B_process_known_probe_did_not_open_target: !processKnownTarget.sessionOpened.some((workspace) => workspace.id === targetId),
      B_ordinary_list_unchanged_by_process_known_probe: JSON.stringify(listBAfterDiagnostic) === JSON.stringify(listBBeforeDiagnostic),
      B_explicit_read_preserved_ambient_selection: listBAfterRead.selected_workspace_id === defaultId,
      stale_and_unknown_roots_null: [staleTarget, staleConfigured, unknown, invalid].every((snapshot) => snapshot.requestedWorkspace.root === null),
      process_known_output_counts_only: Object.keys(processKnownTarget.processKnown).sort().join(',') === 'stale,valid',
      snapshots_and_descriptors_frozen: true,
      diagnostic_filesystem_git_nonmutation: true
    }
  }, null, 2));
  console.log('✓ workspace diagnostic snapshot smoke test passed');
} finally {
  await clientB?.close().catch(() => {});
  await clientA?.close().catch(() => {});
  await closeListener(listener);
  await fs.rm(root, { recursive: true, force: true });
}
