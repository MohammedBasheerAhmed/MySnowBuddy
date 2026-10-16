// Regex-based redaction applied to everything sent to an LLM provider. Callers
// redact page/instance content where they build prompts, and providers/index.js
// runs redactMessages() over every request as the last line of defence.
// This is a best-effort safety net, NOT a guarantee: see docs/decisions.md and
// README "Known limitations".
//
// Rules are written to leave ordinary code alone: a key must END with a secret
// word (passwordLabel is not a secret, password is), a quoted value must not
// start with whitespace or "+" (so 'Password: ' + x is kept), and unquoted
// values that read like code (member access, calls, keywords) are kept.

export const REDACTED = '[REDACTED]';

// Names whose value is a secret. Matched case-insensitively at the END of a key,
// so client_secret, x-api-key, glide.ldap.password and accessToken all count.
const SECRET_WORDS =
  'password|passwd|passphrase|pwd|secret|secret[_-]?key|api[_-]?key|apikey|access[_-]?key|private[_-]?key|' +
  'token|g_ck|sysparm_ck|jsessionid|session[_-]?id|glide_session_store';
const KEY = String.raw`[A-Za-z0-9_.$-]*?(?:${SECRET_WORDS})\d*`;
// The key must not start in the middle of an identifier.
const KEY_START = String.raw`(?<![A-Za-z0-9_$])`;
const SEP = String.raw`\s*(?::|=(?!=))\s*`; // an assignment, never a == / === comparison
const SECRET_NAME_RE = new RegExp(`(?:${SECRET_WORDS})\\d*$`, 'i');
const SECRET_WORD_IN = new RegExp(`(?:${SECRET_WORDS})`, 'i');

// Placeholders and values that are not secrets even under a secret key.
const NOT_A_SECRET = /^(?:\[REDACTED\]|\*+|x+|\.{2,}|\u2026|null|undefined|true|false|none|n\/a|<[^>]*>|\{\{[^}]*\}\}|\$\{[^}]*\})$/i;
const AUTH_SCHEME_ONLY = /^(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|SSWS)\s*$/i;

function keepPrefix(prefix, value, suffix) {
  if (value.includes(REDACTED) || NOT_A_SECRET.test(value.trim()) || AUTH_SCHEME_ONLY.test(value)) return null;
  return `${prefix}${REDACTED}${suffix}`;
}

// Unquoted values: kept when they read like code rather than data.
const CODE_LIKE = [
  /^(?:null|undefined|true|false|this|new|function|typeof|void|return|var|let|const)$/,
  /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/, // member access: current.u_token, payload?.apiKey
  /^[A-Za-z_$]+$/, // a bare identifier or an English word without digits
  /^\d{1,6}$/, // a small number (a count or a limit)
];

const RULES = [
  // -----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY----- (also when truncated before the END line,
  // and with JSON-escaped \n). Only key material is taken: code that merely mentions the BEGIN line is kept.
  {
    re: /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)((?:[A-Za-z0-9+/=\s:,.-]|\\[rn])*?)(-----END [A-Z0-9 ]*PRIVATE KEY-----|(?=[^A-Za-z0-9+/=\s:,.\\-])|$)/g,
    fn: (m, begin, body, end) => (body.replace(/\\[rn]|\s/g, '').length >= 16 ? `${begin}${REDACTED}${end || ''}` : m),
  },
  // user:password@host in any URL.
  {
    re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@'"]+:)([^\s@/'"]+)(@)/gi,
    fn: (m, pre, pass, at) => (pass === REDACTED ? m : `${pre}${REDACTED}${at}`),
  },
  // Authorization: Basic dXNlcjpwYXNz / setRequestHeader('Authorization', 'Bearer abc...')
  {
    re: /(\b(?:Proxy-)?Authorization\\?["']?\s*[:=,]\s*\\?["']?\s*(?:Basic|Bearer|Token|Digest|Negotiate|NTLM|ApiKey|SSWS)\s+)([A-Za-z0-9+/=._~-]{6,})/gi,
    fn: (m, pre) => `${pre}${REDACTED}`,
  },
  // A bare bearer token (the token must look like one: digits or punctuation, not an English word).
  {
    re: /(\bBearer\s+)(?=[A-Za-z0-9\-_.=~+/]*[0-9\-_.=~+/])([A-Za-z0-9\-_.=~+/]{10,})/g,
    fn: (m, pre) => `${pre}${REDACTED}`,
  },
  // JSON Web Tokens.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, fn: () => REDACTED },
  // Well-known key formats: AWS access key ids, OpenAI/Anthropic, GitHub, Slack, Google.
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, fn: () => REDACTED },
  { re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, fn: () => REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, fn: () => REDACTED },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, fn: () => REDACTED },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, fn: () => REDACTED },
  // "password": "x" and var password = "x" inside JSON-escaped text (a script serialized with JSON.stringify).
  {
    re: new RegExp(String.raw`(${KEY_START}${KEY}(?:\\"|["'])?${SEP}\\")((?![\s+])(?:[^"\\\r\n]|\\[^"\r\n])+?)(\\")`, 'gi'),
    fn: (m, pre, value, post) => keepPrefix(pre, value, post) ?? m,
  },
  // password = "x", password: 'x', "api_key": "x", client_secret='x'
  {
    re: new RegExp(String.raw`(${KEY_START}${KEY}["']?${SEP}")((?![\s+])(?:[^"\\\r\n]|\\.)+?)(")`, 'gi'),
    fn: (m, pre, value, post) => keepPrefix(pre, value, post) ?? m,
  },
  {
    re: new RegExp(String.raw`(${KEY_START}${KEY}["']?${SEP}')((?![\s+])(?:[^'\\\r\n]|\\.)+?)(')`, 'gi'),
    fn: (m, pre, value, post) => keepPrefix(pre, value, post) ?? m,
  },
  // Call arguments: setValue('u_password', 'x'), setRequestHeader('X-Api-Key', 'x'), addParam("token", "x").
  // Only right after "(": in a list such as ["password", "email"] the next string is a name, not a value.
  {
    re: new RegExp(String.raw`(\(\s*\\?(["'])[A-Za-z0-9_.$-]*?(?:${SECRET_WORDS}|authorization)\d*\\?\2\s*,\s*\\?(["']))((?![\s+])(?:(?!\\?\3)[^\r\n])+?)(\\?\3)`, 'gi'),
    fn: (m, pre, _q1, _q2, value, post) => keepPrefix(pre, value, post) ?? m,
  },
  // rm.setBasicAuth('user', 'password')
  {
    re: /(\bsetBasicAuth\s*\(\s*(["'])[^"'\r\n]*\2\s*,\s*(["']))([^"'\r\n]+)(\3)/g,
    fn: (m, pre, _q1, _q2, value, post) => keepPrefix(pre, value, post) ?? m,
  },
  // Unquoted: ?api_key=abc&..., password=hunter2 in a log line, TOKEN: abc123 in config text.
  {
    re: new RegExp(String.raw`(?<![^\s?&;,{(\[])(${KEY}\s*[=:]\s*)([^\s'"&,;<>{}()\[\]\\=:][^\s'"&,;<>{}()\[\]\\]*)`, 'gi'),
    fn: (m, pre, value, offset, whole) => {
      if (value.length < 3 || NOT_A_SECRET.test(value)) return m;
      const before = whole[offset - 1] || '';
      const after = whole[offset + m.length] || '';
      if (before !== '?' && before !== '&') {
        // getCsrfToken: getCsrfToken2 names a variable; a real secret value does not repeat the word.
        if (after === '(' || CODE_LIKE.some((re) => re.test(value)) || SECRET_WORD_IN.test(value)) return m;
      }
      return `${pre}${REDACTED}`;
    },
  },
];

// sys_properties rows: { "name": "x.y.password", "value": "..." } in JSON text (one level of
// nesting allowed for display-value rows), and <name>...password</name> ... <value>...</value> in XML.
const JSON_OBJECT = /\{(?:[^{}]|\{[^{}]*\})*\}/g;
const JSON_NAME = /"name"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|\{[^{}]*?"value"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\})/;
const JSON_VALUE = /("value"\s*:\s*)("(?:[^"\\]|\\.)*"|\{[^{}]*\})/g;

function redactPropertyRows(text) {
  let out = text;
  if (out.includes('"name"') && out.includes('"value"')) {
    out = out.replace(JSON_OBJECT, (obj) => {
      const name = JSON_NAME.exec(obj);
      if (!name || !isSecretName(name[1] ?? name[2])) return obj;
      const nameEnd = name.index + name[0].length;
      return obj.replace(JSON_VALUE, (m, pre, value, offset) => {
        if (offset >= name.index && offset < nameEnd) return m; // the name's own {value} pair
        if (value === '""' || value.includes(REDACTED)) return m;
        return value.startsWith('{') ? `${pre}{"value": "${REDACTED}"}` : `${pre}"${REDACTED}"`;
      });
    });
  }
  if (out.includes('<name>') && out.includes('<value>')) {
    out = out
      .replace(/(<name>([^<]*)<\/name>(?:(?!<\/?name>)[\s\S]){0,4000}?<value>)([^<]+)(<\/value>)/g, (m, pre, name, value, post) =>
        isSecretName(name) && value !== REDACTED ? `${pre}${REDACTED}${post}` : m
      )
      .replace(/(<value>)([^<]+)(<\/value>(?:(?!<\/?value>)[\s\S]){0,4000}?<name>([^<]*)<\/name>)/g, (m, pre, value, post, name) =>
        isSecretName(name) && value !== REDACTED ? `${pre}${REDACTED}${post}` : m
      );
  }
  return out;
}

/**
 * Lines where the [REDACTED] placeholder stands where a secret would be (password = '[REDACTED]',
 * setBasicAuth(u, '[REDACTED]')). A model that read a redacted script and writes it back would
 * overwrite the real secret with the placeholder. Found by putting a secret-looking value in place
 * of each placeholder and asking the redactor whether it would hide it.
 * @returns {{secret: number[], other: number[]}} 1-based line numbers
 */
export function findRedactionPlaceholders(text) {
  const secret = [];
  const other = [];
  if (typeof text !== 'string' || !text.includes(REDACTED)) return { secret, other };
  const sentinel = 'Zq9Sentinel7xQ';
  text.split('\n').forEach((line, i) => {
    if (!line.includes(REDACTED)) return;
    const probe = line.split(REDACTED).join(sentinel);
    const kept = redactSecrets(probe).split(sentinel).length;
    (kept < probe.split(sentinel).length ? secret : other).push(i + 1);
  });
  return { secret, other };
}

/** Whether a property / field / key name holds a secret (glide.x.password, client_secret, apiKey). */
export function isSecretName(name) {
  return typeof name === 'string' && SECRET_NAME_RE.test(name.trim());
}

/** Redact secrets in a piece of text. Idempotent; non-strings are returned unchanged. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = redactPropertyRows(text);
  for (const { re, fn } of RULES) {
    re.lastIndex = 0;
    out = out.replace(re, fn);
  }
  return out;
}

function redactContent(content) {
  if (typeof content === 'string') return redactSecrets(content);
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? { ...part, text: redactSecrets(part.text) } : part));
  }
  return content;
}

/**
 * Last line of defence at the provider boundary: redact the text of every
 * neutral message (system, user, tool results, assistant text). Tool-call ids,
 * names and arguments and the provider's raw assistant blocks (Anthropic
 * thinking blocks must be replayed byte for byte) are passed through untouched:
 * they are the model's own output, produced from text that was already redacted.
 */
export function redactMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== 'object' || m.content === undefined || m.content === null) return m;
    const content = redactContent(m.content);
    return content === m.content ? m : { ...m, content };
  });
}
