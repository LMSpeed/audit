const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
  /\b(sk|ak|pk|rk|gsk|hf)_[A-Za-z0-9._-]{8,}\b/g,
  /\b(sk|ak|pk|rk|gsk|hf)-[A-Za-z0-9._-]{8,}\b/g,
];

const KEY_VALUE_PATTERN =
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|authorization)(\s*[:=]\s*)([^\n\s"'`]+)/gi;

const INTERNAL_URL_PATTERN =
  /\b(upstream[_-]?url|internal[_-]?url|backend[_-]?url)(\s*[:=]\s*)https?:\/\/[^\s"'`]+/gi;

export function redactRelayAuditText(text: string) {
  let redacted = text;

  for (const pattern of TOKEN_PATTERNS) {
    redacted = redacted.replace(pattern, '[redacted-token]');
  }

  redacted = redacted.replace(
    KEY_VALUE_PATTERN,
    (_match, key: string, separator: string) => {
      const value =
        key.toLowerCase() === 'authorization'
          ? '[redacted-token]'
          : '[redacted]';
      return `${key}${separator}${value}`;
    }
  );

  redacted = redacted.replace(
    INTERNAL_URL_PATTERN,
    (_match, key: string, separator: string) =>
      `${key}${separator}[redacted-url]`
  );

  redacted = redacted.replace(
    /\b(DATABASE_URL|CLIENT_SECRET|ACCESS_TOKEN|PASSWORD)\b(\s*[:=]\s*)([^\s"',}]+)/gi,
    '$1$2[redacted]'
  );
  redacted = redacted.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+:[^\s/@"']+@/gi,
    '$1[redacted]@'
  );

  return redacted;
}
