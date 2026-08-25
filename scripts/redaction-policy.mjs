import {
  createPythonProvenance,
  ownsPythonCredential
} from './python-provenance.mjs';

const REDACTED_SECRET = '[REDACTED_SECRET]';
export const PRIVATE_KEY_REDACTION_MARKER = '[REDACTED_PRIVATE_KEY]';

// A path hint is trusted only after the caller has resolved/validated the
// target path. Text itself never selects a parser or language.
export function sourceLanguageForPath(filePath) {
  const value = String(filePath ?? '').replaceAll('\\', '/');
  return /\.(?:py|pyi|pyw)$/iu.test(value) ? 'python' : undefined;
}

function normalizeOptions(options, defaultContext = 'source') {
  if (typeof options === 'string') return { context: options, language: undefined };
  const context = options?.context ?? defaultContext;
  const language = context === 'source' && options?.language === 'python' ? 'python' : undefined;
  return { context, language };
}

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

const REFERENCE_CALL = '[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*\\s*\\([^;()=\\r\\n]*\\)';
const CREDENTIAL_LABEL = '[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}';
const CREDENTIAL_LABEL_PATTERN = new RegExp(`^${CREDENTIAL_LABEL}$`, 'i');
const CREDENTIAL_PARENTHESIZED_VALUE = `\\((?:${REFERENCE_CALL}|[^()=]{1,1024})\\)`;
const CREDENTIAL_VALUE = `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|${CREDENTIAL_PARENTHESIZED_VALUE}|(?:${REFERENCE_CALL})(?=[\\s,;})\\]]|$)|[^\\s"'\\x60<>\\[\\]{},;()]+(?![A-Za-z0-9_$])(?!(?:[ \\t]*\\()))`;
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(`\\b(${CREDENTIAL_LABEL}\\s*=\\s*)(${CREDENTIAL_VALUE})`, 'gi');
// Generic bracketed targets/PEP695 aliases are anchored to a statement start.
// Without that boundary, `Token[str] = ...` inside an annotated declaration
// is mistaken for a second assignment and can override the real AST owner.
const CREDENTIAL_ALIAS_ASSIGNMENT_PATTERN = new RegExp(`((?:^|[;\\n])\\s*(?:type\\s+)?${CREDENTIAL_LABEL}\\s*\\[[^\\]\\r\\n]{1,256}\\]\\s*=\\s*)(${CREDENTIAL_VALUE})`, 'gim');
const CREDENTIAL_SUBSCRIPT_ASSIGNMENT_PATTERN = new RegExp(`([\\[(,]\\s*${CREDENTIAL_LABEL}\\s*]\\s*=\\s*)(${CREDENTIAL_VALUE})`, 'gi');
const CREDENTIAL_DESTRUCTURED_ASSIGNMENT_PATTERN = new RegExp(`((?:^|[\\[(,])\\s*\\*?${CREDENTIAL_LABEL}\\s*(?:[,\\]])[^=\\r\\n]{0,256}=\\s*(?:[([{]\\s*)?)(${CREDENTIAL_VALUE})`, 'gim');
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

function hasMalformedGenericTail(code) {
  const text = String(code ?? '');
  const masked = maskSourceTrivia(text);
  for (const match of masked.matchAll(/[<[]/gu)) {
    const tail = genericTailInfo(masked, match.index);
    if (tail && !tail.balanced) return true;
  }
  return false;
}

function unmatchedCredentialParenthesisStart(text) {
  const source = String(text ?? '');
  const masked = maskSourceTrivia(source);
  const candidatePattern = new RegExp(`\\b${CREDENTIAL_LABEL}\\s*(?::|=)[^\\r\\n]{0,512}\\(`, 'gi');
  let match;
  while ((match = candidatePattern.exec(masked)) !== null) {
    const opening = masked.indexOf('(', match.index);
    if (opening < 0) continue;
    let depth = 0;
    for (let index = opening; index < masked.length; index += 1) {
      if (masked[index] === '(') depth += 1;
      else if (masked[index] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return opening;
  }
  return -1;
}

function redactMalformedCredentialParentheses(text) {
  const source = String(text ?? '');
  const start = unmatchedCredentialParenthesisStart(source);
  if (start < 0) return source;
  return `${source.slice(0, start)}${REDACTED_SECRET}${source.slice(start).replace(/[^\r\n]/gu, '')}`;
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
  // A credential-looking assignment nested in a call/parenthesized expression
  // is a keyword/value, not the enclosing declaration's initializer. Keep the
  // declaration anchor line-local and let the nested assignment be redacted.
  if (findEnclosingPair(syntax, '(', ')', offset)) return false;

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
  return /(?:^|[\n;{}])\s*(?:(?:export\s+)?(?:async\s+)?function(?:\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\n]*>)?)?|(?:async\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\n]*>)?)\s*$/u.test(prefix);
}



function hasBalancedGenericTail(code, end) {
  const tail = genericTailInfo(code, end);
  return !tail || tail.balanced;
}

function createSourceSyntax(text, language) {
  const source = String(text ?? '');
  const code = maskSourceTrivia(source);
  return {
    code,
    pairs: buildDelimiterPairs(code),
    language,
    // Parser authority is opt-in from a trusted path-derived language hint.
    // Diagnostics, URLs, config, and generic text deliberately carry no
    // provenance object, even when their bytes resemble Python.
    pythonProvenance: language === 'python'
      ? createPythonProvenance(source, { language })
      : undefined
  };
}

function isCredibleSourceReference(value, text, offset, assignment = '', syntax = undefined) {
  const raw = String(value ?? '').trim();
  const reference = raw.match(BARE_REFERENCE_PATTERN)?.[1];
  if (!syntax) return false;
  const valueStart = offset + assignment.length;
  const valueEnd = valueStart + raw.length;
  const original = String(text ?? '');
  if (hasMalformedGenericTail(assignment)) return false;
  // Parser ownership is authoritative only for an explicitly trusted Python
  // source hint. A Python-looking string passed without that hint remains
  // generic/fail-closed rather than silently selecting a parser.
  if (syntax.language === 'python') {
    // AST ownership grants the Python source-fidelity exception for supported
    // declaration roles. Parser-unowned reference assignments still use the
    // language-neutral envelope below (for example `TOKEN = os.getenv(...)`);
    // literal/value-shaped occurrences continue through the generic checks and
    // therefore remain fail-closed.
    if (ownsPythonCredential({ provenance: syntax.pythonProvenance, offset, valueStart })) return true;
  }
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
  const destructuring = hasDestructuringAnchor(syntax.code, syntax, offset);
  const initializerGeneric = Boolean(genericTail && /=\s*$/u.test(assignment));
  // An unhinted `name: Type = value` is Python-looking source, not a lawful
  // generic source reference. Only an explicit Python language hint may grant
  // its AST declaration ownership; TS/JS declarations retain their keyword.
  if (syntax.language !== 'python' && isPythonLikeTypedAssignment(assignment)) return false;
  // A generic tail is source syntax only when a surrounding type, parameter,
  // annotation, or destructuring anchor proves that it is not a value. In an
  // object/config expression it remains part of the credential-looking value.
  if (genericTail && (initializerGeneric || !(typedAnnotation || typeLikeBody || parameter || destructuring))) return false;
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
    // A parser-unowned Python occurrence inside a dict/object remains a
    // value-shaped hostile case even when its value happens to look like a
    // generic reference. The language-neutral object envelope remains
    // available for non-Python source, while ordinary Python reference
    // assignments (outside the container) use the branches above.
    || (objectExpression && syntax.language !== 'python')
    || parameter;
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

function isPythonLikeTypedAssignment(assignment) {
  const normalized = String(assignment ?? '').trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*[^=\r\n]{1,512}?=\s*$/u.test(normalized);
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
  if (hasMalformedGenericTail(prefix)) {
    const colon = prefix.lastIndexOf(':');
    const equals = prefix.lastIndexOf('=');
    if (colon >= 0 && colon < equals) return `${prefix.slice(0, colon + 1).trimEnd()} ${REDACTED_SECRET}`;
  }
  if (context === 'source' && syntax && !initializerGeneric && (!genericTail || genericTail.balanced) && hasTypedVariableAnnotationAnchor(syntax.code, syntax, offset, prefix, value)) {
    if (!/=\s*$/u.test(prefix)) return match;
    return `${prefix}${REDACTED_SECRET}`;
  }
  const equals = prefix.lastIndexOf('=');
  const preservedValueLineBreaks = value.replace(/[^\r\n]/gu, '');
  if (equals >= 0) {
    const beforeEquals = prefix.slice(0, equals).trimEnd();
    // Keep a separator for typed declarations so the follow-up field pass
    // cannot absorb the assignment operator into the annotation value.
    const typedSeparator = beforeEquals.includes(':') ? ' ' : '';
    return `${beforeEquals}${typedSeparator}= ${REDACTED_SECRET}${preservedValueLineBreaks}`;
  }
  return `${prefix}${REDACTED_SECRET}${preservedValueLineBreaks}`;
}

function collectCredentialMatches(text, pattern, context, syntax, priority) {
  pattern.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const value = match[2] ?? '';
    const replacement = redactCredentialAssignment(match[0], prefix, value, text, match.index, context, syntax);
    const valueEnd = match.index + prefix.length + value.length;
    const end = replacement === match[0] ? match.index + match[0].length : credentialValueSpanEnd(text, valueEnd);
    matches.push({ start: match.index, end, replacement, priority });
  }
  return matches;
}

function applyCredentialPatterns(text, context, language) {
  const syntax = context === 'source' ? createSourceSyntax(text, language) : undefined;
  const candidates = [
    [TYPED_DECLARATION_ASSIGNMENT_PATTERN, 0],
    [CREDENTIAL_ASSIGNMENT_PATTERN, 2],
    [CREDENTIAL_ALIAS_ASSIGNMENT_PATTERN, 2],
    [CREDENTIAL_SUBSCRIPT_ASSIGNMENT_PATTERN, 2],
    [CREDENTIAL_DESTRUCTURED_ASSIGNMENT_PATTERN, 2],
    [CREDENTIAL_FIELD_PATTERN, 3]
  ].flatMap(([pattern, priority]) => collectCredentialMatches(text, pattern, context, syntax, priority));
  candidates.sort((left, right) => left.start - right.start || left.priority - right.priority || right.end - left.end);

  const selected = [];
  let coveredUntil = 0;
  for (const candidate of candidates) {
    if (candidate.start < coveredUntil) continue;
    selected.push(candidate);
    coveredUntil = candidate.end;
  }
  let cursor = 0;
  let output = '';
  for (const candidate of selected) {
    output += text.slice(cursor, candidate.start) + candidate.replacement;
    cursor = candidate.end;
  }
  return output + text.slice(cursor);
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
  const { context, language } = normalizeOptions(options);
  const privateSafe = redactPrivateKeys(String(text ?? ''));
  // Protect transport-shaped credentials before generic assignment handling;
  // otherwise `?codexpro_token=value` becomes `?codexpro_token= [REDACTED_SECRET]`
  // and the displayed URL no longer retains a valid query shape.
  const directSafe = applyDirectPatterns(privateSafe);
  return redactMalformedCredentialParentheses(applyCredentialPatterns(directSafe, context, language));
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
  const { context, language } = normalizeOptions(options);
  const syntax = context === 'source' ? createSourceSyntax(source, language) : undefined;
  PRIVATE_BEGIN_PATTERN.lastIndex = 0;
  if (PRIVATE_BEGIN_PATTERN.test(source) || PRIVATE_PARTIAL_PATTERN.test(source)) return true;
  if (unmatchedCredentialParenthesisStart(source) >= 0) return true;
  if (hasUnsafeCredentialMatch(source, TYPED_DECLARATION_ASSIGNMENT_PATTERN, context, syntax)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_ALIAS_ASSIGNMENT_PATTERN, context, syntax)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_SUBSCRIPT_ASSIGNMENT_PATTERN, context, syntax)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_DESTRUCTURED_ASSIGNMENT_PATTERN, context, syntax)) return true;
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

function diffPathFromBlock(block) {
  const lines = String(block ?? '').split(/\r?\n/u);
  const candidates = [
    lines.find((line) => line.startsWith('+++ ')),
    lines.find((line) => line.startsWith('--- '))
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let value = candidate.slice(4).split('\t')[0].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      const encoded = value.slice(1, -1);
      let decoded = '';
      const octets = [];
      const flushOctets = () => {
        if (!octets.length) return;
        decoded += Buffer.from(octets).toString('utf8');
        octets.length = 0;
      };
      for (let index = 0; index < encoded.length; index += 1) {
        if (encoded[index] !== '\\') {
          flushOctets();
          decoded += encoded[index];
          continue;
        }
        const escaped = encoded[++index];
        if (escaped === undefined) break;
        if (/[0-7]/u.test(escaped)) {
          let octal = escaped;
          for (let count = 0; count < 2 && /[0-7]/u.test(encoded[index + 1] ?? ''); count += 1) octal += encoded[++index];
          octets.push(Number.parseInt(octal, 8));
        } else {
          flushOctets();
          decoded += ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[escaped] ?? escaped);
        }
      }
      flushOctets();
      value = decoded;
    }
    if (value === '/dev/null') continue;
    value = value.replace(/^(?:[ab])\//u, '');
    if (value) return value;
  }
  return undefined;
}

function diffBlocks(text) {
  const source = String(text ?? '');
  if (/^diff --git\s/mu.test(source)) {
    return source.split(/(?=^diff --git\s)/mu).filter((block) => block.length > 0);
  }
  // Some callers provide a minimal unified patch without `diff --git`
  // records. Split each `---`/`+++` pair so a later non-Python file cannot
  // inherit the first file's parser authority.
  if (/^---\s/mu.test(source) && /^\+\+\+\s/mu.test(source)) {
    return source.split(/(?=^---\s)/mu).filter((block) => block.length > 0);
  }
  return [source];
}

// Unified diff output is a collection of per-file target routes. The caller
// may provide a validated-path callback; unknown paths intentionally receive
// no parser authority and therefore use the generic fail-closed policy.
export function redactUnifiedDiff(text, options = {}) {
  const languageForPath = typeof options?.languageForPath === 'function'
    ? options.languageForPath
    : sourceLanguageForPath;
  return diffBlocks(text).map((block) => {
    const language = languageForPath(diffPathFromBlock(block));
    return redactSensitiveText(block, { context: 'source', language: language === 'python' ? 'python' : undefined });
  }).join('');
}

export function hasSecretValueInUnifiedDiff(text, options = {}) {
  const languageForPath = typeof options?.languageForPath === 'function'
    ? options.languageForPath
    : sourceLanguageForPath;
  return diffBlocks(text).some((block) => {
    const language = languageForPath(diffPathFromBlock(block));
    return hasSecretValue(block, { context: 'source', language: language === 'python' ? 'python' : undefined });
  });
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
