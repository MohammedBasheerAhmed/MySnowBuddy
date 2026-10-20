// Smart selection: what is this text the user just selected, and what would they want to do with it?
// Pure and deterministic (no DOM, no network), so every rule is unit tested (tests/smartselect.test.js).
// src/content/smartSelect.js shows the answer in the popover.
//
// The rule that matters most: stay quiet. A popover for every selected word would be worse than none, so a
// kind is only reported when the text is confidently that thing (a JSON blob that parses, Base64 that decodes
// to readable text, a 10-digit number in the epoch range, ...). Lookups that need the instance (table names,
// record numbers) are only candidates here; the caller shows nothing when the lookup finds nothing.

import { parseRecordNumber } from './recordNumber.js';

export const MIN_SELECTION = 6;
export const MAX_SELECTION = 60000;
const MAX_BODY = 4000;
const MAX_ROWS = 8;

/** Kinds that need the instance to confirm them; the popover stays silent when the lookup comes back empty. */
export const LOOKUP_KINDS = new Set(['recordNumber', 'table', 'field']);

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const HEX_ONLY_RE = /^[0-9a-f]+$/i;
const B64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const EPOCH_S_RE = /^\d{10}$/;
const EPOCH_MS_RE = /^\d{13}$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z?$/;
const TABLE_RE = /^[a-z][a-z0-9_]{3,79}$/;
const FIELD_RE = /^([a-z][a-z0-9_]{2,79})\.([a-z][a-z0-9_]{1,79})$/;

// 2000-01-01 to 2050-01-01. A bare 10-digit number outside this is more likely a phone number or an id.
const EPOCH_MIN_S = 946684800;
const EPOCH_MAX_S = 2524608000;

/** The selection as the detector sees it: trimmed, or '' when it is too small or too large to bother with. */
export function selectionCandidate(text) {
  const value = String(text ?? '').trim();
  return value.length >= MIN_SELECTION && value.length <= MAX_SELECTION ? value : '';
}

// --- Detectors ------------------------------------------------------------------------------------

export function parseJson(text) {
  const value = String(text ?? '').trim();
  if (value.length < 8 || !/^[[{]/.test(value) || !/[\]}]$/.test(value)) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') return null;
    if (Array.isArray(parsed) ? parsed.length < 1 : Object.keys(parsed).length < 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

const XML_TOKEN_RE = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][^<>]*>|[^<]+/g;

/** Tokens of well-formed XML, or null. Checks nesting only; attributes are not validated. */
function xmlTokens(text) {
  const tokens = [];
  let consumed = 0;
  XML_TOKEN_RE.lastIndex = 0;
  for (let m = XML_TOKEN_RE.exec(text); m; m = XML_TOKEN_RE.exec(text)) {
    if (m.index !== consumed) return null; // a stray "<" or ">"
    consumed += m[0].length;
    const raw = m[0];
    let type = 'text';
    if (raw.startsWith('<!--')) type = 'comment';
    else if (raw.startsWith('<![CDATA[')) type = 'cdata';
    else if (raw.startsWith('<?') || raw.startsWith('<!')) type = 'decl';
    else if (raw.startsWith('</')) type = 'close';
    else if (raw.startsWith('<')) type = /\/\s*>$/.test(raw) ? 'self' : 'open';
    const name = type === 'open' || type === 'close' || type === 'self' ? /^<\/?([A-Za-z_][\w:.-]*)/.exec(raw)?.[1] : undefined;
    tokens.push({ type, raw, name });
  }
  if (consumed !== text.length) return null;
  const stack = [];
  let elements = 0;
  let roots = 0;
  for (const t of tokens) {
    if (t.type === 'open') {
      if (!stack.length) roots += 1;
      stack.push(t.name);
      elements += 1;
    } else if (t.type === 'self') {
      if (!stack.length) roots += 1;
      elements += 1;
    } else if (t.type === 'close') {
      if (stack.pop() !== t.name) return null;
    } else if (t.type === 'text' && !stack.length && t.raw.trim()) {
      return null; // loose text outside the root
    }
  }
  if (stack.length || roots !== 1 || !elements) return null;
  return { tokens, elements, root: tokens.find((t) => t.name)?.name };
}

/** Pretty-printed and minified XML, or null when the text is not well-formed. */
export function parseXml(text) {
  const value = String(text ?? '').trim();
  if (value.length < 8 || !value.startsWith('<') || !value.endsWith('>')) return null;
  const parsed = xmlTokens(value);
  if (!parsed) return null;
  const { tokens } = parsed;
  const lines = [];
  let depth = 0;
  const pad = () => '  '.repeat(depth);
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type === 'text') {
      if (t.raw.trim()) lines.push(pad() + t.raw.trim().replace(/\s+/g, ' '));
    } else if (t.type === 'open') {
      const text1 = tokens[i + 1];
      const close = tokens[i + 2];
      // <name>short text</name> stays on one line.
      if (text1?.type === 'text' && close?.type === 'close' && text1.raw.trim() && !/\n/.test(text1.raw.trim())) {
        lines.push(`${pad()}${t.raw}${text1.raw.trim()}${close.raw}`);
        i += 2;
      } else {
        lines.push(pad() + t.raw);
        depth += 1;
      }
    } else if (t.type === 'close') {
      depth = Math.max(0, depth - 1);
      lines.push(pad() + t.raw);
    } else {
      lines.push(pad() + t.raw);
    }
  }
  const minified = tokens
    .filter((t) => t.type !== 'comment' && !(t.type === 'text' && !t.raw.trim()))
    .map((t) => (t.type === 'text' ? t.raw.trim() : t.raw))
    .join('');
  return { pretty: lines.join('\n'), minified, elements: parsed.elements, root: parsed.root };
}

function bytesToText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function printableShare(text) {
  if (!text) return 0;
  let good = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 0xfffd) continue;
    if (code >= 32 || code === 9 || code === 10 || code === 13) good += 1;
  }
  return good / [...text].length;
}

/** Decode Base64 / Base64url to UTF-8 text when it is mostly readable, else null. */
export function decodeBase64Text(text, { lenient = false } = {}) {
  const value = String(text ?? '').trim();
  if (value.length < (lenient ? 4 : 12) || !B64_RE.test(value) || HEX_ONLY_RE.test(value) || /^\d+$/.test(value)) return null;
  const urlSafe = /[-_]/.test(value);
  let norm = value.replace(/-/g, '+').replace(/_/g, '/');
  const bare = norm.replace(/=+$/, '');
  if (bare.length % 4 === 1) return null;
  if (!lenient && !urlSafe && !/=$/.test(norm) && bare.length % 4 !== 0) return null; // standard Base64 is padded
  norm = bare + '='.repeat((4 - (bare.length % 4)) % 4);
  let bytes;
  try {
    const bin = globalThis.atob(norm);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  const decoded = bytesToText(bytes);
  if (decoded === null || decoded.length < (lenient ? 2 : 4) || printableShare(decoded) < 0.97) return null;
  return decoded;
}

/** { header, payload } of a JSON Web Token (decoded only; the signature is never checked), or null. */
export function parseJwt(text) {
  const value = String(text ?? '').trim();
  const parts = value.split('.');
  if (parts.length !== 3 || !/^[\w-]{6,}$/.test(parts[0]) || !/^[\w-]{6,}$/.test(parts[1]) || !/^[\w-]*$/.test(parts[2])) return null;
  const header = parseJson(decodeBase64Text(parts[0], { lenient: true }) ?? '');
  const payload = parseJson(decodeBase64Text(parts[1], { lenient: true }) ?? '');
  if (!header || Array.isArray(header) || !(header.alg || header.typ) || !payload) return null;
  return { header, payload };
}

/** The decoded text of URL-encoded input ("active%3Dtrue%5Epriority%3D1"), or null. */
export function decodeUrlEncoded(text) {
  const value = String(text ?? '').trim();
  if (value.length < 8 || /\s/.test(value)) return null;
  if ((value.match(/%[0-9A-Fa-f]{2}/g) || []).length < 2) return null;
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
    return decoded !== value ? decoded : null;
  } catch {
    return null;
  }
}

/** A Date for an epoch number in seconds (10 digits) or milliseconds (13 digits), or null. */
export function parseEpoch(text) {
  const value = String(text ?? '').trim();
  let ms = null;
  if (EPOCH_S_RE.test(value)) ms = Number(value) * 1000;
  else if (EPOCH_MS_RE.test(value)) ms = Number(value);
  if (ms === null || ms < EPOCH_MIN_S * 1000 || ms > EPOCH_MAX_S * 1000) return null;
  return { date: new Date(ms), unit: value.length === 10 ? 'seconds' : 'milliseconds' };
}

/** ServiceNow's stored date-time "YYYY-MM-DD HH:MM:SS" (UTC in the database) as a UTC Date, or null. */
export function parseDateTime(text) {
  const m = DATETIME_RE.exec(String(text ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/** A table name worth checking against the instance. Needs an underscore: plain words are ordinary text. */
export function tableCandidate(text) {
  const value = String(text ?? '').trim();
  return TABLE_RE.test(value) && value.includes('_') && !/__/.test(value) && !value.endsWith('_') ? value : '';
}

/** { table, field } for "table.field" where the table part is a table candidate. */
export function fieldCandidate(text) {
  const m = FIELD_RE.exec(String(text ?? '').trim());
  return m && tableCandidate(m[1]) ? { table: m[1], field: m[2] } : null;
}

/**
 * What the selection is, most specific first. Empty when it is ordinary text.
 * `extra` lets a caller add detectors: [{ kind, detect(text) => boolean }], tried last.
 * @returns {string[]}
 */
export function classify(text, { extra = [] } = {}) {
  const value = selectionCandidate(text);
  if (!value) return [];
  const kinds = [];
  if (SYS_ID_RE.test(value)) return ['sysid'];
  if (parseJwt(value)) kinds.push('jwt');
  if (parseJson(value)) kinds.push('json');
  if (parseXml(value)) kinds.push('xml');
  if (parseEpoch(value)) kinds.push('epoch');
  if (parseDateTime(value)) kinds.push('datetime');
  if (parseRecordNumber(value)) kinds.push('recordNumber');
  if (!kinds.length && decodeBase64Text(value) !== null) kinds.push('base64');
  if (decodeUrlEncoded(value) !== null) kinds.push('urlencoded');
  if (tableCandidate(value)) kinds.push('table');
  if (fieldCandidate(value)) kinds.push('field');
  extra.forEach((detector) => {
    try {
      if (detector.detect(value) && !kinds.includes(detector.kind)) kinds.push(detector.kind);
    } catch {
      // A broken extra detector must not silence the built-in ones.
    }
  });
  return kinds;
}

// --- Descriptions ---------------------------------------------------------------------------------

const clip = (text, max = MAX_BODY) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "3 days ago" / "in 2 hours" / "just now". */
export function relativeTime(date, now = new Date()) {
  const diff = date.getTime() - now.getTime();
  const abs = Math.abs(diff);
  if (abs < 45000) return 'just now';
  const units = [
    ['year', 365 * 86400000],
    ['month', 30 * 86400000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
  ];
  for (const [name, size] of units) {
    if (abs >= size) {
      const n = Math.round(abs / size);
      return diff < 0 ? `${plural(n, name)} ago` : `in ${plural(n, name)}`;
    }
  }
  return 'just now';
}

/** "YYYY-MM-DD HH:MM:SS" of a Date in a time zone (the viewer's own when `timeZone` is omitted). */
export function formatStamp(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function valuePreview(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array (${plural(value.length, 'item')})`;
  if (typeof value === 'object') return `object (${plural(Object.keys(value).length, 'key')})`;
  const text = typeof value === 'string' ? `"${value}"` : String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function jsonDescription(parsed) {
  const pretty = JSON.stringify(parsed, null, 2);
  const minified = JSON.stringify(parsed);
  const isArray = Array.isArray(parsed);
  const entries = isArray ? parsed.map((v, i) => [`[${i}]`, v]) : Object.entries(parsed);
  // The label column is narrow; the full key is in the pretty-printed body below.
  const rows = entries.slice(0, MAX_ROWS).map(([k, v]) => ({ label: k.length > 15 ? `${k.slice(0, 14)}…` : k, value: valuePreview(v), mono: true }));
  if (entries.length > MAX_ROWS) rows.push({ label: '…', value: `${entries.length - MAX_ROWS} more` });
  return {
    title: 'JSON',
    subtitle: isArray ? plural(parsed.length, 'item') : plural(entries.length, 'key'),
    rows,
    body: clip(pretty),
    texts: { pretty, minified },
  };
}

/**
 * What to show for one kind. `now` and `timeZone` make the time rows testable.
 * @returns {{kind: string, title: string, subtitle?: string, rows: object[], body?: string, texts: object} | null}
 */
export function describeSelection(text, kind, { now = new Date(), timeZone } = {}) {
  const value = String(text ?? '').trim();
  switch (kind) {
    case 'json': {
      const parsed = parseJson(value);
      return parsed ? { kind, ...jsonDescription(parsed) } : null;
    }
    case 'xml': {
      const xml = parseXml(value);
      if (!xml) return null;
      return {
        kind,
        title: 'XML',
        subtitle: `<${xml.root}> · ${plural(xml.elements, 'element')}`,
        rows: [],
        body: clip(xml.pretty),
        texts: { pretty: xml.pretty, minified: xml.minified },
      };
    }
    case 'jwt': {
      const jwt = parseJwt(value);
      if (!jwt) return null;
      const rows = [{ label: 'Algorithm', value: String(jwt.header.alg || jwt.header.typ), mono: true }];
      ['iss', 'sub', 'aud'].forEach((k) => {
        if (jwt.payload[k] !== undefined) rows.push({ label: k, value: valuePreview(jwt.payload[k]), mono: true });
      });
      ['iat', 'nbf', 'exp'].forEach((k) => {
        const n = Number(jwt.payload[k]);
        if (Number.isFinite(n) && n > 0) {
          const d = new Date(n * 1000);
          rows.push({ label: { iat: 'Issued', nbf: 'Not before', exp: 'Expires' }[k], value: `${formatStamp(d, timeZone)} (${relativeTime(d, now)})` });
        }
      });
      const pretty = JSON.stringify({ header: jwt.header, payload: jwt.payload }, null, 2);
      return { kind, title: 'JSON Web Token', subtitle: 'decoded, signature not checked', rows, body: clip(pretty), texts: { pretty, decoded: pretty } };
    }
    case 'base64': {
      const decoded = decodeBase64Text(value);
      if (decoded === null) return null;
      const asJson = parseJson(decoded);
      const asXml = asJson ? null : parseXml(decoded);
      const pretty = asJson ? JSON.stringify(asJson, null, 2) : asXml ? asXml.pretty : decoded;
      return {
        kind,
        title: 'Base64',
        subtitle: `decoded text${asJson ? ' (JSON)' : asXml ? ' (XML)' : ''} · ${plural([...decoded].length, 'character')}`,
        rows: [],
        body: clip(pretty),
        texts: { decoded, pretty },
      };
    }
    case 'urlencoded': {
      const decoded = decodeUrlEncoded(value);
      if (decoded === null) return null;
      return { kind, title: 'URL-encoded', subtitle: 'decoded', rows: [], body: clip(decoded), texts: { decoded } };
    }
    case 'epoch': {
      const epoch = parseEpoch(value);
      if (!epoch) return null;
      return {
        kind,
        title: `Epoch ${epoch.unit}`,
        rows: [
          { label: 'Your time', value: formatStamp(epoch.date, timeZone) },
          { label: 'UTC', value: formatStamp(epoch.date, 'UTC') },
          { label: 'When', value: relativeTime(epoch.date, now) },
        ],
        texts: { local: formatStamp(epoch.date, timeZone), utc: formatStamp(epoch.date, 'UTC'), iso: epoch.date.toISOString() },
      };
    }
    case 'datetime': {
      const asUtc = parseDateTime(value);
      if (!asUtc) return null;
      const shown = formatStamp(asUtc, timeZone);
      // The same digits read as the viewer's own clock time: what UTC would that be?
      const m = DATETIME_RE.exec(value);
      const asLocal = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
      return {
        kind,
        title: 'Date and time',
        subtitle: 'the database stores UTC; the UI shows your time zone',
        rows: [
          { label: 'If it is UTC', value: `${shown} your time (${relativeTime(asUtc, now)})` },
          ...(timeZone ? [] : [{ label: 'If it is your time', value: `${formatStamp(asLocal, 'UTC')} UTC (${relativeTime(asLocal, now)})` }]),
        ],
        texts: { iso: asUtc.toISOString(), local: shown },
      };
    }
    default:
      return null;
  }
}

/** The kind whose result the popover leads with, among those that need no lookup. */
export const firstLocalKind = (kinds) => kinds.find((k) => !LOOKUP_KINDS.has(k) && k !== 'sysid') || '';
