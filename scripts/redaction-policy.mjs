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
const CREDENTIAL_VALUE = `(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|(?:${REFERENCE_CALL})(?=[\\s,;}\\]]|$)|[^\\s"'\\x60<>]+)`;
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(`\\b(${CREDENTIAL_LABEL}\\s*=\\s*)(${CREDENTIAL_VALUE})`, 'gi');
const CREDENTIAL_FIELD_PATTERN = new RegExp(`(["']?${CREDENTIAL_LABEL}["']?\\s*:\\s*)(${CREDENTIAL_VALUE})`, 'gi');

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

function isSourceDeclaration(text, offset, assignment = '', context = 'source') {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const linePrefix = text.slice(lineStart, offset + assignment.length);
  const statementStart = Math.max(linePrefix.lastIndexOf(';'), linePrefix.lastIndexOf('{'), linePrefix.lastIndexOf('}')) + 1;
  const structuralPrefix = context === 'diagnostic'
    ? '(?:\\[[^\\]\\r\\n]{1,64}\\]\\s*)?'
    : '(?:(?:\\d+\\s*\\|\\s*)|(?:[+-]\\s*))?';
  return new RegExp(`^\\s*${structuralPrefix}(?:export\\s+)?(?:const|let|var)\\s+[A-Za-z_$][A-Za-z0-9_$]*\\s*=\\s*$`, 'u').test(linePrefix.slice(statementStart));
}

function safeCredentialReference(value, text, offset, context, assignment = '') {
  if (isExactPlaceholder(value)) return true;
  // A real source file can use any language's ordinary call/member syntax;
  // do not require a JavaScript declaration keyword before preserving it.
  // Diagnostic records remain conservative and continue through the
  // declaration heuristic below.
  if (context === 'source' && isReferenceExpression(value, { allowAnyRoot: true })) return true;
  if (!isReferenceExpression(value)) return false;
  // Call expressions are safe only when the surrounding record visibly
  // declares the value. Credible member references remain harmless on their
  // own in both source and diagnostic contexts.
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

  function push(input = '', final = false) {
    let source = pending + String(input ?? '');
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
          }
          return output;
        }
        inPrivateBlock = false;
        privateEndPattern = null;
        source = source.slice(end.index + end[0].length);
        continue;
      }

      PRIVATE_BEGIN_PATTERN.lastIndex = 0;
      const begin = PRIVATE_BEGIN_PATTERN.exec(source);
      if (begin) {
        output += source.slice(0, begin.index) + PRIVATE_KEY_REDACTION_MARKER;
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
        return output;
      }
      output += source;
      return output;
    }
    return output;
  }

  return {
    push,
    reset() {
      pending = '';
      inPrivateBlock = false;
      privateEndPattern = null;
    }
  };
}


function redactPrivateKeys(text) {
  const scanner = createPrivateKeyScanner();
  return scanner.push(String(text ?? ''), true);
}
function redactCredentialAssignment(match, prefix, value, wholeText, offset, context) {
  if (safeCredentialReference(value, wholeText, offset, context, prefix)) return match;
  const equals = prefix.lastIndexOf('=');
  return equals >= 0
    ? `${prefix.slice(0, equals).trimEnd()}= ${REDACTED_SECRET}`
    : `${prefix}${REDACTED_SECRET}`;
}

function applyCredentialPatterns(text, context) {
  let output = text.replace(CREDENTIAL_ASSIGNMENT_PATTERN, (match, prefix, value, offset, wholeText) => redactCredentialAssignment(match, prefix, value, wholeText, offset, context));
  output = output.replace(CREDENTIAL_FIELD_PATTERN, (match, prefix, value, offset, wholeText) => redactCredentialAssignment(match, prefix, value, wholeText, offset, context));
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

export function redactDiagnosticText(text) {
  return redactSensitiveText(text, { context: 'diagnostic' });
}

function hasUnsafeCredentialMatch(text, pattern, context) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const value = match[2] ?? match[0].slice(prefix.length);
    if (!safeCredentialReference(value, text, match.index, context, prefix)) return true;
  }
  return false;
}

export function hasSecretValue(text, options = {}) {
  const source = String(text ?? '');
  const context = typeof options === 'string' ? options : options?.context ?? 'source';
  PRIVATE_BEGIN_PATTERN.lastIndex = 0;
  if (PRIVATE_BEGIN_PATTERN.test(source) || PRIVATE_PARTIAL_PATTERN.test(source)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_ASSIGNMENT_PATTERN, context)) return true;
  if (hasUnsafeCredentialMatch(source, CREDENTIAL_FIELD_PATTERN, context)) return true;

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
