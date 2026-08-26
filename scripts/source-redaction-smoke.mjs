import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  hasSecretValue,
  hasSecretValueInUnifiedDiff,
  redactDiagnosticText,
  redactSearchQuery,
  redactSensitiveText,
  redactSensitiveTextPreservingLines,
  redactUnifiedDiff
} = await import('../dist/redact.js');
const pythonPolicy = { context: 'source', language: 'python' };

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

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function projectedRange(text, startLine = 1, endLine = undefined) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.min(lines.length, Math.floor(endLine ?? lines.length));
  return { text: numbered(lines.slice(start - 1, end).join('\n'), start), start, end, totalLines: lines.length };
}

function stripLineNumbers(text) {
  return text.split('\n').map((line) => line.replace(/^\s*\d+\s\|\s?/u, '')).join('\n');
}

function assertReadMetadata(result, source, startLine, endLine, label) {
  const expected = projectedRange(source, startLine, endLine);
  const data = result.structuredContent;
  assert.ok(data && typeof data === 'object', `${label} omitted structured read content`);
  assert.equal(data.startLine, expected.start, `${label} changed the first physical line`);
  assert.equal(data.endLine, expected.end, `${label} changed the last physical line`);
  assert.equal(data.totalLines, expected.totalLines, `${label} changed total physical line count`);
  assert.equal(data.bytes, Buffer.byteLength(source, 'utf8'), `${label} changed full-file byte metadata`);
  assert.equal(data.sha256, sha256(source), `${label} changed full-file SHA-256 metadata`);
  assert.equal(data.truncated, expected.start > 1 || expected.end < expected.totalLines, `${label} changed the truncation invariant`);
  assert.ok(Object.prototype.hasOwnProperty.call(result, '_meta'), `${label} omitted the MCP metadata envelope`);
  return expected;
}

function expectNoRawLiterals(value, literals, label) {
  const serialized = JSON.stringify(value) ?? '';
  for (const literal of literals) {
    assert.equal(serialized.includes(literal), false, `${label} leaked ${literal} in its serialized response`);
  }
}

function expectNoHostileResponseFields(value, literals, label) {
  expectNoRawLiterals(value, literals, `${label} complete serialized response`);
  expectNoRawLiterals(value?.content, literals, `${label} content`);
  expectNoRawLiterals(value?.structuredContent, literals, `${label} structuredContent`);
  expectNoRawLiterals(value?._meta, literals, `${label} _meta`);
  expectNoRawLiterals(value?.structuredContent?.analysis?.matches, literals, `${label} analysis.matches`);
  expectNoRawLiterals(value?.structuredContent?.analysis?.groups, literals, `${label} analysis.groups`);
  expectNoRawLiterals(value?.structuredContent?.analysis?.query, literals, `${label} analysis.query`);
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

async function writeRawArtifact(root, name, value) {
  if (!root) return;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function gitFixture(root) {
  for (const args of [['init'], ['config', 'core.quotePath', 'true'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  const commit = spawnSync('git', ['-c', 'user.email=source-redaction-smoke@example.com', '-c', 'user.name=Source Redaction Smoke', 'commit', '-m', 'source redaction smoke fixture'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
}

function assertPythonParserAccepted(source, label) {
  const parserScript = [
    'import pathlib, py_compile, sys, tempfile',
    'with tempfile.TemporaryDirectory() as directory:',
    '    target = pathlib.Path(directory) / "fixture.py"',
    '    target.write_text(sys.stdin.read(), encoding="utf-8")',
    '    py_compile.compile(str(target), doraise=True)'
  ].join('\n');
  const result = spawnSync(
    'python3',
    ['-c', parserScript],
    { input: source, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `${label} was not accepted by Python: ${result.stderr || result.stdout}`);
}

function assertPythonAstAccepted(source, label) {
  const parserScript = [
    'import ast, sys',
    'ast.parse(sys.stdin.read(), filename="fixture.py", mode="exec")'
  ].join('\n');
  const result = spawnSync(
    'python3',
    ['-c', parserScript],
    { input: source, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, `${label} was not accepted by ast.parse: ${result.stderr || result.stdout}`);
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
const sourcePyRedacted = redactSensitiveText(sourcePy, pythonPolicy);

function pythonBoundarySource(memberCount) {
  const members = Array.from({ length: memberCount }, (_, index) => `    field_${index}: str`);
  return [`class Boundary${memberCount}:`, ...members, '    token: Token[str]', ''].join('\n');
}

const pythonBoundaryMemberCounts = [0, 1, 95, 96, 97, 128, 256];
const pythonBoundaryLongMemberCount = 512;
const pythonBoundarySources = new Map(
  [...pythonBoundaryMemberCounts, pythonBoundaryLongMemberCount]
    .map((memberCount) => [memberCount, pythonBoundarySource(memberCount)])
);

function pythonLogicalClassSource({ header, bodyIndent = '    ', memberCount = 0 }) {
  const members = Array.from({ length: memberCount }, (_, index) => `${bodyIndent}field_${index}: str`);
  return [...header, ...members, `${bodyIndent}token: Token[str]`, ''].join('\n');
}

const pythonLogicalFixtureSpecs = [
  {
    id: 'simple-multiline-base',
    header: ['class SimpleMultiline(', '    Base,', '):'],
    memberCount: 0
  },
  {
    id: 'multiple-bases',
    header: ['class MultipleBases(', '    FirstBase,', '    SecondBase,', '):'],
    memberCount: 0
  },
  {
    id: 'metaclass-header',
    header: ['class WithMetaclass(', '    Base,', '    metaclass=Meta,', '):'],
    memberCount: 0
  },
  {
    id: 'nested-multiline-class',
    header: ['class Outer:', '    class NestedMultiline(', '        Base,', '    ):'],
    bodyIndent: '        ',
    memberCount: 0
  },
  {
    id: 'decorated-multiline-class',
    header: [
      '@decorator(',
      '    "decorator trivia: []",',
      ')',
      'class DecoratedMultiline(',
      '    Base,',
      '):'
    ],
    memberCount: 0
  },
  {
    id: 'comments-trivia-header',
    header: [
      'class CommentTrivia(',
      '    # fake class Fake[Base]:',
      '    Base,  # trailing fake ]: [',
      '):'
    ],
    memberCount: 0
  },
  {
    id: 'header-strings-fake-delimiters',
    header: [
      'class HeaderStrings(',
      '    Base["fake brackets ] : [ and colon:"],',
      '):'
    ],
    memberCount: 0
  },
  {
    id: 'triple-quoted-fake-class',
    header: [
      'class TripleQuotedHeader(',
      '    Base(',
      '        """fake class Fake(',
      '            FakeBase,',
      '        ):',
      '            fake: str',
      '        """',
      '    ),',
      '):'
    ],
    memberCount: 0
  },
  {
    id: 'mixed-tabs-spaces-header',
    header: ['class MixedTabsSpaces(', '    Base,', '):'],
    bodyIndent: '\t',
    memberCount: 0
  },
  {
    id: 'multiline-base-96-members',
    header: ['class MultilineBase96(', '    Base,', '):'],
    memberCount: 96
  },
  {
    id: 'multiline-base-512-members',
    header: ['class MultilineBase512(', '    Base,', '):'],
    memberCount: 512
  }
];

const pythonLogicalFixtures = new Map(
  pythonLogicalFixtureSpecs.map((spec) => [spec.id, {
    ...spec,
    source: pythonLogicalClassSource(spec),
    path: `python-logical-${spec.id}.py`
  }])
);

const pythonHostileResponseLiterals = [
  'QZ7',
  'ACTUAL_LITERAL_SECRET_7X9',
  'client.actualSecret',
  'client.getSecret()',
  'Token<ACTUAL_LITERAL_SECRET_7X9',
  'Token<client.actualSecret',
  'Password<client.getSecret()'
];

function pythonTokenLine(source) {
  const lines = source.split('\n');
  const line = lines.findIndex((candidate) => /token:\s*Token\[str\]/u.test(candidate));
  assert.notEqual(line, -1, 'Python logical fixture omitted its direct Token[str] member');
  return line + 1;
}

function pythonHeaderStartLine(source, fixture) {
  const lines = source.split('\n');
  const classIndex = lines.findLastIndex((line) => line.trim().startsWith(`class ${fixture.headerClassName}`));
  assert.notEqual(classIndex, -1, `${fixture.id} omitted its class header`);
  let start = classIndex;
  while (start > 0 && lines[start - 1].trim() && !lines[start - 1].trim().startsWith('class ')) start -= 1;
  return start + 1;
}

function pythonLogicalPatch(relativePath, source, startLine, targetLine, replacement, { add = false } = {}) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const target = lines[targetLine - 1];
  assert.ok(target, `Python logical patch target line ${targetLine} was missing`);
  const segment = lines.slice(startLine - 1, targetLine);
  const context = segment.slice(0, -1).map((line) => ` ${line}`);
  const trailingContext = targetLine < lines.length - 1
    ? lines.slice(targetLine, targetLine + 1).map((line) => ` ${line}`)
    : [];
  const changeLines = add
    ? [`+${replacement}`, ` ${target}`]
    : [`-${target}`, `+${replacement}`];
  const oldCount = segment.length + trailingContext.length;
  const newCount = oldCount + (add ? 1 : 0);
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${startLine},${oldCount} +${startLine},${newCount} @@`,
    ...context,
    ...changeLines,
    ...trailingContext
  ].join('\n') + '\n';
}

for (const fixture of pythonLogicalFixtures.values()) {
  fixture.headerClassName = fixture.header.find((line) => /^class\s+/u.test(line.trim()))?.trim().match(/^class\s+([A-Za-z_$][A-Za-z0-9_$]*)/u)?.[1];
  assert.ok(fixture.headerClassName, `${fixture.id} omitted a class declaration`);
  assertPythonAstAccepted(fixture.source, `Python logical ${fixture.id}`);
  assertPythonParserAccepted(fixture.source, `Python logical ${fixture.id}`);
  assert.equal(redactSensitiveText(fixture.source, pythonPolicy), fixture.source, `Python logical ${fixture.id} changed lawful source bytes`);
  assert.equal(hasSecretValue(fixture.source, pythonPolicy), false, `Python logical ${fixture.id} was classified as hostile`);
}

for (const [memberCount, source] of pythonBoundarySources) {
  const label = `Python direct class annotation after ${memberCount} members`;
  assertPythonAstAccepted(source, label);
  assertPythonParserAccepted(source, label);
  assert.equal(redactSensitiveText(source, pythonPolicy), source, `${label} changed source bytes`);
  assert.equal(hasSecretValue(source, pythonPolicy), false, `${label} was classified as hostile`);
}

// These Python fixtures separate lawful class/type provenance from nested
// dictionary and block values. The expected lawful result is the exact source
// projection; hostile values are asserted independently against raw MCP
// responses below so an implementation-generated classification cannot bless
// a value merely because it occurs inside a class suite.
const pythonProvenanceLawful = [
  'class DirectRequest:',
  '    token: Token[str]',
  '    password: PasswordType',
  '    api_token: Token[str]',
  '',
  '    separated: Token[str]',
  '',
  '    class NestedRequest:',
  '        token: Token[str]',
  '',
  'def direct_function(token: Token[str]) -> Token[str]:',
  '    return token',
  ''
].join('\n');

const pythonProvenanceHostile = [
  'class EarlierLawful:',
  '    token: Token[str]',
  '',
  'class HostileRequest:',
  '    payload = {token: Token[ACTUAL_LITERAL_SECRET_7X9]}',
  '    member_payload = {token: Token[client.actualSecret]}',
  '    call_payload = {password: Password[client.getSecret()]}',
  '',
  '    def method(self):',
  '        nested = {token: Token[ACTUAL_LITERAL_SECRET_7X9]}',
  '        return nested',
  '',
  '    if enabled:',
  '        nested_token = Token[ACTUAL_LITERAL_SECRET_7X9]',
  '',
  '    deeply_nested = {outer: {token: Token[ACTUAL_LITERAL_SECRET_7X9]}}',
  '',
  'TOP_LEVEL = {token: Token[ACTUAL_LITERAL_SECRET_7X9]}',
  ''
].join('\n');

const pythonProvenanceHostileRedacted = [
  'class EarlierLawful:',
  '    token: Token[str]',
  '',
  'class HostileRequest:',
  '    payload = {token: [REDACTED_SECRET]}',
  '    member_payload = {token: [REDACTED_SECRET]}',
  '    call_payload = {password: [REDACTED_SECRET]}',
  '',
  '    def method(self):',
  '        nested = {token: [REDACTED_SECRET]}',
  '        return nested',
  '',
  '    if enabled:',
  '        nested_token= [REDACTED_SECRET]',
  '',
  '    deeply_nested = {outer: {token: [REDACTED_SECRET]}}',
  '',
  'TOP_LEVEL = {token: [REDACTED_SECRET]}',
  ''
].join('\n');

assertPythonParserAccepted(pythonProvenanceLawful, 'Python provenance lawful fixture');
assertPythonParserAccepted(pythonProvenanceHostile, 'Python provenance hostile fixture');

const python312Lawful = [
  'type password = PasswordType',
  'type Box[T] = list[T]',
  'type multiline_password = (',
  '    PasswordType',
  ')',
  'class AliasRequest(',
  '    Base,',
  '):',
  '    password: PasswordType',
  '    token: (',
  '        Token[',
  '            str',
  '        ]',
  '    )',
  '    quoted: "PasswordType"',
  '    quoted_password: "PasswordType" = configuredToken',
  '    generic_quoted_password: list["PasswordType"]',
  '    class Nested:',
  '        password: PasswordType',
  '',
  'def annotated(password: (PasswordType), quoted_password: list["PasswordType"]):',
  '    return password',
  ''
].join('\n');

const python312Hostile = [
  'class HostileSyntax:',
  '    dict_payload = {"token": ACTUAL_LITERAL_SECRET_7X9}',
  '    list_payload = [{"token": ACTUAL_LITERAL_SECRET_7X9}]',
  '    tuple_payload = ({"password": ACTUAL_LITERAL_SECRET_7X9},)',
  '    call_payload = make_call(token=ACTUAL_LITERAL_SECRET_7X9,)',
  '    assignment_payload = token = ACTUAL_LITERAL_SECRET_7X9',
  '    def method(self):',
  '        token = ACTUAL_LITERAL_SECRET_7X9',
  '    if enabled:',
  '        token = ACTUAL_LITERAL_SECRET_7X9',
  '        type nested_password = PasswordType',
  '    for item in items:',
  '        token = ACTUAL_LITERAL_SECRET_7X9',
  '    while enabled:',
  '        token = ACTUAL_LITERAL_SECRET_7X9',
  '    with context_manager:',
  '        token = ACTUAL_LITERAL_SECRET_7X9',
  '    try:',
  '        token = ACTUAL_LITERAL_SECRET_7X9',
  '    except Exception:',
  '        pass',
  '    nested = {"outer": {"token": ACTUAL_LITERAL_SECRET_7X9}}',
  '',
  'top_level_payload = {token: client.actualSecret}',
  'call_payload = make_call(password=client.getSecret())',
  ''
].join('\n');

const python312HostileRedacted = [
  'class HostileSyntax:',
  '    dict_payload = {"token": [REDACTED_SECRET]}',
  '    list_payload = [{"token": [REDACTED_SECRET]}]',
  '    tuple_payload = ({"password": [REDACTED_SECRET]},)',
  '    call_payload = make_call(token= [REDACTED_SECRET],)',
  '    assignment_payload = token= [REDACTED_SECRET]',
  '    def method(self):',
  '        token= [REDACTED_SECRET]',
  '    if enabled:',
  '        token= [REDACTED_SECRET]',
  '        type nested_password= [REDACTED_SECRET]',
  '    for item in items:',
  '        token= [REDACTED_SECRET]',
  '    while enabled:',
  '        token= [REDACTED_SECRET]',
  '    with context_manager:',
  '        token= [REDACTED_SECRET]',
  '    try:',
  '        token= [REDACTED_SECRET]',
  '    except Exception:',
  '        pass',
  '    nested = {"outer": {"token": [REDACTED_SECRET]}}',
  '',
  'top_level_payload = {token: [REDACTED_SECRET]}',
  'call_payload = make_call(password= [REDACTED_SECRET])',
  ''
].join('\n');

assertPythonParserAccepted(python312Lawful, 'Python 3.12 lawful alias/annotation fixture');
assertPythonParserAccepted(python312Hostile, 'Python 3.12 hostile ownership fixture');
assert.equal(redactSensitiveText(python312Lawful, pythonPolicy), python312Lawful, 'Python 3.12 lawful aliases/annotations changed source bytes');
assert.equal(hasSecretValue(python312Lawful, pythonPolicy), false, 'Python 3.12 lawful aliases/annotations were classified as hostile');
assert.equal(redactSensitiveText(python312Hostile, pythonPolicy), python312HostileRedacted, 'Python 3.12 hostile ownership projection changed');
assert.equal(hasSecretValue(python312Hostile, pythonPolicy), true, 'Python 3.12 hostile ownership fixture was not classified as hostile');

const multilineHostileAliasDiff = [
  'diff --git a/multiline.py b/multiline.py',
  '--- a/multiline.py',
  '+++ b/multiline.py',
  '@@ -1,2 +1,4 @@',
  ' class R:',
  '+    payload = {password: ACTUAL_LITERAL_SECRET_7X9}',
  ''
].join('\n');
const multilineHostileAliasDiffRedacted = [
  'diff --git a/multiline.py b/multiline.py',
  '--- a/multiline.py',
  '+++ b/multiline.py',
  '@@ -1,2 +1,4 @@',
  ' class R:',
  '+    payload = {password: [REDACTED_SECRET]}',
  ''
].join('\n');
const multilineHostileAnnotationDiff = multilineHostileAliasDiff
  .replaceAll('password: ACTUAL_LITERAL_SECRET_7X9', 'password: client.getSecret()')
  .replaceAll('multiline.py', 'multiline-annotation.py');
const multilineHostileAnnotationDiffRedacted = multilineHostileAliasDiffRedacted
  .replaceAll('password: [REDACTED_SECRET]', 'password: [REDACTED_SECRET]')
  .replaceAll('multiline.py', 'multiline-annotation.py');
for (const [label, source, expected] of [
  ['multiline hostile alias diff', multilineHostileAliasDiff, multilineHostileAliasDiffRedacted],
  ['multiline hostile annotation diff', multilineHostileAnnotationDiff, multilineHostileAnnotationDiffRedacted]
]) {
  assert.equal(hasSecretValue(source, pythonPolicy), true, `${label} was not classified as hostile`);
  assert.equal(redactSensitiveText(source, pythonPolicy), expected, `${label} changed framing or line count`);
  assert.equal(redactSensitiveText(source, pythonPolicy).includes('ACTUAL_LITERAL_SECRET_7X9'), false, `${label} leaked continuation content`);
  const diagnosticRedacted = redactDiagnosticText(source);
  assert.equal(diagnosticRedacted.includes('ACTUAL_LITERAL_SECRET_7X9'), false, `${label} diagnostic leaked continuation content`);
  assert.equal(diagnosticRedacted.split(/\r?\n/u).length, source.split(/\r?\n/u).length, `${label} diagnostic changed line count`);
}

// This fixture keeps a lawful direct class annotation at tab+space column 12,
// then exercises the parseable mixed-indentation dictionary/block shapes that
// must not inherit provenance from the surrounding class. The exact first
// hostile value intentionally matches the reported regression.
const pythonMixedProvenance = [
  'class MixedLawful:',
  '\t    token: Token[str]',
  '',
  'class Request:',
  '        config = {',
  '\t    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  '        }',
  '        member_payload = {',
  '\t    token: Token[client.actualSecret]',
  '        }',
  '        call_payload = {',
  '\t    password: Password[client.getSecret()]',
  '        }',
  '',
  '        def method(self):',
  '\t        nested = {token: Token[ACTUAL_LITERAL_SECRET_7X9]}',
  '\t        return nested',
  '',
  '        if enabled:',
  '\t        nested_token = Token[ACTUAL_LITERAL_SECRET_7X9]',
  '',
  '        deeply_nested = {',
  '\t    outer: {token: Token[ACTUAL_LITERAL_SECRET_7X9]}',
  '        }',
  '',
  'TOP_LEVEL = {token: Token[ACTUAL_LITERAL_SECRET_7X9]}',
  ''
].join('\n');

const pythonMixedProvenanceRedacted = [
  'class MixedLawful:',
  '\t    token: Token[str]',
  '',
  'class Request:',
  '        config = {',
  '\t    token: [REDACTED_SECRET]',
  '        }',
  '        member_payload = {',
  '\t    token: [REDACTED_SECRET]',
  '        }',
  '        call_payload = {',
  '\t    password: [REDACTED_SECRET]',
  '        }',
  '',
  '        def method(self):',
  '\t        nested = {token: [REDACTED_SECRET]}',
  '\t        return nested',
  '',
  '        if enabled:',
  '\t        nested_token= [REDACTED_SECRET]',
  '',
  '        deeply_nested = {',
  '\t    outer: {token: [REDACTED_SECRET]}',
  '        }',
  '',
  'TOP_LEVEL = {token: [REDACTED_SECRET]}',
  ''
].join('\n');

assertPythonParserAccepted(pythonMixedProvenance, 'Python mixed-indentation provenance fixture');

const pythonContinuationExplicitBackslash = '    backslash_payload = { ' + '\\';
const pythonContinuationExplicitBackslashOnly = '    explicit_only_payload = ' + '\\';
const pythonContinuationProvenance = [
  'class ContinuationRequest:',
  '    direct: Token[str]',
  '    brace_payload = {',
  '    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  '    }',
  '',
  '    square_payload = [',
  '    Token[str]',
  '    ]',
  '',
  '    paren_payload = (',
  '    Token[str]',
  '    )',
  '',
  '    call_payload = some_call(',
  '    token=Token[ACTUAL_LITERAL_SECRET_7X9]',
  '    )',
  '',
  pythonContinuationExplicitBackslash,
  '    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  '    }',
  '',
  pythonContinuationExplicitBackslashOnly,
  '    Token[str]',
  '',
  'class MixedContinuation:',
  '\t    lawful: Token[str]',
  '\t    mixed_payload = {',
  '            token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  '            }',
  ''
].join('\n');

const pythonContinuationProvenanceRedacted = [
  'class ContinuationRequest:',
  '    direct: Token[str]',
  '    brace_payload = {',
  '    token: [REDACTED_SECRET]',
  '    }',
  '',
  '    square_payload = [',
  '    Token[str]',
  '    ]',
  '',
  '    paren_payload = (',
  '    Token[str]',
  '    )',
  '',
  '    call_payload = some_call(',
  '    token= [REDACTED_SECRET]',
  '    )',
  '',
  pythonContinuationExplicitBackslash,
  '    token: [REDACTED_SECRET]',
  '    }',
  '',
  pythonContinuationExplicitBackslashOnly,
  '    Token[str]',
  '',
  'class MixedContinuation:',
  '\t    lawful: Token[str]',
  '\t    mixed_payload = {',
  '            token: [REDACTED_SECRET]',
  '            }',
  ''
].join('\n');

const pythonContinuationHostileLiterals = [
  'ACTUAL_LITERAL_SECRET_7X9',
  'client.getSecret()',
  'Token[ACTUAL_LITERAL_SECRET_7X9',
  'Password[client.getSecret()'
];

assertPythonParserAccepted(pythonContinuationProvenance, 'Python continuation provenance fixture');
assert.equal(hasSecretValue(pythonContinuationProvenance, pythonPolicy), true, 'Python continuation provenance fixture was not classified as hostile');
assert.equal(
  redactSensitiveText(pythonContinuationProvenance, pythonPolicy),
  pythonContinuationProvenanceRedacted,
  'Python continuation provenance direct policy changed the independently expected projection'
);
assert.equal(
  redactSensitiveText(pythonContinuationProvenance, pythonPolicy).includes('ACTUAL_LITERAL_SECRET_7X9'),
  false,
  'Python continuation provenance direct policy leaked the raw literal'
);

const pythonContinuationLawfulFixtures = [
  [
    'class R:\n    supported = [\n    Token[str]\n    ]',
    'lawful list continuation'
  ],
  [
    'class R:\n    supported = (\n    Token[str],\n    )',
    'lawful tuple continuation'
  ],
  [
    'class R:\n    supported = some_call(\n    Token[str]\n    )',
    'lawful call continuation'
  ],
  [
    'class R:\n    token: Token[str]',
    'lawful direct annotation'
  ],
  [
    'class R:\n        token: Token[str]',
    'lawful deeper direct annotation'
  ]
];
for (const [source, label] of pythonContinuationLawfulFixtures) {
  assertPythonParserAccepted(source, label);
  assert.equal(redactSensitiveText(source, pythonPolicy), source, `${label} changed source bytes`);
  assert.equal(hasSecretValue(source, pythonPolicy), false, `${label} was classified as hostile`);
}

const collisionPath = '2 |   token: Token<string>;';
const collisionSource = 'type Input = {\n  token: Token<string>;\n};\n';
const identicalSourceBody = 'type Input = {\n  token: Token<string>;\n};\n';
const collisionMetadataPath = '2 |   token: [REDACTED_SECRET];';

const safeConfig = [
  'const API_TOKEN = process.env.API_TOKEN;',
  'const PASSWORD = settings.password;',
  ''
].join('\n');

// These fixtures deliberately select interior lines without the enclosing
// declaration/object/class syntax. The expected range text is derived from
// the raw fixture, not from another MCP response, so a range cannot pass by
// merely agreeing with a full-read redaction artifact.
const rangedLawfulTs = [
  'type Input = {',
  '  token: Token<string>;',
  '  password: PasswordType;',
  '};',
  'interface Credentials<T> {',
  '  token: Token<T>;',
  '  password: PasswordType;',
  '}',
  'const {',
  '  hasSecretValue: policyHasSecretValue,',
  '  apiToken: configuredToken,',
  '} = policy;',
  'function rangedFunction(',
  '  token: Token<string>,',
  '  password: PasswordType',
  '): Token<string> {',
  '  return token;',
  '}',
  'const rangedArrow = (',
  '  token: Token<string>,',
  '  password: PasswordType',
  '): Token<string> => token;',
  ''
].join('\n');

const rangedLawfulPy = [
  'class Request:',
  '    token: Token[str]',
  '    password: PasswordType',
  '',
  'def ranged_function(',
  '    token: Token[str],',
  '    password: PasswordType',
  ') -> Token[str]:',
  '    return token',
  ''
].join('\n');

const rangedHostileFixtures = {
  'ranged-hostile.yaml': [
    'credentials:',
    '  token: QZ7',
    '  password: ACTUAL_LITERAL_SECRET_7X9',
    '  apiToken: client.actualSecret',
    '  secret_call: client.getSecret()',
    'safe: runtimeToken',
    ''
  ].join('\n'),
  'ranged-hostile.env': [
    'TOKEN=QZ7',
    'PASSWORD=ACTUAL_LITERAL_SECRET_7X9',
    'API_TOKEN=client.actualSecret',
    'SECRET=client.getSecret()',
    'SAFE=runtimeToken',
    ''
  ].join('\n'),
  'ranged-hostile.json': [
    '{',
    '  "token": "ACTUAL_LITERAL_SECRET_7X9",',
    '  "password": "QZ7",',
    '  "apiToken": "client.actualSecret",',
    '  "secret": "client.getSecret()",',
    '  "safe": "runtimeToken"',
    '}',
    ''
  ].join('\n'),
  'ranged-hostile.ts': [
    'const payload = {',
    '  token: Token<ACTUAL_LITERAL_SECRET_7X9>,',
    '  password: client.actualSecret,',
    '  apiToken: client.getSecret(),',
    '  nested_token: Wrapper<Token<client.actualSecret>>',
    '};',
    'const safeTail = runtimeToken;',
    ''
  ].join('\n')
};

const rangedHostileRedacted = {
  'ranged-hostile.yaml': [
    'credentials:',
    '  token: [REDACTED_SECRET]',
    '  password: [REDACTED_SECRET]',
    '  apiToken: [REDACTED_SECRET]',
    '  secret_call: [REDACTED_SECRET]',
    'safe: runtimeToken',
    ''
  ].join('\n'),
  'ranged-hostile.env': [
    'TOKEN= [REDACTED_SECRET]',
    'PASSWORD= [REDACTED_SECRET]',
    'API_TOKEN= [REDACTED_SECRET]',
    'SECRET= [REDACTED_SECRET]',
    'SAFE=runtimeToken',
    ''
  ].join('\n'),
  'ranged-hostile.json': [
    '{',
    '  "token": [REDACTED_SECRET],',
    '  "password": [REDACTED_SECRET],',
    '  "apiToken": [REDACTED_SECRET],',
    '  "secret": [REDACTED_SECRET],',
    '  "safe": "runtimeToken"',
    '}',
    ''
  ].join('\n'),
  'ranged-hostile.ts': [
    'const payload = {',
    '  token: [REDACTED_SECRET],',
    '  password: [REDACTED_SECRET],',
    '  apiToken: [REDACTED_SECRET],',
    '  nested_token: [REDACTED_SECRET]',
    '};',
    'const safeTail = runtimeToken;',
    ''
  ].join('\n')
};

const rangedByteLimit = `const rangedByteLimit = ${JSON.stringify('x'.repeat(1_500))};\nconst rangedByteTail = true;\n`;

const privateRangedFixture = [
  'const rangedBefore = true;',
  '-----BEGIN PRIVATE KEY-----',
  'RANGED_PRIVATE_BODY_7X9',
  '-----END PRIVATE KEY-----',
  'const rangedAfter = true;',
  ''
].join('\n');

const privateCrlfFixture = [
  'const crlfBefore = true;',
  '-----BEGIN PRIVATE KEY-----',
  'CRLF_PRIVATE_BODY_7X9',
  '-----END PRIVATE KEY-----',
  'const crlfAfter = true;',
  ''
].join('\r\n');

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
  'typed-literal.txt': 'TOKEN: str = "ACTUAL_LITERAL_SECRET_7X9"\nPASSWORD: str = "QZ7"\n',
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

const looksPythonHostile = 'class R:\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n';
const looksPythonHostileRedacted = redactSensitiveText(looksPythonHostile);
const looksPythonHostileFixtures = {
  'looks-python.yaml': looksPythonHostile,
  'looks-python.txt': looksPythonHostile,
  'looks-python.js': looksPythonHostile,
  'looks-python.ts': looksPythonHostile,
  'looks-python.config': looksPythonHostile
};
const looksPythonLongMembers = Array.from({ length: 100 }, (_, index) => `    field_${index}: str`);
const looksPythonLawful = [
  'from typing import Annotated',
  '',
  'token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  'token_call: Token[str] = client.getSecret()',
  'password_quoted: Token[str] = "ACTUAL_LITERAL_SECRET_7X9"',
  'password_parenthesized: Token[str] = (ACTUAL_LITERAL_SECRET_7X9)',
  'password_quoted_annotation: "Token[ACTUAL_LITERAL_SECRET_7X9]"',
  'password_parenthesized_annotation: (Token[ACTUAL_LITERAL_SECRET_7X9])',
  'password_union: Token[ACTUAL_LITERAL_SECRET_7X9] | None',
  'password_annotated: Annotated[Token[ACTUAL_LITERAL_SECRET_7X9], "metadata"]',
  'password_multiline: (',
  '    Token[',
  '        ACTUAL_LITERAL_SECRET_7X9',
  '    ]',
  ')',
  '',
  'def annotated_function(token: Token[ACTUAL_LITERAL_SECRET_7X9], password_quoted: "ACTUAL_LITERAL_SECRET_7X9") -> Token[ACTUAL_LITERAL_SECRET_7X9]:',
  '    return token',
  '',
  'type password_call_alias = client.getSecret()',
  'type password_quoted_alias = "ACTUAL_LITERAL_SECRET_7X9"',
  'type password_parenthesized_alias = (Token[ACTUAL_LITERAL_SECRET_7X9])',
  'type password_union_alias = Token[ACTUAL_LITERAL_SECRET_7X9] | None',
  'type password_annotated_alias = Annotated[Token[ACTUAL_LITERAL_SECRET_7X9], "metadata"]',
  'type password_multiline_alias = (',
  '    Token[',
  '        ACTUAL_LITERAL_SECRET_7X9',
  '    ]',
  ')',
  '',
  'class R:',
  '    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  '    token_call: Token[str] = client.getSecret()',
  '    type password_nested = Token[ACTUAL_LITERAL_SECRET_7X9]',
  '    type password_nested_box[T] = list[Token[ACTUAL_LITERAL_SECRET_7X9]]',
  '',
  'class LongR:',
  ...looksPythonLongMembers,
  '    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
  ''
].join('\n');

assertPythonAstAccepted(looksPythonLawful, 'looks-Python lawful canary');
assertPythonParserAccepted(looksPythonLawful, 'looks-Python lawful canary');
assert.equal(redactSensitiveText(looksPythonLawful, pythonPolicy), looksPythonLawful, 'looks-Python lawful direct policy changed exact source');
assert.equal(hasSecretValue(looksPythonLawful, pythonPolicy), false, 'looks-Python lawful direct policy was classified as hostile');
for (const [relativePath, source] of Object.entries(looksPythonHostileFixtures)) {
  assert.equal(redactSensitiveText(source), looksPythonHostileRedacted, `${relativePath} direct policy changed generic projection`);
  assert.equal(hasSecretValue(source), true, `${relativePath} direct policy was not failed closed`);
  assert.notEqual(redactSensitiveText(source), source, `${relativePath} unexpectedly received Python provenance`);
}
assert.equal(redactSensitiveText(looksPythonHostile, pythonPolicy), looksPythonHostile, 'explicit Python source hint did not grant lawful AST ownership');
assert.equal(hasSecretValue(looksPythonHostile, pythonPolicy), false, 'explicit Python source hint did not grant lawful AST ownership');
assert.equal(redactSensitiveText(looksPythonHostile), looksPythonHostileRedacted, 'Python-looking text without a language hint was not failed closed');
assert.equal(redactSensitiveText(looksPythonHostile, { context: 'diagnostic', language: 'python' }), looksPythonHostileRedacted, 'diagnostic text incorrectly received Python parser authority');
assert.equal(hasSecretValue(looksPythonHostile, { context: 'diagnostic', language: 'python' }), true, 'diagnostic text incorrectly received Python parser authority');
const pythonNoHintCall = 'token: Token[str] = client.getSecret()';
assert.equal(hasSecretValue(pythonNoHintCall), true, 'Python-looking typed call without a language hint was not failed closed');
assert.equal(redactSensitiveText(pythonNoHintCall).includes('client.getSecret()'), false, 'Python-looking typed call without a language hint leaked');
assert.equal(hasSecretValue(pythonNoHintCall, pythonPolicy), false, 'explicit Python hint rejected a lawful typed call');
assert.equal(redactSensitiveText(pythonNoHintCall, pythonPolicy), pythonNoHintCall, 'explicit Python hint changed a lawful typed call');

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
  'def generic(token: Token[str]) -> Token[str]:\n    return token',
  'class GenericRequest:\n    token: Token[str]',
  'class Request:\n    token: Token[str]\n    password: PasswordType',
  'class SquareRequest:\n    token: Token[str]',
  'def square_parameter(token: Token[str]) -> Token[str]:\n    return token',
  'type password = PasswordType',
  'type password[T] = list[T]',
  'type multiline_password = (\n    PasswordType\n)',
  'class AliasRequest:\n    type password = PasswordType\n    parenthesized: (\n        Token[\n            str\n        ]\n    )\n    quoted: \'PasswordType\'',
  'def annotated(password: (PasswordType), quoted: \'PasswordType\') -> Token[str]:\n    return password'
];
for (const sample of directSafe) {
  const python = /^(?:def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(|class\s+[A-Za-z_][A-Za-z0-9_]*(?:\([^\n]*\))?:|type\s+[A-Za-z_][A-Za-z0-9_]*(?:\[[^\n]*\])?\s*=)|^TOKEN:\s/mu.test(sample) && !sample.includes('{');
  const options = python ? pythonPolicy : {};
  assert.equal(redactSensitiveText(sample, options), sample, `policy changed lawful source: ${sample}`);
  assert.equal(hasSecretValue(sample, options), false, `policy classified lawful source as secret: ${sample}`);
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
  '(TOKEN, other) = (ACTUAL_LITERAL_SECRET_7X9, value)',
  'password: (ACTUAL_LITERAL_SECRET_7X9)',
  'password: (client.getSecret())',
  'type password = (ACTUAL_LITERAL_SECRET_7X9)',
  'password: (\n    Token[ACTUAL_LITERAL_SECRET_7X9]\n)',
  'token: str = {"token": ACTUAL_LITERAL_SECRET_7X9, "password": client.getSecret()}',
  'token: str = make_call(token=ACTUAL_LITERAL_SECRET_7X9)',
  'type password = make_call(token=ACTUAL_LITERAL_SECRET_7X9)',
  'const API_KEY: string = "ACTUAL_LITERAL_SECRET_7X9";',
  'const API_KEY: { token: Token<string>; password: string } = "QZ7";',
  'TOKEN: str = "ACTUAL_LITERAL_SECRET_7X9"',
  'type password = "ACTUAL_LITERAL_SECRET_7X9"',
  'type password[T] = call(ACTUAL_LITERAL_SECRET_7X9)',
  'def malformed(password: PasswordType):',
  'class C:\n    list_payload = [{"token": ACTUAL_LITERAL_SECRET_7X9}]',
  'class C:\n    tuple_payload = ({"password": ACTUAL_LITERAL_SECRET_7X9},)',
  'class C:\n    call_payload = some_call(token=ACTUAL_LITERAL_SECRET_7X9)',
  'class C:\n    token = ACTUAL_LITERAL_SECRET_7X9',
  'class C:\n    def method(self):\n        token = ACTUAL_LITERAL_SECRET_7X9',
  'class C:\n    if enabled:\n        token = ACTUAL_LITERAL_SECRET_7X9',
  'class C:\n    for item in items:\n        token = ACTUAL_LITERAL_SECRET_7X9',
  'class C:\n    while enabled:\n        token = ACTUAL_LITERAL_SECRET_7X9',
  'class C:\n    with context:\n        token = ACTUAL_LITERAL_SECRET_7X9',
  'class C:\n    try:\n        token = ACTUAL_LITERAL_SECRET_7X9\n    except Exception:\n        pass',
  'class C:\n    nested = {outer: {token: client.actualSecret}}',
  'token: client.actualSecret',
  'token: client.getSecret()'
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
const overLimitPython = `class OverLimit:\n    password: PasswordType\n${'x'.repeat(2_000_001)}`;
assert.equal(hasSecretValue(overLimitPython, pythonPolicy), true, 'over-limit Python source was not failed closed');
assert.equal(redactSensitiveText(overLimitPython, pythonPolicy).includes('password: PasswordType'), false, 'over-limit Python source preserved ambiguous credential provenance');

const squareTailCases = [
  ['token: Token[ACTUAL_LITERAL_SECRET_7X9]', 'token: [REDACTED_SECRET]'],
  ['password: Password[client.getSecret()]', 'password: [REDACTED_SECRET]'],
  ['token: Token[Wrapper[ACTUAL_LITERAL_SECRET_7X9]]', 'token: [REDACTED_SECRET]'],
  ['token: Token [ ACTUAL_LITERAL_SECRET_7X9 ]', 'token: [REDACTED_SECRET]'],
  [
    'token: Token[ACTUAL_LITERAL_SECRET_7X9\nconst lawful = runtimeToken;',
    'token: [REDACTED_SECRET]\nconst lawful = runtimeToken;'
  ],
  [
    'token: Token[ACTUAL_LITERAL_SECRET_7X9=LEAK\nconst lawful = runtimeToken;',
    'token: [REDACTED_SECRET]\nconst lawful = runtimeToken;'
  ],
  [
    'token: Token[ACTUAL_LITERAL_SECRET_7X9>\nconst lawful = runtimeToken;',
    'token: [REDACTED_SECRET]\nconst lawful = runtimeToken;'
  ]
];
for (const [sample, expected] of squareTailCases) {
  assert.equal(redactSensitiveText(sample), expected, `square generic tail redaction changed: ${sample}`);
  assert.equal(hasSecretValue(sample), true, `square generic tail was not classified: ${sample}`);
}
for (const sample of [
  'class SquareTailLawful:\n    token: Token[str]',
  'def squareTailFunction(token: Token[str]) -> Token[str]:\n    return token'
]) {
  assert.equal(redactSensitiveText(sample, pythonPolicy), sample, `lawful square generic source changed: ${sample}`);
  assert.equal(hasSecretValue(sample, pythonPolicy), false, `lawful square generic source classified as secret: ${sample}`);
}

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

// Unified diffs carry two independent source identities. The old side must
// use --- metadata, the new side must use +++, shared context must be lawful
// on both sides, and /dev/null must remain an absent side. These assertions
// use neutral observations of the resulting bytes rather than implementation
// labels for the raw-sensitive checks.
const sideRoutingTxtToPy = [
  'diff --git a/side-old.txt b/side-new.py',
  'similarity index 80%',
  'rename from side-old.txt',
  'rename to side-new.py',
  '--- a/side-old.txt',
  '+++ b/side-new.py',
  '@@ -1,2 +1,2 @@',
  ' class SideRouting:',
  '-    token: Token[SIDE_OLD_LITERAL]',
  '+    token: Token[SIDE_NEW_LITERAL]',
  ''
].join('\n');
const sideRoutingPyToTxt = sideRoutingTxtToPy
  .replaceAll('side-old.txt', 'side-old.py')
  .replaceAll('side-new.py', 'side-new.txt');
const sideRoutingContext = [
  'diff --git a/side-context.txt b/side-context.py',
  'rename from side-context.txt',
  'rename to side-context.py',
  '--- a/side-context.txt',
  '+++ b/side-context.py',
  '@@ -1,3 +1,3 @@',
  ' class SideRouting:',
  '     token: Token[SIDE_CONTEXT_LITERAL]',
  '-    old_value = true',
  '+    new_value = true',
  ''
].join('\n');
const sideRoutingCreate = [
  'diff --git a/side-created.py b/side-created.py',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/side-created.py',
  '@@ -0,0 +1,2 @@',
  '+class SideRouting:',
  '+    token: Token[SIDE_CREATED_LITERAL]',
  ''
].join('\n');
const sideRoutingDelete = [
  'diff --git a/side-deleted.py b/side-deleted.py',
  'deleted file mode 100644',
  '--- a/side-deleted.py',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-class SideRouting:',
  '-    token: Token[SIDE_DELETED_LITERAL]',
  ''
].join('\n');
for (const [label, source, oldExpected, newExpected, hasRaw] of [
  ['txt-to-py', sideRoutingTxtToPy, false, true, true],
  ['py-to-txt', sideRoutingPyToTxt, true, false, true],
  ['context', sideRoutingContext, false, false, true],
  ['create', sideRoutingCreate, false, true, false],
  ['delete', sideRoutingDelete, true, false, false]
]) {
  const redacted = redactUnifiedDiff(source);
  const oldContainsLiteral = redacted.includes('SIDE_OLD_LITERAL') || redacted.includes('SIDE_DELETED_LITERAL');
  const newContainsLiteral = redacted.includes('SIDE_NEW_LITERAL') || redacted.includes('SIDE_CREATED_LITERAL');
  assert.equal(oldContainsLiteral, oldExpected, `${label} changed old-side source fidelity`);
  assert.equal(newContainsLiteral, newExpected, `${label} changed new-side source fidelity`);
  assert.equal(hasSecretValueInUnifiedDiff(source), hasRaw, `${label} changed raw-sensitive classification`);
}
const sideRoutingMixed = `${sideRoutingTxtToPy}${sideRoutingPyToTxt}`;
const sideRoutingMixedOutput = redactUnifiedDiff(sideRoutingMixed);
const mixedPythonBytesPresent = sideRoutingMixedOutput.includes('+    token: Token[SIDE_NEW_LITERAL]')
  && sideRoutingMixedOutput.includes('-    token: Token[SIDE_OLD_LITERAL]');
const mixedTextBytesMasked = sideRoutingMixedOutput.includes('+    token: [REDACTED_SECRET]')
  && sideRoutingMixedOutput.includes('-    token: [REDACTED_SECRET]');
assert.equal(mixedPythonBytesPresent, true, 'mixed side routing lost lawful Python-side bytes');
assert.equal(mixedTextBytesMasked, true, 'mixed side routing preserved non-Python-side bytes');
const consultedDiffPaths = [];
redactUnifiedDiff(sideRoutingTxtToPy, (pathHint) => {
  consultedDiffPaths.push(pathHint);
  return pathHint?.endsWith('.py') ? 'python' : undefined;
});
assert.deepEqual(consultedDiffPaths, ['side-old.txt', 'side-new.py'], 'redaction callback did not consult old/new paths independently');
const consultedCheckPaths = [];
hasSecretValueInUnifiedDiff(sideRoutingTxtToPy, (pathHint) => {
  consultedCheckPaths.push(pathHint);
  return pathHint?.endsWith('.py') ? 'python' : undefined;
});
assert.deepEqual(consultedCheckPaths, ['side-old.txt', 'side-new.py'], 'classification callback did not consult old/new paths independently');
const contradictorySideMetadata = sideRoutingTxtToPy
  .replace('rename from side-old.txt', 'rename from contradictory.py')
  .replace('side-old.txt', 'side-old.py');
const contradictoryOutput = redactUnifiedDiff(contradictorySideMetadata);
const contradictoryOldBytesPresent = contradictoryOutput.includes('-    token: Token[SIDE_OLD_LITERAL]');
const contradictoryNewBytesPresent = contradictoryOutput.includes('+    token: Token[SIDE_NEW_LITERAL]');
assert.equal(contradictoryOldBytesPresent, false, 'contradictory old-side metadata donated parser provenance');
assert.equal(contradictoryNewBytesPresent, true, 'contradictory old-side metadata disabled the unaffected new side');

const mcpRouteTxtSource = [
  'class McpRoute:',
  '    marker_one = True',
  '    marker_two = True',
  '    token: Token[MCP_ROUTE_TXT_LITERAL]',
  '    marker_three = True',
  ''
].join('\n');
const mcpRoutePySource = [
  'class McpRoute:',
  '    marker_one = True',
  '    marker_two = True',
  '    token: Token[MCP_ROUTE_PY_LITERAL]',
  '    marker_three = True',
  ''
].join('\n');
const mcpCopyTxtSource = [
  'class McpCopyTxt:',
  '    txt_only_one = True',
  '    txt_only_two = True',
  '    txt_only_three = True',
  '    token: Token[MCP_ROUTE_TXT_LITERAL]',
  '    txt_only_four = True',
  ''
].join('\n');
const mcpCopyPySource = [
  'class McpCopyPy:',
  '    py_only_one = True',
  '    py_only_two = True',
  '    py_only_three = True',
  '    token: Token[MCP_ROUTE_PY_LITERAL]',
  '    py_only_four = True',
  ''
].join('\n');
const mcpHeaderPayloadSource = [
  'class HeaderPayload:',
  '    token: Token[MCP_HEADER_LITERAL]',
  '    payload = """',
  '-- old_marker',
  '"""',
  ''
].join('\n');
const mcpScopedTxtSource = [
  'class ScopedRoute:',
  '    marker_one = True',
  '    marker_two = True',
  '    token: Token[MCP_SCOPED_OLD_LITERAL]',
  '    marker_three = True',
  ''
].join('\n');
const applyRenameOldTxtSource = [
  'class ApplyRenameOldTxt:',
  '    token: Token[APPLY_RENAME_OLD_LITERAL]',
  ''
].join('\n');
const applyRenameOldPySource = [
  'class ApplyRenameOldPy:',
  '    token: Token[str]',
  ''
].join('\n');
const applyRenameHostileLiterals = [
  'APPLY_RENAME_OLD_LITERAL',
  'APPLY_RENAME_NEW_LITERAL'
];

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-source-redaction-'));
const rawArtifactDir = process.env.SOURCE_REDACTION_RAW_ARTIFACT_DIR;
let client;
try {
  await writeFixture(tmp, 'source.ts', sourceTs);
  await writeFixture(tmp, 'source.py', sourcePy);
  await writeFixture(tmp, 'looks-python.py', looksPythonLawful);
  for (const [relativePath, source] of Object.entries(looksPythonHostileFixtures)) await writeFixture(tmp, relativePath, source);
  await writeFixture(tmp, 'python-provenance-lawful.py', pythonProvenanceLawful);
  await writeFixture(tmp, 'python-provenance-hostile.py', pythonProvenanceHostile);
  await writeFixture(tmp, 'python-312-lawful.py', python312Lawful);
  await writeFixture(tmp, 'python-312-hostile.py', python312Hostile);
  await writeFixture(tmp, 'python-mixed-provenance.py', pythonMixedProvenance);
  await writeFixture(tmp, 'python-continuation-provenance.py', pythonContinuationProvenance);
  await writeFixture(tmp, 'python-boundary-96.py', pythonBoundarySources.get(96));
  await writeFixture(tmp, `python-boundary-${pythonBoundaryLongMemberCount}.py`, pythonBoundarySources.get(pythonBoundaryLongMemberCount));
  for (const fixture of pythonLogicalFixtures.values()) await writeFixture(tmp, fixture.path, fixture.source);
  await writeFixture(tmp, collisionPath, collisionSource);
  await writeFixture(tmp, 'identical-source-a.ts', identicalSourceBody);
  await writeFixture(tmp, 'identical-source-b.ts', identicalSourceBody);
  await writeFixture(tmp, 'safe-config.js', safeConfig);
  await writeFixture(tmp, 'ranged-lawful.ts', rangedLawfulTs);
  await writeFixture(tmp, 'ranged-lawful.py', rangedLawfulPy);
  for (const [relativePath, content] of Object.entries(rangedHostileFixtures)) await writeFixture(tmp, relativePath, content);
  await writeFixture(tmp, 'ranged-byte-limit.ts', rangedByteLimit);
  await writeFixture(tmp, 'private-ranged.txt', privateRangedFixture);
  await writeFixture(tmp, 'private-crlf.txt', privateCrlfFixture);
  await writeFixture(tmp, 'binary-private.ts', binaryPrivateFixture);
  await writeFixture(tmp, 'mixed-private.ts', mixedPrivateFixture);
  await writeFixture(tmp, 'invalid-private.ts', invalidPrivateFixture);
  await writeFixture(tmp, relationshipSecretPath, relationshipSource);
  await writeFixture(tmp, 'consumer.ts', relationshipConsumer);
  for (const [relativePath, content] of Object.entries(privateSearchFixtures)) await writeFixture(tmp, relativePath, content);
  for (const [relativePath, content] of Object.entries(negativeFixtures)) await writeFixture(tmp, relativePath, content);
  await writeFixture(tmp, 'mcp-rename.txt', mcpRouteTxtSource);
  await writeFixture(tmp, 'mcp-rename.py', mcpRoutePySource);
  await writeFixture(tmp, 'mcp-copy.txt', mcpCopyTxtSource);
  await writeFixture(tmp, 'mcp-copy.py', mcpCopyPySource);
  await writeFixture(tmp, 'header-payload.py', mcpHeaderPayloadSource);
  await writeFixture(tmp, 'scope.py/old.txt', mcpScopedTxtSource);
  await writeFixture(tmp, 'apply-rename-old.txt', applyRenameOldTxtSource);
  await writeFixture(tmp, 'apply-rename-old.py', applyRenameOldPySource);
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

  // These names intentionally look like Python only in their contents. The
  // path, not text resemblance, is the sole authority for parser provenance.
  const looksPythonRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'looks-python.py' }
  }), 'looks-Python lawful full read');
  assertReadMetadata(looksPythonRead, looksPythonLawful, 1, undefined, 'looks-Python lawful full read');
  assert.equal(looksPythonRead.structuredContent.text, numbered(looksPythonLawful), 'looks-Python lawful read changed exact source bytes');
  assert.equal(resultText(looksPythonRead).includes(numbered(looksPythonLawful)), true, 'looks-Python lawful read content envelope changed exact source bytes');
  assert.equal(JSON.stringify(looksPythonRead).includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'looks-Python lawful read was unexpectedly redacted');
  await writeRawArtifact(rawArtifactDir, 'looks-python-lawful-read', looksPythonRead);

  const looksPythonLines = looksPythonLawful.split('\n');
  const looksPythonRange = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'looks-python.py', start_line: 3, end_line: 16 }
  }), 'looks-Python lawful ranged read');
  assertReadMetadata(looksPythonRange, looksPythonLawful, 3, 16, 'looks-Python lawful ranged read');
  assert.equal(looksPythonRange.structuredContent.text, projectedRange(looksPythonLawful, 3, 16).text, 'looks-Python lawful ranged read changed source projection');
  assert.equal(looksPythonLines.slice(2, 16).some((line) => line.includes('ACTUAL_LITERAL_SECRET_7X9')), true, 'looks-Python lawful ranged read omitted its source marker');

  const looksPythonReadManyPaths = ['looks-python.py', ...Object.keys(looksPythonHostileFixtures)];
  const looksPythonReadMany = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: looksPythonReadManyPaths.map((path) => ({ path })) }
  }), 'looks-Python canary read_many');
  for (const [index, relativePath] of looksPythonReadManyPaths.entries()) {
    const source = relativePath === 'looks-python.py' ? looksPythonLawful : looksPythonHostileFixtures[relativePath];
    const projection = relativePath === 'looks-python.py' ? source : looksPythonHostileRedacted;
    const item = looksPythonReadMany.structuredContent.results?.[index];
    assert.equal(item?.index, index, `looks-Python canary read_many changed item ${index} order`);
    assert.equal(item?.path, relativePath, `looks-Python canary read_many changed item ${index} path`);
    assert.equal(item?.ok, true, `looks-Python canary read_many failed item ${index}`);
    assert.equal(item?.result?.text, numbered(projection), `looks-Python canary read_many changed item ${index} source projection`);
    if (relativePath === 'looks-python.py') {
      assert.equal(JSON.stringify(item).includes('client.getSecret()'), true, `looks-Python lawful read_many item ${index} unexpectedly redacted source`);
    } else expectNoHostileResponseFields(item, ['ACTUAL_LITERAL_SECRET_7X9'], `looks-Python hostile read_many item ${index}`);
  }
  assert.equal(resultText(looksPythonReadMany).includes(numbered(looksPythonLawful)), true, 'looks-Python canary read_many omitted lawful source body');
  for (const relativePath of Object.keys(looksPythonHostileFixtures)) {
    const source = looksPythonHostileFixtures[relativePath];
    const read = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: relativePath }
    }), `looks-Python hostile ${relativePath} full read`);
    assertReadMetadata(read, source, 1, undefined, `looks-Python hostile ${relativePath} full read`);
    assert.equal(read.structuredContent.text, numbered(looksPythonHostileRedacted), `looks-Python hostile ${relativePath} full read changed redacted projection`);
    expectNoHostileResponseFields(read, ['ACTUAL_LITERAL_SECRET_7X9'], `looks-Python hostile ${relativePath} full read`);
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: relativePath, start_line: 2, end_line: 2 }
    }), `looks-Python hostile ${relativePath} ranged read`);
    assert.equal(ranged.structuredContent.text, projectedRange(looksPythonHostileRedacted, 2, 2).text, `looks-Python hostile ${relativePath} ranged read changed projection`);
    expectNoHostileResponseFields(ranged, ['ACTUAL_LITERAL_SECRET_7X9'], `looks-Python hostile ${relativePath} ranged read`);
    if (relativePath === 'looks-python.txt') await writeRawArtifact(rawArtifactDir, 'looks-python-hostile-read', read);
  }

  const looksPythonSearchCases = [
    ['looks-python.py', 'Token[', 'Token', false],
    ...Object.keys(looksPythonHostileFixtures).map((relativePath) => [relativePath, 'ACTUAL_LITERAL_SECRET_7X9', 'ACTUAL_LITERAL_SECRET_7X9', true])
  ];
  for (const [relativePath, query, regexQuery, hostile] of looksPythonSearchCases) {
    const source = hostile ? looksPythonHostileFixtures[relativePath] : looksPythonLawful;
    const expectedLineNumbers = source.split('\n').map((line, index) => line.includes(hostile ? 'ACTUAL_LITERAL_SECRET_7X9' : 'Token[') ? index + 1 : 0).filter(Boolean);
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['regex', { regex: true }, regexQuery],
      ['structured', { intent: 'text' }, query],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: relativePath, max_results: 50, ...variantArgs }
      }), `looks-Python ${relativePath} ${variantName} search`);
      assert.equal(searched.structuredContent.matches?.length, expectedLineNumbers.length, `looks-Python ${relativePath} ${variantName} search changed match count`);
      for (const [index, lineNumber] of expectedLineNumbers.entries()) {
        const expectedLine = source.split('\n')[lineNumber - 1];
        const match = searched.structuredContent.matches[index];
        assert.equal(match.line, lineNumber, `looks-Python ${relativePath} ${variantName} search changed line ${index}`);
        assert.equal(match.text, hostile ? looksPythonHostileRedacted.split('\n')[lineNumber - 1] : expectedLine, `looks-Python ${relativePath} ${variantName} search changed match text ${index}`);
      }
      if (hostile) {
        expectNoHostileResponseFields(searched, ['ACTUAL_LITERAL_SECRET_7X9'], `looks-Python hostile ${variantName} search`);
        assert.equal(searched.structuredContent.analysis?.query ?? '[REDACTED_SECRET]', '[REDACTED_SECRET]', `looks-Python hostile ${variantName} search did not redact analysis.query`);
        assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), true, `looks-Python hostile ${variantName} search omitted marker`);
      } else {
        assert.equal(JSON.stringify(searched).includes('ACTUAL_LITERAL_SECRET_7X9'), true, `looks-Python lawful ${variantName} search unexpectedly redacted source`);
        if (variantArgs.intent === 'text') assert.equal(searched.structuredContent.analysis?.query, searchQuery, `looks-Python lawful ${variantName} search changed analysis.query`);
      }
    }
  }

  const looksPythonWritePath = 'looks-python-write.py';
  const looksPythonWrite = assertToolSuccess(await client.request('tools/call', {
    name: 'write',
    arguments: { workspace_id: workspaceId, path: looksPythonWritePath, content: looksPythonLawful }
  }), 'looks-Python lawful write');
  assert.equal(await fs.readFile(path.join(tmp, looksPythonWritePath), 'utf8'), looksPythonLawful, 'looks-Python lawful write changed source bytes');
  assert.ok(looksPythonWrite.structuredContent, 'looks-Python lawful write omitted structured output');
  assert.equal(looksPythonWrite.structuredContent.diff.includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'looks-Python lawful write diff was re-redacted after path-aware policy');
  assert.equal(resultText(looksPythonWrite).includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'looks-Python lawful write content diff was re-redacted after path-aware policy');
  const looksPythonEdited = looksPythonLawful.replaceAll('token: Token[ACTUAL_LITERAL_SECRET_7X9]', 'token: Token[ACTUAL_LITERAL_SECRET_8Y9]');
  const looksPythonEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: looksPythonWritePath,
      old_text: 'token: Token[ACTUAL_LITERAL_SECRET_7X9]',
      new_text: 'token: Token[ACTUAL_LITERAL_SECRET_8Y9]',
      replace_all: true,
      expected_replacements: 4
    }
  }), 'looks-Python lawful edit');
  assert.equal(await fs.readFile(path.join(tmp, looksPythonWritePath), 'utf8'), looksPythonEdited, 'looks-Python lawful edit changed source bytes');
  assert.ok(looksPythonEdit.structuredContent, 'looks-Python lawful edit omitted structured output');
  assert.equal(looksPythonEdit.structuredContent.diff.includes('ACTUAL_LITERAL_SECRET_8Y9'), true, 'looks-Python lawful edit diff was re-redacted after path-aware policy');

  for (const [relativePath, source] of Object.entries(looksPythonHostileFixtures)) {
    const before = await fs.readFile(path.join(tmp, relativePath), 'utf8');
    const blockedWrite = assertToolError(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: relativePath, content: source }
    }), `looks-Python hostile ${relativePath} write`);
    assert.match(resultText(blockedWrite), /Secret-looking content is blocked/);
    assert.equal(await fs.readFile(path.join(tmp, relativePath), 'utf8'), before, `looks-Python hostile ${relativePath} write mutated the file`);
    const blockedEdit = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: relativePath,
        old_text: 'token: Token[ACTUAL_LITERAL_SECRET_7X9]',
        new_text: 'token: Token[QZ7]',
        expected_replacements: 1
      }
    }), `looks-Python hostile ${relativePath} edit`);
    assert.match(resultText(blockedEdit), /Secret-looking content is blocked/);
    assert.equal(await fs.readFile(path.join(tmp, relativePath), 'utf8'), before, `looks-Python hostile ${relativePath} edit mutated the file`);
  }

  const lawfulPatchPath = 'looks-python-patch.py';
  const mixedPatchTextPath = 'looks-python-patch.txt';
  await writeFixture(tmp, lawfulPatchPath, 'class Patch:\n');
  await writeFixture(tmp, mixedPatchTextPath, 'class Patch:\n');
  const lawfulPythonPatch = [
    `diff --git a/${lawfulPatchPath} b/${lawfulPatchPath}`,
    `--- a/${lawfulPatchPath}`,
    `+++ b/${lawfulPatchPath}`,
    '@@ -1,1 +1,2 @@',
    ' class Patch:',
    '+    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
    ''
  ].join('\n');
  const lawfulPatchResult = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: lawfulPythonPatch }
  }), 'looks-Python lawful apply_patch');
  assert.equal(await fs.readFile(path.join(tmp, lawfulPatchPath), 'utf8'), 'class Patch:\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n', 'looks-Python lawful apply_patch changed source bytes');
  assert.equal(lawfulPatchResult.structuredContent.diff.includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'looks-Python lawful apply_patch diff was re-redacted after path-aware policy');
  assert.equal(resultText(lawfulPatchResult).includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'looks-Python lawful apply_patch content diff was re-redacted after path-aware policy');
  await writeRawArtifact(rawArtifactDir, 'looks-python-lawful-apply-patch', lawfulPatchResult);
  const mixedPatch = [
    lawfulPythonPatch.trimEnd(),
    `diff --git a/${mixedPatchTextPath} b/${mixedPatchTextPath}`,
    `--- a/${mixedPatchTextPath}`,
    `+++ b/${mixedPatchTextPath}`,
    '@@ -1,1 +1,2 @@',
    ' class Patch:',
    '+    token: Token[ACTUAL_LITERAL_SECRET_7X9]',
    ''
  ].join('\n');
  const mixedBeforePython = await fs.readFile(path.join(tmp, lawfulPatchPath), 'utf8');
  const mixedBeforeText = await fs.readFile(path.join(tmp, mixedPatchTextPath), 'utf8');
  const mixedBlocked = assertToolError(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: mixedPatch }
  }), 'looks-Python mixed-language apply_patch');
  assert.match(resultText(mixedBlocked), /Secret-looking content is blocked/);
  assert.equal(resultText(mixedBlocked).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'looks-Python mixed-language rejection leaked its hostile hunk');
  assert.equal(await fs.readFile(path.join(tmp, lawfulPatchPath), 'utf8'), mixedBeforePython, 'looks-Python mixed-language rejection partially mutated Python file');
  assert.equal(await fs.readFile(path.join(tmp, mixedPatchTextPath), 'utf8'), mixedBeforeText, 'looks-Python mixed-language rejection mutated non-Python file');
  await writeRawArtifact(rawArtifactDir, 'looks-python-mixed-apply-patch-rejected', mixedBlocked);

  const sourceRead = assertToolSuccess(await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: 'source.ts' } }), 'source read');
  assert.equal(sourceRead.structuredContent.path, 'source.ts', 'source read hid its path');
  assert.equal(sourceRead.structuredContent.text, numbered(sourceTs), 'MCP read changed lawful source bytes or line framing');
  assert.equal(sourceRead.structuredContent.text.includes('[REDACTED_SECRET]'), false, 'MCP read redacted lawful source');
  assert.equal(sourceRead.content?.[0]?.text.includes(numbered(sourceTs)), true, 'MCP read content envelope changed lawful source bytes');
  assert.equal(sourceRead.content?.[0]?.text.includes('[REDACTED_SECRET]'), false, 'MCP read content envelope redacted lawful source');

  const sourcePyRead = assertToolSuccess(await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: 'source.py' } }), 'Python source read');
  assert.equal(sourcePyRead.structuredContent.text, numbered(sourcePyRedacted), 'MCP read changed Python source bytes or line framing');
  assert.equal(sourcePyRead.structuredContent.text.includes('[REDACTED_SECRET]'), true, 'MCP read omitted hostile Python redaction');
  assert.equal(sourcePyRead.content?.[0]?.text.includes(numbered(sourcePyRedacted)), true, 'MCP Python read content envelope changed source bytes');
  assert.equal(sourcePyRead.content?.[0]?.text.includes('[REDACTED_SECRET]'), true, 'MCP Python read content envelope omitted hostile redaction');

  // The filename is deliberately identical to a later ranged source body.
  // Metadata must take the ordinary policy path while the typed source slot
  // is protected structurally, otherwise a value-based search can bless the
  // path and redact the actual body (or bless the wrong repeated occurrence).
  const collisionFull = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: collisionPath }
  }), 'structural collision full read');
  assertReadMetadata(collisionFull, collisionSource, 1, undefined, 'structural collision full read');
  assert.equal(collisionFull.structuredContent.path, collisionMetadataPath, 'structural collision metadata path was not ordinarily redacted');
  assert.equal(collisionFull.structuredContent.text, numbered(collisionSource), 'structural collision full source body changed');
  assert.equal(collisionFull.content?.[0]?.text.includes(`Path: ${collisionPath}`), false, 'structural collision content header preserved the raw path');
  assert.equal(collisionFull.content?.[0]?.text.includes(`Path: ${collisionMetadataPath}`), true, 'structural collision content header omitted the redacted path');
  assert.equal(JSON.stringify(collisionFull.structuredContent).includes(`"path":"${collisionPath}"`), false, 'structural collision structured path leaked in complete JSON');
  assert.equal(JSON.stringify(collisionFull).includes(`"path":"${collisionPath}"`), false, 'structural collision raw path leaked in complete JSON');
  expectNoRawLiterals(collisionFull, ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'], 'structural collision full read');
  await writeRawArtifact(rawArtifactDir, 'collision-full', collisionFull);

  const collisionRange = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: collisionPath, start_line: 2, end_line: 2 }
  }), 'structural collision ranged read');
  assertReadMetadata(collisionRange, collisionSource, 2, 2, 'structural collision ranged read');
  assert.equal(collisionRange.structuredContent.path, collisionMetadataPath, 'structural collision ranged metadata path was not redacted');
  assert.equal(collisionRange.structuredContent.text, '2 |   token: Token<string>;', 'structural collision ranged source body was redacted or changed');
  assert.equal(collisionRange.content?.[0]?.text.includes(`Path: ${collisionPath}`), false, 'structural collision ranged content header preserved the raw path');
  assert.equal(collisionRange.content?.[0]?.text.includes(`Path: ${collisionMetadataPath}`), true, 'structural collision ranged content header omitted the redacted path');
  expectNoRawLiterals(collisionRange, ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'], 'structural collision ranged read');
  await writeRawArtifact(rawArtifactDir, 'collision-range', collisionRange);

  const collisionBatchItems = Array.from({ length: 3 }, () => ({ path: collisionPath, start_line: 2, end_line: 2 }));
  const collisionBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: collisionBatchItems }
  }), 'structural collision repeated read_many');
  const collisionResults = collisionBatch.structuredContent.results ?? [];
  assert.equal(collisionResults.length, collisionBatchItems.length, 'structural collision repeated read_many changed item count');
  assert.deepEqual(
    collisionResults.map((item) => ({ index: item.index, path: item.path, ok: item.ok, text: item.result?.text })),
    collisionBatchItems.map((item, index) => ({ index, path: collisionMetadataPath, ok: true, text: '2 |   token: Token<string>;' })),
    'structural collision repeated read_many changed item order, metadata, or source slots'
  );
  const collisionBatchText = resultText(collisionBatch);
  assert.equal(collisionBatchText.includes(`Item 0: ${collisionPath}`), false, 'structural collision repeated read_many leaked item 0 path');
  assert.equal(collisionBatchText.includes(`Item 1: ${collisionPath}`), false, 'structural collision repeated read_many leaked item 1 path');
  assert.equal(collisionBatchText.includes(`Item 2: ${collisionPath}`), false, 'structural collision repeated read_many leaked item 2 path');
  for (let index = 0; index < collisionBatchItems.length; index += 1) {
    assert.equal(collisionBatchText.includes(`Item ${index}: ${collisionMetadataPath}`), true, `structural collision repeated read_many omitted redacted item ${index} path`);
  }
  assert.equal(collisionBatchText.split('2 |   token: Token<string>;').length - 1, 3, 'structural collision repeated read_many lost or duplicated a designated source body');
  assert.equal(JSON.stringify(collisionBatch).includes(`"path":"${collisionPath}"`), false, 'structural collision repeated read_many leaked a raw metadata path');
  expectNoRawLiterals(collisionBatch, ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'], 'structural collision repeated read_many');
  await writeRawArtifact(rawArtifactDir, 'collision-read-many', collisionBatch);

  const identicalBodyBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      items: [
        { path: 'identical-source-a.ts', start_line: 2, end_line: 2 },
        { path: 'identical-source-b.ts', start_line: 2, end_line: 2 }
      ]
    }
  }), 'identical ranged source-body read_many');
  const identicalResults = identicalBodyBatch.structuredContent.results ?? [];
  assert.deepEqual(
    identicalResults.map((item) => ({ index: item.index, path: item.path, ok: item.ok, text: item.result?.text })),
    [
      { index: 0, path: 'identical-source-a.ts', ok: true, text: '2 |   token: Token<string>;' },
      { index: 1, path: 'identical-source-b.ts', ok: true, text: '2 |   token: Token<string>;' }
    ],
    'identical ranged source-body read_many changed designated source slots'
  );
  assert.equal(resultText(identicalBodyBatch).split('2 |   token: Token<string>;').length - 1, 2, 'identical ranged source-body read_many did not preserve both equal source bodies');
  assert.equal(resultText(identicalBodyBatch).includes('Item 0: identical-source-a.ts'), true, 'identical ranged source-body read_many omitted first ordinary metadata path');
  assert.equal(resultText(identicalBodyBatch).includes('Item 1: identical-source-b.ts'), true, 'identical ranged source-body read_many omitted second ordinary metadata path');
  await writeRawArtifact(rawArtifactDir, 'identical-read-many', identicalBodyBatch);

  const lawfulRangeFixtures = [
    {
      path: 'ranged-lawful.ts',
      source: rangedLawfulTs,
      ranges: [
        [2, 2, 'TypeScript type member'],
        [6, 7, 'TypeScript interface body'],
        [10, 11, 'TypeScript destructuring body'],
        [14, 15, 'TypeScript function parameters'],
        [20, 21, 'TypeScript arrow parameters']
      ]
    },
    {
      path: 'ranged-lawful.py',
      source: rangedLawfulPy,
      ranges: [
        [2, 3, 'Python class body'],
        [6, 7, 'Python function parameters']
      ]
    }
  ];
  for (const { path: relativePath, source, ranges } of lawfulRangeFixtures) {
    const full = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: relativePath }
    }), `lawful full read ${relativePath}`);
    const fullExpected = assertReadMetadata(full, source, 1, undefined, `lawful full read ${relativePath}`);
    assert.equal(full.structuredContent.text, fullExpected.text, `lawful full read ${relativePath} changed raw source projection`);
    assert.equal(full.structuredContent.text.includes('[REDACTED_SECRET]'), false, `lawful full read ${relativePath} redacted source syntax`);
    assert.equal(full.content?.[0]?.text.includes(fullExpected.text), true, `lawful full read ${relativePath} content envelope changed source projection`);
    expectNoRawCredential(full, `lawful full read ${relativePath}`);

    for (const [startLine, endLine, rangeLabel] of ranges) {
      const ranged = assertToolSuccess(await client.request('tools/call', {
        name: 'read',
        arguments: { workspace_id: workspaceId, path: relativePath, start_line: startLine, end_line: endLine }
      }), `${rangeLabel} read`);
      const expected = assertReadMetadata(ranged, source, startLine, endLine, `${rangeLabel} read`);
      assert.equal(ranged.structuredContent.text, expected.text, `${rangeLabel} read redacted or changed lawful interior lines`);
      assert.equal(
        ranged.structuredContent.text,
        projectedRange(stripLineNumbers(full.structuredContent.text), startLine, endLine).text,
        `${rangeLabel} read diverged from the independently observed full MCP projection`
      );
      assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `${rangeLabel} read redacted lawful source syntax`);
      assert.equal(ranged.content?.[0]?.text.includes(expected.text), true, `${rangeLabel} read content envelope changed lawful source projection`);
      expectNoRawCredential(ranged, `${rangeLabel} read`);
    }
  }

  const pythonLawfulRanges = [
    [2, 4, 'Python consecutive direct class annotations'],
    [6, 6, 'Python blank-line-separated direct class annotation'],
    [9, 9, 'Python nested class direct annotation'],
    [11, 11, 'Python direct function parameter and return annotation']
  ];
  const pythonLawfulRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'python-provenance-lawful.py' }
  }), 'Python provenance lawful full read');
  const pythonLawfulExpected = assertReadMetadata(pythonLawfulRead, pythonProvenanceLawful, 1, undefined, 'Python provenance lawful full read');
  assert.equal(pythonLawfulRead.structuredContent.text, pythonLawfulExpected.text, 'Python provenance lawful full read changed exact source output');
  assert.equal(pythonLawfulRead.structuredContent.text.includes('[REDACTED_SECRET]'), false, 'Python provenance lawful full read redacted direct class/function syntax');
  assert.equal(pythonLawfulRead.content?.[0]?.text.includes(pythonLawfulExpected.text), true, 'Python provenance lawful content envelope changed exact source output');
  expectNoRawCredential(pythonLawfulRead, 'Python provenance lawful full read');
  for (const [startLine, endLine, label] of pythonLawfulRanges) {
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: 'python-provenance-lawful.py', start_line: startLine, end_line: endLine }
    }), `${label} read`);
    const expected = assertReadMetadata(ranged, pythonProvenanceLawful, startLine, endLine, `${label} read`);
    assert.equal(ranged.structuredContent.text, expected.text, `${label} read changed exact source output`);
    assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `${label} read redacted lawful source syntax`);
    assert.equal(ranged.content?.[0]?.text.includes(expected.text), true, `${label} content envelope changed exact source output`);
    expectNoRawCredential(ranged, `${label} read`);
  }

  const pythonLawfulBatchItems = pythonLawfulRanges.map(([start_line, end_line]) => ({
    path: 'python-provenance-lawful.py',
    start_line,
    end_line
  }));
  const pythonLawfulBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: pythonLawfulBatchItems }
  }), 'Python provenance lawful read_many');
  const pythonLawfulResults = pythonLawfulBatch.structuredContent.results ?? [];
  assert.equal(pythonLawfulResults.length, pythonLawfulBatchItems.length, 'Python provenance lawful read_many changed item count');
  for (const [index, item] of pythonLawfulBatchItems.entries()) {
    const expected = projectedRange(pythonProvenanceLawful, item.start_line, item.end_line);
    const actual = pythonLawfulResults[index];
    assert.deepEqual(
      { index: actual.index, path: actual.path, ok: actual.ok, text: actual.result?.text },
      { index, path: item.path, ok: true, text: expected.text },
      `Python provenance lawful read_many changed item ${index}`
    );
    assert.equal(actual.result.startLine, expected.start, `Python provenance lawful read_many changed item ${index} start line`);
    assert.equal(actual.result.endLine, expected.end, `Python provenance lawful read_many changed item ${index} end line`);
    expectNoRawCredential(actual, `Python provenance lawful read_many item ${index}`);
  }
  expectNoRawLiterals(pythonLawfulBatch, ['[REDACTED_SECRET]'], 'Python provenance lawful read_many');

  const pythonHostileLiterals = [
    'QZ7',
    'ACTUAL_LITERAL_SECRET_7X9',
    'client.actualSecret',
    'client.getSecret()',
    'Token[ACTUAL_LITERAL_SECRET_7X9',
    'Token[client.actualSecret',
    'Password[client.getSecret()'
  ];
  const pythonHostileRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'python-provenance-hostile.py' }
  }), 'Python provenance hostile full read');
  assertReadMetadata(pythonHostileRead, pythonProvenanceHostile, 1, undefined, 'Python provenance hostile full read');
  assert.equal(pythonHostileRead.structuredContent.text, numbered(pythonProvenanceHostileRedacted), 'Python provenance hostile full read changed independently-derived sanitized projection');
  expectRedactedText(pythonHostileRead.structuredContent.text, 'Python provenance hostile full read');
  expectNoRawLiterals(pythonHostileRead, pythonHostileLiterals, 'Python provenance hostile full read');
  expectNoRawLiterals(pythonHostileRead.content?.[0]?.text ?? '', pythonHostileLiterals, 'Python provenance hostile content envelope');
  expectNoRawLiterals(pythonHostileRead._meta, pythonHostileLiterals, 'Python provenance hostile _meta');
  await writeRawArtifact(rawArtifactDir, 'python-provenance-hostile-full', pythonHostileRead);

  const pythonHostileRanges = [[5, 7], [10, 10], [14, 14], [16, 16], [18, 18]];
  for (const [startLine, endLine] of pythonHostileRanges) {
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: 'python-provenance-hostile.py', start_line: startLine, end_line: endLine }
    }), `Python provenance hostile range ${startLine}-${endLine}`);
    assertReadMetadata(ranged, pythonProvenanceHostile, startLine, endLine, `Python provenance hostile range ${startLine}-${endLine}`);
    assert.equal(
      ranged.structuredContent.text,
      projectedRange(pythonProvenanceHostileRedacted, startLine, endLine).text,
      `Python provenance hostile range ${startLine}-${endLine} changed independently-derived sanitized projection`
    );
    expectRedactedText(ranged.structuredContent.text, `Python provenance hostile range ${startLine}-${endLine}`);
    expectNoRawLiterals(ranged, pythonHostileLiterals, `Python provenance hostile range ${startLine}-${endLine}`);
    expectNoRawLiterals(ranged.content?.[0]?.text ?? '', pythonHostileLiterals, `Python provenance hostile range ${startLine}-${endLine} content envelope`);
    expectNoRawLiterals(ranged._meta, pythonHostileLiterals, `Python provenance hostile range ${startLine}-${endLine} _meta`);
  }

  const pythonHostileBatchItems = pythonHostileRanges.map(([start_line, end_line]) => ({
    path: 'python-provenance-hostile.py',
    start_line,
    end_line
  }));
  const pythonHostileBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: pythonHostileBatchItems }
  }), 'Python provenance hostile read_many');
  const pythonHostileResults = pythonHostileBatch.structuredContent.results ?? [];
  assert.equal(pythonHostileResults.length, pythonHostileBatchItems.length, 'Python provenance hostile read_many changed item count');
  for (const [index, item] of pythonHostileBatchItems.entries()) {
    const actual = pythonHostileResults[index];
    assert.equal(actual.index, index, `Python provenance hostile read_many changed item ${index} order`);
    assert.equal(actual.path, item.path, `Python provenance hostile read_many changed item ${index} path`);
    assert.equal(actual.ok, true, `Python provenance hostile read_many rejected item ${index}`);
    assert.equal(actual.result.text, projectedRange(pythonProvenanceHostileRedacted, item.start_line, item.end_line).text, `Python provenance hostile read_many changed item ${index} source projection`);
    expectNoRawCredential(actual, `Python provenance hostile read_many item ${index}`);
  }
  expectNoRawLiterals(pythonHostileBatch, pythonHostileLiterals, 'Python provenance hostile read_many complete response');
  expectNoRawLiterals(pythonHostileBatch._meta, pythonHostileLiterals, 'Python provenance hostile read_many _meta');

  const pythonLawfulSearchCases = [
    {
      query: 'Token[str]',
      regexQuery: 'Token\\[str\\]',
      expectedLines: pythonProvenanceLawful.split('\n').filter((line) => line.includes('Token[str]'))
    },
    {
      query: 'direct_function',
      regexQuery: 'direct_function',
      expectedLines: [pythonProvenanceLawful.split('\n')[10]]
    }
  ];
  for (const { query, regexQuery, expectedLines } of pythonLawfulSearchCases) {
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['structured', { intent: 'text' }, query],
      ['regex', { regex: true }, regexQuery],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: 'python-provenance-lawful.py', max_results: 20, ...variantArgs }
      }), `Python provenance lawful ${variantName} search ${query}`);
      assert.equal(searched.structuredContent.matches?.length, expectedLines.length, `Python provenance lawful ${variantName} search ${query} changed match count`);
      for (const [index, expectedLine] of expectedLines.entries()) {
        const match = searched.structuredContent.matches[index];
        assert.equal(match.path, 'python-provenance-lawful.py', `Python provenance lawful ${variantName} search ${query} changed match path`);
        assert.equal(match.text, expectedLine, `Python provenance lawful ${variantName} search ${query} changed exact match text ${index}`);
      }
      assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `Python provenance lawful ${variantName} search ${query} redacted lawful source`);
      expectNoRawCredential(searched, `Python provenance lawful ${variantName} search ${query}`);
    }
  }

  const pythonHostileSearchCases = [
    {
      query: 'ACTUAL_LITERAL_SECRET_7X9',
      regexQuery: 'ACTUAL_LITERAL_SECRET_7X9',
      expectedLines: [5, 10, 14, 16, 18]
    },
    {
      query: 'client.actualSecret',
      regexQuery: 'client\\.actualSecret',
      expectedLines: [6]
    },
    {
      query: 'client.getSecret()',
      regexQuery: 'client\\.getSecret\\(\\)',
      expectedLines: [7]
    }
  ];
  for (const { query, regexQuery, expectedLines } of pythonHostileSearchCases) {
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['structured', { intent: 'text' }, query],
      ['regex', { regex: true }, regexQuery],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: 'python-provenance-hostile.py', max_results: 20, ...variantArgs }
      }), `Python provenance hostile ${variantName} search ${query}`);
      assert.deepEqual(searched.structuredContent.matches?.map((match) => match.line), expectedLines, `Python provenance hostile ${variantName} search ${query} changed physical match lines`);
      for (const match of searched.structuredContent.matches ?? []) {
        assert.equal(match.path, 'python-provenance-hostile.py', `Python provenance hostile ${variantName} search ${query} changed match path`);
        expectRedactedText(match.text, `Python provenance hostile ${variantName} search ${query} match`);
      }
      const analysis = searched.structuredContent.analysis;
      if (analysis && Object.prototype.hasOwnProperty.call(analysis, 'query')) {
        assert.equal(analysis.query, '[REDACTED_SECRET]', `Python provenance hostile ${variantName} search ${query} preserved hostile analysis.query`);
      }
      assert.equal(JSON.stringify(searched).includes(searchQuery), false, `Python provenance hostile ${variantName} search ${query} echoed its hostile query`);
      expectNoRawLiterals(searched, pythonHostileLiterals, `Python provenance hostile ${variantName} search ${query}`);
      assert.equal(structuredStringFields(searched.structuredContent).some((text) => text.includes(searchQuery)), false, `Python provenance hostile ${variantName} search ${query} leaked through nested structured fields`);
      assert.equal(structuredStringFields(searched.structuredContent).some((text) => text.includes('[REDACTED_SECRET]')), true, `Python provenance hostile ${variantName} search ${query} omitted redaction marker`);
      expectRedactedText(resultText(searched), `Python provenance hostile ${variantName} search ${query} envelope`);
      if (query === 'ACTUAL_LITERAL_SECRET_7X9' && variantName === 'structured-regex') {
        await writeRawArtifact(rawArtifactDir, 'python-provenance-hostile-structured-regex-search', searched);
      }
    }
  }

  const python312LawfulRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'python-312-lawful.py' }
  }), 'Python 3.12 lawful alias/annotation full read');
  assertReadMetadata(python312LawfulRead, python312Lawful, 1, undefined, 'Python 3.12 lawful alias/annotation full read');
  assert.equal(python312LawfulRead.structuredContent.text, numbered(python312Lawful), 'Python 3.12 lawful full read changed exact source output');
  assert.equal(python312LawfulRead.structuredContent.text.includes('[REDACTED_SECRET]'), false, 'Python 3.12 lawful full read redacted syntax');
  expectNoHostileResponseFields(python312LawfulRead, ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'], 'Python 3.12 lawful full read');

  const python312LawfulRanges = [[1, 5], [6, 17], [19, 20]];
  for (const [startLine, endLine] of python312LawfulRanges) {
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: 'python-312-lawful.py', start_line: startLine, end_line: endLine }
    }), `Python 3.12 lawful range ${startLine}-${endLine}`);
    assertReadMetadata(ranged, python312Lawful, startLine, endLine, `Python 3.12 lawful range ${startLine}-${endLine}`);
    assert.equal(ranged.structuredContent.text, projectedRange(python312Lawful, startLine, endLine).text, `Python 3.12 lawful range ${startLine}-${endLine} changed exact source output`);
    assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `Python 3.12 lawful range ${startLine}-${endLine} redacted syntax`);
  }

  const python312LawfulBatchItems = python312LawfulRanges.map(([start_line, end_line]) => ({
    path: 'python-312-lawful.py',
    start_line,
    end_line
  }));
  const python312LawfulBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: python312LawfulBatchItems }
  }), 'Python 3.12 lawful alias/annotation read_many');
  for (const [index, item] of python312LawfulBatchItems.entries()) {
    const actual = python312LawfulBatch.structuredContent.results?.[index];
    assert.deepEqual(
      { index: actual.index, path: actual.path, ok: actual.ok, text: actual.result?.text },
      { index, path: item.path, ok: true, text: projectedRange(python312Lawful, item.start_line, item.end_line).text },
      `Python 3.12 lawful read_many item ${index} changed source projection`
    );
    expectNoHostileResponseFields(actual, ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'], `Python 3.12 lawful read_many item ${index}`);
  }

  const python312LawfulSearchCases = [
    { query: 'PasswordType', regexQuery: 'PasswordType', expectedLines: python312Lawful.split('\n').map((line, index) => line.includes('PasswordType') ? index + 1 : 0).filter(Boolean) },
    { query: 'Token[', regexQuery: 'Token\\[', expectedLines: python312Lawful.split('\n').map((line, index) => line.includes('Token[') ? index + 1 : 0).filter(Boolean) }
  ];
  for (const { query, regexQuery, expectedLines } of python312LawfulSearchCases) {
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['structured', { intent: 'text' }, query],
      ['regex', { regex: true }, regexQuery],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: 'python-312-lawful.py', max_results: 20, ...variantArgs }
      }), `Python 3.12 lawful ${variantName} search ${query}`);
      assert.deepEqual(searched.structuredContent.matches?.map((match) => match.line), expectedLines, `Python 3.12 lawful ${variantName} search ${query} changed lines`);
      for (const [index, expectedLine] of expectedLines.entries()) assert.equal(searched.structuredContent.matches[index].text, python312Lawful.split('\n')[expectedLine - 1], `Python 3.12 lawful ${variantName} search ${query} changed match ${index}`);
      assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `Python 3.12 lawful ${variantName} search ${query} redacted syntax`);
      expectNoHostileResponseFields(searched, ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'], `Python 3.12 lawful ${variantName} search ${query}`);
    }
  }

  const python312HostileLiterals = ['ACTUAL_LITERAL_SECRET_7X9', 'client.actualSecret', 'client.getSecret()'];
  const python312HostileRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'python-312-hostile.py' }
  }), 'Python 3.12 hostile ownership full read');
  assertReadMetadata(python312HostileRead, python312Hostile, 1, undefined, 'Python 3.12 hostile ownership full read');
  assert.equal(python312HostileRead.structuredContent.text, numbered(python312HostileRedacted), 'Python 3.12 hostile full read changed sanitized projection');
  expectRedactedText(python312HostileRead.structuredContent.text, 'Python 3.12 hostile ownership full read');
  expectNoHostileResponseFields(python312HostileRead, python312HostileLiterals, 'Python 3.12 hostile ownership full read');

  const python312HostileRanges = [[2, 5], [6, 19], [22, 26]];
  for (const [startLine, endLine] of python312HostileRanges) {
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: 'python-312-hostile.py', start_line: startLine, end_line: endLine }
    }), `Python 3.12 hostile range ${startLine}-${endLine}`);
    assertReadMetadata(ranged, python312Hostile, startLine, endLine, `Python 3.12 hostile range ${startLine}-${endLine}`);
    assert.equal(ranged.structuredContent.text, projectedRange(python312HostileRedacted, startLine, endLine).text, `Python 3.12 hostile range ${startLine}-${endLine} changed sanitized projection`);
    expectRedactedText(ranged.structuredContent.text, `Python 3.12 hostile range ${startLine}-${endLine}`);
    expectNoHostileResponseFields(ranged, python312HostileLiterals, `Python 3.12 hostile range ${startLine}-${endLine}`);
  }

  const python312HostileBatchItems = python312HostileRanges.map(([start_line, end_line]) => ({
    path: 'python-312-hostile.py',
    start_line,
    end_line
  }));
  const python312HostileBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: python312HostileBatchItems }
  }), 'Python 3.12 hostile ownership read_many');
  for (const [index, item] of python312HostileBatchItems.entries()) {
    const actual = python312HostileBatch.structuredContent.results?.[index];
    assert.equal(actual.result?.text, projectedRange(python312HostileRedacted, item.start_line, item.end_line).text, `Python 3.12 hostile read_many item ${index} changed sanitized projection`);
    expectRedactedText(actual.result?.text ?? '', `Python 3.12 hostile read_many item ${index}`);
    expectNoHostileResponseFields(actual, python312HostileLiterals, `Python 3.12 hostile read_many item ${index}`);
  }

  for (const [query, regexQuery] of [
    ['ACTUAL_LITERAL_SECRET_7X9', 'ACTUAL_LITERAL_SECRET_7X9'],
    ['client.actualSecret', 'client\\.actualSecret'],
    ['client.getSecret()', 'client\\.getSecret\\(\\)']
  ]) {
    const expectedLines = python312Hostile.split('\n').map((line, index) => line.includes(query) ? index + 1 : 0).filter(Boolean);
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['structured', { intent: 'text' }, query],
      ['regex', { regex: true }, regexQuery],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: 'python-312-hostile.py', max_results: 20, ...variantArgs }
      }), `Python 3.12 hostile ${variantName} search ${query}`);
      assert.deepEqual(searched.structuredContent.matches?.map((match) => match.line), expectedLines, `Python 3.12 hostile ${variantName} search ${query} changed lines`);
      for (const match of searched.structuredContent.matches ?? []) expectRedactedText(match.text, `Python 3.12 hostile ${variantName} search ${query} match`);
      if (searched.structuredContent.analysis && Object.prototype.hasOwnProperty.call(searched.structuredContent.analysis, 'query')) assert.equal(searched.structuredContent.analysis.query, '[REDACTED_SECRET]', `Python 3.12 hostile ${variantName} search ${query} did not redact analysis.query`);
      expectNoHostileResponseFields(searched, python312HostileLiterals, `Python 3.12 hostile ${variantName} search ${query}`);
    }
  }

  const pythonMixedHostileLiterals = [
    'ACTUAL_LITERAL_SECRET_7X9',
    'client.actualSecret',
    'client.getSecret()',
    'Token[ACTUAL_LITERAL_SECRET_7X9',
    'Token[client.actualSecret',
    'Password[client.getSecret()'
  ];
  const pythonMixedRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'python-mixed-provenance.py' }
  }), 'Python mixed-indentation provenance full read');
  assertReadMetadata(pythonMixedRead, pythonMixedProvenance, 1, undefined, 'Python mixed-indentation provenance full read');
  assert.equal(
    pythonMixedRead.structuredContent.text,
    numbered(pythonMixedProvenanceRedacted),
    'Python mixed-indentation provenance full read changed independently-derived sanitized projection'
  );
  assert.equal(pythonMixedRead.structuredContent.text.includes('\t    token: Token[str]'), true, 'Python mixed-indentation lawful class annotation was redacted');
  expectRedactedText(pythonMixedRead.structuredContent.text, 'Python mixed-indentation provenance full read');
  expectNoHostileResponseFields(pythonMixedRead, pythonMixedHostileLiterals, 'Python mixed-indentation provenance full read');
  await writeRawArtifact(rawArtifactDir, 'python-mixed-provenance-full', pythonMixedRead);

  const pythonMixedRanges = [
    [2, 2, 'lawful mixed direct class annotation'],
    [5, 7, 'class dictionary literal'],
    [8, 10, 'class dictionary member value'],
    [11, 13, 'class dictionary call value'],
    [15, 17, 'method-nested value'],
    [19, 20, 'conditional-block-nested value'],
    [22, 24, 'nested dictionary value'],
    [26, 26, 'top-level material after class']
  ];
  for (const [startLine, endLine, label] of pythonMixedRanges) {
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: 'python-mixed-provenance.py', start_line: startLine, end_line: endLine }
    }), `Python mixed-indentation ${label} ranged read`);
    assertReadMetadata(ranged, pythonMixedProvenance, startLine, endLine, `Python mixed-indentation ${label} ranged read`);
    assert.equal(
      ranged.structuredContent.text,
      projectedRange(pythonMixedProvenanceRedacted, startLine, endLine).text,
      `Python mixed-indentation ${label} ranged read changed independently-derived sanitized projection`
    );
    if (label.startsWith('lawful')) {
      assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `Python mixed-indentation ${label} ranged read redacted lawful source`);
    } else {
      expectRedactedText(ranged.structuredContent.text, `Python mixed-indentation ${label} ranged read`);
    }
    expectNoHostileResponseFields(ranged, pythonMixedHostileLiterals, `Python mixed-indentation ${label} ranged read`);
  }

  const pythonMixedBatchItems = pythonMixedRanges.map(([start_line, end_line]) => ({
    path: 'python-mixed-provenance.py',
    start_line,
    end_line
  }));
  const pythonMixedBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: pythonMixedBatchItems }
  }), 'Python mixed-indentation provenance read_many');
  const pythonMixedResults = pythonMixedBatch.structuredContent.results ?? [];
  assert.equal(pythonMixedResults.length, pythonMixedBatchItems.length, 'Python mixed-indentation provenance read_many changed item count');
  for (const [index, item] of pythonMixedBatchItems.entries()) {
    const actual = pythonMixedResults[index];
    assert.deepEqual(
      { index: actual.index, path: actual.path, ok: actual.ok, text: actual.result?.text },
      {
        index,
        path: item.path,
        ok: true,
        text: projectedRange(pythonMixedProvenanceRedacted, item.start_line, item.end_line).text
      },
      `Python mixed-indentation provenance read_many changed item ${index}`
    );
    expectNoRawLiterals(actual, pythonMixedHostileLiterals, `Python mixed-indentation provenance read_many item ${index}`);
  }
  expectNoHostileResponseFields(pythonMixedBatch, pythonMixedHostileLiterals, 'Python mixed-indentation provenance read_many');

  const pythonMixedSearchCases = [
    {
      query: 'Token[str]',
      regexQuery: 'Token\\[str\\]',
      expectedLines: [2],
      lawful: true
    },
    {
      query: 'ACTUAL_LITERAL_SECRET_7X9',
      regexQuery: 'ACTUAL_LITERAL_SECRET_7X9',
      expectedLines: [6, 16, 20, 23, 26],
      lawful: false
    },
    {
      query: 'client.actualSecret',
      regexQuery: 'client\\.actualSecret',
      expectedLines: [9],
      lawful: false
    },
    {
      query: 'client.getSecret()',
      regexQuery: 'client\\.getSecret\\(\\)',
      expectedLines: [12],
      lawful: false
    }
  ];
  for (const { query, regexQuery, expectedLines, lawful } of pythonMixedSearchCases) {
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['structured', { intent: 'text' }, query],
      ['regex', { regex: true }, regexQuery],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: 'python-mixed-provenance.py', max_results: 20, ...variantArgs }
      }), `Python mixed-indentation ${variantName} search ${query}`);
      assert.deepEqual(
        searched.structuredContent.matches?.map((match) => match.line),
        expectedLines,
        `Python mixed-indentation ${variantName} search ${query} changed physical match lines`
      );
      for (const [index, expectedLine] of expectedLines.entries()) {
        const match = searched.structuredContent.matches[index];
        assert.equal(match.path, 'python-mixed-provenance.py', `Python mixed-indentation ${variantName} search ${query} changed match path`);
        if (lawful) {
          assert.equal(match.text, pythonMixedProvenance.split('\n')[expectedLine - 1], `Python mixed-indentation ${variantName} search ${query} changed lawful source`);
        } else {
          expectRedactedText(match.text, `Python mixed-indentation ${variantName} search ${query} match`);
        }
      }
      if (lawful) {
        assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `Python mixed-indentation ${variantName} search ${query} redacted lawful source`);
      } else {
        const analysis = searched.structuredContent.analysis;
        if (analysis && Object.prototype.hasOwnProperty.call(analysis, 'query')) {
          assert.equal(analysis.query, '[REDACTED_SECRET]', `Python mixed-indentation ${variantName} search ${query} preserved hostile analysis.query`);
        }
        expectRedactedText(resultText(searched), `Python mixed-indentation ${variantName} search ${query} envelope`);
        expectNoHostileResponseFields(searched, pythonMixedHostileLiterals, `Python mixed-indentation ${variantName} search ${query}`);
      }
      expectNoRawCredential(searched, `Python mixed-indentation ${variantName} search ${query}`);
      if (!lawful && query === 'ACTUAL_LITERAL_SECRET_7X9' && variantName === 'structured-regex') {
        await writeRawArtifact(rawArtifactDir, 'python-mixed-provenance-structured-regex-search', searched);
      }
    }
  }

  const pythonContinuationFull = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'python-continuation-provenance.py' }
  }), 'Python continuation provenance full read');
  const pythonContinuationExpected = assertReadMetadata(
    pythonContinuationFull,
    pythonContinuationProvenance,
    1,
    undefined,
    'Python continuation provenance full read'
  );
  assert.equal(
    pythonContinuationFull.structuredContent.text,
    numbered(pythonContinuationProvenanceRedacted),
    'Python continuation provenance full read changed the independently expected sanitized projection'
  );
  assert.equal(
    pythonContinuationFull.content?.[0]?.text.includes(numbered(pythonContinuationProvenanceRedacted)),
    true,
    'Python continuation provenance full read content envelope changed the sanitized projection'
  );
  expectNoHostileResponseFields(
    pythonContinuationFull,
    pythonContinuationHostileLiterals,
    'Python continuation provenance full read'
  );
  await writeRawArtifact(rawArtifactDir, 'python-continuation-provenance-full', pythonContinuationFull);

  const pythonContinuationRanges = [
    [2, 2, 'lawful direct class annotation'],
    [3, 5, 'same-column brace continuation'],
    [7, 9, 'lawful same-column square continuation'],
    [11, 13, 'lawful same-column parenthesis continuation'],
    [15, 17, 'same-column call continuation'],
    [19, 21, 'delimiter plus explicit backslash continuation'],
    [23, 24, 'lawful explicit backslash continuation'],
    [26, 30, 'mixed tab-space continuation']
  ];
  for (const [startLine, endLine, label] of pythonContinuationRanges) {
    const ranged = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: {
        workspace_id: workspaceId,
        path: 'python-continuation-provenance.py',
        start_line: startLine,
        end_line: endLine
      }
    }), `Python continuation provenance ${label} ranged read`);
    const expected = assertReadMetadata(
      ranged,
      pythonContinuationProvenance,
      startLine,
      endLine,
      `Python continuation provenance ${label} ranged read`
    );
    assert.equal(
      ranged.structuredContent.text,
      projectedRange(pythonContinuationProvenanceRedacted, startLine, endLine).text,
      `Python continuation provenance ${label} ranged read changed the sanitized projection`
    );
    const expectedContent = label.startsWith('lawful')
      ? expected.text
      : projectedRange(pythonContinuationProvenanceRedacted, startLine, endLine).text;
    assert.equal(
      ranged.content?.[0]?.text.includes(expectedContent),
      true,
      `Python continuation provenance ${label} ranged read content envelope changed the sanitized projection`
    );
    if (label.startsWith('lawful')) {
      assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `Python continuation provenance ${label} ranged read redacted lawful syntax`);
    } else {
      expectRedactedText(ranged.structuredContent.text, `Python continuation provenance ${label} ranged read`);
    }
    expectNoHostileResponseFields(
      ranged,
      pythonContinuationHostileLiterals,
      `Python continuation provenance ${label} ranged read`
    );
  }

  const pythonContinuationBatchItems = pythonContinuationRanges.map(([start_line, end_line]) => ({
    path: 'python-continuation-provenance.py',
    start_line,
    end_line
  }));
  const pythonContinuationBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: pythonContinuationBatchItems }
  }), 'Python continuation provenance read_many');
  const pythonContinuationResults = pythonContinuationBatch.structuredContent.results ?? [];
  assert.equal(
    pythonContinuationResults.length,
    pythonContinuationBatchItems.length,
    'Python continuation provenance read_many changed item count'
  );
  for (const [index, item] of pythonContinuationBatchItems.entries()) {
    const actual = pythonContinuationResults[index];
    const expected = projectedRange(pythonContinuationProvenanceRedacted, item.start_line, item.end_line);
    assert.deepEqual(
      { index: actual.index, path: actual.path, ok: actual.ok, text: actual.result?.text },
      { index, path: item.path, ok: true, text: expected.text },
      `Python continuation provenance read_many changed item ${index}`
    );
    assert.equal(actual.result.startLine, expected.start, `Python continuation provenance read_many changed item ${index} start line`);
    assert.equal(actual.result.endLine, expected.end, `Python continuation provenance read_many changed item ${index} end line`);
    expectNoRawLiterals(actual, pythonContinuationHostileLiterals, `Python continuation provenance read_many item ${index}`);
  }
  expectNoHostileResponseFields(
    pythonContinuationBatch,
    pythonContinuationHostileLiterals,
    'Python continuation provenance read_many'
  );

  const pythonContinuationSearchCases = [
    {
      query: 'Token[str]',
      regexQuery: 'Token\\[str\\]',
      expectedLines: [2, 8, 12, 24, 27],
      lawful: true
    },
    {
      query: 'ACTUAL_LITERAL_SECRET_7X9',
      regexQuery: 'ACTUAL_LITERAL_SECRET_7X9',
      expectedLines: [4, 16, 20, 29],
      lawful: false
    }
  ];
  for (const { query, regexQuery, expectedLines, lawful } of pythonContinuationSearchCases) {
    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, query],
      ['structured', { intent: 'text' }, query],
      ['regex', { regex: true }, regexQuery],
      ['structured-regex', { intent: 'text', regex: true }, regexQuery]
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: {
          workspace_id: workspaceId,
          query: searchQuery,
          path: 'python-continuation-provenance.py',
          max_results: 20,
          ...variantArgs
        }
      }), `Python continuation provenance ${variantName} search ${query}`);
      assert.deepEqual(
        searched.structuredContent.matches?.map((match) => match.line),
        expectedLines,
        `Python continuation provenance ${variantName} search ${query} changed physical match lines`
      );
      const rawExpectedLines = expectedLines.map((line) => pythonContinuationProvenance.split('\n')[line - 1]);
      for (const [index, match] of (searched.structuredContent.matches ?? []).entries()) {
        assert.equal(match.path, 'python-continuation-provenance.py', `Python continuation provenance ${variantName} search ${query} changed match path`);
        if (lawful) {
          assert.equal(match.text, rawExpectedLines[index], `Python continuation provenance ${variantName} search ${query} changed lawful lexical match`);
        } else {
          expectRedactedText(match.text, `Python continuation provenance ${variantName} search ${query} lexical match`);
        }
      }
      assert.equal(
        resultText(searched).includes(lawful ? rawExpectedLines[0] : '[REDACTED_SECRET]'),
        true,
        `Python continuation provenance ${variantName} search ${query} changed content envelope`
      );
      const analysis = searched.structuredContent.analysis;
      if (analysis) {
        expectNoRawLiterals(analysis.matches, pythonContinuationHostileLiterals, `Python continuation provenance ${variantName} search ${query} analysis.matches`);
        expectNoRawLiterals(analysis.groups, pythonContinuationHostileLiterals, `Python continuation provenance ${variantName} search ${query} analysis.groups`);
        if (Object.prototype.hasOwnProperty.call(analysis, 'query')) {
          const expectedAnalysisQuery = lawful && !variantName.includes('regex')
            ? query
            : '[REDACTED_SECRET]';
          assert.equal(
            analysis.query,
            expectedAnalysisQuery,
            `Python continuation provenance ${variantName} search ${query} changed analysis.query`
          );
        }
        if (lawful && variantName === 'structured' && Array.isArray(analysis.matches)) {
          assert.deepEqual(
            analysis.matches.map((match) => match.line),
            expectedLines,
            `Python continuation provenance ${variantName} search ${query} changed analysis.matches lines`
          );
        }
      }
      if (lawful) {
        assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `Python continuation provenance ${variantName} search ${query} redacted lawful content`);
      } else {
        expectRedactedText(resultText(searched), `Python continuation provenance ${variantName} search ${query} content envelope`);
      }
      expectNoHostileResponseFields(
        searched,
        pythonContinuationHostileLiterals,
        `Python continuation provenance ${variantName} search ${query}`
      );
      if (!lawful) {
        assert.equal(JSON.stringify(searched).includes(searchQuery), false, `Python continuation provenance ${variantName} search ${query} echoed its raw query`);
        if (query === 'ACTUAL_LITERAL_SECRET_7X9' && variantName === 'structured-regex') {
          await writeRawArtifact(rawArtifactDir, 'python-continuation-provenance-structured-regex-search', searched);
        }
      }
    }
  }

  const pythonBoundaryMcpFixtures = [
    {
      memberCount: 96,
      path: 'python-boundary-96.py',
      source: pythonBoundarySources.get(96)
    },
    {
      memberCount: pythonBoundaryLongMemberCount,
      path: `python-boundary-${pythonBoundaryLongMemberCount}.py`,
      source: pythonBoundarySources.get(pythonBoundaryLongMemberCount)
    }
  ];
  for (const fixture of pythonLogicalFixtures.values()) {
    const label = `Python logical ${fixture.id}`;
    const tokenLine = pythonTokenLine(fixture.source);
    const headerStartLine = pythonHeaderStartLine(fixture.source, fixture);
    const full = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: fixture.path }
    }), `${label} full read`);
    const fullExpected = assertReadMetadata(full, fixture.source, 1, undefined, `${label} full read`);
    assert.equal(full.structuredContent.text, fullExpected.text, `${label} full read changed lawful source bytes`);
    assert.equal(full.structuredContent.text.includes('[REDACTED_SECRET]'), false, `${label} full read redacted lawful source`);
    assert.equal(full.content?.[0]?.text.includes(fullExpected.text), true, `${label} full read content envelope changed lawful source`);
    expectNoHostileResponseFields(full, pythonHostileResponseLiterals, `${label} full read`);

    const ranges = [
      [tokenLine, tokenLine, 'one-line Token[str]'],
      [headerStartLine, tokenLine, 'multiline header-to-member']
    ];
    for (const [startLine, endLine, rangeLabel] of ranges) {
      const ranged = assertToolSuccess(await client.request('tools/call', {
        name: 'read',
        arguments: { workspace_id: workspaceId, path: fixture.path, start_line: startLine, end_line: endLine }
      }), `${label} ${rangeLabel} read`);
      const expected = assertReadMetadata(ranged, fixture.source, startLine, endLine, `${label} ${rangeLabel} read`);
      assert.equal(ranged.structuredContent.text, expected.text, `${label} ${rangeLabel} read changed lawful source bytes`);
      assert.equal(ranged.structuredContent.text, projectedRange(fixture.source, startLine, endLine).text, `${label} ${rangeLabel} read diverged from raw fixture projection`);
      assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `${label} ${rangeLabel} read redacted lawful source`);
      assert.equal(ranged.content?.[0]?.text.includes(expected.text), true, `${label} ${rangeLabel} read content envelope changed lawful source`);
      expectNoHostileResponseFields(ranged, pythonHostileResponseLiterals, `${label} ${rangeLabel} read`);
    }

    const batchItems = ranges.map(([start_line, end_line]) => ({ path: fixture.path, start_line, end_line }));
    const batch = assertToolSuccess(await client.request('tools/call', {
      name: 'read_many',
      arguments: { workspace_id: workspaceId, items: batchItems }
    }), `${label} read_many`);
    const batchResults = batch.structuredContent.results ?? [];
    assert.equal(batchResults.length, batchItems.length, `${label} read_many changed item count`);
    for (const [index, item] of batchItems.entries()) {
      const expected = projectedRange(fixture.source, item.start_line, item.end_line);
      const actual = batchResults[index];
      assert.deepEqual(
        { index: actual.index, path: actual.path, ok: actual.ok, text: actual.result?.text },
        { index, path: fixture.path, ok: true, text: expected.text },
        `${label} read_many changed item ${index}`
      );
      assert.equal(actual.result.startLine, expected.start, `${label} read_many changed item ${index} start line`);
      assert.equal(actual.result.endLine, expected.end, `${label} read_many changed item ${index} end line`);
      expectNoHostileResponseFields(actual, pythonHostileResponseLiterals, `${label} read_many item ${index}`);
    }
    expectNoHostileResponseFields(batch, pythonHostileResponseLiterals, `${label} read_many`);

    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, 'Token[str]'],
      ['structured', { intent: 'text' }, 'Token[str]'],
      ['regex', { regex: true }, 'Token\\[str\\]'],
      ['structured-regex', { intent: 'text', regex: true }, 'Token\\[str\\]']
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: fixture.path, max_results: 20, ...variantArgs }
      }), `${label} ${variantName} search`);
      const matches = searched.structuredContent.matches ?? [];
      assert.deepEqual(matches.map((match) => match.line), [tokenLine], `${label} ${variantName} search changed exact match line`);
      assert.equal(matches.length, 1, `${label} ${variantName} search changed exact match count`);
      assert.equal(matches[0].path, fixture.path, `${label} ${variantName} search changed match path`);
      assert.equal(matches[0].text, fixture.source.split('\n')[tokenLine - 1], `${label} ${variantName} search changed exact match text`);
      const analysis = searched.structuredContent.analysis;
      if (variantName === 'structured') {
        assert.ok(analysis && Object.prototype.hasOwnProperty.call(analysis, 'query'), `${label} ${variantName} search omitted analysis.query`);
        assert.equal(analysis.query, 'Token[str]', `${label} ${variantName} search changed analysis.query`);
      }
      assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `${label} ${variantName} search redacted lawful content`);
      expectNoHostileResponseFields(searched, pythonHostileResponseLiterals, `${label} ${variantName} search`);
    }
  }

  const pythonLogicalMutationIds = new Set([
    'simple-multiline-base',
    'nested-multiline-class',
    'multiline-base-96-members',
    'multiline-base-512-members'
  ]);
  for (const fixture of [...pythonLogicalFixtures.values()].filter(({ id }) => pythonLogicalMutationIds.has(id))) {
    const label = `Python logical ${fixture.id}`;
    const writePath = `python-logical-${fixture.id}-write.py`;
    const written = assertToolSuccess(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: writePath, content: fixture.source }
    }), `${label} lawful write`);
    assert.ok(written.structuredContent, `${label} lawful write omitted structured output`);
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), fixture.source, `${label} lawful write changed source`);
    assertPythonAstAccepted(fixture.source, `${label} lawful write target`);

    const tokenLine = pythonTokenLine(fixture.source);
    const headerStartLine = pythonHeaderStartLine(fixture.source, fixture);
    const tokenIndent = fixture.source.split('\n')[tokenLine - 1].match(/^\s*/u)?.[0] ?? '    ';
    const lawfulEdit = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: writePath,
        old_text: `${tokenIndent}token: Token[str]`,
        new_text: `${tokenIndent}token: Token[bytes]`,
        expected_replacements: 1
      }
    }), `${label} lawful edit`);
    assert.ok(lawfulEdit.structuredContent, `${label} lawful edit omitted structured output`);
    const afterEdit = fixture.source.replace(`${tokenIndent}token: Token[str]`, `${tokenIndent}token: Token[bytes]`);
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), afterEdit, `${label} lawful edit changed source`);
    assertPythonAstAccepted(afterEdit, `${label} lawful edit target`);

    const addedMember = `${tokenIndent}added: Token[str]`;
    const addPatch = pythonLogicalPatch(writePath, afterEdit, headerStartLine, tokenLine, addedMember, { add: true });
    const added = assertToolSuccess(await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: workspaceId, patch: addPatch }
    }), `${label} lawful added-member apply_patch`);
    assert.ok(added.structuredContent, `${label} lawful added-member apply_patch omitted structured output`);
    const afterAdd = afterEdit.replace(`${tokenIndent}token: Token[bytes]`, `${addedMember}\n${tokenIndent}token: Token[bytes]`);
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), afterAdd, `${label} lawful added-member apply_patch changed source`);
    assertPythonAstAccepted(afterAdd, `${label} lawful added-member patch target`);

    const replacedMember = `${tokenIndent}replaced: Token[str]`;
    const replacePatch = pythonLogicalPatch(writePath, afterAdd, headerStartLine, tokenLine, replacedMember);
    const replaced = assertToolSuccess(await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: workspaceId, patch: replacePatch }
    }), `${label} lawful replaced-member apply_patch`);
    assert.ok(replaced.structuredContent, `${label} lawful replaced-member apply_patch omitted structured output`);
    const afterReplace = afterAdd.replace(addedMember, replacedMember);
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), afterReplace, `${label} lawful replaced-member apply_patch changed source`);
    assertPythonAstAccepted(afterReplace, `${label} lawful replaced-member patch target`);

    const hostileMember = `${tokenIndent}token = "QZ7"`;
    const hostilePatch = pythonLogicalPatch(writePath, afterReplace, headerStartLine, tokenLine, hostileMember);
    const beforeHostilePatch = await fs.readFile(path.join(tmp, writePath), 'utf8');
    const blocked = assertToolError(await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: workspaceId, patch: hostilePatch }
    }), `${label} hostile apply_patch`);
    assert.match(resultText(blocked), /Secret-looking content is blocked/);
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), beforeHostilePatch, `${label} hostile apply_patch mutated source despite rejection`);
    assertPythonAstAccepted(beforeHostilePatch, `${label} hostile patch atomicity target`);
    expectNoHostileResponseFields(blocked, pythonHostileResponseLiterals, `${label} hostile apply_patch`);
  }

  for (const fixture of pythonBoundaryMcpFixtures) {
    const label = `Python ${fixture.memberCount}-member boundary`;
    const targetLine = fixture.memberCount + 2;
    const multiLineStart = targetLine - 1;
    const multiLineEnd = targetLine + 1;
    const full = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: fixture.path }
    }), `${label} full read`);
    const fullExpected = assertReadMetadata(full, fixture.source, 1, undefined, `${label} full read`);
    assert.equal(full.structuredContent.text, fullExpected.text, `${label} full read changed lawful source bytes`);
    assert.equal(full.structuredContent.text.includes('[REDACTED_SECRET]'), false, `${label} full read redacted lawful source`);
    assert.equal(full.content?.[0]?.text.includes(fullExpected.text), true, `${label} full read content envelope changed lawful source bytes`);
    expectNoRawCredential(full, `${label} full read`);

    for (const [startLine, endLine, rangeLabel] of [
      [targetLine, targetLine, 'one-line Token[str]'],
      [multiLineStart, multiLineEnd, 'multi-line surrounding range']
    ]) {
      const ranged = assertToolSuccess(await client.request('tools/call', {
        name: 'read',
        arguments: { workspace_id: workspaceId, path: fixture.path, start_line: startLine, end_line: endLine }
      }), `${label} ${rangeLabel} read`);
      const expected = assertReadMetadata(ranged, fixture.source, startLine, endLine, `${label} ${rangeLabel} read`);
      assert.equal(ranged.structuredContent.text, expected.text, `${label} ${rangeLabel} read changed lawful source bytes`);
      assert.equal(ranged.structuredContent.text.includes('[REDACTED_SECRET]'), false, `${label} ${rangeLabel} read redacted lawful source`);
      assert.equal(ranged.content?.[0]?.text.includes(expected.text), true, `${label} ${rangeLabel} read content envelope changed lawful source bytes`);
      expectNoRawCredential(ranged, `${label} ${rangeLabel} read`);
    }

    const boundaryBatchItems = [
      { path: fixture.path, start_line: targetLine, end_line: targetLine },
      { path: fixture.path, start_line: multiLineStart, end_line: multiLineEnd }
    ];
    const boundaryBatch = assertToolSuccess(await client.request('tools/call', {
      name: 'read_many',
      arguments: { workspace_id: workspaceId, items: boundaryBatchItems }
    }), `${label} read_many`);
    const boundaryResults = boundaryBatch.structuredContent.results ?? [];
    assert.equal(boundaryResults.length, boundaryBatchItems.length, `${label} read_many changed item count`);
    for (const [index, item] of boundaryBatchItems.entries()) {
      const expected = projectedRange(fixture.source, item.start_line, item.end_line);
      const actual = boundaryResults[index];
      assert.deepEqual(
        { index: actual.index, path: actual.path, ok: actual.ok, text: actual.result?.text },
        { index, path: fixture.path, ok: true, text: expected.text },
        `${label} read_many changed item ${index}`
      );
      expectNoRawCredential(actual, `${label} read_many item ${index}`);
    }
    expectNoRawLiterals(boundaryBatch, ['[REDACTED_SECRET]'], `${label} read_many`);

    for (const [variantName, variantArgs, searchQuery] of [
      ['plain', {}, 'Token[str]'],
      ['structured', { intent: 'text' }, 'Token[str]'],
      // Keep the regex query itself a lawful literal so the MCP analysis
      // field can prove it remains visible rather than being replaced by a
      // policy marker; the exact match assertion still checks Token[str].
      ['regex', { regex: true }, 'Token'],
      ['structured-regex', { intent: 'text', regex: true }, 'Token']
    ]) {
      const searched = assertToolSuccess(await client.request('tools/call', {
        name: 'search',
        arguments: { workspace_id: workspaceId, query: searchQuery, path: fixture.path, max_results: 20, ...variantArgs }
      }), `${label} ${variantName} search`);
      const matches = searched.structuredContent.matches ?? [];
      assert.deepEqual(matches.map((match) => match.line), [targetLine], `${label} ${variantName} search changed exact match line`);
      assert.equal(matches.length, 1, `${label} ${variantName} search changed exact match count`);
      assert.equal(matches[0].path, fixture.path, `${label} ${variantName} search changed match path`);
      assert.equal(matches[0].text, '    token: Token[str]', `${label} ${variantName} search changed exact match text`);
      const analysis = searched.structuredContent.analysis;
      if (analysis && Object.prototype.hasOwnProperty.call(analysis, 'query')) {
        assert.notEqual(analysis.query, '[REDACTED_SECRET]', `${label} ${variantName} search redacted lawful analysis.query`);
      }
      assert.equal(resultText(searched).includes('[REDACTED_SECRET]'), false, `${label} ${variantName} search redacted lawful content`);
      expectNoRawCredential(searched, `${label} ${variantName} search`);
    }
  }

  for (const fixture of pythonBoundaryMcpFixtures) {
    const writePath = `python-boundary-${fixture.memberCount}-write.py`;
    const written = assertToolSuccess(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: writePath, content: fixture.source }
    }), `Python ${fixture.memberCount}-member lawful write`);
    assert.ok(written.structuredContent, `Python ${fixture.memberCount}-member lawful write omitted structured output`);
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), fixture.source, `Python ${fixture.memberCount}-member lawful write changed source`);

    const edited = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: writePath,
        old_text: '    field_0: str',
        new_text: '    field_0: int',
        expected_replacements: 1
      }
    }), `Python ${fixture.memberCount}-member lawful edit`);
    assert.ok(edited.structuredContent, `Python ${fixture.memberCount}-member lawful edit omitted structured output`);
    const afterEdit = fixture.source.replace('    field_0: str', '    field_0: int');
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), afterEdit, `Python ${fixture.memberCount}-member lawful edit changed source`);

    const patch = [
      `diff --git a/${writePath} b/${writePath}`,
      `--- a/${writePath}`,
      `+++ b/${writePath}`,
      '@@ -1,4 +1,4 @@',
      ` class Boundary${fixture.memberCount}:`,
      '     field_0: int',
      '-    field_1: str',
      '+    field_1: int',
      '     field_2: str'
    ].join('\n') + '\n';
    assertToolSuccess(await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: workspaceId, patch }
    }), `Python ${fixture.memberCount}-member lawful apply_patch`);
    const afterPatch = afterEdit.replace('    field_1: str', '    field_1: int');
    assert.equal(await fs.readFile(path.join(tmp, writePath), 'utf8'), afterPatch, `Python ${fixture.memberCount}-member lawful apply_patch changed source`);
  }

  const lawfulRangeBatchItems = [
    { path: 'ranged-lawful.ts', start_line: 2, end_line: 3 },
    { path: 'ranged-lawful.ts', start_line: 10, end_line: 11 },
    { path: 'ranged-lawful.py', start_line: 2, end_line: 2 },
    { path: 'ranged-lawful.py', start_line: 5, end_line: 6 }
  ];
  const lawfulRangeBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: lawfulRangeBatchItems }
  }), 'lawful ranged read_many');
  const lawfulRangeResults = lawfulRangeBatch.structuredContent.results ?? [];
  assert.equal(lawfulRangeResults.length, lawfulRangeBatchItems.length, 'lawful ranged read_many changed item count');
  for (const [index, item] of lawfulRangeBatchItems.entries()) {
    const source = item.path.endsWith('.py') ? rangedLawfulPy : rangedLawfulTs;
    const expected = projectedRange(source, item.start_line, item.end_line);
    const actual = lawfulRangeResults[index];
    assert.equal(actual.index, index, 'lawful ranged read_many changed item order');
    assert.equal(actual.path, item.path, 'lawful ranged read_many changed item path');
    assert.equal(actual.ok, true, `lawful ranged read_many rejected ${item.path}`);
    assert.equal(actual.result.text, expected.text, `lawful ranged read_many changed ${item.path} projection`);
    assert.equal(actual.result.startLine, expected.start, `lawful ranged read_many changed ${item.path} start line`);
    assert.equal(actual.result.endLine, expected.end, `lawful ranged read_many changed ${item.path} end line`);
    assert.equal(actual.result.totalLines, expected.totalLines, `lawful ranged read_many changed ${item.path} total lines`);
    assert.equal(actual.result.bytes, Buffer.byteLength(source, 'utf8'), `lawful ranged read_many changed ${item.path} byte metadata`);
    assert.equal(actual.result.sha256, sha256(source), `lawful ranged read_many changed ${item.path} SHA-256 metadata`);
    assert.equal(actual.result.truncated, true, `lawful ranged read_many lost ${item.path} truncation metadata`);
    expectNoRawCredential(actual, `lawful ranged read_many ${item.path}`);
  }
  expectNoRawLiterals(lawfulRangeBatch, ['[REDACTED_SECRET]'], 'lawful ranged read_many');

  const hostileRangeLiterals = [
    'QZ7',
    'ACTUAL_LITERAL_SECRET_7X9',
    'client.actualSecret',
    'client.getSecret()',
    'Token<ACTUAL_LITERAL_SECRET_7X9',
    'Token<client.actualSecret',
    'Password<client.getSecret()',
    'Wrapper<Token<client.actualSecret>>'
  ];
  const hostileRangeFixtures = [
    {
      path: 'ranged-hostile.yaml',
      source: rangedHostileFixtures['ranged-hostile.yaml'],
      ranges: [[2, 2], [3, 4], [2, 5]]
    },
    {
      path: 'ranged-hostile.env',
      source: rangedHostileFixtures['ranged-hostile.env'],
      ranges: [[1, 2], [3, 4], [2, 4]]
    },
    {
      path: 'ranged-hostile.json',
      source: rangedHostileFixtures['ranged-hostile.json'],
      ranges: [[2, 2], [3, 4], [2, 5]]
    },
    {
      path: 'ranged-hostile.ts',
      source: rangedHostileFixtures['ranged-hostile.ts'],
      ranges: [[2, 2], [3, 4], [2, 5]]
    }
  ];
  for (const { path: relativePath, source, ranges } of hostileRangeFixtures) {
    const redacted = rangedHostileRedacted[relativePath];
    const full = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: relativePath }
    }), `hostile full read ${relativePath}`);
    assertReadMetadata(full, source, 1, undefined, `hostile full read ${relativePath}`);
    assert.equal(full.structuredContent.text, numbered(redacted), `hostile full read ${relativePath} changed independently-derived sanitized projection`);
    expectRedactedText(full.structuredContent.text, `hostile full read ${relativePath}`);
    expectNoRawLiterals(full, hostileRangeLiterals, `hostile full read ${relativePath}`);
    expectNoRawLiterals(full.content?.[0]?.text ?? '', hostileRangeLiterals, `hostile full read ${relativePath} content envelope`);
    expectNoRawLiterals(full._meta, hostileRangeLiterals, `hostile full read ${relativePath} _meta`);

    for (const [startLine, endLine] of ranges) {
      const ranged = assertToolSuccess(await client.request('tools/call', {
        name: 'read',
        arguments: { workspace_id: workspaceId, path: relativePath, start_line: startLine, end_line: endLine }
      }), `hostile range read ${relativePath} ${startLine}-${endLine}`);
      assertReadMetadata(ranged, source, startLine, endLine, `hostile range read ${relativePath} ${startLine}-${endLine}`);
      assert.equal(ranged.structuredContent.text, projectedRange(redacted, startLine, endLine).text, `hostile range read ${relativePath} ${startLine}-${endLine} diverged from independently-derived full sanitized projection`);
      expectRedactedText(ranged.structuredContent.text, `hostile range read ${relativePath} ${startLine}-${endLine}`);
      expectNoRawLiterals(ranged, hostileRangeLiterals, `hostile range read ${relativePath} ${startLine}-${endLine}`);
      expectNoRawLiterals(ranged.content?.[0]?.text ?? '', hostileRangeLiterals, `hostile range read ${relativePath} ${startLine}-${endLine} content envelope`);
      expectNoRawLiterals(ranged._meta, hostileRangeLiterals, `hostile range read ${relativePath} ${startLine}-${endLine} _meta`);
    }
  }

  const hostileRangeBatchItems = [
    { path: 'ranged-hostile.yaml', start_line: 2, end_line: 4 },
    { path: 'ranged-hostile.env', start_line: 1, end_line: 2 },
    { path: 'ranged-hostile.json', start_line: 3, end_line: 4 },
    { path: 'ranged-hostile.ts', start_line: 2, end_line: 5 }
  ];
  const hostileRangeBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, items: hostileRangeBatchItems }
  }), 'hostile ranged read_many');
  const hostileRangeResults = hostileRangeBatch.structuredContent.results ?? [];
  assert.equal(hostileRangeResults.length, hostileRangeBatchItems.length, 'hostile ranged read_many changed item count');
  for (const [index, item] of hostileRangeBatchItems.entries()) {
    const source = rangedHostileFixtures[item.path];
    const redacted = rangedHostileRedacted[item.path];
    const actual = hostileRangeResults[index];
    assert.equal(actual.index, index, 'hostile ranged read_many changed item order');
    assert.equal(actual.path, item.path, 'hostile ranged read_many changed item path');
    assert.equal(actual.ok, true, `hostile ranged read_many rejected ${item.path}`);
    const expected = projectedRange(redacted, item.start_line, item.end_line);
    assert.equal(actual.result.text, expected.text, `hostile ranged read_many changed ${item.path} sanitized projection`);
    assert.equal(actual.result.startLine, expected.start, `hostile ranged read_many changed ${item.path} start line`);
    assert.equal(actual.result.endLine, expected.end, `hostile ranged read_many changed ${item.path} end line`);
    assert.equal(actual.result.totalLines, expected.totalLines, `hostile ranged read_many changed ${item.path} total lines`);
    assert.equal(actual.result.bytes, Buffer.byteLength(source, 'utf8'), `hostile ranged read_many changed ${item.path} byte metadata`);
    assert.equal(actual.result.sha256, sha256(source), `hostile ranged read_many changed ${item.path} SHA-256 metadata`);
    assert.equal(actual.result.truncated, true, `hostile ranged read_many lost ${item.path} truncation metadata`);
    expectRedactedText(actual.result.text, `hostile ranged read_many ${item.path}`);
    expectNoRawLiterals(actual, hostileRangeLiterals, `hostile ranged read_many ${item.path}`);
  }
  expectNoRawLiterals(hostileRangeBatch, hostileRangeLiterals, 'hostile ranged read_many complete response');
  expectNoRawLiterals(hostileRangeBatch._meta, hostileRangeLiterals, 'hostile ranged read_many _meta');

  const privateRangedSafeLines = [
    'const rangedBefore = true;',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    'const rangedAfter = true;',
    ''
  ].join('\n');
  const privateCrlfSafeLines = [
    'const crlfBefore = true;',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    'const crlfAfter = true;',
    ''
  ].join('\n');
  const duplicatePrivateSafeLines = [
    'const duplicate = true;',
    'const duplicate = true;',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    '[REDACTED_PRIVATE_KEY]',
    'const duplicate = true;',
    'const duplicate = true;',
    ''
  ].join('\n');
  const incompletePrivateSafeLines = ['[REDACTED_PRIVATE_KEY]', '[REDACTED_PRIVATE_KEY]', ''].join('\n');
  const fragmentedPrivateSafeLines = ['[REDACTED_PRIVATE_KEY]', '[REDACTED_PRIVATE_KEY]', ''].join('\n');
  const privateRangeCases = [
    {
      path: 'private-ranged.txt',
      source: privateRangedFixture,
      redacted: privateRangedSafeLines,
      literals: ['RANGED_PRIVATE_BODY_7X9'],
      ranges: [[1, 1], [3, 3], [2, 4], [5, 5]]
    },
    {
      path: 'private-crlf.txt',
      source: privateCrlfFixture,
      redacted: privateCrlfSafeLines,
      literals: ['CRLF_PRIVATE_BODY_7X9'],
      ranges: [[1, 1], [3, 3], [2, 4], [5, 5]]
    },
    {
      path: 'private-duplicate.txt',
      source: privateSearchFixtures['private-duplicate.txt'],
      redacted: duplicatePrivateSafeLines,
      literals: ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'],
      ranges: [[3, 5], [1, 7]]
    },
    {
      path: 'private-incomplete.txt',
      source: privateSearchFixtures['private-incomplete.txt'],
      redacted: incompletePrivateSafeLines,
      literals: ['INCOMPLETE_PRIVATE_BODY_7X9'],
      ranges: [[2, 2], [1, 2]]
    },
    {
      path: 'private-fragmented.txt',
      source: privateSearchFixtures['private-fragmented.txt'],
      redacted: fragmentedPrivateSafeLines,
      literals: ['FRAGMENTED_PRIVATE_BODY_7X9'],
      ranges: [[2, 2], [1, 2]]
    }
  ];
  for (const { path: relativePath, source, redacted, literals, ranges } of privateRangeCases) {
    const full = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: relativePath }
    }), `private full read ${relativePath}`);
    assertReadMetadata(full, source, 1, undefined, `private full read ${relativePath}`);
    assert.equal(full.structuredContent.text, numbered(redacted), `private full read ${relativePath} changed physical redaction line mapping`);
    expectNoRawLiterals(full, literals, `private full read ${relativePath}`);
    for (const [startLine, endLine] of ranges) {
      const ranged = assertToolSuccess(await client.request('tools/call', {
        name: 'read',
        arguments: { workspace_id: workspaceId, path: relativePath, start_line: startLine, end_line: endLine }
      }), `private range read ${relativePath} ${startLine}-${endLine}`);
      assertReadMetadata(ranged, source, startLine, endLine, `private range read ${relativePath} ${startLine}-${endLine}`);
      const expected = projectedRange(redacted, startLine, endLine);
      assert.equal(ranged.structuredContent.text, expected.text, `private range read ${relativePath} ${startLine}-${endLine} changed physical redaction line mapping`);
      expectNoRawLiterals(ranged, literals, `private range read ${relativePath} ${startLine}-${endLine}`);
      expectNoRawLiterals(ranged.content?.[0]?.text ?? '', literals, `private range read ${relativePath} ${startLine}-${endLine} content envelope`);
    }
  }

  const privateRangeBatchItems = [
    { path: 'private-ranged.txt', start_line: 3, end_line: 3 },
    { path: 'private-duplicate.txt', start_line: 3, end_line: 5 },
    { path: 'private-crlf.txt', start_line: 2, end_line: 4 }
  ];
  const privateRangeBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      items: privateRangeBatchItems
    }
  }), 'private ranged read_many');
  const privateRangeResults = privateRangeBatch.structuredContent.results ?? [];
  assert.equal(privateRangeResults.length, 3, 'private ranged read_many changed item count');
  assert.deepEqual(privateRangeResults.map((item) => ({ index: item.index, path: item.path, ok: item.ok })), [
    { index: 0, path: 'private-ranged.txt', ok: true },
    { index: 1, path: 'private-duplicate.txt', ok: true },
    { index: 2, path: 'private-crlf.txt', ok: true }
  ], 'private ranged read_many changed order or item status');
  for (const [index, item] of privateRangeBatchItems.entries()) {
    const source = item.path === 'private-ranged.txt'
      ? privateRangedFixture
      : item.path === 'private-duplicate.txt'
        ? privateSearchFixtures['private-duplicate.txt']
        : privateCrlfFixture;
    const expected = projectedRange(source, item.start_line, item.end_line);
    const actual = privateRangeResults[index].result;
    assert.equal(actual.startLine, expected.start, `private ranged read_many changed ${item.path} start line`);
    assert.equal(actual.endLine, expected.end, `private ranged read_many changed ${item.path} end line`);
    assert.equal(actual.totalLines, expected.totalLines, `private ranged read_many changed ${item.path} total lines`);
    assert.equal(actual.bytes, Buffer.byteLength(source, 'utf8'), `private ranged read_many changed ${item.path} byte metadata`);
    assert.equal(actual.sha256, sha256(source), `private ranged read_many changed ${item.path} SHA-256 metadata`);
    assert.equal(actual.truncated, true, `private ranged read_many lost ${item.path} truncation metadata`);
  }
  assert.equal(privateRangeResults[0].result.text, projectedRange(privateRangedSafeLines, 3, 3).text, 'private ranged read_many lost inside-key mapping');
  assert.equal(privateRangeResults[1].result.text, projectedRange(duplicatePrivateSafeLines, 3, 5).text, 'private duplicate read_many lost mapping');
  assert.equal(privateRangeResults[2].result.text, projectedRange(privateCrlfSafeLines, 2, 4).text, 'private CRLF read_many lost mapping');
  expectNoRawLiterals(privateRangeBatch, ['RANGED_PRIVATE_BODY_7X9', 'CRLF_PRIVATE_BODY_7X9', 'PRIVATE_KEY-----'], 'private ranged read_many complete response');

  const fullByteLimited = assertToolError(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'ranged-byte-limit.ts', max_bytes: 1_000 }
  }), 'full read max_bytes limit');
  assert.match(resultText(fullByteLimited), /too large|limit/i, 'full read max_bytes limit changed its bounded error');
  expectNoRawLiterals(fullByteLimited, ['x'.repeat(128)], 'full read max_bytes error');

  const rangedByteLimitedError = assertToolError(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'ranged-byte-limit.ts', start_line: 1, end_line: 1, max_bytes: 1_000 }
  }), 'ranged read selected max_bytes limit');
  assert.match(resultText(rangedByteLimitedError), /Selected line range is too large/i, 'ranged read selected max_bytes limit changed its bounded error');
  expectNoRawLiterals(rangedByteLimitedError, ['x'.repeat(128)], 'ranged read selected max_bytes error');

  const rangedByteTail = assertToolSuccess(await client.request('tools/call', {
    name: 'read',
    arguments: { workspace_id: workspaceId, path: 'ranged-byte-limit.ts', start_line: 2, end_line: 2, max_bytes: 1_000 }
  }), 'ranged read max_bytes bounded success');
  const rangedByteTailExpected = assertReadMetadata(rangedByteTail, rangedByteLimit, 2, 2, 'ranged read max_bytes bounded success');
  assert.equal(rangedByteTail.structuredContent.text, rangedByteTailExpected.text, 'ranged read max_bytes bounded success changed selected source');
  assert.equal(rangedByteTail.structuredContent.text, '2 | const rangedByteTail = true;', 'ranged read max_bytes bounded success changed line framing');

  const byteLimitBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      items: [
        { path: 'ranged-byte-limit.ts', max_bytes: 1_000 },
        { path: 'ranged-lawful.ts', start_line: 2, end_line: 2 }
      ]
    }
  }), 'read_many item max_bytes limit');
  const byteLimitResults = byteLimitBatch.structuredContent.results ?? [];
  assert.equal(byteLimitResults.length, 2, 'read_many item max_bytes limit changed item count');
  assert.deepEqual(byteLimitResults.map((item) => ({ index: item.index, path: item.path, ok: item.ok })), [
    { index: 0, path: 'ranged-byte-limit.ts', ok: false },
    { index: 1, path: 'ranged-lawful.ts', ok: true }
  ], 'read_many item max_bytes limit changed order or sibling status');
  assert.match(byteLimitResults[0].error, /too large|limit/i, 'read_many item max_bytes limit changed its bounded error');
  assert.equal(byteLimitResults[0].error.length <= 512, true, 'read_many item max_bytes error exceeded its bounded length');
  expectNoRawLiterals(byteLimitBatch, ['x'.repeat(128)], 'read_many item max_bytes response');

  const fourKilobyteBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      max_total_bytes: 4_000,
      items: [{ path: 'ranged-lawful.ts', start_line: 2, end_line: 3 }]
    }
  }), 'read_many explicit 4000-byte budget');
  assert.equal(fourKilobyteBatch.structuredContent.max_total_bytes, 4_000, 'read_many explicit budget was not reported');
  assert.ok(Buffer.byteLength(JSON.stringify(fourKilobyteBatch), 'utf8') <= 4_000, 'read_many explicit 4000-byte budget was exceeded');

  const aggregateOverflowBatch = assertToolError(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      max_total_bytes: 4_000,
      items: Array.from({ length: 32 }, () => ({ path: 'ranged-byte-limit.ts' }))
    }
  }), 'read_many aggregate byte limit');
  assert.match(resultText(aggregateOverflowBatch), /aggregate response exceeds|max_total_bytes/i, 'read_many aggregate byte limit changed its bounded error');
  expectNoRawLiterals(aggregateOverflowBatch, ['x'.repeat(128)], 'read_many aggregate byte-limit error');

  const thirtyTwoItemBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      max_total_bytes: 100_000,
      items: Array.from({ length: 32 }, () => ({ path: 'safe-config.js', start_line: 1, end_line: 1 }))
    }
  }), 'read_many maximum item count');
  const thirtyTwoResults = thirtyTwoItemBatch.structuredContent.results ?? [];
  assert.equal(thirtyTwoResults.length, 32, 'read_many maximum item count changed result count');
  assert.ok(thirtyTwoResults.every((item, index) => item.index === index && item.path === 'safe-config.js' && item.ok === true), 'read_many maximum item count changed ordered lawful items');

  const thirtyThreeItemBatch = assertToolError(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      items: Array.from({ length: 33 }, () => ({ path: 'safe-config.js' }))
    }
  }), 'read_many item count limit');
  assert.match(resultText(thirtyThreeItemBatch), /Invalid arguments for read_many/i, 'read_many item count limit changed its bounded error');
  expectNoRawLiterals(thirtyThreeItemBatch, ['const API_TOKEN'], 'read_many item count error');

  const overMaximumBatch = assertToolError(await client.request('tools/call', {
    name: 'read_many',
    arguments: { workspace_id: workspaceId, max_total_bytes: 100_001, items: [{ path: 'safe-config.js' }] }
  }), 'read_many maximum aggregate limit');
  assert.match(resultText(overMaximumBatch), /Invalid arguments for read_many/i, 'read_many maximum aggregate limit changed its bounded error');

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
    ['options = {apiToken', sourcePyRedacted.split('\n')[9]],
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
    assert.equal(
      resultText(searched).includes('[REDACTED_SECRET]'),
      expectedLines.some((line) => line.includes('[REDACTED_SECRET]')),
      `source search ${query} content envelope changed redaction state`
    );
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
    const expectedProjection = relativePath === 'source.py' ? sourcePyRedacted : expected;
    const item = lawfulBatchResults[index];
    assert.equal(item.index, index, 'lawful read_many changed item order');
    assert.equal(item.path, relativePath, 'lawful read_many hid a source path');
    assert.equal(item.ok, true, `lawful read_many rejected ${relativePath}`);
    assert.equal(item.result.text, numbered(expectedProjection), `lawful read_many changed ${relativePath}`);
    assert.equal(item.result.text.includes('[REDACTED_SECRET]'), expectedProjection.includes('[REDACTED_SECRET]'), `lawful read_many changed redaction state for ${relativePath}`);
    assert.equal(lawfulBatch.content?.[0]?.text.includes(numbered(expectedProjection)), true, `lawful read_many content envelope changed ${relativePath}`);
  }
  assert.equal(lawfulBatch.content?.[0]?.text.includes('[REDACTED_SECRET]'), sourcePyRedacted.includes('[REDACTED_SECRET]'), 'lawful read_many content envelope changed aggregate redaction state');

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
    'compat.py': 'class Compat:\n    token: Token[str]\n    password: PasswordType\n',
    'compat.txt': 'TOKEN = os.getenv("TOKEN")\nPASSWORD = getpass.getpass()\n',
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
    'compat.py': ['token: Token[str]', 'token: Token[bytes]'],
    'compat.txt': ['TOKEN = os.getenv("TOKEN")', 'TOKEN = os.environ.get("TOKEN")'],
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

  const multilineLawfulPath = 'python-multiline-lawful-patch.py';
  await assertToolSuccess(await client.request('tools/call', {
    name: 'write',
    arguments: { workspace_id: workspaceId, path: multilineLawfulPath, content: 'class R:\n' }
  }), 'Python multiline lawful patch seed write');
  const multilineLawfulPatch = [
    `diff --git a/${multilineLawfulPath} b/${multilineLawfulPath}`,
    `--- a/${multilineLawfulPath}`,
    `+++ b/${multilineLawfulPath}`,
    '@@ -1,1 +1,7 @@',
    ' class R:',
    '+    type password = (',
    '+        PasswordType',
    '+    )',
    '+    token: (',
    '+        Token[str]',
    '+    )',
    ''
  ].join('\n');
  await assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: multilineLawfulPatch }
  }), 'Python multiline lawful alias/annotation apply_patch');
  assert.equal(
    await fs.readFile(path.join(tmp, multilineLawfulPath), 'utf8'),
    'class R:\n    type password = (\n        PasswordType\n    )\n    token: (\n        Token[str]\n    )\n',
    'Python multiline lawful patch changed source bytes'
  );

  for (const [label, pathName, diff] of [
    ['alias', 'python-multiline-hostile-alias.py', multilineHostileAliasDiff],
    ['annotation', 'python-multiline-hostile-annotation.py', multilineHostileAnnotationDiff]
  ]) {
    await assertToolSuccess(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: pathName, content: 'class R:\n' }
    }), `Python multiline hostile ${label} patch seed write`);
    const hostileDiff = diff.replaceAll('multiline.py', pathName);
    const before = await fs.readFile(path.join(tmp, pathName), 'utf8');
    const blocked = assertToolError(await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: workspaceId, patch: hostileDiff }
    }), `Python multiline hostile ${label} apply_patch`);
    assert.match(resultText(blocked), /Secret-looking content is blocked/);
    assert.equal(resultText(blocked).includes('ACTUAL_LITERAL_SECRET_7X9'), false, `Python multiline hostile ${label} apply_patch leaked continuation content`);
    assert.equal(await fs.readFile(path.join(tmp, pathName), 'utf8'), before, `Python multiline hostile ${label} apply_patch mutated source`);
  }

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

  const compatPyBeforeBlockedPatch = await fs.readFile(path.join(tmp, 'compat.txt'), 'utf8');
  const literalPatch = [
    'diff --git a/compat.txt b/compat.txt',
    '--- a/compat.txt',
    '+++ b/compat.txt',
    '@@ -1,2 +1,2 @@',
    '-TOKEN = os.environ.get("TOKEN")',
    '+TOKEN = "QZ7"',
    ' PASSWORD = getpass.getpass()'
  ].join('\n') + '\n';
  const blockedPatch = assertToolError(await client.request('tools/call', { name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: literalPatch } }), 'literal credential apply_patch');
  assert.match(resultText(blockedPatch), /Secret-looking content is blocked/);
  assert.equal(await fs.readFile(path.join(tmp, 'compat.txt'), 'utf8'), compatPyBeforeBlockedPatch, 'literal patch changed source despite rejection');

  const applyRenameTxtToPyPatch = [
    'diff --git a/apply-rename-old.txt b/apply-rename-new.py',
    'similarity index 80%',
    'rename from apply-rename-old.txt',
    'rename to apply-rename-new.py',
    '--- a/apply-rename-old.txt',
    '+++ b/apply-rename-new.py',
    '@@ -1,2 +1,2 @@',
    '-class ApplyRenameOldTxt:',
    '-    token: Token[APPLY_RENAME_OLD_LITERAL]',
    '+class ApplyRenameNewPy:',
    '+    token: Token[str]',
    ''
  ].join('\n');
  const blockedApplyRenameTxtToPy = assertToolError(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: applyRenameTxtToPyPatch }
  }), 'MCP .txt-to-.py apply_patch rename');
  assert.match(resultText(blockedApplyRenameTxtToPy), /Secret-looking content is blocked/);
  const applyRenameTxtToPyOldUnchanged = await fs.readFile(path.join(tmp, 'apply-rename-old.txt'), 'utf8') === applyRenameOldTxtSource;
  const applyRenameTxtToPyNewAbsent = await fs.access(path.join(tmp, 'apply-rename-new.py'))
    .then(() => false)
    .catch((error) => {
      if (error?.code === 'ENOENT') return true;
      throw error;
    });
  const applyRenameTxtToPyResponseClean = !applyRenameHostileLiterals.some((literal) => JSON.stringify(blockedApplyRenameTxtToPy)?.includes(literal));
  const applyRenameTxtToPyAtomic = applyRenameTxtToPyOldUnchanged
    && applyRenameTxtToPyNewAbsent
    && applyRenameTxtToPyResponseClean;
  assert.equal(applyRenameTxtToPyAtomic, true, 'MCP .txt-to-.py apply_patch rename was not atomically rejected');
  expectNoHostileResponseFields(blockedApplyRenameTxtToPy, applyRenameHostileLiterals, 'MCP .txt-to-.py apply_patch rename');
  await writeRawArtifact(rawArtifactDir, 'apply-rename-txt-to-py-rejected', blockedApplyRenameTxtToPy);

  const applyRenamePyToTxtPatch = [
    'diff --git a/apply-rename-old.py b/apply-rename-new.txt',
    'similarity index 80%',
    'rename from apply-rename-old.py',
    'rename to apply-rename-new.txt',
    '--- a/apply-rename-old.py',
    '+++ b/apply-rename-new.txt',
    '@@ -1,2 +1,2 @@',
    '-class ApplyRenameOldPy:',
    '-    token: Token[str]',
    '+class ApplyRenameNewTxt:',
    '+    token: Token[APPLY_RENAME_NEW_LITERAL]',
    ''
  ].join('\n');
  const blockedApplyRenamePyToTxt = assertToolError(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: applyRenamePyToTxtPatch }
  }), 'MCP .py-to-.txt apply_patch rename');
  assert.match(resultText(blockedApplyRenamePyToTxt), /Secret-looking content is blocked/);
  const applyRenamePyToTxtOldUnchanged = await fs.readFile(path.join(tmp, 'apply-rename-old.py'), 'utf8') === applyRenameOldPySource;
  const applyRenamePyToTxtNewAbsent = await fs.access(path.join(tmp, 'apply-rename-new.txt'))
    .then(() => false)
    .catch((error) => {
      if (error?.code === 'ENOENT') return true;
      throw error;
    });
  const applyRenamePyToTxtResponseClean = !applyRenameHostileLiterals.some((literal) => JSON.stringify(blockedApplyRenamePyToTxt)?.includes(literal));
  const applyRenamePyToTxtAtomic = applyRenamePyToTxtOldUnchanged
    && applyRenamePyToTxtNewAbsent
    && applyRenamePyToTxtResponseClean;
  assert.equal(applyRenamePyToTxtAtomic, true, 'MCP .py-to-.txt apply_patch rename was not atomically rejected');
  expectNoHostileResponseFields(blockedApplyRenamePyToTxt, applyRenameHostileLiterals, 'MCP .py-to-.txt apply_patch rename');
  await writeRawArtifact(rawArtifactDir, 'apply-rename-py-to-txt-rejected', blockedApplyRenamePyToTxt);

  // A real Git hunk can contain payload lines whose first characters look
  // exactly like unified-diff file headers. Those payload bytes must not alter
  // the ordered side paths or parser trust, and the underlying Git line counts
  // must remain unchanged.
  const headerPayloadPath = 'header-payload.py';
  await fs.writeFile(
    path.join(tmp, headerPayloadPath),
    mcpHeaderPayloadSource.replace('-- old_marker', '++ new_marker'),
    'utf8'
  );
  const headerPayloadDiff = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, path: headerPayloadPath, include_diff: true }
  }), 'header-shaped hunk payload git_diff');
  const headerPayloadNumstat = spawnSync('git', ['diff', '--numstat', '--', headerPayloadPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(headerPayloadNumstat.status, 0, `header-shaped hunk payload numstat failed: ${headerPayloadNumstat.stderr || headerPayloadNumstat.stdout}`);
  const [headerPayloadAdditions, headerPayloadDeletions] = headerPayloadNumstat.stdout.trim().split(/\s+/u).slice(0, 2).map(Number);
  assert.deepEqual([headerPayloadAdditions, headerPayloadDeletions], [1, 1], 'header-shaped hunk payload changed raw Git numstat');
  const headerPayloadText = resultText(headerPayloadDiff);
  const headerPayloadTokenRaw = headerPayloadText.includes('    token: Token[MCP_HEADER_LITERAL]');
  const headerPayloadLinesRaw = headerPayloadText.includes('--- old_marker')
    && headerPayloadText.includes('+++ new_marker');
  assert.equal(headerPayloadTokenRaw, true, 'header-shaped hunk payload redacted lawful Python context');
  assert.equal(headerPayloadLinesRaw, true, 'header-shaped hunk payload was not emitted by real Git');
  // The existing Git response counter intentionally excludes lines beginning
  // with `+++`/`---`, even when those prefixes belong to hunk payload. Keep
  // that producer/stat contract stable while proving the raw lines survived.
  assert.equal(headerPayloadDiff.structuredContent.additions, 0, 'header-shaped hunk payload changed Git addition stats');
  assert.equal(headerPayloadDiff.structuredContent.deletions, 0, 'header-shaped hunk payload changed Git deletion stats');
  await writeRawArtifact(rawArtifactDir, 'header-shaped-hunk-payload-git-diff', headerPayloadDiff);

  // Exercise a path-scoped cross-extension rename below a directory whose
  // name itself ends in `.py`. The scoped argument must reach Git, while each
  // real old/new side still consults its own path extension.
  const scopedRenameOldPath = 'scope.py/old.txt';
  const scopedRenameNewPath = 'scope.py/new.py';
  await fs.rename(path.join(tmp, scopedRenameOldPath), path.join(tmp, scopedRenameNewPath));
  await fs.writeFile(
    path.join(tmp, scopedRenameNewPath),
    mcpScopedTxtSource.replace('MCP_SCOPED_OLD_LITERAL', 'MCP_SCOPED_NEW_LITERAL'),
    'utf8'
  );
  const scopedRenameConfig = spawnSync('git', ['config', 'diff.renames', 'true'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(scopedRenameConfig.status, 0, `scoped rename detection setup failed: ${scopedRenameConfig.stderr || scopedRenameConfig.stdout}`);
  const scopedRenameStage = spawnSync('git', ['add', '-A', '--', 'scope.py'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(scopedRenameStage.status, 0, `scoped cross-extension rename staging failed: ${scopedRenameStage.stderr || scopedRenameStage.stdout}`);
  const scopedCrossExtensionDiff = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, path: 'scope.py', staged: true, include_diff: true }
  }), 'scoped cross-extension rename git_diff');
  const scopedCrossExtensionText = resultText(scopedCrossExtensionDiff);
  const scopedOldTextRaw = scopedCrossExtensionText.includes('-    token: Token[MCP_SCOPED_OLD_LITERAL]');
  const scopedOldTextMarker = scopedCrossExtensionText.includes('-    token: [REDACTED_SECRET]');
  const scopedNewPythonRaw = scopedCrossExtensionText.includes('+    token: Token[MCP_SCOPED_NEW_LITERAL]');
  assert.equal(scopedCrossExtensionText.includes('rename from scope.py/old.txt'), true, 'scoped cross-extension rename omitted old metadata');
  assert.equal(scopedCrossExtensionText.includes('rename to scope.py/new.py'), true, 'scoped cross-extension rename omitted new metadata');
  assert.equal(scopedOldTextRaw, false, 'scoped cross-extension rename preserved non-Python old-side bytes');
  assert.equal(scopedOldTextMarker, true, 'scoped cross-extension rename omitted old-side redaction');
  assert.equal(scopedNewPythonRaw, true, 'scoped cross-extension rename lost Python new-side bytes');
  await writeRawArtifact(rawArtifactDir, 'scoped-cross-extension-rename-git-diff', scopedCrossExtensionDiff);

  // Exercise actual git diff/show_changes producers with a mixed tracked
  // result. The Python hunk keeps its parser-lawful source bytes while the
  // same-looking non-Python hunk is redacted from each per-header block.
  const trackedPythonBefore = await fs.readFile(path.join(tmp, 'looks-python.py'), 'utf8');
  const trackedTextBefore = await fs.readFile(path.join(tmp, 'looks-python.txt'), 'utf8');
  await fs.writeFile(path.join(tmp, 'looks-python.py'), `${trackedPythonBefore}class GitDiffLawful:\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n`, 'utf8');
  await fs.writeFile(path.join(tmp, 'looks-python.txt'), `${trackedTextBefore}class R:\n    token: Token[ACTUAL_LITERAL_SECRET_7X9]\n`, 'utf8');
  const scopedGitDiff = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, path: 'looks-python.py', include_diff: true }
  }), 'scoped Python git_diff');
  assert.equal(scopedGitDiff.structuredContent.diff.includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'scoped Python git_diff lost lawful source bytes');
  assert.equal(resultText(scopedGitDiff).includes('ACTUAL_LITERAL_SECRET_7X9'), true, 'scoped Python git_diff content diff was re-redacted');
  const mixedGitDiff = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, include_diff: true }
  }), 'mixed repo-wide git_diff');
  const mixedGitText = resultText(mixedGitDiff);
  assert.equal(mixedGitText.includes('+++ b/looks-python.py'), true, 'repo-wide git_diff omitted Python header');
  assert.equal(mixedGitText.includes('+++ b/looks-python.txt'), true, 'repo-wide git_diff omitted non-Python header');
  assert.match(mixedGitText, /\+    token: Token\[ACTUAL_LITERAL_SECRET_7X9\]/u, 'repo-wide git_diff changed lawful Python hunk');
  const mixedTextHeader = mixedGitText.indexOf('+++ b/looks-python.txt');
  const mixedTextEnd = mixedGitText.indexOf('diff --git ', mixedTextHeader + 1);
  const mixedTextBlock = mixedGitText.slice(mixedTextHeader, mixedTextEnd < 0 ? undefined : mixedTextEnd);
  assert.equal(mixedTextBlock.includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'repo-wide git_diff leaked non-Python hunk');
  assert.equal(mixedTextBlock.includes('[REDACTED_SECRET]'), true, 'repo-wide git_diff omitted non-Python redaction marker');
  const shownChanges = assertToolSuccess(await client.request('tools/call', {
    name: 'show_changes',
    arguments: { workspace_id: workspaceId, include_diff: true, since: 'workspace', mark_reviewed: false }
  }), 'mixed repo-wide show_changes');
  const shownText = resultText(shownChanges);
  assert.match(shownText, /\+    token: Token\[ACTUAL_LITERAL_SECRET_7X9\]/u, 'show_changes changed lawful Python hunk');
  const shownTextHeader = shownText.indexOf('+++ b/looks-python.txt');
  const shownTextEnd = shownText.indexOf('diff --git ', shownTextHeader + 1);
  const shownTextBlock = shownText.slice(shownTextHeader, shownTextEnd < 0 ? undefined : shownTextEnd);
  assert.equal(shownTextBlock.includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'show_changes leaked non-Python hunk');
  assert.equal(shownTextBlock.includes('[REDACTED_SECRET]'), true, 'show_changes omitted non-Python redaction marker');

  // Exercise actual Git rename/copy producers through MCP. The redaction
  // callback must consult Git's old/new side paths independently; configure
  // copy detection for this isolated fixture so both metadata directions are
  // emitted by the real producer. Path-scoped Git coverage is exercised by
  // the preceding mixed-route assertions.
  const gitConfigCopies = spawnSync('git', ['config', 'diff.renames', 'copies'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(gitConfigCopies.status, 0, `git copy detection setup failed: ${gitConfigCopies.stderr || gitConfigCopies.stdout}`);

  const renameTxtPath = 'mcp-rename.txt';
  const renameTxtToPyDestinationPath = 'mcp-rename-renamed.py';
  await fs.rename(path.join(tmp, renameTxtPath), path.join(tmp, renameTxtToPyDestinationPath));
  const renameTxtToPySource = mcpRouteTxtSource.replace('MCP_ROUTE_TXT_LITERAL', 'MCP_ROUTE_TXT_RENAMED_LITERAL');
  await fs.writeFile(path.join(tmp, renameTxtToPyDestinationPath), renameTxtToPySource, 'utf8');
  const renameTxtToPyStage = spawnSync('git', ['add', '-A', '--', renameTxtPath, renameTxtToPyDestinationPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(renameTxtToPyStage.status, 0, `MCP .txt-to-.py rename staging failed: ${renameTxtToPyStage.stderr || renameTxtToPyStage.stdout}`);
  const renameTxtToPy = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, staged: true, include_diff: true }
  }), 'MCP .txt-to-.py rename git_diff');
  const renameTxtToPyText = resultText(renameTxtToPy);
  const renameTxtToPyOldRaw = renameTxtToPyText.includes('-    token: Token[MCP_ROUTE_TXT_LITERAL]');
  const renameTxtToPyNewRaw = renameTxtToPyText.includes('+    token: Token[MCP_ROUTE_TXT_RENAMED_LITERAL]');
  assert.equal(renameTxtToPyText.includes('rename from mcp-rename.txt'), true, 'MCP .txt-to-.py rename omitted old metadata');
  assert.equal(renameTxtToPyText.includes('rename to mcp-rename-renamed.py'), true, 'MCP .txt-to-.py rename omitted new metadata');
  assert.equal(renameTxtToPyOldRaw, false, 'MCP .txt-to-.py rename preserved non-Python old-side bytes');
  assert.equal(renameTxtToPyNewRaw, true, 'MCP .txt-to-.py rename lost Python new-side bytes');
  const renameTxtToPyShown = assertToolSuccess(await client.request('tools/call', {
    name: 'show_changes',
    arguments: { workspace_id: workspaceId, staged: true, include_diff: true, since: 'workspace', mark_reviewed: false }
  }), 'MCP .txt-to-.py rename show_changes');
  const renameTxtToPyShownText = resultText(renameTxtToPyShown);
  const renameTxtToPyShownNewRaw = renameTxtToPyShownText.includes('+    token: Token[MCP_ROUTE_TXT_RENAMED_LITERAL]');
  assert.equal(renameTxtToPyShownNewRaw, true, 'show_changes did not inherit .txt-to-.py side routing');

  const renamePySourcePath = 'mcp-rename.py';
  const renameTxtDestinationPath = 'mcp-rename-renamed.txt';
  await fs.rename(path.join(tmp, renamePySourcePath), path.join(tmp, renameTxtDestinationPath));
  const renamePyToTxtSource = mcpRoutePySource.replace('MCP_ROUTE_PY_LITERAL', 'MCP_ROUTE_PY_RENAMED_LITERAL');
  await fs.writeFile(path.join(tmp, renameTxtDestinationPath), renamePyToTxtSource, 'utf8');
  const renamePyToTxtStage = spawnSync('git', ['add', '-A', '--', renamePySourcePath, renameTxtDestinationPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(renamePyToTxtStage.status, 0, `MCP .py-to-.txt rename staging failed: ${renamePyToTxtStage.stderr || renamePyToTxtStage.stdout}`);
  const renamePyToTxt = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, staged: true, include_diff: true }
  }), 'MCP .py-to-.txt rename git_diff');
  const renamePyToTxtText = resultText(renamePyToTxt);
  const renamePyToTxtOldRaw = renamePyToTxtText.includes('-    token: Token[MCP_ROUTE_PY_LITERAL]');
  const renamePyToTxtNewRaw = renamePyToTxtText.includes('+    token: Token[MCP_ROUTE_PY_RENAMED_LITERAL]');
  const renamePyToTxtNewMarker = renamePyToTxtText.includes('+    token: [REDACTED_SECRET]');
  assert.equal(renamePyToTxtText.includes(`rename from ${renamePySourcePath}`), true, 'MCP .py-to-.txt rename omitted old metadata');
  assert.equal(renamePyToTxtText.includes('rename to mcp-rename-renamed.txt'), true, 'MCP .py-to-.txt rename omitted new metadata');
  assert.equal(renamePyToTxtOldRaw, true, 'MCP .py-to-.txt rename lost Python old-side bytes');
  assert.equal(renamePyToTxtNewRaw, false, 'MCP .py-to-.txt rename preserved non-Python new-side bytes');
  assert.equal(renamePyToTxtNewMarker, true, 'MCP .py-to-.txt rename omitted new-side redaction');

  const copyTxtToPyPath = 'mcp-copy.txt';
  const copyPyDestinationPath = 'mcp-copy-destination.py';
  await fs.copyFile(path.join(tmp, copyTxtToPyPath), path.join(tmp, copyPyDestinationPath));
  const copyTxtToPySource = mcpCopyTxtSource.replace('MCP_ROUTE_TXT_LITERAL', 'MCP_ROUTE_TXT_COPIED_LITERAL');
  await fs.writeFile(path.join(tmp, copyPyDestinationPath), copyTxtToPySource, 'utf8');
  await fs.writeFile(path.join(tmp, copyTxtToPyPath), mcpCopyTxtSource.replace('MCP_ROUTE_TXT_LITERAL', 'MCP_ROUTE_TXT_SOURCE_CHANGED_LITERAL'), 'utf8');
  const copyTxtToPyStage = spawnSync('git', ['add', '--', copyTxtToPyPath, copyPyDestinationPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(copyTxtToPyStage.status, 0, `MCP .txt-to-.py copy staging failed: ${copyTxtToPyStage.stderr || copyTxtToPyStage.stdout}`);
  const copyTxtToPy = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, staged: true, include_diff: true }
  }), 'MCP .txt-to-.py copy git_diff');
  const copyTxtToPyText = resultText(copyTxtToPy);
  const copyTxtToPyOldRaw = copyTxtToPyText.includes('-    token: Token[MCP_ROUTE_TXT_LITERAL]');
  const copyTxtToPyNewRaw = copyTxtToPyText.includes('+    token: Token[MCP_ROUTE_TXT_COPIED_LITERAL]');
  assert.equal(copyTxtToPyText.includes('copy from mcp-copy.txt'), true, 'MCP .txt-to-.py copy omitted old metadata');
  assert.equal(copyTxtToPyText.includes('copy to mcp-copy-destination.py'), true, 'MCP .txt-to-.py copy omitted new metadata');
  assert.equal(copyTxtToPyOldRaw, false, 'MCP .txt-to-.py copy preserved non-Python old-side bytes');
  assert.equal(copyTxtToPyNewRaw, true, 'MCP .txt-to-.py copy lost Python new-side bytes');

  const copyPyToTxtPath = 'mcp-copy.py';
  const copyTxtDestinationPath = 'mcp-copy-destination.txt';
  await fs.copyFile(path.join(tmp, copyPyToTxtPath), path.join(tmp, copyTxtDestinationPath));
  const copyPyToTxtSource = mcpCopyPySource.replace('MCP_ROUTE_PY_LITERAL', 'MCP_ROUTE_PY_COPIED_LITERAL');
  await fs.writeFile(path.join(tmp, copyTxtDestinationPath), copyPyToTxtSource, 'utf8');
  await fs.writeFile(path.join(tmp, copyPyToTxtPath), mcpCopyPySource.replace('MCP_ROUTE_PY_LITERAL', 'MCP_ROUTE_PY_SOURCE_CHANGED_LITERAL'), 'utf8');
  const copyPyToTxtStage = spawnSync('git', ['add', '--', copyPyToTxtPath, copyTxtDestinationPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(copyPyToTxtStage.status, 0, `MCP .py-to-.txt copy staging failed: ${copyPyToTxtStage.stderr || copyPyToTxtStage.stdout}`);
  const copyPyToTxt = assertToolSuccess(await client.request('tools/call', {
    name: 'git_diff',
    arguments: { workspace_id: workspaceId, staged: true, include_diff: true }
  }), 'MCP .py-to-.txt copy git_diff');
  const copyPyToTxtText = resultText(copyPyToTxt);
  const copyPyToTxtOldRaw = copyPyToTxtText.includes('-    token: Token[MCP_ROUTE_PY_LITERAL]');
  const copyPyToTxtNewRaw = copyPyToTxtText.includes('+    token: Token[MCP_ROUTE_PY_COPIED_LITERAL]');
  const copyPyToTxtNewMarker = copyPyToTxtText.includes('+    token: [REDACTED_SECRET]');
  assert.equal(copyPyToTxtText.includes('copy from mcp-copy.py'), true, 'MCP .py-to-.txt copy omitted old metadata');
  assert.equal(copyPyToTxtText.includes('copy to mcp-copy-destination.txt'), true, 'MCP .py-to-.txt copy omitted new metadata');
  assert.equal(copyPyToTxtOldRaw, true, 'MCP .py-to-.txt copy lost Python old-side bytes');
  assert.equal(copyPyToTxtNewRaw, false, 'MCP .py-to-.txt copy preserved non-Python new-side bytes');
  assert.equal(copyPyToTxtNewMarker, true, 'MCP .py-to-.txt copy omitted new-side redaction');

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

  console.log(`source-redaction-smoke: PASS (real MCP read/search/read_many; ranged lawful/hostile/private and byte-limit coverage; ${negativePaths.length} negative fixtures; write/edit/apply_patch compatibility)`);
} finally {
  client?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
