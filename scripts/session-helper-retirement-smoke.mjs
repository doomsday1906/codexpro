#!/usr/bin/env node
// Public MCP regression for explicit OpenCode closeout. The server route and
// isolated target files are exercised directly; the fake OpenCode executable
// is only a deterministic engine/export oracle and failure injector.
//
// Expected from the requester authority: only an actual settled, owner-bound
// run plus retire:true may be archived; export identity and durable readback
// must succeed before reporting archival. Closeout permanently blocks adapter
// follow-up while preserving engine session, helpers, and workdir. The route
// must report release as blocked even on successful archive. Export failures
// stay retryable. Concurrent unrelated work in the same directory survives.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const fileUrl = (p) => `file://${p}`;
function assert(ok, message) { if (!ok) throw new Error(`ASSERT: ${message}`); }
function assertBlocked(result, where) {
  const x = result.structuredContent ?? {};
  assert(x.dir_clear === false && x.cleanup_finished === false && x.session_deleted === false,
    `${where}: release/session flags must stay false: ${JSON.stringify(x)}`);
  assert(Array.isArray(x.helpers_signalled) && x.helpers_signalled.length === 0,
    `${where}: shared helpers must not be signalled: ${JSON.stringify(x)}`);
  assert(x.workdir_release === 'blocked' && /atomic|shared helper|project lifecycle/i.test(x.blocker ?? ''),
    `${where}: exact blocked reason must be reported: ${JSON.stringify(x)}`);
}

const envKeys = [
  'CODEX_HOME', 'CODEXPRO_OPENCODE_AGENTS_DIR', 'CODEXPRO_OPENCODE_BIN',
  'CODEXPRO_DELEGATION_DIR', 'CODEXPRO_DELEGATION_LEGACY_BRIDGE',
  'CLOSEOUT_RUN_MODE_FILE', 'CLOSEOUT_EXPORT_MODE', 'CLOSEOUT_COUNTER_FILE', 'CLOSEOUT_LOG_FILE'
];
const oldEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const roots = [];
const ownedProcesses = new Map();
const ownedChildHandles = new Set();
const activeFixtureRunIds = new Set();
const runProcessIdentities = new Map();
let client;
let server;
let workspaceId;
let primaryError;
const restoreEnv = () => {
  for (const k of envKeys) {
    if (oldEnv[k] === undefined) delete process.env[k];
    else process.env[k] = oldEnv[k];
  }
};
async function cleanup() {
  let failure;
  try {
    for (const runId of [...activeFixtureRunIds]) {
      try {
        await client?.callTool({ name: 'delegation_cancel', arguments: { workspace_id: workspaceId, run_id: runId } });
        const identity = runProcessIdentities.get(runId);
        if (identity) await waitForProcessGone(identity, `cleanup run ${runId}`);
        activeFixtureRunIds.delete(runId);
      } catch (error) { failure ??= error; }
    }
    try { await client?.close(); } catch (error) { failure ??= error; }
    try { await server?.close(); } catch (error) { failure ??= error; }
    const childStillRunning = (child) => child.exitCode === null && child.signalCode === null;
    const fixtureProcessesAlive = () =>
      [...ownedProcesses].some(([pid, start]) => {
        const handle = [...ownedChildHandles].find((child) => child.pid === pid);
        return !(handle && !childStillRunning(handle)) && readStart(pid) === start;
      }) ||
      [...ownedChildHandles].some(childStillRunning);
    for (const child of ownedChildHandles) { if (childStillRunning(child)) { try { child.kill('SIGTERM'); } catch { /* gone */ } } }
    for (let i = 0; i < 20 && fixtureProcessesAlive(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const child of ownedChildHandles) { if (childStillRunning(child)) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
    for (let i = 0; i < 40 && fixtureProcessesAlive(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const survivors = [
      ...[...ownedProcesses].filter(([pid, start]) => {
        const handle = [...ownedChildHandles].find((child) => child.pid === pid);
        return !(handle && !childStillRunning(handle)) && readStart(pid) === start;
      }).map(([pid]) => pid),
      ...[...ownedChildHandles].filter(childStillRunning).map((child) => child.pid)
    ];
    if (survivors.length) {
      const details = survivors.map((pid) => {
        let state = 'unreadable';
        let ppid = 'unknown';
        let start = 'unknown';
        try {
          const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
          state = fields[0] ?? state;
          ppid = fields[1] ?? ppid;
          start = fields[19] ?? start;
        } catch { /* vanished after the survivor check */ }
        const runOwners = [...runProcessIdentities].filter(([, identity]) => identity.pid === pid).map(([runId]) => runId);
        const childHandle = [...ownedChildHandles].some((child) => child.pid === pid);
        return `${pid}(state=${state},ppid=${ppid},start=${start},run=${runOwners.join('|') || 'none'},child_handle=${childHandle})`;
      });
      failure ??= new Error(`fixture processes survived cleanup: ${details.join(',')}`);
    }
  } catch (error) { failure ??= error; }
  finally {
    restoreEnv();
    for (const dir of roots.splice(0)) {
      try { await fsp.rm(dir, { recursive: true, force: true }); } catch (error) { failure ??= error; }
    }
  }
  if (failure) throw failure;
}
async function makeRoot(prefix) {
  const dir = await fsp.mkdtemp(path.join('/tmp', prefix));
  roots.push(dir);
  return dir;
}
function readStart(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
  } catch { return null; }
}
async function makeOwnedSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
  ownedChildHandles.add(child);
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid;
  assert(Number.isSafeInteger(pid) && pid > 0, 'fixture sleeper must have a valid spawned PID');
  const start = readStart(pid);
  if (start !== null) ownedProcesses.set(pid, start);
  assert(start !== null, 'fixture sleeper must have an observable start identity');
  return { pid, start };
}
function findRunFile(dir, runId) {
  const walk = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) { const hit = walk(candidate); if (hit) return hit; }
      else if (entry.name === `${runId}.json`) return candidate;
    }
    return null;
  };
  try { return walk(dir); } catch { return null; }
}
let delegationHome;
async function trackRunProcess(runId, waitForIt = false) {
  for (let i = 0; i < (waitForIt ? 40 : 1); i += 1) {
    const runFile = delegationHome ? findRunFile(delegationHome, runId) : null;
    if (runFile) {
      try {
        const record = JSON.parse(await fsp.readFile(runFile, 'utf8'));
        const attempt = record.attempts?.at(-1);
        if (Number.isSafeInteger(attempt?.pid) && typeof attempt.processStartTime === 'string') {
          const identity = { pid: attempt.pid, start: attempt.processStartTime };
          ownedProcesses.set(identity.pid, identity.start);
          runProcessIdentities.set(runId, identity);
          return identity;
        }
      } catch { /* storage may still be settling */ }
    }
    if (waitForIt) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}
async function waitForProcessGone(identity, label) {
  if (!identity) return;
  for (let i = 0; i < 40 && readStart(identity.pid) === identity.start; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(readStart(identity.pid) !== identity.start, `${label} process identity must exit: ${identity.pid}`);
}

try {
  const codexHome = await makeRoot('codexpro-closeout-codex-');
  const agentsDir = await makeRoot('codexpro-closeout-agents-');
  const wsRoot = await makeRoot('codexpro-closeout-ws-');
  const delegHome = await makeRoot('codexpro-closeout-store-');
  delegationHome = delegHome;
  const shimDir = await makeRoot('codexpro-closeout-shim-');
  await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
  await fsp.writeFile(path.join(agentsDir, 'implementer.md'), '# implementer\n\nIsolated closeout smoke fixture.\n');
  const modeFile = path.join(shimDir, 'run-mode');
  const counterFile = path.join(shimDir, 'run-counter');
  const logFile = path.join(shimDir, 'engine.log');
  const opencodeBin = path.join(shimDir, 'opencode');
  await fsp.writeFile(modeFile, 'instant\n');
  await fsp.writeFile(counterFile, '0\n');
  await fsp.writeFile(logFile, '');
  await fsp.writeFile(opencodeBin, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'opencode v2.0.22'; exit 0; fi
if [ "$1" = "session" ]; then echo "session:$2:$3" >> "$CLOSEOUT_LOG_FILE"; fi
if [ "$1" = "session" ] && [ "$2" = "export" ]; then
  sid="$3"
  echo "export:$sid" >> "$CLOSEOUT_LOG_FILE"
  case "$CLOSEOUT_EXPORT_MODE" in
    fail) echo 'fixture export denied' >&2; exit 7 ;;
    invalid) echo '{"info":{"id":"wrong-session"}}'; exit 0 ;;
    timeout) exec sleep 30 ;;
    large)
      printf '{"info":{"id":"%s"},"history":"' "$sid"
      head -c 20000 /dev/zero | tr '\\000' 'x'
      printf '"}\\n'
      exit 0 ;;
  esac
  printf '{"info":{"id":"%s"},"messages":[{"text":"retained fixture history for %s"}]}\\n' "$sid" "$sid"
  exit 0
fi
if [ "$1" = "session" ] && [ "$2" = "list" ]; then
  n=$(cat "$CLOSEOUT_COUNTER_FILE")
  printf '['
  i=1
  while [ "$i" -le "$n" ]; do
    if [ "$i" -gt 1 ]; then printf ','; fi
    printf '{"id":"ses_fixture_%s"}' "$i"
    i=$((i + 1))
  done
  printf ']\\n'
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
  if [ -z "$sid" ]; then sid="ses_fixture_$n"; fi
  echo "run:$sid" >> "$CLOSEOUT_LOG_FILE"
  printf '{"sessionID":"%s","message":"fixture worker finished"}\\n' "$sid"
  mode=$(cat "$CLOSEOUT_RUN_MODE_FILE")
  if [ "$mode" = "wait" ]; then exec sleep 60; fi
  if [ "$mode" = "fail" ]; then exit 9; fi
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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'session-closeout-regression', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const opened = await call('open_workspace', { root: wsRoot });
  assert(!opened.isError, `workspace open: ${JSON.stringify(opened.structuredContent)}`);
  workspaceId = opened.structuredContent.workspace_id;

  const waitSettled = async (runId, tries = 120) => {
    for (let i = 0; i < tries; i += 1) {
      const read = await call('delegation_read_result', { workspace_id: workspaceId, run_id: runId });
      assert(!read.isError, `read while waiting: ${JSON.stringify(read.structuredContent)}`);
      if (!['queued', 'running'].includes(read.structuredContent.state)) return read;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`ASSERT: run ${runId} did not settle`);
  };
  let requestN = 0;
  const launch = async (workdir = 'shared-closeout', timeoutMs = 60000, sessionId) => {
    requestN += 1;
    const r = await call('delegation_launch', {
      workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model',
      workdir, task: 'Report readiness. Change nothing.', delegation_group: 'team-closeout-smoke',
      request_id: `req-closeout-${requestN}`, timeout_ms: timeoutMs,
      ...(sessionId ? { session_id: sessionId } : {})
    });
    const runId = r.structuredContent?.run_id;
    if (typeof runId === 'string' && (await fsp.readFile(modeFile, 'utf8')).trim() === 'wait') {
      activeFixtureRunIds.add(runId);
      await trackRunProcess(runId, true);
    }
    assert(!r.isError, `launch ${requestN}: ${JSON.stringify(r.structuredContent)}`);
    return runId;
  };
  const runFileFor = (runId) => findRunFile(delegHome, runId);

  // P1: a real MCP launch creates settled, persisted state; closeout while an
  // unrelated same-directory turn is active archives history but releases no
  // project resources. The run state and helper/service fixture are untouched.
  await fsp.writeFile(modeFile, 'instant\n');
  const alpha = await launch();
  const alphaRead = await waitSettled(alpha);
  assert(alphaRead.structuredContent.state === 'completed', `alpha actual state: ${alphaRead.structuredContent.state}`);
  const alphaRunFile = runFileFor(alpha);
  assert(alphaRunFile, 'public launch must persist its run record');
  const alphaRecord = JSON.parse(await fsp.readFile(alphaRunFile, 'utf8'));
  const alphaSession = alphaRecord.session?.sessionId;
  assert(typeof alphaSession === 'string' && /^ses_fixture_\d+$/.test(alphaSession),
    `session identity must come from the run output: ${JSON.stringify(alphaRecord.session)}`);
  assert(alphaRecord.attempts.at(-1)?.exitCode === 0 && alphaRecord.attempts.at(-1)?.finishedAt,
    `terminal predicate must be backed by completed attempt evidence: ${JSON.stringify(alphaRecord.attempts.at(-1))}`);

  await fsp.writeFile(modeFile, 'wait\n');
  const beta = await launch('shared-closeout', 60000, 'ses_fixture_beta');
  let betaRecord;
  let betaStarted;
  for (let i = 0; i < 40; i += 1) {
    betaStarted = await call('delegation_read_result', { workspace_id: workspaceId, run_id: beta });
    const betaPath = runFileFor(beta);
    if (betaPath) betaRecord = JSON.parse(await fsp.readFile(betaPath, 'utf8'));
    if (betaStarted.structuredContent.state === 'running' && betaRecord?.session?.sessionId) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(betaStarted.structuredContent.state === 'running' && betaRecord?.session?.sessionId === 'ses_fixture_beta' &&
    betaRecord.session.sessionId !== alphaSession && betaRecord.workdir === alphaRecord.workdir,
    `beta must be a distinct live session attached to the same workdir: ${JSON.stringify(betaRecord?.session)}`);
  const betaIdentity = await trackRunProcess(beta, true);
  assert(betaIdentity, 'active same-directory fixture process must have an owned PID/starttime identity');
  const alphaClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: alpha, retire: true });
  assert(!alphaClose.isError && alphaClose.structuredContent.exported === true &&
    alphaClose.structuredContent.retired === true && alphaClose.structuredContent.reason === 'archived-release-blocked',
    `settled alpha must archive through MCP while beta runs: ${JSON.stringify(alphaClose.structuredContent)}`);
  assertBlocked(alphaClose, 'successful closeout');

  const runBridge = path.dirname(path.dirname(alphaRunFile));
  const archiveDir = path.join(runBridge, 'delegation-artifacts', alpha);
  const archivePath = path.join(archiveDir, 'session-export.json');
  const intentPath = path.join(archiveDir, 'retirement.json');
  assert(fs.existsSync(archivePath) && fs.existsSync(intentPath), 'archive and monotonic retirement intent must exist');
  const exportRaw = await fsp.readFile(archivePath, 'utf8');
  const exported = JSON.parse(exportRaw);
  assert(exported.binding?.runId === alpha && exported.binding?.sessionId === alphaSession &&
    exported.binding?.workdir === alphaRecord.workdir && typeof exported.output === 'string',
    `durable envelope must bind exact run/session/workdir and retain raw export: ${JSON.stringify(exported.binding)}`);
  const alphaOutput = exported.output;
  assert(JSON.parse(alphaOutput).info?.id === alphaSession,
    `raw engine export identity must match ${alphaSession}`);
  const intent = JSON.parse(await fsp.readFile(intentPath, 'utf8'));
  assert(intent.runId === alpha && intent.sessionId === alphaSession && intent.workdir === alphaRecord.workdir,
    `retirement intent must bind run/session/workdir identity: ${JSON.stringify(intent)}`);
  const blockedAfter = await call('delegation_read_result', { workspace_id: workspaceId, run_id: alpha });
  assert(!blockedAfter.isError && blockedAfter.structuredContent.closeout?.exported === true &&
    blockedAfter.structuredContent.closeout?.cleanup_finished === false &&
    blockedAfter.structuredContent.closeout?.dir_clear === false,
    `ordinary read route must preserve honest closeout state: ${JSON.stringify(blockedAfter.structuredContent.closeout)}`);
  const page = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: alpha, offset: 0, max_chars: 40 });
  assert(!page.isError && page.structuredContent.text === alphaOutput.slice(0, 40) &&
    page.structuredContent.next_offset === 40 && page.structuredContent.total_chars === alphaOutput.length,
    `bounded public read must match the durable export: ${JSON.stringify(page.structuredContent)}`);

  // Repeat is idempotent; future adapter continuation is closed. Neither
  // operation is permission to delete the shared engine session or workdir.
  const repeated = await call('delegation_closeout', { workspace_id: workspaceId, run_id: alpha, retire: true });
  assert(!repeated.isError && repeated.structuredContent.exported === true && repeated.structuredContent.session_deleted === false,
    `repeat closeout must remain successful and preserve session: ${JSON.stringify(repeated.structuredContent)}`);
  assertBlocked(repeated, 'repeated closeout');
  const followup = await call('delegation_followup', { workspace_id: workspaceId, run_id: alpha,
    checkpoint: { id: 'closeout-followup', run_id: alpha, seq: 1, payload: { answer: 'continue' }, input_request_id: 'missing-request' } });
  assert(followup.isError && followup.structuredContent.error === 'run_retired' && followup.structuredContent.executed === false,
    `retirement intent must stop future follow-up: ${JSON.stringify(followup.structuredContent)}`);
  const runCountBeforeRetiredResume = (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('run:')).length;
  const retiredResume = await call('delegation_launch', {
    workspace_id: workspaceId, engine: 'opencode', agent: 'implementer', model: 'test-model', session_id: alphaSession,
    workdir: 'retired-session-resume', task: 'Continue old session.', delegation_group: 'team-closeout-smoke',
    request_id: 'req-closeout-retired-resume', timeout_ms: 60000
  });
  assert(retiredResume.isError && ['session_retired', 'run_retired'].includes(retiredResume.structuredContent.error) &&
    (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('run:')).length === runCountBeforeRetiredResume,
    `known retired session must reject explicit relaunch before engine dispatch: ${JSON.stringify(retiredResume.structuredContent)}`);
  const anotherWorkspace = path.join(wsRoot, 'other-workspace');
  await fsp.mkdir(anotherWorkspace, { recursive: true });
  const wrongOwnerOpen = await call('open_workspace', { root: anotherWorkspace });
  assert(!wrongOwnerOpen.isError, 'second isolated workspace must open');
  const wrongOwner = await call('delegation_closeout', { workspace_id: wrongOwnerOpen.structuredContent.workspace_id, run_id: alpha, retire: true });
  assert(wrongOwner.isError, 'foreign workspace owner must not close out alpha');
  const wrongOwnerRead = await call('delegation_read_closeout', { workspace_id: wrongOwnerOpen.structuredContent.workspace_id, run_id: alpha });
  assert(wrongOwnerRead.isError, 'foreign workspace owner must not read alpha archive');
  const missingRun = 'run_0000000000000000';
  const missingClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: missingRun, retire: true });
  const missingRead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: missingRun });
  const missingArtifacts = path.join(runBridge, 'delegation-artifacts', missingRun);
  assert(missingClose.isError && missingRead.isError && !fs.existsSync(missingArtifacts),
    'invalid/foreign run identity must refuse both public routes without creating artifacts');
  assertBlocked(repeated, 'foreign-owner non-effect baseline');
  console.log('P1 public MCP: terminal run archived and identity-checked; blocked workdir/session/helper status persisted; concurrent unrelated same-dir run remained active.');

  // P2: caller terminal-state claims cannot authorize closing a resumable run.
  // This run is created by the MCP route and emits its session before holding.
  const beforeInvalid = (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('export:')).length;
  const activeClose = await call('delegation_closeout', {
    workspace_id: workspaceId, run_id: beta, retire: true, terminal_states: ['running']
  });
  assert(activeClose.isError && /Invalid arguments for delegation_closeout/i.test(activeClose.structuredContent.error ?? ''),
    `caller-supplied terminal states must fail schema validation: ${JSON.stringify(activeClose.structuredContent)}`);
  const activeStoredClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: beta, retire: true });
  assert(activeStoredClose.isError && activeStoredClose.structuredContent.error === 'closeout_not_terminal',
    `actual active run state must independently refuse closeout: ${JSON.stringify(activeStoredClose.structuredContent)}`);
  assert((await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('export:')).length === beforeInvalid,
    'untrusted state claim and actual active run must both refuse before engine export');
  const betaCancel = await call('delegation_cancel', { workspace_id: workspaceId, run_id: beta });
  assert(!betaCancel.isError && betaCancel.structuredContent.state === 'cancelled',
    `isolated owned beta turn must cancel: ${JSON.stringify(betaCancel.structuredContent)}`);
  assert(betaCancel.structuredContent.cleanup_finished === true,
    `owned standalone worker cancellation must finish its owned process cleanup: ${JSON.stringify(betaCancel.structuredContent)}`);
  await waitForProcessGone(betaIdentity, 'cancelled beta');
  activeFixtureRunIds.delete(beta);
  const betaRead = await call('delegation_read_result', { workspace_id: workspaceId, run_id: beta });
  assert(!betaRead.isError && betaRead.structuredContent.state === 'cancelled' && fs.existsSync(betaRecordWorkdir(betaRead, wsRoot)),
    'cancel must leave the same-directory workdir present');
  const cancelledClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: beta, retire: true });
  assert(!cancelledClose.isError && cancelledClose.structuredContent.exported === true,
    `settled cancelled run must archive while keeping release blocked: ${JSON.stringify(cancelledClose.structuredContent)}`);
  assertBlocked(cancelledClose, 'cancelled-run closeout');
  const cancelledRepeat = await call('delegation_closeout', { workspace_id: workspaceId, run_id: beta, retire: true });
  assert(!cancelledRepeat.isError && cancelledRepeat.structuredContent.exported === true,
    'cancelled run closeout must remain idempotent');
  assertBlocked(cancelledRepeat, 'repeated cancelled-run closeout');
  console.log('P2 public MCP: active resumable run rejected forged terminal_states; cancellation retained directory and honest cleanup bounds.');

  // A settled run with an open request remains resumable and cannot be retired.
  await fsp.writeFile(modeFile, 'instant\n');
  const needsInput = await launch();
  const needsSettled = await waitSettled(needsInput);
  assert(needsSettled.structuredContent.state === 'completed', 'needs-input fixture must first settle through launch');
  const question = await call('delegation_followup', { workspace_id: workspaceId, run_id: needsInput,
    checkpoint: { id: 'closeout-needs-input', run_id: needsInput, seq: 0, payload: {},
      questions: [{ id: 'continue', question: 'Should this task continue?' }] } });
  assert(!question.isError && question.structuredContent.state === 'needs-input',
    `question checkpoint must make run resumable: ${JSON.stringify(question.structuredContent)}`);
  const needsRunFile = runFileFor(needsInput);
  const needsRecord = JSON.parse(await fsp.readFile(needsRunFile, 'utf8'));
  const needsArchiveDir = path.join(path.dirname(path.dirname(needsRunFile)), 'delegation-artifacts', needsInput);
  const exportsBeforeNeedsClose = (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('session:export:')).length;
  const needsClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: needsInput, retire: true });
  assert(needsClose.isError && needsClose.structuredContent.error === 'closeout_not_terminal' &&
    !fs.existsSync(path.join(needsArchiveDir, 'retirement.json')) &&
    (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('session:export:')).length === exportsBeforeNeedsClose,
    `needs-input closeout must refuse without intent/export: ${JSON.stringify(needsClose.structuredContent)}`);
  const answer = await call('delegation_followup', { workspace_id: workspaceId, run_id: needsInput,
    checkpoint: { id: 'closeout-needs-answer', run_id: needsInput, seq: 1, payload: { answer: 'continue' }, input_request_id: 'closeout-needs-input' } });
  assert(!answer.isError && answer.structuredContent.executed === true,
    `ordinary follow-up must still be available after closeout refusal: ${JSON.stringify(answer.structuredContent)}`);
  const needsAfter = await waitSettled(needsInput);
  assert(needsAfter.structuredContent.state === 'completed' &&
    JSON.parse(await fsp.readFile(needsRunFile, 'utf8')).attempts.length === needsRecord.attempts.length + 1,
    'ordinary follow-up must complete as a new observed attempt');
  console.log('P2b public MCP: needs-input retirement refused without effects; ordinary follow-up remained usable.');

  // Failed is terminal only after the real attempt exits; it remains eligible
  // for archive-only closeout and repeat without deleting the engine session.
  await fsp.writeFile(modeFile, 'fail\n');
  const failedRun = await launch();
  const failedRead = await waitSettled(failedRun);
  assert(failedRead.structuredContent.state === 'failed',
    `failed turn state must come from the nonzero worker exit: ${JSON.stringify(failedRead.structuredContent)}`);
  const failedRunRecord = JSON.parse(await fsp.readFile(runFileFor(failedRun), 'utf8'));
  assert(failedRunRecord.attempts.at(-1)?.exitCode === 9 && failedRunRecord.session?.sessionId,
    `failed run must retain real nonzero exit and session identity: ${JSON.stringify(failedRunRecord.attempts.at(-1))}`);
  await fsp.writeFile(modeFile, 'instant\n');
  const failedClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: failedRun, retire: true });
  assert(!failedClose.isError && failedClose.structuredContent.exported === true,
    `settled failed run may archive with release blocked: ${JSON.stringify(failedClose.structuredContent)}`);
  assertBlocked(failedClose, 'failed-run closeout');
  const failedRepeat = await call('delegation_closeout', { workspace_id: workspaceId, run_id: failedRun, retire: true });
  assert(!failedRepeat.isError && failedRepeat.structuredContent.exported === true,
    'failed-run closeout must remain idempotent');
  assertBlocked(failedRepeat, 'repeated failed-run closeout');
  console.log('P2c public MCP: nonzero failed worker exit remained terminal, preservable, and repeatable.');

  // P3: export failure and wrong-identity output are not reported as archived;
  // intent remains durable and a corrected retry can finish without deleting
  // the session, prior history, workdir, or unrelated run artifacts.
  await fsp.writeFile(modeFile, 'instant\n');
  const gamma = await launch();
  const gammaRead = await waitSettled(gamma);
  assert(gammaRead.structuredContent.state === 'completed', 'gamma must complete through MCP');
  const gammaRunFile = runFileFor(gamma);
  const gammaRecord = JSON.parse(await fsp.readFile(gammaRunFile, 'utf8'));
  const gammaWorkdir = gammaRecord.workdir;
  const gammaArchiveDir = path.join(path.dirname(path.dirname(gammaRunFile)), 'delegation-artifacts', gamma);
  process.env.CLOSEOUT_EXPORT_MODE = 'fail';
  const failedExport = await call('delegation_closeout', { workspace_id: workspaceId, run_id: gamma, retire: true });
  assert(failedExport.isError && failedExport.structuredContent.exported === false &&
    failedExport.structuredContent.reason === 'export-failed',
    `nonzero export must stay retryable and incomplete: ${JSON.stringify(failedExport.structuredContent)}`);
  assertBlocked(failedExport, 'failed export');
  assert(fs.existsSync(path.join(gammaArchiveDir, 'retirement.json')) &&
    !fs.existsSync(path.join(gammaArchiveDir, 'session-export.json')) && fs.existsSync(gammaWorkdir),
    'failed export must preserve durable intent and workdir without claiming an archive');
  const failedFollowup = await call('delegation_followup', { workspace_id: workspaceId, run_id: gamma,
    checkpoint: { id: 'gamma-followup', run_id: gamma, seq: 1, payload: {}, input_request_id: 'missing' } });
  assert(failedFollowup.isError && failedFollowup.structuredContent.error === 'run_retired',
    'published retirement intent must prevent follow-up even while export retry is pending');

  process.env.CLOSEOUT_EXPORT_MODE = 'invalid';
  const invalidExport = await call('delegation_closeout', { workspace_id: workspaceId, run_id: gamma, retire: true });
  assert(invalidExport.isError && invalidExport.structuredContent.exported === false &&
    invalidExport.structuredContent.reason === 'export-invalid',
    `wrong identity export must stay incomplete: ${JSON.stringify(invalidExport.structuredContent)}`);
  assert(!fs.existsSync(path.join(gammaArchiveDir, 'session-export.json')),
    'invalid identity bytes must never become the durable archive');
  process.env.CLOSEOUT_EXPORT_MODE = 'timeout';
  const timedExport = await call('delegation_closeout', { workspace_id: workspaceId, run_id: gamma, retire: true, timeout_ms: 1000 });
  assert(timedExport.isError && timedExport.structuredContent.exported === false &&
    timedExport.structuredContent.reason === 'export-failed' && timedExport.structuredContent.engine_signal === 'SIGKILL' &&
    !fs.existsSync(path.join(gammaArchiveDir, 'session-export.json')),
    `timed-out export must be bounded, incomplete, and leave no partial archive: ${JSON.stringify(timedExport.structuredContent)}`);
  delete process.env.CLOSEOUT_EXPORT_MODE;
  const gammaRetry = await call('delegation_closeout', { workspace_id: workspaceId, run_id: gamma, retire: true });
  assert(!gammaRetry.isError && gammaRetry.structuredContent.exported === true,
    `corrected export retry must succeed: ${JSON.stringify(gammaRetry.structuredContent)}`);
  assertBlocked(gammaRetry, 'recovered export retry');
  assert(fs.existsSync(gammaWorkdir), 'successful archival still must not remove the workdir');
  const gammaEnvelope = JSON.parse(await fsp.readFile(path.join(gammaArchiveDir, 'session-export.json'), 'utf8'));
  assert(gammaEnvelope.binding?.runId === gamma && gammaEnvelope.binding?.sessionId === gammaRecord.session?.sessionId,
    'durable archive envelope must bind owner/run/workdir/session provenance');
  const gammaRaw = gammaEnvelope.output;
  assert(typeof gammaRaw === 'string' && JSON.parse(gammaRaw).info?.id === gammaRecord.session?.sessionId,
    'retry archive must contain the exact run session history');
  const gammaLog = await fsp.readFile(logFile, 'utf8');
  assert(!/^session:delete:/m.test(gammaLog), 'closeout must never issue session delete');
  console.log('P3 public MCP: failed and wrong-identity exports stayed incomplete; retry archived verified bytes without deleting run history/workdir.');

  // P3a: an atomic archive may exist after a crash between archive fsync and
  // the separate confirmation receipt. It stays unconfirmed until retry
  // verifies/fsyncs it; retry must not invoke engine export a second time.
  const delta = await launch();
  await waitSettled(delta);
  const deltaRunFile = runFileFor(delta);
  const deltaRecord = JSON.parse(await fsp.readFile(deltaRunFile, 'utf8'));
  const deltaSessionId = deltaRecord.session?.sessionId;
  assert(deltaSessionId, 'delta must retain session identity for interruption test');
  const deltaArchiveDir = path.join(path.dirname(path.dirname(deltaRunFile)), 'delegation-artifacts', delta);
  const deltaArchivePath = path.join(deltaArchiveDir, 'session-export.json');
  const deltaConfirmationPath = path.join(deltaArchiveDir, 'archive-confirmed.json');
  const deltaExportCallsBefore = (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x === `export:${deltaSessionId}`).length;
  const nativeLink = fs.linkSync;
  let interruptedConfirmation = false;
  fs.linkSync = function (source, destination, ...rest) {
    if (!interruptedConfirmation && path.resolve(destination) === path.resolve(deltaConfirmationPath) && fs.existsSync(deltaArchivePath)) {
      interruptedConfirmation = true;
      throw new Error('fixture interruption after archive publication');
    }
    return nativeLink.call(fs, source, destination, ...rest);
  };
  let deltaInterrupted;
  try { deltaInterrupted = await call('delegation_closeout', { workspace_id: workspaceId, run_id: delta, retire: true }); }
  finally { fs.linkSync = nativeLink; }
  assert(interruptedConfirmation && deltaInterrupted.isError && deltaInterrupted.structuredContent.exported === false &&
    deltaInterrupted.structuredContent.reason === 'persist-or-verify-failed' && fs.existsSync(deltaArchivePath) &&
    !fs.existsSync(deltaConfirmationPath),
    `archive must remain honest when confirmation persistence is interrupted: ${JSON.stringify(deltaInterrupted.structuredContent)}`);
  const deltaRetry = await call('delegation_closeout', { workspace_id: workspaceId, run_id: delta, retire: true });
  assert(!deltaRetry.isError && deltaRetry.structuredContent.exported === true,
    `retry must revalidate the complete archive and finish confirmation: ${JSON.stringify(deltaRetry.structuredContent)}`);
  const deltaExportCallsAfter = (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x === `export:${deltaSessionId}`).length;
  assert(deltaExportCallsAfter === deltaExportCallsBefore + 1,
    'confirmation retry must not invoke the engine export a second time');
  const deltaAfterRead = await call('delegation_read_result', { workspace_id: workspaceId, run_id: delta });
  assert(deltaAfterRead.structuredContent.closeout?.exported === true,
    'separate archive confirmation must become visible on the ordinary read route after retry');
  assertBlocked(deltaRetry, 'interrupted-confirmation retry');
  console.log('P3a supporting fault injection: archive-present/unconfirmed remained false until public retry revalidated it.');

  // P3a1: a corrupt confirmation cannot make a valid export readable or
  // allow a retry to overwrite uncertain evidence.
  const mu = await launch();
  await waitSettled(mu);
  const muRunFile = runFileFor(mu);
  const muRecord = JSON.parse(await fsp.readFile(muRunFile, 'utf8'));
  const muArchiveDir = path.join(path.dirname(path.dirname(muRunFile)), 'delegation-artifacts', mu);
  const muExportPath = path.join(muArchiveDir, 'session-export.json');
  const muConfirmationPath = path.join(muArchiveDir, 'archive-confirmed.json');
  const muClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: mu, retire: true });
  assert(!muClose.isError && muClose.structuredContent.exported === true, 'mu setup must first archive normally');
  const muExportBefore = await fsp.readFile(muExportPath, 'utf8');
  const corruptConfirmation = '{"corrupt":"fixture-owned confirmation"}\\n';
  await fsp.writeFile(muConfirmationPath, corruptConfirmation);
  const muRead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: mu });
  const muRepeat = await call('delegation_closeout', { workspace_id: workspaceId, run_id: mu, retire: true });
  assert(muRead.isError && muRead.structuredContent.error === 'closeout_export_unavailable' &&
    muRepeat.isError && muRepeat.structuredContent.exported === false &&
    muRepeat.structuredContent.reason === 'closeout-artifact-unverified' &&
    (await fsp.readFile(muConfirmationPath, 'utf8')) === corruptConfirmation &&
    (await fsp.readFile(muExportPath, 'utf8')) === muExportBefore && fs.existsSync(muRecord.workdir),
    `corrupt confirmation must remain unreadable and immutable without cleanup: ${JSON.stringify(muRepeat.structuredContent)}`);

  // P3a2: fail the second public-path confirmation read, which is the final
  // verification after export and confirmation publication. The call must
  // return unexported; a fresh ordinary read can verify the restored bytes.
  const lambda = await launch();
  await waitSettled(lambda);
  const lambdaRunFile = runFileFor(lambda);
  const lambdaRecord = JSON.parse(await fsp.readFile(lambdaRunFile, 'utf8'));
  const lambdaArchiveDir = path.join(path.dirname(path.dirname(lambdaRunFile)), 'delegation-artifacts', lambda);
  const lambdaExportPath = path.join(lambdaArchiveDir, 'session-export.json');
  const lambdaConfirmationPath = path.join(lambdaArchiveDir, 'archive-confirmed.json');
  const nativeOpen = fs.openSync;
  let lambdaConfirmationReads = 0;
  fs.openSync = function (file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(lambdaConfirmationPath) && ++lambdaConfirmationReads === 2) {
      throw Object.assign(new Error('fixture final confirmation read failure'), { code: 'EIO' });
    }
    return nativeOpen.call(fs, file, ...rest);
  };
  let lambdaClose;
  try { lambdaClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: lambda, retire: true }); }
  finally { fs.openSync = nativeOpen; }
  assert(lambdaConfirmationReads === 2 && lambdaClose.isError && lambdaClose.structuredContent.exported === false &&
    lambdaClose.structuredContent.reason === 'closeout-artifact-unverified' &&
    fs.existsSync(lambdaExportPath) && fs.existsSync(lambdaConfirmationPath) && fs.existsSync(lambdaRecord.workdir),
    `failed final verification must not claim archival or clean up: ${JSON.stringify(lambdaClose.structuredContent)}`);
  const lambdaRead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: lambda });
  assert(!lambdaRead.isError && lambdaRead.structuredContent.text === JSON.parse(await fsp.readFile(lambdaExportPath, 'utf8')).output,
    'restored final verification must expose the exact persisted export on the ordinary read route');

  // P3a3: corrupt intent presence remains a monotonic follow-up seal while
  // archive verification fails closed and preserves the export/workdir.
  const nu = await launch();
  await waitSettled(nu);
  const nuRunFile = runFileFor(nu);
  const nuRecord = JSON.parse(await fsp.readFile(nuRunFile, 'utf8'));
  const nuArchiveDir = path.join(path.dirname(path.dirname(nuRunFile)), 'delegation-artifacts', nu);
  const nuExportPath = path.join(nuArchiveDir, 'session-export.json');
  const nuIntentPath = path.join(nuArchiveDir, 'retirement.json');
  const nuClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: nu, retire: true });
  assert(!nuClose.isError && nuClose.structuredContent.exported === true, 'nu setup must first archive normally');
  const nuExportBefore = await fsp.readFile(nuExportPath, 'utf8');
  const corruptIntent = '{"corrupt":"fixture-owned intent"}\\n';
  await fsp.writeFile(nuIntentPath, corruptIntent);
  const nuRead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: nu });
  const nuFollowup = await call('delegation_followup', { workspace_id: workspaceId, run_id: nu,
    checkpoint: { id: 'nu-followup', run_id: nu, seq: 1, payload: {}, input_request_id: 'missing' } });
  const nuRepeat = await call('delegation_closeout', { workspace_id: workspaceId, run_id: nu, retire: true });
  assert(nuRead.isError && nuRead.structuredContent.error === 'closeout_export_unavailable' &&
    nuFollowup.isError && nuFollowup.structuredContent.error === 'run_retired' &&
    nuRepeat.isError && ['closeout-artifact-unverified', 'persist-or-verify-failed'].includes(nuRepeat.structuredContent.reason) &&
    (await fsp.readFile(nuIntentPath, 'utf8')) === corruptIntent &&
    (await fsp.readFile(nuExportPath, 'utf8')) === nuExportBefore && fs.existsSync(nuRecord.workdir),
    `corrupt intent must preserve the retirement seal and all uncertain resources: ${JSON.stringify(nuRepeat.structuredContent)}`);

  // P3a4: replace a valid same-run export after its confirmation has been
  // read but before the public route obtains the bytes it will page. It may
  // return only the previously confirmed snapshot, or fail closed.
  const omicron = await launch();
  await waitSettled(omicron);
  const omicronRunFile = runFileFor(omicron);
  const omicronRecord = JSON.parse(await fsp.readFile(omicronRunFile, 'utf8'));
  const omicronArchiveDir = path.join(path.dirname(path.dirname(omicronRunFile)), 'delegation-artifacts', omicron);
  const omicronExportPath = path.join(omicronArchiveDir, 'session-export.json');
  const omicronConfirmationPath = path.join(omicronArchiveDir, 'archive-confirmed.json');
  const omicronClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: omicron, retire: true });
  assert(!omicronClose.isError && omicronClose.structuredContent.exported === true, 'omicron setup must first archive normally');
  const omicronArchive = JSON.parse(await fsp.readFile(omicronExportPath, 'utf8'));
  const omicronConfirmedReceipt = await fsp.readFile(omicronConfirmationPath, 'utf8');
  const omicronConfirmedOutput = omicronArchive.output;
  const omicronChangedOutput = omicronConfirmedOutput.replace('retained', 'altered!');
  assert(omicronChangedOutput !== omicronConfirmedOutput && omicronChangedOutput.length === omicronConfirmedOutput.length,
    'interleaving replacement must alter bytes without changing length or JSON validity');
  const omicronReplacement = `${JSON.stringify({ ...omicronArchive, output: omicronChangedOutput })}\n`;
  const nativeOpenForRace = fs.openSync;
  const nativeWriteForRace = fs.writeFileSync;
  let omicronSwapped = false;
  fs.openSync = function (file, ...rest) {
    if (!omicronSwapped && path.resolve(String(file)) === path.resolve(omicronConfirmationPath)) {
      omicronSwapped = true;
      nativeWriteForRace.call(fs, omicronExportPath, omicronReplacement, 'utf8');
    }
    return nativeOpenForRace.call(fs, file, ...rest);
  };
  let omicronRead;
  try { omicronRead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: omicron }); }
  finally { fs.openSync = nativeOpenForRace; }
  assert(omicronSwapped && (omicronRead.isError || omicronRead.structuredContent.text === omicronConfirmedOutput) &&
    JSON.parse(await fsp.readFile(omicronExportPath, 'utf8')).output === omicronChangedOutput &&
    (await fsp.readFile(omicronConfirmationPath, 'utf8')) === omicronConfirmedReceipt && fs.existsSync(omicronRecord.workdir),
    `public read must not return same-binding export bytes that its confirmation did not cover: ${JSON.stringify(omicronRead.structuredContent)}`);
  console.log(`P3a4 supporting fault injection: trigger=${omicronSwapped}; disk export=replaced; confirmation=unchanged; route=${omicronRead.isError ? 'refused' : 'confirmed snapshot'}.`);
  console.log('P3a1-P3a4 supporting fault injections: corruption, final-verification failure and same-binding export replacement stayed fail-closed.');

  // P3b: stale/reused PID identity is not treated as ownership of another
  // live task-owned process, and closeout never signals that process.
  const epsilon = await launch();
  await waitSettled(epsilon);
  const epsilonRunFile = runFileFor(epsilon);
  const epsilonRecord = JSON.parse(await fsp.readFile(epsilonRunFile, 'utf8'));
  const originalAttempt = { ...epsilonRecord.attempts.at(-1) };
  const reused = await makeOwnedSleeper();
  epsilonRecord.attempts.at(-1).pid = reused.pid;
  epsilonRecord.attempts.at(-1).processStartTime = reused.start === '0' ? '1' : '0';
  await fsp.writeFile(epsilonRunFile, `${JSON.stringify(epsilonRecord, null, 2)}\n`);
  const epsilonClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: epsilon, retire: true });
  assert(!epsilonClose.isError && epsilonClose.structuredContent.exported === true && readStart(reused.pid) === reused.start,
    `stale PID baseline must not signal a reused unrelated process: ${JSON.stringify(epsilonClose.structuredContent)}`);
  assertBlocked(epsilonClose, 'stale/reused PID closeout');
  console.log('P3b supporting target-owned process: stale/reused PID baseline survived closeout unchanged.');

  // P3c: inaccessible proc identity is uncertainty, so closeout fails before
  // intent/export and remains retryable when the original identity is restored.
  const zeta = await launch();
  await waitSettled(zeta);
  const zetaRunFile = runFileFor(zeta);
  const zetaRecord = JSON.parse(await fsp.readFile(zetaRunFile, 'utf8'));
  const zetaAttempt = zetaRecord.attempts.at(-1);
  const zetaOriginalAttempt = { ...zetaAttempt };
  const zetaPid = 2147480000 + (requestN % 50000);
  zetaAttempt.pid = zetaPid;
  zetaAttempt.processStartTime = 'unavailable-baseline';
  await fsp.writeFile(zetaRunFile, `${JSON.stringify(zetaRecord, null, 2)}\n`);
  const zetaArchiveDir = path.join(path.dirname(path.dirname(zetaRunFile)), 'delegation-artifacts', zeta);
  const exportsBeforeProcFault = (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('export:')).length;
  const nativeRead = fs.readFileSync;
  const nativeLstat = fs.lstatSync;
  const denyProc = (p) => path.resolve(String(p)) === `/proc/${zetaPid}/stat` || path.resolve(String(p)) === `/proc/${zetaPid}`;
  fs.readFileSync = function (p, ...rest) {
    if (denyProc(p)) throw Object.assign(new Error('fixture proc read denied'), { code: 'EACCES' });
    return nativeRead.call(fs, p, ...rest);
  };
  fs.lstatSync = function (p, ...rest) {
    if (denyProc(p)) throw Object.assign(new Error('fixture proc identity denied'), { code: 'EACCES' });
    return nativeLstat.call(fs, p, ...rest);
  };
  let zetaRefused;
  try { zetaRefused = await call('delegation_closeout', { workspace_id: workspaceId, run_id: zeta, retire: true }); }
  finally { fs.readFileSync = nativeRead; fs.lstatSync = nativeLstat; }
  assert(zetaRefused.isError && zetaRefused.structuredContent.error === 'closeout_process_unverified' &&
    !fs.existsSync(path.join(zetaArchiveDir, 'retirement.json')) &&
    (await fsp.readFile(logFile, 'utf8')).split('\n').filter((x) => x.startsWith('export:')).length === exportsBeforeProcFault,
    `unreadable proc evidence must refuse before any retirement effect: ${JSON.stringify(zetaRefused.structuredContent)}`);
  zetaAttempt.pid = zetaOriginalAttempt.pid;
  zetaAttempt.processStartTime = zetaOriginalAttempt.processStartTime;
  await fsp.writeFile(zetaRunFile, `${JSON.stringify(zetaRecord, null, 2)}\n`);
  process.env.CLOSEOUT_EXPORT_MODE = 'large';
  const zetaRetry = await call('delegation_closeout', { workspace_id: workspaceId, run_id: zeta, retire: true });
  assert(!zetaRetry.isError && zetaRetry.structuredContent.exported === true, 'restored owner evidence must allow zeta retry');
  assertBlocked(zetaRetry, 'proc-evidence retry');
  const zetaHead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: zeta, offset: 0, max_chars: 12000 });
  const zetaTail = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: zeta, offset: 12000, max_chars: 12000 });
  assert(!zetaHead.isError && !zetaTail.isError && zetaHead.structuredContent.text.length === 12000 &&
    zetaHead.structuredContent.next_offset === 12000 && zetaTail.structuredContent.next_offset === null &&
    zetaHead.structuredContent.total_chars === zetaHead.structuredContent.text.length + zetaTail.structuredContent.text.length &&
    zetaHead.structuredContent.text.startsWith('{"info":{"id":"') && zetaTail.structuredContent.text.endsWith('"}\n'),
    'large preserved export must page in bounded contiguous exact-output slices');
  delete process.env.CLOSEOUT_EXPORT_MODE;
  console.log('P3c/P3d supporting fault injections: inaccessible proc failed closed; restored run retried and large export paged exactly.');

  // P3e: archive write/fsync failure reports exported=false, leaves intent,
  // and can be retried without overwriting another run or deleting history.
  const eta = await launch();
  await waitSettled(eta);
  const etaRunFile = runFileFor(eta);
  const etaArchiveDir = path.join(path.dirname(path.dirname(etaRunFile)), 'delegation-artifacts', eta);
  const nativeFsync = fs.fsyncSync;
  let archiveFsyncFault = false;
  let closeoutStages = 0;
  fs.fsyncSync = function (fd) {
    let target = '';
    try { target = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* not our descriptor */ }
    if (!archiveFsyncFault && target.startsWith(`${etaArchiveDir}/.closeout-`) && target.endsWith('.tmp') && ++closeoutStages === 2) {
      archiveFsyncFault = true;
      throw new Error('fixture archive fsync failure');
    }
    return nativeFsync.call(fs, fd);
  };
  let etaFailed;
  try { etaFailed = await call('delegation_closeout', { workspace_id: workspaceId, run_id: eta, retire: true }); }
  finally { fs.fsyncSync = nativeFsync; }
  assert(archiveFsyncFault && etaFailed.isError && etaFailed.structuredContent.exported === false &&
    etaFailed.structuredContent.reason === 'persist-or-verify-failed' &&
    fs.existsSync(path.join(etaArchiveDir, 'retirement.json')) && !fs.existsSync(path.join(etaArchiveDir, 'session-export.json')),
    `archive fsync failure must not claim durable export: ${JSON.stringify(etaFailed.structuredContent)}`);
  const etaRetry = await call('delegation_closeout', { workspace_id: workspaceId, run_id: eta, retire: true });
  assert(!etaRetry.isError && etaRetry.structuredContent.exported === true, 'fsync-failed archive must recover on retry');
  assertBlocked(etaRetry, 'archive-fsync retry');
  console.log('P3e supporting fault injection: archive fsync failure stayed unexported until a verified retry.');

  // P3f: foreign/preoccupied archive bytes are immutable and never attributed
  // to the run. Removing this exact task-created fixture permits a later retry.
  const theta = await launch();
  await waitSettled(theta);
  const thetaRunFile = runFileFor(theta);
  const thetaArchiveDir = path.join(path.dirname(path.dirname(thetaRunFile)), 'delegation-artifacts', theta);
  await fsp.mkdir(thetaArchiveDir, { recursive: true });
  const thetaArchivePath = path.join(thetaArchiveDir, 'session-export.json');
  const foreignArchive = '{"foreign":"fixture-owned bytes"}\n';
  await fsp.writeFile(thetaArchivePath, foreignArchive, { flag: 'wx' });
  const thetaRefused = await call('delegation_closeout', { workspace_id: workspaceId, run_id: theta, retire: true });
  assert(thetaRefused.isError && thetaRefused.structuredContent.exported === false &&
    thetaRefused.structuredContent.reason === 'closeout-artifact-unverified' &&
    (await fsp.readFile(thetaArchivePath, 'utf8')) === foreignArchive,
    `preoccupied archive must remain foreign and closeout incomplete: ${JSON.stringify(thetaRefused.structuredContent)}`);
  await fsp.unlink(thetaArchivePath); // exact file created above in this run-owned temporary root
  const thetaRetry = await call('delegation_closeout', { workspace_id: workspaceId, run_id: theta, retire: true });
  assert(!thetaRetry.isError && thetaRetry.structuredContent.exported === true,
    `retry after removing the exact test-owned conflict must succeed: ${JSON.stringify(thetaRetry.structuredContent)}`);
  assertBlocked(thetaRetry, 'preoccupied-archive retry');
  console.log('P3f supporting fixture: preoccupied export remained byte-identical and unattributed; clean retry succeeded.');

  // P4: a real timeout is still terminal only after the owned attempt settles;
  // the closeout then archives its known session while leaving its directory.
  await fsp.writeFile(modeFile, 'wait\n');
  const timed = await launch('shared-closeout', 1000);
  const timedRead = await waitSettled(timed, 160);
  activeFixtureRunIds.delete(timed);
  await waitForProcessGone(runProcessIdentities.get(timed), 'timed-out worker');
  assert(timedRead.structuredContent.state === 'timed_out',
    `actual bounded launch timeout must be visible as timed_out: ${JSON.stringify(timedRead.structuredContent)}`);
  const timedRecord = JSON.parse(await fsp.readFile(runFileFor(timed), 'utf8'));
  assert(timedRecord.attempts.at(-1)?.finishedAt && timedRecord.session?.sessionId,
    `timeout must retain actual finished attempt and session identity: ${JSON.stringify(timedRecord.attempts.at(-1))}`);
  await fsp.writeFile(modeFile, 'instant\n');
  const timedClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: timed, retire: true });
  assert(!timedClose.isError && timedClose.structuredContent.exported === true && timedClose.structuredContent.reason === 'archived-release-blocked',
    `settled timeout may preserve its export but never release workdir: ${JSON.stringify(timedClose.structuredContent)}`);
  const timedRepeat = await call('delegation_closeout', { workspace_id: workspaceId, run_id: timed, retire: true });
  assert(!timedRepeat.isError && timedRepeat.structuredContent.exported === true && timedRepeat.structuredContent.session_deleted === false,
    `timed-out closeout repeat must remain idempotent without session deletion: ${JSON.stringify(timedRepeat.structuredContent)}`);
  assertBlocked(timedClose, 'timed-out closeout');
  assertBlocked(timedRepeat, 'repeated timed-out closeout');
  assert(fs.existsSync(timedRecord.workdir), 'timed-out closeout must preserve the workdir');
  console.log('P4 public MCP: timed_out came from the bounded worker route; its verified export persisted with release blocked.');

  // P5: automatic bounded run retention may prune old terminal runs but must
  // not discard an explicitly retired run or its central archive.
  await fsp.writeFile(modeFile, 'instant\n');
  const xi = await launch();
  await waitSettled(xi);
  const xiRunFile = runFileFor(xi);
  const xiRecord = JSON.parse(await fsp.readFile(xiRunFile, 'utf8'));
  const xiArchiveDir = path.join(path.dirname(path.dirname(xiRunFile)), 'delegation-artifacts', xi);
  const xiClose = await call('delegation_closeout', { workspace_id: workspaceId, run_id: xi, retire: true });
  assert(!xiClose.isError && xiClose.structuredContent.exported === true, 'xi setup must first archive normally');
  for (let i = 0; i < 36; i += 1) {
    const churn = await launch(`retention-churn-${i}`);
    const settled = await waitSettled(churn);
    assert(settled.structuredContent.state === 'completed', `retention churn ${i} must settle normally`);
  }
  assert(fs.existsSync(xiRunFile) && fs.existsSync(path.join(xiArchiveDir, 'session-export.json')) &&
    fs.existsSync(path.join(xiArchiveDir, 'archive-confirmed.json')) && fs.existsSync(xiRecord.workdir),
    'automatic retention must preserve the retired run, its verified archive and its workdir');
  const xiRead = await call('delegation_read_closeout', { workspace_id: workspaceId, run_id: xi });
  assert(!xiRead.isError && xiRead.structuredContent.text === JSON.parse(await fsp.readFile(path.join(xiArchiveDir, 'session-export.json'), 'utf8')).output,
    'retired archive must remain readable through MCP after retention pressure');
  console.log('P5 public MCP: retention churn pruned without discarding an explicitly retired run or archive.');

  console.log('TARGET_EVIDENCE: actual in-memory MCP server handlers, their persisted run/intent/archive files, and isolated target workdirs.');
  console.log('SUPPORTING_ORACLE: task-owned fake OpenCode executable supplied deterministic session JSON, active process, and export failure/identity variants; no shared OpenCode runtime used.');
  console.log('session-helper-retirement-smoke: PASS (workdir release intentionally remains blocked by engine/project ownership boundary).');
} catch (error) {
  primaryError = error;
} finally {
  // Retry cancellation only for exact task-created run identities. Never
  // enumerate or signal ambient processes/services.
  try {
    if (client && workspaceId) {
      for (const runId of activeFixtureRunIds) {
        try {
          const identity = await trackRunProcess(runId, true);
          if (!identity) throw new Error(`owned fixture run ${runId} has no verified PID/starttime for cleanup`);
          const cancelled = await client.callTool({ name: 'delegation_cancel', arguments: { workspace_id: workspaceId, run_id: runId } });
          if (cancelled.isError) throw new Error(`owned fixture run ${runId} cancellation failed: ${JSON.stringify(cancelled.structuredContent)}`);
          await waitForProcessGone(identity, `finally-cancelled run ${runId}`);
        } catch (error) { primaryError ??= error; }
      }
    }
  } catch (error) { primaryError ??= error; }
  try { await cleanup(); } catch (error) { primaryError ??= error; }
}
if (primaryError) throw primaryError;

function betaRecordWorkdir(read, workspaceRoot) {
  const value = String(read.structuredContent.workdir ?? '');
  return value && path.resolve(value).startsWith(path.resolve(workspaceRoot) + path.sep) ? value : path.join(workspaceRoot, 'shared-closeout');
}
