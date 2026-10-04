import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addValidatedObservedDescendants,
  addValidatedObservedDescendantsOfKnownProcesses,
  captureProcessIdentity,
  isParentIdentityValidForExpansion,
  parseProcessIdentityTable,
  processIdentityTableInvocation,
  readLinuxProcessStartTime,
  validatedDescendantProcessIds,
  verifyProcessIdentity,
  windowsRootTaskkillDecision
} from './launcher-process-tree.mjs';

function run(args, options = {}) {
  return spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    ...options
  });
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function quoteArg(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function readJson(filePath) {
  return JSON.parse(syncFs.readFileSync(filePath, 'utf8'));
}

// Alive only when the PID exists AND its cmdline still carries our marker
// (guards against PID reuse: a recycled PID shows different cmdline).
function markerProcessAlive(pid, marker) {
  let cmdline = '';
  try {
    cmdline = syncFs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return false;
  }
  return cmdline.includes(marker);
}

async function waitForMarkerGone(pid, marker, timeoutMs = 5000) {
  const started = Date.now();
  for (;;) {
    if (!markerProcessAlive(pid, marker)) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// --- 1. Codex named profile: requested vs configured/inferred, permissions preserved ---
// Uses a hermetic CODEX_HOME fixture so the test never depends on ~/.codex.
{
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-codexhome-'));
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "base-model-xyz"\nmodel_reasoning_effort = "high"\napproval_policy = "never"\n', 'utf8');
  await fs.writeFile(
    path.join(codexHome, 'TESTPROF.config.toml'),
    'model = "profile-model-xyz"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n',
    'utf8'
  );
  const fixtureEnv = { ...process.env, NO_COLOR: '1', CODEX_HOME: codexHome };

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-profile-'));
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Profile plan\n\nNo-op.\n', 'utf8');

  const profileRun = run([
    'execute-handoff', '--root', root,
    '--agent', 'codex', '--profile', 'TESTPROF',
    '--reasoning-effort', 'low', '--dry-run'
  ], { env: fixtureEnv });
  requireSuccess(profileRun, 'profile dry-run');
  for (const expected of ['--profile', 'TESTPROF', 'model_reasoning_effort', 'profile-model-xyz', 'Model (configured)', 'Reasoning (configured)']) {
    if (!profileRun.stdout.includes(expected)) {
      throw new Error(`profile dry-run missing ${expected}\n${profileRun.stdout}`);
    }
  }
  if (profileRun.stdout.includes('workspace-write') || profileRun.stdout.includes('approval_policy')) {
    throw new Error(`profile dry-run forced adapter permissions over the profile\n${profileRun.stdout}`);
  }
  if (profileRun.stdout.includes('(observed)') || profileRun.stdout.includes('_observed')) {
    throw new Error(`profile dry-run presents config as observed\n${profileRun.stdout}`);
  }

  // Backward compat: no profile keeps adapter-forced sandbox + approval.
  const defaultRun = run([
    'execute-handoff', '--root', root,
    '--agent', 'codex', '--model', 'gpt-test', '--dry-run'
  ], { env: fixtureEnv });
  requireSuccess(defaultRun, 'default codex dry-run');
  for (const expected of ['workspace-write', 'approval_policy="never"', '--model']) {
    if (!defaultRun.stdout.includes(expected)) {
      throw new Error(`default codex dry-run changed behavior, missing ${expected}\n${defaultRun.stdout}`);
    }
  }

  // Profiles are codex-only.
  const wrongAgent = run([
    'execute-handoff', '--root', root,
    '--agent', 'opencode', '--profile', 'TESTPROF', '--dry-run'
  ], { env: fixtureEnv });
  if (wrongAgent.status === 0 || !wrongAgent.stderr.includes('only supported with --agent codex')) {
    throw new Error(`non-codex --profile should fail\nstdout:\n${wrongAgent.stdout}\nstderr:\n${wrongAgent.stderr}`);
  }

  // Real run through a fake codex binary: configured/inferred keys must reach
  // every surface (dry-run box, agent-status.md, execution-log.jsonl,
  // handoff-run-state.json) and no _observed key may appear anywhere.
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-fake-codex-prof-'));
  const lastMessageProbe = path.join(root, 'codex-last-message-probe.txt');
  await fs.writeFile(path.join(root, 'fake-codex-prof.mjs'), `
import fs from 'node:fs';
const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output-last-message');
if (outputIndex < 0) throw new Error('missing --output-last-message');
fs.writeFileSync(args[outputIndex + 1], 'fake codex last message\\n');
fs.appendFileSync('app.txt', 'profile adapter executed\\n');
`, 'utf8');
  await fs.writeFile(path.join(fakeBin, 'codex'), `#!/usr/bin/env sh\nexec "${process.execPath}" "${path.join(root, 'fake-codex-prof.mjs')}" "$@"\n`, 'utf8');
  await fs.chmod(path.join(fakeBin, 'codex'), 0o755);
  await fs.writeFile(path.join(root, 'app.txt'), 'base\n', 'utf8');
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', 'app.txt'], { cwd: root, encoding: 'utf8' });
  const profileExecEnv = { ...fixtureEnv, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` };
  requireSuccess(run([
    'execute-handoff', '--root', root,
    '--agent', 'codex', '--profile', 'TESTPROF',
    '--reasoning-effort', 'low', '--yes'
  ], { env: profileExecEnv }), 'profile execute-handoff');
  void lastMessageProbe;
  const statusText = await fs.readFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'utf8');
  const logText = await fs.readFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
  const runState = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  for (const [label, text] of [['agent-status.md', statusText], ['execution-log.jsonl', logText], ['handoff-run-state.json', JSON.stringify(runState)]]) {
    if (text.includes('_observed') || text.includes('(observed)')) {
      throw new Error(`${label} still presents config as observed\n${text.slice(0, 2000)}`);
    }
  }
  if (!statusText.includes('Profile (requested): TESTPROF') || !statusText.includes('Model (configured): profile-model-xyz') || !statusText.includes('Reasoning (configured): low')) {
    throw new Error(`agent-status.md missing requested/configured split\n${statusText}`);
  }
  const logEvent = JSON.parse(logText.trim().split('\n').at(-1));
  if (logEvent.codex_profile_requested !== 'TESTPROF' || logEvent.model_configured !== 'profile-model-xyz' || logEvent.reasoning_effort_configured !== 'low' || logEvent.sandbox_mode_configured !== 'read-only') {
    throw new Error(`execution-log.jsonl missing configured keys\n${logText}`);
  }
  if (runState.codex_profile !== 'TESTPROF' || runState.model_configured !== 'profile-model-xyz' || runState.reasoning_effort_configured !== 'low') {
    throw new Error(`handoff-run-state.json missing requested/configured keys\n${JSON.stringify(runState, null, 2)}`);
  }
  console.log('ok: profile requested/configured + backward compat + codex-only guard');
}

// --- 2. Git evidence failure must fail, never succeed with zero diff ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-gitfail-'));
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Git failure plan\n\nDo nothing.\n', 'utf8');
  // NOTE: deliberately NOT a git repository, so git diff/status evidence fails.
  await fs.writeFile(path.join(root, 'noop-agent.mjs'), `console.log('noop agent ok');\n`, 'utf8');
  const failed = run([
    'execute-handoff', '--root', root,
    '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} noop-agent.mjs --task-file {{plan_file}}`,
    '--yes'
  ]);
  if (failed.status === 0) {
    throw new Error(`git evidence failure exited successfully\nstdout:\n${failed.stdout}\nstderr:\n${failed.stderr}`);
  }
  const state = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  if (state.state !== 'failed' || state.exit_code !== 1 || !state.git_evidence_error || state.git_evidence_incomplete !== true || state.git_evidence_reason !== 'GIT_COMMAND_FAILED') {
    throw new Error(`git failure run state was wrong\n${JSON.stringify(state, null, 2)}`);
  }
  const status = await fs.readFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'utf8');
  if (!status.includes('Git evidence error:') || !status.includes('Exit code: 1')) {
    throw new Error(`git failure status did not record the evidence error\n${status}`);
  }
  console.log('ok: git failure returns failure with git_evidence_error');
}

// --- 3. Timeout kills the full process tree, not just the direct child ---
if (process.platform !== 'win32') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-treekill-'));
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Tree kill plan\n\nSleep too long.\n', 'utf8');
  await fs.writeFile(path.join(root, 'tree-agent.mjs'), `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
// Grandchild in its own session that ignores SIGTERM: only a real tree kill reaps it.
const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);"], {
  detached: true, stdio: 'ignore'
});
grandchild.unref();
fs.writeFileSync('grandchild.pid', String(grandchild.pid));
process.on('SIGTERM', () => {});
setTimeout(() => {}, 60000);
`, 'utf8');
  const treeRun = run([
    'execute-handoff', '--root', root,
    '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} tree-agent.mjs --task-file {{plan_file}}`,
    '--timeout-ms', '1000', '--yes'
  ]);
  if (treeRun.status === 0) {
    throw new Error(`tree-kill timeout exited successfully\nstdout:\n${treeRun.stdout}\nstderr:\n${treeRun.stderr}`);
  }
  const grandchildPid = Number(await fs.readFile(path.join(root, 'grandchild.pid'), 'utf8'));
  let grandchildAlive = true;
  for (let i = 0; i < 50 && grandchildAlive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(grandchildPid, 0);
    } catch {
      grandchildAlive = false;
    }
  }
  if (grandchildAlive) {
    try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* best effort */ }
    throw new Error(`timeout left detached grandchild ${grandchildPid} alive (direct-child-only cleanup)`);
  }
  // No stray agent/grandchild node processes from this workspace may remain.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' });
  const strays = String(ps.stdout || '').split('\n').filter((line) => line.includes('tree-agent.mjs') || line.includes('grandchild.pid'));
  if (strays.length) {
    throw new Error(`stray handoff processes remain:\n${strays.join('\n')}`);
  }
  console.log('ok: timeout reaps the full process tree');
}

// --- 4. Early-exiting root with inherited pipes + retained-pipes child ---
// The root exits 0 immediately while a detached child holding inherited stdio
// ignores SIGTERM. The run must reap the child (bounded cleanup before
// publishing) — never hang, never publish clean while the child holds pipes.
if (process.platform !== 'win32') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-retained-'));
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Retained pipes plan\n\nExit fast, leave a child.\n', 'utf8');
  const marker = `codexpro-retained-marker-${process.pid}-${Date.now()}`;
  await fs.writeFile(path.join(root, 'fast-exit-agent.mjs'), `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const kid = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000); // ${marker}"], {
  stdio: 'inherit', detached: true
});
kid.unref();
fs.writeFileSync('retained.pid', String(kid.pid));
// Linger past several ownership snapshots so the child is tracked during
// execution, then exit while it still holds our pipes.
await new Promise((resolve) => setTimeout(resolve, 800));
process.exit(0);
`, 'utf8');
  await fs.writeFile(path.join(root, 'app.txt'), 'base\n', 'utf8');
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', 'app.txt'], { cwd: root, encoding: 'utf8' });
  const retainedRun = run([
    'execute-handoff', '--root', root,
    '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} fast-exit-agent.mjs --task-file {{plan_file}}`,
    '--timeout-ms', '30000', '--yes'
  ]);
  requireSuccess(retainedRun, 'retained-pipes execute-handoff');
  const retainedPid = Number(await fs.readFile(path.join(root, 'retained.pid'), 'utf8'));
  if (!Number.isSafeInteger(retainedPid) || retainedPid <= 0) {
    throw new Error('retained-pipes agent did not record its child pid');
  }
  if (!(await waitForMarkerGone(retainedPid, marker))) {
    try { process.kill(retainedPid, 'SIGKILL'); } catch { /* best effort exact-owned cleanup */ }
    throw new Error(`early-exiting root left retained-pipes child ${retainedPid} alive (published clean while child holds pipes)`);
  }
  const state = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  if (state.state !== 'completed' || state.exit_code !== 0) {
    throw new Error(`retained-pipes run state was wrong\n${JSON.stringify(state, null, 2)}`);
  }
  if (state.tree_cleanup_incomplete) {
    throw new Error(`retained-pipes child was reaped but the run still reports incomplete cleanup\n${JSON.stringify(state, null, 2)}`);
  }
  console.log('ok: early-exiting root reaps its retained-pipes child before publishing');
}

// --- 5. Oversize git output stays a success but is flagged incomplete ---
// ENOBUFS/GIT_OUTPUT_TOO_LARGE is bounded evidence, not a command failure:
// the pinned loop needs the success, but no consumer may mistake the missing
// diff for a verified empty/complete diff.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-oversize-'));
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Oversize diff plan\n\nWrite a very large tracked diff.\n', 'utf8');
  await fs.writeFile(path.join(root, 'huge.txt'), 'base\n', 'utf8');
  await fs.writeFile(path.join(root, 'agent.mjs'), `
import fs from 'node:fs';
fs.writeFileSync('huge.txt', \`changed\\n\${'x'.repeat(2_500_000)}\\n\`);
`, 'utf8');
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', 'huge.txt'], { cwd: root, encoding: 'utf8' });
  requireSuccess(run([
    'execute-handoff', '--root', root,
    '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
    '--max-output-bytes', '4000', '--yes'
  ]), 'oversize diff execute-handoff');
  const state = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  if (state.state !== 'completed' || state.exit_code !== 0) {
    throw new Error(`oversize diff run should still succeed\n${JSON.stringify(state, null, 2)}`);
  }
  if (state.git_evidence_error) {
    throw new Error(`oversize diff must not carry a hard git evidence error\n${JSON.stringify(state, null, 2)}`);
  }
  if (state.git_evidence_incomplete !== true || state.git_evidence_reason !== 'GIT_OUTPUT_TOO_LARGE') {
    throw new Error(`oversize diff run state missing incomplete-evidence flag\n${JSON.stringify(state, null, 2)}`);
  }
  const diffText = await fs.readFile(path.join(root, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
  if (!diffText.includes('# git changes unavailable (incomplete evidence: GIT_OUTPUT_TOO_LARGE)') || !diffText.includes('NOT proof of an empty')) {
    throw new Error(`oversize diff artifact does not say incomplete/unavailable\n${diffText.slice(0, 1000)}`);
  }
  const statusText = await fs.readFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'utf8');
  if (!statusText.includes('Git evidence: incomplete (GIT_OUTPUT_TOO_LARGE)')) {
    throw new Error(`oversize status text does not say incomplete\n${statusText}`);
  }
  const logText = await fs.readFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
  if (!logText.includes('"git_evidence_incomplete":true') || !logText.includes('GIT_OUTPUT_TOO_LARGE')) {
    throw new Error(`oversize execution log missing incomplete-evidence flag\n${logText.slice(0, 2000)}`);
  }
  console.log('ok: oversize git output succeeds with git_evidence_incomplete');
}

// --- 5b. Trimmed (not oversize) git output succeeds but is flagged incomplete ---
// The capture buffer (maxBuffer, >= 1M) is wider than the evidence budget
// (maxBytes): output in that gap trims silently without ENOBUFS. That trimmed
// capture is partial evidence and must carry incomplete:true with the distinct
// GIT_OUTPUT_TRUNCATED reason — never a silent complete success. The pinned
// loop success behaviour is preserved: the run still succeeds.
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-handoff-truncated-'));
  await fs.mkdir(path.join(root, '.ai-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bridge', 'current-plan.md'), '# Truncated diff plan\n\nWrite a large-but-capturable tracked diff.\n', 'utf8');
  await fs.writeFile(path.join(root, 'big.txt'), 'base\n', 'utf8');
  await fs.writeFile(path.join(root, 'agent.mjs'), `
import fs from 'node:fs';
fs.writeFileSync('big.txt', \`base\n\${'y'.repeat(60_000)}\n\`);
`, 'utf8');
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', 'big.txt'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['-c', 'user.email=truncated@example.com', '-c', 'user.name=Truncated', 'commit', '-qm', 'base'], { cwd: root, encoding: 'utf8' });
  // ~60KB diff: under the ~1M capture buffer (no ENOBUFS/GIT_OUTPUT_TOO_LARGE)
  // but over the 4000-byte evidence budget, so trimBytes truncates it.
  requireSuccess(run([
    'execute-handoff', '--root', root,
    '--agent', 'custom',
    '--command', `${quoteArg(process.execPath)} agent.mjs --task-file {{plan_file}}`,
    '--max-output-bytes', '4000', '--yes'
  ]), 'truncated diff execute-handoff');
  const state = readJson(path.join(root, '.ai-bridge', 'handoff-run-state.json'));
  if (state.state !== 'completed' || state.exit_code !== 0) {
    throw new Error(`trimmed diff run should still succeed\n${JSON.stringify(state, null, 2)}`);
  }
  if (state.git_evidence_error) {
    throw new Error(`trimmed diff must not carry a hard git evidence error\n${JSON.stringify(state, null, 2)}`);
  }
  if (state.git_evidence_incomplete !== true || state.git_evidence_reason !== 'GIT_OUTPUT_TRUNCATED') {
    throw new Error(`trimmed diff run state missing truncated-incomplete flag\n${JSON.stringify(state, null, 2)}`);
  }
  const diffText = await fs.readFile(path.join(root, '.ai-bridge', 'implementation-diff.patch'), 'utf8');
  if (!diffText.includes('output truncated to 4000 bytes')) {
    throw new Error(`trimmed diff artifact lost the truncation marker\n${diffText.slice(0, 500)}`);
  }
  const statusText = await fs.readFile(path.join(root, '.ai-bridge', 'agent-status.md'), 'utf8');
  if (!statusText.includes('Git evidence: incomplete (GIT_OUTPUT_TRUNCATED)') || !statusText.includes('not proof of an empty or complete diff')) {
    throw new Error(`trimmed status text does not say incomplete/partial\n${statusText.slice(0, 800)}`);
  }
  const logText = await fs.readFile(path.join(root, '.ai-bridge', 'execution-log.jsonl'), 'utf8');
  if (!logText.includes('"git_evidence_incomplete":true') || !logText.includes('GIT_OUTPUT_TRUNCATED')) {
    throw new Error(`trimmed execution log missing incomplete-evidence flag\n${logText.slice(0, 2000)}`);
  }
  console.log('ok: trimmed git output succeeds with GIT_OUTPUT_TRUNCATED incomplete flag');
}

// --- 6. Stale/reused PIDs verify as foreign and are never signalled ---
// Pure identity-gate regression: the gate that every traversal/signalling
// path consults before touching a bare PID.
{
  if (process.platform !== 'linux') {
    throw new Error('stale-PID identity regression requires Linux /proc');
  }
  const self = captureProcessIdentity(process.pid);
  if (!self || !self.startTime) {
    throw new Error('could not capture this process identity via /proc');
  }
  if (readLinuxProcessStartTime(process.pid) !== self.startTime) {
    throw new Error('process starttime is not stable across reads');
  }
  if (!verifyProcessIdentity(process.pid, self)) {
    throw new Error('own live identity did not verify');
  }
  // Fabricated baseline for a live PID: recycled-PID lookalike, must fail.
  if (verifyProcessIdentity(process.pid, { pid: process.pid, startTime: '0' })) {
    throw new Error('fabricated starttime verified against a live PID (recycled PID would be signalled)');
  }
  // Baseline object for a different PID: must fail.
  if (verifyProcessIdentity(process.pid, { pid: process.pid + 1, startTime: self.startTime })) {
    throw new Error('cross-PID identity verified (wrong process would be signalled)');
  }
  // Missing/unreadable sides: fail closed, never signal.
  if (verifyProcessIdentity(process.pid, { pid: process.pid, startTime: null })) {
    throw new Error('null baseline verified (unprovable identity would be signalled)');
  }
  const deadPid = 2 ** 30 + 7;
  if (readLinuxProcessStartTime(deadPid) !== null) {
    throw new Error(`implausible PID ${deadPid} unexpectedly readable; cannot prove absence`);
  }
  if (verifyProcessIdentity(deadPid, { pid: deadPid, startTime: '1' })) {
    throw new Error('absent PID verified (stale PID would be signalled)');
  }
  if (verifyProcessIdentity(-1, { pid: -1, startTime: '1' }) || verifyProcessIdentity(process.pid, null)) {
    throw new Error('invalid identity input verified');
  }
  // Windows identity table parser stays honest: rows parse, garbage drops.
  const rows = parseProcessIdentityTable('123 1 20260101000000000000\nbad row\n456 123 20260101000001000000\n');
  if (rows.length !== 2 || rows[0].pid !== 123 || rows[0].creationDate !== '20260101000000000000' || rows[1].parentPid !== 123) {
    throw new Error(`Windows identity table parser regressed: ${JSON.stringify(rows)}`);
  }
  if (processIdentityTableInvocation('linux') !== null || !processIdentityTableInvocation('win32')) {
    throw new Error('Windows identity snapshot must be win32-only');
  }
  console.log('ok: stale/reused PIDs never verify (fail closed)');
}

// --- 6b. Reused parent PID never yields unrelated children (validated traversal) ---
// Exercises the ACTUAL owned-tree discovery path shared with codexpro.mjs:
// codexpro.mjs addObservedDescendants /
// addObservedDescendantsOfKnownProcesses delegate to
// addValidatedObservedDescendants(OfKnownProcesses) /
// validatedDescendantProcessIds in launcher-process-tree.mjs for every
// POSIX and Windows kill/wait discovery call. Stubbed process tables plus
// stubbed birth markers; no real kills, no signalling, fixtures are four
// small PIDs. A dry-run signalling set derived from knownPids would never
// contain the unrelated child because it is never added.
{
  const stubReadNull = () => null;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  // A: reused root 1234 (recorded T1, current T2) with unrelated child 9999.
  {
    const knownPids = new Set([1234, 1235]);
    const knownIdentities = new Map([[1234, '1000'], [1235, '2000']]);
    const current = new Map([[1234, '1001'], [1235, '2000'], [9999, '3000']]);
    const table = [{ pid: 1234, parentPid: 1 }, { pid: 9999, parentPid: 1234 }];
    assert(
      isParentIdentityValidForExpansion(1234, knownIdentities, current, { platform: 'linux', readStartTime: stubReadNull }) === false,
      'reused root 1234 must validate as stale (T1 vs T2)'
    );
    assert(
      validatedDescendantProcessIds(table, 1234, knownIdentities, current, { platform: 'linux', readStartTime: stubReadNull }).length === 0,
      'validated BFS from stale root must return no descendants'
    );
    const before = knownIdentities.get(1234);
    addValidatedObservedDescendantsOfKnownProcesses(table, knownPids, knownIdentities, current, { platform: 'linux', readStartTime: stubReadNull });
    assert(!knownPids.has(9999), 'unrelated child 9999 of reused parent 1234 was added to knownPids');
    assert(!knownIdentities.has(9999), 'unrelated child 9999 acquired an ownership baseline');
    assert(knownIdentities.get(1234) === before && before === '1000', `stale 1234 baseline refreshed to ${knownIdentities.get(1234)} (must stay T1)`);
    // Dry-run signalling set derived from knownPids never targets 9999.
    const wouldSignal = [...knownPids].filter((pid) => pid === 9999);
    assert(wouldSignal.length === 0, 'dry-run signalling set contains unrelated 9999');
  }
  // B: positive control — valid root still discovers its child (helper is not always-empty).
  {
    const knownPids = new Set();
    const knownIdentities = new Map([[1234, '1000']]);
    const current = new Map([[1234, '1000'], [1235, '2000']]);
    const table = [{ pid: 1234, parentPid: 1 }, { pid: 1235, parentPid: 1234 }];
    assert(
      isParentIdentityValidForExpansion(1234, knownIdentities, current, { platform: 'linux', readStartTime: stubReadNull }) === true,
      'valid root 1234 must validate'
    );
    const { added, staleRoot } = addValidatedObservedDescendants(table, 1234, knownPids, knownIdentities, current, { platform: 'linux', readStartTime: stubReadNull });
    assert(staleRoot === false, 'valid root reported stale');
    assert(knownPids.has(1235) && added.includes(1235), 'valid child 1235 was not adopted');
    assert(knownIdentities.get(1235) === '2000', 'valid child baseline not recorded');
    assert(knownIdentities.get(1234) === '1000', 'valid root baseline must not change');
  }
  // C: reused intermediate 200 under valid root 100 must prune grandchild 9999.
  {
    const knownPids = new Set([100, 200]);
    const knownIdentities = new Map([[100, 'A1'], [200, 'B1']]);
    const current = new Map([[100, 'A1'], [200, 'B2'], [9999, 'C1']]);
    const table = [{ pid: 100, parentPid: 1 }, { pid: 200, parentPid: 100 }, { pid: 9999, parentPid: 200 }];
    addValidatedObservedDescendantsOfKnownProcesses(table, knownPids, knownIdentities, current, { platform: 'linux', readStartTime: stubReadNull });
    assert(!knownPids.has(9999), 'grandchild 9999 of stale intermediate 200 was added');
    assert(!knownIdentities.has(9999), 'grandchild 9999 acquired a baseline via stale intermediate');
    assert(knownIdentities.get(200) === 'B1', `stale intermediate 200 baseline refreshed to ${knownIdentities.get(200)}`);
  }
  // D: Windows CreationDate path (platform override, mocked CIM values).
  {
    const t1 = '20260101000000000000';
    const t2 = '20260101000001000000';
    const knownPids = new Set([1234]);
    const knownIdentities = new Map([[1234, t1]]);
    const current = new Map([[1234, t2], [9999, t2]]);
    const table = [{ pid: 1234, parentPid: 1 }, { pid: 9999, parentPid: 1234 }];
    assert(
      isParentIdentityValidForExpansion(1234, knownIdentities, current, { platform: 'win32' }) === false,
      'Windows reused root must validate as stale'
    );
    addValidatedObservedDescendantsOfKnownProcesses(table, knownPids, knownIdentities, current, { platform: 'win32' });
    assert(!knownPids.has(9999), 'Windows: unrelated 9999 of reused parent was added');
    assert(knownIdentities.get(1234) === t1, 'Windows: stale baseline refreshed');
    // Snapshot unavailable on Windows refuses expansion (fail closed, narrowed).
    const knownPids2 = new Set([1234]);
    const knownIdentities2 = new Map([[1234, t1]]);
    addValidatedObservedDescendantsOfKnownProcesses(table, knownPids2, knownIdentities2, null, { platform: 'win32' });
    assert(!knownPids2.has(9999), 'Windows without CIM snapshot must not expand');
  }
  console.log('ok: reused parent PID never yields unrelated children (validated traversal, no refresh)');
}

// --- 7. Windows root-taskkill identity gate (mocked CIM, pure unit) ---
// The gate that guards taskkill /T /F against PID reuse: only an exact
// spawn-baseline vs fresh-snapshot CreationDate match on a live child
// proceeds. Every other case refuses the root signal. Uses mocked CIM rows
// (no live CIM/taskkill here): live Windows taskkill/CIM execution is
// Windows-only and is a documented skip on Linux — this unit proves the
// decision logic that guards it, including the POSIX-parity exit guard.
{
  if (typeof windowsRootTaskkillDecision !== 'function') {
    throw new Error('windowsRootTaskkillDecision is not exported from launcher-process-tree.mjs');
  }
  // Mocked CIM identity rows: parse first, then decide from parsed values.
  const mocked = parseProcessIdentityTable('777 1 20260101000000000000\nbad row\n888 777 20260101000001000000\n');
  if (mocked.length !== 2 || mocked[0].pid !== 777 || mocked[0].creationDate !== '20260101000000000000') {
    throw new Error(`mocked CIM rows did not parse: ${JSON.stringify(mocked)}`);
  }
  const check = (label, spawn, current, exited, expectProceed, expectReason) => {
    const decision = windowsRootTaskkillDecision(spawn, current, exited);
    if (decision.proceed !== expectProceed || decision.reason !== expectReason) {
      throw new Error(`${label}: got ${JSON.stringify(decision)}, expected proceed=${expectProceed} reason=${expectReason}`);
    }
  };
  check('live exact match proceeds', mocked[0].creationDate, mocked[0].creationDate, false, true, 'IDENTITY_VERIFIED');
  check('mismatch refuses (PID reuse)', mocked[0].creationDate, mocked[1].creationDate, false, false, 'ROOT_IDENTITY_MISMATCH');
  check('absent current refuses', mocked[0].creationDate, null, false, false, 'ROOT_IDENTITY_ABSENT');
  check('absent current refuses (empty string)', mocked[0].creationDate, '', false, false, 'ROOT_IDENTITY_ABSENT');
  check('unprovable spawn baseline refuses', null, mocked[0].creationDate, false, false, 'SPAWN_IDENTITY_UNPROVABLE');
  check('exited child refuses even on match (exit guard)', mocked[0].creationDate, mocked[0].creationDate, true, false, 'CHILD_EXITED');
  check('exited child refuses on mismatch', mocked[0].creationDate, mocked[1].creationDate, true, false, 'CHILD_EXITED');
  if (processIdentityTableInvocation('linux') !== null || !processIdentityTableInvocation('win32')) {
    throw new Error('Windows identity snapshot route must stay win32-only');
  }
  console.log('ok: Windows root-taskkill gate refuses reuse/exit/unprovable, proceeds only on live match (live CIM/taskkill Windows-only: documented skip)');
}

console.log('handoff profile/cleanup/git-failure smoke passed');
