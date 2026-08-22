const OPENAI_SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
const COMMON_TOKEN_PATTERN = /\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g;
const JWT_TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_TOKEN_PATTERN = /\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const AUTHORIZATION_HEADER_PATTERN = /\b(Authorization\s*:\s*)[^\r\n]*/gi;
const CREDENTIAL_URL_PATTERN = /\b((?:https?|wss?):\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const CLI_TOKEN_PATTERN = /((?:\bngrok\s+config\s+add-authtoken|\bcloudflared\s+service\s+install|--(?:token|access-token|auth-token|api[_-]?key|authtoken))(?:=|[ \t]+))(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`<>]+)/gi;
const QUERY_TOKEN_PATTERN = /([?&](?:codexpro_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'`<>]+/gi;
const REFERENCE_CALL = `[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*\\s*\\([^;\\r\\n]*\\)`;
const CODEXPRO_TOKEN_ASSIGNMENT_PATTERN = new RegExp(`\\b(codexpro_token\\s*=\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|${REFERENCE_CALL}|[^\\s"'\\x60<>]+)`, "gi");
const CODEXPRO_TOKEN_FIELD_PATTERN = new RegExp(`(["']?codexpro_token["']?\\s*:\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|${REFERENCE_CALL}|[A-Za-z0-9_./+=-]+)`, "gi");
const SHORT_SECRET_ASSIGNMENT_PATTERN = new RegExp(`\\b[A-Z][A-Z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]{0,64}\\s*=\\s*(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|${REFERENCE_CALL}|[A-Za-z0-9_./+=-]+)`, "g");
const SHORT_SECRET_FIELD_PATTERN = new RegExp(`(["']?[A-Z][A-Z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]{0,64}["']?\\s*:\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|\\x60[^\\x60\\r\\n]*\\x60|${REFERENCE_CALL}|[A-Za-z0-9_./+=-]+)`, "g");
const SECRET_ASSIGNMENT_PATTERN = /\b[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}\s*=\s*(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_FIELD_PATTERN = /(["']?[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}["']?\s*:\s*)(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi;
const SECRET_PATTERNS = [OPENAI_SECRET_PATTERN, COMMON_TOKEN_PATTERN, JWT_TOKEN_PATTERN, BEARER_TOKEN_PATTERN, AUTHORIZATION_HEADER_PATTERN, CREDENTIAL_URL_PATTERN, CLI_TOKEN_PATTERN, QUERY_TOKEN_PATTERN, CODEXPRO_TOKEN_ASSIGNMENT_PATTERN, CODEXPRO_TOKEN_FIELD_PATTERN, SHORT_SECRET_ASSIGNMENT_PATTERN, SHORT_SECRET_FIELD_PATTERN, SECRET_ASSIGNMENT_PATTERN, SECRET_FIELD_PATTERN];
const CREDENTIAL_EXPRESSION_PATTERNS = new Set([
  CODEXPRO_TOKEN_ASSIGNMENT_PATTERN,
  CODEXPRO_TOKEN_FIELD_PATTERN,
  SHORT_SECRET_ASSIGNMENT_PATTERN,
  SHORT_SECRET_FIELD_PATTERN,
  SECRET_ASSIGNMENT_PATTERN,
  SECRET_FIELD_PATTERN
]);

export function hasSecretValue(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (!isPlaceholderSecret(match[0]) && !isReferenceCredentialMatch(pattern, match[0])) return true;
    }
  }
  return false;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(CODEXPRO_TOKEN_ASSIGNMENT_PATTERN, (match, prefix) => shouldRedactCredentialMatch(match) ? `${prefix}[REDACTED_SECRET]` : match)
    .replace(CODEXPRO_TOKEN_FIELD_PATTERN, (match, prefix) => shouldRedactCredentialMatch(match) ? `${prefix}[REDACTED_SECRET]` : match)
    .replace(CLI_TOKEN_PATTERN, (match, prefix) => isPlaceholderSecret(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(SHORT_SECRET_ASSIGNMENT_PATTERN, (match) => isPlaceholderSecret(match) || !shouldRedactCredentialMatch(match) ? match : redactSecretAssignment(match))
    .replace(SHORT_SECRET_FIELD_PATTERN, (match, prefix) => isPlaceholderSecret(match) || !shouldRedactCredentialMatch(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(SECRET_ASSIGNMENT_PATTERN, (match) => isPlaceholderSecret(match) || !shouldRedactCredentialMatch(match) ? match : redactSecretAssignment(match))
    .replace(SECRET_FIELD_PATTERN, (match, prefix) => isPlaceholderSecret(match) || !shouldRedactCredentialMatch(match) ? match : `${prefix}[REDACTED_SECRET]`)
    .replace(BEARER_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(AUTHORIZATION_HEADER_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(CREDENTIAL_URL_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]@`)
    .replace(QUERY_TOKEN_PATTERN, (_match, prefix) => `${prefix}[REDACTED_SECRET]`)
    .replace(OPENAI_SECRET_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]")
    .replace(COMMON_TOKEN_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]")
    .replace(JWT_TOKEN_PATTERN, (match) => isPlaceholderSecret(match) ? match : "[REDACTED_SECRET]");
}

export function redactStructured<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1)) as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = redactStructured(item, depth + 1);
  }
  return out as T;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("[redacted_secret]") ||
    normalized.includes("replace-me") ||
    normalized.includes("replace-with-long-random-token") ||
    normalized.includes("keep-this-codexpro-token-stable") ||
    normalized.includes("keep-this-stable-token") ||
    normalized.includes("your-ngrok-token") ||
    normalized.includes("your-token") ||
    normalized.includes("your-api-key-here") ||
    normalized.includes("<openai_api_key>") ||
    normalized.includes("process.env.") ||
    normalized.includes("import.meta.env.") ||
    normalized.includes("os.environ") ||
    normalized.includes("getenv(") ||
    normalized === "sk-..." ||
    normalized.endsWith("=sk-...")
  );
}

function isReferenceExpression(value: string): boolean {
  const normalized = value.trim().replace(/[;,]+$/, "").trim();
  if (!normalized || /["'`]/.test(normalized)) return false;
  const memberReference = normalized.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\.(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*$/);
  return (
    Boolean(memberReference && /^(?:config|credentials|process|env|settings|secrets|options|runtime|context|this|import|os)$/i.test(memberReference[1])) ||
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\s*\([^;\r\n]*\)$/.test(normalized)
  );
}

function credentialValueFromMatch(match: string): string {
  const separator = match.search(/[:=]\s*/);
  return separator < 0 ? "" : match.slice(separator).replace(/^[:=]\s*/, "");
}

function isReferenceCredentialMatch(pattern: RegExp, match: string): boolean {
  return CREDENTIAL_EXPRESSION_PATTERNS.has(pattern) && isReferenceExpression(credentialValueFromMatch(match));
}

function shouldRedactCredentialMatch(match: string): boolean {
  return !isReferenceExpression(credentialValueFromMatch(match));
}

function redactSecretAssignment(value: string): string {
  const index = value.indexOf("=");
  if (index < 0) return "[REDACTED_SECRET]";
  return `${value.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
}
