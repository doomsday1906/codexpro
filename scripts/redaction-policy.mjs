// Keep one shape-based detector for source, diagnostics and mutation checks.
import { extractDiffFileBlocks } from './python-provenance.mjs';
export { extractDiffFileBlocks };

const REDACTED_SECRET = '[REDACTED_SECRET]';
export const PRIVATE_KEY_REDACTION_MARKER = '[REDACTED_PRIVATE_KEY]';

export function sourceLanguageForPath(filePath) {
  return /\.(?:py|pyi|pyw)$/iu.test(String(filePath ?? '')) ? 'python' : undefined;
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


const KNOWN_TOKEN = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;
const CREDENTIAL_NAME = String.raw`[\w$-]*(?:api[_-]?key|token|secret|password|private[_-]?key)[\w$-]*`;
// Only literal bodies are candidates; references, calls and annotations have no value shape.
const ASSIGNED_LITERAL = new RegExp(String.raw`\b${CREDENTIAL_NAME}["']?\s*(?:\])?\s*(?::[^=;\r\n"'\x60]+)?[=:]\s*\(?\s*(?:[rubf]{0,2})?(?<quote>"""|'''|["'\x60])(?<value>(?:\\[\s\S]|(?!\k<quote>)[^\\])*)\k<quote>`, 'gidu');
const BARE_CREDENTIAL = new RegExp(String.raw`(?:\b${CREDENTIAL_NAME}["']?\s*[=:]\s*|--(?:token|access-token|auth-token|api[_-]?key|authtoken)[= ]+|\b(?:ngrok\s+config\s+add-authtoken|cloudflared\s+service\s+install)\s+|[?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)(?<value>[^\s"'\x60<>&,;)}\]]+)`, 'gidu');
const BEARER = /\bAuthorization["']?\s*[:=]\s*["']?Bearer\s+(?<value>\$\{[^}]*\}|\{\{[^}]*\}\}|<[^>]*>|[^\s"'\x60,;}]+)/gidu;
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:(?<value>[^@\s/]+)@/gidu;

const PLACEHOLDERS = new Set([
  'replace-me', 'replace-with-long-random-token', 'keep-this-codexpro-token-stable',
  'keep-this-stable-token', 'your-ngrok-token', 'your-token', 'your-api-key-here', 'sk-...'
]);
function isPlaceholder(value) {
  return PLACEHOLDERS.has(value.toLowerCase())
    || /^(?:\[REDACTED_(?:SECRET|PRIVATE_KEY)\]|<[^>]*>|\$\{[^}]*\}|\$[\w]+|%[\w]+%|\{\{[\s\S]*\}\})$/iu.test(value)
    || /^(?:(?:sk-|gh[opsru]_|github_pat_|npm_))?(?:your[-_]|replace[-_]|example[-_]|placeholder|dummy|redacted)/iu.test(value);
}

function isHighEntropyLiteral(value) {
  if (value.length < 24 || isPlaceholder(value) || /\s|\$\{|\\/.test(value) || /^\d+$/.test(value)) return false;
  if (!/^[A-Za-z0-9_+/=.-]+$/.test(value)) return false;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 4 || (entropy >= 3.5 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value));
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

    // Streaming-finalize exactness (large-file surgical readability): the
    // streaming scanner finalizes with an empty push after the last content
    // was already fed non-final. When a block is still open and nothing is
    // retained, `source` is empty and the loop below would skip recording the
    // unterminated span — while the single-push oracle (non-empty final input)
    // records it. Close the span at exact EOF instead. Single-push callers are
    // unaffected (non-empty input still takes the loop path; empty text was
    // never inside a block).
    if (!source && final && inPrivateBlock && privateBlockStart !== null) {
      spans.push({ start: privateBlockStart, end: sourceOffset });
      privateBlockStart = null;
      inPrivateBlock = false;
      privateEndPattern = null;
      return output;
    }

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



function mergeSensitiveSpans(spans) {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const result = [];
  for (const span of spans) {
    const previous = result.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else result.push({ ...span });
  }
  return result;
}

export function scanSecretValues(text, _options = {}) {
  const source = String(text ?? '');
  const scanner = createPrivateKeyScanner();
  scanner.push(source, true);
  const spans = scanner.spans();
  for (const pattern of [KNOWN_TOKEN, ASSIGNED_LITERAL, BARE_CREDENTIAL, BEARER, URL_PASSWORD]) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const rawValue = match.groups?.value ?? match[0];
      const value = rawValue.trim();
      if (isPlaceholder(value)) continue;
      if ((pattern === ASSIGNED_LITERAL || pattern === BARE_CREDENTIAL) && !isHighEntropyLiteral(value)) continue;
      // Bare source identifiers are references, even when their spelling has high entropy.
      if (pattern === BARE_CREDENTIAL && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)) continue;
      const [start] = match.indices?.groups?.value ?? [match.index];
      const valueStart = start + rawValue.indexOf(value);
      spans.push({ start: valueStart, end: valueStart + value.length });
    }
  }
  return { spans: mergeSensitiveSpans(spans), complete: true };
}

export function hasSecretValue(text, options = {}) {
  return scanSecretValues(text, options).spans.length > 0;
}

function redactSpans(text, preservingLines) {
  const source = String(text ?? '');
  const { spans } = scanSecretValues(source);
  let output = '';
  let cursor = 0;
  for (const span of spans) {
    const value = source.slice(span.start, span.end);
    const marker = /^-----BEGIN\s/i.test(value) ? PRIVATE_KEY_REDACTION_MARKER : REDACTED_SECRET;
    output += source.slice(cursor, span.start) + (preservingLines
      ? value.replace(/[^\r\n]+/gu, marker)
      : marker);
    cursor = span.end;
  }
  return output + source.slice(cursor);
}

export function redactSensitiveText(text, _options = {}) {
  return redactSpans(text, false);
}
export function redactSensitiveTextPreservingLines(text, _options = {}) {
  return redactSpans(text, true);
}
export function redactDiagnosticText(text) {
  return redactSensitiveText(text);
}
export function redactSearchQuery(query, safeMatchTexts = []) {
  const value = String(query ?? '').trim();
  if (hasSecretValue(value) || hasSecretValue(`TOKEN="${value}"`)) return REDACTED_SECRET;
  // A query matching a masked part of a file must not echo the hidden body back.
  if (safeMatchTexts.length && !safeMatchTexts.some((text) => text
    .replaceAll(REDACTED_SECRET, '').replaceAll(PRIVATE_KEY_REDACTION_MARKER, '').includes(value))) return REDACTED_SECRET;
  return value;
}
export function redactUnifiedDiff(text, _options = {}) {
  return redactSensitiveText(text);
}
export function hasSecretValueInUnifiedDiff(text, _options = {}) {
  return hasSecretValue(text);
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
