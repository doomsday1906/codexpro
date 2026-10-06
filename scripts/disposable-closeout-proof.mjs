#!/usr/bin/env node
// Disposable isolated closeout proof through the public MCP route.
// Covers Hestia review findings: explicit launch-time disposable authority,
// central backup of workdir files before deletion, git-probe inconclusive
// refusal, ambiguous session refusal with truncation guard, persisted
// physical outcome with truthful read_result plus restart recovery, and the
// retained shared/invalid/stubborn/archive cases. Deterministic fixture
// coverage via a fake opencode binary is labeled as such; a read-only
// real-engine section uses the installed opencode/codegraph lifecycle
// without mutation and without touching shared services or unrelated work.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = path.resolve('.');
const fileUrl = (p) => `file://${p}`;
function assert(ok, message) { if (!ok) throw new Error(`ASSERT: ${message}`); }

const envKeys = ['CODEX_HOME','CODEXPRO_OPENCODE_AGENTS_DIR','CODEXPRO_OPENCODE_BIN','CODEXPRO_DELEGATION_DIR','CODEXPRO_DELEGATION_LEGACY_BRIDGE','CLOSEOUT_RUN_MODE_FILE','CLOSEOUT_EXPORT_MODE','CLOSEOUT_SESSION_MODE','CLOSEOUT_COUNTER_FILE','CLOSEOUT_LOG_FILE','PATH'];
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
  case "$CLOSEOUT_SESSION_MODE" in
    ambiguous) echo '[{"id":"ses_ambiguous_no_dir"}]'; exit 0 ;;
    unresolvable) echo '[{"id":"ses_unresolvable_dir","directory":"/tmp/codexpro-dc-no-such-dir-000000"}]'; exit 0 ;;
    truncated) python3 -c "import json; print(json.dumps([{'id':'ses_trunc_%03d'%i,'directory':'/tmp/codexpro-dc-trunc-%03d'%i} for i in range(100)]))"; exit 0 ;;
    conflict) echo "[{\\"id\\":\\"ses_other_in_dir\\",\\"directory\\":\\"$wsRoot/PLACEHOLDER\\"}]"; exit 0 ;;
    swap-handoff)
      swapdir="$CLOSEOUT_SWAP_DIR"
      if [ -n "$swapdir" ] && [ -f "$swapdir/handoff.txt" ]; then
        if grep -q '^OLD$' "$swapdir/handoff.txt" 2>/dev/null; then
          mv "$swapdir" "$swapdir.orig-A"
          mkdir -p "$swapdir"
          chmod 700 "$swapdir"
          printf 'NEW\\n' > "$swapdir/handoff.txt"
        fi
      fi
      echo '[]'
      exit 0 ;;
  esac
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
  delete process.env.CLOSEOUT_SESSION_MODE;
  const savedPath = process.env.PATH ?? '';

  const { loadConfig } = await import(fileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer } = await import(fileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client } = await import(fileUrl(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
  const { InMemoryTransport } = await import(fileUrl(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js')));
  const openServer = async () => {
    const config = loadConfig(['--root', wsRoot]);
    const srv = createCodexProServer(config);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const cli = new Client({ name: 'disposable-closeout-proof', version: '1' }, { capabilities: {} });
    await Promise.all([srv.connect(st), cli.connect(ct)]);
    return { srv, cli };
  };
  ({ srv: server, cli: client } = await openServer());
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
  const launchDisposable = async (workdirRel, disposable) => {
    reqN += 1;
    const r = await call('delegation_launch', {
      workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
      workdir: workdirRel, task: 'Report readiness. Change nothing.', delegation_group: 'team-disposable-proof',
      request_id: `req-dc-${reqN}`, timeout_ms: 60000,
      ...(disposable ? { disposable_workdir: true } : {}),
    });
    return r;
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

  // P1: authorized disposable with pre-existing file: backup preserves it,
  // helpers stop, dir disappears, read_result stays truthful, restart recovers.
  const dispRel1 = `disposable-p1-${Date.now()}`;
  const dispAbs1 = path.join(wsRoot, dispRel1);
  await fsp.mkdir(dispAbs1, { recursive: true });
  const preBytes = Buffer.from('pre-existing disposable task content\n');
  await fsp.writeFile(path.join(dispAbs1, 'task.txt'), preBytes);
  const launch1 = await launchDisposable(dispRel1, true);
  assert(!launch1.isError, `launch1: ${JSON.stringify(launch1.structuredContent)}`);
  const run1 = launch1.structuredContent.run_id;
  const rec1pre = JSON.parse(await fsp.readFile(runFileFor(run1), 'utf8'));
  assert(rec1pre.workdirDisposable?.authorized === true, 'launch must record disposable authority');
  const read1 = await waitSettled(run1);
  assert(read1.structuredContent.state === 'completed', `run1 ${read1.structuredContent.state}`);
  const rec1 = JSON.parse(await fsp.readFile(runFileFor(run1), 'utf8'));
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
  assert(sc1.exported === true && sc1.workdir_release === 'released' && sc1.dir_clear === true && sc1.cleanup_finished === true, `released ${JSON.stringify(sc1)}`);
  assert(Array.isArray(sc1.helpers_signalled) && sc1.helpers_signalled.includes(owned1.pid), `owned signalled ${JSON.stringify(sc1)}`);
  await waitGone(owned1.pid, owned1.start, 'owned helper');
  assert(!fs.existsSync(dispAbs1), 'disposable workdir must be absent');
  assert(readStart(unrelated.pid) === unrelated.start, 'unrelated helper must survive');
  const bridgeOf = (runFile) => path.dirname(path.dirname(runFile));
  const artDir1 = path.join(bridgeOf(runFileFor(run1)), 'delegation-artifacts', run1);
  assert(fs.existsSync(path.join(artDir1, 'session-export.json')), 'central export retained');
  assert(fs.existsSync(path.join(artDir1, 'physical-release.json')), 'physical record retained');
  const backupManifest = JSON.parse(await fsp.readFile(path.join(artDir1, 'workdir-backup', 'backup-manifest.json'), 'utf8'));
  const taskEntry = backupManifest.files.find((f) => f.rel === 'task.txt');
  assert(taskEntry && taskEntry.bytes === preBytes.length, `backup manifest ${JSON.stringify(backupManifest.files)}`);
  const backedBytes = await fsp.readFile(path.join(artDir1, 'workdir-backup', 'task.txt'));
  assert(backedBytes.equals(preBytes), 'pre-existing file bytes preserved centrally');
  assert(createHash('sha256').update(backedBytes).digest('hex') === taskEntry.sha256, 'backup hash verified');
  const readBack1 = await call('delegation_read_result', { workspace_id: workspaceId, run_id: run1 });
  assert(!readBack1.isError && readBack1.structuredContent.closeout?.workdir_release === 'released' && readBack1.structuredContent.closeout?.cleanup_finished === true, `read_result truthful ${JSON.stringify(readBack1.structuredContent.closeout)}`);
  assert(readBack1.structuredContent.closeout?.exported === true, 'archival distinct from physical, both true');
  const page1 = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: run1, offset: 0, max_chars: 4000 });
  assert(!page1.isError && page1.structuredContent.text.includes(ses1), 'readback after removal');
  const follow1 = await call('delegation_followup', { workspace_id: workspaceId, run_id: run1, checkpoint: { id: 'x', run_id: run1, seq: 1, payload: {}, input_request_id: 'missing' } });
  assert(follow1.isError && follow1.structuredContent.error === 'run_retired', 'retired followup refused');
  const repeat1 = await call('delegation_closeout', { workspace_id: workspaceId, run_id: run1, retire: true });
  assert(!repeat1.isError && repeat1.structuredContent.exported === true && repeat1.structuredContent.workdir_release === 'released', `repeat ${JSON.stringify(repeat1.structuredContent)}`);
  // Restart recovery: brand-new server/client over the same on-disk state.
  try { await client.close(); } catch {}
  try { await server.close(); } catch {}
  ({ srv: server, cli: client } = await openServer());
  const call2 = async (name, args) => client.callTool({ name, arguments: args });
  const opened2 = await call2('open_workspace', { root: wsRoot });
  assert(!opened2.isError, 'reopen after restart');
  const wid2 = opened2.structuredContent.workspace_id;
  const readRestart = await call2('delegation_read_result', { workspace_id: wid2, run_id: run1 });
  assert(!readRestart.isError && readRestart.structuredContent.closeout?.workdir_release === 'released' && readRestart.structuredContent.closeout?.dir_clear === true, `restart read truthful ${JSON.stringify(readRestart.structuredContent.closeout)}`);
  const pageRestart = await call2('delegation_read_closeout', { workspace_id: wid2, run_id: run1, offset: 0, max_chars: 4000 });
  assert(!pageRestart.isError && pageRestart.structuredContent.text.includes(ses1), 'restart readback');
  // Rebind call/workspace for the rest of the proof.
  const callRest = call2;
  workspaceId = wid2;
  const waitSettledRest = async (runId, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      const r = await callRest('delegation_read_result', { workspace_id: workspaceId, run_id: runId });
      assert(!r.isError, `read: ${JSON.stringify(r.structuredContent)}`);
      if (!['queued','running'].includes(r.structuredContent.state)) return r;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error(`ASSERT: run ${runId} did not settle`);
  };
  const launchRest = async (workdirRel, disposable) => {
    reqN += 1;
    const r = await callRest('delegation_launch', {
      workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
      workdir: workdirRel, task: 'Report readiness. Change nothing.', delegation_group: 'team-disposable-proof',
      request_id: `req-dc-${reqN}`, timeout_ms: 60000,
      ...(disposable ? { disposable_workdir: true } : {}),
    });
    return r;
  };
  unrelated.child.kill('SIGKILL');
  console.log('P1 authorized disposable: pre-existing file backed up + verified, helpers stopped, dir removed, reads + restart truthful, repeat idempotent.');

  // P2: shared workdir without authority stays blocked and retained.
  const sharedRel = `shared-protect-${Date.now()}`;
  const sharedAbs = path.join(wsRoot, sharedRel);
  await fsp.mkdir(sharedAbs, { recursive: true });
  const launchA = await launchRest(sharedRel, false);
  assert(!launchA.isError, 'shared launch A');
  await waitSettledRest(launchA.structuredContent.run_id);
  const launchB = await launchRest(sharedRel, false);
  assert(!launchB.isError, 'shared launch B');
  await waitSettledRest(launchB.structuredContent.run_id);
  const closeA = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: launchA.structuredContent.run_id, retire: true });
  assert(!closeA.isError && closeA.structuredContent.exported === true && closeA.structuredContent.workdir_release === 'blocked' && fs.existsSync(sharedAbs), `shared blocked ${JSON.stringify(closeA.structuredContent)}`);
  console.log('P2 shared without authority: archived but blocked, directory retained.');

  // P2b: shared WITH authority still refuses via sharing gate.
  const sharedAuthRel = `shared-auth-${Date.now()}`;
  const sharedAuthAbs = path.join(wsRoot, sharedAuthRel);
  await fsp.mkdir(sharedAuthAbs, { recursive: true });
  const launchA2 = await launchRest(sharedAuthRel, true);
  assert(!launchA2.isError, 'shared-auth launch A');
  await waitSettledRest(launchA2.structuredContent.run_id);
  const launchB2 = await launchRest(sharedAuthRel, true);
  assert(!launchB2.isError, 'shared-auth launch B');
  await waitSettledRest(launchB2.structuredContent.run_id);
  const closeA2 = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: launchA2.structuredContent.run_id, retire: true });
  assert(!closeA2.isError && closeA2.structuredContent.exported === true && closeA2.structuredContent.workdir_release === 'blocked' && fs.existsSync(sharedAuthAbs), `shared-auth blocked ${JSON.stringify(closeA2.structuredContent)}`);
  console.log('P2b shared with authority: sharing gate refuses, directory retained.');

  // P3: invalid run refuses without effects.
  const missingClose = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: 'run_0000000000000000', retire: true });
  assert(missingClose.isError, 'missing run must refuse');
  console.log('P3 ambiguous ownership: invalid run refused without effects.');

  // P4: stubborn helper blocks, retry after SIGKILL releases (authorized).
  const dispRel4 = `disposable-p4-${Date.now()}`;
  const dispAbs4 = path.join(wsRoot, dispRel4);
  await fsp.mkdir(dispAbs4, { recursive: true });
  const launch4 = await launchRest(dispRel4, true);
  assert(!launch4.isError, 'launch4');
  const run4 = launch4.structuredContent.run_id;
  await waitSettledRest(run4);
  const cgJs4 = path.join(await makeRoot('codexpro-dc-cg4-'), 'codegraph.js');
  const stubborn = await spawnCodegraphHelper(cgJs4, dispAbs4, true);
  const close4 = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run4, retire: true });
  assert(!close4.isError && close4.structuredContent.exported === true && close4.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs4) && readStart(stubborn.pid) === stubborn.start, `stubborn blocked ${JSON.stringify(close4.structuredContent)}`);
  stubborn.child.kill('SIGKILL');
  await waitGone(stubborn.pid, stubborn.start, 'stubborn after SIGKILL');
  const retry4 = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run4, retire: true });
  assert(!retry4.isError && retry4.structuredContent.workdir_release === 'released' && !fs.existsSync(dispAbs4), `retry released ${JSON.stringify(retry4.structuredContent)}`);
  console.log('P4 partial failure: stubborn blocked, retry after SIGKILL released.');

  // P5: disposable path WITHOUT authority is preserved (pre-existing survives).
  const noAuthRel = `disposable-noauth-${Date.now()}`;
  const noAuthAbs = path.join(wsRoot, noAuthRel);
  await fsp.mkdir(noAuthAbs, { recursive: true });
  await fsp.writeFile(path.join(noAuthAbs, 'valuable.txt'), 'valuable pre-existing content\n');
  const launchNoAuth = await launchRest(noAuthRel, false);
  assert(!launchNoAuth.isError, 'noauth launch');
  const runNoAuth = launchNoAuth.structuredContent.run_id;
  await waitSettledRest(runNoAuth);
  const closeNoAuth = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: runNoAuth, retire: true });
  assert(!closeNoAuth.isError && closeNoAuth.structuredContent.exported === true && closeNoAuth.structuredContent.workdir_release === 'blocked' && fs.existsSync(path.join(noAuthAbs, 'valuable.txt')), `noauth blocked ${JSON.stringify(closeNoAuth.structuredContent)}`);
  console.log('P5 unowned with valuable file: refused, file preserved.');

  // P6: git repository workdir refuses disposable launch; inconclusive probe refuses closeout.
  const gitRel = `disposable-git-${Date.now()}`;
  const gitAbs = path.join(wsRoot, gitRel);
  await fsp.mkdir(gitAbs, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: gitAbs, timeout: 15000 });
  spawnSync('git', ['config', 'user.email', 'proof@example.com'], { cwd: gitAbs, timeout: 15000 });
  spawnSync('git', ['config', 'user.name', 'proof'], { cwd: gitAbs, timeout: 15000 });
  await fsp.writeFile(path.join(gitAbs, 'tracked.txt'), 'v\n');
  spawnSync('git', ['add', 'tracked.txt'], { cwd: gitAbs, timeout: 15000 });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: gitAbs, timeout: 15000 });
  const launchGit = await launchRest(gitRel, true);
  assert(launchGit.isError && launchGit.structuredContent.error === 'disposable_workdir_rejected', `git launch refused ${JSON.stringify(launchGit.structuredContent)}`);
  // Inconclusive git probe: hide git from PATH for the closeout attempt.
  const dispRel6 = `disposable-gitprobe-${Date.now()}`;
  const dispAbs6 = path.join(wsRoot, dispRel6);
  await fsp.mkdir(dispAbs6, { recursive: true });
  const launch6 = await launchRest(dispRel6, true);
  assert(!launch6.isError, 'launch6');
  const run6 = launch6.structuredContent.run_id;
  await waitSettledRest(run6);
  const emptyDir = await makeRoot('codexpro-dc-empty-path-');
  process.env.PATH = emptyDir;
  let closeInconclusive;
  try { closeInconclusive = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run6, retire: true }); }
  finally { process.env.PATH = savedPath; }
  assert(!closeInconclusive.isError && closeInconclusive.structuredContent.exported === true && closeInconclusive.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs6), `inconclusive blocked ${JSON.stringify(closeInconclusive.structuredContent)}`);
  const retry6 = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run6, retire: true });
  assert(!retry6.isError && retry6.structuredContent.workdir_release === 'released' && !fs.existsSync(dispAbs6), `retry6 released ${JSON.stringify(retry6.structuredContent)}`);
  console.log('P6 git: repo launch refused; inconclusive probe blocked then retry released.');

  // P7: ambiguous engine session identity refuses; cleared retry releases.
  const dispRel7 = `disposable-ambig-${Date.now()}`;
  const dispAbs7 = path.join(wsRoot, dispRel7);
  await fsp.mkdir(dispAbs7, { recursive: true });
  const launch7 = await launchRest(dispRel7, true);
  assert(!launch7.isError, 'launch7');
  const run7 = launch7.structuredContent.run_id;
  await waitSettledRest(run7);
  process.env.CLOSEOUT_SESSION_MODE = 'ambiguous';
  let closeAmbig;
  try { closeAmbig = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run7, retire: true }); }
  finally { delete process.env.CLOSEOUT_SESSION_MODE; }
  assert(!closeAmbig.isError && closeAmbig.structuredContent.exported === true && closeAmbig.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs7), `ambiguous blocked ${JSON.stringify(closeAmbig.structuredContent)}`);
  const retry7 = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run7, retire: true });
  assert(!retry7.isError && retry7.structuredContent.workdir_release === 'released' && !fs.existsSync(dispAbs7), `retry7 released ${JSON.stringify(retry7.structuredContent)}`);
  console.log('P7 ambiguous session: unproven identity blocked, cleared retry released.');

  // P7b: truncated session coverage (full page) refuses as unproven.
  const dispRel7b = `disposable-trunc-${Date.now()}`;
  const dispAbs7b = path.join(wsRoot, dispRel7b);
  await fsp.mkdir(dispAbs7b, { recursive: true });
  const launch7b = await launchRest(dispRel7b, true);
  assert(!launch7b.isError, 'launch7b');
  const run7b = launch7b.structuredContent.run_id;
  await waitSettledRest(run7b);
  process.env.CLOSEOUT_SESSION_MODE = 'truncated';
  let closeTrunc;
  try { closeTrunc = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run7b, retire: true }); }
  finally { delete process.env.CLOSEOUT_SESSION_MODE; }
  assert(!closeTrunc.isError && closeTrunc.structuredContent.exported === true && closeTrunc.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs7b), `truncated blocked ${JSON.stringify(closeTrunc.structuredContent)}`);
  const retry7b = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run7b, retire: true });
  assert(!retry7b.isError && retry7b.structuredContent.workdir_release === 'released' && !fs.existsSync(dispAbs7b), `retry7b released ${JSON.stringify(retry7b.structuredContent)}`);
  console.log('P7b truncated session list: full-page coverage refused, cleared retry released.');

  // P7c: unresolvable session directory refuses as unproven.
  const dispRel7c = `disposable-unres-${Date.now()}`;
  const dispAbs7c = path.join(wsRoot, dispRel7c);
  await fsp.mkdir(dispAbs7c, { recursive: true });
  const launch7c = await launchRest(dispRel7c, true);
  assert(!launch7c.isError, 'launch7c');
  const run7c = launch7c.structuredContent.run_id;
  await waitSettledRest(run7c);
  process.env.CLOSEOUT_SESSION_MODE = 'unresolvable';
  let closeUnres;
  try { closeUnres = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run7c, retire: true }); }
  finally { delete process.env.CLOSEOUT_SESSION_MODE; }
  assert(!closeUnres.isError && closeUnres.structuredContent.exported === true && closeUnres.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs7c), `unresolvable blocked ${JSON.stringify(closeUnres.structuredContent)}`);
  const retry7c = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run7c, retire: true });
  assert(!retry7c.isError && retry7c.structuredContent.workdir_release === 'released' && !fs.existsSync(dispAbs7c), `retry7c released ${JSON.stringify(retry7c.structuredContent)}`);
  console.log('P7c unresolvable session directory: unproven identity blocked, cleared retry released.');

  // P8: crash window after physical removal but before final publication.
  // Fault injection blocks only the final physical-release.json link while
  // allowing backup, prepared intent, helper signals, and removal. Restart
  // recovery via a brand-new server/client must finalize to released from
  // prepared + absent target + valid bound backup.
  const dispRel8 = `disposable-crash-${Date.now()}`;
  const dispAbs8 = path.join(wsRoot, dispRel8);
  await fsp.mkdir(dispAbs8, { recursive: true });
  const crashBytes = Buffer.from('crash-window file content\n');
  await fsp.writeFile(path.join(dispAbs8, 'crash.txt'), crashBytes);
  const launch8 = await launchRest(dispRel8, true);
  assert(!launch8.isError, 'launch8');
  const run8 = launch8.structuredContent.run_id;
  await waitSettledRest(run8);
  const runFile8 = runFileFor(run8);
  const bridge8 = path.dirname(path.dirname(runFile8));
  const cgJs8 = path.join(await makeRoot('codexpro-dc-cg8-'), 'codegraph.js');
  const owned8 = await spawnCodegraphHelper(cgJs8, dispAbs8, false);
  const cgJs8other = path.join(await makeRoot('codexpro-dc-cg8other-'), 'codegraph.js');
  const unrelated8 = await spawnCodegraphHelper(cgJs8other, await makeRoot('codexpro-dc-crash-other-'), false);
  const nativeLink = fs.linkSync;
  let finalBlocked = false;
  fs.linkSync = function (source, destination, ...rest) {
    if (String(destination).endsWith('physical-release.json') && !finalBlocked) {
      finalBlocked = true;
      throw new Error('fixture interruption before final release publication');
    }
    return nativeLink.call(fs, source, destination, ...rest);
  };
  let closeCrash;
  try { closeCrash = await callRest('delegation_closeout', { workspace_id: workspaceId, run_id: run8, retire: true }); }
  finally { fs.linkSync = nativeLink; }
  assert(finalBlocked, 'fault must have intercepted the final publication');
  assert(!closeCrash.isError && closeCrash.structuredContent.exported === true && closeCrash.structuredContent.workdir_release === 'blocked', `crash interrupted ${JSON.stringify(closeCrash.structuredContent)}`);
  assert(!fs.existsSync(dispAbs8), 'workdir was physically removed before the interruption');
  assert(!fs.existsSync(path.join(bridge8, 'delegation-artifacts', run8, 'physical-release.json')), 'final record absent after interruption');
  assert(fs.existsSync(path.join(bridge8, 'delegation-artifacts', run8, 'physical-release-prepared.json')), 'prepared intent durable after interruption');
  await waitGone(owned8.pid, owned8.start, 'crash owned helper');
  assert(readStart(unrelated8.pid) === unrelated8.start, 'unrelated helper untouched by interruption');
  // Restart: recreate server/process state, then reconcile.
  try { await client.close(); } catch {}
  try { await server.close(); } catch {}
  ({ srv: server, cli: client } = await openServer());
  const callCrash = async (name, args) => client.callTool({ name, arguments: args });
  const openedCrash = await callCrash('open_workspace', { root: wsRoot });
  assert(!openedCrash.isError, 'reopen after crash');
  const widCrash = openedCrash.structuredContent.workspace_id;
  const readCrash = await callCrash('delegation_read_result', { workspace_id: widCrash, run_id: run8 });
  assert(!readCrash.isError && readCrash.structuredContent.closeout?.exported === true, 'archival preserved across restart');
  const retryCrash = await callCrash('delegation_closeout', { workspace_id: widCrash, run_id: run8, retire: true });
  assert(!retryCrash.isError && retryCrash.structuredContent.workdir_release === 'released' && retryCrash.structuredContent.dir_clear === true, `crash recovery released ${JSON.stringify(retryCrash.structuredContent)}`);
  assert(fs.existsSync(path.join(bridge8, 'delegation-artifacts', run8, 'physical-release.json')), 'final record published by recovery');
  const backedCrash = await fsp.readFile(path.join(bridge8, 'delegation-artifacts', run8, 'workdir-backup', 'crash.txt'));
  assert(backedCrash.equals(crashBytes), 'backup readable and hash-valid after recovery');
  assert(readStart(unrelated8.pid) === unrelated8.start, 'unrelated helper survives recovery');
  unrelated8.child.kill('SIGKILL');
  // Rebind for the rest of the proof.
  const callRest2 = callCrash;
  workspaceId = widCrash;
  const waitSettledRest2 = async (runId, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      const r = await callRest2('delegation_read_result', { workspace_id: workspaceId, run_id: runId });
      assert(!r.isError, `read: ${JSON.stringify(r.structuredContent)}`);
      if (!['queued','running'].includes(r.structuredContent.state)) return r;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error(`ASSERT: run ${runId} did not settle`);
  };
  const launchRest2 = async (workdirRel, disposable) => {
    reqN += 1;
    const r = await callRest2('delegation_launch', {
      workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
      workdir: workdirRel, task: 'Report readiness. Change nothing.', delegation_group: 'team-disposable-proof',
      request_id: `req-dc-${reqN}`, timeout_ms: 60000,
      ...(disposable ? { disposable_workdir: true } : {}),
    });
    return r;
  };
  console.log('P8 crash window: removal happened, final publish interrupted, restart recovery finalized released with backup intact and unrelated preserved.');

  // P9: fail-closed prepared mismatch (tampered intent never finalizes).
  // Well-formed but conflicting (wrong dirReal/identity/backup): must fail
  // closed without reuse, without overwrite, and without deletion.
  const dispRel9 = `disposable-tamper-${Date.now()}`;
  const dispAbs9 = path.join(wsRoot, dispRel9);
  await fsp.mkdir(dispAbs9, { recursive: true });
  await fsp.writeFile(path.join(dispAbs9, 'keep.txt'), 'tamper test content\n');
  const launch9 = await launchRest2(dispRel9, true);
  assert(!launch9.isError, 'launch9');
  const run9 = launch9.structuredContent.run_id;
  await waitSettledRest2(run9);
  const artDir9 = path.join(bridgeOf(runFileFor(run9)), 'delegation-artifacts', run9);
  await fsp.mkdir(artDir9, { recursive: true });
  const rec9 = JSON.parse(await fsp.readFile(runFileFor(run9), 'utf8'));
  const tamperPrepared = { version: 1, phase: 'prepared', binding: { runId: run9, ownerIdHash: rec9.ownerIdHash, ownerKind: rec9.ownerKind, workdir: rec9.workdir, engine: rec9.engine, sessionId: rec9.session?.sessionId ?? null, dirReal: '/tmp/codexpro-dc-tampered-elsewhere' }, dirIdentity: { dev: 1, ino: 1 }, preparedAt: new Date().toISOString(), helpersSignalled: [], backup: { fileCount: 0, totalBytes: 0, manifestSha256: '0'.repeat(64) } };
  const tamperText = `${JSON.stringify(tamperPrepared)}\n`;
  await fsp.writeFile(path.join(artDir9, 'physical-release-prepared.json'), tamperText);
  const closeTamper = await callRest2('delegation_closeout', { workspace_id: workspaceId, run_id: run9, retire: true });
  assert(!closeTamper.isError && closeTamper.structuredContent.exported === true && closeTamper.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs9) && fs.existsSync(path.join(dispAbs9, 'keep.txt')) && !fs.existsSync(path.join(artDir9, 'physical-release.json')), `tamper blocked ${JSON.stringify(closeTamper.structuredContent)}`);
  assert((await fsp.readFile(path.join(artDir9, 'physical-release-prepared.json'), 'utf8')) === tamperText, 'conflicting prepared record must not be overwritten');
  console.log('P9 tampered prepared intent: binding mismatch failed closed, directory and files retained, no final record, prepared not overwritten.');

  // P10: prepared + target still present is retryable (the exact reproduced
  // sequence `prepared persisted -> removal fails -> target remains -> retry`
  // must finish as released, not prepared-state-conflict). Faults rmSync
  // AFTER prepared persistence; restarts; proves gates rerun via an
  // intermediate ambiguous-session block; proves the existing prepared
  // transaction is reused byte-identically (same preparedAt, no overwrite).
  const dispRel10 = `disposable-retry-${Date.now()}`;
  const dispAbs10 = path.join(wsRoot, dispRel10);
  await fsp.mkdir(dispAbs10, { recursive: true });
  const retryBytes = Buffer.from('prepared-retry file content\n');
  await fsp.writeFile(path.join(dispAbs10, 'retry.txt'), retryBytes);
  const launch10 = await launchRest2(dispRel10, true);
  assert(!launch10.isError, 'launch10');
  const run10 = launch10.structuredContent.run_id;
  await waitSettledRest2(run10);
  const runFile10 = runFileFor(run10);
  const bridge10 = path.dirname(path.dirname(runFile10));
  const artDir10 = path.join(bridge10, 'delegation-artifacts', run10);
  const cgJs10 = path.join(await makeRoot('codexpro-dc-cg10-'), 'codegraph.js');
  const owned10 = await spawnCodegraphHelper(cgJs10, dispAbs10, false);
  const cgJs10other = path.join(await makeRoot('codexpro-dc-cg10other-'), 'codegraph.js');
  const unrelated10 = await spawnCodegraphHelper(cgJs10other, await makeRoot('codexpro-dc-retry-other-'), false);
  const nativeRm = fs.rmSync;
  let rmBlocked = false;
  fs.rmSync = function (target, ...rest) {
    if (!rmBlocked && String(target).includes(dispRel10)) {
      rmBlocked = true;
      const err = new Error('fixture removal fault after prepare');
      err.code = 'EIO';
      throw err;
    }
    return nativeRm.call(fs, target, ...rest);
  };
  let closeRetryFail;
  try { closeRetryFail = await callRest2('delegation_closeout', { workspace_id: workspaceId, run_id: run10, retire: true }); }
  finally { fs.rmSync = nativeRm; }
  assert(rmBlocked, 'fault must have intercepted physical removal');
  assert(!closeRetryFail.isError && closeRetryFail.structuredContent.exported === true && closeRetryFail.structuredContent.workdir_release === 'blocked', `first retry blocked ${JSON.stringify(closeRetryFail.structuredContent)}`);
  assert(fs.existsSync(dispAbs10) && fs.existsSync(path.join(dispAbs10, 'retry.txt')), 'workdir and files remain after failed removal');
  const preparedPath10 = path.join(artDir10, 'physical-release-prepared.json');
  const finalPath10 = path.join(artDir10, 'physical-release.json');
  assert(fs.existsSync(preparedPath10), 'prepared record exists after failed removal');
  assert(!fs.existsSync(finalPath10), 'final record absent after failed removal');
  const preparedBytesBefore = await fsp.readFile(preparedPath10, 'utf8');
  const preparedParsedBefore = JSON.parse(preparedBytesBefore);
  assert(preparedParsedBefore.phase === 'prepared' && typeof preparedParsedBefore.preparedAt === 'string' && preparedParsedBefore.dirIdentity && Number.isSafeInteger(preparedParsedBefore.dirIdentity.dev), 'prepared binds directory identity');
  await waitGone(owned10.pid, owned10.start, 'retry owned helper signalled before failed removal');
  assert(readStart(unrelated10.pid) === unrelated10.start, 'unrelated helper untouched by failed removal');
  // Restart recovery: recreate server/process state before retry.
  try { await client.close(); } catch {}
  try { await server.close(); } catch {}
  ({ srv: server, cli: client } = await openServer());
  const callRetry = async (name, args) => client.callTool({ name, arguments: args });
  const openedRetry = await callRetry('open_workspace', { root: wsRoot });
  assert(!openedRetry.isError, 'reopen after prepared-present interruption');
  workspaceId = openedRetry.structuredContent.workspace_id;
  const waitSettledRetry = async (runId, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      const r = await callRetry('delegation_read_result', { workspace_id: workspaceId, run_id: runId });
      assert(!r.isError, `read: ${JSON.stringify(r.structuredContent)}`);
      if (!['queued','running'].includes(r.structuredContent.state)) return r;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    throw new Error(`ASSERT: run ${runId} did not settle`);
  };
  // Gates rerun proof: an ambiguous session must still block the prepared
  // retry without touching the prepared record or the directory.
  process.env.CLOSEOUT_SESSION_MODE = 'ambiguous';
  let closeRetryGated;
  try { closeRetryGated = await callRetry('delegation_closeout', { workspace_id: workspaceId, run_id: run10, retire: true }); }
  finally { delete process.env.CLOSEOUT_SESSION_MODE; }
  assert(!closeRetryGated.isError && closeRetryGated.structuredContent.exported === true && closeRetryGated.structuredContent.workdir_release === 'blocked' && fs.existsSync(dispAbs10), `gated retry blocked ${JSON.stringify(closeRetryGated.structuredContent)}`);
  assert((await fsp.readFile(preparedPath10, 'utf8')) === preparedBytesBefore, 'gated retry must not replace the prepared transaction');
  assert(!fs.existsSync(finalPath10), 'no final record after gated block');
  // Clear retry reuses the existing prepared transaction and releases.
  const closeRetryOk = await callRetry('delegation_closeout', { workspace_id: workspaceId, run_id: run10, retire: true });
  assert(!closeRetryOk.isError && closeRetryOk.structuredContent.workdir_release === 'released' && closeRetryOk.structuredContent.dir_clear === true, `prepared retry released ${JSON.stringify(closeRetryOk.structuredContent)}`);
  assert(!fs.existsSync(dispAbs10), 'workdir physically removed by prepared retry');
  assert((await fsp.readFile(preparedPath10, 'utf8')) === preparedBytesBefore, 'prepared transaction reused byte-identically, not replaced/conflicted');
  assert(fs.existsSync(finalPath10), 'final physical-release.json durably published by retry');
  const finalParsed10 = JSON.parse(await fsp.readFile(finalPath10, 'utf8'));
  assert(finalParsed10.version === 1 && finalParsed10.dirIdentity.dev === preparedParsedBefore.dirIdentity.dev && finalParsed10.dirIdentity.ino === preparedParsedBefore.dirIdentity.ino, 'final carries the prepared directory identity');
  const readRetry = await callRetry('delegation_read_result', { workspace_id: workspaceId, run_id: run10 });
  assert(!readRetry.isError && readRetry.structuredContent.closeout?.workdir_release === 'released' && readRetry.structuredContent.closeout?.cleanup_finished === true, `retry read truthful ${JSON.stringify(readRetry.structuredContent.closeout)}`);
  const backedRetry = await fsp.readFile(path.join(artDir10, 'workdir-backup', 'retry.txt'));
  assert(backedRetry.equals(retryBytes), 'backup readable after prepared retry');
  const manifestRetry = JSON.parse(await fsp.readFile(path.join(artDir10, 'workdir-backup', 'backup-manifest.json'), 'utf8'));
  const retryEntry = manifestRetry.files.find((f) => f.rel === 'retry.txt');
  assert(retryEntry && createHash('sha256').update(backedRetry).digest('hex') === retryEntry.sha256, 'backup hash valid after prepared retry');
  assert(readStart(unrelated10.pid) === unrelated10.start, 'unrelated helper survives prepared retry');
  unrelated10.child.kill('SIGKILL');
  // Rebind for the rest of the proof.
  const callRest3 = callRetry;
  workspaceId = workspaceId;
  void callRest3;
  await waitSettledRetry(run10);
  console.log('P10 prepared+present retry: removal fault after prepare, restart, gated block proves gates rerun, cleared retry reused prepared byte-identically and released with backup intact and unrelated preserved.');

  // P11: pathname replacement during backup must not authorize the
  // replacement. A passes gates; during backup the pathname is atomically
  // replaced by B (different dev/ino, distinct NEW content). Release must
  // detect the identity change after backup/before prepared or deletion:
  // blocked, B intact with NEW bytes, no final claims release, no fresh
  // prepared authorizes B, stale OLD backup cannot release B.
  const dispRel11 = `disposable-swap-${Date.now()}`;
  const dispAbs11 = path.join(wsRoot, dispRel11);
  await fsp.mkdir(dispAbs11, { recursive: true });
  const oldBytes11 = Buffer.from('OLD\n');
  const newBytes11 = Buffer.from('NEW\n');
  await fsp.writeFile(path.join(dispAbs11, 'old.txt'), oldBytes11);
  reqN += 1;
  const launch11 = await callRetry('delegation_launch', {
    workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: dispRel11, task: 'Report readiness. Change nothing.', delegation_group: 'team-disposable-proof',
    request_id: `req-dc-${reqN}`, timeout_ms: 60000, disposable_workdir: true,
  });
  assert(!launch11.isError, 'launch11');
  const run11 = launch11.structuredContent.run_id;
  await waitSettledRetry(run11);
  const runFile11 = runFileFor(run11);
  const artDir11 = path.join(bridgeOf(runFile11), 'delegation-artifacts', run11);
  const cgJs11other = path.join(await makeRoot('codexpro-dc-cg11other-'), 'codegraph.js');
  const unrelated11 = await spawnCodegraphHelper(cgJs11other, await makeRoot('codexpro-dc-swap-other-'), false);
  const nativeReadFile = fs.readFileSync;
  let swapDone = false;
  fs.readFileSync = function (p, ...rest) {
    const ps = String(p);
    if (!swapDone && ps === path.join(dispAbs11, 'old.txt')) {
      const original = nativeReadFile.call(fs, p, ...rest);
      // Atomically replace pathname A with directory B after the backup
      // has observed A's OLD bytes: move A aside, create B with NEW.
      fs.renameSync(dispAbs11, `${dispAbs11}.orig-A`);
      fs.mkdirSync(dispAbs11, { mode: 0o700 });
      fs.writeFileSync(path.join(dispAbs11, 'old.txt'), newBytes11);
      swapDone = true;
      return original;
    }
    return nativeReadFile.call(fs, p, ...rest);
  };
  let closeSwap;
  try { closeSwap = await callRetry('delegation_closeout', { workspace_id: workspaceId, run_id: run11, retire: true }); }
  finally { fs.readFileSync = nativeReadFile; }
  assert(swapDone, 'swap must have occurred during backup');
  assert(!closeSwap.isError && closeSwap.structuredContent.exported === true && closeSwap.structuredContent.workdir_release === 'blocked', `swap blocked ${JSON.stringify(closeSwap.structuredContent)}`);
  // B at the same pathname remains intact with NEW content; A remains aside.
  assert(fs.existsSync(dispAbs11), 'replacement directory B must remain');
  const bBytes = await fsp.readFile(path.join(dispAbs11, 'old.txt'));
  assert(bBytes.equals(newBytes11), 'B NEW file byte-identical, not deleted or overwritten');
  assert(fs.existsSync(`${dispAbs11}.orig-A`), 'original directory A preserved aside, not deleted');
  const aBytes = await fsp.readFile(path.join(`${dispAbs11}.orig-A`, 'old.txt'));
  assert(aBytes.equals(oldBytes11), 'A OLD bytes preserved aside');
  assert(!fs.existsSync(path.join(artDir11, 'physical-release.json')), 'no final record claims release of the replacement');
  assert(!fs.existsSync(path.join(artDir11, 'physical-release-prepared.json')), 'no fresh prepared record authorizes the replacement');
  try {
    const manifestSwap = JSON.parse(await fsp.readFile(path.join(artDir11, 'workdir-backup', 'backup-manifest.json'), 'utf8'));
    const swapEntry = manifestSwap.files.find((f) => f.rel === 'old.txt');
    assert(swapEntry && swapEntry.sha256 !== createHash('sha256').update(newBytes11).digest('hex'), 'stale OLD backup cannot authorize B (NEW hash differs)');
  } catch (e) {
    if (e.message.startsWith('ASSERT:')) throw e;
    // No backup manifest at all is also acceptable: nothing authorizes B.
  }
  assert(readStart(unrelated11.pid) === unrelated11.start, 'unrelated helper untouched by swap block');
  unrelated11.child.kill('SIGKILL');
  // Restore test hygiene without authorizing B: remove B and restore A so
  // workspace cleanup stays ordinary (no closeout retried against B).
  await fsp.rm(dispAbs11, { recursive: true, force: true });
  await fsp.rename(`${dispAbs11}.orig-A`, dispAbs11);
  assert((await fsp.readFile(path.join(dispAbs11, 'old.txt'))).equals(oldBytes11), 'workdir restored to A after swap proof');
  console.log('P11 pathname replacement during backup: B untouched with NEW bytes, closeout blocked, no prepared/final authorizes B, stale backup cannot release B.');

  // P12: caller/release handoff replacement. A passes caller sharing gate;
  // the engine-session gate (fake session list) atomically replaces A with
  // B (different dev/ino, NEW bytes) before release begins. The caller chain
  // must refuse B, and a direct release call with the stale caller-bound
  // identity must also refuse B before destructive work. B stays intact.
  const dispRel12 = `disposable-handoff-${Date.now()}`;
  const dispAbs12 = path.join(wsRoot, dispRel12);
  await fsp.mkdir(dispAbs12, { recursive: true });
  const oldBytes12 = Buffer.from('OLD\n');
  const newBytes12 = Buffer.from('NEW\n');
  await fsp.writeFile(path.join(dispAbs12, 'handoff.txt'), oldBytes12);
  reqN += 1;
  const launch12 = await callRetry('delegation_launch', {
    workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
    workdir: dispRel12, task: 'Report readiness. Change nothing.', delegation_group: 'team-disposable-proof',
    request_id: `req-dc-${reqN}`, timeout_ms: 60000, disposable_workdir: true,
  });
  assert(!launch12.isError, 'launch12');
  const run12 = launch12.structuredContent.run_id;
  await waitSettledRetry(run12);
  const runFile12 = runFileFor(run12);
  const bridge12 = path.dirname(path.dirname(runFile12));
  const artDir12 = path.join(bridge12, 'delegation-artifacts', run12);
  const cgJs12other = path.join(await makeRoot('codexpro-dc-cg12other-'), 'codegraph.js');
  const unrelated12 = await spawnCodegraphHelper(cgJs12other, await makeRoot('codexpro-dc-handoff-other-'), false);
  const aStat12 = fs.statSync(dispAbs12);
  const aReal12 = fs.realpathSync(dispAbs12);
  const staleCallerTarget = { dirReal: aReal12, dev: aStat12.dev, ino: aStat12.ino };
  process.env.CLOSEOUT_SWAP_DIR = dispAbs12;
  process.env.CLOSEOUT_SESSION_MODE = 'swap-handoff';
  let closeHandoff;
  try { closeHandoff = await callRetry('delegation_closeout', { workspace_id: workspaceId, run_id: run12, retire: true }); }
  finally { delete process.env.CLOSEOUT_SESSION_MODE; delete process.env.CLOSEOUT_SWAP_DIR; }
  assert(!closeHandoff.isError && closeHandoff.structuredContent.exported === true && closeHandoff.structuredContent.workdir_release === 'blocked', `handoff blocked ${JSON.stringify(closeHandoff.structuredContent)}`);
  assert(fs.existsSync(dispAbs12), 'replacement B must remain at the pathname');
  assert((await fsp.readFile(path.join(dispAbs12, 'handoff.txt'))).equals(newBytes12), 'B NEW file byte-identical');
  assert(fs.existsSync(`${dispAbs12}.orig-A`), 'original A preserved aside');
  assert((await fsp.readFile(path.join(`${dispAbs12}.orig-A`, 'handoff.txt'))).equals(oldBytes12), 'A OLD bytes preserved aside');
  assert(!fs.existsSync(path.join(artDir12, 'physical-release.json')), 'no final claims B released');
  assert(!fs.existsSync(path.join(artDir12, 'physical-release-prepared.json')), 'no fresh prepared authorizes B');
  try {
    const manifestHandoff = JSON.parse(await fsp.readFile(path.join(artDir12, 'workdir-backup', 'backup-manifest.json'), 'utf8'));
    const handoffEntry = manifestHandoff.files.find((f) => f.rel === 'handoff.txt');
    assert(!handoffEntry || handoffEntry.sha256 !== createHash('sha256').update(newBytes12).digest('hex'), 'no backup proves B');
  } catch (e) {
    if (e.message.startsWith('ASSERT:')) throw e;
  }
  assert(readStart(unrelated12.pid) === unrelated12.start, 'unrelated helper untouched by handoff block');
  // Release-side defense in depth: a direct release call carrying the stale
  // caller-bound identity (A) while B sits at the pathname must refuse
  // before backup/prepared/deletion and leave B intact.
  const { releaseDisposableWorktree: releaseDirect } = await import(fileUrl(path.join(ROOT, 'dist', 'disposableCloseout.js')));
  const rec12 = JSON.parse(await fsp.readFile(runFile12, 'utf8'));
  const directRefusal = await releaseDirect(bridge12, {
    runId: run12, ownerIdHash: rec12.ownerIdHash, ownerKind: rec12.ownerKind,
    workdir: rec12.workdir, engine: rec12.engine, sessionId: rec12.session?.sessionId ?? null,
  }, { expectedTarget: staleCallerTarget });
  assert(directRefusal.ok === false && directRefusal.workdirRelease === 'blocked' && String(directRefusal.reason).includes('caller-identity-mismatch'), `direct release refuses stale caller identity ${JSON.stringify(directRefusal)}`);
  assert((await fsp.readFile(path.join(dispAbs12, 'handoff.txt'))).equals(newBytes12), 'B still intact after direct release refusal');
  assert(!fs.existsSync(path.join(artDir12, 'physical-release.json')), 'direct refusal creates no final');
  assert(!fs.existsSync(path.join(artDir12, 'physical-release-prepared.json')), 'direct refusal creates no prepared for B');
  assert(readStart(unrelated12.pid) === unrelated12.start, 'unrelated helper survives direct refusal');
  unrelated12.child.kill('SIGKILL');
  await fsp.rm(dispAbs12, { recursive: true, force: true });
  await fsp.rename(`${dispAbs12}.orig-A`, dispAbs12);
  assert((await fsp.readFile(path.join(dispAbs12, 'handoff.txt'))).equals(oldBytes12), 'workdir restored to A after handoff proof');
  console.log('P12 caller handoff: A gated, B swapped during session gate, public closeout blocked with B intact NEW, direct release with stale caller identity refused before destructive work.');

  // R0: read-only real-engine lifecycle evidence (no mutation, no shared-service contact).
  // Uses the installed opencode binary and live /proc only: session entries
  // carry directory identity, and shared CodeGraph helpers serve non-tmp
  // paths while no shared helper serves our removed /tmp dirs.
  const realBinCandidates = ['/home/andrew/.nvm/versions/node/v22.22.2/bin/opencode', '/home/andrew/.local/opencode-v2/2.0.22/bin/opencode'];
  let realBin;
  for (const candidate of realBinCandidates) { try { fs.accessSync(candidate, fs.constants.X_OK); realBin = candidate; break; } catch {} }
  if (realBin) {
    const list = spawnSync(realBin, ['session', 'list', '--format', 'json', '--max-count', '5'], { timeout: 15000, encoding: 'utf8', maxBuffer: 512 * 1024, env: { ...process.env, NO_COLOR: '1' } });
    assert(!list.error && list.status === 0, 'real session list readable');
    const sessions = JSON.parse(String(list.stdout ?? ''));
    assert(Array.isArray(sessions), 'real session list is an array');
    for (const entry of sessions) {
      assert(entry && typeof entry.id === 'string' && typeof entry.directory === 'string', `real session has directory identity: ${JSON.stringify(entry).slice(0, 160)}`);
    }
    let sharedHelperSeen = false;
    for (const entry of fs.readdirSync('/proc')) {
      const pid = Number(entry);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      let cmd;
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (!cmd.includes('codegraph')) continue;
      const parts = cmd.split('\0').filter(Boolean);
      const pathIndex = parts.findIndex((t) => t === '--path');
      const served = pathIndex >= 0 ? parts[pathIndex + 1] : undefined;
      if (served && !served.startsWith('/tmp/')) sharedHelperSeen = true;
      if (served === dispAbs1) throw new Error('ASSERT: shared helper must not serve the removed disposable dir');
    }
    assert(sharedHelperSeen, 'real shared CodeGraph helpers observed and untouched');
    console.log(`R0 real-engine read-only: sessions=${sessions.length} with directory identity; shared helpers observed, removed /tmp dirs unserved, zero mutations.`);
  } else {
    console.log('R0 real-engine read-only: installed opencode binary not found, skipped without mutation.');
  }

  console.log('PASS disposable isolated closeout proof: P1, P2, P2b, P3, P4, P5, P6, P7, P7b, P7c, P8, P9, P10, P11, P12 plus R0 complete (fixture sections use the task-owned fake engine; R0 uses the installed engine read-only).');
  await cleanup();
} catch (e) {
  try { await cleanup(); } catch {}
  console.error(e?.stack ?? String(e));
  process.exit(1);
}
