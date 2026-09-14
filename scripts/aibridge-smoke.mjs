import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

class McpStdioClient {
  constructor(command, args, options = {}) {
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      while (true) {
        const index = this.buffer.indexOf('\n');
        if (index < 0) break;
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id == null) continue;
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
  }
  request(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`);
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  close() {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
  }
}

function cliRun(args, env) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`codexpro ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

function cliFail(args, env, pattern) {
  const result = spawnSync(process.execPath, ['scripts/codexpro.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status === 0) {
    throw new Error(`codexpro ${args.join(' ')} unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (pattern && !pattern.test(output)) {
    throw new Error(`codexpro ${args.join(' ')} failed for the wrong reason\n${output}`);
  }
  return output;
}

function helperFail(script, args, env, pattern) {
  const result = spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status === 0) {
    throw new Error(`node scripts/${script} ${args.join(' ')} unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (pattern && !pattern.test(output)) {
    throw new Error(`node scripts/${script} ${args.join(' ')} failed for the wrong reason\n${output}`);
  }
  return output;
}

async function readProfile(root, home) {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return JSON.parse(await fs.readFile(path.join(home, 'profiles', `${id}.json`), 'utf8'));
}

async function census(root) {
  const entries = [];
  async function walk(dir, rel) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        entries.push(`${r}/`);
        await walk(abs, r);
      } else {
        entries.push(r);
      }
    }
  }
  await walk(root, '');
  return entries;
}

const BRIDGE_TOOLS = ['read_handoff', 'wait_for_handoff', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex'];
const BRIDGE_ALIASES = ['handoff_poll', 'pro_export', 'agent_handoff', 'codex_handoff'];

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-smoke-'));
const cliRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-cli-'));
const cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-home-'));
const tempDirs = [root, cliRoot, cliHome];
try {
  const { loadConfig } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'config.js')).href);
  const { aiBridgeEnabledFromProfile } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'profileStore.js')).href);

  // ---- 1. Profile/config defaults + strict parsing ----
  if (aiBridgeEnabledFromProfile({}) !== true) throw new Error('missing profile key should default to enabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: undefined }) !== true) throw new Error('undefined should default to enabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: null }) !== true) throw new Error('null should default to enabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: false }) !== false) throw new Error('false should stay disabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: true }) !== true) throw new Error('true should stay enabled');
  for (const spelling of ['on', 'ON', 'off', 'OFF', 'true', 'false', '1', '0', 'yes', 'no', 'enabled', 'disabled']) {
    const expected = ['on', 'true', '1', 'yes', 'enabled'].includes(spelling.toLowerCase());
    const got = aiBridgeEnabledFromProfile({ aiBridgeEnabled: spelling });
    if (got !== expected) throw new Error(`profile spelling ${spelling} should be ${expected}`);
  }
  let malformedProfileFailed = false;
  try {
    aiBridgeEnabledFromProfile({ aiBridgeEnabled: 'definitely-not-off' });
  } catch (error) {
    malformedProfileFailed = true;
    if (!/Invalid aiBridgeEnabled profile value/i.test(String(error.message))) {
      throw new Error(`malformed profile wrong error: ${error.message}`);
    }
  }
  if (!malformedProfileFailed) throw new Error('malformed profile value should throw, not default ON');

  const defaultConfig = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off']);
  if (defaultConfig.aiBridgeEnabled !== true) throw new Error('default config should be enabled');
  const offConfig = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off', '--ai-bridge', 'off']);
  if (offConfig.aiBridgeEnabled !== false) throw new Error('--ai-bridge off should disable');
  for (const spelling of ['on', 'off', 'true', 'false', '1', '0', 'yes', 'no', 'enabled', 'disabled']) {
    const expected = ['on', 'true', '1', 'yes', 'enabled'].includes(spelling);
    const c = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off', '--ai-bridge', spelling]);
    if (c.aiBridgeEnabled !== expected) throw new Error(`CLI spelling ${spelling} should be ${expected}`);
  }
  let badCliFailed = false;
  try {
    loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off', '--ai-bridge', 'garbage']);
  } catch (error) {
    badCliFailed = true;
    if (!/--ai-bridge must be on or off/i.test(String(error.message))) {
      throw new Error(`bad CLI wrong error: ${error.message}`);
    }
  }
  if (!badCliFailed) throw new Error('invalid --ai-bridge should throw, not default ON');
  process.env.CODEXPRO_AI_BRIDGE = '0';
  try {
    const fromEnv = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off']);
    if (fromEnv.aiBridgeEnabled !== false) throw new Error('CODEXPRO_AI_BRIDGE=0 should disable');
  } finally {
    delete process.env.CODEXPRO_AI_BRIDGE;
  }
  process.env.CODEXPRO_AI_BRIDGE = 'garbage';
  let badEnvFailed = false;
  try {
    loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off']);
  } catch (error) {
    badEnvFailed = true;
    if (!/CODEXPRO_AI_BRIDGE must be on or off/i.test(String(error.message))) {
      throw new Error(`bad env wrong error: ${error.message}`);
    }
  } finally {
    delete process.env.CODEXPRO_AI_BRIDGE;
  }
  if (!badEnvFailed) throw new Error('invalid CODEXPRO_AI_BRIDGE should throw, not default ON');

  // ---- 2. Saved-profile CLI behavior (persisted OFF) ----
  const cliEnv = { ...process.env, CODEXPRO_HOME: cliHome };
  await fs.writeFile(path.join(cliRoot, 'plan.md'), '# CLI Proof Plan\n\nDo things.\n', 'utf8');
  const cliBridgeDir = path.join(cliRoot, '.ai-bridge');
  await fs.mkdir(cliBridgeDir, { recursive: true });
  const cliMarkerPath = path.join(cliBridgeDir, 'secret-marker.md');
  const cliMarkerContent = '# secret-marker DO_NOT_INJECT_CLI_OFF\n';
  await fs.writeFile(cliMarkerPath, cliMarkerContent, 'utf8');
  cliRun(['settings', 'set', '--root', cliRoot, '--tunnel', 'none', '--ai-bridge', 'off'], cliEnv);
  const offProfile = await readProfile(cliRoot, cliHome);
  if (offProfile.aiBridgeEnabled !== false) throw new Error('saved OFF not persisted');
  const beforeCensus = await census(cliRoot);

  const bridgeErr = /AI Bridge is disabled/i;
  cliFail(['pro-apply', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md')], cliEnv, bridgeErr);
  cliFail(['apply', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md')], cliEnv, bridgeErr);
  helperFail('pro-apply.mjs', ['--root', cliRoot, '--file', path.join(cliRoot, 'plan.md')], cliEnv, bridgeErr);
  cliFail(['pro-bundle', '--root', cliRoot, '--no-diff', '--no-changed-files'], cliEnv, bridgeErr);
  cliFail(['bundle', '--root', cliRoot, '--no-diff', '--no-changed-files'], cliEnv, bridgeErr);
  helperFail('pro-bundle.mjs', ['--root', cliRoot, '--no-diff', '--no-changed-files'], cliEnv, bridgeErr);
  cliFail(['execute-handoff', '--root', cliRoot, '--agent', 'opencode'], cliEnv, bridgeErr);
  cliFail(['execute', '--root', cliRoot, '--agent', 'opencode'], cliEnv, bridgeErr);
  cliFail(['watch-handoff', '--root', cliRoot, '--agent', 'opencode', '--yes'], cliEnv, bridgeErr);
  cliFail(['watch', '--root', cliRoot, '--agent', 'opencode', '--yes'], cliEnv, bridgeErr);
  cliFail(['loop-handoff', '--root', cliRoot, '--agent', 'opencode', '--yes', '--review-command', 'true'], cliEnv, bridgeErr);
  cliFail(['loop', '--root', cliRoot, '--agent', 'opencode', '--yes', '--review-command', 'true'], cliEnv, bridgeErr);
  const afterCensus = await census(cliRoot);
  if (JSON.stringify(beforeCensus) !== JSON.stringify(afterCensus)) {
    throw new Error(`OFF CLI created/modified files.\nbefore: ${JSON.stringify(beforeCensus)}\nafter: ${JSON.stringify(afterCensus)}`);
  }
  const markerAfter = await fs.readFile(cliMarkerPath, 'utf8');
  if (markerAfter !== cliMarkerContent) throw new Error('pre-existing bridge marker was modified while OFF');

  // Invalid CLI value must fail, never silently ON
  cliFail(['settings', 'set', '--root', cliRoot, '--tunnel', 'none', '--ai-bridge', 'definitely-not-off'], cliEnv, /--ai-bridge must be on or off/i);

  // ---- 2b. --no-profile parity: saved OFF ignored, CLI > env > default ----
  {
    const noProfilePlan = await fs.readFile(path.join(cliRoot, '.ai-bridge', 'current-plan.md'), 'utf8').catch(() => null);
    if (noProfilePlan !== null) throw new Error('current-plan.md should not exist before --no-profile runs');
    cliRun(['pro-apply', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md'), '--no-profile'], cliEnv);
    cliRun(['apply', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md'), '--no-profile'], cliEnv);
    const directApply = spawnSync(process.execPath, ['scripts/pro-apply.mjs', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md'), '--no-profile'], {
      cwd: path.resolve('.'),
      env: cliEnv,
      encoding: 'utf8'
    });
    if (directApply.status !== 0) throw new Error(`direct pro-apply --no-profile failed\n${directApply.stdout}\n${directApply.stderr}`);
    cliRun(['pro-bundle', '--root', cliRoot, '--no-diff', '--no-changed-files', '--no-profile'], cliEnv);
    cliRun(['bundle', '--root', cliRoot, '--no-diff', '--no-changed-files', '--no-profile'], cliEnv);
    const directBundle = spawnSync(process.execPath, ['scripts/pro-bundle.mjs', '--root', cliRoot, '--no-diff', '--no-changed-files', '--no-profile'], {
      cwd: path.resolve('.'),
      env: cliEnv,
      encoding: 'utf8'
    });
    if (directBundle.status !== 0) throw new Error(`direct pro-bundle --no-profile failed\n${directBundle.stdout}\n${directBundle.stderr}`);
    const wrotePlan = await fs.readFile(path.join(cliRoot, '.ai-bridge', 'current-plan.md'), 'utf8');
    if (!wrotePlan.includes('CLI Proof Plan')) throw new Error('--no-profile pro-apply did not write expected plan');
    await fs.access(path.join(cliRoot, '.ai-bridge', 'pro-context.md'));
    const markerNoProfile = await fs.readFile(cliMarkerPath, 'utf8');
    if (markerNoProfile !== cliMarkerContent) throw new Error('--no-profile run modified pre-existing marker');
    // Explicit env OFF still overrides --no-profile
    const envOffNoProfile = { ...cliEnv, CODEXPRO_AI_BRIDGE: 'off' };
    cliFail(['pro-apply', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md'), '--no-profile'], envOffNoProfile, bridgeErr);
    cliFail(['pro-bundle', '--root', cliRoot, '--no-diff', '--no-changed-files', '--no-profile'], envOffNoProfile, bridgeErr);
    // Explicit CLI OFF still overrides --no-profile
    cliFail(['pro-apply', '--root', cliRoot, '--file', path.join(cliRoot, 'plan.md'), '--ai-bridge', 'off', '--no-profile'], cliEnv, bridgeErr);
    cliFail(['pro-bundle', '--root', cliRoot, '--no-diff', '--no-changed-files', '--ai-bridge', 'off', '--no-profile'], cliEnv, bridgeErr);
  }

  // ---- 2c. Fresh-root OFF: blocked paths leave .ai-bridge absent ----
  {
    const freshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-fresh-'));
    tempDirs.push(freshRoot);
    await fs.writeFile(path.join(freshRoot, 'plan.md'), '# Fresh Plan\n\nWork.\n', 'utf8');
    cliRun(['settings', 'set', '--root', freshRoot, '--tunnel', 'none', '--ai-bridge', 'off'], cliEnv);
    cliFail(['pro-apply', '--root', freshRoot, '--file', path.join(freshRoot, 'plan.md')], cliEnv, bridgeErr);
    helperFail('pro-apply.mjs', ['--root', freshRoot, '--file', path.join(freshRoot, 'plan.md')], cliEnv, bridgeErr);
    cliFail(['pro-bundle', '--root', freshRoot, '--no-diff', '--no-changed-files'], cliEnv, bridgeErr);
    helperFail('pro-bundle.mjs', ['--root', freshRoot, '--no-diff', '--no-changed-files'], cliEnv, bridgeErr);
    cliFail(['execute-handoff', '--root', freshRoot, '--agent', 'opencode'], cliEnv, bridgeErr);
    let bridgeExists = true;
    try {
      await fs.access(path.join(freshRoot, '.ai-bridge'));
      bridgeExists = true;
    } catch {
      bridgeExists = false;
    }
    if (bridgeExists) throw new Error('fresh-root OFF run created .ai-bridge');
  }

  // ---- 2d. Malformed saved profile must never display as ON ----
  {
    const realCliRoot = await fs.realpath(cliRoot);
    const malformedId = createHash('sha256').update(realCliRoot).digest('hex').slice(0, 24);
    const malformedPath = path.join(cliHome, 'profiles', `${malformedId}.json`);
    const savedRaw = await fs.readFile(malformedPath, 'utf8');
    try {
      const poisoned = JSON.parse(savedRaw);
      poisoned.aiBridgeEnabled = 'garbage';
      await fs.writeFile(malformedPath, `${JSON.stringify(poisoned, null, 2)}\n`, 'utf8');
      const showResult = spawnSync(process.execPath, ['scripts/codexpro.mjs', 'settings', 'show', '--root', cliRoot], {
        cwd: path.resolve('.'),
        env: cliEnv,
        encoding: 'utf8'
      });
      const showOutput = `${showResult.stdout}\n${showResult.stderr}`;
      if (showResult.status === 0) throw new Error(`malformed settings show unexpectedly succeeded\n${showOutput}`);
      if (!/aiBridgeEnabled profile value must be on or off/i.test(showOutput)) {
        throw new Error(`malformed settings show wrong error\n${showOutput}`);
      }
      if (/AI Bridge\s+on/i.test(showOutput)) throw new Error(`malformed profile displayed as ON\n${showOutput}`);
      const listResult = spawnSync(process.execPath, ['scripts/codexpro.mjs', 'settings', 'list'], {
        cwd: path.resolve('.'),
        env: cliEnv,
        encoding: 'utf8'
      });
      if (/AI Bridge\s+on/i.test(`${listResult.stdout}\n${listResult.stderr}`)) {
        throw new Error('settings list misreported malformed profile as ON');
      }
    } finally {
      await fs.writeFile(malformedPath, savedRaw, 'utf8');
    }
    const restored = await readProfile(cliRoot, cliHome);
    if (restored.aiBridgeEnabled !== false) throw new Error('profile restore after malformed test failed');
  }

  // ---- 3. MCP catalog/context neutrality with OFF ----
  const bridgeDir = path.join(root, '.ai-bridge');
  await fs.mkdir(bridgeDir, { recursive: true });
  const markerPath = path.join(bridgeDir, 'secret-marker.md');
  const markerContent = '# secret-marker DO_NOT_INJECT_7f3a9c\n';
  await fs.writeFile(markerPath, markerContent, 'utf8');

  async function listTools(envExtra) {
    const client = new McpStdioClient(process.execPath, ['dist/stdio.js', '--root', root, '--allow-root', root, '--write', 'workspace', '--bash', 'off', '--tool-mode', 'full', '--tool-cards', 'on'], {
      cwd: path.resolve('.'),
      env: { ...process.env, CODEXPRO_ROOT: root, CODEXPRO_ALLOWED_ROOTS: root, CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'full', CODEXPRO_BASH_MODE: 'off', CODEXPRO_TOOL_CARDS: '1', CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1', ...envExtra }
    });
    try {
      const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aibridge-smoke', version: '0.1.0' } });
      client.notify('notifications/initialized');
      const tools = await client.request('tools/list', {});
      return { client, init, tools: tools.tools };
    } catch (e) {
      client.close();
      throw e;
    }
  }

  // Enabled: bridge tools present
  {
    const { client, tools } = await listTools({ CODEXPRO_AI_BRIDGE: '1' });
    try {
      const names = tools.map((t) => t.name);
      for (const expected of BRIDGE_TOOLS) {
        if (!names.includes(expected)) throw new Error(`enabled server missing bridge tool ${expected}`);
      }
      const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
      if (opened.isError) throw new Error(`open failed: ${JSON.stringify(opened)}`);
      const snap = await client.request('tools/call', { name: 'workspace_snapshot', arguments: { workspace_id: opened.structuredContent.workspace_id } });
      if (snap.isError) throw new Error(`enabled snapshot failed: ${JSON.stringify(snap)}`);
      const cfg = await client.request('tools/call', { name: 'server_config', arguments: {} });
      if (cfg.isError) throw new Error('server_config failed');
      if (cfg.structuredContent.aiBridgeEnabled !== true) throw new Error(`server_config should report true, got ${JSON.stringify(cfg.structuredContent)}`);
    } finally {
      client.close();
    }
  }

  // Disabled: full neutrality matrix
  {
    const { client, init, tools } = await listTools({ CODEXPRO_AI_BRIDGE: '0' });
    try {
      const initBlob = JSON.stringify(init);
      if (initBlob.includes('AI Bridge')) throw new Error('disabled init instructions mention AI Bridge');
      if (initBlob.includes('.ai-bridge')) throw new Error('disabled init instructions mention .ai-bridge');

      const names = tools.map((t) => t.name);
      for (const banned of BRIDGE_TOOLS) {
        if (names.includes(banned)) throw new Error(`disabled server should not list ${banned}`);
      }
      const toolsBlob = JSON.stringify(tools);
      if (toolsBlob.includes('AI Bridge')) throw new Error('disabled tools/list advertises AI Bridge');
      if (toolsBlob.includes('.ai-bridge')) throw new Error('disabled tools/list advertises .ai-bridge');

      const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
      if (opened.isError) throw new Error(`disabled open failed: ${JSON.stringify(opened)}`);
      const wsId = opened.structuredContent.workspace_id;

      const snap = await client.request('tools/call', { name: 'workspace_snapshot', arguments: { workspace_id: wsId } });
      if (snap.isError) throw new Error(`disabled snapshot failed: ${JSON.stringify(snap)}`);
      const snapText = JSON.stringify(snap);
      if (snapText.includes('DO_NOT_INJECT_7f3a9c')) throw new Error('disabled snapshot injected bridge contents');
      if (snapText.includes('.ai-bridge/current-plan')) throw new Error('disabled snapshot references bridge files');
      if (snapText.includes('AI Bridge')) throw new Error('disabled snapshot mentions AI Bridge');

      const ctx = await client.request('tools/call', { name: 'codex_context', arguments: { workspace_id: wsId } });
      if (ctx.isError) throw new Error(`disabled codex_context failed: ${JSON.stringify(ctx)}`);
      const ctxText = JSON.stringify(ctx);
      if (ctxText.includes('DO_NOT_INJECT_7f3a9c')) throw new Error('disabled codex_context injected bridge');
      if (ctxText.includes('AI Bridge Context')) throw new Error('disabled codex_context has bridge section');
      if (ctxText.includes('Skipped by request')) throw new Error('disabled codex_context has disabled placeholder');
      if (ctxText.includes('AI Bridge')) throw new Error('disabled codex_context mentions AI Bridge');
      if (ctxText.includes('.ai-bridge')) throw new Error('disabled codex_context mentions .ai-bridge');

      const self = await client.request('tools/call', { name: 'codexpro_self_test', arguments: { workspace_id: wsId } });
      if (self.isError) throw new Error(`disabled self-test failed: ${JSON.stringify(self)}`);
      const selfText = JSON.stringify(self);
      if (selfText.includes('AI Bridge')) throw new Error('disabled self-test mentions AI Bridge');
      if (selfText.includes('.ai-bridge')) throw new Error('disabled self-test mentions .ai-bridge');

      const written = await client.request('tools/call', { name: 'write', arguments: { workspace_id: wsId, path: 'notes/hello.txt', content: 'hello disabled bridge\n' } });
      if (written.isError) throw new Error(`disabled ordinary write failed: ${JSON.stringify(written)}`);
      const readBack = await fs.readFile(path.join(root, 'notes/hello.txt'), 'utf8');
      if (!readBack.includes('hello disabled bridge')) throw new Error('ordinary write content mismatch');

      const cfg = await client.request('tools/call', { name: 'server_config', arguments: {} });
      if (cfg.isError) throw new Error('disabled server_config failed');
      if (cfg.structuredContent.aiBridgeEnabled !== false) throw new Error('server_config should report false when disabled');

      const sup = await client.request('tools/call', { name: 'codexpro', arguments: { action: 'list_actions' } });
      if (sup.isError) throw new Error(`disabled list_actions failed: ${JSON.stringify(sup)}`);
      const actions = sup.structuredContent.actions;
      for (const banned of BRIDGE_TOOLS) {
        if (actions.includes(banned)) throw new Error(`disabled supertool should not list action ${banned}`);
      }
      const aliases = sup.structuredContent.aliases;
      for (const bannedAlias of BRIDGE_ALIASES) {
        if (aliases[bannedAlias] !== undefined) throw new Error(`disabled supertool should not advertise alias ${bannedAlias}`);
      }
      const aliasBlob = JSON.stringify(aliases);
      if (aliasBlob.includes('wait_for_handoff') || aliasBlob.includes('export_pro_context') || aliasBlob.includes('handoff_to_agent') || aliasBlob.includes('handoff_to_codex')) {
        throw new Error(`disabled supertool aliases leak bridge targets: ${aliasBlob}`);
      }
      // Invoking an old bridge alias must not reach a hidden writer
      const badAlias = await client.request('tools/call', { name: 'codexpro', arguments: { action: 'pro_export', args: {} } });
      if (!badAlias.isError) throw new Error('disabled bridge alias unexpectedly succeeded');
    } finally {
      client.close();
    }
  }

  // Filesystem census: no new .ai-bridge artifact created in disabled run
  {
    const entries = await fs.readdir(bridgeDir);
    if (!entries.includes('secret-marker.md')) throw new Error('seeded marker missing');
    try {
      await fs.access(path.join(bridgeDir, 'codexpro-self-test.md'));
      throw new Error('disabled self-test created bridge probe');
    } catch (e) {
      if (e.message.includes('created bridge probe')) throw e;
    }
    const markerAfter = await fs.readFile(markerPath, 'utf8');
    if (markerAfter !== markerContent) throw new Error('pre-existing bridge file was modified');
  }

  // Handoff mode + disabled must fail clearly before creating files
  {
    const { loadConfig: lc2 } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'config.js')).href);
    const { createCodexProServer } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'server.js')).href);
    const badConfig = { ...lc2(['--root', root, '--write', 'workspace', '--bash', 'off']), writeMode: 'handoff', aiBridgeEnabled: false };
    let failed = false;
    try {
      createCodexProServer(badConfig);
    } catch (e) {
      failed = true;
      if (!String(e.message).includes('handoff mode requires AI Bridge')) throw new Error(`wrong handoff error: ${e.message}`);
    }
    if (!failed) throw new Error('handoff+disabled should fail');
  }

  // ---- 4. Enabled CLI regression (pro-apply/pro-bundle work when ON) ----
  {
    const enHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-en-home-'));
    const enRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-en-root-'));
    tempDirs.push(enHome, enRoot);
    const enEnv = { ...process.env, CODEXPRO_HOME: enHome };
    await fs.writeFile(path.join(enRoot, 'plan.md'), '# Enabled Plan\n\nWork.\n', 'utf8');
    cliRun(['settings', 'set', '--root', enRoot, '--tunnel', 'none', '--ai-bridge', 'on'], enEnv);
    cliRun(['pro-apply', '--root', enRoot, '--file', path.join(enRoot, 'plan.md')], enEnv);
    cliRun(['pro-bundle', '--root', enRoot, '--no-diff', '--no-changed-files', '--no-ai-bridge'], enEnv);
    const applied = await fs.readFile(path.join(enRoot, '.ai-bridge', 'current-plan.md'), 'utf8');
    if (!applied.includes('Enabled Plan')) throw new Error('enabled pro-apply did not write plan');
  }

  console.log('✓ aibridge smoke test passed');
} finally {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
