import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const {
  hasSecretValue,
  hasSecretValueInUnifiedDiff,
  extractDiffFileBlocks,
  redactDiagnosticText,
  redactSearchQuery,
  redactSensitiveText,
  redactSensitiveTextPreservingLines,
  redactUnifiedDiff
} = await import('../dist/redact.js');
const { createPythonProvenance } = await import('../scripts/python-provenance.mjs');
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

function assertPythonAstRejected(source, label) {
  const result = spawnSync(
    'python3',
    ['-c', 'import ast, sys; ast.parse(sys.stdin.read(), filename="fixture.py", mode="exec")'],
    { input: source, encoding: 'utf8' }
  );
  assert.notEqual(result.status, 0, `${label} unexpectedly parsed as valid Python`);
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

const pythonReturnAnnotationLawful = [
  'def campaign_head() -> CampaignHeadToken:',
  '    return CampaignHeadToken("harmless")',
  ''
].join('\n');

const pythonReturnAnnotationCredentialField = [
  'def campaign_head() -> CampaignHeadToken:',
  '    API_TOKEN: "QZ7"',
  '    return CampaignHeadToken("harmless")',
  ''
].join('\n');

const pythonMultilineCredentialAssignment = [
  'API_TOKEN = (',
  '    "QZ7"',
  ')',
  ''
].join('\n');

const pythonMultilineCredentialField = [
  'config = {',
  '    API_TOKEN:',
  '        "QZ7"',
  '}',
  ''
].join('\n');

const pythonMalformedReturnAnnotation = [
  'def campaign_head() -> CampaignHeadToken:',
  '    return CampaignHeadToken("harmless")',
  '  unexpected_indent = 1',
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
assertPythonAstAccepted(pythonReturnAnnotationLawful, 'Python function return annotation fixture');
assertPythonParserAccepted(pythonReturnAnnotationLawful, 'Python function return annotation fixture');
assert.equal(redactSensitiveText(pythonReturnAnnotationLawful, pythonPolicy), pythonReturnAnnotationLawful, 'Python function return annotation changed source bytes');
assert.equal(hasSecretValue(pythonReturnAnnotationLawful, pythonPolicy), false, 'Python function return annotation was classified as hostile');

assertPythonAstAccepted(pythonReturnAnnotationCredentialField, 'Python return annotation credential-field fixture');
assert.equal(hasSecretValue(pythonReturnAnnotationCredentialField, pythonPolicy), true, 'credential field after Python return annotation escaped detection');
const pythonReturnAnnotationCredentialFieldRedacted = redactSensitiveText(pythonReturnAnnotationCredentialField, pythonPolicy);
assert.equal(pythonReturnAnnotationCredentialFieldRedacted.includes('QZ7'), false, 'credential field after Python return annotation leaked its synthetic value');
assert.equal(pythonReturnAnnotationCredentialFieldRedacted.includes('[REDACTED_SECRET]'), true, 'credential field after Python return annotation omitted the redaction marker');

for (const [label, source] of [
  ['multiline assignment', pythonMultilineCredentialAssignment],
  ['multiline field', pythonMultilineCredentialField]
]) {
  assertPythonAstAccepted(source, `Python ${label} credential fixture`);
  assertPythonParserAccepted(source, `Python ${label} credential fixture`);
  const redacted = redactSensitiveText(source, pythonPolicy);
  assert.equal(hasSecretValue(source, pythonPolicy), true, `Python ${label} credential was not classified as hostile`);
  assert.equal(redacted.includes('QZ7'), false, `Python ${label} credential leaked its synthetic value`);
  assert.equal(redacted.includes('[REDACTED_SECRET]'), true, `Python ${label} credential omitted the redaction marker`);
}

assert.equal(hasSecretValue(pythonMalformedReturnAnnotation, pythonPolicy), true, 'malformed Python return annotation received syntax ownership');
const pythonMalformedReturnAnnotationRedacted = redactSensitiveText(pythonMalformedReturnAnnotation, pythonPolicy);
assert.notEqual(pythonMalformedReturnAnnotationRedacted, pythonMalformedReturnAnnotation, 'malformed Python return annotation bypassed fail-closed redaction');
assert.equal(pythonMalformedReturnAnnotationRedacted.includes('[REDACTED_SECRET]'), true, 'malformed Python return annotation omitted the fail-closed marker');
assertPythonAstRejected(pythonMalformedReturnAnnotation, 'malformed Python return annotation fixture');

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

const pythonCallKeywordFailures = [];
let pythonCallKeywordCheckCount = 0;
function checkPythonCallKeyword(label, callback) {
  pythonCallKeywordCheckCount += 1;
  try {
    callback();
    console.log(`PASS Python call-keyword ${label}`);
  } catch (error) {
    pythonCallKeywordFailures.push(`${label}: ${error?.message ?? String(error)}`);
    console.log(`FAIL Python call-keyword ${label}: ${error?.message ?? String(error)}`);
  }
}
async function checkPythonCallKeywordAsync(label, callback) {
  pythonCallKeywordCheckCount += 1;
  try {
    await callback();
    console.log(`PASS Python call-keyword ${label}`);
  } catch (error) {
    pythonCallKeywordFailures.push(`${label}: ${error?.message ?? String(error)}`);
    console.log(`FAIL Python call-keyword ${label}: ${error?.message ?? String(error)}`);
  }
}
function assertPythonCallKeywordAllowed(label, source) {
  assertPythonParserAccepted(source, label);
  assert.equal(hasSecretValue(source, pythonPolicy), false, `${label} was classified as hostile`);
  assert.equal(redactSensitiveText(source, pythonPolicy), source, `${label} changed source bytes`);
}
function assertPythonCallKeywordDenied(label, source, rawMarker = undefined, syntaxValid = true) {
  if (syntaxValid) assertPythonParserAccepted(source, label);
  assert.equal(hasSecretValue(source, pythonPolicy), true, `${label} was not classified as hostile`);
  const projection = redactSensitiveText(source, pythonPolicy);
  if (rawMarker) assert.equal(projection.includes(rawMarker), false, `${label} leaked its synthetic marker`);
}
const pythonCallKeywordReference = [
  'def run(token_ref, work_ref, client):',
  '    send(token=token_ref, work_token=work_ref, state=client.session.state)',
  ''
].join('\n');
const pythonCallKeywordMultilineLf = [
  'send(',
  '    token=token_ref,',
  '    work_token=client.session.state,',
  ')',
  ''
].join('\n');
const pythonCallKeywordMultilineCrlf = pythonCallKeywordMultilineLf.replaceAll('\n', '\r\n');
const pythonCallKeywordReturnComposition = [
  'def run(token_ref: Token) -> Result:',
  '    send(token=token_ref, work_token=client.session.state)',
  ''
].join('\n');
const pythonCallKeywordTypedReference = [
  '# marker: before',
  'def run(authorization: Mapping[str, Any] | None = None):',
  '    if invalid or pending_status is not None or token:',
  '        raise LaneOperationError("not ready")',
  '    authorization: Mapping[str, Any] | None = None',
  '    send(token=authorization, work_token=authorization)',
  ''
].join('\n');
const pythonCallKeywordSyntheticCredential = ['ghp_', 'A'.repeat(24)].join('');
const pythonCallKeywordMalformedAnnotationSource = [
  'send(token=reference)',
  'def run(authorization: Mapping[str, Any] | None ='
].join('\n');
const pythonCallKeywordMalformedControlSource = [
  'send(token=reference)',
  'if invalid or pending_status is not None or token',
  '    raise LaneOperationError("not ready")'
].join('\n');
const pythonCallKeywordTypedHostileSource = [
  '# marker: before',
  'def run(authorization: Mapping[str, Any] | None = None):',
  '    if invalid or pending_status is not None or token:',
  '        raise LaneOperationError("not ready")',
  `    headers = {"Authorization": "Bearer ${pythonCallKeywordSyntheticCredential}"}`,
  '    send(token=authorization)',
  ''
].join('\n');
const pythonCallKeywordMarker = 'QZ7';
const pythonCallKeywordPositiveCases = [
  ['noncredential helper keyword', 'helper(timeout=timeout_value)\n'],
  ['variable and dotted references', pythonCallKeywordReference],
  ['multiline LF references', pythonCallKeywordMultilineLf],
  ['multiline CRLF references', pythonCallKeywordMultilineCrlf],
  ['return annotation composition', pythonCallKeywordReturnComposition],
  ['mapping annotations with None and reference values', pythonCallKeywordTypedReference]
];
for (const [label, source] of pythonCallKeywordPositiveCases) {
  checkPythonCallKeyword(label, () => assertPythonCallKeywordAllowed(label, source));
}
const pythonCallKeywordHostileCases = [
  ['None keyword value is not a reference', 'send(token=None)\n'],
  ['string keyword value is not a reference', 'send(token="safe")\n'],
  ['generic-root attribute concatenation', 'send(token=config.token + suffix)\n'],
  ['environment attribute concatenation', 'send(token=os.environ.token + suffix)\n'],
  ['concatenated reference', 'send(token=client.session.token_ref + suffix)\n'],
  ['indexed reference', 'send(token=client.session.token_refs[0])\n'],
  ['called reference', 'send(token=client.get_token())\n'],
  ['parenthesized reference', 'send(token=(token_ref))\n'],
  ['string reference', `send(token="${pythonCallKeywordMarker}")\n`],
  ['nested hostile call', `outer(token=token_ref, extra=inner(password="${pythonCallKeywordMarker}"))\n`],
  ['safe reference with hostile sibling', `send(token=token_ref, password="${pythonCallKeywordMarker}")\n`],
  ['whole-file hostile match after safe call', `send(token=token_ref)\npassword = "${pythonCallKeywordMarker}"\n`],
  ['credential-shaped root in keyword value', `send(token=${pythonCallKeywordSyntheticCredential})\n`, pythonCallKeywordSyntheticCredential],
  ['credential-shaped attribute in keyword value', `send(token=provider.${pythonCallKeywordSyntheticCredential})\n`, pythonCallKeywordSyntheticCredential],
  ['credential-shaped root outside keyword', `credential = ${pythonCallKeywordSyntheticCredential}\n`, pythonCallKeywordSyntheticCredential],
  ['credential-shaped attribute outside keyword', `credential = provider.${pythonCallKeywordSyntheticCredential}\n`, pythonCallKeywordSyntheticCredential],
  ['return annotation followed by hostile field', `def run() -> Result:\n    password: str = "${pythonCallKeywordMarker}"\n`],
  ['return annotation followed by hostile assignment', `def run() -> Result:\n    client.password = "${pythonCallKeywordMarker}"\n`]
];
for (const [label, source, marker = pythonCallKeywordMarker] of pythonCallKeywordHostileCases) {
  checkPythonCallKeyword(label, () => assertPythonCallKeywordDenied(label, source, marker));
}
for (const [label, source] of [
  ['credential-shaped type identifier', `def run(value: Mapping[${pythonCallKeywordSyntheticCredential}, str] | None = None):\n    pass\n`],
  ['credential-bearing authorization header after safe call', `send(token=reference)\nheaders = {"Authorization": "Bearer ${pythonCallKeywordSyntheticCredential}"}\n`],
  ['credential-bearing authorization default', `def run(headers={"Authorization": "Bearer ${pythonCallKeywordSyntheticCredential}"}):\n    pass\n`],
  ['credential-bearing nested dictionary call', `send(token=provider.forward({"Authorization": "Bearer ${pythonCallKeywordSyntheticCredential}"}))\n`],
  ['credential field after token guard suite', `if invalid or pending_status is not None or token:\n    raise LaneOperationError("not ready")\ncredentials = {"token": "${pythonCallKeywordSyntheticCredential}"}\n`]
]) {
  checkPythonCallKeyword(label, () => assertPythonCallKeywordDenied(label, source, pythonCallKeywordSyntheticCredential));
}
checkPythonCallKeyword('malformed mapping annotation remains refused', () => {
  const source = pythonCallKeywordMalformedAnnotationSource;
  assertPythonAstRejected(source, 'malformed mapping annotation with safe keyword candidate');
  assertPythonCallKeywordDenied('malformed mapping annotation with safe keyword candidate', source, undefined, false);
});
checkPythonCallKeyword('malformed control syntax with safe keyword candidate remains refused', () => {
  assertPythonAstRejected(pythonCallKeywordMalformedControlSource, 'malformed control syntax with safe keyword candidate');
  assertPythonCallKeywordDenied('malformed control syntax with safe keyword candidate', pythonCallKeywordMalformedControlSource, undefined, false);
});
for (const [label, source] of [
  ['malformed LF call', 'send(token=token_ref, password=)\n'],
  ['malformed CRLF call', 'send(token=token_ref, password=)\r\n']
]) {
  checkPythonCallKeyword(label, () => {
    assertPythonAstRejected(source, label);
    assertPythonCallKeywordDenied(label, source, undefined, false);
  });
}
checkPythonCallKeyword('mixed diff sides preserve language agreement', () => {
  const mixedReferenceDiff = [
    'diff --git a/old.txt b/new.py',
    '--- a/old.txt',
    '+++ b/new.py',
    '@@ -1 +1 @@',
    '-send(token="QZ7")',
    '+send(token=token_ref)',
    ''
  ].join('\n');
  assert.equal(hasSecretValueInUnifiedDiff(mixedReferenceDiff), true, 'non-Python old side was not classified as hostile');
  const projection = redactUnifiedDiff(mixedReferenceDiff);
  assert.equal(projection.includes('-send(token="QZ7")'), false, 'non-Python old side leaked its synthetic marker');
  assert.equal(projection.includes('+send(token=token_ref)'), true, 'Python new side lost lawful reference bytes');
});

const multilineHostileAliasDiff = [
  'diff --git a/multiline.py b/multiline.py',
  '--- a/multiline.py',
  '+++ b/multiline.py',
  '@@ -1,1 +1,2 @@',
  ' class R:',
  '+    payload = {password: ACTUAL_LITERAL_SECRET_7X9}',
  ''
].join('\n');
const multilineHostileAliasDiffRedacted = [
  'diff --git a/multiline.py b/multiline.py',
  '--- a/multiline.py',
  '+++ b/multiline.py',
  '@@ -1,1 +1,2 @@',
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
const sideRoutingCopyTxtToPy = sideRoutingTxtToPy
  .replaceAll('rename from', 'copy from')
  .replaceAll('rename to', 'copy to');
const sideRoutingCopyPyToTxt = sideRoutingPyToTxt
  .replaceAll('rename from', 'copy from')
  .replaceAll('rename to', 'copy to');
const sideRoutingCreateTxt = sideRoutingCreate
  .replaceAll('side-created.py', 'side-created.txt')
  .replaceAll('SIDE_CREATED_LITERAL', 'SIDE_CREATED_TEXT_LITERAL');
const sideRoutingDeleteTxt = sideRoutingDelete
  .replaceAll('side-deleted.py', 'side-deleted.txt')
  .replaceAll('SIDE_DELETED_LITERAL', 'SIDE_DELETED_TEXT_LITERAL');
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
function diffSideLanguages(source) {
  const provenance = createPythonProvenance(source, { language: 'python' });
  return {
    available: provenance.available,
    languages: provenance.segments.flatMap((segment) => (segment.sides ?? []).map((side) => side.language))
  };
}

function assertValidDiffSideAuthority(label, source, expectedPaths, expectedLanguages, expectedAvailable) {
  const blocks = extractDiffFileBlocks(source);
  assert.equal(blocks.length, 1, `${label} changed canonical block count`);
  assert.equal(blocks[0].pathDiscoveryValid, true, `${label} lost valid block authority`);
  assert.deepEqual(blocks[0].paths, expectedPaths, `${label} changed canonical paths`);
  assert.deepEqual(diffSideLanguages(source), {
    available: expectedAvailable,
    languages: expectedLanguages
  }, `${label} changed side-specific Python provenance`);
}

assertValidDiffSideAuthority('txt-to-py mirror', sideRoutingTxtToPy, ['side-old.txt', 'side-new.py'], [undefined, 'python'], true);
assertValidDiffSideAuthority('py-to-txt mirror', sideRoutingPyToTxt, ['side-old.py', 'side-new.txt'], ['python', undefined], true);
assertValidDiffSideAuthority('copy txt-to-py', sideRoutingCopyTxtToPy, ['side-old.txt', 'side-new.py'], [undefined, 'python'], true);
assertValidDiffSideAuthority('copy py-to-txt', sideRoutingCopyPyToTxt, ['side-old.py', 'side-new.txt'], ['python', undefined], true);
assertValidDiffSideAuthority('dev-null to new.py', sideRoutingCreate, ['side-created.py'], [undefined, 'python'], true);
assertValidDiffSideAuthority('old.py to dev-null', sideRoutingDelete, ['side-deleted.py'], ['python', undefined], true);
assertValidDiffSideAuthority('dev-null to new.txt', sideRoutingCreateTxt, ['side-created.txt'], [undefined, undefined], false);
assertValidDiffSideAuthority('old.txt to dev-null', sideRoutingDeleteTxt, ['side-deleted.txt'], [undefined, undefined], false);
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
assert.equal(contradictoryNewBytesPresent, false, 'contradictory old-side metadata left block-level new-side parser provenance enabled');
assert.deepEqual(diffSideLanguages(contradictorySideMetadata), {
  available: false,
  languages: [undefined, undefined]
}, 'contradictory old-side metadata retained Python provenance on one side');

const mixedInvalidBlock = contradictorySideMetadata
  .replaceAll('SIDE_OLD_LITERAL', 'MIXED_INVALID_OLD_LITERAL')
  .replaceAll('SIDE_NEW_LITERAL', 'MIXED_INVALID_NEW_LITERAL');
const mixedValidBlock = sideRoutingPyToTxt
  .replaceAll('SIDE_OLD_LITERAL', 'MIXED_VALID_OLD_LITERAL')
  .replaceAll('SIDE_NEW_LITERAL', 'MIXED_VALID_NEW_LITERAL');
const mixedInvalidAndValid = `${mixedInvalidBlock}${mixedValidBlock}`;
const mixedInvalidAndValidBlocks = extractDiffFileBlocks(mixedInvalidAndValid);
assert.equal(mixedInvalidAndValidBlocks.length, 2, 'mixed invalid/valid patch changed canonical block count');
assert.equal(mixedInvalidAndValidBlocks[0].pathDiscoveryValid, false, 'mixed invalid block granted path authority');
assert.deepEqual(mixedInvalidAndValidBlocks[0].paths, [], 'mixed invalid block exposed paths');
assert.equal(mixedInvalidAndValidBlocks[1].pathDiscoveryValid, true, 'mixed valid block lost independent path authority');
assert.deepEqual(mixedInvalidAndValidBlocks[1].paths, ['side-old.py', 'side-new.txt'], 'mixed valid block changed lawful paths');
const mixedInvalidAndValidProvenance = createPythonProvenance(mixedInvalidAndValid, { language: 'python' });
assert.deepEqual(mixedInvalidAndValidProvenance.segments.map((segment) => (segment.sides ?? []).map((side) => side.language)), [
  [undefined, undefined],
  ['python', undefined]
], 'mixed invalid/valid provenance did not isolate block-level authority');
const mixedInvalidAndValidOutput = redactUnifiedDiff(mixedInvalidAndValid);
assert.equal(mixedInvalidAndValidOutput.includes('MIXED_INVALID_OLD_LITERAL'), false, 'mixed invalid old side leaked parser-sensitive bytes');
assert.equal(mixedInvalidAndValidOutput.includes('MIXED_INVALID_NEW_LITERAL'), false, 'mixed invalid new side leaked parser-sensitive bytes');
assert.equal(mixedInvalidAndValidOutput.includes('MIXED_VALID_OLD_LITERAL'), true, 'mixed valid Python old side lost lawful source fidelity');
assert.equal(mixedInvalidAndValidOutput.includes('MIXED_VALID_NEW_LITERAL'), false, 'mixed valid non-Python new side omitted generic redaction');
assert.equal(hasSecretValueInUnifiedDiff(mixedInvalidAndValid), true, 'mixed invalid/valid classification lost sensitive material');

const unfinishedHunk = [
  'diff --git a/bad.py b/bad.py',
  '--- a/bad.py',
  '+++ b/bad.py',
  '@@ -1,2 +1,2 @@',
  '-one',
  ''
].join('\n');
const unfinishedHunkBlock = extractDiffFileBlocks(unfinishedHunk);
assert.equal(unfinishedHunkBlock.length, 1, 'unfinished EOF hunk changed block count');
assert.equal(unfinishedHunkBlock[0].ambiguous, true, 'unfinished EOF hunk was not marked ambiguous');
assert.equal(unfinishedHunkBlock[0].pathDiscoveryValid, false, 'unfinished EOF hunk granted path discovery');
assert.deepEqual(unfinishedHunkBlock[0].paths, [], 'unfinished EOF hunk exposed a touched path');
const ambiguousPythonPayload = [
  'diff --git a/ambiguous.py b/ambiguous.py',
  '--- a/ambiguous.py',
  '+++ b/ambiguous.py',
  '@@ -1,2 +1,2 @@',
  '+    token: Token[AMBIGUOUS_LITERAL]',
  ''
].join('\n');
const ambiguousPythonOutput = redactUnifiedDiff(ambiguousPythonPayload);
assert.equal(hasSecretValueInUnifiedDiff(ambiguousPythonPayload), true, 'ambiguous Python-looking hunk lost fail-closed classification');
assert.equal(ambiguousPythonOutput.includes('AMBIGUOUS_LITERAL'), false, 'ambiguous Python-looking hunk preserved a raw secret-looking token');
assert.equal(ambiguousPythonOutput.includes('[REDACTED_SECRET]'), true, 'ambiguous Python-looking hunk omitted generic redaction');

function syntheticDiff({
  metadata = [],
  oldHeaders = ['--- a/matrix-old.py'],
  newHeaders = ['+++ b/matrix-new.py'],
  headerOrder,
  hunkHeader = '@@ -1,2 +1,2 @@',
  hunkLines = [
    '-class Matrix:',
    '-    token: Token[MATRIX_LITERAL]',
    '+class Matrix:',
    '+    token: Token[MATRIX_LITERAL]'
  ]
} = {}) {
  const headers = headerOrder ?? [...oldHeaders, ...newHeaders];
  return [
    'diff --git a/matrix-old.py b/matrix-new.py',
    ...metadata,
    ...headers,
    hunkHeader,
    ...hunkLines,
    ''
  ].join('\n');
}

function assertInvalidDiffAuthority(label, source, literal) {
  const blocks = extractDiffFileBlocks(source);
  assert.equal(blocks.length, 1, `${label} changed canonical block count`);
  assert.equal(blocks[0].pathDiscoveryValid, false, `${label} granted block-level path authority`);
  assert.deepEqual(blocks[0].paths, [], `${label} exposed paths despite invalid block authority`);
  const provenance = createPythonProvenance(source, { language: 'python' });
  const sideRecords = provenance.segments.flatMap((segment) => segment.sides ?? []);
  assert.equal(provenance.available, false, `${label} exposed Python provenance availability`);
  assert.equal(sideRecords.length >= 2, true, `${label} omitted old/new provenance sides`);
  assert.equal(sideRecords.every((side) => side.language === undefined && side.parse === undefined), true, `${label} retained parser authority on an invalid side`);
  const redacted = redactUnifiedDiff(source);
  assert.equal(redacted.includes(literal), false, `${label} preserved synthetic sensitive material`);
  assert.equal(redacted.includes('[REDACTED_SECRET]'), true, `${label} omitted generic redaction marker`);
  assert.equal(hasSecretValueInUnifiedDiff(source), true, `${label} lost generic sensitive classification`);
}

const invalidDiffCases = [
  ['conflicting rename-from', syntheticDiff({ metadata: ['rename from matrix-other.py', 'rename to matrix-new.py'] })],
  ['conflicting rename-to', syntheticDiff({ metadata: ['rename from matrix-old.py', 'rename to matrix-other.py'] })],
  ['conflicting copy-from', syntheticDiff({ metadata: ['copy from matrix-other.py', 'copy to matrix-new.py'] })],
  ['conflicting copy-to', syntheticDiff({ metadata: ['copy from matrix-old.py', 'copy to matrix-other.py'] })],
  ['duplicate --- headers', syntheticDiff({ oldHeaders: ['--- a/matrix-old.py', '--- a/duplicate-old.py'] })],
  ['duplicate +++ headers', syntheticDiff({ newHeaders: ['+++ b/matrix-new.py', '+++ b/duplicate-new.py'] })],
  ['reversed header ordering', syntheticDiff({ headerOrder: ['+++ b/matrix-new.py', '--- a/matrix-old.py'] })],
  ['malformed quoted old path', syntheticDiff({ oldHeaders: ['--- "a/matrix-old.py'] })],
  ['malformed quoted new path', syntheticDiff({ newHeaders: ['+++ "b/matrix-new.py'] })],
  ['unfinished hunk', syntheticDiff({ hunkLines: ['-class Matrix:', '-    token: Token[MATRIX_LITERAL]', '+class Matrix:'] })],
  ['malformed hunk counts', syntheticDiff({ hunkHeader: '@@ -1,2 +1,not-a-count @@' })],
  ['already-supported structural ambiguity', ambiguousPythonPayload, 'AMBIGUOUS_LITERAL']
];
for (const [label, source, literal = 'MATRIX_LITERAL'] of invalidDiffCases) {
  assertInvalidDiffAuthority(label, source, literal);
}

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
const mcpHeaderPayloadMirrorSource = [
  'class HeaderPayloadMirror:',
  '    payload = """',
  '-- header-looking.txt',
  '"""',
  ''
].join('\n');
const mcpHeaderPayloadVariantFixtures = [
  {
    path: 'header-payload-relative.py',
    payload: 'relative-looking-text',
    source: ['class HeaderPayloadRelative:', '    payload = """', '-- relative-looking-text', '"""', ''].join('\n')
  },
  {
    path: 'header-payload-absolute.py',
    payload: '/absolute-looking/synthetic/path',
    source: ['class HeaderPayloadAbsolute:', '    payload = """', '-- /absolute-looking/synthetic/path', '"""', ''].join('\n')
  },
  {
    path: 'header-payload-suffix.py',
    payload: 'header-looking.py',
    source: ['class HeaderPayloadSuffixPy:', '    payload = """', '-- header-looking.py', '"""', ''].join('\n')
  },
  {
    path: 'header-payload-suffix.txt',
    payload: 'header-looking.txt',
    source: ['class HeaderPayloadSuffixTxt:', '    payload = """', '-- header-looking.txt', '"""', ''].join('\n')
  }
];
const customPrefixOldPath = 'a/custom-prefix.py';
const customPrefixNewPath = 'b/custom-prefix.py';
const customPrefixOldSource = [
  'class CustomPrefix:',
  '    marker_one = True',
  '    token: Token[CUSTOM_PREFIX_OLD_LITERAL]',
  '    marker_two = True',
  ''
].join('\n');
const customPrefixNewSource = customPrefixOldSource.replace('CUSTOM_PREFIX_OLD_LITERAL', 'CUSTOM_PREFIX_NEW_LITERAL');
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
const pythonReturnAnnotationEditPath = 'python-return-annotation-edit.py';
const pythonReturnAnnotationEditAfter = pythonReturnAnnotationLawful.replace(
  'return CampaignHeadToken("harmless")',
  'return CampaignHeadToken("still_harmless")'
);
const pythonReturnAnnotationCredentialFieldEditPath = 'python-return-annotation-credential-field-edit.py';
const pythonMultilineAssignmentEditPath = 'python-multiline-assignment-edit.py';
const pythonMultilineAssignmentEditBefore = [
  '# marker: before',
  ...pythonMultilineCredentialAssignment.trimEnd().split('\n'),
  ''
].join('\n');
const pythonMultilineFieldEditPath = 'python-multiline-field-edit.py';
const pythonMultilineFieldEditBefore = [
  '# marker: before',
  ...pythonMultilineCredentialField.trimEnd().split('\n'),
  ''
].join('\n');
const pythonMalformedAnnotationEditPath = 'python-malformed-annotation-edit.py';
const pythonCallKeywordWritePath = 'python-call-keyword-write.py';
const pythonCallKeywordReadPath = 'python-call-keyword-read.py';
const pythonCallKeywordReadSource = pythonCallKeywordReference;
const pythonCallKeywordEditPath = 'python-call-keyword-edit.py';
const pythonCallKeywordEditBefore = [
  '# marker: before',
  'def run(token_ref, work_ref):',
  '    send(token=token_ref, work_token=work_ref)',
  ''
].join('\n');
const pythonCallKeywordEditAfter = pythonCallKeywordEditBefore.replace('# marker: before', '# marker: after');
const pythonCallKeywordHostilePath = 'python-call-keyword-hostile.py';
const pythonCallKeywordHostileSource = [
  '# marker: before',
  'def run(token_ref):',
  `    send(token=token_ref, password="${pythonCallKeywordMarker}")`,
  ''
].join('\n');
const pythonCallKeywordTypedPath = 'python-call-keyword-typed.py';
const pythonCallKeywordTypedEditAfter = pythonCallKeywordTypedReference.replace('# marker: before', '# marker: after');
const pythonCallKeywordTypedHostilePath = 'python-call-keyword-typed-hostile.py';
const pythonCallKeywordMalformedAnnotationPath = 'python-call-keyword-malformed-annotation.py';
const pythonCallKeywordMalformedWritePath = 'python-call-keyword-malformed.py';
const pythonCallKeywordMalformedSource = 'send(token=token_ref, password=)\n';

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
  await writeFixture(tmp, pythonReturnAnnotationEditPath, pythonReturnAnnotationLawful);
  await writeFixture(tmp, pythonReturnAnnotationCredentialFieldEditPath, pythonReturnAnnotationCredentialField);
  await writeFixture(tmp, pythonCallKeywordReadPath, pythonCallKeywordReadSource);
  await writeFixture(tmp, pythonCallKeywordEditPath, pythonCallKeywordEditBefore);
  await writeFixture(tmp, pythonCallKeywordHostilePath, pythonCallKeywordHostileSource);
  await writeFixture(tmp, pythonCallKeywordTypedHostilePath, pythonCallKeywordTypedHostileSource);
  await writeFixture(tmp, pythonMultilineAssignmentEditPath, pythonMultilineAssignmentEditBefore);
  await writeFixture(tmp, pythonMultilineFieldEditPath, pythonMultilineFieldEditBefore);
  await writeFixture(tmp, pythonMalformedAnnotationEditPath, pythonMalformedReturnAnnotation);
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
  await writeFixture(tmp, 'header-payload-mirror.txt', mcpHeaderPayloadMirrorSource);
  for (const fixture of mcpHeaderPayloadVariantFixtures) await writeFixture(tmp, fixture.path, fixture.source);
  await writeFixture(tmp, customPrefixOldPath, customPrefixOldSource);
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

  await checkPythonCallKeywordAsync('ordinary MCP write accepts complete call-keyword references', async () => {
    const written = assertToolSuccess(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordWritePath, content: pythonCallKeywordReturnComposition }
    }), 'Python call-keyword reference write');
    assert.equal(await fs.readFile(path.join(tmp, pythonCallKeywordWritePath), 'utf8'), pythonCallKeywordReturnComposition, 'Python call-keyword write changed exact bytes');
    assert.equal(written.structuredContent.sha256, sha256(pythonCallKeywordReturnComposition), 'Python call-keyword write returned a different source hash');
  });

  await checkPythonCallKeywordAsync('ordinary MCP read preserves complete reference source bytes', async () => {
    const read = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordReadPath }
    }), 'Python call-keyword reference read');
    assertReadMetadata(read, pythonCallKeywordReadSource, 1, undefined, 'Python call-keyword reference read');
    assert.equal(read.structuredContent.text, numbered(pythonCallKeywordReadSource), 'Python call-keyword read changed source projection');
  });

  await checkPythonCallKeywordAsync('ordinary MCP edit accepts references in the complete resulting file', async () => {
    const edited = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: pythonCallKeywordEditPath,
        old_text: '# marker: before',
        new_text: '# marker: after',
        expected_replacements: 1
      }
    }), 'Python call-keyword reference edit');
    assert.equal(await fs.readFile(path.join(tmp, pythonCallKeywordEditPath), 'utf8'), pythonCallKeywordEditAfter, 'Python call-keyword edit changed unexpected bytes');
    assert.equal(edited.structuredContent.sha256, sha256(pythonCallKeywordEditAfter), 'Python call-keyword edit returned a different source hash');
  });

  await checkPythonCallKeywordAsync('ordinary MCP typed-reference write/read/edit accepts safe annotations and token guard', async () => {
    const written = assertToolSuccess(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordTypedPath, content: pythonCallKeywordTypedReference }
    }), 'Python typed-reference write');
    assert.equal(await fs.readFile(path.join(tmp, pythonCallKeywordTypedPath), 'utf8'), pythonCallKeywordTypedReference, 'typed-reference write changed exact bytes');
    assert.equal(written.structuredContent.sha256, sha256(pythonCallKeywordTypedReference), 'typed-reference write returned a different source hash');
    const read = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordTypedPath }
    }), 'Python typed-reference read');
    assertReadMetadata(read, pythonCallKeywordTypedReference, 1, undefined, 'Python typed-reference read');
    assert.equal(read.structuredContent.text, numbered(pythonCallKeywordTypedReference), 'typed-reference read changed exact source projection');
    const edited = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: pythonCallKeywordTypedPath,
        old_text: '# marker: before',
        new_text: '# marker: after',
        expected_replacements: 1
      }
    }), 'Python typed-reference edit');
    assert.equal(await fs.readFile(path.join(tmp, pythonCallKeywordTypedPath), 'utf8'), pythonCallKeywordTypedEditAfter, 'typed-reference edit changed unexpected bytes');
    assert.equal(edited.structuredContent.sha256, sha256(pythonCallKeywordTypedEditAfter), 'typed-reference edit returned a different source hash');
  });

  await checkPythonCallKeywordAsync('ordinary MCP typed credential refusal preserves file identity', async () => {
    const target = path.join(tmp, pythonCallKeywordTypedHostilePath);
    const before = await fs.readFile(target);
    const beforeStat = await fs.stat(target, { bigint: true });
    const refused = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: pythonCallKeywordTypedHostilePath,
        old_text: '# marker: before',
        new_text: '# marker: after',
        expected_replacements: 1
      }
    }), 'Python typed credential edit');
    assert.match(resultText(refused), /Secret-looking content is blocked/);
    expectNoHostileResponseFields(refused, [pythonCallKeywordSyntheticCredential], 'Python typed credential edit refusal');
    const after = await fs.readFile(target);
    const afterStat = await fs.stat(target, { bigint: true });
    assert.deepEqual({
      bytes: after.toString('utf8'),
      hash: sha256(after),
      dev: afterStat.dev.toString(),
      ino: afterStat.ino.toString(),
      size: afterStat.size.toString(),
      mtimeNs: afterStat.mtimeNs.toString()
    }, {
      bytes: before.toString('utf8'),
      hash: sha256(before),
      dev: beforeStat.dev.toString(),
      ino: beforeStat.ino.toString(),
      size: beforeStat.size.toString(),
      mtimeNs: beforeStat.mtimeNs.toString()
    }, 'typed credential edit refusal changed bytes or file identity');
  });

  await checkPythonCallKeywordAsync('ordinary MCP malformed-source write refuses without creating a file', async () => {
    const refused = assertToolError(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordMalformedWritePath, content: pythonCallKeywordMalformedSource }
    }), 'Python call-keyword malformed-source write');
    assert.match(resultText(refused), /Secret-looking content is blocked/);
    await assert.rejects(fs.access(path.join(tmp, pythonCallKeywordMalformedWritePath)), (error) => error?.code === 'ENOENT');
  });

  const pythonCallKeywordHostileTarget = path.join(tmp, pythonCallKeywordHostilePath);
  const pythonCallKeywordHostileBefore = await fs.readFile(pythonCallKeywordHostileTarget);
  const pythonCallKeywordHostileStat = await fs.stat(pythonCallKeywordHostileTarget, { bigint: true });
  const pythonCallKeywordHostileIdentity = {
    bytes: pythonCallKeywordHostileBefore.toString('utf8'),
    hash: sha256(pythonCallKeywordHostileBefore),
    dev: pythonCallKeywordHostileStat.dev.toString(),
    ino: pythonCallKeywordHostileStat.ino.toString(),
    size: pythonCallKeywordHostileStat.size.toString(),
    mtimeNs: pythonCallKeywordHostileStat.mtimeNs.toString()
  };

  await checkPythonCallKeywordAsync('ordinary MCP malformed annotation write refuses without creating a file', async () => {
    const refused = assertToolError(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordMalformedAnnotationPath, content: pythonCallKeywordMalformedAnnotationSource }
    }), 'Python malformed annotation write');
    assert.match(resultText(refused), /Secret-looking content is blocked/);
    await assert.rejects(fs.access(path.join(tmp, pythonCallKeywordMalformedAnnotationPath)), (error) => error?.code === 'ENOENT');
  });

  await checkPythonCallKeywordAsync('ordinary MCP read redacts a hostile sibling in the same call', async () => {
    const read = assertToolSuccess(await client.request('tools/call', {
      name: 'read',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordHostilePath }
    }), 'Python call-keyword hostile read');
    expectNoHostileResponseFields(read, [pythonCallKeywordMarker], 'Python call-keyword hostile read');
    assert.equal(read.structuredContent.text.includes(pythonCallKeywordMarker), false, 'hostile sibling survived the read projection');
    assert.deepEqual(await fs.readFile(pythonCallKeywordHostileTarget), pythonCallKeywordHostileBefore, 'hostile read mutated target bytes');
  });

  await checkPythonCallKeywordAsync('ordinary MCP write refuses hostile sibling without changing bytes or metadata', async () => {
    const refused = assertToolError(await client.request('tools/call', {
      name: 'write',
      arguments: { workspace_id: workspaceId, path: pythonCallKeywordHostilePath, content: pythonCallKeywordHostileSource }
    }), 'Python call-keyword hostile write');
    assert.match(resultText(refused), /Secret-looking content is blocked/);
    expectNoHostileResponseFields(refused, [pythonCallKeywordMarker], 'Python call-keyword hostile write refusal');
    const bytes = await fs.readFile(pythonCallKeywordHostileTarget);
    const stat = await fs.stat(pythonCallKeywordHostileTarget, { bigint: true });
    assert.deepEqual({
      bytes: bytes.toString('utf8'),
      hash: sha256(bytes),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString()
    }, pythonCallKeywordHostileIdentity, 'refused hostile write changed bytes, inode, metadata, or hash');
  });

  await checkPythonCallKeywordAsync('ordinary MCP edit refuses hostile sibling without changing bytes or metadata', async () => {
    const refused = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: pythonCallKeywordHostilePath,
        old_text: '# marker: before',
        new_text: '# marker: after',
        expected_replacements: 1
      }
    }), 'Python call-keyword hostile edit');
    assert.match(resultText(refused), /Secret-looking content is blocked/);
    expectNoHostileResponseFields(refused, [pythonCallKeywordMarker], 'Python call-keyword hostile edit refusal');
    const bytes = await fs.readFile(pythonCallKeywordHostileTarget);
    const stat = await fs.stat(pythonCallKeywordHostileTarget, { bigint: true });
    assert.deepEqual({
      bytes: bytes.toString('utf8'),
      hash: sha256(bytes),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString()
    }, pythonCallKeywordHostileIdentity, 'refused hostile edit changed bytes, inode, metadata, or hash');
  });

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
  // Git preflight is the first authority. This mixed patch repeats the
  // already-applied Python block, so Git must reject it before source-policy
  // classification of the later hostile material can run.
  assert.match(resultText(mixedBlocked), /Checking patch|patch failed|does not apply/i);
  assert.equal(resultText(mixedBlocked).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'looks-Python mixed-language rejection leaked its hostile hunk');
  assert.equal(await fs.readFile(path.join(tmp, lawfulPatchPath), 'utf8'), mixedBeforePython, 'looks-Python mixed-language rejection partially mutated Python file');
  assert.equal(await fs.readFile(path.join(tmp, mixedPatchTextPath), 'utf8'), mixedBeforeText, 'looks-Python mixed-language rejection mutated non-Python file');
  await writeRawArtifact(rawArtifactDir, 'looks-python-mixed-apply-patch-rejected', mixedBlocked);

  // Independent atomic policy proof: both Git hunks are applicable against
  // fresh targets, but the Python side is source-policy hostile. The route
  // must reject before mutating either the Python or non-Python file.
  const policyAtomicPyPath = 'policy-atomic.py';
  const policyAtomicTxtPath = 'policy-atomic.txt';
  await writeFixture(tmp, policyAtomicPyPath, 'class PolicyAtomic:\n');
  await writeFixture(tmp, policyAtomicTxtPath, 'class PolicyAtomicMirror:\n');
  const policyAtomicPatch = [
    `diff --git a/${policyAtomicPyPath} b/${policyAtomicPyPath}`,
    `--- a/${policyAtomicPyPath}`,
    `+++ b/${policyAtomicPyPath}`,
    '@@ -1,1 +1,2 @@',
    ' class PolicyAtomic:',
    '+    token = ACTUAL_LITERAL_SECRET_7X9',
    `diff --git a/${policyAtomicTxtPath} b/${policyAtomicTxtPath}`,
    `--- a/${policyAtomicTxtPath}`,
    `+++ b/${policyAtomicTxtPath}`,
    '@@ -1,1 +1,2 @@',
    ' class PolicyAtomicMirror:',
    '+    mirror = "safe"',
    ''
  ].join('\n');
  const policyAtomicGitCheck = spawnSync('git', ['apply', '--check', '--whitespace=nowarn'], { cwd: tmp, input: policyAtomicPatch, encoding: 'utf8' });
  assert.equal(policyAtomicGitCheck.status, 0, `fully applicable mixed policy fixture was not accepted by Git: ${policyAtomicGitCheck.stderr || policyAtomicGitCheck.stdout}`);
  const policyAtomicPyBefore = await fs.readFile(path.join(tmp, policyAtomicPyPath), 'utf8');
  const policyAtomicTxtBefore = await fs.readFile(path.join(tmp, policyAtomicTxtPath), 'utf8');
  const policyAtomicBlocked = assertToolError(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: policyAtomicPatch }
  }), 'fully applicable mixed-language policy atomicity');
  assert.match(resultText(policyAtomicBlocked), /Secret-looking content is blocked/);
  assert.equal(resultText(policyAtomicBlocked).includes('ACTUAL_LITERAL_SECRET_7X9'), false, 'fully applicable mixed policy rejection leaked hostile content');
  assert.equal(await fs.readFile(path.join(tmp, policyAtomicPyPath), 'utf8'), policyAtomicPyBefore, 'fully applicable mixed policy rejection mutated Python file');
  assert.equal(await fs.readFile(path.join(tmp, policyAtomicTxtPath), 'utf8'), policyAtomicTxtBefore, 'fully applicable mixed policy rejection mutated mirror file');
  await writeRawArtifact(rawArtifactDir, 'fully-applicable-mixed-policy-atomicity-rejected', policyAtomicBlocked);

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
          const representedLines = analysis.matches
            .flatMap((match) => [match.line, ...(match.additionalLines ?? [])])
            .sort((a, b) => a - b);
          assert.deepEqual(
            representedLines,
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
  assert.match(resultText(rangedByteLimitedError), /Selected line 1 is too large/i, 'ranged read selected max_bytes limit changed its bounded error');
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

  const aggregateOverflowBatch = assertToolSuccess(await client.request('tools/call', {
    name: 'read_many',
    arguments: {
      workspace_id: workspaceId,
      max_total_bytes: 4_000,
      items: Array.from({ length: 32 }, () => ({ path: 'ranged-byte-limit.ts' }))
    }
  }), 'read_many aggregate byte limit');
  const aggregateOverflowResults = aggregateOverflowBatch.structuredContent.results ?? [];
  assert.ok(aggregateOverflowResults.length > 0 && aggregateOverflowResults.length < 32, 'read_many aggregate byte limit did not return a useful bounded prefix');
  assert.ok(aggregateOverflowResults.every((item, index) => item.index === index && item.ok === false && /aggregate response budget/i.test(item.error)), 'read_many aggregate byte limit returned incomplete or unmarked item results');
  assert.equal(aggregateOverflowBatch.structuredContent.next_index, aggregateOverflowResults.length, 'read_many aggregate byte limit lost deterministic next_index');
  assert.equal(typeof aggregateOverflowBatch.structuredContent.cursor, 'string', 'read_many aggregate byte limit lost continuation cursor');
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
  assert.equal(structuredMatches.length, 1, 'structured source search did not compress same-file evidence');
  assert.deepEqual(
    structuredMatches.map((match) => ({ path: match.path, line: match.line, text: match.text })),
    [
      { path: 'source.ts', line: 2, text: sourceTs.split('\n')[1].trim() }
    ],
    'structured source search changed lawful source text or ordering'
  );
  assert.equal(structuredMatches[0].occurrenceCount, 2, 'structured source search lost repeated-line count');
  assert.deepEqual(structuredMatches[0].additionalLines, [15], 'structured source search lost repeated-line provenance');
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
  const duplicatePrivateAnalysisMatches = duplicatePrivateStructured.structuredContent.analysis?.matches ?? [];
  assert.equal(duplicatePrivateAnalysisMatches.length, 1, 'duplicate-line structured private-key search did not compress same-file evidence');
  assert.deepEqual(
    duplicatePrivateAnalysisMatches.map((match) => ({ line: match.line, text: match.text })),
    [
      { line: 1, text: 'const duplicate = true;' }
    ],
    'duplicate-line structured private-key search changed lawful line mapping or source text'
  );
  assert.equal(duplicatePrivateAnalysisMatches[0].occurrenceCount, 5, 'duplicate-line structured private-key search lost occurrence count');
  assert.deepEqual(duplicatePrivateAnalysisMatches[0].additionalLines, [2, 4, 6, 7], 'duplicate-line structured private-key search lost occurrence provenance');

  const binaryPrivateSearch = assertToolSuccess(await client.request('tools/call', {
    name: 'search',
    arguments: { workspace_id: workspaceId, query: binaryPrivateBody, path: 'binary-private.ts', max_results: 10 }
  }), 'binary private-key search');
  assert.deepEqual(
    binaryPrivateSearch.structuredContent.matches?.map((match) => ({ line: match.line, text: match.text })),
    [{ line: 2, text: '[SOURCE_CONTEXT_UNAVAILABLE]' }],
    'binary private-key search did not report unavailable context distinctly from redaction'
  );
  assert.deepEqual(
    binaryPrivateSearch.structuredContent.matches?.map((match) => ({ line: match.line, text_status: match.text_status, reason: match.reason })),
    [{ line: 2, text_status: 'unavailable', reason: 'binary' }],
    'binary private-key search omitted honest unavailable status'
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
      [{ line: 2, text: '[SOURCE_CONTEXT_UNAVAILABLE]' }],
      `mixed-case private-key ${label} search changed its unavailable lexical match`
    );
    assert.deepEqual(
      mixedPrivateStructured.structuredContent.matches?.map((match) => ({ line: match.line, text_status: match.text_status, reason: match.reason })),
      [{ line: 2, text_status: 'unavailable', reason: 'binary' }],
      `mixed-case private-key ${label} search omitted honest unavailable status`
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
    [{ line: 2, text: '[SOURCE_CONTEXT_UNAVAILABLE]' }],
    'invalid UTF-8 private-key analysis did not report unavailable context'
  );
  assert.deepEqual(
    invalidPrivateStructured.structuredContent.analysis?.matches?.map((match) => ({ line: match.line, text_status: match.text_status, reason: match.reason })),
    [{ line: 2, text_status: 'unavailable', reason: 'invalid-encoding' }],
    'invalid UTF-8 private-key analysis omitted honest unavailable status'
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

  const returnAnnotationEdited = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: pythonReturnAnnotationEditPath,
      old_text: 'return CampaignHeadToken("harmless")',
      new_text: 'return CampaignHeadToken("still_harmless")',
      expected_replacements: 1
    }
  }), 'Python function return annotation edit');
  assert.ok(returnAnnotationEdited.structuredContent, 'Python function return annotation edit omitted structured output');
  assert.equal(
    await fs.readFile(path.join(tmp, pythonReturnAnnotationEditPath), 'utf8'),
    pythonReturnAnnotationEditAfter,
    'Python function return annotation edit changed more than the harmless body value'
  );

  const pythonReturnAnnotationCredentialFieldBefore = await fs.readFile(
    path.join(tmp, pythonReturnAnnotationCredentialFieldEditPath),
    'utf8'
  );
  const blockedReturnAnnotationCredentialField = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: pythonReturnAnnotationCredentialFieldEditPath,
      old_text: 'return CampaignHeadToken("harmless")',
      new_text: 'return CampaignHeadToken("still_harmless")',
      expected_replacements: 1
    }
  }), 'credential field after Python return annotation edit');
  assert.match(resultText(blockedReturnAnnotationCredentialField), /Secret-looking content is blocked from edit/);
  assert.equal(resultText(blockedReturnAnnotationCredentialField).includes('QZ7'), false, 'blocked composite edit leaked its synthetic value');
  assert.equal(
    await fs.readFile(path.join(tmp, pythonReturnAnnotationCredentialFieldEditPath), 'utf8'),
    pythonReturnAnnotationCredentialFieldBefore,
    'credential field after Python return annotation edit mutated the source'
  );

  for (const [label, pathName, before] of [
    ['multiline assignment', pythonMultilineAssignmentEditPath, pythonMultilineAssignmentEditBefore],
    ['multiline field', pythonMultilineFieldEditPath, pythonMultilineFieldEditBefore]
  ]) {
    const blocked = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: pathName,
        old_text: '# marker: before',
        new_text: '# marker: after',
        expected_replacements: 1
      }
    }), `Python ${label} credential edit`);
    assert.match(resultText(blocked), /Secret-looking content is blocked from edit/);
    assert.equal(resultText(blocked).includes('QZ7'), false, `Python ${label} edit leaked its synthetic value`);
    assert.equal(await fs.readFile(path.join(tmp, pathName), 'utf8'), before, `Python ${label} edit mutated the source`);
  }

  const malformedAnnotationBefore = await fs.readFile(path.join(tmp, pythonMalformedAnnotationEditPath), 'utf8');
  const blockedMalformedAnnotation = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: pythonMalformedAnnotationEditPath,
      old_text: 'return CampaignHeadToken("harmless")',
      new_text: 'return CampaignHeadToken("still_harmless")',
      expected_replacements: 1
    }
  }), 'malformed Python return annotation edit');
  assert.match(resultText(blockedMalformedAnnotation), /Secret-looking content is blocked from edit/);
  assert.equal(
    await fs.readFile(path.join(tmp, pythonMalformedAnnotationEditPath), 'utf8'),
    malformedAnnotationBefore,
    'malformed Python return annotation edit mutated the source'
  );

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
    // Keep the producer patch identity equal to the seeded target. Git
    // preflight now runs before source classification, so a mismatched path
    // would test only "file not found" rather than the intended hostile
    // source-policy rejection.
    const hostileDiff = diff
      .replaceAll('multiline.py', pathName)
      .replaceAll('multiline-annotation.py', pathName);
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

  const mixedAtomicTxtBefore = await fs.readFile(path.join(tmp, 'apply-rename-old.txt'), 'utf8');
  const mixedAtomicPyBefore = await fs.readFile(path.join(tmp, 'apply-rename-old.py'), 'utf8');
  const mixedAtomicPatch = [
    'diff --git a/apply-rename-old.txt b/apply-rename-old.txt',
    'rename from contradictory.txt',
    'rename to apply-rename-old.txt',
    '--- a/apply-rename-old.txt',
    '+++ b/apply-rename-old.txt',
    '@@ -1,2 +1,2 @@',
    '-class ApplyRenameOldTxt:',
    '-    token: Token[APPLY_RENAME_OLD_LITERAL]',
    '+class ApplyRenameOldTxt:',
    '+    token: Token[MIXED_INVALID_LITERAL]',
    'diff --git a/apply-rename-old.py b/apply-rename-old.py',
    '--- a/apply-rename-old.py',
    '+++ b/apply-rename-old.py',
    '@@ -1,2 +1,2 @@',
    '-class ApplyRenameOldPy:',
    '+class ApplyRenameNewPy:',
    '     token: Token[str]',
    ''
  ].join('\n');
  const blockedMixedAtomicPatch = assertToolError(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: mixedAtomicPatch }
  }), 'mixed invalid/valid apply_patch atomicity');
  // Git preflight is authoritative before canonical path/source parsing; its
  // malformed duplicate block may therefore report the producer's filename
  // contradiction directly instead of the later path-ambiguity label.
  assert.match(resultText(blockedMixedAtomicPatch), /inconsistent old filename|unambiguous file paths/i);
  assert.equal(resultText(blockedMixedAtomicPatch).includes('MIXED_INVALID_LITERAL'), false, 'mixed invalid/valid apply_patch leaked rejected payload');
  assert.equal(await fs.readFile(path.join(tmp, 'apply-rename-old.txt'), 'utf8'), mixedAtomicTxtBefore, 'mixed invalid/valid apply_patch mutated invalid-block file');
  assert.equal(await fs.readFile(path.join(tmp, 'apply-rename-old.py'), 'utf8'), mixedAtomicPyBefore, 'mixed invalid/valid apply_patch mutated valid-block file');
  await writeRawArtifact(rawArtifactDir, 'mixed-invalid-valid-apply-patch-rejected', blockedMixedAtomicPatch);

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

  // Feed that exact Git-produced patch back through the real MCP apply_patch
  // route. The file is restored only to make the captured diff applicable;
  // Git remains the target patch producer and MCP remains the target route.
  const headerPayloadRawPatchResult = spawnSync('git', ['diff', '--', headerPayloadPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(headerPayloadRawPatchResult.status, 0, `header-shaped raw Git patch failed: ${headerPayloadRawPatchResult.stderr || headerPayloadRawPatchResult.stdout}`);
  const headerPayloadRawPatch = headerPayloadRawPatchResult.stdout;
  assert.equal(headerPayloadRawPatch, `${headerPayloadDiff.structuredContent.diff}\n`, 'MCP Git diff did not preserve the real Git patch bytes');
  await fs.writeFile(path.join(tmp, headerPayloadPath), mcpHeaderPayloadSource, 'utf8');
  const headerPayloadSentinelPath = 'source.ts';
  const headerPayloadSentinelBefore = await fs.readFile(path.join(tmp, headerPayloadSentinelPath), 'utf8');
  const headerPayloadSentinelHash = sha256(headerPayloadSentinelBefore);
  const headerPayloadEntriesBefore = (await fs.readdir(tmp)).sort();
  const headerPayloadDerivedFiles = [
    'old_marker',
    'new_marker',
    'relative-looking-text',
    'header-looking.py',
    'header-looking.txt',
    'absolute-looking'
  ];
  const headerPayloadApply = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: headerPayloadRawPatch }
  }), 'header-shaped hunk payload MCP apply_patch');
  assert.deepEqual(headerPayloadApply.structuredContent.paths, [headerPayloadPath], 'header-shaped MCP apply_patch returned payload-looking paths');
  assert.equal(await fs.readFile(path.join(tmp, headerPayloadPath), 'utf8'), mcpHeaderPayloadSource
    .replace('-- old_marker', '++ new_marker'), 'header-shaped MCP apply_patch changed bytes unexpectedly');
  const headerPayloadSentinelAfter = await fs.readFile(path.join(tmp, headerPayloadSentinelPath), 'utf8');
  assert.equal(headerPayloadSentinelAfter, headerPayloadSentinelBefore, 'header-shaped MCP apply_patch changed unrelated sentinel bytes');
  assert.equal(sha256(headerPayloadSentinelAfter), headerPayloadSentinelHash, 'header-shaped MCP apply_patch changed unrelated sentinel hash');
  assert.deepEqual((await fs.readdir(tmp)).sort(), headerPayloadEntriesBefore, 'header-shaped MCP apply_patch created or removed unrelated entries');
  for (const derivedFile of headerPayloadDerivedFiles) {
    const derivedPath = path.join(tmp, derivedFile);
    const absent = await fs.access(derivedPath).then(() => false).catch((error) => {
      if (error?.code === 'ENOENT') return true;
      throw error;
    });
    assert.equal(absent, true, `header-shaped MCP apply_patch created payload-derived file ${derivedFile}`);
  }
  await writeRawArtifact(rawArtifactDir, 'header-shaped-hunk-payload-mcp-apply', headerPayloadApply);

  for (const fixture of mcpHeaderPayloadVariantFixtures) {
    const { path: variantPath, payload: expectedPayload, source: variantSource } = fixture;
    const variantChanged = variantSource.replace('-- ', '++ ');
    await fs.writeFile(path.join(tmp, variantPath), variantChanged, 'utf8');
    const variantDiffResult = spawnSync('git', ['diff', '--', variantPath], { cwd: tmp, encoding: 'utf8' });
    assert.equal(variantDiffResult.status, 0, `${variantPath} real Git diff failed: ${variantDiffResult.stderr || variantDiffResult.stdout}`);
    const variantPatch = variantDiffResult.stdout;
    assert.equal(variantPatch.includes(`--- ${expectedPayload}`), true, `${variantPath} real Git diff omitted exact header-shaped deletion payload`);
    assert.equal(variantPatch.includes(`+++ ${expectedPayload}`), true, `${variantPath} real Git diff omitted exact header-shaped addition payload`);
    const variantBlocks = extractDiffFileBlocks(variantPatch);
    assert.deepEqual(variantBlocks.map((block) => block.paths), [[variantPath]], `${variantPath} canonical metadata admitted payload-looking path`);
    await fs.writeFile(path.join(tmp, variantPath), variantSource, 'utf8');
    const variantApply = assertToolSuccess(await client.request('tools/call', {
      name: 'apply_patch',
      arguments: { workspace_id: workspaceId, patch: variantPatch }
    }), `${variantPath} header-shaped MCP apply_patch`);
    assert.deepEqual(variantApply.structuredContent.paths, [variantPath], `${variantPath} MCP apply_patch returned payload-looking paths`);
    assert.equal(await fs.readFile(path.join(tmp, variantPath), 'utf8'), variantChanged, `${variantPath} MCP apply_patch changed bytes unexpectedly`);
  }

  // A real Git multi-file diff must be split per file, with the Python and
  // mirror paths independently routed and the MCP result deterministically
  // deduped in producer order.
  const headerPayloadMirrorPath = 'header-payload-mirror.txt';
  const headerPayloadMirrorChanged = mcpHeaderPayloadMirrorSource.replace('-- header-looking.txt', '++ header-looking.txt');
  await fs.writeFile(path.join(tmp, headerPayloadPath), mcpHeaderPayloadSource, 'utf8');
  await fs.writeFile(path.join(tmp, headerPayloadMirrorPath), mcpHeaderPayloadMirrorSource, 'utf8');
  await fs.writeFile(path.join(tmp, headerPayloadPath), mcpHeaderPayloadSource.replace('-- old_marker', '++ new_marker'), 'utf8');
  await fs.writeFile(path.join(tmp, headerPayloadMirrorPath), headerPayloadMirrorChanged, 'utf8');
  const multiHeaderPayloadPatchResult = spawnSync('git', ['diff', '--', headerPayloadPath, headerPayloadMirrorPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(multiHeaderPayloadPatchResult.status, 0, `multi-file header-shaped Git diff failed: ${multiHeaderPayloadPatchResult.stderr || multiHeaderPayloadPatchResult.stdout}`);
  const multiHeaderPayloadPatch = multiHeaderPayloadPatchResult.stdout;
  assert.equal(multiHeaderPayloadPatch.includes('--- header-looking.txt'), true, 'multi-file Git diff omitted .txt header-shaped deletion payload');
  assert.equal(multiHeaderPayloadPatch.includes('+++ header-looking.txt'), true, 'multi-file Git diff omitted .txt header-shaped addition payload');
  await writeRawArtifact(rawArtifactDir, 'header-shaped-hunk-payload-multi-file-git-diff', { patch: multiHeaderPayloadPatch });
  const multiHeaderPayloadBlocks = extractDiffFileBlocks(multiHeaderPayloadPatch);
  assert.deepEqual(multiHeaderPayloadBlocks.map((block) => block.paths), [[headerPayloadMirrorPath], [headerPayloadPath]], 'multi-file canonical blocks changed producer-ordered paths');
  assert.equal(multiHeaderPayloadBlocks.every((block) => block.pathDiscoveryValid), true, 'multi-file canonical blocks were not unambiguous');
  await fs.writeFile(path.join(tmp, headerPayloadPath), mcpHeaderPayloadSource, 'utf8');
  await fs.writeFile(path.join(tmp, headerPayloadMirrorPath), mcpHeaderPayloadMirrorSource, 'utf8');
  const multiHeaderPayloadApply = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: multiHeaderPayloadPatch }
  }), 'multi-file header-shaped MCP apply_patch');
  assert.deepEqual(multiHeaderPayloadApply.structuredContent.paths, [headerPayloadMirrorPath, headerPayloadPath], 'multi-file MCP apply_patch changed returned path order or dedupe');
  assert.equal(await fs.readFile(path.join(tmp, headerPayloadPath), 'utf8'), mcpHeaderPayloadSource
    .replace('-- old_marker', '++ new_marker'), 'multi-file MCP apply_patch changed Python bytes unexpectedly');
  assert.equal(await fs.readFile(path.join(tmp, headerPayloadMirrorPath), 'utf8'), headerPayloadMirrorChanged, 'multi-file MCP apply_patch changed mirror bytes unexpectedly');
  await writeRawArtifact(rawArtifactDir, 'header-shaped-hunk-payload-multi-file-mcp-apply', multiHeaderPayloadApply);

  // Git's default -p1 strips one component from ordinary unified headers even
  // when the producer uses prefixes other than `a/` and `b/`. Keep actual
  // Python files beneath top-level `a/` and `b/` to prove the canonical path
  // is the post-strip target consumed by PathGuard, language routing, and Git.
  await fs.mkdir(path.join(tmp, 'b'), { recursive: true });
  await fs.rename(path.join(tmp, customPrefixOldPath), path.join(tmp, customPrefixNewPath));
  await fs.writeFile(path.join(tmp, customPrefixNewPath), customPrefixNewSource, 'utf8');
  const customPrefixStage = spawnSync('git', ['add', '-A', '--', customPrefixOldPath, customPrefixNewPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(customPrefixStage.status, 0, `custom-prefix rename staging failed: ${customPrefixStage.stderr || customPrefixStage.stdout}`);
  const customPrefixPatchResult = spawnSync('git', [
    '-c', 'diff.renames=true',
    'diff', '--cached', '--find-renames=50%',
    '--src-prefix=old/', '--dst-prefix=new/',
    '--', customPrefixOldPath, customPrefixNewPath
  ], { cwd: tmp, encoding: 'utf8' });
  assert.equal(customPrefixPatchResult.status, 0, `custom-prefix real Git diff failed: ${customPrefixPatchResult.stderr || customPrefixPatchResult.stdout}`);
  const customPrefixPatch = customPrefixPatchResult.stdout;
  assert.equal(customPrefixPatch.includes(`--- old/${customPrefixOldPath}`), true, 'custom-prefix Git diff omitted old non-a/b header');
  assert.equal(customPrefixPatch.includes(`+++ new/${customPrefixNewPath}`), true, 'custom-prefix Git diff omitted new non-a/b header');
  assert.equal(customPrefixPatch.includes(`rename from ${customPrefixOldPath}`), true, 'custom-prefix Git diff omitted old rename metadata');
  assert.equal(customPrefixPatch.includes(`rename to ${customPrefixNewPath}`), true, 'custom-prefix Git diff omitted new rename metadata');
  const customPrefixBlocks = extractDiffFileBlocks(customPrefixPatch);
  assert.deepEqual(customPrefixBlocks.map((block) => block.paths), [[customPrefixOldPath, customPrefixNewPath]], 'custom-prefix canonical paths did not match Git -p1 targets');
  assert.equal(customPrefixBlocks[0].oldPath, customPrefixOldPath, 'custom-prefix old canonical path was not post-strip');
  assert.equal(customPrefixBlocks[0].newPath, customPrefixNewPath, 'custom-prefix new canonical path was not post-strip');
  assert.equal(customPrefixBlocks[0].pathDiscoveryValid, true, 'custom-prefix canonical block was not valid');
  const customPrefixReset = spawnSync('git', ['reset', 'HEAD', '--', customPrefixOldPath, customPrefixNewPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(customPrefixReset.status, 0, `custom-prefix rename unstaging failed: ${customPrefixReset.stderr || customPrefixReset.stdout}`);
  await fs.rename(path.join(tmp, customPrefixNewPath), path.join(tmp, customPrefixOldPath));
  await fs.writeFile(path.join(tmp, customPrefixOldPath), customPrefixOldSource, 'utf8');
  const customPrefixApply = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch',
    arguments: { workspace_id: workspaceId, patch: customPrefixPatch }
  }), 'custom-prefix Python rename MCP apply_patch');
  assert.deepEqual(customPrefixApply.structuredContent.paths, [customPrefixOldPath, customPrefixNewPath], 'custom-prefix MCP apply_patch returned non-canonical or payload-derived paths');
  assert.equal(await fs.readFile(path.join(tmp, customPrefixNewPath), 'utf8'), customPrefixNewSource, 'custom-prefix MCP apply_patch changed new Python bytes unexpectedly');
  const customPrefixOldAbsent = await fs.access(path.join(tmp, customPrefixOldPath)).then(() => false).catch((error) => {
    if (error?.code === 'ENOENT') return true;
    throw error;
  });
  assert.equal(customPrefixOldAbsent, true, 'custom-prefix MCP apply_patch left the old Python path behind');
  assert.equal(resultText(customPrefixApply).includes('CUSTOM_PREFIX_NEW_LITERAL'), true, 'custom-prefix MCP apply_patch did not preserve trusted Python response bytes');
  const customPrefixPostApplyReset = spawnSync('git', ['reset', 'HEAD', '--', customPrefixOldPath, customPrefixNewPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(customPrefixPostApplyReset.status, 0, `custom-prefix post-apply unstaging failed: ${customPrefixPostApplyReset.stderr || customPrefixPostApplyReset.stdout}`);
  await writeRawArtifact(rawArtifactDir, 'custom-prefix-python-rename-mcp-apply', customPrefixApply);

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
  assert.ok(resultText(privateWrite).includes('Path blocked-private-key.txt; source line(s) 1, 2, 3; matched content omitted'));
  assert.equal(/\brule\b/i.test(resultText(privateWrite)), false, 'private-key refusal inferred a detector rule name');
  await assert.rejects(fs.access(path.join(tmp, 'blocked-private-key.txt')), (error) => error?.code === 'ENOENT');

  {
    const labelNames = [['to', 'ken_label'], ['work_', 'token_label']].map((parts) => parts.join(''));
    const labelValue = 'NONSECRET_TEST_LABEL_42';
    const labelPath = 'ordinary-token-labels.cs';
    const labelAbsolutePath = path.join(tmp, labelPath);
    const labelBase = [
      'class OrdinaryLabelFixture {',
      '    string fixture_kind = "test";',
      '    string fixture_marker = "before";',
      '}',
      ''
    ].join(String.fromCharCode(10));
    const labelCandidate = [
      'class OrdinaryLabelFixture {',
      '    string fixture_kind = "test";',
      `    string ${labelNames[0]} = "${labelValue}";`,
      `    string ${labelNames[1]} = "${labelValue}";`,
      '    string fixture_marker = "after";',
      '}',
      ''
    ].join(String.fromCharCode(10));
    await fs.writeFile(labelAbsolutePath, labelBase, { encoding: 'utf8', flag: 'wx' });
    const labelBytesBefore = await fs.readFile(labelAbsolutePath);
    const labelStatBefore = await fs.stat(labelAbsolutePath, { bigint: true });
    const labelRefusal = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: labelPath,
        old_text: '    string fixture_marker = "before";',
        new_text: [
          '    string ' + labelNames[0] + ' = "' + labelValue + '";',
          '    string ' + labelNames[1] + ' = "' + labelValue + '";',
          '    string fixture_marker = "after";'
        ].join(String.fromCharCode(10)),
        expected_replacements: 1
      }
    }), 'synthetic harmless token-label MCP edit');
    assert.ok(resultText(labelRefusal).includes('Path ' + labelPath + '; source line(s) 3, 4; matched content omitted'));
    assert.equal(/\brule\b/i.test(resultText(labelRefusal)), false, 'token-label refusal inferred a detector rule name');
    expectNoHostileResponseFields(labelRefusal, [labelValue], 'synthetic harmless token-label refusal');
    assert.deepEqual(await fs.readFile(labelAbsolutePath), labelBytesBefore, 'harmless token-label refusal changed file bytes');
    const labelStatAfter = await fs.stat(labelAbsolutePath, { bigint: true });
    assert.equal(labelStatAfter.ino, labelStatBefore.ino, 'harmless token-label refusal replaced the file');
    assert.equal(labelStatAfter.mtimeNs, labelStatBefore.mtimeNs, 'harmless token-label refusal changed file metadata');

    const labelReadPath = 'ordinary-token-labels-read.cs';
    await fs.writeFile(path.join(tmp, labelReadPath), labelCandidate, { encoding: 'utf8', flag: 'wx' });
    const labelRead = assertToolSuccess(await client.request('tools/call', {
      name: 'read', arguments: { workspace_id: workspaceId, path: labelReadPath }
    }), 'synthetic harmless token-label read projection');
    const projected = labelRead.structuredContent.text;
    assert.equal(projected.includes(labelValue), false, 'source redaction exposed a synthetic label value');
    for (const lineNo of [3, 4]) {
      const projectedLine = projected.split(String.fromCharCode(10)).find((line) => line.trimStart().startsWith(`${lineNo} |`));
      assert.ok(projectedLine?.includes('[REDACTED_SECRET]'), `read projection did not redact label line ${lineNo}`);
      assert.ok(projectedLine?.includes(labelNames[lineNo - 3]), `read projection lost label identity at line ${lineNo}`);
    }
  }
  {
    // apply_patch consistency matrix: ordinary edit and apply_patch must
    // agree on allow and block with bounded safe diagnostics. Hostile
    // literals are assembled, never written literally, and asserted absent
    // from every refusal envelope.
    const matrixPyLabel = ['to', 'ken'].join('');
    const matrixPyValue = ['SYNTHETIC_PY_', 'SECRET_9Z1'].join('');
    const matrixCsLabel = ['api', '_key'].join('');
    const matrixCsValue = ['SYNTHETIC_CS_', 'SECRET_9Z1'].join('');
    const matrixTxtLabel = ['pass', 'word'].join('');
    const matrixTxtValue = ['SYNTHETIC_TXT_', 'SECRET_9Z1'].join('');
    const matrixWholeValue = ['SYNTHETIC_WHOLEFILE_', 'SECRET_9Z1'].join('');

    // Allow agrees: benign content passes both ordinary edit and apply_patch.
    await writeFixture(tmp, 'matrix-allow.txt', 'line one\n');
    const matrixAllowEdit = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: { workspace_id: workspaceId, path: 'matrix-allow.txt', old_text: 'line one\n', new_text: 'line one\nline two\n', expected_replacements: 1 }
    }), 'consistency-matrix benign edit');
    assert.ok(matrixAllowEdit.structuredContent, 'consistency-matrix benign edit omitted structured output');
    const matrixAllowPatch = [
      'diff --git a/matrix-allow.txt b/matrix-allow.txt',
      '--- a/matrix-allow.txt',
      '+++ b/matrix-allow.txt',
      '@@ -1,2 +1,3 @@',
      ' line one',
      ' line two',
      '+line three',
      ''
    ].join('\n');
    const matrixAllowPatchResult = assertToolSuccess(await client.request('tools/call', {
      name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: matrixAllowPatch }
    }), 'consistency-matrix benign apply_patch');
    assert.ok(matrixAllowPatchResult.structuredContent, 'consistency-matrix benign apply_patch omitted structured output');
    assert.equal(await fs.readFile(path.join(tmp, 'matrix-allow.txt'), 'utf8'), 'line one\nline two\nline three\n', 'consistency-matrix benign route changed unexpected bytes');

    // Block agrees on added lines: Python detector language route.
    const matrixBlockPath = 'matrix-block.py';
    await writeFixture(tmp, matrixBlockPath, 'x = 1\n');
    const matrixBlockBefore = await fs.readFile(path.join(tmp, matrixBlockPath));
    const matrixBlockEdit = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: matrixBlockPath,
        old_text: 'x = 1\n',
        new_text: `x = 1\n${matrixPyLabel} = ${matrixPyValue}\n`,
        expected_replacements: 1
      }
    }), 'consistency-matrix hostile Python edit');
    assert.ok(resultText(matrixBlockEdit).includes(`Path ${matrixBlockPath}; source line(s) 2; matched content omitted`), 'consistency-matrix hostile Python edit omitted bounded source-line diagnostics');
    assert.equal(/\brule\b/i.test(resultText(matrixBlockEdit)), false, 'consistency-matrix hostile Python edit inferred a detector rule name');
    expectNoHostileResponseFields(matrixBlockEdit, [matrixPyValue], 'consistency-matrix hostile Python edit refusal');
    const matrixBlockPatch = [
      `diff --git a/${matrixBlockPath} b/${matrixBlockPath}`,
      `--- a/${matrixBlockPath}`,
      `+++ b/${matrixBlockPath}`,
      '@@ -1,1 +1,2 @@',
      ' x = 1',
      `+${matrixPyLabel} = ${matrixPyValue}`,
      ''
    ].join('\n');
    const matrixBlockPatchRefusal = assertToolError(await client.request('tools/call', {
      name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: matrixBlockPatch }
    }), 'consistency-matrix hostile Python apply_patch');
    assert.match(resultText(matrixBlockPatchRefusal), /Secret-looking content is blocked from apply_patch/);
    assert.match(resultText(matrixBlockPatchRefusal), new RegExp(`Path ${matrixBlockPath}; patch line\\(s\\) [0-9, +more]+; matched content omitted`), 'consistency-matrix hostile Python apply_patch omitted bounded patch-line diagnostics');
    assert.equal(/\brule\b/i.test(resultText(matrixBlockPatchRefusal)), false, 'consistency-matrix hostile Python apply_patch inferred a detector rule name');
    expectNoHostileResponseFields(matrixBlockPatchRefusal, [matrixPyValue], 'consistency-matrix hostile Python apply_patch refusal');
    assert.deepEqual(await fs.readFile(path.join(tmp, matrixBlockPath)), matrixBlockBefore, 'consistency-matrix hostile Python apply_patch partially mutated the file');

    // Whole-file protection: the patch hunk is benign and the canonical diff
    // context (3 lines) cannot see the secret kept further away, but
    // unpatched regions keep secret-looking content. Both routes must block.
    // The hunk touches only the tail; the secret stays at source line 2.
    const matrixWholePath = 'matrix-wholefile.py';
    await fs.writeFile(path.join(tmp, matrixWholePath), [
      '# benign header',
      `${matrixPyLabel} = ${matrixWholeValue}`,
      'x = 1',
      '# pad a',
      '# pad b',
      '# pad c',
      '# pad d',
      '# tail marker',
      ''
    ].join('\n'), 'utf8');
    const matrixWholeBefore = await fs.readFile(path.join(tmp, matrixWholePath));
    const matrixWholePatch = [
      `diff --git a/${matrixWholePath} b/${matrixWholePath}`,
      `--- a/${matrixWholePath}`,
      `+++ b/${matrixWholePath}`,
      '@@ -6,3 +6,4 @@',
      ' # pad c',
      ' # pad d',
      ' # tail marker',
      '+# appended note',
      ''
    ].join('\n');
    const matrixWholePatchRefusal = assertToolError(await client.request('tools/call', {
      name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: matrixWholePatch }
    }), 'consistency-matrix whole-file apply_patch');
    assert.match(resultText(matrixWholePatchRefusal), /Secret-looking content is blocked from apply_patch/);
    assert.ok(resultText(matrixWholePatchRefusal).includes(`Path ${matrixWholePath}; source line(s) 2; matched content omitted`), 'consistency-matrix whole-file apply_patch omitted source-line diagnostics');
    assert.equal(/\brule\b/i.test(resultText(matrixWholePatchRefusal)), false, 'consistency-matrix whole-file apply_patch inferred a detector rule name');
    expectNoHostileResponseFields(matrixWholePatchRefusal, [matrixWholeValue], 'consistency-matrix whole-file apply_patch refusal');
    assert.deepEqual(await fs.readFile(path.join(tmp, matrixWholePath)), matrixWholeBefore, 'consistency-matrix whole-file apply_patch partially mutated the file');
    const matrixWholeEdit = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: matrixWholePath,
        old_text: '# tail marker\n',
        new_text: '# tail marker\n# appended note\n',
        expected_replacements: 1
      }
    }), 'consistency-matrix whole-file edit');
    assert.ok(resultText(matrixWholeEdit).includes(`Path ${matrixWholePath}; source line(s) 2; matched content omitted`), 'consistency-matrix whole-file edit disagreed with apply_patch diagnostics');
    expectNoHostileResponseFields(matrixWholeEdit, [matrixWholeValue], 'consistency-matrix whole-file edit refusal');
    assert.deepEqual(await fs.readFile(path.join(tmp, matrixWholePath)), matrixWholeBefore, 'consistency-matrix whole-file edit mutated the file');

    // Language handling: .cs and .txt have no dedicated parser (undefined
    // language) and must still block hostile content without crashing, while
    // benign .cs content stays allowed.
    const matrixBenignCsPath = 'matrix-lang-benign.cs';
    await writeFixture(tmp, matrixBenignCsPath, 'class Benign {\n}\n');
    const matrixBenignCsPatch = [
      `diff --git a/${matrixBenignCsPath} b/${matrixBenignCsPath}`,
      `--- a/${matrixBenignCsPath}`,
      `+++ b/${matrixBenignCsPath}`,
      '@@ -1,2 +1,3 @@',
      ' class Benign {',
      '+    // harmless note',
      ' }',
      ''
    ].join('\n');
    assertToolSuccess(await client.request('tools/call', {
      name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: matrixBenignCsPatch }
    }), 'consistency-matrix benign C# apply_patch');
    assert.equal(await fs.readFile(path.join(tmp, matrixBenignCsPath), 'utf8'), 'class Benign {\n    // harmless note\n}\n', 'consistency-matrix benign C# apply_patch changed unexpected bytes');

    const matrixCsPath = 'matrix-lang.cs';
    await writeFixture(tmp, matrixCsPath, 'class Lang {\n}\n');
    const matrixCsBefore = await fs.readFile(path.join(tmp, matrixCsPath));
    const matrixCsPatch = [
      `diff --git a/${matrixCsPath} b/${matrixCsPath}`,
      `--- a/${matrixCsPath}`,
      `+++ b/${matrixCsPath}`,
      '@@ -1,2 +1,3 @@',
      ' class Lang {',
      `+    string ${matrixCsLabel} = "${matrixCsValue}";`,
      ' }',
      ''
    ].join('\n');
    const matrixCsRefusal = assertToolError(await client.request('tools/call', {
      name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: matrixCsPatch }
    }), 'consistency-matrix hostile C# apply_patch');
    assert.match(resultText(matrixCsRefusal), /Secret-looking content is blocked from apply_patch/);
    assert.match(resultText(matrixCsRefusal), new RegExp(`Path ${matrixCsPath}; patch line\\(s\\) [0-9, +more]+; matched content omitted`), 'consistency-matrix hostile C# apply_patch omitted bounded patch-line diagnostics');
    assert.equal(/\brule\b/i.test(resultText(matrixCsRefusal)), false, 'consistency-matrix hostile C# apply_patch inferred a detector rule name');
    expectNoHostileResponseFields(matrixCsRefusal, [matrixCsValue], 'consistency-matrix hostile C# apply_patch refusal');
    assert.deepEqual(await fs.readFile(path.join(tmp, matrixCsPath)), matrixCsBefore, 'consistency-matrix hostile C# apply_patch partially mutated the file');

    const matrixTxtPath = 'matrix-lang.txt';
    await writeFixture(tmp, matrixTxtPath, 'note = 1\n');
    const matrixTxtBefore = await fs.readFile(path.join(tmp, matrixTxtPath));
    const matrixTxtPatch = [
      `diff --git a/${matrixTxtPath} b/${matrixTxtPath}`,
      `--- a/${matrixTxtPath}`,
      `+++ b/${matrixTxtPath}`,
      '@@ -1,1 +1,2 @@',
      ' note = 1',
      `+${matrixTxtLabel} = "${matrixTxtValue}"`,
      ''
    ].join('\n');
    const matrixTxtRefusal = assertToolError(await client.request('tools/call', {
      name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: matrixTxtPatch }
    }), 'consistency-matrix hostile txt apply_patch');
    assert.match(resultText(matrixTxtRefusal), /Secret-looking content is blocked from apply_patch/);
    assert.match(resultText(matrixTxtRefusal), new RegExp(`Path ${matrixTxtPath}; patch line\\(s\\) [0-9, +more]+; matched content omitted`), 'consistency-matrix hostile txt apply_patch omitted bounded patch-line diagnostics');
    assert.equal(/\brule\b/i.test(resultText(matrixTxtRefusal)), false, 'consistency-matrix hostile txt apply_patch inferred a detector rule name');
    expectNoHostileResponseFields(matrixTxtRefusal, [matrixTxtValue], 'consistency-matrix hostile txt apply_patch refusal');
    assert.deepEqual(await fs.readFile(path.join(tmp, matrixTxtPath)), matrixTxtBefore, 'consistency-matrix hostile txt apply_patch partially mutated the file');
    console.log('APPLY_PATCH_CONSISTENCY_MATRIX: ordinary edit and apply_patch agree on allow and block; whole-file and undefined-language routes refused with bounded diagnostics');
  }
  {
  const approvalRegistryPath = path.join(tmp, 'source-approvals.json');
  const approvalClient = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--write', 'workspace', '--tool-mode', 'full'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CODEXPRO_ROOT: tmp,
      CODEXPRO_ALLOWED_ROOTS: tmp,
      CODEXPRO_BASH_MODE: 'off',
      CODEXPRO_WRITE_MODE: 'workspace',
      CODEXPRO_TOOL_MODE: 'full',
      CODEXPRO_TOOL_CARDS: '0',
      CODEXPRO_ANALYSIS: '1',
      CODEXPRO_SOURCE_APPROVALS_FILE: approvalRegistryPath
    }
  });
  try {
  await approvalClient.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-source-approval-smoke', version: '0.1.0' }
  });
  approvalClient.notify('notifications/initialized');
  const approvalOpened = assertToolSuccess(await approvalClient.request('tools/call', {
    name: 'open_current_workspace', arguments: { include_tree: false }
  }), 'approval open_current_workspace');
  const client = approvalClient;
  const workspaceId = approvalOpened.structuredContent.workspace_id;
  assert.ok(workspaceId, 'approval workspace omitted its id');

  // Owner approvals are a native command and bind only exact parser-owned
  // keyword/callee/value triples to the canonical file path. The registry
  // contains digests, never source literals; MCP receives no approval writer.
  const approvalRelativePath = 'source-approval-fixture.py';
  const approvalAbsolutePath = path.join(tmp, approvalRelativePath);
  const approvalSource = [
    '# approval marker: before',
    'def run():',
    '    send(token="APPROVED_OWNER_ALPHA", work_token=None)',
    '    client.session.send(token="APPROVED_OWNER_BETA", work_token="APPROVED_OWNER_GAMMA")',
    ''
  ].join('\n');
  const approvalAfterMarker = approvalSource.replace('# approval marker: before', '# approval marker: after');
  const approvalLiterals = ['APPROVED_OWNER_ALPHA', 'APPROVED_OWNER_BETA', 'APPROVED_OWNER_GAMMA'];
  const approvalSnapshot = async (absolutePath) => {
    const bytes = await fs.readFile(absolutePath);
    const stat = await fs.stat(absolutePath, { bigint: true });
    return {
      bytes: bytes.toString('base64'),
      sha256: sha256(bytes.toString('utf8')),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString()
    };
  };
  const approvalCommand = path.resolve('scripts/codexpro.mjs');
  const runApprovalCommand = (sourcePath, expectedSha) => spawnSync(process.execPath, [
    approvalCommand,
    'approve-source',
    sourcePath,
    '--expected-sha', expectedSha,
    '--keywords', 'token,work_token',
    '--registry', approvalRegistryPath
  ], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 20000, maxBuffer: 128 * 1024 });
  await fs.writeFile(approvalAbsolutePath, approvalSource, { encoding: 'utf8', flag: 'wx' });
  const approvalBeforeEnrollment = await approvalSnapshot(approvalAbsolutePath);
  const enrollmentResult = runApprovalCommand(approvalAbsolutePath, sha256(approvalSource));
  assert.equal(enrollmentResult.error?.code ?? null, null, 'codexpro approve-source could not start');
  assert.equal(enrollmentResult.status, 0, `codexpro approve-source failed: ${enrollmentResult.stderr || enrollmentResult.stdout}`);
  expectNoHostileResponseFields({ stdout: enrollmentResult.stdout, stderr: enrollmentResult.stderr }, approvalLiterals, 'owner approval command');
  const enrolledRegistryBytes = await fs.readFile(approvalRegistryPath);
  const enrolledRegistry = JSON.parse(enrolledRegistryBytes.toString('utf8'));
  assert.equal(enrolledRegistry.version, 1, 'approval registry schema version changed');
  assert.equal(enrolledRegistry.files.length, 1, 'owner command enrolled an unexpected file count');
  assert.equal(enrolledRegistry.files[0].path, path.resolve(approvalAbsolutePath), 'owner command did not bind the canonical exact path');
  assert.equal(enrolledRegistry.files[0].source_sha256, sha256(approvalSource), 'owner command omitted the enrollment source hash');
  const expectedApprovalRows = [
    ['token', 'send', '"APPROVED_OWNER_ALPHA"'],
    ['work_token', 'send', 'None'],
    ['token', 'client.session.send', '"APPROVED_OWNER_BETA"'],
    ['work_token', 'client.session.send', '"APPROVED_OWNER_GAMMA"']
  ].map((row) => row.map(sha256).join(':')).sort();
  const actualApprovalRows = enrolledRegistry.files[0].entries.map((row) => [
    row.keyword_sha256,
    row.callee_sha256,
    row.value_sha256
  ].join(':')).sort();
  assert.deepEqual(actualApprovalRows, expectedApprovalRows, 'owner command enrolled a different keyword/callee/value triple set');
  expectNoHostileResponseFields(enrolledRegistry, [...approvalLiterals, 'None'], 'hash-only approval registry');
  assert.deepEqual(await approvalSnapshot(approvalAbsolutePath), approvalBeforeEnrollment, 'owner command changed source bytes or metadata');

  const toolsListResult = assertToolSuccess(await client.request('tools/list', {}), 'approval tools/list');
  const listedTools = toolsListResult.structuredContent?.tools ?? toolsListResult.tools;
  assert.ok(Array.isArray(listedTools) && listedTools.length > 0, 'approval tools/list omitted its tool catalog');
  assert.equal(listedTools.some((tool) => /approve.*source|source.*approve/i.test(String(tool.name))), false, 'MCP exposed an owner approval command');
  for (const toolName of ['write', 'edit']) {
    const schema = listedTools.find((tool) => tool.name === toolName)?.inputSchema?.properties ?? {};
    assert.equal(Object.keys(schema).some((name) => /approval/i.test(name)), false, `${toolName} exposed an approval-writing parameter`);
  }
  const approvedRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read', arguments: { workspace_id: workspaceId, path: approvalRelativePath }
  }), 'approved source read');
  assert.equal(approvedRead.structuredContent.text, numbered(approvalSource), 'approved read changed exact source bytes');
  for (const literal of approvalLiterals) assert.equal(JSON.stringify(approvedRead).includes(literal), true, 'approved read omitted an enrolled literal');
  const approvedWrite = assertToolSuccess(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: approvalRelativePath, content: approvalSource }
  }), 'approved ordinary MCP write');
  assert.equal(await fs.readFile(approvalAbsolutePath, 'utf8'), approvalSource, 'approved write changed exact fixture bytes');
  assert.equal(approvedWrite.structuredContent.sha256, sha256(approvalSource), 'approved write returned a different hash');
  const approvedEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit', arguments: {
      workspace_id: workspaceId,
      path: approvalRelativePath,
      old_text: '# approval marker: before',
      new_text: '# approval marker: after',
      expected_replacements: 1
    }
  }), 'approved unrelated ordinary MCP edit');
  assert.equal(await fs.readFile(approvalAbsolutePath, 'utf8'), approvalAfterMarker, 'unrelated approved edit changed additional source bytes');
  assert.equal(approvedEdit.structuredContent.sha256, sha256(approvalAfterMarker), 'approved edit returned a different resulting hash');
  const approvedReread = assertToolSuccess(await client.request('tools/call', {
    name: 'read', arguments: { workspace_id: workspaceId, path: approvalRelativePath }
  }), 'approved source reread');
  assert.equal(approvedReread.structuredContent.text, numbered(approvalAfterMarker), 'unrelated edit invalidated unchanged approved triples');
  assert.deepEqual(await fs.readFile(approvalRegistryPath), enrolledRegistryBytes, 'unrelated edit rewrote enrollment metadata');

  const syntheticProviderIdentifier = ['gh', 'p_', 'A'.repeat(28)].join('');
  const syntheticJwtValue = [
    ['eyJ', 'hbGciOiJub25lIn0'].join(''),
    ['eyJ', 'zdWIiOiJzeW50aGV0aWMifQ'].join(''),
    'S'.repeat(32)
  ].join('.');
  const syntheticPrivateKeyValue = [
    '-----BEGIN PRIVATE KEY-----',
    'SYNTHETIC_TEST_MATERIAL_ONLY',
    '-----END PRIVATE KEY-----'
  ].join('\n');
  const hostileOpaqueValue = 'Authorization: Bearer OPAQUE_LITERAL';
  const protectedSyntheticValues = [syntheticProviderIdentifier, syntheticJwtValue, syntheticPrivateKeyValue, hostileOpaqueValue, 'OPAQUE_LITERAL'];
  const refusalCases = [
    ['changed credential key', '    send(api_token="APPROVED_OWNER_ALPHA")'],
    ['changed approved value', '    send(token="APPROVED_OWNER_CHANGED")'],
    ['changed approved callee', '    client.session.forward(token="APPROVED_OWNER_ALPHA")'],
    ['approved prefix concatenation', '    send(token="APPROVED_OWNER_ALPHA" + suffix)'],
    ['new unapproved literal sibling', '    send(token="APPROVED_OWNER_UNENROLLED")'],
    ['generic-root concatenated attribute', '    send(token=config.token + suffix)'],
    ['environment-root indexed attribute', '    send(token=os.environ.token[0])'],
    ['generic-root called attribute', '    send(token=config.token())'],
    ['generic-root parenthesized attribute', '    send(token=(config.token))'],
    ['safe argument with hostile sibling', '    send(token=token_ref, password="OPAQUE_LITERAL")'],
    ['credential-shaped identifier root', `    send(token=${syntheticProviderIdentifier})`],
    ['credential-shaped attribute', `    send(token=provider.${syntheticProviderIdentifier})`],
    ['safe annotation followed by opaque same-line header', 'def run(authorization: Mapping[str, str] | None = None, note="Authorization: Bearer OPAQUE_LITERAL"):\n    pass'],
    ['token suite followed by opaque password', 'if token:\n    password="OPAQUE_LITERAL"'],
    ['malformed approved Python edit', '    send(token="APPROVED_OWNER_ALPHA"']
  ];
  async function refuseApprovedEdit(label, insertedSource) {
    const before = await approvalSnapshot(approvalAbsolutePath);
    const topLevelCandidate = label.startsWith('safe annotation') || label.startsWith('token suite');
    const targetText = topLevelCandidate
      ? '# approval marker: after'
      : '    send(token="APPROVED_OWNER_ALPHA", work_token=None)';
    const replacementText = topLevelCandidate
      ? '# approval marker: after\n' + insertedSource
      : insertedSource;
    const candidateSource = approvalAfterMarker.replace(targetText, replacementText);
    const syntaxCheck = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      input: candidateSource, encoding: 'utf8', timeout: 10000
    });
    if (label === 'malformed approved Python edit') {
      assert.notEqual(syntaxCheck.status, 0, 'malformed edit fixture unexpectedly parsed');
    } else {
      assert.equal(syntaxCheck.status, 0, `${label} was malformed before policy evaluation: ${syntaxCheck.stderr || syntaxCheck.stdout}`);
    }
    const result = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: approvalRelativePath,
        old_text: targetText,
        new_text: replacementText,
        expected_replacements: 1
      }
    }), label);
    assert.match(resultText(result), /Secret-looking content is blocked/);
    expectNoHostileResponseFields(result, [...approvalLiterals, ...protectedSyntheticValues], label);
    assert.deepEqual(await approvalSnapshot(approvalAbsolutePath), before, `${label} changed bytes, hash, inode, size, or mtime`);
  }
  for (const [label, source] of refusalCases) await refuseApprovedEdit(label, source);
  for (const [label, source] of [
    ['complete generic-root dotted reference', 'send(token=config.token)'],
    ['complete environment-root dotted reference', 'send(token=os.environ.token)']
  ]) {
    const before = await fs.readFile(approvalAbsolutePath, 'utf8');
    const after = before.replace('# approval marker: after', '# approval marker: after\n' + source);
    assert.notEqual(after, before, `${label} insertion anchor was missing`);
    assertPythonAstAccepted(after, label);
    const allowed = assertToolSuccess(await client.request('tools/call', {
      name: 'edit',
      arguments: {
        workspace_id: workspaceId,
        path: approvalRelativePath,
        old_text: '# approval marker: after',
        new_text: '# approval marker: after\n' + source,
        expected_replacements: 1
      }
    }), label);
    assert.equal(await fs.readFile(approvalAbsolutePath, 'utf8'), after, `${label} edit changed unexpected bytes`);
    assert.equal(allowed.structuredContent.sha256, sha256(after), `${label} edit returned an incorrect source hash`);
  }
  assert.deepEqual(await fs.readFile(approvalRegistryPath), enrolledRegistryBytes, 'complete dotted references changed owner approval metadata');
  for (const [label, value] of [
    ['provider-shaped approved literal', syntheticProviderIdentifier],
    ['JWT-shaped approved literal', syntheticJwtValue],
    ['private-key approved literal', syntheticPrivateKeyValue],
    ['Authorization-header approved literal', hostileOpaqueValue]
  ]) {
    const source = `send(token=${JSON.stringify(value)})\n`;
    const file = path.join(tmp, `approval-refusal-${label.replaceAll(/[^a-z0-9]+/giu, '-')}.py`);
    await fs.writeFile(file, source, { encoding: 'utf8', flag: 'wx' });
    const sourceBefore = await approvalSnapshot(file);
    const registryBefore = await fs.readFile(approvalRegistryPath);
    const rejected = runApprovalCommand(file, sha256(source));
    assert.equal(rejected.error?.code ?? null, null, `${label} enrollment command could not start`);
    assert.notEqual(rejected.status, 0, `${label} enrollment unexpectedly succeeded`);
    expectNoHostileResponseFields({ stdout: rejected.stdout, stderr: rejected.stderr }, protectedSyntheticValues, `${label} enrollment refusal`);
    assert.deepEqual(await approvalSnapshot(file), sourceBefore, `${label} enrollment changed source bytes or metadata`);
    assert.deepEqual(await fs.readFile(approvalRegistryPath), registryBefore, `${label} enrollment changed the registry`);
  }

  const sourceBeforeStaleApproval = await approvalSnapshot(approvalAbsolutePath);
  const staleRegistryBeforeAttempt = await fs.readFile(approvalRegistryPath);
  const staleApproval = runApprovalCommand(approvalAbsolutePath, '0'.repeat(64));
  assert.notEqual(staleApproval.status, 0, 'stale expected source SHA was accepted');
  assert.deepEqual(await approvalSnapshot(approvalAbsolutePath), sourceBeforeStaleApproval, 'stale SHA changed source identity');
  assert.deepEqual(await fs.readFile(approvalRegistryPath), staleRegistryBeforeAttempt, 'stale expected source SHA changed the registry');
  const malformedApprovalPath = path.join(tmp, 'approval-malformed.py');
  const malformedApprovalSource = 'send(token="APPROVED_OWNER_SAFE")\ndef broken(:\n';
  await fs.writeFile(malformedApprovalPath, malformedApprovalSource, { encoding: 'utf8', flag: 'wx' });
  const malformedApprovalBefore = await approvalSnapshot(malformedApprovalPath);
  const registryBeforeMalformedEnrollment = await fs.readFile(approvalRegistryPath);
  const malformedEnrollment = runApprovalCommand(malformedApprovalPath, sha256(malformedApprovalSource));
  assert.notEqual(malformedEnrollment.status, 0, 'malformed source enrollment unexpectedly succeeded');
  assert.deepEqual(await approvalSnapshot(malformedApprovalPath), malformedApprovalBefore, 'malformed enrollment changed source bytes or metadata');
  assert.deepEqual(await fs.readFile(approvalRegistryPath), registryBeforeMalformedEnrollment, 'malformed enrollment changed the registry');

  const approvalDiffPath = 'source-approval-diff.py';
  const unapprovedDiffPath = 'source-approval-unapproved-diff.py';
  const approvalDiffSource = '# diff marker: before\ndef run():\n    send(token="APPROVED_DIFF_VALUE")\n';
  const approvalDiffAfter = approvalDiffSource.replace('# diff marker: before', '# diff marker: after');
  await fs.writeFile(path.join(tmp, approvalDiffPath), approvalDiffSource, { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(path.join(tmp, unapprovedDiffPath), approvalDiffSource, { encoding: 'utf8', flag: 'wx' });
  const stageApprovalDiffFixtures = spawnSync('git', ['add', '--', approvalDiffPath, unapprovedDiffPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(stageApprovalDiffFixtures.status, 0, `approval diff fixture staging failed: ${stageApprovalDiffFixtures.stderr || stageApprovalDiffFixtures.stdout}`);
  const commitApprovalDiffFixtures = spawnSync('git', ['-c', 'user.email=source-redaction-smoke@example.com', '-c', 'user.name=Source Redaction Smoke', 'commit', '-m', 'approval diff fixture'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(commitApprovalDiffFixtures.status, 0, `approval diff fixture commit failed: ${commitApprovalDiffFixtures.stderr || commitApprovalDiffFixtures.stdout}`);
  const diffApprovalFile = path.join(tmp, approvalDiffPath);
  const diffApprovalResult = runApprovalCommand(diffApprovalFile, sha256(approvalDiffSource));
  assert.equal(diffApprovalResult.status, 0, `approved diff-side enrollment failed: ${diffApprovalResult.stderr || diffApprovalResult.stdout}`);
  await fs.writeFile(diffApprovalFile, approvalDiffAfter, 'utf8');
  const approvedGitDiff = spawnSync('git', ['diff', '--no-ext-diff', '--unified=3', '--', approvalDiffPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(approvedGitDiff.status, 0, `approved-side Git diff failed: ${approvedGitDiff.stderr || approvedGitDiff.stdout}`);
  assert.equal(approvedGitDiff.stdout.includes(`a/${approvalDiffPath}`) && approvedGitDiff.stdout.includes(`b/${approvalDiffPath}`), true, 'approved-side patch omitted its exact old/new path');
  await fs.writeFile(diffApprovalFile, approvalDiffSource, 'utf8');
  const approvedDiffApply = assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: approvedGitDiff.stdout }
  }), 'Git-produced approved-side apply_patch');
  assert.deepEqual(approvedDiffApply.structuredContent.paths, [approvalDiffPath], 'approved-side apply_patch changed an unexpected path');
  assert.equal(await fs.readFile(diffApprovalFile, 'utf8'), approvalDiffAfter, 'approved-side apply_patch changed unexpected bytes');

  const approvalDiffAfterCommit = spawnSync('git', ['add', '--', approvalDiffPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(approvalDiffAfterCommit.status, 0, `approved-side diff commit staging failed: ${approvalDiffAfterCommit.stderr || approvalDiffAfterCommit.stdout}`);
  const approvalDiffCommit = spawnSync('git', ['-c', 'user.email=source-redaction-smoke@example.com', '-c', 'user.name=Source Redaction Smoke', 'commit', '-m', 'approved-side diff baseline'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(approvalDiffCommit.status, 0, `approved-side diff baseline commit failed: ${approvalDiffCommit.stderr || approvalDiffCommit.stdout}`);
  const approvalDiffFinal = approvalDiffAfter.replace('# diff marker: after', '# diff marker: final');
  await fs.writeFile(diffApprovalFile, approvalDiffFinal, 'utf8');
  await fs.writeFile(path.join(tmp, unapprovedDiffPath), approvalDiffAfter, 'utf8');
  const mixedApprovalDiff = spawnSync('git', ['diff', '--no-ext-diff', '--unified=3', '--', approvalDiffPath, unapprovedDiffPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(mixedApprovalDiff.status, 0, `mixed approval-side Git diff failed: ${mixedApprovalDiff.stderr || mixedApprovalDiff.stdout}`);
  await fs.writeFile(diffApprovalFile, approvalDiffAfter, 'utf8');
  await fs.writeFile(path.join(tmp, unapprovedDiffPath), approvalDiffSource, 'utf8');
  const approvedDiffBeforeRefusal = await approvalSnapshot(diffApprovalFile);
  const unapprovedDiffBeforeRefusal = await approvalSnapshot(path.join(tmp, unapprovedDiffPath));
  const mixedApprovalRefusal = assertToolError(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: mixedApprovalDiff.stdout }
  }), 'Git-produced approved plus unapproved diff-side agreement');
  assert.match(resultText(mixedApprovalRefusal), /Secret-looking content is blocked/);
  expectNoHostileResponseFields(mixedApprovalRefusal, ['APPROVED_DIFF_VALUE'], 'mixed approval-side refusal');
  assert.deepEqual(await approvalSnapshot(diffApprovalFile), approvedDiffBeforeRefusal, 'mixed approval-side refusal changed approved file bytes or metadata');
  assert.deepEqual(await approvalSnapshot(path.join(tmp, unapprovedDiffPath)), unapprovedDiffBeforeRefusal, 'mixed approval-side refusal changed unapproved sibling bytes or metadata');

  async function prepareRenameDiff(oldPath, newPath, approveNewSide) {
    const oldSource = '# rename marker: before\ndef run():\n    send(token="APPROVED_RENAME_VALUE")\n';
    const newSource = oldSource.replace('# rename marker: before', '# rename marker: after');
    const oldAbsolute = path.join(tmp, oldPath);
    const newAbsolute = path.join(tmp, newPath);
    await fs.writeFile(oldAbsolute, oldSource, { encoding: 'utf8', flag: 'wx' });
    const stageOld = spawnSync('git', ['add', '--', oldPath], { cwd: tmp, encoding: 'utf8' });
    assert.equal(stageOld.status, 0, `rename source staging failed: ${stageOld.stderr || stageOld.stdout}`);
    const commitOld = spawnSync('git', ['-c', 'user.email=source-redaction-smoke@example.com', '-c', 'user.name=Source Redaction Smoke', 'commit', '-m', `rename source ${oldPath}`], { cwd: tmp, encoding: 'utf8' });
    assert.equal(commitOld.status, 0, `rename source commit failed: ${commitOld.stderr || commitOld.stdout}`);
    const approveOld = runApprovalCommand(oldAbsolute, sha256(oldSource));
    assert.equal(approveOld.status, 0, `rename old-side approval failed: ${approveOld.stderr || approveOld.stdout}`);
    if (approveNewSide) {
      await fs.writeFile(newAbsolute, newSource, { encoding: 'utf8', flag: 'wx' });
      const approveNew = runApprovalCommand(newAbsolute, sha256(newSource));
      assert.equal(approveNew.status, 0, `rename new-side approval failed: ${approveNew.stderr || approveNew.stdout}`);
      await fs.rm(newAbsolute);
    }
    await fs.writeFile(newAbsolute, newSource, { encoding: 'utf8', flag: 'wx' });
    await fs.rm(oldAbsolute);
    const stageRename = spawnSync('git', ['add', '-A', '--', oldPath, newPath], { cwd: tmp, encoding: 'utf8' });
    assert.equal(stageRename.status, 0, `rename candidate staging failed: ${stageRename.stderr || stageRename.stdout}`);
    const renameDiff = spawnSync('git', ['diff', '--cached', '--find-renames', '--no-ext-diff', '--unified=3', '--', oldPath, newPath], { cwd: tmp, encoding: 'utf8' });
    assert.equal(renameDiff.status, 0, `rename-side Git diff failed: ${renameDiff.stderr || renameDiff.stdout}`);
    assert.equal(renameDiff.stdout.includes(`rename from ${oldPath}`) && renameDiff.stdout.includes(`rename to ${newPath}`), true, 'Git did not produce the expected two-sided rename patch');
    const resetRename = spawnSync('git', ['reset', '--hard', 'HEAD'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(resetRename.status, 0, `rename fixture reset failed: ${resetRename.stderr || resetRename.stdout}`);
    assert.equal(await fs.readFile(oldAbsolute, 'utf8'), oldSource, 'rename patch setup did not restore the old-side source');
    await assert.rejects(fs.access(newAbsolute), (error) => error?.code === 'ENOENT');
    return { oldSource, newSource, diff: renameDiff.stdout, oldAbsolute, newAbsolute };
  }

  const approvedRename = await prepareRenameDiff('source-approval-rename-old.py', 'source-approval-rename-new.py', true);
  assertToolSuccess(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: approvedRename.diff }
  }), 'Git-produced rename with both source sides approved');
  await assert.rejects(fs.access(approvedRename.oldAbsolute), (error) => error?.code === 'ENOENT');
  assert.equal(await fs.readFile(approvedRename.newAbsolute, 'utf8'), approvedRename.newSource, 'approved two-sided rename changed resulting bytes');

  const oneSidedRename = await prepareRenameDiff('source-approval-one-sided-old.py', 'source-approval-one-sided-new.py', false);
  const oneSidedOldBefore = await approvalSnapshot(oneSidedRename.oldAbsolute);
  const oneSidedNewBefore = await fs.access(oneSidedRename.newAbsolute).then(() => 'present').catch((error) => {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  });
  const oneSidedRenameRefusal = assertToolError(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: oneSidedRename.diff }
  }), 'Git-produced rename with only old source side approved');
  assert.match(resultText(oneSidedRenameRefusal), /Secret-looking content is blocked/);
  expectNoHostileResponseFields(oneSidedRenameRefusal, ['APPROVED_RENAME_VALUE'], 'one-sided rename refusal');
  assert.deepEqual(await approvalSnapshot(oneSidedRename.oldAbsolute), oneSidedOldBefore, 'one-sided rename refusal changed old-side bytes or metadata');
  const oneSidedNewAfter = await fs.access(oneSidedRename.newAbsolute).then(() => 'present').catch((error) => {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  });
  assert.equal(oneSidedNewAfter, oneSidedNewBefore, 'one-sided rename refusal changed new-side presence');

  const fstringRelativePath = 'source-approval-fstrings.py';
  const fstringAbsolutePath = path.join(tmp, fstringRelativePath);
  const fstringSource = [
    '# fstring approval marker: before',
    'def run(token_ref, count, batch):',
    '    send(token=f"scope-{token_ref}", work_token=f"count-{count:04d}")',
    '    client.session.send(token=f"batch-{batch:02d}", work_token=None)',
    ''
  ].join('\n');
  const fstringAfterMarker = fstringSource.replace(
    '# fstring approval marker: before',
    '# fstring approval marker: after'
  );
  const fstringCallLine = '    send(token=f"scope-{token_ref}", work_token=f"count-{count:04d}")';
  const fstringValues = ['f"scope-{token_ref}"', 'f"count-{count:04d}"', 'f"batch-{batch:02d}"'];
  const fstringLiterals = ['scope-', 'count-', 'batch-', 'FSTRING_MARK'];
  await fs.writeFile(fstringAbsolutePath, fstringSource, { encoding: 'utf8', flag: 'wx' });
  const fstringBeforeEnrollment = await approvalSnapshot(fstringAbsolutePath);
  const unapprovedFstringRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read', arguments: { workspace_id: workspaceId, path: fstringRelativePath }
  }), 'unapproved f-string source read');
  assert.equal(typeof unapprovedFstringRead.structuredContent.text, 'string', 'unenrolled f-string source read omitted its typed text result');
  const unapprovedFstringEdit = assertToolError(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: fstringRelativePath,
      old_text: '# fstring approval marker: before',
      new_text: '# fstring approval marker: after',
      expected_replacements: 1
    }
  }), 'unenrolled f-string unrelated edit');
  assert.match(resultText(unapprovedFstringEdit), /Secret-looking content is blocked/);
  assert.deepEqual(await approvalSnapshot(fstringAbsolutePath), fstringBeforeEnrollment, 'unenrolled f-string edit changed bytes or metadata');

  const fstringEnrollment = runApprovalCommand(fstringAbsolutePath, sha256(fstringSource));
  assert.equal(fstringEnrollment.error?.code ?? null, null, 'f-string owner enrollment command could not start');
  assert.equal(fstringEnrollment.status, 0, `owner CLI rejected complete parser-owned f-string values: ${fstringEnrollment.stderr || fstringEnrollment.stdout}`);
  expectNoHostileResponseFields({ stdout: fstringEnrollment.stdout, stderr: fstringEnrollment.stderr }, fstringLiterals, 'f-string owner enrollment');
  const fstringRegistryBytes = await fs.readFile(approvalRegistryPath);
  const fstringRegistry = JSON.parse(fstringRegistryBytes.toString('utf8'));
  const fstringEntry = fstringRegistry.files.find((entry) => entry.path === path.resolve(fstringAbsolutePath));
  assert.ok(fstringEntry, 'owner registry omitted the exact f-string source path');
  assert.equal(fstringEntry.source_sha256, sha256(fstringSource), 'f-string registry entry omitted its enrollment source hash');
  const expectedFstringRows = [
    ['token', 'send', fstringValues[0]],
    ['work_token', 'send', fstringValues[1]],
    ['token', 'client.session.send', fstringValues[2]],
    ['work_token', 'client.session.send', 'None']
  ].map((row) => row.map(sha256).join(':')).sort();
  const actualFstringRows = fstringEntry.entries.map((row) => [row.keyword_sha256, row.callee_sha256, row.value_sha256].join(':')).sort();
  assert.deepEqual(actualFstringRows, expectedFstringRows, 'owner registry omitted or widened exact f-string RHS approvals');
  expectNoHostileResponseFields(fstringEntry, fstringLiterals, 'f-string approval entry');
  assert.deepEqual(await approvalSnapshot(fstringAbsolutePath), fstringBeforeEnrollment, 'f-string owner enrollment changed source bytes or metadata');
  const fstringRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read', arguments: { workspace_id: workspaceId, path: fstringRelativePath }
  }), 'approved f-string source read');
  assert.equal(fstringRead.structuredContent.text, numbered(fstringSource), 'approved f-string read changed exact source bytes');
  const fstringWrite = assertToolSuccess(await client.request('tools/call', {
    name: 'write', arguments: { workspace_id: workspaceId, path: fstringRelativePath, content: fstringSource }
  }), 'approved f-string ordinary MCP write');
  assert.equal(fstringWrite.structuredContent.sha256, sha256(fstringSource), 'approved f-string write returned an incorrect hash');
  const fstringMarkerEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: fstringRelativePath,
      old_text: '# fstring approval marker: before',
      new_text: '# fstring approval marker: after',
      expected_replacements: 1
    }
  }), 'approved f-string unrelated MCP edit');
  assert.equal(await fs.readFile(fstringAbsolutePath, 'utf8'), fstringAfterMarker, 'approved f-string edit changed unexpected bytes');
  assert.equal(fstringMarkerEdit.structuredContent.sha256, sha256(fstringAfterMarker), 'approved f-string edit returned an incorrect hash');
  assert.deepEqual(await fs.readFile(approvalRegistryPath), fstringRegistryBytes, 'unrelated f-string edit rewrote approval rows');

  const dottedFstringRelativePath = 'source-approval-fstring-dotted.py';
  const dottedFstringAbsolutePath = path.join(tmp, dottedFstringRelativePath);
  const dottedFstringSource = '# dotted fstring marker: before\ndef run(context):\n    send(token=f"member-{context.scope}")\n';
  await fs.writeFile(dottedFstringAbsolutePath, dottedFstringSource, { encoding: 'utf8', flag: 'wx' });
  const dottedFstringBefore = await approvalSnapshot(dottedFstringAbsolutePath);
  const dottedFstringEnrollment = runApprovalCommand(dottedFstringAbsolutePath, sha256(dottedFstringSource));
  assert.equal(dottedFstringEnrollment.status, 0, `owner CLI rejected a complete f-string with a dotted-member interpolation: ${dottedFstringEnrollment.stderr || dottedFstringEnrollment.stdout}`);
  const dottedFstringRegistryBytes = await fs.readFile(approvalRegistryPath);
  const dottedFstringRegistry = JSON.parse(dottedFstringRegistryBytes.toString('utf8'));
  const dottedFstringEntry = dottedFstringRegistry.files.find((entry) => entry.path === path.resolve(dottedFstringAbsolutePath));
  assert.ok(dottedFstringEntry, 'owner registry omitted the dotted f-string source path');
  assert.deepEqual(
    dottedFstringEntry.entries.map((row) => [row.keyword_sha256, row.callee_sha256, row.value_sha256].join(':')),
    [['token', 'send', 'f"member-{context.scope}"'].map(sha256).join(':')],
    'dotted-member f-string approval did not bind the exact whole RHS'
  );
  assert.deepEqual(await approvalSnapshot(dottedFstringAbsolutePath), dottedFstringBefore, 'dotted f-string enrollment changed source bytes or metadata');
  const dottedFstringRead = assertToolSuccess(await client.request('tools/call', {
    name: 'read', arguments: { workspace_id: workspaceId, path: dottedFstringRelativePath }
  }), 'approved dotted-member f-string read');
  assert.equal(dottedFstringRead.structuredContent.text, numbered(dottedFstringSource), 'approved dotted-member f-string read changed source bytes');
  const dottedFstringEdit = assertToolSuccess(await client.request('tools/call', {
    name: 'edit',
    arguments: {
      workspace_id: workspaceId,
      path: dottedFstringRelativePath,
      old_text: '# dotted fstring marker: before',
      new_text: '# dotted fstring marker: after',
      expected_replacements: 1
    }
  }), 'approved dotted-member f-string unrelated edit');
  assert.equal(await fs.readFile(dottedFstringAbsolutePath, 'utf8'), dottedFstringSource.replace('before', 'after'), 'dotted f-string edit changed unexpected bytes');
  assert.deepEqual(await fs.readFile(approvalRegistryPath), dottedFstringRegistryBytes, 'dotted f-string edit rewrote approval rows');

  const fstringProviderIdentifier = syntheticProviderIdentifier;
  const rejectedFstringEnrollmentValues = [
    ['call interpolation', 'f"scope-{token_factory()}"'],
    ['indexed interpolation', 'f"scope-{tokens[0]}"'],
    ['arithmetic interpolation', 'f"scope-{count + 1}"'],
    ['dynamic nested format specification', 'f"count-{count:{width}}"'],
    ['arithmetic around f-string', '(f"scope-{token_ref}" + suffix)'],
    ['indexed f-string expression', 'f"scope-{token_ref}"[0]'],
    ['concatenated f-string expression', 'f"scope-{token_ref}" + suffix'],
    ['called f-string expression', 'wrap(f"scope-{token_ref}")'],
    ['credential in f-string raw part', 'f"scope-' + fstringProviderIdentifier + '"'],
    ['credential-shaped f-string interpolation root', 'f"{' + fstringProviderIdentifier + '}"'],
    ['credential-shaped f-string interpolation attribute', 'f"{provider.' + fstringProviderIdentifier + '}"']
  ];
  for (const [label, rhs] of rejectedFstringEnrollmentValues) {
    const source = `def run(token_ref, count, tokens, width):\n    send(token=${rhs})\n`;
    assertPythonAstAccepted(source, `f-string ${label} enrollment source`);
    const file = path.join(tmp, `fstring-enrollment-refusal-${label.replaceAll(/[^a-z0-9]+/giu, '-')}.py`);
    await fs.writeFile(file, source, { encoding: 'utf8', flag: 'wx' });
    const sourceBefore = await approvalSnapshot(file);
    const registryBefore = await fs.readFile(approvalRegistryPath);
    const rejected = runApprovalCommand(file, sha256(source));
    assert.equal(rejected.error?.code ?? null, null, `f-string ${label} enrollment command could not start`);
    assert.notEqual(rejected.status, 0, `owner command enrolled ineligible f-string ${label}`);
    expectNoHostileResponseFields({ stdout: rejected.stdout, stderr: rejected.stderr }, [fstringProviderIdentifier], `f-string ${label} enrollment refusal`);
    assert.deepEqual(await approvalSnapshot(file), sourceBefore, `f-string ${label} enrollment changed source bytes or metadata`);
    assert.deepEqual(await fs.readFile(approvalRegistryPath), registryBefore, `f-string ${label} enrollment changed the registry`);
  }
  const fstringRefusalCases = [
    ['changed f-string interpolation', '    send(token=f"scope-{other_ref}", work_token=f"count-{count:04d}")', true],
    ['changed f-string format specification', '    send(token=f"scope-{token_ref}", work_token=f"count-{count:05d}")', true],
    ['changed f-string credential key', '    send(api_token=f"scope-{token_ref}", work_token=f"count-{count:04d}")', true],
    ['changed f-string callee', '    client.forward(token=f"scope-{token_ref}", work_token=f"count-{count:04d}")', true],
    ['f-string concatenation', '    send(token=f"scope-{token_ref}" + suffix, work_token=f"count-{count:04d}")', true],
    ['f-string indexing', '    send(token=f"scope-{token_ref}"[0], work_token=f"count-{count:04d}")', true],
    ['f-string function call', '    send(token=wrap(f"scope-{token_ref}"), work_token=f"count-{count:04d}")', true],
    ['parenthesized f-string', '    send(token=(f"scope-{token_ref}"), work_token=f"count-{count:04d}")', true],
    ['approved f-string with hostile sibling', '    send(token=f"scope-{token_ref}", work_token=f"count-{count:04d}", password="OPAQUE_LITERAL")', true],
    ['provider in f-string literal segment', '    send(token=f"scope-' + fstringProviderIdentifier + '")', true],
    ['provider identifier in f-string interpolation root', '    send(token=f"{' + fstringProviderIdentifier + '}")', true],
    ['provider identifier in f-string interpolation attribute', '    send(token=f"{provider.' + fstringProviderIdentifier + '}")', true],
    ['malformed f-string interpolation', '    send(token=f"scope-{token_ref", work_token=f"count-{count:04d}")', false]
  ];
  for (const [label, replacement, syntaxValid] of fstringRefusalCases) {
    const before = await approvalSnapshot(fstringAbsolutePath);
    const candidate = fstringAfterMarker.replace(fstringCallLine, replacement);
    assert.notEqual(candidate, fstringAfterMarker, `${label} did not replace the enrolled call`);
    const syntax = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
      input: candidate, encoding: 'utf8', timeout: 10000
    });
    if (syntaxValid) assert.equal(syntax.status, 0, `${label} candidate was malformed before policy evaluation: ${syntax.stderr || syntax.stdout}`);
    else assert.notEqual(syntax.status, 0, `${label} candidate unexpectedly parsed`);
    const refused = assertToolError(await client.request('tools/call', {
      name: 'edit',
      arguments: { workspace_id: workspaceId, path: fstringRelativePath, old_text: fstringCallLine, new_text: replacement, expected_replacements: 1 }
    }), label);
    assert.match(resultText(refused), /Secret-looking content is blocked/);
    expectNoHostileResponseFields(refused, [...approvalLiterals, ...fstringLiterals, fstringProviderIdentifier], label);
    assert.deepEqual(await approvalSnapshot(fstringAbsolutePath), before, `${label} changed source bytes or metadata`);
  }

  const fstringDiffPath = 'source-approval-fstring-diff.py';
  const fstringUnapprovedDiffPath = 'source-approval-fstring-unapproved-diff.py';
  const fstringDiffSource = '# fstring diff marker: before\ndef run(token_ref):\n    send(token=f"diff-{token_ref}")\n';
  const fstringDiffAfter = fstringDiffSource.replace('# fstring diff marker: before', '# fstring diff marker: after');
  await fs.writeFile(path.join(tmp, fstringDiffPath), fstringDiffSource, { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(path.join(tmp, fstringUnapprovedDiffPath), fstringDiffSource, { encoding: 'utf8', flag: 'wx' });
  const stageFstringDiffFixtures = spawnSync('git', ['add', '--', fstringDiffPath, fstringUnapprovedDiffPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(stageFstringDiffFixtures.status, 0, `f-string diff fixture staging failed: ${stageFstringDiffFixtures.stderr || stageFstringDiffFixtures.stdout}`);
  const commitFstringDiffFixtures = spawnSync('git', ['-c', 'user.email=source-redaction-smoke@example.com', '-c', 'user.name=Source Redaction Smoke', 'commit', '-m', 'f-string approval diff fixture'], { cwd: tmp, encoding: 'utf8' });
  assert.equal(commitFstringDiffFixtures.status, 0, `f-string diff fixture commit failed: ${commitFstringDiffFixtures.stderr || commitFstringDiffFixtures.stdout}`);
  const fstringDiffAbsolute = path.join(tmp, fstringDiffPath);
  const fstringDiffEnrollment = runApprovalCommand(fstringDiffAbsolute, sha256(fstringDiffSource));
  assert.equal(fstringDiffEnrollment.status, 0, `f-string diff path enrollment failed: ${fstringDiffEnrollment.stderr || fstringDiffEnrollment.stdout}`);
  await fs.writeFile(fstringDiffAbsolute, fstringDiffAfter, 'utf8');
  await fs.writeFile(path.join(tmp, fstringUnapprovedDiffPath), fstringDiffAfter, 'utf8');
  const fstringMixedDiff = spawnSync('git', ['diff', '--no-ext-diff', '--unified=3', '--', fstringDiffPath, fstringUnapprovedDiffPath], { cwd: tmp, encoding: 'utf8' });
  assert.equal(fstringMixedDiff.status, 0, `f-string mixed-side Git diff failed: ${fstringMixedDiff.stderr || fstringMixedDiff.stdout}`);
  await fs.writeFile(fstringDiffAbsolute, fstringDiffSource, 'utf8');
  await fs.writeFile(path.join(tmp, fstringUnapprovedDiffPath), fstringDiffSource, 'utf8');
  const approvedFstringDiffBefore = await approvalSnapshot(fstringDiffAbsolute);
  const unapprovedFstringDiffBefore = await approvalSnapshot(path.join(tmp, fstringUnapprovedDiffPath));
  const fstringMixedRefusal = assertToolError(await client.request('tools/call', {
    name: 'apply_patch', arguments: { workspace_id: workspaceId, patch: fstringMixedDiff.stdout }
  }), 'f-string diff path approval does not donate to sibling');
  assert.match(resultText(fstringMixedRefusal), /Secret-looking content is blocked/);
  expectNoHostileResponseFields(fstringMixedRefusal, ['diff-'], 'f-string mixed-side refusal');
  assert.deepEqual(await approvalSnapshot(fstringDiffAbsolute), approvedFstringDiffBefore, 'f-string diff refusal changed approved-side bytes or metadata');
  assert.deepEqual(await approvalSnapshot(path.join(tmp, fstringUnapprovedDiffPath)), unapprovedFstringDiffBefore, 'f-string diff refusal changed unapproved-side bytes or metadata');
  console.log('SOURCE_APPROVAL_MATRIX: owner CLI hash-only enrollment; ordinary MCP approval/read/write/edit/refusal; registry non-mutation; exact Git diff path-side agreement');
  } finally {
    let closeTimer;
    const childExit = approvalClient.child.exitCode !== null || approvalClient.child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => approvalClient.child.once('exit', resolve));
    approvalClient.child.stdin.end();
    try {
      await Promise.race([
        childExit,
        new Promise((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('approval stdio server did not exit after stdin close')), 10000);
        })
      ]);
    } finally {
      clearTimeout(closeTimer);
    }
  }
  }

  console.log(`source-redaction-smoke: PASS (real MCP read/search/read_many; ranged lawful/hostile/private and byte-limit coverage; ${negativePaths.length} negative fixtures; write/edit/apply_patch compatibility)`);
} finally {
  client?.close();
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`PYTHON_CALL_KEYWORD_MATRIX: ${pythonCallKeywordCheckCount - pythonCallKeywordFailures.length}/${pythonCallKeywordCheckCount} checks passed; ${pythonCallKeywordFailures.length} failed.`);
assert.deepEqual(pythonCallKeywordFailures, [], `Python call-keyword regression failures: ${pythonCallKeywordFailures.join('; ')}`);
