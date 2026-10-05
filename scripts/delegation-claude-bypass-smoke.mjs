#!/usr/bin/env node
// Claude scoped-bypass smoke: explicit per-run opt-in, default OFF.
// disable_gitkraken_hooks=true rides per-invocation --settings disabling
// gitkraken-hooks@gitkraken on every claude argv for that run (initial
// launch, stable --session-id creation, verified --resume continuation),
// surfaced in preview (argv_preview + scoped_bypass notice), read_result
// execution_provenance, and the launch ack prose. Default OFF omits
// --settings entirely. Follow-ups preserve the stored run choice (never
// re-interpreted). Inert when the plugin is absent (zero files touched,
// never task content, never a model/permission substitution;
// --safe-mode/--bare never used). No global ~/.claude change.
//
// Hermetic: fixture agent/projects dirs + labeled shims only. No live model
// calls (fake claude prints canned JSON; --version only for probes).
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

const BYPASS_JSON = '{"enabledPlugins":{"gitkraken-hooks@gitkraken":false}}';
const BYPASS_PAIR = ['--settings', BYPASS_JSON];

const clAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-bypass-clagents-'));
await fsp.writeFile(path.join(clAgents, 'implementer.md'),
  '---\nname: implementer\nmodel: claude-sonnet-5-5\neffort: high\n---\n\nReal Claude agent fixture.\n');
process.env.CODEXPRO_CLAUDE_AGENTS_DIR = clAgents;

const clProjects = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-bypass-clprojects-'));
await fsp.mkdir(path.join(clProjects, 'slug'));
process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;

const UUID_A = '123e4567-e89b-42d3-a456-426614174000';
const UUID_B = '123e4567-e89b-42d3-a456-426614174111';

// C1: default OFF omits --settings entirely (byte-exact without bypass).
{
  const argv = Engines.buildClaudeArgv({
    agent: 'implementer', prompt: 'Do the thing.', model: 'opus',
    effort: 'max', permissionMode: 'acceptEdits', allowedTools: 'Read',
    disallowedTools: 'Bash', sessionId: UUID_A
  });
  const expected = ['-p', '--output-format', 'json', '--agent', 'implementer',
    '--model', 'opus', '--effort', 'max', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', '--disallowedTools', 'Bash',
    '--session-id', UUID_A, 'Do the thing.'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `default-OFF launch argv must omit --settings entirely: ${JSON.stringify(argv)}`);
  assert(!argv.includes('--settings'), 'default OFF must not ride --settings');
  console.log('ok: C1 default-OFF initial-launch argv byte-exact (no --settings)');
}

// C1b: explicit opt-in ON rides exactly one --settings element before prompt.
{
  const argv = Engines.buildClaudeArgv({
    agent: 'implementer', prompt: 'Do the thing.', model: 'opus',
    effort: 'max', permissionMode: 'acceptEdits', allowedTools: 'Read',
    disallowedTools: 'Bash', sessionId: UUID_A, disableGitkrakenHooks: true
  });
  const expected = ['-p', '--output-format', 'json', '--agent', 'implementer',
    '--model', 'opus', '--effort', 'max', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', '--disallowedTools', 'Bash',
    '--session-id', UUID_A, '--settings', BYPASS_JSON, 'Do the thing.'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `opt-in launch argv must be byte-exact (only addition: the --settings pair): ${JSON.stringify(argv)}`);
  console.log('ok: C1b opt-in initial-launch argv byte-exact (exact --settings element before prompt)');
}

// C2: bare launch default OFF (inherits, no bypass); opt-in adds bypass only.
{
  const argv = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'hi', sessionId: UUID_B });
  const expected = ['-p', '--output-format', 'json', '--agent', 'implementer',
    '--session-id', UUID_B, 'hi'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `bare default-OFF argv must be byte-exact: ${JSON.stringify(argv)}`);
  assert(!argv.includes('--model') && !argv.includes('--effort') && !argv.includes('--permission-mode'),
    'bare launch must still inherit (no invented explicit flags)');
  assert(!argv.includes('--settings'), 'bare default OFF must omit --settings');
  const opt = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'hi', sessionId: UUID_B, disableGitkrakenHooks: true });
  assert(JSON.stringify(opt) === JSON.stringify(['-p', '--output-format', 'json', '--agent', 'implementer',
    '--session-id', UUID_B, '--settings', BYPASS_JSON, 'hi']),
    `bare opt-in argv must add only the --settings pair: ${JSON.stringify(opt)}`);
  console.log('ok: C2 bare argv default OFF omits, opt-in adds only --settings');
}

// C3: verified-resume default OFF omits; opt-in carries full flag set + bypass.
{
  const argv = Engines.buildClaudeResumeArgv(UUID_A, 'hi', {
    agent: 'implementer', permissionMode: 'acceptEdits', model: 'opus',
    effort: 'high', allowedTools: 'Read', disallowedTools: 'Bash'
  });
  const expected = ['--resume', UUID_A, '-p', '--output-format', 'json',
    '--agent', 'implementer', '--model', 'opus', '--effort', 'high',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read',
    '--disallowedTools', 'Bash', 'hi'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `default-OFF resume argv must omit --settings: ${JSON.stringify(argv)}`);
  const opt = Engines.buildClaudeResumeArgv(UUID_A, 'hi', {
    agent: 'implementer', permissionMode: 'acceptEdits', model: 'opus',
    effort: 'high', allowedTools: 'Read', disallowedTools: 'Bash', disableGitkrakenHooks: true
  });
  assert(JSON.stringify(opt) === JSON.stringify(['--resume', UUID_A, '-p', '--output-format', 'json',
    '--agent', 'implementer', '--model', 'opus', '--effort', 'high',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read',
    '--disallowedTools', 'Bash', '--settings', BYPASS_JSON, 'hi']),
    `opt-in resume argv must be byte-exact: ${JSON.stringify(opt)}`);
  assert(!opt.includes('--session-id'), 'resume argv uses --resume only');
  const bare = Engines.buildClaudeResumeArgv(UUID_A, 'hi', { agent: 'implementer' });
  assert(JSON.stringify(bare) === JSON.stringify(['--resume', UUID_A, '-p', '--output-format', 'json',
    '--agent', 'implementer', 'hi']),
    `bare default-OFF resume must omit --settings: ${JSON.stringify(bare)}`);
  const bareOpt = Engines.buildClaudeResumeArgv(UUID_A, 'hi', { agent: 'implementer', disableGitkrakenHooks: true });
  assert(JSON.stringify(bareOpt) === JSON.stringify(['--resume', UUID_A, '-p', '--output-format', 'json',
    '--agent', 'implementer', '--settings', BYPASS_JSON, 'hi']),
    `bare opt-in resume must add only --settings: ${JSON.stringify(bareOpt)}`);
  console.log('ok: C3 resume argv default OFF omits, opt-in carries full flag set + bypass');
}

// C4: invalid JSON impossible by construction: the constant parses, has
// stable key order, and is byte-identical to the exported constant.
{
  assert(Engines.CLAUDE_SCOPED_BYPASS_SETTINGS_JSON === BYPASS_JSON,
    'exported constant must be byte-identical to the asserted element');
  const parsed = JSON.parse(Engines.CLAUDE_SCOPED_BYPASS_SETTINGS_JSON);
  assert(parsed.enabledPlugins?.['gitkraken-hooks@gitkraken'] === false,
    'parsed bypass must disable exactly gitkraken-hooks@gitkraken');
  assert(JSON.stringify(Object.keys(parsed)) === JSON.stringify(['enabledPlugins']) &&
    JSON.stringify(Object.keys(parsed.enabledPlugins)) === JSON.stringify(['gitkraken-hooks@gitkraken']),
    'bypass JSON key order must be stable');
  assert(Engines.CLAUDE_SCOPED_BYPASS_PLUGIN_ID === 'gitkraken-hooks@gitkraken',
    'plugin id constant must match');
  assert(/explicit opt-in only.*default OFF/i.test(Engines.CLAUDE_SCOPED_BYPASS_NOTICE.orthogonality ?? ''),
    `notice orthogonality must state explicit opt-in default OFF: ${JSON.stringify(Engines.CLAUDE_SCOPED_BYPASS_NOTICE)}`);
  console.log('ok: C4 bypass JSON parses from the constant (stable key order, byte-identical) + notice states opt-in');
}

// C5: plugin-absent behavior is identical except the inert element choice (no
// other argv drift), and the bypass never carries task content.
{
  const withEmpty = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'MARKER-xyz-123', sessionId: UUID_A, disableGitkrakenHooks: true });
  process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = path.join(clProjects, 'does-not-exist');
  const withMissing = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'MARKER-xyz-123', sessionId: UUID_A, disableGitkrakenHooks: true });
  process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;
  assert(JSON.stringify(withEmpty) === JSON.stringify(withMissing),
    'opt-in argv must not depend on any plugin presence probe (no drift between states)');
  const markerCount = withEmpty.filter((el) => String(el).includes('MARKER-xyz-123')).length;
  assert(markerCount === 1 && withEmpty.at(-1) === 'MARKER-xyz-123',
    'task text must ride exactly once as the trailing prompt');
  assert(!BYPASS_JSON.includes('MARKER-xyz-123') && !withEmpty.slice(0, -1).some((el) => String(el).includes('MARKER-xyz-123')),
    'the bypass element must never carry task content');
  assert(!withEmpty.includes('--safe-mode') && !withEmpty.includes('--bare'),
    '--safe-mode/--bare must never ride as a bypass substitute');
  const resume = Engines.buildClaudeResumeArgv(UUID_A, 'MARKER-xyz-123', { agent: 'implementer', disableGitkrakenHooks: true });
  assert(!resume.includes('--safe-mode') && !resume.includes('--bare'), 'resume must not use --safe-mode/--bare either');
  const offEmpty = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'MARKER-xyz-123', sessionId: UUID_A });
  assert(!offEmpty.includes('--settings'), 'default OFF omits --settings regardless of plugin state');
  console.log('ok: C5 plugin-absent identical (constant argv when opted in, omitted when OFF), bypass carries no task content, no --safe-mode/--bare');
}

// C6: preview surfaces the bypass ONLY on opt-in: argv_preview carries the
// exact element + named scoped_bypass notice; default OFF omits both but
// still names the opt-in in engine_note; non-claude previews omit it.
{
  const previewOn = Engines.buildLaunchPreview({
    engine: 'claude', executable: 'claude',
    argvPreview: Engines.buildClaudeArgv({ agent: 'implementer', prompt: '<worker prompt 10 chars>', sessionId: UUID_A, disableGitkrakenHooks: true }),
    promptChars: 10, agent: 'implementer', modelConfigured: 'claude-sonnet-5-5', effortConfigured: 'high',
    modelExplicit: false, effortExplicit: false, workdir: '/tmp/w', delegationGroup: 'team',
    isCanary: false, timeoutMs: 300000, gateReason: 'ok', disableGitkrakenHooks: true,
    capability: { engine: 'claude', binary: { binary: 'claude', found: true, version: '2.1.289', evidence: 'x' }, definitionFound: true, definitionPath: 'p', authNote: 'a', ready: true, blocker: null }
  });
  assert(previewOn.argv_preview.includes('--settings') && previewOn.argv_preview.includes(BYPASS_JSON),
    'opt-in preview argv_preview must carry the exact bypass element');
  const notice = previewOn.scoped_bypass;
  assert(notice && notice.plugin === 'gitkraken-hooks@gitkraken' &&
    JSON.stringify(notice.argv_element) === JSON.stringify(BYPASS_PAIR) &&
    /hangs every tool-using run/.test(notice.reason ?? '') &&
    /no settings file is read or written/.test(notice.zero_files ?? ''),
    `opt-in preview must carry the named bypass notice (plugin + reason + zero-files): ${JSON.stringify(notice)}`);
  assert(/scoped bypass/.test(previewOn.engine_note ?? ''), 'opt-in preview engine_note prose must name the scoped bypass');
  const previewOff = Engines.buildLaunchPreview({
    engine: 'claude', executable: 'claude',
    argvPreview: Engines.buildClaudeArgv({ agent: 'implementer', prompt: '<worker prompt 10 chars>', sessionId: UUID_A }),
    promptChars: 10, agent: 'implementer', modelConfigured: 'claude-sonnet-5-5', effortConfigured: 'high',
    modelExplicit: false, effortExplicit: false, workdir: '/tmp/w', delegationGroup: 'team',
    isCanary: false, timeoutMs: 300000, gateReason: 'ok',
    capability: { engine: 'claude', binary: { binary: 'claude', found: true, version: '2.1.289', evidence: 'x' }, definitionFound: true, definitionPath: 'p', authNote: 'a', ready: true, blocker: null }
  });
  assert(!previewOff.argv_preview.includes('--settings'), 'default-OFF preview argv must omit --settings');
  assert(!('scoped_bypass' in previewOff), 'default-OFF preview must omit the scoped_bypass notice');
  assert(/OFF by default|default OFF/.test(previewOff.engine_note ?? ''), `default-OFF engine_note must state OFF by default: ${previewOff.engine_note}`);
  const ocPreview = Engines.buildLaunchPreview({
    engine: 'opencode', executable: 'opencode', argvPreview: ['run', 'x'],
    promptChars: 1, workdir: '/tmp/w', delegationGroup: 'team',
    isCanary: false, timeoutMs: 300000, gateReason: 'ok',
    capability: { engine: 'opencode', binary: { binary: 'opencode', found: true, version: 'v', evidence: 'x' }, definitionFound: true, definitionPath: 'p', authNote: 'a', ready: true, blocker: null }
  });
  assert(!('scoped_bypass' in ocPreview), 'non-claude previews must not carry the bypass notice');
  console.log('ok: C6 preview shows argv element + notice only on opt-in, OFF omits both (claude only)');
}

// C7-C8: MCP wiring through labeled shims: default OFF omits; opt-in ON
// carries the exact element on launch + verified --resume continuation;
// provenance conditional; ack prose conditional; follow-ups preserve choice.
{
  const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-bypass-shim-'));
  const argvLog = path.join(shimBin, 'claude-argv.log');
  await fsp.writeFile(argvLog, '');
  await fsp.writeFile(path.join(shimBin, 'fake-claude.mjs'), [
    `import fs from 'node:fs';`,
    `const args = process.argv.slice(2);`,
    `if (args[0] === '--version') { console.log('2.1.289'); process.exit(0); }`,
    `fs.appendFileSync(process.env.CLAUDE_ARGV_LOG ?? '/dev/null', JSON.stringify(args) + '\\n');`,
    `console.log('{"type":"result"}');`,
    `process.exit(0);`,
    ''
  ].join('\n'));
  const fakeBin = async (name, body) => {
    const p = path.join(shimBin, name);
    await fsp.writeFile(p, `#!/bin/sh\n${body}\n`);
    await fsp.chmod(p, 0o755);
    return p;
  };
  await fsp.writeFile(path.join(shimBin, 'claude'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-claude.mjs')}" "$@"\n`);
  await fsp.chmod(path.join(shimBin, 'claude'), 0o755);
  process.env.CLAUDE_ARGV_LOG = argvLog;
  process.env.CODEXPRO_CLAUDE_BIN = path.join(shimBin, 'claude');
  process.env.CODEXPRO_CODEX_BIN = await fakeBin('codex', 'echo "codex-cli 0.159.0"\nexit 0');
  process.env.CODEXPRO_OPENCODE_BIN = await fakeBin('opencode', 'echo "opencode v2.0.22"\nexit 0');

  const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-bypass-mcp-'));
  const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-bypass-deleghome-'));
  process.env.CODEXPRO_DELEGATION_DIR = delegHome;
  delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;

  const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
  const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
  const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
  const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));
  const config = loadConfig(['--root', wsRoot]);
  const server = createCodexProServer(config);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bypass-smoke', version: '1' }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name, args) => client.callTool({ name, arguments: args });
  const opened = await call('open_workspace', { root: wsRoot });
  assert(!opened.isError, 'open_workspace must succeed');
  const wid = opened.structuredContent.workspace_id;
  const wireLines = () => fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

  // Preview through MCP: default OFF omits; opt-in shows notice.
  const prevOff = await call('delegation_preview', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'bypass-prev-off', task: 'Do the thing.', delegation_group: 'team-bypass' });
  assert(!prevOff.isError, `default preview must succeed: ${JSON.stringify(prevOff.structuredContent)}`);
  assert(!('scoped_bypass' in (prevOff.structuredContent.preview ?? {})) && !prevOff.structuredContent.preview.argv_preview.includes(BYPASS_JSON),
    'default MCP preview must omit bypass notice + argv element');
  const prevOn = await call('delegation_preview', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'bypass-prev', task: 'Do the thing.', delegation_group: 'team-bypass', disable_gitkraken_hooks: true });
  assert(!prevOn.isError, `opt-in preview must succeed: ${JSON.stringify(prevOn.structuredContent)}`);
  assert(prevOn.structuredContent.preview.scoped_bypass?.plugin === 'gitkraken-hooks@gitkraken' &&
    prevOn.structuredContent.preview.argv_preview.includes(BYPASS_JSON),
    'opt-in MCP preview must surface the bypass notice + argv element');

  // Non-claude opt-in refused (never silently ignored).
  const badEngine = await call('delegation_preview', { workspace_id: wid, engine: 'codex', profile: 'CODEX_IMPLEMENTER', workdir: 'bypass-prev-bad', task: 'Do the thing.', delegation_group: 'team-bypass', disable_gitkraken_hooks: true, execution_policy: 'read-only' });
  assert(badEngine.isError && /disable_gitkraken_hooks_unsupported_for_engine/.test(JSON.stringify(badEngine.structuredContent ?? badEngine)),
    `non-claude opt-in must refuse claude-only: ${JSON.stringify(badEngine.structuredContent ?? badEngine)}`);

  // Launch default OFF: ack states OFF, wire omits --settings, provenance omits.
  const launchedOff = await call('delegation_launch', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'bypass-0', task: 'List files. Change nothing.', delegation_group: 'team-bypass', request_id: 'req-bypass-0', timeout_ms: 60000 });
  assert(!launchedOff.isError, `default launch failed: ${JSON.stringify(launchedOff.structuredContent)}`);
  assert(/bypass OFF by default/.test(JSON.stringify(launchedOff.content ?? [])), `default ack must state OFF by default: ${JSON.stringify(launchedOff.content ?? []).slice(0, 400)}`);
  assert(launchedOff.structuredContent.disable_gitkraken_hooks === false, 'default ack structured must carry disable_gitkraken_hooks:false');
  const runOff = launchedOff.structuredContent.run_id;
  const sidOff = launchedOff.structuredContent.session_id;
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runOff });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const launchWireOff = wireLines().at(-1);
  assert(!launchWireOff.includes('--settings'), `default wire launch must omit --settings: ${JSON.stringify(launchWireOff)}`);
  assert(launchWireOff.includes('--session-id') && launchWireOff.includes(sidOff), 'default wire must ride stable --session-id');
  const readOff = await call('delegation_read_result', { workspace_id: wid, run_id: runOff });
  assert(!readOff.isError && !('scoped_bypass' in (readOff.structuredContent.execution_provenance ?? {})),
    `default provenance must omit scoped_bypass: ${JSON.stringify(readOff.structuredContent.execution_provenance)}`);

  // Launch opt-in ON: ack names bypass, wire carries it, provenance reports it.
  const launched = await call('delegation_launch', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'bypass-1', task: 'List files. Change nothing.', delegation_group: 'team-bypass', request_id: 'req-bypass-1', timeout_ms: 60000, disable_gitkraken_hooks: true });
  assert(!launched.isError, `opt-in launch failed: ${JSON.stringify(launched.structuredContent)}`);
  const launchText = JSON.stringify(launched.content ?? []);
  assert(/scoped bypass disabling gitkraken-hooks@gitkraken/.test(launchText),
    `opt-in ack prose must name the scoped bypass: ${launchText.slice(0, 400)}`);
  assert(launched.structuredContent.disable_gitkraken_hooks === true, 'opt-in ack structured must carry disable_gitkraken_hooks:true');
  const runId = launched.structuredContent.run_id;
  const sid = launched.structuredContent.session_id;
  assert(/^[0-9a-f-]{36}$/.test(sid ?? ''), 'launch must mint a stable UUID session');
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const launchWire = wireLines().at(-1);
  {
    const idx = launchWire.indexOf('--settings');
    assert(idx >= 0 && launchWire[idx + 1] === BYPASS_JSON,
      `opt-in wire launch argv must carry the exact --settings element: ${JSON.stringify(launchWire)}`);
    assert(launchWire.includes('--session-id') && launchWire.includes(sid), 'wire launch must ride the stable --session-id');
  }

  // Provenance reports the bypass on read_result (opt-in only).
  const read1 = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read1.isError && read1.structuredContent.execution_provenance?.scoped_bypass?.plugin === 'gitkraken-hooks@gitkraken' &&
    JSON.stringify(read1.structuredContent.execution_provenance.scoped_bypass.argv_element) === JSON.stringify(BYPASS_PAIR),
    `opt-in provenance must report the bypass: ${JSON.stringify(read1.structuredContent.execution_provenance)}`);

  // Verified --resume continuation preserves the stored choice: opt-in run
  // resumes WITH bypass; default run continues WITHOUT.
  await fsp.writeFile(path.join(clProjects, 'slug', `${sid}.jsonl`), '{"type":"session"}\n');
  const q = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'bq', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
  assert(!q.isError && q.structuredContent.state === 'needs-input', 'question must reach needs-input');
  const before = wireLines().length;
  const a = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'ba', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'bq' } });
  assert(!a.isError && a.structuredContent.executed === true && a.structuredContent.continuation === 'resumed',
    `verified session must truly resume: ${JSON.stringify(a.structuredContent)}`);
  let contWire = null;
  for (let i = 0; i < 100; i += 1) {
    const lines = wireLines();
    if (lines.length === before + 1) { contWire = lines.at(-1); break; }
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert(contWire !== null, 'exactly one continuation worker must spawn');
  {
    const idx = contWire.indexOf('--settings');
    assert(contWire.includes('--resume') && contWire.includes(sid) && idx >= 0 && contWire[idx + 1] === BYPASS_JSON,
      `opt-in wire resume argv must carry --resume + the exact --settings element: ${JSON.stringify(contWire)}`);
  }
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  const done = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(done.structuredContent.state === 'completed' && done.structuredContent.attempts.length === 2,
    'continuation must complete as attempt 2');
  assert(done.structuredContent.execution_provenance?.scoped_bypass?.plugin === 'gitkraken-hooks@gitkraken',
    'provenance must still report the bypass after continuation');

  // Default-OFF continuation preserves OFF (no --settings on --session-id reuse).
  await fsp.writeFile(path.join(clProjects, 'slug', `${sidOff}.jsonl`), '{"type":"session"}\n');
  const q0 = await call('delegation_followup', { workspace_id: wid, run_id: runOff, checkpoint: { id: 'bq0', run_id: runOff, seq: 0, payload: {}, questions: [{ id: 'qq0', question: 'Proceed?' }] } });
  assert(!q0.isError && q0.structuredContent.state === 'needs-input', 'default question must reach needs-input');
  const before0 = wireLines().length;
  const a0 = await call('delegation_followup', { workspace_id: wid, run_id: runOff, checkpoint: { id: 'ba0', run_id: runOff, seq: 1, payload: { answer: 'yes' }, input_request_id: 'bq0' } });
  assert(!a0.isError && a0.structuredContent.executed === true, `default answer must dispatch: ${JSON.stringify(a0.structuredContent)}`);
  let contWire0 = null;
  for (let i = 0; i < 100; i += 1) {
    const lines = wireLines();
    if (lines.length === before0 + 1) { contWire0 = lines.at(-1); break; }
    await new Promise((r2) => setTimeout(r2, 100));
  }
  assert(contWire0 !== null, 'default continuation worker must spawn');
  assert(!contWire0.includes('--settings'), `default continuation must preserve OFF (no --settings): ${JSON.stringify(contWire0)}`);
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runOff });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') break;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  console.log('ok: C7-C8 MCP wiring (default OFF omits, opt-in carries on launch + verified-resume, provenance + ack conditional, follow-ups preserve choice)');
}

console.log('delegation-claude-bypass-smoke: PASS (no live model calls; labeled shims only)');
