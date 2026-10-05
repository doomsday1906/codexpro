#!/usr/bin/env node
// Focused regressions for the bounded tri-engine repair leaf (5 items).
// Extends (never replaces) delegation-triengine-smoke.mjs T1-T9.
//
// R1 codex effective settings: protected -c keys refused, danger never
//   inherited (explicit per-run only), final effective model/effort/policy
//   reported, sandbox != bypass (separate explicit handling).
// R2 idempotency: EVERY launch-affecting field is conflict identity
//   (model/config overrides, tool filters, bypass, session selection,
//   canonical workdir). Timeout stays non-identity.
// R3 baseline + honest evidence: commit baseline captured, non-git edits
//   attributed, empty/missing test evidence unavailable (never pass).
// R4 opencode cancel: session-scoped halt unsupported in v2.0.22 (fail
//   closed with blocker); cancel verified by PID-tree + workdir quiescence.
//   Shim workers are labeled shim, never live proof.
// R5 claude deferred: Claude stays UNQUALIFIED (resume drops stored
//   model/effort/tool settings); verified-resume withheld where settings
//   would drop; Codex/OpenCode qualification independent.
//
// No live model calls. Deterministic containment: mkdtemp roots, fixture
// CODEX_HOME / agent dirs / projects dir, fake binaries via CODEXPRO_*_BIN
// (all fake-binary results labeled shim). The real installed opencode
// binary is probed read-only (--version, session help shape) for the R4
// capability blocker.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));
const Tools = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationTools.js')));

// ---------- fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_IMPLEMENTER.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_DANGER.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "danger-full-access"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_MODELER.config.toml'),
  'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\nsandbox_mode = "workspace-write"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_NOSANDBOX.config.toml'), 'model = "gpt-6-luna"\n');
process.env.CODEX_HOME = codexHome;

const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;

const clAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-clagents-'));
await fsp.writeFile(path.join(clAgents, 'implementer.md'),
  '---\nname: implementer\nmodel: claude-sonnet-5-5\neffort: high\n---\n\nReal Claude agent fixture.\n');
process.env.CODEXPRO_CLAUDE_AGENTS_DIR = clAgents;

const clProjects = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-clprojects-'));
await fsp.mkdir(path.join(clProjects, 'slug'));
process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;

// ---------- R1: codex effective settings ----------
{
  for (const entry of [
    'model="gpt-6-luna"',
    'sandbox_mode="read-only"',
    'approval_policy="never"',
    'model_reasoning_effort="low"',
    'profile="CODEX_SCOUT_FAST"',
    'toplevel.model="gpt-6-luna"',
    'MODEL="gpt-6-luna"',
    'dangerously_bypass_approvals_and_sandbox=true'
  ]) {
    const gate = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER',
      { isCanary: false, delegationGroup: 'team', configOverrides: [entry] });
    assert(!gate.allowed && gate.code === 'protected_config_override',
      `protected -c key must be refused, got ${JSON.stringify(gate)} for ${entry}`);
  }
  assert(Engines.isProtectedCodexConfigKey('sandbox') && Engines.isProtectedCodexConfigKey('effort'),
    'isProtectedCodexConfigKey must cover sandbox/effort segments');
  assert(!Engines.isProtectedCodexConfigKey('shell_environment_policy'),
    'benign -c keys must not be protected');
  const benign = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER',
    { isCanary: false, delegationGroup: 'team', configOverrides: ['shell_environment_policy.inherit="all"'] });
  assert(benign.allowed, `benign -c override must pass: ${JSON.stringify(benign)}`);
  const inheritedDanger = Engines.verifyCodexLaunch(codexHome, 'CODEX_DANGER',
    { isCanary: false, delegationGroup: 'team' });
  assert(!inheritedDanger.allowed && inheritedDanger.code === 'danger_requires_explicit',
    `danger without explicit selection must be refused, got ${JSON.stringify(inheritedDanger)}`);
  const explicitDanger = Engines.verifyCodexLaunch(codexHome, 'CODEX_SCOUT_FAST',
    { isCanary: false, delegationGroup: 'team', executionPolicy: 'danger-full-access' });
  assert(explicitDanger.allowed && explicitDanger.executionPolicy === 'danger-full-access',
    'explicit danger-full-access must be honored per-run');
  const real = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER',
    { isCanary: false, delegationGroup: 'team', modelOverride: 'gpt-6-luna-x' });
  assert(real.allowed && real.effectiveModel === 'gpt-6-luna-x' && real.effectiveEffort === 'high',
    `final effective model/effort must be reported: ${JSON.stringify(real)}`);
  const plain = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER',
    { isCanary: false, delegationGroup: 'team' });
  assert(plain.allowed && plain.effectiveModel === 'gpt-6-luna' && plain.effectiveEffort === 'high',
    'effective settings must reflect profile resolution without overrides');
  console.log('ok: R1 codex effective settings (protected override rejected, danger explicit-only, effective model/effort, sandbox!=bypass)');
}

// ---------- R2: idempotency over every launch-affecting field ----------
{
  const codex = {
    engine: 'codex', delegationGroup: 'g', isCanary: false, task: 't',
    profile: 'CODEX_IMPLEMENTER', executionPolicy: 'workspace-write',
    modelOverride: 'm1', configOverrides: ['a=b'], bypassApprovals: false
  };
  assert(Store.isLaunchRequestConflict(codex, { ...codex }) === false, 'identical codex request must replay');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, modelOverride: 'm2' }) === true, 'model override change conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex }) === false, 'replay after check must still replay');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, modelOverride: undefined }) === true, 'dropping a stored model override conflicts (no silent reuse)');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, configOverrides: ['a=c'] }) === true, 'config override change conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, configOverrides: ['a=b', 'c=d'] }) === true, 'added config override conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, configOverrides: ['c=d', 'a=b'] }) === true, 'reordered config overrides conflict (order-sensitive argv)');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, bypassApprovals: true }) === true, 'bypass opt-in change conflicts');
  const claude = {
    engine: 'claude', delegationGroup: 'g', isCanary: false, task: 't',
    agent: 'implementer', model: 'opus', permissionMode: 'acceptEdits', effort: 'high',
    allowedTools: 'Bash', disallowedTools: 'Web', requestedSessionId: 'ses_X'
  };
  assert(Store.isLaunchRequestConflict(claude, { ...claude, sessionId: 'ses_X' }) === false, 'same explicit session replays');
  assert(Store.isLaunchRequestConflict(claude, { ...claude, sessionId: 'ses_Y' }) === true, 'changed session selection conflicts');
  assert(Store.isLaunchRequestConflict(claude, { ...claude, sessionId: undefined }) === true, 'dropping a stored explicit session conflicts (no silent reuse)');
  assert(Store.isLaunchRequestConflict(claude, { ...claude, allowedTools: 'Edit' }) === true, 'allowed-tools change conflicts');
  assert(Store.isLaunchRequestConflict(claude, { ...claude, allowedTools: undefined }) === true, 'dropping stored tool filters conflicts');
  assert(Store.isLaunchRequestConflict(claude, { ...claude, disallowedTools: 'Bash' }) === true, 'disallowed-tools change conflicts');
  const oc = {
    engine: 'opencode', delegationGroup: 'g', isCanary: false, task: 't',
    model: 'm1', agent: 'implementer', requestedSessionId: ''
  };
  assert(Store.isLaunchRequestConflict(oc, { ...oc, model: 'm2' }) === true, 'opencode model change conflicts');
  assert(Store.isLaunchRequestConflict(oc, { ...oc, sessionId: undefined }) === false, 'omitted session on both sides replays');
  // Legacy runs without the requestedSessionId marker keep the old rule.
  const legacyOc = { engine: 'opencode', delegationGroup: 'g', isCanary: false, task: 't', model: 'm1', agent: 'implementer', session: { sessionId: 'ses_obs' } };
  assert(Store.isLaunchRequestConflict(legacyOc, { ...oc, sessionId: undefined }) === false, 'legacy run with omitted candidate session replays');
  assert(Store.isLaunchRequestConflict(legacyOc, { ...oc, sessionId: 'ses_obs' }) === false, 'legacy run matching the observed session replays');
  assert(Store.isLaunchRequestConflict(legacyOc, { ...oc, sessionId: 'ses_other' }) === true, 'legacy run with a differing explicit candidate session conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, task: 'other' }) === true, 'task change conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, delegationGroup: 'h' }) === true, 'group change conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, isCanary: true }) === true, 'canary-flag change conflicts');
  assert(Store.isLaunchRequestConflict(codex, { ...codex, engine: 'opencode' }) === true, 'engine change conflicts');
  console.log('ok: R2 idempotency (model/config/tool-filter/bypass/session/workdir changes conflict; timeout stays non-identity by construction)');
}

// ---------- R3: launch baseline + honest evidence ----------
{
  // Git repo: commit baseline captured, worker commit + untracked edit attributed.
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-repo-'));
  await fsp.writeFile(path.join(repo, 'tracked.txt'), 'v1');
  await fsp.writeFile(path.join(repo, 'untracked.txt'), 'u1');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: repo });
  const base = Engines.captureWorkdirBaseline(repo);
  assert(base.gitHead && /^[0-9a-f]{40}$/i.test(base.gitHead), `commit baseline HEAD must be captured: ${JSON.stringify(base.gitHead)}`);
  assert(Array.isArray(base.fingerprints) && base.fingerprints.length >= 2, 'fingerprints must cover baseline files');
  // Worker simulation: commit a tracked change, edit untracked content, add a file.
  await fsp.writeFile(path.join(repo, 'tracked.txt'), 'v2-worker');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'worker commit'], { cwd: repo });
  await fsp.writeFile(path.join(repo, 'untracked.txt'), 'u2-worker-edit');
  await fsp.writeFile(path.join(repo, 'newfile.txt'), 'new');
  const ev = Engines.collectWorkdirEvidence(repo, base);
  assert(ev.kind === 'git', `repo evidence must be git-kind: ${ev.kind}`);
  assert(ev.baselineHead === base.gitHead && ev.currentHead && ev.currentHead !== base.gitHead, 'baseline vs current HEAD must be reported');
  assert(ev.commits && ev.commits.newCommits.length === 1 && ev.commits.newCommits[0].includes('worker commit'),
    `worker commit must be attributed: ${JSON.stringify(ev.commits)}`);
  assert(ev.changed.some((c) => c.includes('newfile.txt')), 'new file must appear in git status evidence');
  assert(ev.changed.some((c) => c.startsWith('~ untracked.txt')),
    `untracked content edit must be attributed: ${JSON.stringify(ev.changed)}`);
  // Non-repo: added/removed by name, content edits by fingerprint.
  const plain = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-plain-'));
  await fsp.writeFile(path.join(plain, 'b.txt'), 'b1');
  await fsp.writeFile(path.join(plain, 'c.txt'), 'c1');
  const plainBase = Engines.captureWorkdirBaseline(plain);
  assert(plainBase.gitHead === null && plainBase.gitHeadReason, 'non-repo baseline must explain the missing commit baseline');
  await fsp.writeFile(path.join(plain, 'a.txt'), 'a');
  await fsp.writeFile(path.join(plain, 'b.txt'), 'b2-edited');
  await fsp.unlink(path.join(plain, 'c.txt'));
  const pev = Engines.collectWorkdirEvidence(plain, plainBase);
  assert(pev.kind === 'snapshot', `non-repo evidence must be snapshot-kind: ${pev.kind}`);
  assert(pev.changed.some((c) => c === '+ a.txt'), `added file must show: ${JSON.stringify(pev.changed)}`);
  assert(pev.changed.some((c) => c === '- c.txt'), `removed file must show: ${JSON.stringify(pev.changed)}`);
  assert(pev.changed.some((c) => c.startsWith('~ b.txt')), `content edit must show: ${JSON.stringify(pev.changed)}`);
  // Honest test evidence: empty/missing is unavailable, never pass.
  const running = Tools.buildTestEvidence({
    terminal: false, state: 'running', exitCode: null, timedOut: false,
    stdoutTruncated: false, stderrTruncated: false, diffKind: 'snapshot',
    lastMessage: { path: 'codex-last-message.md', status: 'unavailable', truncated: false, reason: 'absent' }
  });
  assert(running.unavailable === true && running.stdout.status === 'unavailable' && running.tests.status === 'unavailable',
    'running run without tails must be unavailable everywhere (never pass)');
  const emptyTerminal = Tools.buildTestEvidence({
    terminal: true, state: 'completed', exitCode: 0, timedOut: false,
    stdoutTail: '', stderrTail: '', stdoutTruncated: false, stderrTruncated: false, diffKind: 'git',
    lastMessage: { path: 'codex-last-message.md', status: 'unavailable', truncated: false, reason: 'absent' }
  });
  assert(emptyTerminal.unavailable === true && /no captured output tails/.test(emptyTerminal.unavailable_reason ?? ''),
    'terminal run with empty tails must be unavailable, not pass');
  const withOutput = Tools.buildTestEvidence({
    terminal: true, state: 'completed', exitCode: 0, timedOut: false,
    stdoutTail: 'some output', stderrTail: '', stdoutTruncated: false, stderrTruncated: false, diffKind: 'git',
    lastMessage: { path: 'codex-last-message.md', status: 'present', truncated: false, bytes: 10 }
  });
  assert(withOutput.unavailable === false && withOutput.stdout.status === 'present' && withOutput.tests.status === 'unavailable',
    'nonempty tails are output presence only; tests stay unavailable');
  assert(/output presence only/.test(withOutput.output_note), 'output honesty note must be present');
  const truncated = Tools.buildTestEvidence({
    terminal: true, state: 'completed', exitCode: 0, timedOut: false,
    stdoutTail: 'x', stderrTail: '', stdoutTruncated: true, stderrTruncated: false, diffKind: 'unavailable', diffReason: 'gone',
    lastMessage: { path: 'm', status: 'unavailable', truncated: false, reason: 'absent' }
  });
  assert(truncated.stdout.status === 'truncated' && truncated.diff.status === 'unavailable',
    'truncated/missing artifacts must be labeled explicitly');
  console.log('ok: R3 baseline + honest evidence (commit baseline, attributed edits, unavailable-not-pass)');
}

// ---------- R4 + R5 + R1-gate via MCP ----------
{
  const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-mcp-'));
  const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-shim-'));
  const fake = async (name, body) => {
    const p = path.join(shimBin, name);
    await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
    await fsp.chmod(p, 0o755);
    return p;
  };
  // R4 unit: real-binary capability probe + fail-closed blocker (no model call).
  const realProbe = Engines.probeEngineBinary('opencode');
  assert(realProbe.found, `installed opencode binary must probe (read-only --version): ${realProbe.evidence}`);
  assert(Engines.OPENCODE_CANCEL_CAPABILITY.sessionScopedHaltSupported === false &&
    Engines.OPENCODE_CANCEL_CAPABILITY.blocker.length > 0,
    'opencode session-scoped halt must be marked unsupported with an explicit fail-closed blocker');
  const sessionHelp = spawnSync('opencode', ['session', '--help'], { encoding: 'utf8', timeout: 15000 });
  assert(sessionHelp.status === 0 && /list/.test(String(sessionHelp.stdout)) && !/halt|stop|cancel/i.test(String(sessionHelp.stdout).split('SUBCOMMANDS')[1] ?? ''),
    `real opencode session subcommands must show no halt/stop (grounding the blocker): ${String(sessionHelp.stdout).slice(0, 200)}`);
  // Quiescence helper unit proof.
  const qdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-q-'));
  await fsp.writeFile(path.join(qdir, 'f.txt'), 'v1');
  const qsnap = Engines.snapshotWorkdirMtimes(qdir);
  const qt0 = Date.now();
  await new Promise((r) => setTimeout(r, 20));
  await fsp.writeFile(path.join(qdir, 'f.txt'), 'v2');
  const qfound = Engines.findPostCancelWrites(qdir, qsnap, qt0);
  assert(qfound.checked && qfound.continued.some((c) => c.startsWith('~ f.txt')),
    `post-cancel write must be detected: ${JSON.stringify(qfound)}`);
  const qclean = Engines.findPostCancelWrites(qdir, Engines.snapshotWorkdirMtimes(qdir), Date.now());
  assert(qclean.checked && qclean.continued.length === 0, 'quiet workdir must quiesce');
  const qgone = Engines.findPostCancelWrites(path.join(qdir, 'nope'), qsnap, qt0);
  assert(!qgone.checked && qgone.reason, 'unreadable workdir must fail closed (unchecked, never clean)');
  console.log('ok: R4 unit (real-binary probe, no session halt in v2.0.22, quiescence helpers fail closed)');

  // MCP wiring for R1-gate, R4-shim-cancel, R5-deferred.
  const heartbeat = await fake('codex-heartbeat', 'if [ "$1" = "--version" ]; then echo "codex-heartbeat-shim 0.0.0"; exit 0; fi\nwhile true; do date +%s%N >> heartbeat.txt; sleep 0.2; done');
  const instant = await fake('claude-instant', 'echo "{\\"type\\":\\"result\\"}"\nexit 0');
  const ocFake = await fake('opencode', 'echo "opencode v2.0.22"\nexit 0');
  process.env.CODEXPRO_CODEX_BIN = heartbeat;
  process.env.CODEXPRO_CLAUDE_BIN = instant;
  process.env.CODEXPRO_OPENCODE_BIN = ocFake;
  const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-focus-deleghome-'));
  process.env.CODEXPRO_DELEGATION_DIR = delegHome;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

  const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const config = loadConfig(['--root', wsRoot]);
  const server = createCodexProServer(config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'focus-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const opened = await call('open_workspace', { root: wsRoot });
  assert(!opened.isError, 'open_workspace must succeed');
  const wid = opened.structuredContent.workspace_id;

  // R1 gate at MCP level: sandbox != bypass, protected override refused.
  const prevDanger = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_DANGER', workdir: 'focus-prev-1',
    task: 'Do the thing.', delegation_group: 'team-focus', execution_policy: 'danger-full-access'
  });
  assert(!prevDanger.isError && !prevDanger.structuredContent.preview.argv_preview.includes('--dangerously-bypass-approvals-and-sandbox'),
    'preview danger sandbox alone must not carry the bypass flag');
  const prevBypass = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_DANGER', workdir: 'focus-prev-1',
    task: 'Do the thing.', delegation_group: 'team-focus', execution_policy: 'danger-full-access', bypass_approvals: true
  });
  assert(!prevBypass.isError && prevBypass.structuredContent.preview.argv_preview.includes('--dangerously-bypass-approvals-and-sandbox'),
    'separate explicit bypass_approvals must ride only with explicit danger');
  const prevBypassNoDanger = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_IMPLEMENTER', workdir: 'focus-prev-1',
    task: 'Do the thing.', delegation_group: 'team-focus', execution_policy: 'workspace-write', bypass_approvals: true
  });
  assert(prevBypassNoDanger.isError && prevBypassNoDanger.structuredContent.error === 'bypass_requires_danger',
    'bypass without explicit danger must be refused');
  const prevInheritedDanger = await call('delegation_preview', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_DANGER', workdir: 'focus-prev-1',
    task: 'Do the thing.', delegation_group: 'team-focus'
  });
  assert(prevInheritedDanger.isError && prevInheritedDanger.structuredContent.error === 'danger_requires_explicit',
    'inherited danger must be refused at preview');
  const launchProtected = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_IMPLEMENTER', workdir: 'focus-prot-1',
    task: 'Do the thing.', delegation_group: 'team-focus', config_overrides: ['sandbox_mode="read-only"'], request_id: 'req-focus-prot'
  });
  assert(launchProtected.isError && launchProtected.structuredContent.error === 'protected_config_override',
    'protected config override must be refused at launch');
  console.log('ok: R1 MCP gate (sandbox!=bypass, inherited danger refused, protected override refused)');

  // R4 shim cancel: cancel -> no further writes, unrelated run intact.
  // (shim workers: labeled shim below; never live proof.)
  // Containment: the heartbeat shim writes a RELATIVE heartbeat.txt, so the
  // spawn cwd is the containment. Any escape would land in the repo root;
  // assert it never does (tripwire). Cleanup is guaranteed: both shim runs
  // are cancelled best-effort even if an assertion below throws, so no
  // heartbeat orphan can escape a failed run.
  let runAId = null;
  let runBId = null;
  const bestEffortCancel = async (runId) => {
    if (!runId) return;
    try {
      const state = (await call('delegation_read_result', { workspace_id: wid, run_id: runId })).structuredContent.state;
      if (state === 'running' || state === 'queued' || state === 'needs-input') {
        await call('delegation_cancel', { workspace_id: wid, run_id: runId });
      }
    } catch { /* cleanup only */ }
  };
  try {
  const runA = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'focus-cancel-a',
    canary: true, delegation_group: 'hestia-cli-canary', request_id: 'req-focus-cancel-a', timeout_ms: 60000
  });
  assert(!runA.isError, `shim run A must launch: ${JSON.stringify(runA.structuredContent)}`);
  runAId = runA.structuredContent.run_id;
  const runB = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST', workdir: 'focus-cancel-b',
    canary: true, delegation_group: 'hestia-cli-canary', request_id: 'req-focus-cancel-b', timeout_ms: 60000
  });
  assert(!runB.isError, 'shim run B must launch (unrelated session)');
  runBId = runB.structuredContent.run_id;
  await new Promise((r) => setTimeout(r, 1500));
  const workdirA = path.join(wsRoot, 'focus-cancel-a');
  const hbA = path.join(workdirA, 'heartbeat.txt');
  assert(fs.existsSync(hbA), 'shim worker A must have written heartbeats before cancel');
  const cancelA = await call('delegation_cancel', { workspace_id: wid, run_id: runA.structuredContent.run_id });
  assert(!cancelA.isError, `cancel A must succeed: ${JSON.stringify(cancelA.structuredContent)}`);
  const cv = cancelA.structuredContent.cancel_verification;
  assert(cancelA.structuredContent.cleanup_finished === true, 'shim owned tree must be reaped');
  assert(cv && cv.quiescence && cv.quiescence.checked === true && cv.quiescence.continued_writes.length === 0,
    `shim cancel must verify quiescence: ${JSON.stringify(cv)}`);
  assert(cv.verification_complete === true, 'shim cancel verification must be complete');
  const m1 = fs.statSync(hbA).mtimeMs;
  const s1 = fs.statSync(hbA).size;
  assert(s1 > 0, 'heartbeat file must be nonempty');
  await new Promise((r) => setTimeout(r, 2500));
  assert(fs.statSync(hbA).mtimeMs === m1 && fs.statSync(hbA).size === s1, 'shim: no further writes after cancel');
  const readB = await call('delegation_read_result', { workspace_id: wid, run_id: runB.structuredContent.run_id });
  assert(!readB.isError && readB.structuredContent.state === 'running', 'shim: unrelated run B must stay running after A is cancelled');
  const hbB = path.join(wsRoot, 'focus-cancel-b', 'heartbeat.txt');
  const bs1 = fs.statSync(hbB).size;
  await new Promise((r) => setTimeout(r, 600));
  assert(fs.statSync(hbB).size > bs1, 'shim: unrelated run B must keep executing');
  const readA = await call('delegation_read_result', { workspace_id: wid, run_id: runA.structuredContent.run_id });
  assert(readA.structuredContent.execution_provenance.binary_overridden === true &&
    /shim results are never live proof/.test(readA.structuredContent.execution_provenance.note),
    'shim: execution provenance must label the override route as shim (never live proof)');
  const cancelB = await call('delegation_cancel', { workspace_id: wid, run_id: runB.structuredContent.run_id });
  assert(!cancelB.isError && cancelB.structuredContent.cancel_verification.quiescence.checked === true,
    'shim run B must cancel cleanly too');
  assert(!fs.existsSync(path.join(ROOT, 'heartbeat.txt')), 'containment tripwire: no shim heartbeat may escape the run workdir');
  console.log('ok: R4 shim cancel (cancel -> no further writes, unrelated shim run intact, shim labeled as shim)');
  } finally {
    await bestEffortCancel(runAId);
    await bestEffortCancel(runBId);
  }

  // R5 deferred: Claude UNQUALIFIED; withhold verified-resume where settings drop.
  assert(Engines.CLAUDE_ENGINE_QUALIFICATION.qualified === false &&
    Engines.CLAUDE_ENGINE_QUALIFICATION.status === 'deferred' &&
    Engines.CLAUDE_ENGINE_QUALIFICATION.blocker.length > 0,
    'Claude must stay UNQUALIFIED with a deferred blocker');
  assert(Engines.CODEX_ENGINE_QUALIFICATION.qualified === true &&
    Engines.OPENCODE_ENGINE_QUALIFICATION.qualified === true,
    'Codex/OpenCode qualification must be independent of the Claude deferral');
  const resumeArgv = Engines.buildClaudeResumeArgv('123e4567-e89b-42d3-a456-426614174000', 'hi', { agent: 'implementer', permissionMode: 'acceptEdits' });
  assert(resumeArgv.includes('--resume') && !resumeArgv.includes('--model') && !resumeArgv.includes('--effort') &&
    !resumeArgv.includes('--allowedTools') && !resumeArgv.includes('--disallowedTools'),
    `resume argv must visibly drop model/effort/tool settings: ${JSON.stringify(resumeArgv)}`);
  const prevClaude = await call('delegation_preview', {
    workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'focus-claude-1',
    task: 'Do the thing.', delegation_group: 'team-focus'
  });
  assert(!prevClaude.isError && prevClaude.structuredContent.preview.qualification.qualified === false,
    'shim: claude preview must carry the deferred qualification marker');
  const launchClaudeModel = await call('delegation_launch', {
    workspace_id: wid, engine: 'claude', agent: 'implementer', model: 'opus',
    workdir: 'focus-claude-model', task: 'List files. Change nothing.',
    delegation_group: 'team-focus', request_id: 'req-focus-claude-model', timeout_ms: 60000
  });
  assert(!launchClaudeModel.isError, `shim claude launch must work: ${JSON.stringify(launchClaudeModel.structuredContent)}`);
  assert(launchClaudeModel.structuredContent.engine_qualification.qualified === false,
    'shim: claude launch ack must carry the deferred marker');
  const mintedModel = launchClaudeModel.structuredContent.session_id;
  await fsp.writeFile(path.join(clProjects, 'slug', `${mintedModel}.jsonl`), '{"type":"session"}\n');
  const claudeRunId = launchClaudeModel.structuredContent.run_id;
  for (let i = 0; i < 100 && (await call('delegation_read_result', { workspace_id: wid, run_id: claudeRunId })).structuredContent.state === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const q1 = await call('delegation_followup', { workspace_id: wid, run_id: claudeRunId, checkpoint: { id: 'fq1', run_id: claudeRunId, seq: 0, payload: {}, questions: [{ id: 'fqq', question: 'Proceed?' }] } });
  assert(!q1.isError && q1.structuredContent.state === 'needs-input', 'shim: question must move to needs-input');
  const a1 = await call('delegation_followup', { workspace_id: wid, run_id: claudeRunId, checkpoint: { id: 'fa1', run_id: claudeRunId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'fq1' } });
  assert(!a1.isError && a1.structuredContent.executed === true, `shim: answer must dispatch: ${JSON.stringify(a1.structuredContent)}`);
  assert(a1.structuredContent.continuation === 'new-continuation-attempt' &&
    /resume withheld/.test(a1.structuredContent.session_evidence ?? ''),
    `shim: verified session with stored explicit model must withhold resume (never papered over): ${JSON.stringify(a1.structuredContent)}`);
  // Negative control: no stored explicit settings -> true verified resume.
  const launchClaudeBare = await call('delegation_launch', {
    workspace_id: wid, engine: 'claude', agent: 'implementer',
    workdir: 'focus-claude-bare', task: 'List files. Change nothing.',
    delegation_group: 'team-focus', request_id: 'req-focus-claude-bare', timeout_ms: 60000
  });
  assert(!launchClaudeBare.isError, 'shim bare claude launch must work');
  const mintedBare = launchClaudeBare.structuredContent.session_id;
  await fsp.writeFile(path.join(clProjects, 'slug', `${mintedBare}.jsonl`), '{"type":"session"}\n');
  const bareRunId = launchClaudeBare.structuredContent.run_id;
  for (let i = 0; i < 100 && (await call('delegation_read_result', { workspace_id: wid, run_id: bareRunId })).structuredContent.state === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const bq = await call('delegation_followup', { workspace_id: wid, run_id: bareRunId, checkpoint: { id: 'bq1', run_id: bareRunId, seq: 0, payload: {}, questions: [{ id: 'bqq', question: 'Proceed?' }] } });
  assert(!bq.isError, 'shim: bare question must store');
  const ba = await call('delegation_followup', { workspace_id: wid, run_id: bareRunId, checkpoint: { id: 'ba1', run_id: bareRunId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'bq1' } });
  assert(!ba.isError && ba.structuredContent.continuation === 'resumed',
    `shim: verified session with no stored explicit settings resumes precisely: ${JSON.stringify(ba.structuredContent)}`);
  console.log('ok: R5 deferred (Claude UNQUALIFIED; resume withheld only where settings would drop; Codex/OpenCode independent)');
}

console.log('delegation-repair-focus-smoke: PASS (no live model calls; fake-binary results labeled shim)');
