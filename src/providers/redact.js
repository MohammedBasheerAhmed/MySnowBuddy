// Basic regex-based redaction applied to script/config content before it is
// sent to any LLM provider. This is a best-effort safety net, NOT a
// guarantee — see docs/decisions.md and README "Known limitations".
const SECRET_PATTERNS = [
  /(['"]?password['"]?\s*[:=]\s*['"])([^'"]+)(['"])/gi,
  /(['"]?api[_-]?key['"]?\s*[:=]\s*['"])([^'"]+)(['"])/gi,
  /(['"]?secret['"]?\s*[:=]\s*['"])([^'"]+)(['"])/gi,
  /(Bearer\s+)[A-Za-z0-9\-_.=]{10,}/gi,
  /(sk-[A-Za-z0-9]{16,})/g,
];

export function redactSecrets(text) {
  if (!text) return text;
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, ...groups) => {
      // groups from a capturing pattern like (prefix)(secret)(suffix)
      const captured = groups.filter((g) => typeof g === 'string');
      if (captured.length >= 3) {
        return `${captured[0]}[REDACTED]${captured[2]}`;
      }
      return '[REDACTED]';
    });
  }
  return redacted;
}
