#!/usr/bin/env node
// Disposable isolated closeout proof through the public MCP route.
// Proves ordinary isolated closeout physically removes its exact owned
// helpers and disposable worktree after durable preservation, while
// preserving unrelated/shared state, refusing ambiguous targets, and
// staying safe across repeats and partial failures.
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs, fake opencode binary (instant + export oracle).
// Real CodeGraph-shaped fixture helpers (node <tmp>/codegraph.js serve
// --mcp --path <disposable>) prove owned-helper stopping; unrelated
// helpers with different --path prove preservation.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const fileUrl = (p) => `file://${p}`;
function assert(ok, message) { if (!ok) throw new Error(`ASSERT: ${message}`); }

const envKeys = ['CODEX_HOME','CODEXPRO_OPENCODE_AGENTS_DIR','CODEXPRO_OPENCODE_BIN','CODEXPRO_DELEGATION_DIR','CODEXPRO_DELEGATION_LEGACY_BRIDGE','CLOSEOUT_RUN_MODE_FILE','CLOSEOUT_EXPORT_MODE','CLOSEOUT_COUNTER_FILE','CLOSEOUT_LOG_FILE'];
const oldEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const roots = [];
let client; let server; let workspaceId;
const ownedHelpers = new Set();
function restoreEnv() {
  for (const k of envKeys) {
    if (oldEnv[k] === undefined) delete process.env[k];
    else process.env[k] = oldEnv[k];
  }
}
function readStart(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch { return null; }
}
async function cleanup() {
  let failure;
  try {
    try { await client?.close(); } catch (e) { failure ??= e; }
    try { await server?.close(); } catch (e) { failure ??= e; }
    for (const child of [...ownedHelpers]) {
      try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
    }
    for (let i = 0; i < 40; i += 1) {
      const alive = [...ownedHelpers].some((c) => c.exitCode === null && c.signalCode === null);
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (e) { failure ??= e; }
  finally {
    restoreEnv();
    for (const dir of roots.splice(0)) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (e) { failure ??= e; }
    }
  }
  if (failure) throw failure;
}
async function makeRoot(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
async function spawnCodegraphHelper(codegraphJs, disposableDir, stubborn = false) {
  if (stubborn) {
    await fsp.writeFile(codegraphJs, `process.on('SIGTERM', () => {});\nsetInterval(() => {}, 60000);\n`);
  } else {
    await fsp.writeFile(codegraphJs, `setInterval(() => {}, 60000);\n`);
  }
  const child = spawn(process.execPath, [codegraphJs, 'serve', '--mcp', '--path', disposableDir], { cwd: disposableDir, stdio: 'ignore' });
  ownedHelpers.add(child);
  child.on('exit', () => {});
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pid = child.pid;
  assert(Number.isSafeInteger(pid) && pid > 0, 'helper must spawn');
  const start = readStart(pid);
  assert(start !== null, 'helper must have observable start');
  // Verify shape: cmdline must match collector expectations.
  const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  assert(cmd.includes('serve') && cmd.includes('--mcp'), `helper argv shape: ${cmd.join(' ')}`);
  return { child, pid, start };
}
async function waitGone(pid, start, label) {
  for (let i = 0; i < 60 && readStart(pid) === start; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert(readStart(pid) !== start, `${label} must exit`);
}

try {
  const codexHome = await makeRoot('codexpro-dc-codex-');
  const agentsDir = await makeRoot('codexpro-dc-agents-');
  const wsRoot = await makeRoot('codexpro-dc-ws-');
  const delegHome = await makeRoot('codexpro-dc-store-');
  const shimDir = await makeRoot('codexpro-dc-shim-');
  await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
  await fsp.writeFile(path.join(agentsDir, 'implementer.md'), '# implementer\n\nDisposable closeout proof fixture.\n');
  const modeFile = path.join(shimDir, 'run-mode');
  const counterFile = path.join(shimDir, 'run-counter');
  const logFile = path.join(shimDir, 'engine.log');
  const opencodeBin = path.join(shimDir, 'opencode');
  await fsp.writeFile(modeFile, 'instant\n');
  await fsp.writeFile(counterFile, '0\n');
  await fsp.writeFile(logFile, '');
  await fsp.writeFile(opencodeBin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'opencode v2.0.22'; exit 0; fi
if [ "$1" = "session" ] && [ "$2" = "export" ]; then
  sid="$3"
  case "$CLOSEOUT_EXPORT_MODE" in
    fail) echo 'fixture export denied' >&2; exit 7 ;;
    invalid) echo '{"info":{"id":"wrong-session"}}'; exit 0 ;;
  esac
  printf '{"info":{"id":"%s"},"messages":[{"text":"disposable proof history for %s"}]}\\n' "$sid" "$sid"
  exit 0
fi
if [ "$1" = "session" ] && [ "$2" = "list" ]; then
  echo '[]'
  exit 0
fi
if [ "$1" = "run" ]; then
  n=$(cat "$CLOSEOUT_COUNTER_FILE")
  n=$((n + 1))
  printf '%s\\n' "$n" > "$CLOSEOUT_COUNTER_FILE"
  sid=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--session" ] && [ "$#" -gt 1 ]; then sid="$2"; shift 2; else shift; fi
  done
  if [ -z "$sid" ]; then sid="ses_disposable_$n"; fi
  printf '{"sessionID":"%s","message":"fixture worker finished"}\\n' "$sid"
  exit 0
fi
exit 2
`);
  await fsp.chmod(opencodeBin, 0o755);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEXPRO_OPENCODE_AGENTS_DIR = agentsDir;
  process.env.CODEXPRO_OPENCODE_BIN = opencodeBin;
  process.env.CODEXPRO_DELEGATION_DIR = delegHome;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
  process.env.CLOSEOUT_RUN_MODE_FILE = modeFile;
  process.env.CLOSEOUT_COUNTER_FILE = counterFile;
  process.env.CLOSEOUT_LOG_FILE = logFile;
  delete process.env.CLOSEOUT_EXPORT_MODE;

  const { loadConfig } = await import(fileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer } = await import(fileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client } = await import(fileUrl(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
  const { InMemoryTransport } = await import(fileUrl(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js')));
  const config = loadConfig(['--root', wsRoot]);
  server = createCodexProServer(config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'disposable-closeout-proof', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const opened = await call('open_workspace', { root: wsRoot });
  assert(!opened.isError, `open: ${JSON.stringify(opened.structuredContent)}`);
  workspaceId = opened.structuredContent.workspace_id;
  const waitSettled = async (runId, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      const r = await call('delegation_read_result', { workspace_id: workspaceId, run_id: runId });
      assert(!r.isError, `read: ${JSON.stringify(r.structuredContent)}`);
      if (!['queued','running'].includes(r.structuredContent.state)) return r;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error(`ASSERT: run ${runId} did not settle`);
  };
  let reqN = 0;
  const launchDisposable = async (workdirRel) => {
    reqN += 1;
    const r = await call('delegation_launch', {
      workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
      workdir: workdirRel, task: 'Report readiness. Change nothing.', delegation_group: 'team-disposable-proof',
      request_id: `req-dc-${reqN}`, timeout_ms: 60000,
    });
    assert(!r.isError, `launch: ${JSON.stringify(r.structuredContent)}`);
    return r.structuredContent.run_id;
  };
  const runFileFor = (runId) => {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { const h = walk(p); if (h) return h; }
        else if (e.name === `${runId}.json`) return p;
      }
      return null;
    };
    return walk(delegHome);
  };

  // P1: isolated disposable closeout physically removes owned helpers + worktree.
  const dispRel1 = `disposable-p1-${Date.now()}`;
  const dispAbs1 = path.join(wsRoot, dispRel1);
  await fsp.mkdir(dispAbs1, { recursive: true });
  await fsp.writeFile(path.join(dispAbs1, 'task.txt'), 'disposable task content\n');
  const run1 = await launchDisposable(dispRel1);
  const read1 = await waitSettled(run1);
  assert(read1.structuredContent.state === 'completed', `run1 state ${read1.structuredContent.state}`);
  const runFile1 = runFileFor(run1);
  const rec1 = JSON.parse(await fsp.readFile(runFile1, 'utf8'));
  const ses1 = rec1.session?.sessionId;
  assert(typeof ses1 === 'string' && ses1.startsWith('ses_'), `session ${ses1}`);
  const cgJs1 = path.join(await makeRoot('codexpro-dc-cg1-'), 'codegraph.js');
  const owned1 = await spawnCodegraphHelper(cgJs1, dispAbs1, false);
  const otherDir = await makeRoot('codexpro-dc-other-');
  const cgJsOther = path.join(await makeRoot('codexpro-dc-cgother-'), 'codegraph.js');
  const unrelated = await spawnCodegraphHelper(cgJsOther, otherDir, false);
  const close1 = await call('delegation_closeout', { workspace_id: workspaceId, run_id: run1, retire: true });
  assert(!close1.isError, `close1: ${JSON.stringify(close1.structuredContent)}`);
  const sc1 = close1.structuredContent;
  assert(sc1.exported === true, `exported ${JSON.stringify(sc1)}`);
  assert(sc1.workdir_release === 'released', `released ${JSON.stringify(sc1)}`);
  assert(sc1.dir_clear === true && sc1.cleanup_finished === true, `clear ${JSON.stringify(sc1)}`);
  assert(Array.isArray(sc1.helpers_signalled) && sc1.helpers_signalled.includes(owned1.pid), `owned signalled ${JSON.stringify(sc1)}`);
  await waitGone(owned1.pid, owned1.start, 'owned helper');
  assert(!fs.existsSync(dispAbs1), 'disposable workdir must be absent');
  assert(readStart(unrelated.pid) === unrelated.start, 'unrelated helper must survive');
  // Durable preservation after physical removal.
  const bridgeOf = (runFile) => path.dirname(path.dirname(runFile));
  const artDir1 = path.join(bridgeOf(runFile1), 'delegation-artifacts', run1);
  assert(fs.existsSync(path.join(artDir1, 'session-export.json')), 'central export retained');
  assert(fs.existsSync(path.join(artDir1, 'retirement.json')), 'retirement intent retained');
  const page1 = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: run1, offset: 0, max_chars: 4000 });
  assert(!page1.isError && page1.structuredContent.text.includes(ses1), `readback ${JSON.stringify(page1.structuredContent)}`);
  const follow1 = await call('delegation_followup', { workspace_id: workspaceId, run_id: run1, checkpoint: { id: 'x', run_id: run1, seq: 1, payload: {}, input_request_id: 'missing' } });
  assert(follow1.isError && follow1.structuredContent.error === 'run_retired', 'retired followup refused');
  // Repeat is idempotent.
  const repeat1 = await call('delegation_closeout', { workspace_id: workspaceId, run_id: run1, retire: true });
  assert(!repeat1.isError && repeat1.structuredContent.exported === true, `repeat ${JSON.stringify(repeat1.structuredContent)}`);
  assert(repeat1.structuredContent.workdir_release === 'already_removed', `already_removed ${JSON.stringify(repeat1.structuredContent)}`);
  assert(readStart(unrelated.pid) === unrelated.start, 'unrelated still survives repeat');
  unrelated.child.kill('SIGKILL');
  console.log('P1 isolated disposable closeout: owned helper stopped, workdir removed, unrelated preserved, repeat idempotent, archive retained.');

  // P2: shared workdir protection (two runs share one dir stays blocked).
  const sharedRel = `shared-protect-${Date.now()}`;
  const sharedAbs = path.join(wsRoot, sharedRel);
  await fsp.mkdir(sharedAbs, { recursive: true });
  const runA = await launchDisposable(sharedRel);
  await waitSettled(runA);
  const runB = await launchDisposable(sharedRel);
  await waitSettled(runB);
  const closeA = await call('delegation_closeout', { workspace_id: workspaceId, run_id: runA, retire: true });
  assert(!closeA.isError && closeA.structuredContent.exported === true, `shared close exported ${JSON.stringify(closeA.structuredContent)}`);
  assert(closeA.structuredContent.workdir_release === 'blocked', `shared blocked ${JSON.stringify(closeA.structuredContent)}`);
  assert(fs.existsSync(sharedAbs), 'shared workdir retained');
  console.log('P2 shared workdir protection: first close archived but stayed blocked, directory retained.');

  // P3: ambiguous ownership (invalid run) refuses without artifacts.
  const missingClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: 'run_0000000000000000', retire: true });
  assert(missingClose.isError, 'missing run must refuse');
  console.log('P3 ambiguous ownership: invalid run refused without effects.');

  // P4: partial failure (stubborn helper survives SIGTERM stays blocked, retry releases).
  const dispRel4 = `disposable-p4-${Date.now()}`;
  const dispAbs4 = path.join(wsRoot, dispRel4);
  await fsp.mkdir(dispAbs4, { recursive: true });
  const run4 = await launchDisposable(dispRel4);
  await waitSettled(run4);
  const cgJs4 = path.join(await makeRoot('codexpro-dc-cg4-'), 'codegraph.js');
  const stubborn = await spawnCodegraphHelper(cgJs4, dispAbs4, true);
  const close4 = await call('delegation_closeout', { workspace_id: workspaceId, run_id: run4, retire: true });
  assert(!close4.isError && close4.structuredContent.exported === true, `stubborn exported ${JSON.stringify(close4.structuredContent)}`);
  assert(close4.structuredContent.workdir_release === 'blocked', `stubborn blocked ${JSON.stringify(close4.structuredContent)}`);
  assert(fs.existsSync(dispAbs4), 'stubborn workdir retained');
  assert(readStart(stubborn.pid) === stubborn.start, 'stubborn helper survives SIGTERM');
  // Retry after force removal succeeds.
  stubborn.child.kill('SIGKILL');
  await waitGone(stubborn.pid, stubborn.start, 'stubborn after SIGKILL');
  const retry4 = await call('delegation_closeout', { workspace_id: workspaceId, run_id: run4, retire: true });
  assert(!retry4.isError && retry4.structuredContent.workdir_release === 'released', `retry released ${JSON.stringify(retry4.structuredContent)}`);
  assert(!fs.existsSync(dispAbs4), 'retry removed workdir');
  console.log('P4 partial failure: stubborn helper blocked removal, retry after SIGKILL released.');

  console.log('PASS disposable isolated closeout proof: P1-P4 complete.');
  await cleanup();
} catch (e) {
  try { await cleanup(); } catch {}
  console.error(e?.stack ?? String(e));
  process.exit(1);
}
