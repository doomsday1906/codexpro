import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  CLOUDFLARED_VERSION,
  cloudflaredReleaseAsset,
  cloudflaredReleaseUrl,
  readCloudflaredAssetResponse,
  verifyCloudflaredAsset
} from './cloudflared-release.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  descendantProcessIds,
  parseProcessTable,
  processTableInvocation,
  processTreeTerminationInvocation
} from './launcher-process-tree.mjs';

const portableMacProcessList = processTableInvocation('darwin');
if (portableMacProcessList.command !== 'ps' || portableMacProcessList.args.join(' ') !== '-A -o pid=,ppid=') {
  throw new Error(`macOS process discovery must use portable ps columns; got ${JSON.stringify(portableMacProcessList)}`);
}
const portableLinuxProcessList = processTableInvocation('linux');
if (portableLinuxProcessList.command !== 'ps' || portableLinuxProcessList.args.join(' ') !== '-A -o pid=,ppid=') {
  throw new Error(`Linux process discovery must use portable ps columns; got ${JSON.stringify(portableLinuxProcessList)}`);
}
const portableRows = parseProcessTable('41 7\n42 41\n43 42\nnot-a-process-row');
if (JSON.stringify(descendantProcessIds(portableRows, 41).sort((a, b) => a - b)) !== JSON.stringify([42, 43])) {
  throw new Error('portable process-table parser did not find transitive descendants');
}
const windowsTreeKill = processTreeTerminationInvocation('win32', 4242);
if (
  windowsTreeKill?.command !== 'taskkill.exe'
  || windowsTreeKill.args.join(' ') !== '/PID 4242 /T /F'
  || processTreeTerminationInvocation('linux', 4242) !== null
) {
  throw new Error(`Windows managed children must select recursive taskkill independently of wrapper type; got ${JSON.stringify(windowsTreeKill)}`);
}

const pinnedCloudflared = cloudflaredReleaseAsset('darwin', 'arm64');
if (
  CLOUDFLARED_VERSION !== '2026.7.2' ||
  !cloudflaredReleaseUrl(pinnedCloudflared).includes(`/download/${CLOUDFLARED_VERSION}/`) ||
  !/^[a-f0-9]{64}$/.test(pinnedCloudflared.sha256)
) {
  throw new Error('cloudflared release metadata is not pinned to an immutable version and digest');
}
try {
  verifyCloudflaredAsset(pinnedCloudflared, Buffer.from('tampered cloudflared fixture'));
  throw new Error('cloudflared checksum validation accepted a tampered download');
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('checksum mismatch')) throw error;
}
const oversizedAsset = { file: 'oversized-fixture', sha256: createHash('sha256').update('123456789').digest('hex') };
for (const response of [
  new Response('123456789', { headers: { 'content-length': '9' } }),
  new Response('123456789')
]) {
  try {
    await readCloudflaredAssetResponse(response, oversizedAsset, 8);
    throw new Error('cloudflared response cap accepted an oversized download');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('oversized cloudflared asset')) throw error;
  }
}

function run(args, env) {
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

function runFail(args, env, pattern) {
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

async function readProfile(root, home) {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return JSON.parse(await fs.readFile(path.join(home, 'profiles', `${id}.json`), 'utf8'));
}

async function runtimeStatusPath(root, home) {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return path.join(home, 'runtime', `${id}.json`);
}

async function runtimeFailurePath(root, home) {
  const realRoot = await fs.realpath(root);
  const id = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return path.join(home, 'runtime', `${id}.last-failure.json`);
}

async function writeNodeExecutable(filePath, lines, windowsCommandPath) {
  await fs.writeFile(filePath, lines.join('\n'), { mode: 0o700 });
  if (process.platform !== 'win32') return filePath;
  const commandPath = windowsCommandPath ?? path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}.cmd`
  );
  await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${filePath}" %*\r\n`, 'utf8');
  return commandPath;
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

async function waitForJson(filePath, predicate, label) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (predicate(data)) return data;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? 'predicate not met'}`);
}

async function waitForFileText(filePath, label) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = (await fs.readFile(filePath, 'utf8')).trim();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}: ${lastError?.message ?? 'file remained empty'}`);
}

async function waitForProcessExit(pid, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label} process ${pid} to exit`);
}

async function waitForLauncherClose(child, label, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs}ms`)), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function directChildPids(pid) {
  const invocation = processTableInvocation();
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect launcher child processes: ${result.error?.message ?? result.stderr}`);
  }
  return parseProcessTable(result.stdout)
    .filter((row) => row.parentPid === pid)
    .map((row) => row.pid);
}

function processSnapshot() {
  const invocation = processTableInvocation();
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`could not inspect managed process tree: ${result.error?.message ?? result.stderr}`);
  }
  return parseProcessTable(result.stdout);
}

async function reapProcess(pid, label) {
  if (!await processExists(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  const gracefulDeadline = Date.now() + 2_000;
  while (Date.now() < gracefulDeadline && await processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await processExists(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && await processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (await processExists(pid)) throw new Error(`could not reap ${label} process ${pid}`);
}

async function assertPortReusable(port, label) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function assertPathMissing(filePath, label) {
  try {
    await fs.access(filePath);
    throw new Error(`${label} unexpectedly remains: ${filePath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function startObservedLauncher(args, env, root, label) {
  const child = spawn(process.execPath, ['scripts/codexpro.mjs', 'start', ...args], {
    cwd: path.resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const runtimePath = await runtimeStatusPath(root, env.CODEXPRO_HOME);
  try {
    const runtime = await waitForJson(runtimePath, (value) => Number.isInteger(value.pid) && Number.isInteger(value.runtimePid), `${label} runtime status`);
    return { child, closed, runtime, runtimePath, failurePath: await runtimeFailurePath(root, env.CODEXPRO_HOME), output: () => output };
  } catch (error) {
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    throw new Error(`${error.message}\n${label} output:\n${output}`);
  }
}

async function createLauncherMcpClient(port) {
  const client = new Client({ name: 'launcher-supervision-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function startLauncherBeforeTunnelReady(args, env, tunnelPidPath, label) {
  const child = spawn(process.execPath, ['scripts/codexpro.mjs', 'start', ...args], {
    cwd: path.resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const tunnelPid = Number(await waitForFileText(tunnelPidPath, `${label} fake tunnel PID`));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const childPids = directChildPids(child.pid);
    const httpPid = childPids.find((pid) => pid !== tunnelPid);
    if (!Number.isInteger(httpPid)) {
      throw new Error(`launcher child list did not contain HTTP child PID; launcherPid=${child.pid}; childPids=${JSON.stringify(childPids)}; tunnelPid=${tunnelPid}`);
    }
    return { child, closed, tunnelPid, httpPid, output: () => output };
  } catch (error) {
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    throw new Error(`${error.message}\n${label} output:\n${output}`);
  }
}

async function withStartedCodexPro(args, env, fn, options = {}) {
  const child = spawn(process.execPath, ['scripts/codexpro.mjs', 'start', ...args], {
    cwd: path.resolve('.'),
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  let closed = false;
  const closedPromise = new Promise((resolve) => child.once('close', (code, signal) => {
    closed = true;
    resolve({ code, signal });
  }));
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    await fn(child);
  } catch (error) {
    throw new Error(`${error.message}\nstart output:\n${output}`);
  } finally {
    if (!closed) {
      if (process.platform === 'win32' && !options.forceKill) child.stdin.end('q\n');
      else child.kill('SIGTERM');
    }
    await closedPromise;
  }
}

function findPythonForPty() {
  if (process.platform === 'win32') return '';
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['-c', 'import pty, select, subprocess'], { stdio: 'ignore' });
    if (result.status === 0) return command;
  }
  return '';
}

function runInteractiveQuit(args, env) {
  const python = findPythonForPty();
  if (!python) return false;
  const payload = JSON.stringify({
    cmd: process.execPath,
    args: ['scripts/codexpro.mjs', 'start', ...args],
    cwd: path.resolve('.'),
    runtimePath: args[args.indexOf('--root') + 1]
  });
  const code = `
import json, os, pty, select, subprocess, sys, time
payload = json.loads(sys.argv[1])
master, slave = pty.openpty()
proc = subprocess.Popen([payload["cmd"]] + payload["args"], cwd=payload["cwd"], env=os.environ.copy(), stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
out = bytearray()
sent = False
deadline = time.time() + 20
while time.time() < deadline:
    if proc.poll() is not None:
        break
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        continue
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out.extend(chunk)
    if not sent and b"codexpro> " in out:
        runtime_path = payload["runtimePath"]
        runtime_dir = os.environ.get("CODEXPRO_HOME", os.path.expanduser("~/.codexpro"))
        runtime_id = __import__("hashlib").sha256(os.path.realpath(runtime_path).encode()).hexdigest()[:24]
        status_path = os.path.join(runtime_dir, "runtime", runtime_id + ".json")
        try:
            with open(status_path, encoding="utf-8") as status_file:
                runtime_snapshot = json.load(status_file)
        except (OSError, ValueError):
            runtime_snapshot = {}
        os.write(master, b"q")
        sent = True
if proc.poll() is None:
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    sys.stderr.write(out.decode(errors="replace"))
    raise SystemExit(124)
while True:
    ready, _, _ = select.select([master], [], [], 0)
    if not ready:
        break
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out.extend(chunk)
os.close(master)
sys.stdout.write(out.decode(errors="replace"))
if not sent:
    sys.stderr.write("control prompt was not reached\\n")
    raise SystemExit(125)
sys.stdout.write("\\nCODEXPRO_RUNTIME_SNAPSHOT:" + json.dumps(runtime_snapshot) + "\\n")
raise SystemExit(proc.returncode or 0)
`;
  const result = spawnSync(python, ['-c', code, payload], {
    cwd: path.resolve('.'),
    env: { ...env, NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`interactive quit failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  const snapshotLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('CODEXPRO_RUNTIME_SNAPSHOT:'));
  const runtime = snapshotLine ? JSON.parse(snapshotLine.slice('CODEXPRO_RUNTIME_SNAPSHOT:'.length)) : {};
  return { runtime, output: result.stdout };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-root-'));
const realRoot = await fs.realpath(root);
const reuseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-reuse-'));
const realReuseRoot = await fs.realpath(reuseRoot);
const policyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-policy-'));
const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-runtime-'));
const staleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-stale-'));
const ngrokRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-ngrok-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-home-'));
const env = { ...process.env, CODEXPRO_HOME: home };
function withoutProxyEnv(input) {
  const next = { ...input };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) delete next[key];
  return next;
}

const empty = run(['settings', 'show', '--root', root], env);
if (!empty.includes('No saved settings')) {
  throw new Error(`expected empty settings output, got:\n${empty}`);
}
const emptyEquals = run([`settings`, `show`, `--root=${root}`], env);
if (!emptyEquals.includes('No saved settings')) {
  throw new Error(`expected --root= settings output, got:\n${emptyEquals}`);
}

const saved = run([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-test.ngrok-free.app',
  '--port',
  '19087',
  '--mode',
  'agent',
  '--tool-mode',
  'full',
  '--bash-transcript',
  'full',
  '--widget-domain',
  'https://widgets.codexpro.test',
  '--tool-cards',
  'on',
  '--project',
  reuseRoot,
  '--token',
  'codexpro-settings-token'
], env);
if (!saved.includes('Saved workspace settings')) {
  throw new Error(`expected settings save output, got:\n${saved}`);
}

const shown = run(['settings', 'show', '--root', root], env);
for (const expected of ['Tunnel', 'ngrok', 'codexpro-test.ngrok-free.app', '19087', 'Tool cards', 'on', 'AI Bridge', 'on', 'Bash transcript', 'full', 'Projects', realReuseRoot, '<saved>']) {
  if (!shown.includes(expected)) {
    throw new Error(`settings show missing ${expected}\n${shown}`);
  }
}
if (shown.includes('codexpro-settings-token')) {
  throw new Error(`settings show leaked token\n${shown}`);
}
const profile = await readProfile(root, home);
if (
  profile.toolMode !== 'full'
  || profile.toolCards !== true
  || profile.bashTranscript !== 'full'
  || profile.widgetDomain !== 'https://widgets.codexpro.test'
  || JSON.stringify(profile.allowedRoots) !== JSON.stringify([realReuseRoot])
) {
  throw new Error(`settings profile did not persist tool/widget options: ${JSON.stringify(profile)}`);
}
run([
  'settings',
  'set',
  '--root',
  root,
  '--clear-projects'
], env);
const clearedProjectsProfile = await readProfile(root, home);
if (clearedProjectsProfile.allowedRoots !== undefined) {
  throw new Error(`settings profile did not clear saved projects: ${JSON.stringify(clearedProjectsProfile)}`);
}

run(['settings', 'set', '--root', root, '--ai-bridge', 'off'], env);
const bridgeOffProfile = await readProfile(root, home);
if (bridgeOffProfile.aiBridgeEnabled !== false) {
  throw new Error(`settings --ai-bridge off not persisted: ${JSON.stringify(bridgeOffProfile)}`);
}
const bridgeOffShown = run(['settings', 'show', '--root', root], env);
if (!bridgeOffShown.includes('AI Bridge') || !bridgeOffShown.includes('off')) {
  throw new Error(`settings show did not report AI Bridge off\n${bridgeOffShown}`);
}
run(['settings', 'set', '--root', root, '--ai-bridge', 'on'], env);
const bridgeOnProfile = await readProfile(root, home);
if (bridgeOnProfile.aiBridgeEnabled !== true) {
  throw new Error(`settings --ai-bridge on not persisted: ${JSON.stringify(bridgeOnProfile)}`);
}
// Malformed persisted value must fail display, never render as ON
{
  const realRoot = await fs.realpath(root);
  const malformedId = createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  const malformedPath = path.join(home, 'profiles', `${malformedId}.json`);
  const savedRaw = await fs.readFile(malformedPath, 'utf8');
  try {
    const poisoned = JSON.parse(savedRaw);
    poisoned.aiBridgeEnabled = 'garbage';
    await fs.writeFile(malformedPath, `${JSON.stringify(poisoned, null, 2)}\n`, 'utf8');
    runFail(['settings', 'show', '--root', root], env, /aiBridgeEnabled profile value must be on or off/i);
  } finally {
    await fs.writeFile(malformedPath, savedRaw, 'utf8');
  }
}
runFail(['settings', 'set', '--root', policyRoot, '--mode', 'handoff', '--ai-bridge', 'off'], env, /handoff mode requires AI Bridge/i);

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'cloudflare-named',
  '--hostname',
  'codexpro.example.com',
  '--cloudflare-token',
  'raw-cloudflare-token'
], env, /does not save raw --cloudflare-token/i);

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'http://policy.ngrok-free.app'
], env, /hostname must use https/i);

run([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'https://policy.ngrok-free.app/mcp',
  '--mode',
  'handoff',
  '--write',
  'workspace',
  '--ngrok-config',
  'ngrok.yml'
], env);
const policyProfile = await readProfile(policyRoot, home);
const realPolicyRoot = await fs.realpath(policyRoot);
if (policyProfile.write !== 'handoff' || policyProfile.hostname !== 'policy.ngrok-free.app' || policyProfile.ngrokConfig !== path.join(realPolicyRoot, 'ngrok.yml')) {
  throw new Error(`settings policy profile did not normalize write/path values: ${JSON.stringify(policyProfile)}`);
}
run([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none'
], env);
const localPolicyProfile = await readProfile(policyRoot, home);
if (localPolicyProfile.tunnel !== 'none' || localPolicyProfile.hostname || localPolicyProfile.ngrokConfig) {
  throw new Error(`settings local-only profile kept stale ngrok values: ${JSON.stringify(localPolicyProfile)}`);
}

run([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'tailscale',
  '--hostname',
  'https://codexpro-test.tailnet.ts.net/mcp'
], env);
const tailscalePolicyProfile = await readProfile(policyRoot, home);
if (tailscalePolicyProfile.tunnel !== 'tailscale' || tailscalePolicyProfile.hostname !== 'codexpro-test.tailnet.ts.net' || tailscalePolicyProfile.ngrokConfig) {
  throw new Error(`settings tailscale profile did not normalize/clear stale tunnel values: ${JSON.stringify(tailscalePolicyProfile)}`);
}

run([
  'settings',
  'set',
  '--root',
  staleRoot,
  '--tunnel',
  'cloudflare-named',
  '--hostname',
  'codexpro-stale.example.com',
  '--tunnel-name',
  'stale-tunnel',
  '--cloudflare-config',
  'cloudflared.yml',
  '--cloudflare-token-file',
  'cloudflare-token'
], env);
run([
  'settings',
  'set',
  '--root',
  staleRoot,
  '--tunnel',
  'cloudflare'
], env);
const quickProfile = await readProfile(staleRoot, home);
if (quickProfile.tunnel !== 'cloudflare' || quickProfile.hostname || quickProfile.tunnelName || quickProfile.cloudflareConfig || quickProfile.cloudflareTokenFile) {
  throw new Error(`settings quick tunnel profile kept stale named-tunnel values: ${JSON.stringify(quickProfile)}`);
}

runFail([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-test.ngrok-free.app',
  '--require-bash-session'
], env, /requires --bash-session/i);

const guarded = run([
  'settings',
  'set',
  '--root',
  root,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-test.ngrok-free.app',
  '--bash-session',
  'guarded-main',
  '--require-bash-session'
], env);
if (!guarded.includes('Bash session') || !guarded.includes('guarded-main required')) {
  throw new Error(`settings save did not display guarded bash session\n${guarded}`);
}
const guardedProfile = await readProfile(root, home);
if (guardedProfile.bashSession !== 'guarded-main' || guardedProfile.requireBashSession !== true) {
  throw new Error(`settings profile did not persist bash session guard: ${JSON.stringify(guardedProfile)}`);
}

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none',
  '--bash',
  'banana'
], env, /--bash must be off, safe, or full/i);

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none',
  '--tool-mode',
  'banana'
], env, /--tool-mode must be minimal, standard, or full/i);

runFail([
  'settings',
  'set',
  '--root',
  policyRoot,
  '--tunnel',
  'none',
  '--port',
  'abc'
], env, /Invalid port: abc/i);

const runtimePort = await getFreePort();
const runtimePath = await runtimeStatusPath(runtimeRoot, home);
run([
  'settings',
  'set',
  '--root',
  runtimeRoot,
  '--tunnel',
  'none',
  '--port',
  String(runtimePort),
  '--tool-cards',
  'on'
], env);
await withStartedCodexPro([
  '--root',
  runtimeRoot
], env, async (child) => {
  const runtime = await waitForJson(runtimePath, (data) => data.toolCards === true && data.pid === child.pid, 'tool-cards runtime status');
  if (runtime.toolCards !== true || runtime.pid !== child.pid) {
    throw new Error(`runtime status did not persist toolCards: ${JSON.stringify(runtime)}`);
  }
}, { forceKill: true });
const previousCodexProHome = process.env.CODEXPRO_HOME;
process.env.CODEXPRO_HOME = home;
try {
  const { readRuntimeConnection } = await import('../dist/profileStore.js');
  const stoppedRuntime = readRuntimeConnection(runtimeRoot);
  if (Object.keys(stoppedRuntime).length > 0) {
    throw new Error(`stale runtime status remained visible after launcher exit: ${JSON.stringify(stoppedRuntime)}`);
  }
} finally {
  if (previousCodexProHome === undefined) delete process.env.CODEXPRO_HOME;
  else process.env.CODEXPRO_HOME = previousCodexProHome;
}
try {
  await fs.access(runtimePath);
  throw new Error('runtime status was not cleared after launcher SIGTERM');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const headlessRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-headless-'));
const headlessPort = await getFreePort();
const headlessRuntimePath = await runtimeStatusPath(headlessRoot, home);
await withStartedCodexPro([
  '--root',
  headlessRoot,
  '--tunnel',
  'none',
  '--port',
  String(headlessPort),
  '--headless'
], env, async (child) => {
  const runtime = await waitForJson(
    headlessRuntimePath,
    (data) => data.pid === child.pid && Number.isInteger(data.runtimePid),
    'headless runtime status'
  );
  if (runtime.runtimePid === child.pid) {
    throw new Error(`headless runtime did not publish its supervised child pid: ${JSON.stringify(runtime)}`);
  }
  process.kill(runtime.runtimePid, 'SIGTERM');
  const closed = await Promise.race([
    new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('headless launcher did not exit after HTTP runtime stopped')), 10_000))
  ]);
  if (closed.code === 0) {
    throw new Error(`headless launcher exited successfully after unexpected runtime loss: ${JSON.stringify(closed)}`);
  }
});
try {
  await fs.access(headlessRuntimePath);
  throw new Error('headless runtime status was not cleared after supervised child exit');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const quitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-quit-'));
const quitPort = await getFreePort();
const quitRuntimePath = await runtimeStatusPath(quitRoot, home);
const quitFailurePath = await runtimeFailurePath(quitRoot, home);
const quitResult = runInteractiveQuit([
  '--root',
  quitRoot,
  '--tunnel',
  'none',
  '--port',
  String(quitPort),
  '--no-copy-url'
], env);
if (quitResult) {
  if (!Number.isInteger(quitResult.runtime.runtimePid)) {
    throw new Error(`interactive q did not expose the running HTTP child PID; port=${quitPort}\n${quitResult.output}`);
  }
  await waitForProcessExit(quitResult.runtime.runtimePid, 'HTTP child after interactive q');
  await assertPortReusable(quitPort, 'interactive q');
  await assertPathMissing(quitRuntimePath, 'runtime status after interactive q');
  await assertPathMissing(quitFailurePath, 'last-failure record after interactive q');
}

const shutdownCaseFailures = [];
async function recordShutdownCase(name, runCase) {
  try {
    await runCase();
  } catch (error) {
    shutdownCaseFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runIntentionalSignalCase(name, signal) {
  const signalRoot = await fs.mkdtemp(path.join(os.tmpdir(), `codexpro-settings-${name}-`));
  const signalPort = await getFreePort();
  const launch = await startObservedLauncher([
    '--root', signalRoot,
    '--tunnel', 'none',
    '--port', String(signalPort),
    '--headless',
    '--no-auth'
  ], env, signalRoot, name);
  try {
    const startedAt = Date.now();
    launch.child.kill(signal);
    const closed = await waitForLauncherClose(launch.child, name);
    const expectedExitCode = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;
    if (closed.code !== expectedExitCode) {
      throw new Error(`${name} exited with code=${closed.code} signal=${closed.signal}; expected exit code ${expectedExitCode}`);
    }
    await waitForProcessExit(launch.runtime.runtimePid, `HTTP child after ${name}`);
    await assertPortReusable(signalPort, name);
    await assertPathMissing(launch.runtimePath, `runtime status after ${name}`);
    await assertPathMissing(launch.failurePath, `last-failure record after ${name}`);
    return { elapsedMs: Date.now() - startedAt, closed, pid: launch.child.pid, httpPid: launch.runtime.runtimePid, port: signalPort };
  } catch (error) {
    throw new Error(`${error.message}; launcherPid=${launch.child.pid}; httpPid=${launch.runtime.runtimePid}; port=${signalPort}; output=${launch.output()}`);
  } finally {
    await reapProcess(launch.runtime.runtimePid, `${name} HTTP child`);
    await reapProcess(launch.child.pid, `${name} launcher`);
  }
}

await recordShutdownCase('SIGTERM shutdown', async () => {
  await runIntentionalSignalCase('sigterm', 'SIGTERM');
});
await recordShutdownCase('SIGINT shutdown', async () => {
  await runIntentionalSignalCase('sigint', 'SIGINT');
});
if (process.platform !== 'win32') {
  await recordShutdownCase('POSIX SIGHUP shutdown', async () => {
    await runIntentionalSignalCase('sighup', 'SIGHUP');
  });
}

await recordShutdownCase('stubborn fake tunnel shutdown', async () => {
  const stubbornRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-stubborn-tunnel-'));
  const stubbornPort = await getFreePort();
  const termMarker = path.join(home, 'fake-stubborn-tunnel-sigterm');
  const tunnelPidPath = path.join(home, 'fake-stubborn-tunnel.pid');
  const stubbornRuntimePath = await runtimeStatusPath(stubbornRoot, home);
  const stubbornFailurePath = await runtimeFailurePath(stubbornRoot, home);
  const fakeTunnel = await writeNodeExecutable(path.join(home, 'fake-stubborn-cloudflared.mjs'), [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
    "fs.writeFileSync(process.env.CODEXPRO_STUBBORN_TUNNEL_PID, String(process.pid));",
    "process.on('SIGTERM', () => fs.appendFileSync(process.env.CODEXPRO_STUBBORN_TUNNEL_TERM, 'SIGTERM\\n'));",
    'setInterval(() => {}, 1000);',
    ''
  ]);
  let launch;
  try {
    launch = await startLauncherBeforeTunnelReady([
      '--root', stubbornRoot,
      '--tunnel', 'cloudflare',
      '--cloudflared', fakeTunnel,
      '--port', String(stubbornPort),
      '--headless',
      '--no-copy-url'
    ], {
      ...env,
      CODEXPRO_STUBBORN_TUNNEL_PID: tunnelPidPath,
      CODEXPRO_STUBBORN_TUNNEL_TERM: termMarker
    }, tunnelPidPath, 'stubborn fake tunnel');
    const startedAt = Date.now();
    launch.child.kill('SIGTERM');
    const closed = await waitForLauncherClose(launch.child, 'stubborn fake tunnel launcher');
    const elapsedMs = Date.now() - startedAt;
    const evidenceFailures = [];
    const observe = async (name, assertion) => {
      try { await assertion(); }
      catch (error) { evidenceFailures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    await observe('launcher exit code', async () => {
      if (closed.code !== 143) throw new Error(`observed code=${closed.code} signal=${closed.signal}; expected 143`);
    });
    await observe('grace elapsed', async () => {
      if (elapsedMs < 1_000) throw new Error(`observed ${elapsedMs}ms; expected at least 1000ms`);
    });
    await observe('graceful tunnel signal', async () => {
      const signals = await fs.readFile(termMarker, 'utf8');
      if (!signals.includes('SIGTERM')) throw new Error(`marker did not record SIGTERM: ${signals}`);
    });
    await observe('tunnel process exit', () => waitForProcessExit(launch.tunnelPid, 'stubborn fake tunnel after escalation'));
    await observe('HTTP child exit', () => waitForProcessExit(launch.httpPid, 'HTTP child after stubborn tunnel shutdown'));
    await observe('port bindability', () => assertPortReusable(stubbornPort, 'stubborn fake tunnel shutdown'));
    await observe('runtime-current removal', () => assertPathMissing(stubbornRuntimePath, 'runtime status after stubborn tunnel shutdown'));
    await observe('failure-record absence', () => assertPathMissing(stubbornFailurePath, 'last-failure record after stubborn tunnel shutdown'));
    if (evidenceFailures.length) {
      throw new Error(`${evidenceFailures.join('; ')}; launcherPid=${launch.child.pid}; tunnelPid=${launch.tunnelPid}; httpPid=${launch.httpPid}; port=${stubbornPort}`);
    }
  } catch (error) {
    const detail = launch
      ? `${error.message}; launcherPid=${launch.child.pid}; tunnelPid=${launch.tunnelPid}; httpPid=${launch.httpPid}; port=${stubbornPort}; output=${launch.output()}`
      : `${error.message}; port=${stubbornPort}`;
    throw new Error(detail);
  } finally {
    if (launch) {
      await reapProcess(launch.tunnelPid, 'stubborn fake tunnel');
      await reapProcess(launch.httpPid, 'stubborn tunnel HTTP child');
      await reapProcess(launch.child.pid, 'stubborn tunnel launcher');
    }
  }
});

if (process.platform !== 'win32') {
  await recordShutdownCase('active managed verification descendant shutdown', async () => {
    const activeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-active-verification-'));
    const activePort = await getFreePort();
    const descendantPidPath = path.join(home, 'active-verification-descendant.pid');
    const descendantTermPath = path.join(home, 'active-verification-descendant.term');
    const fixturePath = path.resolve('scripts/launcher-supervision-stubborn-child.mjs');
    const quoteScriptArg = (value) => `"${String(value).replaceAll('"', '""')}"`;
    await fs.writeFile(path.join(activeRoot, 'package.json'), JSON.stringify({
      name: 'codexpro-launcher-supervision-fixture',
      version: '1.0.0',
      scripts: {
        supervision_probe: [process.execPath, fixturePath, descendantPidPath, descendantTermPath]
          .map(quoteScriptArg)
          .join(' ')
      }
    }, null, 2));

    let launch;
    let client;
    let descendantPid;
    try {
      launch = await startObservedLauncher([
        '--root', activeRoot,
        '--tunnel', 'none',
        '--port', String(activePort),
        '--headless',
        '--no-auth',
        '--bash', 'full',
        '--tool-mode', 'full'
      ], withoutProxyEnv(env), activeRoot, 'active managed verification descendant');
      const opened = await createLauncherMcpClient(activePort);
      client = opened.client;
      const workspace = await client.callTool({ name: 'open_current_workspace', arguments: {} });
      if (workspace.isError) throw new Error(`could not open disposable workspace: ${JSON.stringify(workspace)}`);
      const workspaceId = workspace.structuredContent?.workspace_id;
      if (typeof workspaceId !== 'string' || !workspaceId) {
        throw new Error(`open_current_workspace did not return a workspace ID: ${JSON.stringify(workspace)}`);
      }
      const started = await client.callTool({
        name: 'start_verification',
        arguments: {
          workspace_id: workspaceId,
          runner: 'package_script',
          package_manager: 'npm',
          script: 'supervision_probe',
          lifetime_ms: 60_000
        }
      });
      if (started.isError) throw new Error(`managed verification fixture did not start: ${JSON.stringify(started)}`);
      descendantPid = Number(await waitForFileText(descendantPidPath, 'managed verification descendant PID'));
      if (!Number.isInteger(descendantPid) || descendantPid <= 0 || !await processExists(descendantPid)) {
        throw new Error(`managed verification descendant is not alive at shutdown setup: ${descendantPid}`);
      }
      const descendants = descendantProcessIds(processSnapshot(), launch.runtime.runtimePid);
      if (!descendants.includes(descendantPid)) {
        throw new Error(`fixture PID ${descendantPid} is not below HTTP child ${launch.runtime.runtimePid}; descendants=${JSON.stringify(descendants)}`);
      }
      await opened.close();
      client = undefined;

      const startedAt = Date.now();
      launch.child.kill('SIGTERM');
      const closed = await waitForLauncherClose(launch.child, 'active managed verification launcher', 15_000);
      const descendantAliveAtLauncherClose = await processExists(descendantPid);
      if (descendantAliveAtLauncherClose) {
        throw new Error(`managed verification descendant PID ${descendantPid} was still alive when launcher close was observed`);
      }
      const termText = await fs.readFile(descendantTermPath, 'utf8');
      const termMatch = termText.match(/^(\d+) SIGTERM$/m);
      if (!termMatch) throw new Error(`managed descendant did not record SIGTERM: ${termText}`);
      const elapsedSinceTermMs = Date.now() - Number(termMatch[1]);
      if (elapsedSinceTermMs < 1_200) {
        throw new Error(`SIGTERM-resistant managed child ended after ${elapsedSinceTermMs}ms; expected internal escalation after its grace`);
      }
      if (closed.code !== 143) {
        throw new Error(`launcher exited code=${closed.code} signal=${closed.signal}; expected intentional SIGTERM code 143`);
      }
      await waitForProcessExit(descendantPid, 'managed verification descendant after launcher shutdown');
      await waitForProcessExit(launch.runtime.runtimePid, 'HTTP child after active verification shutdown');
      await assertPortReusable(activePort, 'active managed verification shutdown');
      await assertPathMissing(launch.runtimePath, 'runtime status after active verification shutdown');
      await assertPathMissing(launch.failurePath, 'last-failure after active verification shutdown');
      console.log(
        `PASS active managed verification shutdown: launcherPid=${launch.child.pid} httpPid=${launch.runtime.runtimePid} descendantPid=${descendantPid} port=${activePort} exitCode=${closed.code} termToCloseMs=${elapsedSinceTermMs} portRebound=true runtimeCurrentRemoved=true lastFailureAbsent=true`
      );
      return {
        elapsedMs: Date.now() - startedAt,
        elapsedSinceTermMs,
        launcherPid: launch.child.pid,
        httpPid: launch.runtime.runtimePid,
        descendantPid,
        port: activePort
      };
    } catch (error) {
      throw new Error(`${error.message}; launcherPid=${launch?.child.pid ?? 'unknown'}; httpPid=${launch?.runtime.runtimePid ?? 'unknown'}; descendantPid=${descendantPid ?? 'unknown'}; port=${activePort}; output=${launch?.output() ?? ''}`);
    } finally {
      if (client) await client.close().catch(() => {});
      if (descendantPid) await reapProcess(descendantPid, 'active managed verification descendant');
      if (launch) {
        await reapProcess(launch.runtime.runtimePid, 'active verification HTTP child');
        await reapProcess(launch.child.pid, 'active verification launcher');
      }
    }
  });
}
if (shutdownCaseFailures.length) {
  throw new Error(`launcher shutdown regression cases failed:\n${shutdownCaseFailures.join('\n')}`);
}

const cloudflareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-'));
const cloudflarePort = await getFreePort();
const cloudflarePath = await runtimeStatusPath(cloudflareRoot, home);
const fakeCloudflaredPidPath = path.join(home, 'fake-cloudflared.pid');
const fakeCloudflared = await writeNodeExecutable(path.join(home, 'fake-cloudflared.mjs'), [
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  'fs.writeFileSync(process.env.CODEXPRO_FAKE_CLOUDFLARED_PID, String(process.pid));',
  "console.error('https://api.trycloudflare.com/tunnel');",
  "setTimeout(() => console.error('https://real-codexpro.trycloudflare.com'), 100);",
  'setInterval(() => {}, 1000);',
  ''
]);
await withStartedCodexPro([
  '--root',
  cloudflareRoot,
  '--tunnel',
  'cloudflare',
  '--cloudflared',
  fakeCloudflared,
  '--port',
  String(cloudflarePort),
  '--token',
  'codexpro-cloudflare-token',
  '--no-copy-url'
], withoutProxyEnv({ ...env, CODEXPRO_FAKE_CLOUDFLARED_PID: fakeCloudflaredPidPath }), async () => {
  const runtime = await waitForJson(cloudflarePath, (data) => data.endpoint?.includes('trycloudflare.com'), 'cloudflare runtime status');
  if (runtime.endpoint.includes('api.trycloudflare.com') || !runtime.endpoint.startsWith('https://real-codexpro.trycloudflare.com/mcp')) {
    throw new Error(`quick tunnel saved the wrong endpoint: ${JSON.stringify(runtime)}`);
  }
});
if (process.platform === 'win32') {
  const fakeCloudflaredPid = Number(await fs.readFile(fakeCloudflaredPidPath, 'utf8'));
  try {
    await waitForProcessExit(fakeCloudflaredPid, 'fake cloudflared shim descendant');
  } catch (error) {
    spawnSync('taskkill.exe', ['/pid', String(fakeCloudflaredPid), '/t', '/f'], { stdio: 'ignore' });
    throw error;
  }
}

const proxyCloudflareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-proxy-'));
const proxyCloudflarePort = await getFreePort();
const proxyCloudflarePath = await runtimeStatusPath(proxyCloudflareRoot, home);
const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-fake-bin-'));
const fakeCurlScript = path.join(fakeBin, process.platform === 'win32' ? 'curl.cjs' : 'curl');
const curlArgsPath = path.join(home, 'fake-curl-args.json');
const cloudflaredArgsPath = path.join(home, 'fake-cloudflared-proxy-args.json');
await writeNodeExecutable(fakeCurlScript, [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  "fs.writeFileSync(process.env.CODEXPRO_FAKE_CURL_ARGS, JSON.stringify(process.argv.slice(2)));",
  "console.log(JSON.stringify({ success: true, result: { id: 'proxy-tunnel-id', hostname: 'proxy-codexpro.trycloudflare.com', account_tag: 'account-tag', secret: 'proxy-secret-1234567890' } }));",
  ''
], path.join(fakeBin, 'curl.cmd'));
const fakeProxyCloudflared = await writeNodeExecutable(path.join(home, 'fake-cloudflared-proxy.mjs'), [
  '#!/usr/bin/env node',
  "import fs from 'node:fs';",
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "const args = process.argv.slice(2);",
  "fs.writeFileSync(process.env.CODEXPRO_FAKE_CLOUDFLARED_ARGS, JSON.stringify(args));",
  "const credentialsPath = args[args.indexOf('--credentials-file') + 1];",
  "const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));",
  "if (credentials.TunnelID !== 'proxy-tunnel-id' || credentials.AccountTag !== 'account-tag' || credentials.TunnelSecret !== 'proxy-secret-1234567890') process.exit(4);",
  "setInterval(() => {}, 1000);",
  ''
]);
await withStartedCodexPro([
  '--root',
  proxyCloudflareRoot,
  '--tunnel',
  'cloudflare',
  '--cloudflared',
  fakeProxyCloudflared,
  '--port',
  String(proxyCloudflarePort),
  '--token',
  'codexpro-cloudflare-proxy-token',
  '--no-copy-url'
], {
  ...env,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  HTTPS_PROXY: 'http://proxy.example.test:8080',
  CODEXPRO_FAKE_CURL_ARGS: curlArgsPath,
  CODEXPRO_FAKE_CLOUDFLARED_ARGS: cloudflaredArgsPath
}, async () => {
  const runtime = await waitForJson(proxyCloudflarePath, (data) => data.endpoint?.includes('proxy-codexpro.trycloudflare.com'), 'proxy cloudflare runtime status');
  if (!runtime.endpoint.startsWith('https://proxy-codexpro.trycloudflare.com/mcp')) {
    throw new Error(`proxy quick tunnel saved the wrong endpoint: ${JSON.stringify(runtime)}`);
  }
});
const curlArgs = JSON.parse(await fs.readFile(curlArgsPath, 'utf8'));
if (!curlArgs.includes('--proxy') || !curlArgs.includes('http://proxy.example.test:8080') || !curlArgs.includes('https://api.trycloudflare.com/tunnel')) {
  throw new Error(`proxy quick tunnel did not call curl through proxy: ${JSON.stringify(curlArgs)}`);
}
const cloudflaredArgs = JSON.parse(await fs.readFile(cloudflaredArgsPath, 'utf8'));
if (!cloudflaredArgs.includes('--credentials-file') || !cloudflaredArgs.includes('run') || !cloudflaredArgs.includes('proxy-tunnel-id')) {
  throw new Error(`proxy quick tunnel did not run cloudflared with credentials: ${JSON.stringify(cloudflaredArgs)}`);
}
const credentialsPath = cloudflaredArgs[cloudflaredArgs.indexOf('--credentials-file') + 1];
try {
  await fs.access(credentialsPath);
  throw new Error(`proxy quick tunnel credentials were not cleaned up: ${credentialsPath}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const proxyCloudflareFailRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-proxy-fail-'));
const proxyCloudflareFailPort = await getFreePort();
const fakeFailingProxyCloudflared = await writeNodeExecutable(path.join(home, 'fake-cloudflared-proxy-fail.mjs'), [
  '#!/usr/bin/env node',
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "console.error('proxy tunnel startup failed');",
  'process.exit(7);',
  ''
]);
const proxyFailure = runFail([
  'start',
  '--root',
  proxyCloudflareFailRoot,
  '--tunnel',
  'cloudflare',
  '--cloudflared',
  fakeFailingProxyCloudflared,
  '--port',
  String(proxyCloudflareFailPort),
  '--token',
  'codexpro-cloudflare-proxy-token',
  '--no-copy-url'
], {
  ...env,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
  HTTPS_PROXY: 'http://proxy.example.test:8080',
  CODEXPRO_FAKE_CURL_ARGS: path.join(home, 'fake-curl-fail-args.json')
}, /exited before startup completed/);
if (!proxyFailure.includes('proxy tunnel startup failed')) {
  throw new Error(`proxy quick tunnel did not include cloudflared startup failure output\n${proxyFailure}`);
}

const namedCloudflareRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-cloudflare-named-'));
const namedCloudflarePort = await getFreePort();
const cloudflareRawToken = 'cf_audit_secret_1234567890TOKEN';
const fakeNamedCloudflared = await writeNodeExecutable(path.join(home, 'fake-cloudflared-named.mjs'), [
  '#!/usr/bin/env node',
  "if (process.argv.includes('--version')) { console.log('cloudflared version 2026.6.0'); process.exit(0); }",
  "console.error('fake tunnel saw TUNNEL_TOKEN=' + process.env.TUNNEL_TOKEN);",
  'process.exit(2);',
  ''
]);
const namedFailure = runFail([
  'start',
  '--root',
  namedCloudflareRoot,
  '--tunnel',
  'cloudflare-named',
  '--hostname',
  'codexpro-audit.example.com',
  '--cloudflare-token',
  cloudflareRawToken,
  '--cloudflared',
  fakeNamedCloudflared,
  '--port',
  String(namedCloudflarePort),
  '--token',
  'codexpro-named-http-token',
  '--no-copy-url'
], env, /Recent cloudflared output/);
if (namedFailure.includes(cloudflareRawToken) || !namedFailure.includes('TUNNEL_TOKEN= [REDACTED_SECRET]')) {
  throw new Error(`named tunnel failure leaked or failed to redact Cloudflare token\n${namedFailure}`);
}

const fakeNgrok = await writeNodeExecutable(path.join(home, 'fake-ngrok.mjs'), [
  '#!/usr/bin/env node',
  "if (process.argv.includes('version')) { console.log('ngrok version 3.0.0'); process.exit(0); }",
  "console.error('NGROK_ARGS=' + process.argv.slice(2).join('|'));",
  'process.exit(2);',
  ''
]);
run([
  'settings',
  'set',
  '--root',
  ngrokRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-env.ngrok-free.app',
  '--ngrok-config',
  'old-ngrok.yml'
], env);
const ngrokPort = await getFreePort();
const ngrokFailure = runFail([
  'start',
  '--root',
  ngrokRoot,
  '--tunnel',
  'ngrok',
  '--hostname',
  'codexpro-env.ngrok-free.app',
  '--ngrok',
  fakeNgrok,
  '--port',
  String(ngrokPort),
  '--token',
  'codexpro-ngrok-env-token',
  '--no-copy-url'
], { ...env, NGROK_CONFIG: 'new-ngrok.yml' }, /Recent ngrok output/);
const realNgrokRoot = await fs.realpath(ngrokRoot);
if (!ngrokFailure.includes(`--config|${path.join(realNgrokRoot, 'new-ngrok.yml')}`) || ngrokFailure.includes('old-ngrok.yml')) {
  throw new Error(`ngrok start did not let env config override saved profile\n${ngrokFailure}`);
}

const fakeTailscale = await writeNodeExecutable(path.join(home, 'fake-tailscale.mjs'), [
  '#!/usr/bin/env node',
  "if (process.argv.includes('version')) { console.log('1.80.0'); process.exit(0); }",
  "console.error('TAILSCALE_ARGS=' + process.argv.slice(2).join('|'));",
  'process.exit(2);',
  ''
]);
const tailscaleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-tailscale-'));
const tailscalePort = await getFreePort();
const tailscaleFailure = runFail([
  'start',
  '--root',
  tailscaleRoot,
  '--tunnel',
  'tailscale',
  '--hostname',
  'codexpro-env.tailnet.ts.net',
  '--tailscale',
  fakeTailscale,
  '--port',
  String(tailscalePort),
  '--token',
  'codexpro-tailscale-token',
  '--no-copy-url'
], env, /Recent tailscale output/);
if (!tailscaleFailure.includes(`funnel|http://127.0.0.1:${tailscalePort}`)) {
  throw new Error(`tailscale start did not invoke Funnel against the local server\n${tailscaleFailure}`);
}
const tailscalePortRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-settings-tailscale-port-'));
const tailscalePort8443 = await getFreePort();
const tailscalePortFailure = runFail([
  'start',
  '--root',
  tailscalePortRoot,
  '--tunnel',
  'tailscale',
  '--hostname',
  'codexpro-env.tailnet.ts.net:8443',
  '--tailscale',
  fakeTailscale,
  '--port',
  String(tailscalePort8443),
  '--token',
  'codexpro-tailscale-token',
  '--no-copy-url'
], env, /Recent tailscale output/);
if (!tailscalePortFailure.includes(`funnel|--https=8443|http://127.0.0.1:${tailscalePort8443}`)) {
  throw new Error(`tailscale start did not map hostname port to Funnel HTTPS port\n${tailscalePortFailure}`);
}

const listed = run(['settings', 'list'], env);
if (!listed.includes(realRoot) || !listed.includes('codexpro-test.ngrok-free.app') || !listed.includes('codexpro-test.tailnet.ts.net')) {
  throw new Error(`settings list missing saved profile\n${listed}`);
}

const reused = run(['settings', 'use', '--root', reuseRoot, '--from-root', root], env);
if (!reused.includes('Saved workspace settings from')) {
  throw new Error(`settings use did not save profile\n${reused}`);
}

const reusedShown = run(['settings', 'show', '--root', reuseRoot], env);
for (const expected of ['ngrok', 'codexpro-test.ngrok-free.app', '<saved>']) {
  if (!reusedShown.includes(expected)) {
    throw new Error(`reused settings show missing ${expected}\n${reusedShown}`);
  }
}

const deleted = run(['settings', 'delete', '--root', root, '--yes'], env);
if (!deleted.includes('Deleted saved settings')) {
  throw new Error(`expected settings delete output, got:\n${deleted}`);
}

run(['settings', 'delete', '--root', reuseRoot, '--yes'], env);

const afterDelete = run(['settings', 'show', '--root', root], env);
if (!afterDelete.includes('No saved settings')) {
  throw new Error(`expected empty settings after delete, got:\n${afterDelete}`);
}

console.log('✓ settings smoke test passed');
