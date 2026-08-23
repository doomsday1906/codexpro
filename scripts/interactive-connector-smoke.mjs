import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

async function writeExecutable(filePath, contents) {
  await fs.writeFile(filePath, contents, { mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o700);
}

function findPythonForPty() {
  if (process.platform === 'win32') return '';
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['-c', 'import pty, select, subprocess'], { stdio: 'ignore' });
    if (result.status === 0) return command;
  }
  return '';
}

function runInteractiveConnector(python, payload) {
  const code = String.raw`
import json, os, pty, select, subprocess, sys, time

payload = json.loads(sys.argv[1])
env = os.environ.copy()
env.update(payload["env"])
master, slave = pty.openpty()
proc = subprocess.Popen(
    [payload["cmd"]] + payload["args"],
    cwd=payload["cwd"],
    env=env,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
out = bytearray()
cursor = 0
sent = []

def read_until(marker, timeout=20):
    global cursor
    deadline = time.time() + timeout
    while time.time() < deadline:
        if marker in out[cursor:]:
            cursor = out.find(marker, cursor) + len(marker)
            return
        if proc.poll() is not None:
            break
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                out.extend(os.read(master, 8192))
            except OSError:
                break
    raise RuntimeError("control prompt was not reached after " + repr(sent))

try:
    read_until(b"codexpro> ")
    for key in [b"p", b"u", b"h", b"c", b"o", b"\r"]:
        os.write(master, key)
        sent.append(key.decode(errors="replace"))
        read_until(b"codexpro> ")
    os.write(master, b"q")
    sent.append("q")

    deadline = time.time() + 10
    while proc.poll() is None and time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                out.extend(os.read(master, 8192))
            except OSError:
                break
    if proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=3)

    while True:
        ready, _, _ = select.select([master], [], [], 0)
        if not ready:
            break
        try:
            out.extend(os.read(master, 8192))
        except OSError:
            break

    sys.stdout.write(out.decode(errors="replace"))
    if proc.returncode not in (0,):
        sys.stderr.write("interactive connector exited with " + repr(proc.returncode) + " after " + repr(sent) + "\n")
        raise SystemExit(proc.returncode or 1)
finally:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    try:
        os.close(master)
    except OSError:
        pass
`;
  return spawnSync(python, ['-c', code, JSON.stringify(payload)], {
    cwd: payload.cwd,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024
  });
}

async function assertAbsent(filePath, label) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} remained at ${filePath}`);
}

async function main() {
  const python = findPythonForPty();
  if (!python) {
    console.log('✓ interactive connector smoke skipped (Python PTY support unavailable)');
    return;
  }

  const projectRoot = path.resolve('.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-interactive-root-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-interactive-home-'));
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-interactive-bin-'));
  const clipboardPath = path.join(home, 'clipboard.txt');
  const openLogPath = path.join(home, 'opened-urls.txt');
  const codexProHome = path.join(home, '.codexpro');
  const token = 'live_connector_7f4a2d9c8e1b6f3a5c7d9e2b4a6c8d0f';
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverUrl = new URL(`${baseUrl}/mcp`);
  serverUrl.searchParams.set('codexpro_token', token);
  const expectedServerUrl = serverUrl.toString();
  const statusUrl = new URL(`${baseUrl}/`);
  statusUrl.searchParams.set('codexpro_token', token);
  const runtimeId = createHash('sha256').update(await fs.realpath(root)).digest('hex').slice(0, 24);
  const runtimePath = path.join(codexProHome, 'runtime', `${runtimeId}.json`);
  const runtimeFailurePath = path.join(codexProHome, 'runtime', `${runtimeId}.last-failure.json`);

  try {
    await writeExecutable(path.join(binDir, 'xclip'), `#!/usr/bin/env node
import fs from 'node:fs';
let value = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { value += chunk; });
process.stdin.on('end', () => fs.writeFileSync(process.env.CODEXPRO_CLIPBOARD, value));
`);
    const openShim = [
      '#!/usr/bin/env node',
      "import fs from 'node:fs';",
      "fs.appendFileSync(process.env.CODEXPRO_OPEN_LOG, String(process.argv[2] ?? '') + '\\n');",
      ''
    ].join('\n');
    await writeExecutable(path.join(binDir, 'xdg-open'), openShim);

    const env = { ...process.env };
    for (const key of ['CODEXPRO_HTTP_TOKEN', 'CODEBASE_BRIDGE_HTTP_TOKEN', 'CODEXPRO_TUNNEL']) delete env[key];
    env.HOME = home;
    env.CODEXPRO_HOME = codexProHome;
    env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ''}`;
    env.CODEXPRO_CLIPBOARD = clipboardPath;
    env.CODEXPRO_OPEN_LOG = openLogPath;
    env.NO_COLOR = '1';

    const result = runInteractiveConnector(python, {
      cmd: process.execPath,
      args: [
        'scripts/codexpro.mjs',
        '--root', root,
        '--tunnel', 'none',
        '--port', String(port),
        '--token', token,
        '--no-profile',
        '--no-copy-url'
      ],
      cwd: projectRoot,
      env
    });
    const transcript = `${result.stdout}\n${result.stderr}`;
    if (result.status !== 0) {
      throw new Error(`interactive connector process failed with status ${result.status}\n${transcript}`);
    }

    assert(!transcript.includes(token), 'interactive transcript leaked the supplied bearer token');
    assert(transcript.includes('Authorization: Bearer [REDACTED_SECRET]'), 'p did not show the exact safe custom-header marker');
    assert(!transcript.includes('Authorization: Bearer live_connector_'), 'p exposed a token-shaped Authorization value');
    assert(transcript.includes('?codexpro_token=[REDACTED_SECRET]'), 'startup or p did not retain the redacted URL shape');
    assert(transcript.includes('Controls'), 'h did not print control help');
    assert(transcript.includes('Server URL copied with xclip.'), 'c did not report successful copy without exposing the URL');
    assert(transcript.includes('Opened local CodexPro setup/status page.'), 'o did not use the safe open path');
    assert(transcript.includes('Opened ChatGPT connector settings.'), 'Enter did not use the safe open path');
    assert(transcript.includes('Stopping CodexPro...'), 'q did not report a clean stop');

    const copied = await fs.readFile(clipboardPath, 'utf8');
    assert(copied === expectedServerUrl, 'c did not preserve the functional full Server URL');
    const opened = (await fs.readFile(openLogPath, 'utf8')).trim().split(/\r?\n/);
    assert(opened.length === 2, `expected o and Enter to open two URLs, got ${opened.length}`);
    assert(opened[0] === statusUrl.toString(), 'o opened an unexpected local status URL');
    assert(opened[1] === 'https://chatgpt.com/#settings/Connectors', 'Enter opened an unexpected ChatGPT URL');

    await assertAbsent(runtimePath, 'runtime status');
    await assertAbsent(runtimeFailurePath, 'runtime failure status');
    console.log('✓ interactive connector PTY smoke passed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(binDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
