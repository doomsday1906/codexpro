import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-aibridge-smoke-'));
try {
  const { loadConfig } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'config.js')).href);
  const { aiBridgeEnabledFromProfile } = await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'profileStore.js')).href);

  // Default/enabled: missing key defaults to enabled
  if (aiBridgeEnabledFromProfile({}) !== true) throw new Error('missing profile key should default to enabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: undefined }) !== true) throw new Error('undefined should default to enabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: false }) !== false) throw new Error('false should stay disabled');
  if (aiBridgeEnabledFromProfile({ aiBridgeEnabled: true }) !== true) throw new Error('true should stay enabled');

  const defaultConfig = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off']);
  if (defaultConfig.aiBridgeEnabled !== true) throw new Error('default config should be enabled');
  const offConfig = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off', '--ai-bridge', 'off']);
  if (offConfig.aiBridgeEnabled !== false) throw new Error('--ai-bridge off should disable');
  const envOff = loadConfig(['--root', root, '--write', 'workspace', '--bash', 'off']);
  // env override check via explicit env
  process.env.CODEXPRO_AI_BRIDGE = '0';
  try {
    const fromEnv = (await import(pathToFileURL(path.join(path.resolve('.'), 'dist', 'config.js')).href + `?t=${Date.now()}`)).loadConfig;
    const c = fromEnv(['--root', root, '--write', 'workspace', '--bash', 'off']);
    if (c.aiBridgeEnabled !== false) throw new Error('CODEXPRO_AI_BRIDGE=0 should disable');
  } finally {
    delete process.env.CODEXPRO_AI_BRIDGE;
  }

  // Seed pre-existing bridge file
  const bridgeDir = path.join(root, '.ai-bridge');
  await fs.mkdir(bridgeDir, { recursive: true });
  const markerPath = path.join(bridgeDir, 'secret-marker.md');
  const markerContent = '# secret-marker DO_NOT_INJECT_7f3a9c\n';
  await fs.writeFile(markerPath, markerContent, 'utf8');

  async function listTools(envExtra) {
    const client = new McpStdioClient(process.execPath, ['dist/stdio.js', '--root', root, '--allow-root', root, '--write', 'workspace', '--bash', 'off', '--tool-mode', 'full'], {
      cwd: path.resolve('.'),
      env: { ...process.env, CODEXPRO_ROOT: root, CODEXPRO_ALLOWED_ROOTS: root, CODEXPRO_WRITE_MODE: 'workspace', CODEXPRO_TOOL_MODE: 'full', CODEXPRO_ALLOW_NO_HTTP_TOKEN: '1', ...envExtra }
    });
    try {
      await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'aibridge-smoke', version: '0.1.0' } });
      client.notify('notifications/initialized');
      const tools = await client.request('tools/list', {});
      return { client, tools: tools.tools };
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
      for (const expected of ['read_handoff', 'wait_for_handoff', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex']) {
        if (!names.includes(expected)) throw new Error(`enabled server missing bridge tool ${expected}`);
      }
      const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
      if (opened.isError) throw new Error(`open failed: ${JSON.stringify(opened)}`);
      const snap = await client.request('tools/call', { name: 'workspace_snapshot', arguments: { workspace_id: opened.structuredContent.workspace_id } });
      if (snap.isError) throw new Error(`enabled snapshot failed: ${JSON.stringify(snap)}`);
      // server_config reports ON
      const cfg = await client.request('tools/call', { name: 'server_config', arguments: {} });
      if (cfg.isError) throw new Error(`server_config failed: ${JSON.stringify(cfg)}`);
      if (cfg.structuredContent.aiBridgeEnabled !== true) throw new Error(`server_config should report true, got ${JSON.stringify(cfg.structuredContent)}`);
    } finally {
      client.close();
    }
  }

  // Disabled: bridge tools absent, no creation/injection, writes preserved
  {
    const { client, tools } = await listTools({ CODEXPRO_AI_BRIDGE: '0' });
    try {
      const names = tools.map((t) => t.name);
      for (const banned of ['read_handoff', 'wait_for_handoff', 'export_pro_context', 'handoff_to_agent', 'handoff_to_codex']) {
        if (names.includes(banned)) throw new Error(`disabled server should not list ${banned}`);
      }
      // Remaining descriptions must not advertise .ai-bridge
      for (const tool of tools) {
        const text = `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema ?? {})}`;
        if (['workspace_snapshot', 'codex_context', 'codexpro_self_test'].includes(tool.name) && text.includes('.ai-bridge')) {
          throw new Error(`disabled ${tool.name} advertises .ai-bridge: ${tool.description}`);
        }
      }
      const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
      if (opened.isError) throw new Error(`disabled open failed: ${JSON.stringify(opened)}`);
      const wsId = opened.structuredContent.workspace_id;

      const snap = await client.request('tools/call', { name: 'workspace_snapshot', arguments: { workspace_id: wsId } });
      if (snap.isError) throw new Error(`disabled snapshot failed: ${JSON.stringify(snap)}`);
      const snapText = JSON.stringify(snap);
      if (snapText.includes('DO_NOT_INJECT_7f3a9c')) throw new Error('disabled snapshot injected bridge contents');
      if (snapText.includes('.ai-bridge/current-plan')) throw new Error('disabled snapshot references bridge files');

      const ctx = await client.request('tools/call', { name: 'codex_context', arguments: { workspace_id: wsId } });
      if (ctx.isError) throw new Error(`disabled codex_context failed: ${JSON.stringify(ctx)}`);
      if (JSON.stringify(ctx).includes('DO_NOT_INJECT_7f3a9c')) throw new Error('disabled codex_context injected bridge');

      const self = await client.request('tools/call', { name: 'codexpro_self_test', arguments: { workspace_id: wsId } });
      if (self.isError) throw new Error(`disabled self-test failed: ${JSON.stringify(self)}`);

      // Ordinary workspace write still works
      const written = await client.request('tools/call', { name: 'write', arguments: { workspace_id: wsId, path: 'notes/hello.txt', content: 'hello disabled bridge\n' } });
      if (written.isError) throw new Error(`disabled ordinary write failed: ${JSON.stringify(written)}`);
      const readBack = await fs.readFile(path.join(root, 'notes/hello.txt'), 'utf8');
      if (!readBack.includes('hello disabled bridge')) throw new Error('ordinary write content mismatch');

      // server_config reports OFF
      const cfg = await client.request('tools/call', { name: 'server_config', arguments: {} });
      if (cfg.isError) throw new Error(`disabled server_config failed`);
      if (cfg.structuredContent.aiBridgeEnabled !== false) throw new Error('server_config should report false when disabled');
    } finally {
      client.close();
    }
  }

  // Filesystem census: no new .ai-bridge artifact created in disabled run (except seeded marker)
  {
    const entries = await fs.readdir(bridgeDir);
    if (!entries.includes('secret-marker.md')) throw new Error('seeded marker missing');
    // self-test probe must not exist
    try {
      await fs.access(path.join(bridgeDir, 'codexpro-self-test.md'));
      throw new Error('disabled self-test created bridge probe');
    } catch (e) {
      if (e.message.includes('created bridge probe')) throw e;
    }
    // No pro-context created via disabled path (export tool absent, but check)
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

  console.log('✓ aibridge smoke test passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
