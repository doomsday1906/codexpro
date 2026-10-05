#!/usr/bin/env node
// Tri-engine RepoConnect CLI delegation smoke: codex (selected-profile gate
// + per-run execution policy) x opencode (selected-agent + explicit model)
// x claude (selected-agent + explicit-flag-only overrides).
//
// Proves, with NO live model calls:
// - Luna read-only gate stays ONLY for the legacy canary slice; real tasks
//   verify the SELECTED profile (exists, non-Astra, resolvable sandbox) and
//   danger-full-access is explicit-only (never inherited, never escalated).
// - OpenCode host-model equality stays canary-only; real tasks use the
//   selected agent + explicit model; Codex flags never leak into argv.
// - Claude inherits agent/settings unless the caller explicitly passed
//   --model/--effort/--permission-mode/--allowedTools; unknown agents,
//   bad enums, and Astra refuse; resume is verified via the session file.
// - Failure classification: only a real tool-execution denial warrants
//   proposing a permission change; read refusals, missing binaries, auth
//   problems, and model assertions never do.
// - delegation_preview is a read-only dry-run (no spawn, no run record)
//   separating configured settings from runtime-observed evidence, and
//   reports INCOMPLETE with an exact blocker for missing capability.
// - One MCP-level claude launch + follow-up through fake binaries proves
//   the wiring end to end (stable --session-id, new-continuation-attempt
//   without a session file, raw evidence + review note in read_result).
//
// Deterministic containment: mkdtemp roots, fixture CODEX_HOME / agent
// dirs / projects dir, fake binaries via CODEXPRO_*_BIN. No heavy builds
// beyond the required `npm run build` prefix.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));

// ---------- fixtures ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "low"\nsandbox_mode = "read-only"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_IMPLEMENTER.config.toml'),
  'model = "gpt-6-luna"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_MODELER.config.toml'),
  'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\nsandbox_mode = "workspace-write"\n');
await fsp.writeFile(path.join(codexHome, 'CODEX_NOSANDBOX.config.toml'), 'model = "gpt-6-luna"\n');
process.env.CODEX_HOME = codexHome;

const ocAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-ocagents-'));
await fsp.writeFile(path.join(ocAgents, 'implementer.md'), '# implementer\n\nReal OpenCode agent fixture.\n');
process.env.CODEXPRO_OPENCODE_AGENTS_DIR = ocAgents;

const clAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-clagents-'));
await fsp.writeFile(path.join(clAgents, 'implementer.md'),
  '---\nname: implementer\nmodel: claude-sonnet-5-5\neffort: high\n---\n\nReal Claude agent fixture.\n');
process.env.CODEXPRO_CLAUDE_AGENTS_DIR = clAgents;

const clProjects = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-clprojects-'));
await fsp.mkdir(path.join(clProjects, 'slug'));
const knownUuid = '123e4567-e89b-42d3-a456-426614174000';
await fsp.writeFile(path.join(clProjects, 'slug', `${knownUuid}.jsonl`), '{"type":"session"}\n');
process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;

const HOST_MODEL = 'opencode-go/muse-spark-1.3-contributor';

// ---------- 1. codex gates ----------
{
  const canary = Engines.verifyCodexLaunch(codexHome, 'CODEX_SCOUT_FAST', { isCanary: true, delegationGroup: 'hestia-cli-canary' });
  assert(canary.allowed && canary.gateKind === 'luna' && canary.executionPolicy === 'read-only', `luna canary must allow scout-fast read-only: ${JSON.stringify(canary)}`);
  const canaryWrong = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER', { isCanary: true, delegationGroup: 'hestia-cli-canary' });
  assert(!canaryWrong.allowed && canaryWrong.code === 'luna_gate_refused', 'canary with a non-luna profile must stay refused');
  const canaryEscalate = Engines.verifyCodexLaunch(codexHome, 'CODEX_SCOUT_FAST', { isCanary: true, delegationGroup: 'hestia-cli-canary', executionPolicy: 'workspace-write' });
  assert(!canaryEscalate.allowed && canaryEscalate.code === 'luna_gate_refused', 'canary must refuse an explicit non-read-only policy');
  const canaryOverride = Engines.verifyCodexLaunch(codexHome, 'CODEX_SCOUT_FAST', { isCanary: true, delegationGroup: 'hestia-cli-canary', modelOverride: 'gpt-6-luna' });
  assert(!canaryOverride.allowed, 'canary must refuse explicit model overrides');
  const real = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER', { isCanary: false, delegationGroup: 'team-alpha' });
  assert(real.allowed && real.gateKind === 'profile' && real.executionPolicy === 'workspace-write', `real task must inherit the profile sandbox: ${JSON.stringify(real)}`);
  const realDanger = Engines.verifyCodexLaunch(codexHome, 'CODEX_SCOUT_FAST', { isCanary: false, delegationGroup: 'team-alpha', executionPolicy: 'danger-full-access' });
  assert(realDanger.allowed && realDanger.executionPolicy === 'danger-full-access', 'explicit danger-full-access must be honored per-run');
  const realBadPolicy = Engines.verifyCodexLaunch(codexHome, 'CODEX_SCOUT_FAST', { isCanary: false, delegationGroup: 'team-alpha', executionPolicy: 'yolo' });
  assert(!realBadPolicy.allowed && realBadPolicy.code === 'invalid_execution_policy', 'unknown policy must be refused');
  const realNoSandbox = Engines.verifyCodexLaunch(codexHome, 'CODEX_NOSANDBOX', { isCanary: false, delegationGroup: 'team-alpha' });
  assert(!realNoSandbox.allowed && realNoSandbox.code === 'execution_policy_unresolvable', 'unresolvable sandbox without explicit policy must be refused, never guessed');
  const unknown = Engines.verifyCodexLaunch(codexHome, 'NOPE', { isCanary: false, delegationGroup: 'team-alpha' });
  assert(!unknown.allowed && unknown.code === 'profile_unknown', 'unknown profile must be refused, never substituted');
  const astra = Engines.verifyCodexLaunch(codexHome, 'CODEX_MODELER', { isCanary: false, delegationGroup: 'team-alpha' });
  assert(!astra.allowed && astra.code === 'astra_forbidden', 'Astra profile must be refused');
  const astraOverride = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER', { isCanary: false, delegationGroup: 'team-alpha', modelOverride: 'gpt-6-astra' });
  assert(!astraOverride.allowed && astraOverride.code === 'astra_forbidden', 'Astra override must be refused');
  const badConfig = Engines.verifyCodexLaunch(codexHome, 'CODEX_IMPLEMENTER', { isCanary: false, delegationGroup: 'team-alpha', configOverrides: ['not-kv'] });
  assert(!badConfig.allowed && badConfig.code === 'invalid_config_override', 'malformed -c override must be refused');
  console.log('ok: T1 codex gates (luna canary-only, selected-profile real tasks, explicit-only danger, astra forbidden)');
}
{
  const argv = Engines.buildCodexRealArgv('CODEX_IMPLEMENTER', 'do work', '/tmp/x/codex-last-message.md', { executionPolicy: 'workspace-write' });
  assert(argv.includes('--profile') && argv.includes('-s') && argv.includes('workspace-write') && argv.includes('--ephemeral'), 'real codex argv must carry profile + sandbox + ephemeral');
  assert(!argv.includes('--dangerously-bypass-approvals-and-sandbox'), 'workspace-write must not carry the danger bypass');
  const danger = Engines.buildCodexRealArgv('CODEX_SCOUT_FAST', 'do work', '/tmp/x/m.md', { executionPolicy: 'danger-full-access' });
  assert(!danger.includes('--dangerously-bypass-approvals-and-sandbox'), 'sandbox danger-full-access alone must NOT imply the bypass flag (sandbox != bypass)');
  const dangerBypass = Engines.buildCodexRealArgv('CODEX_SCOUT_FAST', 'do work', '/tmp/x/m.md', { executionPolicy: 'danger-full-access', dangerBypassExplicit: true });
  assert(dangerBypass.includes('--dangerously-bypass-approvals-and-sandbox'), 'separate explicit bypass rides only with explicit danger');
  const bypassNoDanger = Engines.buildCodexRealArgv('CODEX_IMPLEMENTER', 'do work', '/tmp/x/m.md', { executionPolicy: 'workspace-write', dangerBypassExplicit: true });
  assert(!bypassNoDanger.includes('--dangerously-bypass-approvals-and-sandbox'), 'bypass without danger must not ride');
  const over = Engines.buildCodexRealArgv('CODEX_IMPLEMENTER', 'do work', '/tmp/x/m.md', { executionPolicy: 'read-only', modelOverride: 'm', configOverrides: ['a=b'] });
  assert(over.includes('-m') && over.includes('-c'), 'explicit overrides must ride argv only when passed');
  console.log('ok: T2 codex argv (policy-gated sandbox, explicit-only escalation/overrides)');
}
{
  const cases = [
    [{ exitCode: 127, stderrTail: 'spawn codex ENOENT' }, 'missing-executable', false],
    [{ exitCode: 1, stderrTail: 'Error: unauthorized: invalid api key' }, 'auth-problem', false],
    [{ exitCode: 1, stderrTail: 'model gpt-9 not found' }, 'unsupported-model', false],
    [{ exitCode: 1, stderrTail: 'command denied by sandbox policy' }, 'execution-denial', true],
    [{ exitCode: 1, stderrTail: 'failed to read /etc/secret: EACCES' }, 'execution-denial', false],
    [{ exitCode: 1, stderrTail: 'weird output' }, 'unknown', false]
  ];
  for (const [input, cls, warranted] of cases) {
    const got = Engines.classifyCodexFailure(input);
    assert(got.class === cls && got.permissionChangeWarranted === warranted, `classify ${JSON.stringify(input)} -> ${cls}/${warranted}, got ${JSON.stringify(got)}`);
  }
  console.log('ok: T3 failure classification (only real execution denial warrants a proposal)');
}

// ---------- 2. opencode gates ----------
{
  const canary = Engines.verifyOpenCodeLaunch({ model: HOST_MODEL, agent: undefined, isCanary: true, delegationGroup: 'hestia-cli-canary', hostModel: HOST_MODEL });
  assert(canary.allowed && canary.hostEqualityEnforced, 'legacy opencode canary without agent must keep working');
  const canaryAgent = Engines.verifyOpenCodeLaunch({ model: HOST_MODEL, agent: 'implementer', isCanary: true, delegationGroup: 'hestia-cli-canary', hostModel: HOST_MODEL });
  assert(canaryAgent.allowed, 'legacy canary with a real agent must allow');
  const mismatch = Engines.verifyOpenCodeLaunch({ model: 'other/model', agent: undefined, isCanary: true, delegationGroup: 'hestia-cli-canary', hostModel: HOST_MODEL });
  assert(!mismatch.allowed && mismatch.code === 'opencode_model_mismatch', 'canary model mismatch must refuse, never substitute');
  const noModel = Engines.verifyOpenCodeLaunch({ model: '', agent: undefined, isCanary: true, delegationGroup: 'hestia-cli-canary', hostModel: HOST_MODEL });
  assert(!noModel.allowed && noModel.code === 'model_required', 'missing canary model must be refused');
  const realNoAgent = Engines.verifyOpenCodeLaunch({ model: 'some/model', agent: '', isCanary: false, delegationGroup: 'team', hostModel: HOST_MODEL });
  assert(!realNoAgent.allowed && realNoAgent.code === 'agent_required', 'real task without agent must be refused');
  const realUnknown = Engines.verifyOpenCodeLaunch({ model: 'some/model', agent: 'ghost', isCanary: false, delegationGroup: 'team', hostModel: HOST_MODEL });
  assert(!realUnknown.allowed && realUnknown.code === 'agent_unknown', 'unknown agent must be refused');
  const real = Engines.verifyOpenCodeLaunch({ model: 'some/model', agent: 'implementer', isCanary: false, delegationGroup: 'team', hostModel: HOST_MODEL });
  assert(real.allowed && !real.hostEqualityEnforced && real.requestedModel === 'some/model', `real task must use selected agent + explicit model: ${JSON.stringify(real)}`);
  const astra = Engines.verifyOpenCodeLaunch({ model: 'gpt-6-astra', agent: 'implementer', isCanary: false, delegationGroup: 'team', hostModel: HOST_MODEL });
  assert(!astra.allowed && astra.code === 'astra_forbidden', 'Astra model must be refused');
  const argv = Engines.buildOpenCodeRealArgv({ model: 'some/model', agent: 'implementer', prompt: 'hi' });
  assert(argv.includes('--agent') && argv.includes('--model') && argv.includes('--format'), 'opencode argv must carry agent+model+format');
  assert(!argv.includes('--profile') && !argv.includes('exec') && !argv.includes('--ephemeral') && !argv.includes('-s'), 'opencode argv must never carry Codex flags');
  console.log('ok: T4 opencode gates (host equality canary-only, selected agent + explicit model for real tasks)');
}

// ---------- 3. claude gates ----------
{
  const missing = Engines.verifyClaudeLaunch({ agent: '' });
  assert(!missing.allowed && missing.code === 'agent_required', 'missing claude agent must be refused');
  const unknown = Engines.verifyClaudeLaunch({ agent: 'ghost' });
  assert(!unknown.allowed && unknown.code === 'agent_unknown', 'unknown claude agent must be refused');
  const inherit = Engines.verifyClaudeLaunch({ agent: 'implementer' });
  assert(inherit.allowed && !inherit.modelExplicit && !inherit.effortExplicit && !inherit.permissionExplicit, `bare agent must inherit: ${JSON.stringify(inherit)}`);
  assert(inherit.effectiveModel === 'claude-sonnet-5-5' && inherit.effectiveEffort === 'high', 'frontmatter model/effort are the inheritance source');
  const explicit = Engines.verifyClaudeLaunch({ agent: 'implementer', model: 'opus', effort: 'max', permissionMode: 'acceptEdits', allowedTools: 'Bash Edit' });
  assert(explicit.allowed && explicit.modelExplicit && explicit.effortExplicit && explicit.permissionExplicit, 'explicit flags must be recorded explicit');
  assert(!Engines.verifyClaudeLaunch({ agent: 'implementer', effort: 'ultra' }).allowed, 'bad effort must be refused');
  assert(!Engines.verifyClaudeLaunch({ agent: 'implementer', permissionMode: 'yolo' }).allowed, 'bad permission mode must be refused');
  assert(Engines.verifyClaudeLaunch({ agent: 'implementer', model: 'gpt-6-astra' }).code === 'astra_forbidden', 'Astra model must be refused');
  const argv = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'hi', sessionId: knownUuid });
  assert(argv[0] === '-p' && argv.includes('--output-format') && argv.includes('--agent') && argv.includes('--session-id') && !argv.includes('--model'), `new claude argv must inherit model: ${JSON.stringify(argv)}`);
  assert(!argv.includes('-s') && !argv.includes('--profile') && !argv.includes('--sandbox'), 'claude argv must never carry Codex flags');
  const resumed = Engines.buildClaudeResumeArgv(knownUuid, 'hi', { agent: 'implementer' });
  assert(resumed.includes('--resume') && !resumed.includes('--session-id'), 'resume argv uses --resume only');
  assert(Engines.isClaudeSessionId(knownUuid) && !Engines.isClaudeSessionId('ses_abc'), 'claude session grammar is UUID');
  assert(Engines.isClaudeSessionId(Engines.newClaudeSessionId()), 'minted claude session id must be a UUID');
  const verified = Engines.verifyClaudeSession(knownUuid);
  assert(verified.verified, `known session file must verify: ${verified.evidence}`);
  const unknownSession = Engines.verifyClaudeSession('123e4567-e89b-42d3-a456-426614174999');
  assert(!unknownSession.verified, 'unknown session must fail closed to new-continuation-attempt');
  console.log('ok: T5 claude gates (real agent, explicit-only flags, UUID sessions, file-verified resume)');
}

// ---------- 4. capability probe + preview shape (no live calls) ----------
{
  process.env.CODEXPRO_CODEX_BIN = '/nonexistent-codex-bin';
  const missing = Engines.probeEngineCapability('codex', { profileOrAgent: 'CODEX_SCOUT_FAST' });
  assert(!missing.ready && missing.blocker.includes('missing'), `missing binary must block: ${JSON.stringify(missing)}`);
  delete process.env.CODEXPRO_CODEX_BIN;
  const unknownEngine = Engines.probeEngineCapability('nope', {});
  assert(!unknownEngine.ready && unknownEngine.blocker.includes('codex|opencode|claude'), 'unknown engine must block');
  const preview = Engines.buildLaunchPreview({
    engine: 'claude', executable: 'claude', argvPreview: ['-p', '<worker prompt 10 chars>'],
    promptChars: 10, agent: 'implementer', modelConfigured: 'claude-sonnet-5-5', effortConfigured: 'high',
    modelExplicit: false, effortExplicit: false, workdir: '/tmp/w', delegationGroup: 'team',
    isCanary: false, timeoutMs: 300000, gateReason: 'ok',
    capability: { engine: 'claude', binary: { binary: 'claude', found: false, version: null, evidence: 'x' }, definitionFound: false, definitionPath: null, authNote: 'a', ready: false, blocker: 'nope' }
  });
  assert(preview.sensitive_omitted === true && preview.configured_vs_observed && preview.overall_status.startsWith('INCOMPLETE'), 'preview must omit sensitive, separate configured/observed, and report INCOMPLETE');
  console.log('ok: T6 capability probe blockers + preview shape');
}

// ---------- 5. store: tri-engine conflict identity ----------
{
  const base = { engine: 'codex', delegationGroup: 'g', isCanary: false, task: 't', profile: 'CODEX_IMPLEMENTER', executionPolicy: 'workspace-write' };
  assert(Store.isLaunchRequestConflict(base, { ...base }) === false, 'identical codex request must replay');
  assert(Store.isLaunchRequestConflict(base, { ...base, executionPolicy: 'read-only' }) === true, 'different execution policy is a different worker');
  assert(Store.isLaunchRequestConflict({ engine: 'codex', delegationGroup: 'g', isCanary: true, profile: 'CODEX_SCOUT_FAST' }, { engine: 'codex', delegationGroup: 'g', isCanary: true, profile: 'CODEX_SCOUT_FAST', executionPolicy: 'read-only' }) === false, 'legacy run without stored policy must not conflict');
  const cl = { engine: 'claude', delegationGroup: 'g', isCanary: false, task: 't', agent: 'implementer', model: '', permissionMode: '', effort: '' };
  assert(Store.isLaunchRequestConflict(cl, { ...cl, agent: 'reviewer' }) === true, 'different claude agent conflicts');
  assert(Store.isLaunchRequestConflict({ engine: 'claude', delegationGroup: 'g', isCanary: false, task: 't' }, { ...cl }) === false, 'legacy claude-less run must not conflict on absent agent');
  console.log('ok: T7 store conflict identity (policy/agent are identity; absent legacy fields are wildcards)');
}

// ---------- 6. workdir evidence ----------
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-ev-'));
  await fsp.writeFile(path.join(dir, 'a.txt'), 'a');
  const before = Engines.snapshotWorkdirListing(dir);
  await fsp.writeFile(path.join(dir, 'b.txt'), 'b');
  const ev = Engines.collectWorkdirEvidence(dir, before);
  assert(ev.kind === 'snapshot' && ev.changed.some((c) => c.includes('b.txt')), `snapshot diff must show the new file: ${JSON.stringify(ev)}`);
  const noBase = Engines.collectWorkdirEvidence(dir);
  assert(noBase.kind === 'unavailable', 'repo-less workdir without baseline must be explicit unavailable');
  console.log('ok: T8 workdir evidence (snapshot diff, explicit unavailable)');
}

// ---------- 7. MCP wiring: preview dry-run + claude launch/followup via fakes ----------
{
  const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-mcp-'));
  const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-shim-'));
  const fake = async (name, body) => {
    const p = path.join(shimBin, name);
    await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
    await fsp.chmod(p, 0o755);
    return p;
  };
  process.env.CODEXPRO_CODEX_BIN = await fake('codex', 'echo "codex-cli 0.159.0"\nexit 0');
  process.env.CODEXPRO_OPENCODE_BIN = await fake('opencode', 'echo "opencode v2.0.22"\nexit 0');
  process.env.CODEXPRO_CLAUDE_BIN = await fake('claude', 'echo "{\\"type\\":\\"result\\"}"\nexit 0');
  const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-tri-deleghome-'));
  process.env.CODEXPRO_DELEGATION_DIR = delegHome;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

  const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const config = loadConfig(['--root', wsRoot]);
  const server = createCodexProServer(config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tri-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert(names.includes('delegation_preview'), 'tool surface must include delegation_preview');
  const opened = await call('open_workspace', { root: wsRoot });
  assert(!opened.isError, 'open_workspace must succeed');
  const wid = opened.structuredContent.workspace_id;

  // Preview is a dry-run: resolved argv + capability, no run record.
  const prev = await call('delegation_preview', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'prev-1', task: 'Do the thing.', delegation_group: 'team-tri' });
  assert(!prev.isError, `preview must succeed: ${JSON.stringify(prev.structuredContent)}`);
  const pv = prev.structuredContent.preview;
  assert(pv.engine === 'claude' && pv.agent === 'implementer' && pv.sensitive_omitted === true, 'preview must show resolved agent with sensitive omitted');
  assert(pv.model_configured === 'claude-sonnet-5-5' && pv.model_explicit === false, 'preview must show inherited model as configured-but-not-explicit');
  assert(pv.capability.ready === true, `fake claude + real agent must be ready: ${JSON.stringify(pv.capability)}`);
  const prevBad = await call('delegation_preview', { workspace_id: wid, engine: 'claude', agent: 'ghost', workdir: 'prev-1', task: 'Do the thing.' });
  assert(prevBad.isError, 'preview with an unknown agent must refuse like launch');
  const prevCodex = await call('delegation_preview', { workspace_id: wid, engine: 'codex', profile: 'CODEX_IMPLEMENTER', workdir: 'prev-2', task: 'Do the thing.', delegation_group: 'team-tri', execution_policy: 'danger-full-access' });
  assert(!prevCodex.isError && prevCodex.structuredContent.preview.execution_policy === 'danger-full-access', 'preview must show the explicit danger policy');
  assert(prevCodex.structuredContent.preview.argv_preview.includes('-s'), 'preview argv must show the sandbox flag');

  // Claude launch through the fake binary: completes, stable session UUID.
  const launched = await call('delegation_launch', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'tri-claude-1', task: 'List files. Change nothing.', delegation_group: 'team-tri', request_id: 'req-tri-1', timeout_ms: 60000 });
  assert(!launched.isError, `claude launch failed: ${JSON.stringify(launched.structuredContent)}`);
  assert(launched.structuredContent.session_id && /^[0-9a-f-]{36}$/.test(launched.structuredContent.session_id), 'claude launch must mint a stable UUID session');
  assert(launched.structuredContent.timeout_ms === 60000 && launched.structuredContent.timeout_clamped === false, 'unclamped timeout must be truthfully acked');
  const runId = launched.structuredContent.run_id;
  const read1 = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read1.isError, 'read must succeed');
  const r1 = read1.structuredContent;
  assert(r1.agent === 'implementer' && r1.session.sessionId === launched.structuredContent.session_id, 'read must carry agent + stable session');
  assert(r1.review_note && r1.workdir_evidence && r1.test_evidence, 'read must carry review note + workdir/test evidence');
  assert(r1.resume_capability.engine === 'claude', 'read must carry the claude resume capability');
  // Wait for the fake to complete, then follow up: question -> answer ->
  // continuation with the SAME session id (no session file => first-use
  // creation, honestly labeled new-continuation-attempt).
  for (let i = 0; i < 100 && (await call('delegation_read_result', { workspace_id: wid, run_id: runId })).structuredContent.state === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const done = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(done.structuredContent.state === 'completed', `fake claude must complete, got ${done.structuredContent.state}`);
  const q = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'q1', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
  assert(!q.isError && q.structuredContent.state === 'needs-input', `question must move to needs-input: ${JSON.stringify(q.structuredContent)}`);
  const a = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'a1', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'q1' } });
  assert(!a.isError && a.structuredContent.executed === true, `answer must dispatch: ${JSON.stringify(a.structuredContent)}`);
  assert(a.structuredContent.continuation === 'new-continuation-attempt' && a.structuredContent.session_id === launched.structuredContent.session_id, 'unverified claude session must reuse the stable id as new-continuation-attempt');
  for (let i = 0; i < 100 && (await call('delegation_read_result', { workspace_id: wid, run_id: runId })).structuredContent.state === 'running'; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const done2 = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(done2.structuredContent.state === 'completed', 'continuation must complete');
  assert(done2.structuredContent.attempts.length === 2, 'two attempts must be recorded');
  console.log('ok: T9 MCP wiring (preview dry-run, claude launch + stable session + followup, raw evidence + review note)');
}

console.log('delegation-triengine-smoke: PASS (no live model calls)');
