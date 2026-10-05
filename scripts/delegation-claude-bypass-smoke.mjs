#!/usr/bin/env node
// Claude scoped-bypass smoke: per-invocation --settings disabling
// gitkraken-hooks@gitkraken rides EVERY claude argv (initial launch, stable
// --session-id creation, verified --resume continuation), is surfaced in
// preview (argv_preview + scoped_bypass notice), read_result
// execution_provenance, and the launch ack prose, and is inert when the
// plugin is absent (zero files touched, never task content, never a
// model/permission substitution; --safe-mode/--bare never used).
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

// C1: initial-launch argv is byte-exact: pre-change shape + exactly the one
// scoped --settings element immediately before the prompt.
{
  const argv = Engines.buildClaudeArgv({
    agent: 'implementer', prompt: 'Do the thing.', model: 'opus',
    effort: 'max', permissionMode: 'acceptEdits', allowedTools: 'Read',
    disallowedTools: 'Bash', sessionId: UUID_A
  });
  const expected = ['-p', '--output-format', 'json', '--agent', 'implementer',
    '--model', 'opus', '--effort', 'max', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read', '--disallowedTools', 'Bash',
    '--session-id', UUID_A, '--settings', BYPASS_JSON, 'Do the thing.'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `launch argv must be byte-exact (only addition: the --settings pair): ${JSON.stringify(argv)}`);
  console.log('ok: C1 initial-launch argv byte-exact (exact --settings element before prompt)');
}

// C2: bare launch (inherited model/effort, stable --session-id creation) is
// byte-exact: no invented flags, bypass still present.
{
  const argv = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'hi', sessionId: UUID_B });
  const expected = ['-p', '--output-format', 'json', '--agent', 'implementer',
    '--session-id', UUID_B, '--settings', BYPASS_JSON, 'hi'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `bare launch argv must be byte-exact: ${JSON.stringify(argv)}`);
  assert(!argv.includes('--model') && !argv.includes('--effort') && !argv.includes('--permission-mode'),
    'bare launch must still inherit (no invented explicit flags alongside the bypass)');
  console.log('ok: C2 stable-session-id creation argv byte-exact (inherits, bypass present)');
}

// C3: verified-resume argv is byte-exact: full explicit-flag set + bypass,
// --resume only (never --session-id alongside).
{
  const argv = Engines.buildClaudeResumeArgv(UUID_A, 'hi', {
    agent: 'implementer', permissionMode: 'acceptEdits', model: 'opus',
    effort: 'high', allowedTools: 'Read', disallowedTools: 'Bash'
  });
  const expected = ['--resume', UUID_A, '-p', '--output-format', 'json',
    '--agent', 'implementer', '--model', 'opus', '--effort', 'high',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'Read',
    '--disallowedTools', 'Bash', '--settings', BYPASS_JSON, 'hi'];
  assert(JSON.stringify(argv) === JSON.stringify(expected),
    `resume argv must be byte-exact: ${JSON.stringify(argv)}`);
  assert(!argv.includes('--session-id'), 'resume argv uses --resume only');
  const bare = Engines.buildClaudeResumeArgv(UUID_A, 'hi', { agent: 'implementer' });
  assert(JSON.stringify(bare) === JSON.stringify(['--resume', UUID_A, '-p', '--output-format', 'json',
    '--agent', 'implementer', '--settings', BYPASS_JSON, 'hi']),
    `bare resume argv must be byte-exact: ${JSON.stringify(bare)}`);
  console.log('ok: C3 resume argv byte-exact (full explicit-flag set + bypass, --resume only)');
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
  console.log('ok: C4 bypass JSON parses from the constant (stable key order, byte-identical)');
}

// C5: plugin-absent behavior is identical except the inert element (no other
// argv drift), and the bypass never carries task content.
{
  // No plugin state is ever inspected: empty vs populated projects dir, and
  // a missing plugin id, all yield identical argv (the element is constant).
  const withEmpty = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'MARKER-xyz-123', sessionId: UUID_A });
  process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = path.join(clProjects, 'does-not-exist');
  const withMissing = Engines.buildClaudeArgv({ agent: 'implementer', prompt: 'MARKER-xyz-123', sessionId: UUID_A });
  process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;
  assert(JSON.stringify(withEmpty) === JSON.stringify(withMissing),
    'argv must not depend on any plugin presence probe (no drift between states)');
  const markerCount = withEmpty.filter((el) => String(el).includes('MARKER-xyz-123')).length;
  assert(markerCount === 1 && withEmpty.at(-1) === 'MARKER-xyz-123',
    'task text must ride exactly once as the trailing prompt');
  assert(!BYPASS_JSON.includes('MARKER-xyz-123') && !withEmpty.slice(0, -1).some((el) => String(el).includes('MARKER-xyz-123')),
    'the bypass element must never carry task content');
  assert(!withEmpty.includes('--safe-mode') && !withEmpty.includes('--bare'),
    '--safe-mode/--bare must never ride as a bypass substitute');
  const resume = Engines.buildClaudeResumeArgv(UUID_A, 'MARKER-xyz-123', { agent: 'implementer' });
  assert(!resume.includes('--safe-mode') && !resume.includes('--bare'), 'resume must not use --safe-mode/--bare either');
  console.log('ok: C5 plugin-absent identical (constant argv), bypass carries no task content, no --safe-mode/--bare');
}

// C6: preview surfaces the bypass: argv_preview carries the exact element,
// the named scoped_bypass notice names the plugin + reason + zero-files, and
// non-claude previews omit it.
{
  const preview = Engines.buildLaunchPreview({
    engine: 'claude', executable: 'claude',
    argvPreview: Engines.buildClaudeArgv({ agent: 'implementer', prompt: '<worker prompt 10 chars>', sessionId: UUID_A }),
    promptChars: 10, agent: 'implementer', modelConfigured: 'claude-sonnet-5-5', effortConfigured: 'high',
    modelExplicit: false, effortExplicit: false, workdir: '/tmp/w', delegationGroup: 'team',
    isCanary: false, timeoutMs: 300000, gateReason: 'ok',
    capability: { engine: 'claude', binary: { binary: 'claude', found: true, version: '2.1.289', evidence: 'x' }, definitionFound: true, definitionPath: 'p', authNote: 'a', ready: true, blocker: null }
  });
  assert(preview.argv_preview.includes('--settings') && preview.argv_preview.includes(BYPASS_JSON),
    'preview argv_preview must carry the exact bypass element');
  const notice = preview.scoped_bypass;
  assert(notice && notice.plugin === 'gitkraken-hooks@gitkraken' &&
    JSON.stringify(notice.argv_element) === JSON.stringify(BYPASS_PAIR) &&
    /hangs every tool-using run/.test(notice.reason ?? '') &&
    /no settings file is read or written/.test(notice.zero_files ?? ''),
    `preview must carry the named bypass notice (plugin + reason + zero-files): ${JSON.stringify(notice)}`);
  assert(/scoped bypass/.test(preview.engine_note ?? ''), 'preview engine_note prose must name the scoped bypass');
  const ocPreview = Engines.buildLaunchPreview({
    engine: 'opencode', executable: 'opencode', argvPreview: ['run', 'x'],
    promptChars: 1, workdir: '/tmp/w', delegationGroup: 'team',
    isCanary: false, timeoutMs: 300000, gateReason: 'ok',
    capability: { engine: 'opencode', binary: { binary: 'opencode', found: true, version: 'v', evidence: 'x' }, definitionFound: true, definitionPath: 'p', authNote: 'a', ready: true, blocker: null }
  });
  assert(!('scoped_bypass' in ocPreview), 'non-claude previews must not carry the bypass notice');
  console.log('ok: C6 preview shows argv element + named scoped_bypass notice (claude only)');
}

// C7-C8: MCP wiring through labeled shims: wire argv (launch + verified
// --resume continuation) carries the exact element; provenance reports it;
// the launch ack prose names it.
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

  // Preview through MCP shows the notice (Hestia-visible without source).
  const prev = await call('delegation_preview', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'bypass-prev', task: 'Do the thing.', delegation_group: 'team-bypass' });
  assert(!prev.isError, `preview must succeed: ${JSON.stringify(prev.structuredContent)}`);
  assert(prev.structuredContent.preview.scoped_bypass?.plugin === 'gitkraken-hooks@gitkraken' &&
    prev.structuredContent.preview.argv_preview.includes(BYPASS_JSON),
    'MCP preview must surface the bypass notice + argv element');

  // Launch: ack prose names the bypass; wire argv carries the exact element.
  const launched = await call('delegation_launch', { workspace_id: wid, engine: 'claude', agent: 'implementer', workdir: 'bypass-1', task: 'List files. Change nothing.', delegation_group: 'team-bypass', request_id: 'req-bypass-1', timeout_ms: 60000 });
  assert(!launched.isError, `launch failed: ${JSON.stringify(launched.structuredContent)}`);
  const launchText = JSON.stringify(launched.content ?? []);
  assert(/scoped bypass disabling gitkraken-hooks@gitkraken/.test(launchText),
    `launch ack prose must name the scoped bypass: ${launchText.slice(0, 400)}`);
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
      `wire launch argv must carry the exact --settings element: ${JSON.stringify(launchWire)}`);
    assert(launchWire.includes('--session-id') && launchWire.includes(sid), 'wire launch must ride the stable --session-id');
  }

  // Provenance reports the bypass on read_result.
  const read1 = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read1.isError && read1.structuredContent.execution_provenance?.scoped_bypass?.plugin === 'gitkraken-hooks@gitkraken' &&
    JSON.stringify(read1.structuredContent.execution_provenance.scoped_bypass.argv_element) === JSON.stringify(BYPASS_PAIR),
    `provenance must report the bypass: ${JSON.stringify(read1.structuredContent.execution_provenance)}`);

  // Verified --resume continuation: plant the session file, then answer.
  await fsp.writeFile(path.join(clProjects, 'slug', `${sid}.jsonl`), '{"type":"session"}\n');
  const q = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'bq', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
  assert(!q.isError && q.structuredContent.state === 'needs-input', 'question must reach needs-input');
  const before = wireLines().length;
  const a = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'ba', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'bq' } });
  assert(!a.isError && a.structuredContent.executed === true && a.structuredContent.continuation === 'resumed',
    `verified session must truly resume: ${JSON.stringify(a.structuredContent)}`);
  // The spawn acknowledgement can precede shim boot: poll boundedly for the
  // wire line rather than asserting it immediately.
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
      `wire resume argv must carry --resume + the exact --settings element: ${JSON.stringify(contWire)}`);
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
  console.log('ok: C7-C8 MCP wiring (preview notice, launch + verified-resume wire argv, provenance, ack prose)');
}

console.log('delegation-claude-bypass-smoke: PASS (no live model calls; labeled shims only)');
