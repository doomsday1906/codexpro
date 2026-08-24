import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { hasSecretValue, redactDiagnosticText, redactSearchQuery, redactSensitiveText, redactSensitiveTextPreservingLines } = await import('../dist/redact.js');

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
  }
}

function resultText(result) {
  return result.content?.find?.((part) => part.type === 'text')?.text ?? JSON.stringify(result.structuredContent);
}

function structuredTextFields(value, fields = []) {
  if (Array.isArray(value)) {
    for (const item of value) structuredTextFields(item, fields);
    return fields;
  }
  if (!value || typeof value !== 'object') return fields;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'text' && typeof item === 'string') fields.push(item);
    else structuredTextFields(item, fields);
  }
  return fields;
}

function structuredStringFields(value, fields = []) {
  if (typeof value === 'string') {
    fields.push(value);
    return fields;
  }
  if (Array.isArray(value)) {
    for (const item of value) structuredStringFields(item, fields);
    return fields;
  }
  if (!value || typeof value !== 'object') return fields;
  for (const item of Object.values(value)) structuredStringFields(item, fields);
  return fields;
}

function assertToolSuccess(result, label) {
  assert.notEqual(result.isError, true, `${label} failed: ${resultText(result)}`);
  return result;
}

function assertToolError(result, label) {
  assert.equal(result.isError, true, `${label} unexpectedly succeeded: ${resultText(result)}`);
  return result;
}

function numbered(text, startLine = 1) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, index) => `${String(startLine + index).padStart(width, ' ')} | ${line}`).join('\n');
}

function expectRedactedText(text, label) {
  for (const literal of [
    'QZ7',
    'ACTUAL_LITERAL_SECRET_7X9',
    'client.actualSecret',
    'client.getSecret()'
  ]) {
    assert.equal(text.includes(literal), false, `${label} leaked the raw credential ${literal}`);
  }
  assert.equal(text.includes('[REDACTED_SECRET]'), true, `${label} omitted the redaction marker`);
}

function expectNoRawCredential(value, label) {
  const serialized = JSON.stringify(value);
  for (const literal of [
    'ACTUAL_LITERAL_SECRET_7X9',
    'client.actualSecret',
    'client.getSecret()',
    'Token<ACTUAL_LITERAL_SECRET_7X9',
    'Token<client.actualSecret',
    'Password<client.getSecret()',
    'Wrapper<Token<'
  ]) {
    assert.equal(serialized.includes(literal), false, `${label} leaked ${literal} in its complete serialized response`);
  }
}

async function writeFixture(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

function gitFixture(root) {
  for (const args of [['init'], ['config', 'core.quotePath', 'true'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  const commit = spawnSync('git', ['-c', 'user.email=source-redaction-smoke@example.com', '-c', 'user.name=Source Redaction Smoke', 'commit', '-m', 'source redaction smoke fixture'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}

const sourceTs = [
  'const isCurrentTransition = (token: PlayerSessionTransitionToken): boolean => true;',
  'const { hasSecretValue: policyHasSecretValue, apiToken: configuredToken } = policy;',
  'interface Request { token: string; password: string; }',
  'type GenericInput = { token: Token<string>; };',
  'const options = { token: runtimeToken, password: currentPassword };',
  'const x={apiToken:configuredToken};',
  'const fromCall = readOptions({ token: runtimeToken });',
  'const fromArrow = () => ({ password: currentPassword });',
  'function fromReturn() { return { token: runtimeToken }; }',
  'export default { password: currentPassword };',
  'const API_TOKEN = config.apiToken;',
  'const PASSWORD = credentials.getPassword();',
  'const API_TOKEN = configuredToken;',
  'const {',
  '  hasSecretValue: policyHasSecretValue,',
  '  apiToken: configuredToken,',
  '} = policy;',
  'const API_KEY: string = configuredToken;',
  'const value: { token: Token<string>; password: string } = input;',
  'const typedOptions: { token: Token<string>; password: string } = input;',
  'const typedObjectValue: { token: Token<string>; password: string } = {token: runtimeToken,password: currentPassword};',
  'const typedGenericValue: { token: Token<RuntimeToken>; password: PasswordType } = input;',
  'const genericOptions = { token: runtimeToken, password: currentPassword };',
  'const genericFunction = <T>(token: Token<T>): Token<T> => token;',
  'function genericMethod<T>(token: Token<T>): Token<T> { return token; }',
  'type GenericShape<T> = { token: T; };',
  'interface GenericInterface<T> { token: T; }',
  'class GenericClass<T> { password: P; }',
  'type Input = { token: Token<string>; };',
  'interface Credentials<T> { token: Token<T>; password: PasswordType; }',
  'function f(token: Token<string>): Token<string> { return token; }',
  'const arrowFn = (token: Token<string>): Token<string> => token;',
  'const { token: destructuredToken, password: destructuredPassword } = input;',
  ''
].join('\n');

const sourcePy = [
  'def f(token: str) -> bool:',
  '    return True',
  '',
  'def g(password: PasswordType):',
  '    return True',
  '',
  'class Request:',
  '    token: str',
  '',
  'options = {apiToken: configuredToken}',
  'TOKEN: str = configuredToken',
  'def generic(token: Token[str]) -> Token[str]:',
  '    return token',
  '',
  'class GenericRequest:',
  '    token: Token[str]',
  ''
].join('\n');

const safeConfig = [
  'const API_TOKEN = process.env.API_TOKEN;',
  'const PASSWORD = settings.password;',
  ''
].join('\n');

const relationshipSecretPath = 'ghp_01234567890123456789.ts';
const relationshipSource = 'export const target = true;\n';
const relationshipConsumer = `import './${relationshipSecretPath}';\nexport const consumer = true;\n`;
const binaryPrivateBody = 'BINARY_PRIVATE_BODY_7X9';
const binaryPrivateFixture = Buffer.concat([
  Buffer.from(`-----BEGIN PRIVATE KEY-----\n${binaryPrivateBody}\n-----END PRIVATE KEY-----\nconst binaryTail = true;\n`, 'utf8'),
  Buffer.from([0])
]);
const mixedPrivateBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
const mixedPrivateFixture = Buffer.concat([
  Buffer.from(`-----BEGIN PRIVATE KEY-----\n${mixedPrivateBody}\n-----END PRIVATE KEY-----\nconst mixedTail = true;\n`, 'utf8'),
  Buffer.from([0])
]);
const invalidPrivateBody = 'INVALID_PRIVATE_BODY_7X9';
const invalidPrivateFixture = Buffer.concat([
  Buffer.from(`-----BEGIN PRIVATE KEY-----\n${invalidPrivateBody}\n-----END PRIVATE KEY-----\nconst invalidTail = true;\n`, 'utf8'),
  Buffer.from([0xc3, 0x28, 0x0a])
]);

const privateSearchFixtures = {
  'private-complete.txt': [
    '-----BEGIN PRIVATE KEY-----',
    'COMPLETE_PRIVATE_BODY_7X9',
    '-----END PRIVATE KEY-----',
    'const completeTail = true;',
    ''
  ].join('\n'),
  'private-fragmented.txt': [
    '-----BEGIN PRIVATE KEY-',
    'FRAGMENTED_PRIVATE_BODY_7X9',
    ''
  ].join('\n'),
  'private-incomplete.txt': [
    '-----BEGIN PRIVATE KEY-----',
    'INCOMPLETE_PRIVATE_BODY_7X9',
    ''
  ].join('\n'),
  'private-duplicate.txt': [
    'const duplicate = true;',
    'const duplicate = true;',
    '-----BEGIN PRIVATE KEY-----',
    'const duplicate = true;',
    '-----END PRIVATE KEY-----',
    'const duplicate = true;',
    'const duplicate = true;',
    ''
  ].join('\n')
};

const negativeFixtures = {
  'literal.ts': 'const TOKEN = "ACTUAL_LITERAL_SECRET_7X9";\nconst x = { token: "ACTUAL_LITERAL_SECRET_7X9" };\nconst source = "TOKEN=QZ7";\n',
  'typed-literal.ts': 'const API_KEY: string = "ACTUAL_LITERAL_SECRET_7X9";\nconst TOKEN: { token: Token<string>; password: string } = "QZ7";\n',
  'typed-literal.py': 'TOKEN: str = "ACTUAL_LITERAL_SECRET_7X9"\nPASSWORD: str = "QZ7"\n',
  'config.env': 'TOKEN=QZ7\nPASSWORD=ACTUAL_LITERAL_SECRET_7X9\n',
  'secrets.yaml': 'token: QZ7\npassword: ACTUAL_LITERAL_SECRET_7X9\n',
  'secrets.json': '{\n  "token": "ACTUAL_LITERAL_SECRET_7X9",\n  "password": "QZ7"\n}\n',
  'member-contexts.ts': 'const note = "token: client.actualSecret";\n// token: client.actualSecret\ntoken: client.actualSecret\ntoken: client.getSecret()\n',
  'member.env': 'TOKEN=client.actualSecret\nPASSWORD=client.getSecret()\n',
  'member.yaml': [
    'credentials: { password: client.actualSecret }',
    'credentials: {',
    '  password: client.actualSecret',
    '}',
    'credentials: { password: client.getSecret() }',
    ''
  ].join('\n'),
  'generic-payloads.ts': [
    'const apiToken = Token<ACTUAL_LITERAL_SECRET_7X9>;',
    'const generic_token = Token<client.actualSecret>;',
    'const generic_password = Password<client.getSecret()>;',
    'const nested_token = Wrapper<Token<ACTUAL_LITERAL_SECRET_7X9>>;',
    'const API_KEY: string = Token<ACTUAL_LITERAL_SECRET_7X9>;',
    'const config = { apiToken: Token<ACTUAL_LITERAL_SECRET_7X9> };',
    'const nested = { token: Wrapper<Token<client.actualSecret>> };',
    'const spaced = { password: Password <client.getSecret()> };',
    'const malformed = { token: Token<ACTUAL_LITERAL_SECRET_7X9',
    'const lawful = { token: runtimeToken };',
    ''
  ].join('\n'),
  'generic-payloads.env': [
    'apiToken=Token<ACTUAL_LITERAL_SECRET_7X9>',
    'generic_token=Token<client.actualSecret>',
    'generic_password=Password <client.getSecret()>',
    'nested_token=Wrapper<Token<ACTUAL_LITERAL_SECRET_7X9>>',
    'NEXT_TOKEN=runtimeToken',
    ''
  ].join('\n'),
  'generic-payloads.yaml': [
    'apiToken: Token <ACTUAL_LITERAL_SECRET_7X9>',
    'generic_token: Token<client.actualSecret>',
    'generic_password: Password<client.getSecret()>',
    'nested_token: Wrapper<Token<ACTUAL_LITERAL_SECRET_7X9>>',
    'malformed_token: Token<ACTUAL_LITERAL_SECRET_7X9',
    'next_token: runtimeToken',
    ''
  ].join('\n'),
  'generic-contexts.js': [
    'const text = "apiToken: Token<ACTUAL_LITERAL_SECRET_7X9>";',
    '// apiToken: Password<client.getSecret()>',
    'const config = { apiToken: client.actualSecret };',
    'const callConfig = { apiToken: client.getSecret() };',
    ''
  ].join('\n')
};

const directSafe = [
  'const isCurrentTransition = (token: PlayerSessionTransitionToken): boolean => true;',
  'const { hasSecretValue: policyHasSecretValue, apiToken: configuredToken } = policy;',
  'const {\n  hasSecretValue: policyHasSecretValue,\n  apiToken: configuredToken\n} = policy;',
  'interface Request { token: string; password: string; }',
  'type GenericInput = { token: Token<string>; };',
  'const options = { token: runtimeToken, password: currentPassword };',
  'const x={apiToken:configuredToken};',
  'def f(token: str) -> bool: ...',
  'def g(password: PasswordType): ...',
  'options = {apiToken: configuredToken}',
  'const API_TOKEN = configuredToken;',
  'const API_TOKEN = config.apiToken;',
  'const TOKEN = getToken(user);',
  'TOKEN = getToken(user);',
  'TOKEN = process.env.TOKEN;',
  'TOKEN = os.getenv("TOKEN")',
  'PASSWORD = credentials.getPassword();',
  'token = credentials.fetch(:token)',
  'const API_KEY: string = configuredToken;',
  'const value: { token: Token<string>; password: string } = input;',
  'const typedOptions: { token: Token<string>; password: string } = input;',
  'const typedObjectValue: { token: Token<string>; password: string } = {token: runtimeToken,password: currentPassword};',
  'type GenericShape<T> = { token: T; };',
  'interface GenericInterface<T> { token: T; }',
  'class GenericClass<T> { password: P; }',
  'type Input = { token: Token<string>; };',
  'interface Credentials<T> { token: Token<T>; password: PasswordType; }',
  'function f(token: Token<string>): Token<string> { return token; }',
  'const arrowFn = (token: Token<string>): Token<string> => token;',
  'const { token: destructuredToken, password: destructuredPassword } = input;',
  'TOKEN: str = configuredToken',
  'def generic(token: Token[str]) -> Token[str]:',
  'class GenericRequest:\n    token: Token[str]'
];
for (const sample of directSafe) {
  assert.equal(redactSensitiveText(sample), sample, `policy changed lawful source: ${sample}`);
  assert.equal(hasSecretValue(sample), false, `policy classified lawful source as secret: ${sample}`);
}

const directUnsafe = [
  'TOKEN=QZ7',
  'PASSWORD=QZ7',
  'TOKEN=client.actualSecret',
  'PASSWORD=client.getSecret()',
  'TOKEN = client.actualSecret',
  'token: QZ7',
  'password: QZ7',
  'apiToken: configuredToken',
  'password: PasswordType',
  'token: Token<string>',
  'credentials: { password: configuredToken }',
  'credentials: { password: client.actualSecret }',
  'credentials: {\n  password: client.actualSecret\n}',
  'token: Token<ACTUAL_LITERAL_SECRET_7X9>',
  'token: Token<client.actualSecret>',
  'password: Password<client.getSecret()>',
  'token: Wrapper<Token<ACTUAL_LITERAL_SECRET_7X9>>',
  'token: Token <ACTUAL_LITERAL_SECRET_7X9>',
  'token: Token<ACTUAL_LITERAL_SECRET_7X9',
  'const API_KEY: string = Token<ACTUAL_LITERAL_SECRET_7X9>;',
  'const config = { apiToken: Token<ACTUAL_LITERAL_SECRET_7X9> };',
  'const config = { apiToken: Wrapper<Token<ACTUAL_LITERAL_SECRET_7X9>> };',
  'const config = { apiToken: client.actualSecret };',
  'const config = { apiToken: client.getSecret() };',
  'const source = "token: configuredToken";',
  '// const source = { token: configuredToken };',
  'const note = "token: client.actualSecret";',
  '// token: client.actualSecret',
  'token: client.actualSecret',
  'token: client.getSecret()',
  'const API_KEY: string = "ACTUAL_LITERAL_SECRET_7X9";',
  'const API_KEY: { token: Token<string>; password: string } = "QZ7";',
  'TOKEN: str = "ACTUAL_LITERAL_SECRET_7X9"'
];
for (const sample of directUnsafe) {
  const redacted = redactSensitiveText(sample);
  assert.equal(hasSecretValue(sample), true, `policy missed unsafe text: ${sample}`);
  expectRedactedText(redacted, `policy ${sample}`);
}
const malformedWithFollowingSource = 'token: Token<ACTUAL_LITERAL_SECRET_7X9\nconst lawful = runtimeToken;';
assert.equal(
  redactSensitiveText(malformedWithFollowingSource),
  'token: [REDACTED_SECRET]\nconst lawful = runtimeToken;',
  'malformed generic tail consumed a later source line or leaked its payload'
);
const malformedWithInternalDelimiter = 'token: Token<ACTUAL_LITERAL_SECRET_7X9=LEAK\nconst lawful = runtimeToken;';
assert.equal(
  redactSensitiveText(malformedWithInternalDelimiter),
  'token: [REDACTED_SECRET]\nconst lawful = runtimeToken;',
  'malformed generic tail stopped before its rejected payload'
);

for (const [query, safeMatchTexts, expected] of [
  ['policyHasSecretValue', ['const { hasSecretValue: policyHasSecretValue } = policy;'], 'policyHasSecretValue'],
  ['client.actualSecret', ['TOKEN= [REDACTED_SECRET]'], '[REDACTED_SECRET]'],
  ['client.getSecret()', ['PASSWORD= [REDACTED_SECRET]'], '[REDACTED_SECRET]'],
  ['PRIVATE_BODY_BINARY_FALLBACK_7X9', ['[REDACTED_SECRET]'], '[REDACTED_SECRET]'],
  ['client.actualSecret', [], '[REDACTED_SECRET]'],
  ['QZ7', [], '[REDACTED_SECRET]'],
  ['ordinarySourceSymbol', [], 'ordinarySourceSymbol']
]) {
  assert.equal(redactSearchQuery(query, safeMatchTexts), expected, `search query policy changed ${query}`);
}

for (const [sample, literal] of [
  ['TOKEN=getToken(CALL_LITERAL_7X9)', 'CALL_LITERAL_7X9'],
  ['PASSWORD=readPassword(ACTUAL_LITERAL)', 'ACTUAL_LITERAL']
]) {
  assert.equal(redactSensitiveText(sample), sample, `source call compatibility changed: ${sample}`);
  assert.equal(hasSecretValue(sample), false, `source call compatibility classified: ${sample}`);
  assert.equal(hasSecretValue(sample, { context: 'diagnostic' }), true, `diagnostic call was not classified: ${sample}`);
  assert.equal(redactDiagnosticText(sample).includes(literal), false, `diagnostic call leaked: ${sample}`);
}
for (const sample of ['TOKEN=configuredToken', 'TOKEN: str = configuredToken', 'token: Token<string>']) {
  assert.equal(hasSecretValue(sample, { context: 'diagnostic' }), true, `diagnostic bare reference was not classified: ${sample}`);
  assert.equal(redactDiagnosticText(sample).includes('configuredToken'), false, `diagnostic bare reference leaked: ${sample}`);
}

const privateKey = '-----BEGIN PRIVATE KEY-----\nTASK003_SOURCE_REDACTION_PRIVATE_BODY\n-----END PRIVATE KEY-----';
assert.equal(hasSecretValue(privateKey), true, 'private key was not classified');
assert.equal(redactSensitiveText(privateKey).includes('TASK003_SOURCE_REDACTION_PRIVATE_BODY'), false, 'private key body leaked');
const duplicatePrivateSource = privateSearchFixtures['private-duplicate.txt'];
assert.deepEqual(
  redactSensitiveTextPreservingLines(duplicatePrivateSource).split(/\r?\n/).slice(0, 7),
  [
    'const duplicate = true;',
    'const duplicate = true;',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    'const duplicate = true;',
    'const duplicate = true;'
  ],
  'line-preserving policy changed duplicate physical lines around a private key'
);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-source-redaction-'));
let client;
try {
  await writeFixture(tmp, 'source.ts', sourceTs);
  await writeFixture(tmp, 'source.py', sourcePy);
  await writeFixture(tmp, 'safe-config.js', safeConfig);
  await writeFixture(tmp, 'binary-private.ts', binaryPrivateFixture);
  await writeFixture(tmp, 'mixed-private.ts', mixedPrivateFixture);
  await writeFixture(tmp, 'invalid-private.ts', invalidPrivateFixture);
  await writeFixture(tmp, relationshipSecretPath, relationshipSource);
  await writeFixture(tmp, 'consumer.ts', relationshipConsumer);
  for (const [relativePath, content] of Object.entries(privateSearchFixtures)) await writeFixture(tmp, relativePath, content);
  for (const [relativePath, content] of Object.entries(negativeFixtures)) await writeFixture(tmp, relativePath, content);
  gitFixture(tmp);

  client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'workspace', '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'workspace',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0',
      CODEXPRO_ANALYSIS: '1'
    }
  });
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-source-redaction-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const opened = assertToolSuccess(await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } }), 'open_current_workspace');
  const workspaceId = opened.structuredContent.workspace_id;
  assert.ok(workspaceId, 'open_current_workspace omitted workspace id');

  const sourceRead = assertToolSuccess(await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: 'source.ts' } }), 'source read');
  assert.equal(sourceRead.structuredContent.path, 'source.ts', 'source read hid its path');
  assert.equal(sourceRead.structuredContent.text, numbered(sourceTs), 'MCP read changed lawful source bytes or line framing');
  assert.equal(sourceRead.structuredContent.text.includes('[REDACTED_SECRET]'), false, 'MCP read redacted lawful source');
  assert.equal(sourceRead.content?.[0]?.text.includes(numbered(sourceTs)), true, 'MCP read content envelope changed lawful source bytes');
  assert.equal(sourceRead.content?.[0]?.text.includes('[REDACTED_SECRET]'), false, 'MCP read content envelope redacted lawful source');

  const sourcePyRead = assertToolSuccess(await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: 'source.py' } }), 'Python source read');
  assert.equal(sourcePyRead.structuredContent.text, numbered(sourcePy), 'MCP read changed lawful Python source bytes or line framing');
  assert.equal(sourcePyRead.structuredContent.text.includes('[REDACTED_SECRET]'), false, 'MCP read redacted lawful Python source');
  assert.equal(sourcePyRead.content?.[0]?.text.includes(numbered(sourcePy)), true, 'MCP Python read content envelope changed lawful source bytes');
  assert.equal(sourcePyRead.content?.[0]?.text.includes('[REDACTED_SECRET]'), false, 'MCP Python read content envelope redacted lawful source');

  const sourceSearchCases = [
    ['isCurrentTransition', sourceTs.split('\n')[0]],
    ['policyHasSecretValue, apiToken', sourceTs.split('\n')[1]],
    ['policyHasSecretValue', [sourceTs.split('\n')[1], sourceTs.split('\n')[14]]],
    ['apiToken: configuredToken', [sourceTs.split('\n')[1], sourceTs.split('\n')[15]]],
    ['GenericInput', sourceTs.split('\n')[3]],
    ['fromArrow', sourceTs.split('\n')[7]],
    ['API_KEY', sourceTs.split('\n')[17]],
    ['value: { token', sourceTs.split('\n')[18]],
    ['typedOptions', sourceTs.split('\n')[19]],
    ['typedObjectValue', sourceTs.split('\n')[20]],
    ['GenericShape', sourceTs.split('\n')[25]],
    ['GenericInterface', sourceTs.split('\n')[26]],
    ['GenericClass', sourceTs.split('\n')[27]],
    ['type Input', sourceTs.split('\n').find((line) => line.startsWith('type Input'))],
    ['interface Credentials', sourceTs.split('\n').find((line) => line.startsWith('interface Credentials'))],
    ['function f(', sourceTs.split('\n').find((line) => line.startsWith('function f('))],
    ['arrowFn', sourceTs.split('\n').find((line) => line.includes('const arrowFn'))],
    ['destructuredToken', sourceTs.split('\n').find((line) => line.includes('destructuredToken'))],
    ['PasswordType', sourcePy.split('\n')[3]],
    ['options = {apiToken', sourcePy.split('\n')[9]],
    ['TOKEN: str', sourcePy.split('\n')[10]],
    ['def generic', sourcePy.split('\n').find((line) => line.startsWith('def generic')), 'source.py'],
    ['GenericRequest', sourcePy.split('\n').find((line) => line.startsWith('class GenericRequest')), 'source.py']
  ];
  for (const [query, expected, explicitPath] of sourceSearchCases) {
    const expectedLines = Array.isArray(expected) ? expected : [expected];
    const searchPath = explicitPath ?? (query === 'PasswordType' || query.startsWith('options =') || query.startsWith('TOKEN:') ? 'source.py' : 'source.ts');
    const searched = assertToolSuccess(await client.request('tools/call', { name: 'search', arguments: { workspace_id: workspaceId, query, path: searchPath, max_results: 10 } }), `source search ${query}`);
    assert.equal(searched.structuredContent.matches?.length, expectedLines.length, `source search ${query} returned an unexpected match count`);
    for (const [index, expectedLine] of expectedLines.entries()) {
      assert.equal(searched.structuredContent.matches[index].text, expectedLine, `source search ${query} changed lawful source text at result ${index}`);
      assert.equal(searched.structuredContent.matches[index].path, searchPath, `source search ${query} hid its path`);
      assert.equal(resultText(searched).includes(expectedLine), true, `source search ${query} content envelope changed lawful source text`);
    }
    assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `source search ${query} content envelope redacted lawful source`);
  }

  const lawfulQueryCases = [
    ['PlayerSessionTransitionToken', [sourceTs.split('\n')[0]]],
    ['policyHasSecretValue', [sourceTs.split('\n')[1], sourceTs.split('\n')[14]]]
  ];
  for (const [query, expectedLines] of lawfulQueryCases) {
    for (const [route, routeArgs] of [['plain', {}], ['structured', { intent: 'text' }]]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query, path: 'source.ts', max_results: 10, ...routeArgs }
      }), `lawful ${route} search ${query}`);
      assert.deepEqual(
        searched.structuredContent.matches?.map((match) => match.text),
        expectedLines,
        `lawful ${route} search ${query} changed source matches`
      );
      assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `lawful ${route} search ${query} redacted source output`);
      assert.equal(JSON.stringify(searched).includes(query), true, `lawful ${route} search ${query} lost its query in the complete response`);
      // The plain route intentionally omits the analysis envelope; when it
      // is present, it must still carry the lawful query unchanged.
      assert.equal(searched.structuredContent.analysis?.query ?? query, query, `lawful ${route} search ${query} changed analysis.query`);
      if (route === 'structured') {
        assert.equal(searched.structuredContent.analysis?.query, query, `lawful structured search ${query} omitted analysis.query`);
      }
    }
  }

  const structuredSearch = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: 'policyHasSecretValue', path: 'source.ts', intent: 'text', max_results: 10 }
  }), 'structured source search policyHasSecretValue');
  const structuredMatches = structuredSearch.structuredContent.analysis?.matches ?? [];
  assert.deepEqual(
    structuredMatches.map((match) => ({ path: match.path, line: match.line, text: match.text })),
    [
      { path: 'source.ts', line: 2, text: sourceTs.split('\n')[1].trim() },
      { path: 'source.ts', line: 15, text: sourceTs.split('\n')[14].trim() }
    ],
    'structured source search changed lawful source text or ordering'
  );
  assert.equal(resultText(structuredSearch).includes('[REDACTED_SECRET]'), false, 'structured source search content envelope redacted lawful source');
  assert.equal(structuredSearch.structuredContent.analysis?.query, 'policyHasSecretValue', 'structured source search changed a lawful query');

  const relationshipSearch = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: 'target', path: '.', intent: 'impact', max_results: 10 }
  }), 'structured relationship search target');
  const relationshipPayload = JSON.stringify(relationshipSearch.structuredContent);
  assert.equal(relationshipPayload.includes(relationshipSecretPath), false, 'structured relationship search leaked a secret-shaped path');
  assert.equal(resultText(relationshipSearch).includes(relationshipSecretPath), false, 'structured relationship search content envelope leaked a secret-shaped path');
  const derivedRelationship = relationshipSearch.structuredContent.analysis?.groups?.references?.find((match) => match.source === 'built-in import extraction');
  assert.ok(derivedRelationship, 'structured relationship search omitted the derived relationship regression');
  assert.equal(derivedRelationship.text.includes('[REDACTED_SECRET]'), true, 'derived relationship text was restored without source provenance');

  const completePrivateCases = [
    ['BEGIN PRIVATE KEY', 1, '[REDACTED_PRIVATE_KEY]'],
    ['COMPLETE_PRIVATE_BODY_7X9', 2, '[REDACTED_PRIVATE_KEY]'],
    ['END PRIVATE KEY', 3, '[REDACTED_PRIVATE_KEY]'],
    ['completeTail', 4, 'const completeTail = true;']
  ];
  for (const [query, expectedLineNumber, expectedText] of completePrivateCases) {
    const searched = assertToolSuccess(await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: workspaceId, query, path: 'private-complete.txt', max_results: 10 }
    }), `private complete search ${query}`);
    assert.equal(searched.structuredContent.matches?.length, 1, `private complete search ${query} returned an unexpected match count`);
    assert.equal(searched.structuredContent.matches[0].line, expectedLineNumber, `private complete search ${query} changed the physical line number`);
    assert.equal(searched.structuredContent.matches[0].text, expectedText, `private complete search ${query} leaked or misaligned redacted text`);
    assert.equal(resultText(searched).includes('COMPLETE_PRIVATE_BODY_7X9'), false, `private complete search ${query} leaked the private body`);
  }
  for (const [relativePath, body] of [['private-fragmented.txt', 'FRAGMENTED_PRIVATE_BODY_7X9'], ['private-incomplete.txt', 'INCOMPLETE_PRIVATE_BODY_7X9']]) {
    const searched = assertToolSuccess(await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: workspaceId, query: body, path: relativePath, max_results: 10 }
    }), `private variant search ${relativePath}`);
    assert.equal(searched.structuredContent.matches?.length, 1, `private variant search ${relativePath} returned no physical body match`);
    assert.equal(searched.structuredContent.matches[0].text, '[REDACTED_PRIVATE_KEY]', `private variant search ${relativePath} leaked an incomplete private body`);
    assert.equal(resultText(searched).includes(body), false, `private variant search ${relativePath} leaked the private body in its envelope`);
  }
  const duplicatePrivateSearch = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: 'duplicate = true', path: 'private-duplicate.txt', max_results: 10 }
  }), 'duplicate-line private-key search');
  assert.deepEqual(
    duplicatePrivateSearch.structuredContent.matches?.map((match) => ({ line: match.line, text: match.text })),
    [
      { line: 1, text: 'const duplicate = true;' },
      { line: 2, text: 'const duplicate = true;' },
      { line: 4, text: '[REDACTED_PRIVATE_KEY]' },
      { line: 6, text: 'const duplicate = true;' },
      { line: 7, text: 'const duplicate = true;' }
    ],
    'duplicate-line private-key search changed lawful line mapping or source text'
  );
  assert.equal(resultText(duplicatePrivateSearch).includes('const duplicate = true;'), true, 'duplicate-line private-key search omitted lawful source lines');

  const duplicatePrivateStructured = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: 'duplicate = true', path: 'private-duplicate.txt', intent: 'text', max_results: 10 }
  }), 'duplicate-line structured private-key search');
  assert.deepEqual(
    duplicatePrivateStructured.structuredContent.analysis?.matches?.map((match) => ({ line: match.line, text: match.text })),
    [
      { line: 1, text: 'const duplicate = true;' },
      { line: 2, text: 'const duplicate = true;' },
      { line: 4, text: '[REDACTED_PRIVATE_KEY]' },
      { line: 6, text: 'const duplicate = true;' },
      { line: 7, text: 'const duplicate = true;' }
    ],
    'duplicate-line structured private-key search changed lawful line mapping or source text'
  );

  const binaryPrivateSearch = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: binaryPrivateBody, path: 'binary-private.ts', max_results: 10 }
  }), 'binary private-key search');
  assert.deepEqual(
    binaryPrivateSearch.structuredContent.matches?.map((match) => ({ line: match.line, text: match.text })),
    [{ line: 2, text: '[REDACTED_SECRET]' }],
    'binary private-key search did not fail closed when full-file context was unavailable'
  );
  assert.equal(resultText(binaryPrivateSearch).includes(binaryPrivateBody), false, 'binary private-key search leaked through its content envelope');
  assert.equal(structuredStringFields(binaryPrivateSearch.structuredContent).some((text) => text.includes(binaryPrivateBody)), false, 'binary private-key search leaked through nested structured strings');

  const binaryPrivateStructured = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: binaryPrivateBody, path: 'binary-private.ts', intent: 'text', max_results: 10 }
  }), 'binary private-key structured search');
  assert.equal(resultText(binaryPrivateStructured).includes(binaryPrivateBody), false, 'binary private-key structured search leaked through its content envelope');
  assert.equal(structuredStringFields(binaryPrivateStructured.structuredContent).some((text) => text.includes(binaryPrivateBody)), false, 'binary private-key structured search leaked through nested structured strings');

  for (const [label, extra] of [['normal', {}], ['regex', { regex: true }]]) {
    const mixedPrivateStructured = assertToolSuccess(await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: workspaceId, query: mixedPrivateBody, path: 'mixed-private.ts', intent: 'text', max_results: 10, ...extra }
    }), `mixed-case private-key ${label} structured search`);
    assert.deepEqual(
      mixedPrivateStructured.structuredContent.matches?.map((match) => ({ line: match.line, text: match.text })),
      [{ line: 2, text: '[REDACTED_SECRET]' }],
      `mixed-case private-key ${label} search changed its fail-closed lexical match`
    );
    assert.equal(mixedPrivateStructured.structuredContent.matches?.[0]?.path, 'mixed-private.ts', `mixed-case private-key ${label} search hid its source path`);
    assert.equal(mixedPrivateStructured.structuredContent.analysis?.query, '[REDACTED_SECRET]', `mixed-case private-key ${label} search echoed its raw query`);
    assert.equal(resultText(mixedPrivateStructured).includes(mixedPrivateBody), false, `mixed-case private-key ${label} search leaked through its content envelope`);
    assert.equal(structuredStringFields(mixedPrivateStructured.structuredContent).some((text) => text.includes(mixedPrivateBody)), false, `mixed-case private-key ${label} search leaked through nested structured strings`);
  }

  const invalidPrivateStructured = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: invalidPrivateBody, path: 'invalid-private.ts', intent: 'text', max_results: 10 }
  }), 'invalid UTF-8 private-key structured search');
  assert.deepEqual(
    invalidPrivateStructured.structuredContent.analysis?.matches?.map((match) => ({ line: match.line, text: match.text })),
    [{ line: 2, text: '[REDACTED_SECRET]' }],
    'invalid UTF-8 private-key analysis did not fail closed'
  );
  assert.equal(resultText(invalidPrivateStructured).includes(invalidPrivateBody), false, 'invalid UTF-8 private-key search leaked through its content envelope');
  assert.equal(structuredStringFields(invalidPrivateStructured.structuredContent).some((text) => text.includes(invalidPrivateBody)), false, 'invalid UTF-8 private-key analysis leaked through nested structured strings');

  const lawfulBatchPaths = ['source.ts', 'source.py', 'safe-config.js'];
  const lawfulBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: lawfulBatchPaths.map((path) => ({ path })) }
  }), 'lawful source read_many');
  const lawfulBatchResults = lawfulBatch.structuredContent.results ?? [];
  assert.equal(lawfulBatchResults.length, lawfulBatchPaths.length, 'lawful read_many changed item count');
  for (const [index, relativePath] of lawfulBatchPaths.entries()) {
    const expected = await fs.readFile(path.join(tmp, relativePath), 'utf8');
    const item = lawfulBatchResults[index];
    assert.equal(item.index, index, 'lawful read_many changed item order');
    assert.equal(item.path, relativePath, 'lawful read_many hid a source path');
    assert.equal(item.ok, true, `lawful read_many rejected ${relativePath}`);
    assert.equal(item.result.text, numbered(expected), `lawful read_many changed ${relativePath}`);
    assert.equal(item.result.text.includes('[REDACTED_SECRET]'), false, `lawful read_many redacted ${relativePath}`);
    assert.equal(lawfulBatch.content?.[0]?.text.includes(numbered(expected)), true, `lawful read_many content envelope changed ${relativePath}`);
    assert.equal(lawfulBatch.content?.[0]?.text.includes('[REDACTED_SECRET]'), false, `lawful read_many content envelope redacted ${relativePath}`);
  }

  const negativePaths = Object.keys(negativeFixtures);
  for (const relativePath of negativePaths) {
    const read = assertToolSuccess(await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: relativePath } }), `negative read ${relativePath}`);
    assert.equal(read.structuredContent.path, relativePath, `negative read hid ${relativePath}`);
    expectRedactedText(read.structuredContent.text, `MCP read ${relativePath}`);
    expectNoRawCredential(read, `MCP read ${relativePath}`);

    const queries = relativePath.startsWith('member')
      ? ['client.actualSecret', 'client.getSecret()']
      : relativePath.startsWith('generic')
        ? ['client.actualSecret', 'client.getSecret()', 'ACTUAL_LITERAL_SECRET_7X9']
        : ['QZ7', 'ACTUAL_LITERAL_SECRET_7X9'];
    for (const query of queries) {
      for (const variant of [
        ['plain', {}],
        ['structured', { intent: 'text' }],
        ['regex', { regex: true }],
        ['structured-regex', { intent: 'text', regex: true }]
      ]) {
        const [variantName, variantArgs] = variant;
        const searched = assertToolSuccess(await client.request('tools/call', {
          name: 'search',
          arguments: { workspace_id: workspaceId, query, path: relativePath, max_results: 10, ...variantArgs }
        }), `negative search ${relativePath} ${query} ${variantName}`);
        assert.ok(searched.structuredContent.matches?.length, `negative search ${relativePath} ${query} ${variantName} returned no raw fixture matches`);
        for (const match of searched.structuredContent.matches) {
          assert.equal(match.path, relativePath, `negative search changed ${relativePath} path`);
          expectRedactedText(match.text, `MCP search ${relativePath} ${query} ${variantName}`);
        }
        expectNoRawCredential(searched, `MCP search ${relativePath} ${query} ${variantName}`);
        assert.notEqual(searched.structuredContent.analysis?.query, query, `MCP search ${relativePath} ${query} ${variantName} echoed its hostile analysis.query`);
        assert.equal(JSON.stringify(searched).includes(query), false, `MCP search ${relativePath} ${query} ${variantName} echoed its hostile query in the complete response`);
        assert.equal(structuredStringFields(searched.structuredContent).some((text) => text.includes(query)), false, `MCP search ${relativePath} ${query} ${variantName} leaked through a nested structured field`);
        expectRedactedText(resultText(searched), `MCP search ${relativePath} ${query} ${variantName} envelope`);
      }
    }
  }

  const negativeBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: negativePaths.map((path) => ({ path })) }
  }), 'negative read_many');
  const negativeResults = negativeBatch.structuredContent.results ?? [];
  assert.equal(negativeResults.length, negativePaths.length, 'negative read_many changed item count');
  for (const [index, relativePath] of negativePaths.entries()) {
    const item = negativeResults[index];
    assert.equal(item.index, index, 'negative read_many changed item order');
    assert.equal(item.path, relativePath, 'negative read_many hid a source path');
    assert.equal(item.ok, true, `negative read_many failed ${relativePath}`);
    expectRedactedText(item.result.text, `MCP read_many ${relativePath}`);
  }
  expectNoRawCredential(negativeBatch, 'MCP read_many complete response');
  const negativeBatchStrings = structuredStringFields(negativeBatch.structuredContent);
  for (const literal of ['QZ7', 'ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()']) {
    assert.equal(negativeBatchStrings.some((text) => text.includes(literal)), false, `MCP read_many leaked ${literal} through a nested structured field`);
  }
  assert.ok(negativeBatchStrings.some((text) => text.includes('[REDACTED_SECRET]')), 'MCP read_many omitted nested redaction markers');

  for (const [relativePath, query] of [['member.env', 'client.actualSecret'], ['member.yaml', 'client.actualSecret'], ['member.yaml', 'client.getSecret()']]) {
    const structuredMemberSearch = assertToolSuccess(await client.request('tools/call', {
      name: 'search',
      arguments: { workspace_id: workspaceId, query, path: relativePath, intent: 'text', max_results: 10 }
    }), `member structured search ${relativePath} ${query}`);
    assert.equal(structuredStringFields(structuredMemberSearch.structuredContent).some((text) => text.includes(query)), false, `structured member search leaked ${query} from ${relativePath}`);
    assert.equal(resultText(structuredMemberSearch).includes(query), false, `structured member search content envelope leaked ${query} from ${relativePath}`);
    assert.ok(structuredStringFields(structuredMemberSearch.structuredContent).some((text) => text.includes('[REDACTED_SECRET]')), `structured member search omitted marker for ${relativePath}`);
  }

  const compatibility = {
    'compat.js': 'const API_TOKEN = getToken();\nconst options = { token: runtimeToken };\n',
    'compat.ts': 'interface Compat { token: string; }\nconst PASSWORD = credentials.getPassword();\n',
    'compat.py': 'TOKEN = os.getenv("TOKEN")\nPASSWORD = getpass.getpass()\n',
    'compat.rb': 'token = credentials.fetch(:token)\npassword = ENV.fetch("PASSWORD")\n'
  };
  for (const [relativePath, content] of Object.entries(compatibility)) {
    const written = assertToolSuccess(await client.request('tools/call', { name: 'write', arguments: { workspace_id: workspaceId, path: relativePath, content } }), `source write ${relativePath}`);
    assert.ok(written.structuredContent, `source write ${relativePath} omitted structured output`);
    assert.equal(await fs.readFile(path.join(tmp, relativePath), 'utf8'), content, `source write changed ${relativePath}`);
  }

  const edits = {
    'compat.js': ['const API_TOKEN = getToken();', 'const API_TOKEN = config.apiToken;'],
    'compat.ts': ['interface Compat { token: string; }', 'interface Compat { token: string; password: string; }'],
    'compat.py': ['TOKEN = os.getenv("TOKEN")', 'TOKEN = os.environ.get("TOKEN")'],
    'compat.rb': ['token = credentials.fetch(:token)', 'token = credentials.fetch(:token_name)']
  };
  for (const [relativePath, [oldText, newText]] of Object.entries(edits)) {
    const edited = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: { workspace_id: workspaceId, path: relativePath, old_text: oldText, new_text: newText, expected_replacements: 1 }
    }), `source edit ${relativePath}`);
    assert.ok(edited.structuredContent, `source edit ${relativePath} omitted structured output`);
    const current = await fs.readFile(path.join(tmp, relativePath), 'utf8');
    assert.equal(current.includes(newText), true, `source edit changed ${relativePath} unexpectedly`);
  }

  const patch = [
    'diff --git a/compat.rb b/compat.rb',
    '--- a/compat.rb',
    '+++ b/compat.rb',
    '@@ -1,2 +1,2 @@',
    '-token = credentials.fetch(:token_name)',
    '+token = credentials.fetch(:runtime_token)',
    ' password = ENV.fetch("PASSWORD")'
  ].join('\n') + '\n';
  assertToolSuccess(await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: workspaceId, patch } }), 'source apply_patch Ruby');
  assert.equal((await fs.readFile(path.join(tmp, 'compat.rb'), 'utf8')).includes('credentials.fetch(:runtime_token)'), true, 'source apply_patch changed Ruby source unexpectedly');

  const literalWritePath = 'blocked-literal.txt';
  const literalWrite = assertToolError(await client.request('tools/call', {
    name: 'write',
    arguments: { workspace_id: workspaceId, path: literalWritePath, content: 'TOKEN="QZ7"\n' }
  }), 'literal credential write');
  assert.match(resultText(literalWrite), /Secret-looking content is blocked/);
  await assert.rejects(fs.access(path.join(tmp, literalWritePath)), (error) => error?.code === 'ENOENT');

  const compatTsBeforeBlockedEdit = await fs.readFile(path.join(tmp, 'compat.ts'), 'utf8');
  const literalEdit = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: { workspace_id: workspaceId, path: 'compat.ts', old_text: 'password: string;', new_text: 'password: "QZ7";', expected_replacements: 1 }
  }), 'literal credential edit');
  assert.match(resultText(literalEdit), /Secret-looking content is blocked/);
  assert.equal(await fs.readFile(path.join(tmp, 'compat.ts'), 'utf8'), compatTsBeforeBlockedEdit, 'literal edit changed source despite rejection');

  const compatPyBeforeBlockedPatch = await fs.readFile(path.join(tmp, 'compat.py'), 'utf8');
  const literalPatch = [
    'diff --git a/compat.py b/compat.py',
    '--- a/compat.py',
    '+++ b/compat.py',
    '@@ -1,2 +1,2 @@',
    '-TOKEN = os.environ.get("TOKEN")',
    '+TOKEN = "QZ7"',
    ' PASSWORD = getpass.getpass()'
  ].join('\n') + '\n';
  const blockedPatch = assertToolError(await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: literalPatch } }), 'literal credential apply_patch');
  assert.match(resultText(blockedPatch), /Secret-looking content is blocked/);
  assert.equal(await fs.readFile(path.join(tmp, 'compat.py'), 'utf8'), compatPyBeforeBlockedPatch, 'literal patch changed source despite rejection');

  const privateWrite = assertToolError(await client.request('tools/call', {
    name: 'write',
    arguments: {
      workspace_id: workspaceId,
      path: 'blocked-private-key.txt',
      content: '-----BEGIN PRIVATE KEY-----\nTASK003_MCP_PRIVATE_BODY\n-----END PRIVATE KEY-----\n'
    }
  }), 'private-key write');
  assert.match(resultText(privateWrite), /Secret-looking content is blocked/);
  await assert.rejects(fs.access(path.join(tmp, 'blocked-private-key.txt')), (error) => error?.code === 'ENOENT');

  console.log(`source-redaction-smoke: PASS (real MCP read/search/read_many; ${negativePaths.length} negative fixtures; write/edit/apply_patch compatibility)`);
} finally {
  client?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
