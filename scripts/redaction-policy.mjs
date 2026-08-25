const REDACTED_SECRET = '[REDACTED_SECRET]';
export const PRIVATE_KEY_REDACTION_MARKER = '[REDACTED_PRIVATE_KEY]';

const PRIVATE_KEY_LABELS = [
  'PRIVATE KEY',
  'ENCRYPTED PRIVATE KEY',
  'RSA PRIVATE KEY',
  'EC PRIVATE KEY',
  'DSA PRIVATE KEY',
  'OPENSSH PRIVATE KEY',
  'PGP PRIVATE KEY BLOCK'
];
const PRIVATE_KEY_LABEL_PATTERN = PRIVATE_KEY_LABELS.map((label) => label.replaceAll(' ', '\\s+')).join('|');
const PRIVATE_BEGIN_PATTERN = new RegExp(`-----BEGIN\\s+(?:${PRIVATE_KEY_LABEL_PATTERN})-----`, 'gi');
const PRIVATE_PARTIAL_PATTERN = new RegExp(`-----BEGIN\\s+(?:${PRIVATE_KEY_LABEL_PATTERN})-*(?:\\r?\\n|$)`, 'i');

const REFERENCE_CALL = '[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*\\s*\\([^;\\r\\n]*\\)';
const CREDENTIAL_LABEL = '[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}';
const CREDENTIAL_VALUE = `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|(?:${REFERENCE_CALL})(?=[\\s,;}\\]]|$)|[^\\s"'\\x60<>\\[\\]{},;]+)`;
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(`\\b(${CREDENTIAL_LABEL}\\s*=\\s*)(${CREDENTIAL_VALUE})`, 'gi');
const CREDENTIAL_FIELD_PATTERN = new RegExp(`(["']?${CREDENTIAL_LABEL}["']?\\s*:\\s*)(${CREDENTIAL_VALUE})`, 'gi');
// A typed declaration keeps the credential label and its annotation in one
// prefix, so the initializer can be redacted without treating the annotation
// (including an inline object type or generic tail) as a credential value.
const TYPED_DECLARATION_ASSIGNMENT_PATTERN = new RegExp(`((?:^|[;\\n])\\s*(?:(?:\\d+\\s*\\|\\s*)|(?:[^:\\r\\n]+:\\d+\\s*:\\s*))?(?:(?:export\\s+)?(?:const|let|var)\\s+)?${CREDENTIAL_LABEL}\\s*:\\s*[^=\\r\\n]{1,512}?\\s*=\\s*)(${CREDENTIAL_VALUE})`, 'gim');

const AUTHORIZATION_PATTERN = /\b(Authorization\s*:\s*)([^\r\n]*)/gi;
const CLI_TOKEN_PATTERN = /((?:\bngrok\s+config\s+add-authtoken|\bcloudflared\s+service\s+install|--(?:token|access-token|auth-token|api[_-]?key|authtoken))(?:=|[ \t]+))(?:("[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`<>]+))/gi;
const QUERY_TOKEN_PATTERN = /([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)([^&\s"'`<>]+)/gi;
const CREDENTIAL_URL_PATTERN = /\b((?:https?|wss?):\/\/)[^/\s:@]+:([^@\s/]+)@/gi;
const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const COMMON_TOKEN_PATTERN = /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g;
const JWT_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

const EXACT_PLACEHOLDERS = new Set([
  REDACTED_SECRET.toLowerCase(),
  PRIVATE_KEY_REDACTION_MARKER.toLowerCase(),
  'replace-me',
  'replace-with-long-random-token',
  'keep-this-codexpro-token-stable',
  'keep-this-stable-token',
  'your-ngrok-token',
  'your-token',
  'your-api-key-here',
  '<openai_api_key>',
  'sk-...'
]);
const REFERENCE_ROOTS = /^(?:config|credentials|process|env|settings|secrets|options|runtime|context|this|import|os)$/i;
const HORIZONTAL_WHITESPACE = /[^\S\r\n]/u;
const MAX_GENERIC_TAIL_LENGTH = 512;
const MAX_GENERIC_TAIL_DEPTH = 16;

function normalizeCredentialValue(value) {
  let normalized = String(value ?? '').trim().replace(/[;,]+$/, '').trim();
  if (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === '`' && last === '`')) {
      normalized = normalized.slice(1, -1).trim();
    }
  }
  return normalized.toLowerCase();
}

function isExactPlaceholder(value) {
  const normalized = normalizeCredentialValue(value);
  if (EXACT_PLACEHOLDERS.has(normalized)) return true;
  return /^(?:process\.env|import\.meta\.env|os\.environ)(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^\]\r\n]+\])*$/u.test(normalized);
}

function isReferenceExpression(value, options = {}) {
  const normalized = String(value ?? '').trim().replace(/[;,]+$/, '').trim();
  if (!normalized) return false;
  if (new RegExp(`^${REFERENCE_CALL}$`).test(normalized)) return true;
  if (/['"`]/.test(normalized)) return false;
  const member = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/);
  return Boolean(member && (options.allowAnyRoot === true || REFERENCE_ROOTS.test(member[1])));
}

const BARE_REFERENCE_PATTERN = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:[,;)}\]:]+)?$/u;

function maskSourceTrivia(text) {
  const source = String(text ?? '');
  const masked = source.split('');
  let state = 'code';
  let quote = '';

  const blank = (index) => {
    if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
  };

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] ?? '';

    if (state === 'line-comment') {
      if (current === '\n' || current === '\r') state = 'code';
      else blank(index);
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        blank(index);
        blank(index + 1);
        index += 1;
        state = 'code';
      } else {
        blank(index);
      }
      continue;
    }
    if (state === 'string') {
      if (current === '\\') {
        blank(index);
        if (index + 1 < source.length) {
          blank(index + 1);
          index += 1;
        }
      } else if (current === quote) {
        blank(index);
        state = 'code';
        quote = '';
      } else {
        blank(index);
      }
      continue;
    }

    if (current === '/' && next === '/') {
      blank(index);
      blank(index + 1);
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (current === '/' && next === '*') {
      blank(index);
      blank(index + 1);
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (current === '`' && source.slice(index, index + 3) === '```') {
      index += 2;
      continue;
    }
    if (current === '#') {
      blank(index);
      state = 'line-comment';
      continue;
    }
    if (current === '"' || current === "'" || current === '`') {
      blank(index);
      state = 'string';
      quote = current;
    }
  }

  return masked.join('');
}

function buildDelimiterPairs(code) {
  const stacks = { '(': [], '[': [], '{': [] };
  const closeToOpen = { ')': '(', ']': '[', '}': '{' };
  const openToClose = new Map();
  const openers = [];
  const enclosing = { '(': new Int32Array(code.length), '{': new Int32Array(code.length) };
  enclosing['('].fill(-1);
  enclosing['{'].fill(-1);

  for (let index = 0; index < code.length; index += 1) {
    const parens = stacks['('];
    const braces = stacks['{'];
    enclosing['('][index] = parens.length > 0 ? parens[parens.length - 1] : -1;
    enclosing['{'][index] = braces.length > 0 ? braces[braces.length - 1] : -1;
    const current = code[index];
    if (stacks[current]) {
      stacks[current].push(index);
      openers.push(index);
      continue;
    }
    const opener = closeToOpen[current];
    if (!opener || stacks[opener].length === 0) continue;
    const open = stacks[opener].pop();
    openToClose.set(open, index);
  }
  return { openToClose, openers, enclosing };
}

function findEnclosingPair(syntax, open, close, offset) {
  const openIndex = syntax.pairs.enclosing[open]?.[offset];
  if (openIndex === undefined || openIndex < 0) return null;
  const closeIndex = syntax.pairs.openToClose.get(openIndex);
  return closeIndex !== undefined && closeIndex > offset ? { open: openIndex, close: closeIndex } : null;
}

function sourceAnchorPrefix(code, offset) {
  let start = 0;
  for (const boundary of [';', '{', '}']) start = Math.max(start, code.lastIndexOf(boundary, offset - 1) + 1);
  return code.slice(start, offset)
    .replace(/^\s*\d+\s*\|\s?/gmu, '')
    .replace(/^\s*[^:\n]+:\d+\s*:\s?/gmu, '')
    .replace(/[ \t\r\n]+$/u, '');
}

function sourceLineBounds(code, offset) {
  const start = code.lastIndexOf('\n', offset - 1) + 1;
  const endAt = code.indexOf('\n', offset);
  return { start, end: endAt < 0 ? code.length : endAt };
}

function hasVariableInitializerAnchor(code, offset) {
  const prefix = sourceAnchorPrefix(code, offset);
  return /(?:^|[\n;{}])\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*:\s*[^=;{}]+)?\s*=\s*$/u.test(prefix);
}

function hasAssignmentAnchor(code, offset, value = '') {
  const prefix = sourceAnchorPrefix(code, offset);
  if (!/(?:^|[\n;{}])\s*(?:[+-]\s*)?[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*$/u.test(prefix)) return false;
  // Compact assignment syntax is ambiguous with env/config records. Retain
  // only the existing root-call compatibility (`TOKEN=getToken(...)`); a
  // compact member or member-call value stays conservative.
  if (!/(?:[A-Za-z_$][A-Za-z0-9_$]*)=\s*$/u.test(prefix)) return true;
  return /^[A-Za-z_$][A-Za-z0-9_$]*\s*\([^;\r\n]*\)$/u.test(String(value ?? '').trim());
}

function genericTailEnd(code, end) {
  let index = end;
  while (index < code.length && HORIZONTAL_WHITESPACE.test(code[index])) index += 1;
  if (code[index] !== '<' && code[index] !== '[') return index;
  const start = index;
  const expectedClosers = { '<': '>', '[': ']' };
  const openers = new Set(Object.keys(expectedClosers));
  const closers = new Set(Object.values(expectedClosers));
  const stack = [];
  for (; index < code.length; index += 1) {
    if (index - start >= MAX_GENERIC_TAIL_LENGTH) return -1;
    const current = code[index];
    if (current === '\n' || current === '\r' || (stack.length > 0 && /[=;{}]/u.test(current))) return -1;
    if (openers.has(current)) {
      stack.push(current);
      if (stack.length > MAX_GENERIC_TAIL_DEPTH) return -1;
    } else if (closers.has(current)) {
      if (expectedClosers[stack[stack.length - 1]] !== current) return -1;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

function genericTailStart(code, end) {
  let index = end;
  while (index < code.length && HORIZONTAL_WHITESPACE.test(code[index])) index += 1;
  return code[index] === '<' || code[index] === '[' ? index : -1;
}

function genericTailRecordEnd(code, start) {
  const line = sourceLineBounds(code, start);
  // Once the bounded parser rejects a tail, consume only the rest of the
  // current physical line. This cannot leak a rejected payload after an
  // internal delimiter, and it cannot consume a later source line.
  return line.end > line.start && code[line.end - 1] === '\r' ? line.end - 1 : line.end;
}

function genericTailBoundaryIsValid(code, start, end) {
  // `]` remains a lawful suffix after an angle generic (`Token<T>[]`), but a
  // second close bracket after a square tail is an unmatched/malformed tail.
  if (code[start] === '[') return /^(?:[^\S\r\n]*(?:[,;=)}:]|#|\/\/|\/\*|\r?\n|$))/u.test(code.slice(end));
  return /^(?:[^\S\r\n]*(?:[,;=)}\]:]|#|\/\/|\/\*|\r?\n|$))/u.test(code.slice(end));
}

function genericTailInfo(code, end) {
  const start = genericTailStart(code, end);
  if (start < 0) return null;
  const parsedEnd = genericTailEnd(code, end);
  const balanced = parsedEnd >= 0 && genericTailBoundaryIsValid(code, start, parsedEnd);
  return {
    start,
    end: balanced ? parsedEnd : genericTailRecordEnd(code, start),
    balanced
  };
}

function credentialValueSpanEnd(text, valueEnd) {
  const genericTail = genericTailInfo(String(text ?? ''), valueEnd);
  return genericTail ? genericTail.end : valueEnd;
}

function hasTypedVariableAnnotationAnchor(code, syntax, offset, assignment = '', value = '') {
  const raw = String(value ?? '').trim();
  const valueStart = offset + assignment.length;
  const valueEnd = valueStart + raw.length;
  const forwardClose = code[valueStart] === '{' ? syntax.pairs.openToClose.get(valueStart) : undefined;
  if (forwardClose !== undefined) {
    const prefix = sourceAnchorPrefix(code, valueStart);
    const suffix = code.slice(forwardClose + 1, forwardClose + 257);
    if (/(?:^|[\n;{}])\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*$/u.test(prefix)
      && /^\s*=/u.test(suffix)) return true;
  }
  const braces = findEnclosingPair(syntax, '{', '}', offset);
  if (braces) {
    const prefix = sourceAnchorPrefix(code, braces.open);
    const suffix = code.slice(braces.close + 1, braces.close + 257);
    if (/(?:^|[\n;{}])\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*$/u.test(prefix)
      && /^\s*=/u.test(suffix)) return true;
  }

  const line = sourceLineBounds(code, valueStart);
  const linePrefix = code.slice(line.start, valueStart).trim()
    .replace(/^(?:\d+\s*\|\s*|[^:\r\n]+:\d+\s*:\s*)/u, '');
  // Keep the simple declaration check line-local. A whole-file prefix can
  // contain unrelated diagnostic records such as `Authorization: ...` and
  // must not be mistaken for a typed declaration ending at this assignment.
  const localPrefixes = [linePrefix];
  if (localPrefixes.some((candidate) => /^(?:(?:export\s+)?(?:const|let|var)\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*[\s\S]{1,512}?=\s*$/u.test(candidate))) return true;
  if (braces) return false;
  const declaration = localPrefixes.some((candidate) => /^(?:(?:export\s+)?(?:const|let|var)\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*$/u.test(candidate));
  if (!declaration) return false;
  const tailEnd = genericTailEnd(code, valueEnd);
  if (tailEnd >= 0 && /^\s*=/u.test(code.slice(tailEnd, tailEnd + 8))) return true;
  const lineEnd = code.indexOf('\n', valueEnd);
  const lineTail = code.slice(valueEnd, lineEnd < 0 ? code.length : lineEnd);
  return /^[^;{}]*=/u.test(lineTail);
}

function hasDestructuringAnchor(code, syntax, offset) {
  const braces = findEnclosingPair(syntax, '{', '}', offset);
  if (!braces) return false;
  const prefix = sourceAnchorPrefix(code, braces.open);
  if (!/(?:^|[\n;{}])\s*(?:export\s+)?(?:const|let|var)\s*$/u.test(prefix)) return false;
  return /^\s*=/.test(code.slice(braces.close + 1));
}

function hasTypeLikeBodyAnchor(code, syntax, offset) {
  const braces = findEnclosingPair(syntax, '{', '}', offset);
  if (!braces) return false;
  const prefix = sourceAnchorPrefix(code, braces.open);
  const genericParameters = '(?:\\s*<[^{}\\n]{1,256}>)?';
  const interfaceAnchor = new RegExp(`(?:^|[\\n;{}])\\s*(?:export\\s+)?interface\\s+[A-Za-z_$][A-Za-z0-9_$]*${genericParameters}(?:\\s+extends[\\s\\S]*)?$`, 'u');
  const classAnchor = new RegExp(`(?:^|[\\n;{}])\\s*(?:export\\s+)?class\\s+[A-Za-z_$][A-Za-z0-9_$]*${genericParameters}(?:\\s+extends[\\s\\S]*)?$`, 'u');
  const typeAnchor = new RegExp(`(?:^|[\\n;{}])\\s*(?:export\\s+)?type\\s+[A-Za-z_$][A-Za-z0-9_$]*${genericParameters}\\s*=\\s*[\\s\\S]*$`, 'u');
  return interfaceAnchor.test(prefix) || classAnchor.test(prefix) || typeAnchor.test(prefix);
}

function hasObjectExpressionAnchor(code, syntax, offset) {
  const braces = findEnclosingPair(syntax, '{', '}', offset);
  if (!braces) return false;
  const prefix = sourceAnchorPrefix(code, braces.open);
  const trimmed = prefix.trim();
  const plainAssignment = /(?:^|[\n;{}])\s*[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*$/u.test(prefix);
  const boundedPrefix = code.slice(Math.max(0, braces.open - 1024), braces.open)
    .replace(/^\s*\d+\s*\|\s?/gmu, '')
    .replace(/^\s*[^:\n]+:\d+\s*:\s?/gmu, '');
  const typedObjectAssignment = /(?:^|[\n;])\s*(?:(?:export\s+)?(?:const|let|var)\s+)?[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*(?:\{[\s\S]{0,768}\}|[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\n]{0,256}>)?(?:\s*\[\])?)\s*=\s*$/u.test(boundedPrefix);
  return hasVariableInitializerAnchor(code, braces.open)
    || plainAssignment
    || typedObjectAssignment
    || /\breturn\s*$/u.test(trimmed)
    || /\bexport\s+default\s*$/u.test(trimmed)
    || /=>\s*\(?\s*$/u.test(trimmed)
    || /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\([^{}]*$/u.test(prefix);
}

function hasParameterAnchor(code, syntax, offset) {
  const parens = findEnclosingPair(syntax, '(', ')', offset);
  if (!parens) return false;
  const tail = code.slice(parens.close + 1, parens.close + 256);
  const arrow = /^\s*(?::\s*[^=\n{};]+)?\s*=>/u.test(tail);
  const declaration = /^\s*(?::\s*[^\n{};]+)?\s*\{|^\s*(?:->\s*[^\n{};]+)?\s*:/u.test(tail);
  if (!arrow && !declaration) return false;
  if (arrow) return true;
  const prefix = sourceAnchorPrefix(code, parens.open);
  return /(?:^|[\n;{}])\s*(?:(?:export\s+)?(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\n]*>)?)?|(?:async\s+)?def\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*[\[<][^>\]\n]*[\]>])?|(?:async\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\n]*>)?)\s*$/u.test(prefix);
}

function pythonIndentationColumn(line) {
  let column = 0;
  for (const character of line) {
    if (character === ' ') {
      column += 1;
      continue;
    }
    if (character === '\t') {
      column += 8 - (column % 8);
      continue;
    }
    // Python's other leading control/Unicode whitespace forms have semantics
    // that this bounded source classifier does not model. Fail closed instead
    // of inventing an indentation ordering for them.
    if (/\s/u.test(character)) return null;
    return column;
  }
  return column;
}

function pythonLayoutLine(source, start, end) {
  const raw = source.slice(start, end);
  let contentStart = start;
  // Public reads add a `N | ` prefix to every physical line. It is framing,
  // not Python syntax, so strip it from the layout while retaining raw source
  // offsets for candidate provenance checks.
  const numbered = raw.match(/^\s*\d+\s*\|\s?/u);
  if (numbered) contentStart += numbered[0].length;
  return { start, end, contentStart, raw };
}

function pythonLayoutDiffLine(source, line) {
  const raw = source.slice(line.start, line.end);
  if (/^(?:diff --git\s|@@\s|---\s|\+\+\+\s|index\s|new file mode\s|old file mode\s|deleted file mode\s|similarity index\s|rename from\s|rename to\s|copy from\s|copy to\s|Binary files\s)/u.test(raw)) {
    return { kind: 'metadata' };
  }
  if (/^\\(?: No newline at end of file)?\s*$/u.test(raw)) return { kind: 'metadata' };
  if (!/^[ +\-]/u.test(raw)) return { kind: 'outside-hunk' };
  return { kind: 'payload', start: line.start + 1 };
}

function pythonLayoutLooksLikeSuiteHeader(code) {
  // A physical backslash continuation is layout trivia once the logical
  // statement is assembled. Keep the scanner conservative, but permit it in
  // otherwise parser-valid class/ suite headers.
  const trimmed = String(code ?? '').replace(/\\[ \t]*/gu, '').trim();
  // Keep the bounded recognizer on Python's identifier alphabet. `$` is a
  // JavaScript identifier character but cannot begin a Python class name;
  // accepting it here would let invalid source establish a class parent.
  if (/^class\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\[[\s\S]*\])?(?:\s*\([\s\S]*\))?$/u.test(trimmed)) return 'class-header';
  if (/^(?:(?:async\s+)?def|if|for|while|try|with|match|case|else|elif|except|finally)\b[\s\S]*$/u.test(trimmed)) return 'suite-header';
  return null;
}

function pythonLayoutStatementKind(code, suiteColon) {
  if (suiteColon < 0) return 'statement';
  const beforeColon = String(code ?? '').slice(0, suiteColon);
  return pythonLayoutLooksLikeSuiteHeader(beforeColon) ?? 'statement';
}

const PYTHON_SUITE_FIRST_WORDS = new Set([
  'async',
  'case',
  'class',
  'def',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'if',
  'match',
  'try',
  'while',
  'with'
]);

function buildPythonSourceLayout(source) {
  const text = String(source ?? '');
  const statements = [];
  const suiteStack = [];

  // A layout scan is deliberately a small lexical envelope, not a Python
  // parser. Diff mode is recognized once, then only hunk payload lines are
  // admitted. File/hunk metadata cannot become suite parents.
  // Unified diffs begin with one of these metadata records. Checking only the
  // prefix keeps mode selection constant-time; the scanner still validates
  // every subsequent hunk/file line before admitting payload.
  const diffMode = text.startsWith('diff --git ') || text.startsWith('--- ') || text.startsWith('@@ ');
  let inHunk = !diffMode;
  let current = null;
  let stringState = null;
  let delimiterStack = [];
  let lineLastSignificant = '';
  let layoutUncertain = false;

  const resetSuiteState = () => {
    suiteStack.length = 0;
    current = null;
    stringState = null;
    delimiterStack = [];
    lineLastSignificant = '';
    layoutUncertain = false;
  };

  const beginStatement = (start, indentColumn, valid = true) => {
    current = {
      start,
      end: start,
      firstCodeOffset: -1,
      indentColumn,
      valid: valid && indentColumn !== null && !layoutUncertain,
      code: [],
      suiteColon: -1,
      firstWord: '',
      firstWordDone: false
    };
  };

  const appendBlank = (count = 1) => {
    if (!current) return;
    for (let index = 0; index < count; index += 1) current.code.push(' ');
  };

  const appendCode = (character, offset) => {
    if (!current) return;
    if (current.firstCodeOffset < 0 && !/[ \t\r\n]/u.test(character)) current.firstCodeOffset = offset;
    current.code.push(character);
    if (!current.firstWordDone) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(character)) current.firstWord += character;
      else if (current.firstWord) current.firstWordDone = true;
      else if (!/[ \t]/u.test(character)) current.firstWordDone = true;
    }
    if (!/[ \t\r\n]/u.test(character)) lineLastSignificant = character;
  };

  const nearestParent = (indentColumn) => {
    if (indentColumn === null) return null;
    while (suiteStack.length > 0 && indentColumn <= suiteStack[suiteStack.length - 1].indentColumn) suiteStack.pop();
    return suiteStack[suiteStack.length - 1] ?? null;
  };

  const finishStatement = (forcedInvalid = false, endOverride = undefined) => {
    if (!current) return null;
    const statement = current;
    current = null;
    if (statement.firstCodeOffset < 0) return null;
    const code = statement.code.join('');
    const kind = pythonLayoutStatementKind(code, statement.suiteColon);
    const valid = statement.valid && !forcedInvalid && delimiterStack.length === 0 && !stringState;
    if (statement.indentColumn === null) {
      // An unsupported leading whitespace form makes parent ordering unknown;
      // do not let a later statement inherit a class suite through it.
      suiteStack.length = 0;
      layoutUncertain = true;
    }
    const parent = valid ? nearestParent(statement.indentColumn) : null;
    const record = {
      start: statement.start,
      end: endOverride ?? statement.end,
      firstCodeOffset: statement.firstCodeOffset,
      indentColumn: statement.indentColumn,
      parent,
      parentKind: parent?.kind ?? null,
      kind,
      classHeaderKind: kind === 'class-header' ? 'class-header' : null,
      valid
    };
    statements.push(record);
    if (valid && (kind === 'class-header' || kind === 'suite-header')) suiteStack.push(record);
    return record;
  };

  const startInlineStatement = (offset, indentColumn) => {
    beginStatement(offset, indentColumn, true);
    lineLastSignificant = '';
  };

  const processBoundary = () => {
    if (!current) return;
    current.end = current.end || current.start;
    const continued = Boolean(stringState || delimiterStack.length > 0 || lineLastSignificant === '\\');
    if (!continued) finishStatement(false, current.end);
    else appendBlank();
  };

  // Discover each physical line boundary as the scanner reaches it. This
  // keeps the layout construction to one bounded left-to-right pass rather
  // than materializing a second full source representation first.
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = lineStart;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') lineEnd += 1;
    const next = lineEnd < text.length
      ? (text[lineEnd] === '\r' && text[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1)
      : text.length;
    const line = { start: lineStart, end: lineEnd };
    const diffInfo = diffMode ? pythonLayoutDiffLine(text, line) : { kind: 'payload', start: line.start };
    if (diffMode && diffInfo.kind === 'metadata') {
      const raw = text.slice(line.start, line.end);
      if (/^@@\s/u.test(raw)) inHunk = true;
      else if (/^(?:diff --git\s|---\s|\+\+\+\s)/u.test(raw)) inHunk = false;
      resetSuiteState();
      if (lineEnd >= text.length) break;
      lineStart = next;
      continue;
    }
    if (diffMode && (!inHunk || diffInfo.kind !== 'payload')) {
      resetSuiteState();
      if (lineEnd >= text.length) break;
      lineStart = next;
      continue;
    }

    const layoutLine = pythonLayoutLine(text, line.start, line.end);
    const payloadStart = diffMode ? Math.min(line.end, diffInfo.start) : layoutLine.contentStart;
    const contentStart = diffMode
      ? pythonLayoutLine(text, payloadStart, line.end).contentStart
      : layoutLine.contentStart;
    const content = text.slice(contentStart, line.end);
    const indentColumn = current ? current.indentColumn : pythonIndentationColumn(content);
    if (!current) beginStatement(contentStart, indentColumn, true);
    current.end = line.end;
    lineLastSignificant = '';
    let inlineIndentColumn = null;
    let inComment = false;

    for (let index = contentStart; index < line.end; index += 1) {
      const character = text[index];
      if (!current && character !== '#' && !/[ \t]/u.test(character)) {
        startInlineStatement(index, inlineIndentColumn ?? (indentColumn === null ? null : indentColumn + 1));
      }
      if (inComment) {
        appendBlank();
        continue;
      }

      if (stringState) {
        if (stringState.escaped) {
          appendBlank();
          stringState.escaped = false;
          continue;
        }
        if (character === '\\') {
          appendBlank();
          stringState.escaped = true;
          continue;
        }
        const delimiter = stringState.triple ? stringState.quote.repeat(3) : stringState.quote;
        if (text.startsWith(delimiter, index)) {
          appendBlank(delimiter.length);
          index += delimiter.length - 1;
          stringState = null;
          continue;
        }
        appendBlank();
        continue;
      }

      if (character === '#') {
        appendBlank();
        inComment = true;
        continue;
      }
      if (character === '"' || character === "'") {
        const triple = text.startsWith(character.repeat(3), index);
        appendBlank(triple ? 3 : 1);
        if (triple) index += 2;
        stringState = { quote: character, triple, escaped: false };
        continue;
      }

      if (character === '(' || character === '[' || character === '{') {
        delimiterStack.push(character);
        appendCode(character, index);
        continue;
      }
      if (character === ')' || character === ']' || character === '}') {
        const expected = character === ')' ? '(' : character === ']' ? '[' : '{';
        if (delimiterStack.length === 0 || delimiterStack[delimiterStack.length - 1] !== expected) current.valid = false;
        else delimiterStack.pop();
        appendCode(character, index);
        continue;
      }

      if (character === ':' && delimiterStack.length === 0 && current.suiteColon < 0) {
        const inlineCompound = inlineIndentColumn !== null;
        const suiteKind = PYTHON_SUITE_FIRST_WORDS.has(current.firstWord)
          ? pythonLayoutLooksLikeSuiteHeader(current.code.join(''))
          : null;
        appendCode(character, index);
        if (suiteKind) {
          current.suiteColon = current.code.length - 1;
          finishStatement(false, index + 1);
          // A compound suite cannot legally follow the simple suite body on
          // the same physical line. Keep that malformed route fail-closed so
          // its following credential-looking statement cannot inherit the
          // enclosing class merely from virtual inline indentation.
          inlineIndentColumn = inlineCompound
            ? indentColumn
            : (indentColumn === null ? null : indentColumn + 1);
        }
        continue;
      }
      if (character === ';' && delimiterStack.length === 0) {
        const statementIndent = current.indentColumn;
        appendCode(character, index);
        finishStatement(false, index + 1);
        startInlineStatement(index + 1, statementIndent ?? inlineIndentColumn ?? indentColumn);
        continue;
      }
      appendCode(character, index);
      // Keep an invalid state for control characters that are not supported
      // by this bounded lexical envelope; ordinary spaces/tabs remain valid.
      if (current && character !== ' ' && character !== '\t' && character.charCodeAt(0) < 0x20) current.valid = false;
    }
    if (current) current.end = line.end;
    processBoundary();
    if (stringState || delimiterStack.length > 0 || lineLastSignificant === '\\') appendBlank();
    if (lineEnd >= text.length) break;
    lineStart = next;
  }

  if (current) finishStatement(true, current.end);
  return { statements, uncertain: layoutUncertain, diffMode };
}

function findPythonLayoutStatement(layout, offset) {
  const statements = layout?.statements ?? [];
  let low = 0;
  let high = statements.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const statement = statements[middle];
    if (offset < statement.start) high = middle - 1;
    else if (offset >= statement.end) low = middle + 1;
    else return statement;
  }
  return null;
}

function hasPythonClassAnchor(syntax, offset) {
  const statement = findPythonLayoutStatement(syntax?.pythonLayout, offset);
  if (!statement || !statement.valid) return false;
  // The candidate must itself be the first code/member occurrence. This
  // rejects labels nested in assignments, containers, calls, and suites.
  return statement.firstCodeOffset === offset && statement.parent?.kind === 'class-header';
}

function hasBalancedGenericTail(code, end) {
  const tail = genericTailInfo(code, end);
  return !tail || tail.balanced;
}

function createSourceSyntax(text) {
  const source = String(text ?? '');
  const code = maskSourceTrivia(source);
  return { code, pairs: buildDelimiterPairs(code), pythonLayout: buildPythonSourceLayout(source) };
}

function isCredibleSourceReference(value, text, offset, assignment = '', syntax = undefined) {
  const raw = String(value ?? '').trim();
  const reference = raw.match(BARE_REFERENCE_PATTERN)?.[1];
  if (!syntax) return false;
  const valueStart = offset + assignment.length;
  const valueEnd = valueStart + raw.length;
  const original = String(text ?? '');
  // Only the matched occurrence's code boundary must survive trivia masking.
  // Calls such as os.getenv("TOKEN") legitimately contain masked string bytes
  // inside the outer source expression, so comparing the complete slice would
  // reject lawful source while still failing to reject strings/comments.
  if (syntax.code[offset] !== original[offset] || syntax.code[valueStart] !== original[valueStart]) return false;
  const genericTail = genericTailInfo(original, valueEnd);
  if (genericTail && !genericTail.balanced) return false;
  if (!hasBalancedGenericTail(syntax.code, valueEnd)) return false;
  const typedAnnotation = hasTypedVariableAnnotationAnchor(syntax.code, syntax, offset, assignment, raw);
  const typeLikeBody = hasTypeLikeBodyAnchor(syntax.code, syntax, offset);
  const parameter = hasParameterAnchor(syntax.code, syntax, offset);
  const pythonClass = hasPythonClassAnchor(syntax, offset);
  const destructuring = hasDestructuringAnchor(syntax.code, syntax, offset);
  // The credential value matcher intentionally remains language-neutral and
  // may capture a physical backslash before a continued class annotation's
  // real type name. The layout has already proved this is the first direct
  // class member, so preserve that continuation instead of redacting the
  // separator and leaving the type tail behind.
  if (raw === '\\' && pythonClass) return true;
  const initializerGeneric = Boolean(genericTail && /=\s*$/u.test(assignment));
  // A generic tail is source syntax only when a surrounding type, parameter,
  // annotation, or destructuring anchor proves that it is not a value. In an
  // object/config expression it remains part of the credential-looking value.
  if (genericTail && (initializerGeneric || !(typedAnnotation || typeLikeBody || parameter || pythonClass || destructuring))) return false;
  const expressionReference = isReferenceExpression(raw, { allowAnyRoot: true });
  if (!reference && !expressionReference) return typedAnnotation && !/=\s*$/u.test(assignment);
  const memberExpression = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(raw);
  const callExpression = new RegExp(`^${REFERENCE_CALL}$`).test(raw);
  const objectExpression = hasObjectExpressionAnchor(syntax.code, syntax, offset);
  // Member/call values nested in an object/config record are ambiguous with
  // credential material. Keep the existing declaration/parameter/type
  // compatibility, but fail closed for this value-shaped route.
  if (objectExpression && (memberExpression || callExpression)) return false;
  const assignmentReference = hasAssignmentAnchor(syntax.code, offset + assignment.length, raw)
    && (callExpression || !memberExpression || isReferenceExpression(raw));
  return hasVariableInitializerAnchor(syntax.code, offset + assignment.length)
    || (expressionReference && assignmentReference)
    || typedAnnotation
    || destructuring
    || typeLikeBody
    || objectExpression
    || parameter
    || pythonClass;
}

function isSourceDeclaration(text, offset, assignment = '', context = 'source') {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const linePrefix = text.slice(lineStart, offset + assignment.length);
  const statementStart = Math.max(linePrefix.lastIndexOf(';'), linePrefix.lastIndexOf('{'), linePrefix.lastIndexOf('}')) + 1;
  const structuralPrefix = context === 'diagnostic'
    ? '(?:\\[[^\\]\\r\\n]{1,64}\\]\\s*)?'
    : '(?:(?:\\d+\\s*\\|\\s*)|(?:[+-]\\s*))?';
  return new RegExp(`^\\s*${structuralPrefix}(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*=\\s*$`, 'u').test(linePrefix.slice(statementStart));
}

function safeCredentialReference(value, text, offset, context, assignment = '', syntax = undefined) {
  if (isExactPlaceholder(value)) return true;
  // Source member/call expressions are safe only through the masked-syntax
  // envelope. Do not let a source string/comment/config record inherit the
  // diagnostic member compatibility fallback.
  if (context === 'source') return isCredibleSourceReference(value, text, offset, assignment, syntax);
  if (!isReferenceExpression(value)) return false;
  // Retain the existing diagnostic member compatibility, while requiring a
  // visible declaration for diagnostic call expressions.
  const normalized = String(value ?? '').trim().replace(/[;,]+$/, '').trim();
  if (!new RegExp(`^${REFERENCE_CALL}$`).test(normalized)) return true;
  return isSourceDeclaration(text, offset, assignment, context);
}

function authorizationValue(value) {
  return String(value ?? '').trim().replace(/^[A-Za-z][A-Za-z0-9_-]*\s+/, '');
}

function markerPrefixes(direction) {
  const prefixes = new Set();
  for (const label of PRIVATE_KEY_LABELS) {
    const marker = '-----' + direction + ' ' + label + '-----';
    for (let i = 1; i < marker.length; i += 1) prefixes.add(marker.slice(0, i));
  }
  return [...prefixes].sort((a, b) => b.length - a.length);
}
const PRIVATE_BEGIN_PREFIXES = markerPrefixes('BEGIN');
const PRIVATE_END_PREFIXES = markerPrefixes('END');

function longestSuffixPrefix(value, prefixes) {
  for (const prefix of prefixes) {
    if (value.endsWith(prefix)) return prefix.length;
  }
  return 0;
}

/**
 * Incrementally remove standardized armored private-key blocks. The marker
 * is emitted as soon as BEGIN is observed; all body bytes are discarded, so
 * an incomplete block cannot leak on process exit.
 */
export function createPrivateKeyScanner() {
  let pending = '';
  let inPrivateBlock = false;
  let privateEndPattern = null;
  let privateBlockStart = null;
  let totalInputOffset = 0;
  const spans = [];

  function push(input = '', final = false) {
    const inputText = String(input ?? '');
    const sourceBaseOffset = totalInputOffset - pending.length;
    totalInputOffset += inputText.length;
    let source = pending + inputText;
    let sourceOffset = sourceBaseOffset;
    pending = '';
    let output = '';

    while (source) {
      if (inPrivateBlock) {
        privateEndPattern.lastIndex = 0;
        const end = privateEndPattern.exec(source);
        if (!end) {
          if (!final) {
            const keep = longestSuffixPrefix(source, PRIVATE_END_PREFIXES);
            if (keep > 0) pending = source.slice(-keep);
          } else if (privateBlockStart !== null) {
            spans.push({ start: privateBlockStart, end: sourceOffset + source.length });
            privateBlockStart = null;
          }
          return output;
        }
        if (privateBlockStart !== null) {
          spans.push({ start: privateBlockStart, end: sourceOffset + end.index + end[0].length });
          privateBlockStart = null;
        }
        inPrivateBlock = false;
        privateEndPattern = null;
        sourceOffset += end.index + end[0].length;
        source = source.slice(end.index + end[0].length);
        continue;
      }

      PRIVATE_BEGIN_PATTERN.lastIndex = 0;
      const begin = PRIVATE_BEGIN_PATTERN.exec(source);
      if (begin) {
        output += source.slice(0, begin.index) + PRIVATE_KEY_REDACTION_MARKER;
        privateBlockStart = sourceOffset + begin.index;
        sourceOffset += begin.index + begin[0].length;
        source = source.slice(begin.index + begin[0].length);
        inPrivateBlock = true;
        const label = begin[0].replace(/^-----BEGIN\s+/i, '').replace(/-----$/u, '').replace(/\s+/g, ' ').toUpperCase();
        privateEndPattern = new RegExp(`-----END\\s+${label.replaceAll(' ', '\\s+')}-----`, 'i');
        continue;
      }

      if (!final) {
        const keep = longestSuffixPrefix(source, PRIVATE_BEGIN_PREFIXES);
        if (keep > 0) {
          output += source.slice(0, -keep);
          pending = source.slice(-keep);
        } else {
          output += source;
        }
        return output;
      }

      const partial = PRIVATE_PARTIAL_PATTERN.exec(source);
      if (partial) {
        output += source.slice(0, partial.index) + PRIVATE_KEY_REDACTION_MARKER;
        spans.push({ start: sourceOffset + partial.index, end: sourceOffset + source.length });
        return output;
      }
      output += source;
      return output;
    }
    return output;
  }

  return {
    push,
    spans() {
      return spans.map((span) => ({ ...span }));
    },
    reset() {
      pending = '';
      inPrivateBlock = false;
      privateEndPattern = null;
      privateBlockStart = null;
      totalInputOffset = 0;
      spans.length = 0;
    }
  };
}


function redactPrivateKeys(text) {
  const scanner = createPrivateKeyScanner();
  return scanner.push(String(text ?? ''), true);
}

function splitLinesWithOffsets(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '\n' && text[index] !== '\r') continue;
    const separator = text[index] === '\r' && text[index + 1] === '\n' ? '\r\n' : text[index];
    lines.push({ start, end: index, separator });
    index += separator.length - 1;
    start = index + 1;
  }
  lines.push({ start, end: text.length, separator: '' });
  return lines;
}

function replacePrivateSpansWithLineMarkers(text, spans) {
  if (spans.length === 0) return text;
  const lines = splitLinesWithOffsets(text);
  let spanIndex = 0;
  const output = [];
  for (const line of lines) {
    while (spanIndex < spans.length && spans[spanIndex].end <= line.start) spanIndex += 1;
    let cursor = line.start;
    let currentSpanIndex = spanIndex;
    let transformed = '';
    while (currentSpanIndex < spans.length) {
      const span = spans[currentSpanIndex];
      if (span.start >= line.end) break;
      if (span.end <= line.start) {
        currentSpanIndex += 1;
        continue;
      }
      const start = Math.max(line.start, span.start);
      const end = Math.min(line.end, span.end);
      if (start > cursor) transformed += text.slice(cursor, start);
      transformed += PRIVATE_KEY_REDACTION_MARKER;
      cursor = Math.max(cursor, end);
      if (span.end <= line.end) currentSpanIndex += 1;
      else break;
    }
    transformed += text.slice(cursor, line.end);
    output.push(transformed + line.separator);
    spanIndex = currentSpanIndex;
  }
  return output.join('');
}

function redactPrivateKeysPreservingLines(text) {
  const source = String(text ?? '');
  const scanner = createPrivateKeyScanner();
  scanner.push(source, true);
  return replacePrivateSpansWithLineMarkers(source, scanner.spans());
}

function redactCredentialAssignment(match, prefix, value, wholeText, offset, context, syntax = undefined) {
  if (safeCredentialReference(value, wholeText, offset, context, prefix, syntax)) return match;
  const valueEnd = offset + prefix.length + value.length;
  const genericTail = genericTailInfo(wholeText, valueEnd);
  const initializerGeneric = Boolean(genericTail && /=\s*$/u.test(prefix));
  if (context === 'source' && syntax && !initializerGeneric && (!genericTail || genericTail.balanced) && hasTypedVariableAnnotationAnchor(syntax.code, syntax, offset, prefix, value)) {
    if (!/=\s*$/u.test(prefix)) return match;
    return `${prefix}${REDACTED_SECRET}`;
  }
  const equals = prefix.lastIndexOf('=');
  if (equals >= 0) {
    const beforeEquals = prefix.slice(0, equals).trimEnd();
    // Keep a separator for typed declarations so the follow-up field pass
    // cannot absorb the assignment operator into the annotation value.
    const typedSeparator = beforeEquals.includes(':') ? ' ' : '';
    return `${beforeEquals}${typedSeparator}= ${REDACTED_SECRET}`;
  }
  return `${prefix}${REDACTED_SECRET}`;
}

function replaceCredentialMatches(text, pattern, context, syntax) {
  pattern.lastIndex = 0;
  let cursor = 0;
  let output = '';
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const value = match[2] ?? '';
    const replacement = redactCredentialAssignment(match[0], prefix, value, text, match.index, context, syntax);
    const valueEnd = match.index + prefix.length + value.length;
    const end = replacement === match[0] ? match.index + match[0].length : credentialValueSpanEnd(text, valueEnd);
    output += text.slice(cursor, match.index) + replacement;
    cursor = Math.max(cursor, end);
    if (end > match.index + match[0].length) pattern.lastIndex = end;
  }
  return output + text.slice(cursor);
}

function applyCredentialPatterns(text, context) {
  let output = text;
  const typedSyntax = context === 'source' ? createSourceSyntax(output) : undefined;
  output = replaceCredentialMatches(output, TYPED_DECLARATION_ASSIGNMENT_PATTERN, context, typedSyntax);
  const assignmentSyntax = context === 'source' ? createSourceSyntax(output) : undefined;
  output = replaceCredentialMatches(output, CREDENTIAL_ASSIGNMENT_PATTERN, context, assignmentSyntax);
  const fieldSyntax = context === 'source' ? createSourceSyntax(output) : undefined;
  output = replaceCredentialMatches(output, CREDENTIAL_FIELD_PATTERN, context, fieldSyntax);
  return output;
}

function applyDirectPatterns(text) {
  let output = text.replace(AUTHORIZATION_PATTERN, (match, prefix, value) => isExactPlaceholder(authorizationValue(value)) ? match : `${prefix}${REDACTED_SECRET}`);
  output = output.replace(CLI_TOKEN_PATTERN, (match, prefix, value) => isExactPlaceholder(value) ? match : `${prefix}${REDACTED_SECRET}`);
  output = output.replace(QUERY_TOKEN_PATTERN, (match, prefix, value) => isExactPlaceholder(value) ? match : `${prefix}${REDACTED_SECRET}`);
  output = output.replace(CREDENTIAL_URL_PATTERN, (match, prefix, value) => isExactPlaceholder(value) ? match : `${prefix}${REDACTED_SECRET}@`);
  output = output.replace(OPENAI_SECRET_PATTERN, (match) => isExactPlaceholder(match) ? match : REDACTED_SECRET);
  output = output.replace(COMMON_TOKEN_PATTERN, (match) => isExactPlaceholder(match) ? match : REDACTED_SECRET);
  output = output.replace(JWT_TOKEN_PATTERN, (match) => isExactPlaceholder(match) ? match : REDACTED_SECRET);
  return output;
}

export function redactSensitiveText(text, options = {}) {
  const context = typeof options === 'string' ? options : options?.context ?? 'source';
  const privateSafe = redactPrivateKeys(String(text ?? ''));
  // Protect transport-shaped credentials before generic assignment handling;
  // otherwise `?codexpro_token=value` becomes `?codexpro_token= [REDACTED_SECRET]`
  // and the displayed URL no longer retains a valid query shape.
  const directSafe = applyDirectPatterns(privateSafe);
  return applyCredentialPatterns(directSafe, context);
}

export function redactSensitiveTextPreservingLines(text, options = {}) {
  const linePreserved = redactPrivateKeysPreservingLines(String(text ?? ''));
  return redactSensitiveText(linePreserved, options);
}

const SEARCH_QUERY_MEMBER_OR_CALL = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\s*\([^;\r\n]*\))?$/u;
const SEARCH_QUERY_LITERAL_LIKE = /^(?=.*\d)[A-Z0-9][A-Z0-9_-]*$/u;

// Search analysis echoes the caller's query in a structured field.  A query
// is lawful to echo only when a redacted match still contains that exact
// query outside policy markers.  Marker-only matches (including fail-closed
// binary/private-key lines) and obviously member/call-shaped fallbacks must
// not reintroduce the hidden value through analysis metadata.
export function redactSearchQuery(query, safeMatchTexts = []) {
  const normalized = String(query ?? '').trim();
  if (!normalized) return normalized;
  const texts = Array.isArray(safeMatchTexts)
    ? safeMatchTexts.filter((value) => typeof value === 'string').map((value) => String(value))
    : [];
  const unmarked = (value) => value
    .replaceAll(REDACTED_SECRET, '')
    .replaceAll(PRIVATE_KEY_REDACTION_MARKER, '');

  if (texts.some((text) => unmarked(text).includes(normalized))) return normalized;
  if (texts.length > 0) return REDACTED_SECRET;
  if (SEARCH_QUERY_MEMBER_OR_CALL.test(normalized)) return REDACTED_SECRET;

  // Keep ordinary source symbol searches intact while covering literal-like
  // credential queries when no match text is available (disabled/error path).
  const quoted = /^(['"`])[\s\S]*\1$/u.test(normalized);
  const probe = `TOKEN=${normalized}`;
  if ((quoted || SEARCH_QUERY_LITERAL_LIKE.test(normalized)) && hasSecretValue(probe, { context: 'source' })) {
    return REDACTED_SECRET;
  }
  return normalized;
}

export function redactDiagnosticText(text) {
  return redactSensitiveText(text, { context: 'diagnostic' });
}

function hasUnsafeCredentialMatch(text, pattern, context, syntax = undefined) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const value = match[2] ?? match[0].slice(prefix.length);
    if (!safeCredentialReference(value, text, match.index, context, prefix, syntax)) return true;
  }
  return false;
}

export function hasSecretValue(text, options = {}) {
  const source = String(text ?? '');
  const context = typeof options === 'string' ? options : options?.context ?? 'source';
  const syntax = context === 'source' ? createSourceSyntax(source) : undefined;
  PRIVATE_BEGIN_PATTERN.lastIndex = 0;
  if (PRIVATE_BEGIN_PATTERN.test(source) || PRIVATE_PARTIAL_PATTERN.test(source)) return true;
  if (hasUnsafeCredentialMatch(source, TYPED_DECLARATION_ASSIGNMENT_PATTERN, context, syntax)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_ASSIGNMENT_PATTERN, context, syntax)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_FIELD_PATTERN, context, syntax)) return true;

  AUTHORIZATION_PATTERN.lastIndex = 0;
  let match;
  while ((match = AUTHORIZATION_PATTERN.exec(source)) !== null) {
    if (!isExactPlaceholder(authorizationValue(match[2]))) return true;
  }
  for (const pattern of [CLI_TOKEN_PATTERN, QUERY_TOKEN_PATTERN, CREDENTIAL_URL_PATTERN]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(source)) !== null) {
      const value = pattern === CREDENTIAL_URL_PATTERN ? match[2] : pattern === QUERY_TOKEN_PATTERN ? match[2] : match[2];
      if (!isExactPlaceholder(value)) return true;
    }
  }
  for (const pattern of [OPENAI_SECRET_PATTERN, COMMON_TOKEN_PATTERN, JWT_TOKEN_PATTERN]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(source)) !== null) {
      if (!isExactPlaceholder(match[0])) return true;
    }
  }
  return false;
}

function utf8PrefixLength(buffer, limit) {
  const requested = Math.min(Math.max(0, limit), buffer.byteLength);
  if (requested === buffer.byteLength) return requested;
  let end = requested;
  while (end > 0) {
    const byte = buffer[end - 1];
    if ((byte & 0x80) === 0) return requested;
    if ((byte & 0xc0) === 0x80) {
      end -= 1;
      continue;
    }
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return requested - (end - 1) >= needed ? requested : end - 1;
  }
  return 0;
}

export function truncateUtf8(value, maxBytes, suffix = '') {
  const limit = Math.max(0, Number(maxBytes) || 0);
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= limit) return text;
  const suffixText = String(suffix ?? '');
  const suffixBuffer = Buffer.from(suffixText, 'utf8');
  if (suffixBuffer.byteLength >= limit) {
    const suffixLength = utf8PrefixLength(suffixBuffer, limit);
    return suffixBuffer.subarray(0, suffixLength).toString('utf8');
  }
  const prefixLength = utf8PrefixLength(buffer, limit - suffixBuffer.byteLength);
  return `${buffer.subarray(0, prefixLength).toString('utf8')}${suffixText}`;
}
