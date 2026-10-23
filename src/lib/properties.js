// System properties (/prop), the pure half. sys_properties steer half of an instance, and the platform's own UI makes the
// four things a developer needs slow: find one, read it (and what it means), see which scripts read it, and flip it for
// a test and put it back. This file holds the rules that must be right and are therefore unit-tested
// (tests/properties.test.js): what is secret and never shown, how a stored value is typed and edited, how search results
// are ranked, how a script is read to tell a real gs.getProperty call from a comment or a look-alike, the list of
// developer switches, the bookkeeping that makes "restore" possible, and the wording of the confirmations.
// No DOM, no network. The instance half is src/content/properties.js; the panel is src/sidebar/PropertiesPanel.jsx.
//
// Assumptions about the instance (sys_properties columns and API shapes) are listed in docs/features/properties.md and
// src/lib/requirements/properties.js, because they could not be checked against a live instance when this was written.

import { redactSecrets } from '../providers/redact.js';

export const PROPERTY_TABLE = 'sys_properties';
export const SEARCH_LIMIT = 100;
export const CHANGES_KEY = 'mysnowbuddy_property_changes';
export const CHANGES_CAP = 30;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const NAME_RE = /^[A-Za-z0-9_.\-]+$/;

// Columns the panel asks for. name, value, type and sys_id are certain on every instance. The rest are asked for too, but a
// column the instance does not know is silently left out of the answer, so the panel finds out which came back
// (see readableColumns in src/content/properties.js) and only uses a column for a search condition when it did: a condition on a missing column is ignored by
// the instance and would match every row.
export const CORE_COLUMNS = ['sys_id', 'name', 'value', 'type'];
export const OPTIONAL_COLUMNS = ['description', 'choices', 'suffix', 'is_private', 'read_roles', 'write_roles', 'sys_scope', 'sys_scope.scope', 'sys_updated_on', 'sys_updated_by'];
export const ALL_COLUMNS = [...CORE_COLUMNS, ...OPTIONAL_COLUMNS];

const clip = (text, max = 160) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** The stored value of a field, whether the Table API gave a plain string or { value, display_value }. */
export const rawOf = (v) => (v && typeof v === 'object' ? (v.value == null ? '' : String(v.value)) : v == null ? '' : String(v));
/** What a person sees: the display value when there is one. */
export const shownOf = (v) => (v && typeof v === 'object' ? String(v.display_value ?? v.value ?? '') : v == null ? '' : String(v));

// --- Secrets ------------------------------------------------------------------------------------------------------

const SECRET_WORD_RE = /(password|passwd|passphrase|secret|token|credential|key)/i;
// Words that contain "key" but are settings, not secrets (glide.ui.keyboard_shortcuts). Anything else with "key" is hidden.
const HARMLESS_KEY_WORDS_RE = /(keyboard|keyword|keystroke|keypad|hotkey|monkey|turkey)s?/gi;

/** True when a property NAME says the value is a secret: password, secret, token, key, credential. */
export function nameLooksSecret(name) {
  return SECRET_WORD_RE.test(String(name || '').replace(HARMLESS_KEY_WORDS_RE, ''));
}

/** Why a property's value must never be shown, copied or edited here; '' when it is an ordinary value. */
export function secretReason({ name = '', type = '', value = '' } = {}) {
  if (/password|encrypt/i.test(String(type))) return 'It is a password-type property.';
  if (nameLooksSecret(name)) return 'Its name contains password, secret, token, key or credential.';
  if (value && redactSecrets(String(value)) !== String(value)) return 'The value contains a credential.';
  return '';
}

// --- Typing a property --------------------------------------------------------------------------------------------

/** The stored `type` of a property reduced to what the editor needs. */
export function typeKind(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'string';
  if (/password|encrypt/.test(t)) return 'password';
  if (/^bool/.test(t)) return 'boolean';
  if (/^int|^number|^long$|^decimal/.test(t)) return 'integer';
  if (/choice/.test(t)) return 'choice';
  if (/colou?r/.test(t)) return 'color';
  if (/image/.test(t)) return 'image';
  return 'string';
}

/** "red, green ,blue" -> ['red','green','blue'] (a comma or a new line separates choices). */
export function parseChoices(text) {
  const seen = new Set();
  return String(text || '')
    .split(/[,\n]/)
    .map((c) => c.trim())
    .filter((c) => c && !seen.has(c) && seen.add(c));
}

const boolOf = (value) => (/^true$/i.test(String(value).trim()) ? true : /^false$/i.test(String(value).trim()) ? false : null);

/**
 * How a property is edited. `kind`: toggle (true/false), number, select (a choice list), text, textarea, or none (with
 * the reason it cannot be edited here). A string-typed property whose value is exactly true or false is offered as a toggle,
 * since that is what it is used as; `inferred` says so on screen.
 */
export function editorFor(prop) {
  if (!prop || prop.hidden) return { kind: 'none', reason: 'Hidden: NowBuddy never shows or changes secrets. Open the record in the platform to change it.' };
  if (prop.unreadable) return { kind: 'none', reason: 'The value could not be read, so it is not changed here: your user may not be allowed to read it.' };
  if (!prop.sysId) return { kind: 'none', reason: 'This property has no record to change.' };
  if (prop.typeKind === 'image') return { kind: 'none', reason: 'Image properties are changed on the record in the platform.' };
  if (prop.typeKind === 'boolean') return { kind: 'toggle', inferred: false };
  if (prop.typeKind === 'string' && boolOf(prop.value) !== null && /^(true|false)$/.test(String(prop.value))) return { kind: 'toggle', inferred: true };
  if (prop.typeKind === 'integer') return { kind: 'number' };
  if (prop.typeKind === 'choice' && prop.choices?.length) return { kind: 'select', options: prop.choices };
  if (String(prop.value).includes('\n') || String(prop.value).length > 100) return { kind: 'textarea' };
  return { kind: 'text' };
}

/** Check what the person typed against the property's type. Returns { ok, value } or { ok: false, error }. */
export function validateValue(prop, text) {
  const editor = editorFor(prop);
  if (editor.kind === 'none') return { ok: false, error: editor.reason };
  const value = editor.kind === 'toggle' || editor.kind === 'number' || editor.kind === 'select' ? String(text ?? '').trim() : String(text ?? '');
  if (editor.kind === 'toggle' && !/^(true|false)$/.test(value)) return { ok: false, error: 'Choose true or false.' };
  if (editor.kind === 'number' && !/^-?\d+$/.test(value)) return { ok: false, error: 'This property holds a whole number, for example 30.' };
  if (editor.kind === 'select' && !editor.options.includes(value) && value !== prop.value) return { ok: false, error: `Choose one of: ${editor.options.join(', ')}.` };
  if (/\[REDACTED\]/.test(value)) return { ok: false, error: 'The text contains the [REDACTED] placeholder. Writing it would replace the real value.' };
  // A credential typed into an ordinary property would be written into the audit log and then hidden by NowBuddy itself.
  if (value && secretReason({ value })) return { ok: false, error: 'That value looks like a password, token or key. NowBuddy never writes secrets: change it on the record in the platform.' };
  if (value.length > 100000) return { ok: false, error: 'That value is too long.' };
  if (value === prop.value) return { ok: false, unchanged: true, error: 'That is already the value.' };
  return { ok: true, value };
}

/** One property as the panel holds it. Hidden properties never carry their value. */
export function toProperty(row = {}) {
  const sysId = rawOf(row.sys_id);
  const name = rawOf(row.name);
  const type = rawOf(row.type).trim().toLowerCase();
  const stored = rawOf(row.value);
  const reason = secretReason({ name, type, value: stored });
  const kind = typeKind(type);
  const hidden = Boolean(reason);
  // No value column in the answer means "could not read", which is not the same as an empty value.
  const unreadable = !('value' in row);
  const prop = {
    sysId: SYS_ID_RE.test(sysId) ? sysId : '',
    name,
    type,
    typeLabel: shownOf(row.type) || type || 'string',
    typeKind: kind,
    hidden,
    hiddenReason: reason,
    // The value of a hidden property is dropped here, so nothing downstream can show or copy it.
    value: hidden || unreadable ? '' : stored,
    unreadable,
    empty: !hidden && !unreadable && stored === '',
    long: !hidden && !unreadable && (stored.includes('\n') || stored.length > 120),
    description: rawOf(row.description).trim(),
    choices: kind === 'choice' ? parseChoices(rawOf(row.choices)) : [],
    suffix: rawOf(row.suffix),
    isPrivate: 'is_private' in row ? rawOf(row.is_private) === 'true' : null,
    readRoles: shownOf(row.read_roles),
    writeRoles: shownOf(row.write_roles),
    scope: shownOf(row['sys_scope.scope']) || shownOf(row.sys_scope),
    scopeName: shownOf(row.sys_scope),
    updatedOn: rawOf(row.sys_updated_on),
    updatedBy: rawOf(row.sys_updated_by),
  };
  prop.editor = editorFor(prop);
  return prop;
}

/** What to print for the value: "hidden", "unreadable", "(empty)" or the value itself. */
export function valueText(prop) {
  if (!prop) return '';
  if (prop.hidden) return 'hidden';
  if (prop.unreadable) return 'unreadable';
  return prop.value === '' ? '(empty)' : prop.value;
}

/** The record of a property in the platform; only the record's own sys_id goes into the address. */
export function propertyPath(sysId) {
  return SYS_ID_RE.test(sysId || '') ? `/sys_properties.do?sys_id=${sysId}` : '';
}

// --- Finding ------------------------------------------------------------------------------------------------------

/** The words of a search box: up to four, no encoded-query separators, nothing that starts a script. */
export function searchTokens(query) {
  return String(query || '')
    .replace(/\^/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 4)
    .map((t) => t.slice(0, 80));
}

/** True when `text` looks like one property name (glide.ui.session_timeout), not words to search for. */
export function looksLikePropertyName(text) {
  const t = String(text || '').trim();
  return t.length >= 4 && NAME_RE.test(t) && /[._]/.test(t) && /^[A-Za-z]/.test(t);
}

/**
 * The two searches the instance runs: `name` finds names only (so a name match is never crowded out by a description
 * match) and `wide` also looks in description and value. A word has to appear in the name, the description or the value;
 * every word has to appear somewhere (an ^OR joins the fields of one word, ^ joins the words).
 * `columns` is the set of columns the instance returned; the description is only searched when it exists.
 * @returns {{ tokens: string[], name: string, wide: string }}
 */
export function searchQueries(query, columns = new Set(ALL_COLUMNS)) {
  const tokens = searchTokens(query);
  if (!tokens.length) throw new Error('Type part of a property name, description or value.');
  if (tokens.every((t) => t.length < 2)) throw new Error('Type at least two characters.');
  if (tokens.some((t) => /^\s*javascript\s*:/i.test(t))) throw new Error('That search may not start with "javascript:".');
  const fields = ['name', ...(columns.has('description') ? ['description'] : []), 'value'];
  return {
    tokens,
    name: `${tokens.map((t) => `nameLIKE${t}`).join('^')}^ORDERBYname`,
    wide: `${tokens.map((t) => fields.map((f) => `${f}LIKE${t}`).join('^OR')).join('^')}^ORDERBYname`,
  };
}

const lower = (s) => String(s || '').toLowerCase();
const atBoundary = (name, token) => {
  const at = lower(name).indexOf(lower(token));
  return at === 0 || (at > 0 && /[._-]/.test(name[at - 1]));
};

/**
 * Rank properties for a search box: an exact name first, then names that start with it, names that contain every word,
 * then the description, then the value. The value of a hidden property never counts as a match (so searching cannot be
 * used to probe a secret). Properties that match nothing are dropped. Each gets `matchedIn` and `score`.
 */
export function rankProperties(properties, query) {
  const tokens = searchTokens(query).map(lower);
  if (!tokens.length) return [];
  const whole = lower(String(query || '').trim());
  const scored = [];
  for (const prop of properties || []) {
    const name = lower(prop.name);
    const description = lower(prop.description);
    const value = prop.hidden ? '' : lower(prop.value);
    let score = 0;
    let matchedIn = '';
    if (name === whole) {
      score = 1000;
      matchedIn = 'name';
    } else if (name.startsWith(whole)) {
      score = 800;
      matchedIn = 'name';
    } else if (tokens.every((t) => name.includes(t))) {
      score = 600 + (tokens.every((t) => atBoundary(prop.name, t)) ? 40 : 0);
      matchedIn = 'name';
    } else if (tokens.every((t) => name.includes(t) || description.includes(t))) {
      score = tokens.some((t) => name.includes(t)) ? 400 : 300;
      matchedIn = tokens.some((t) => name.includes(t)) ? 'name' : 'description';
    } else if (tokens.every((t) => name.includes(t) || description.includes(t) || value.includes(t))) {
      score = 200;
      matchedIn = tokens.some((t) => value.includes(t) && !name.includes(t) && !description.includes(t)) ? 'value' : 'description';
    }
    if (!score) continue;
    // Among equals a shorter name is the more specific one.
    scored.push({ ...prop, score: score - Math.min(prop.name.length, 99) / 100, matchedIn });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Pieces of `text` with the parts that match a search word marked: [{ text, hit }]. */
export function highlightParts(text, query) {
  const value = String(text ?? '');
  const tokens = searchTokens(query).map(lower).filter(Boolean);
  if (!value || !tokens.length) return [{ text: value, hit: false }];
  const hay = lower(value);
  const marks = [];
  tokens.forEach((t) => {
    for (let at = hay.indexOf(t); at >= 0; at = hay.indexOf(t, at + t.length)) marks.push([at, at + t.length]);
  });
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  marks.forEach(([s, e]) => {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  });
  const parts = [];
  let cursor = 0;
  merged.forEach(([s, e]) => {
    if (s > cursor) parts.push({ text: value.slice(cursor, s), hit: false });
    parts.push({ text: value.slice(s, e), hit: true });
    cursor = e;
  });
  if (cursor < value.length) parts.push({ text: value.slice(cursor), hit: false });
  return parts;
}

/** A sentence for the top of a result list. */
export function resultsHeadline({ query, shown, total, capped }) {
  if (!shown) return `No property matches "${clip(query, 60)}".`;
  const base = `${shown} ${shown === 1 ? 'property' : 'properties'} for "${clip(query, 60)}"`;
  if (capped && total > shown) return `${base}, best ${shown} of ${total}. Add another word to narrow it.`;
  if (capped) return `${base}, the first ${shown}. Add another word to narrow it.`;
  return base;
}

// --- Who reads a property: telling a real call from a look-alike --------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** [start, end) ranges of comments in a script, skipping over strings. `//` right after a colon is a URL, not a comment. */
export function commentRanges(src) {
  const ranges = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/' && src[i - 1] !== ':') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      ranges.push([i, j]);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      ranges.push([i, j]);
      i = j;
    } else if (c === '<' && src.startsWith('<!--', i)) {
      let j = src.indexOf('-->', i + 4);
      j = j < 0 ? n : j + 3;
      ranges.push([i, j]);
      i = j;
    } else if (c === '"' || c === "'") {
      // A string ends at its closing quote or at the end of the line (a stray quote must not swallow the file).
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return ranges;
}

const READ_VERB_RE = /^get/i;
const WRITE_VERB_RE = /^(set|put|update)/i;
// gs.getProperty( ' ...   GlideProperties.get( " ...   (the quote is the last character before the name)
const CALL_BEFORE_RE = /\b(gs|GlideSystem|GlideProperties)\s*\.\s*([A-Za-z]+)\s*\(\s*['"]$/;
// The second argument after the name: the default of a read, the new value of a write.
const SECOND_ARG_RE = /^['"]\s*,\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[-\w.$]+(?:\([^()]*\))?)/;

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}
const lineOf = (starts, index) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

/** An argument as it reads in code (quotes kept, so a string stays a string), shortened. */
const argText = (text) => clip(redactSecrets(String(text)), 40);

const LITERAL_RE = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

/**
 * A line of a script that reads a SECRET property, made safe to show: every string literal except the property name is
 * masked, long numbers too, and nothing after the name is kept (that is where the default or the new value sits).
 */
export function maskSecretLine(text, name) {
  const value = String(text ?? '');
  const lowerName = String(name || '').toLowerCase();
  const at = value.toLowerCase().indexOf(lowerName);
  const end = at < 0 ? value.length : Math.min(value.length, at + lowerName.length + 1);
  const head = value.slice(0, end);
  const masked = head.replace(LITERAL_RE, (m, q, inner) => (inner.toLowerCase() === lowerName ? m : `${q}***${q}`)).replace(/\b\d{4,}\b/g, '***');
  // A literal cut open at the end (the name's own quote is kept) is fine; anything that followed is dropped.
  return end < value.length ? `${masked} …` : masked;
}

/** The line around a match, short enough to show and to run the redactor over (a minified script is one long line). */
function lineAround(src, lineStart, lineEnd, at, length) {
  if (lineEnd - lineStart <= 240) return src.slice(lineStart, lineEnd).trim();
  const from = Math.max(lineStart, at - 80);
  const to = Math.min(lineEnd, at + length + 160);
  return `${from > lineStart ? '… ' : ''}${src.slice(from, to).trim()}${to < lineEnd ? ' …' : ''}`;
}

/**
 * Read one script for a property name. Comments are skipped (and counted). Each remaining line holding the whole name is
 * classified: `write` (gs.setProperty), `read` (gs.getProperty, GlideProperties.get), or `mention` (anything else: a log
 * line, a comparison, a name kept in a variable that is not passed to a property call). A name held in a variable
 * (`var KEY = 'glide.x'; gs.getProperty(KEY)`) is followed to the call and reported with `via`.
 * Every line is run through the redactor. `secret: true` (the property is a password, a token, a key...) also masks the
 * other literals on the line and drops `arg`: the default of a read, or the value a script sets, can be the secret itself.
 * @returns {{ lines: Array<{ line: number, text: string, kind: 'read'|'write'|'mention', arg?: string, via?: string, caseDiffers?: boolean }>, inComments: number }}
 */
export function usageLines(source, name, { maxLines = 12, secret = false } = {}) {
  const src = String(source ?? '');
  const out = { lines: [], inComments: 0 };
  if (!src || !name || !NAME_RE.test(name)) return out;
  const re = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$]|\\.[\\w$])`, 'gi');
  const comments = commentRanges(src);
  const starts = lineStarts(src);
  const seen = new Set();
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = m.index;
    if (comments.some(([s, e]) => at >= s && at < e)) {
      out.inComments += 1;
      continue;
    }
    const line = lineOf(starts, at);
    if (seen.has(line) || out.lines.length >= maxLines) continue;
    seen.add(line);
    const lineEnd = src.indexOf('\n', at);
    const lineText = lineAround(src, starts[line - 1], lineEnd < 0 ? src.length : lineEnd, at, m[0].length);
    const entry = { line, text: clip(redactSecrets(secret ? maskSecretLine(lineText, name) : lineText), 200), kind: 'mention' };
    if (m[0] !== name) entry.caseDiffers = true;

    const call = CALL_BEFORE_RE.exec(src.slice(Math.max(0, at - 80), at));
    if (call) {
      const verb = call[2];
      const isRead = READ_VERB_RE.test(verb) && /property|^get$/i.test(verb);
      const isWrite = WRITE_VERB_RE.test(verb) && /property|^set$/i.test(verb);
      if (isRead || isWrite) {
        entry.kind = isWrite ? 'write' : 'read';
        const second = secret ? null : SECOND_ARG_RE.exec(src.slice(at + m[0].length, at + m[0].length + 160));
        if (second) entry.arg = argText(second[1]);
      }
    } else {
      // var KEY = 'glide.x';   KEY: 'glide.x'   this.KEY = 'glide.x'
      const held = /(?:(?:var|let|const)\s+|this\.|[\w$]+\.)?([A-Za-z_$][\w$]*)\s*[:=]\s*['"]$/.exec(src.slice(Math.max(0, at - 80), at));
      if (held) {
        const variable = held[1];
        const useRe = new RegExp(`\\b(?:gs|GlideSystem|GlideProperties)\\s*\\.\\s*(get|set)\\w*\\s*\\(\\s*(?:[\\w$]+\\s*\\.\\s*)*${escapeRegExp(variable)}\\b`, 'g');
        const use = useRe.exec(src);
        if (use) {
          entry.kind = use[1].toLowerCase() === 'set' ? 'write' : 'read';
          entry.via = variable;
        }
      }
    }
    out.lines.push(entry);
  }
  return out;
}

const KIND_RANK = { write: 0, read: 1, mention: 2 };
export const USAGE_KIND_TEXT = { write: 'Sets it', read: 'Reads it', mention: 'Mentions it' };

/**
 * Turn the scripts a search returned into classified hits. `results` are { table, label, sysId, name, field, source, url? }.
 * A script whose only occurrences are inside comments is not a hit; it is counted in `commentOnly`.
 * `secret: true` masks what the lines could reveal of a secret property (see usageLines).
 */
export function classifyUsage(results, name, { secret = false } = {}) {
  const hits = [];
  let commentOnly = 0;
  for (const result of results || []) {
    const { lines, inComments } = usageLines(result.source, name, { secret });
    if (!lines.length) {
      if (inComments) commentOnly += 1;
      continue;
    }
    const kind = lines.reduce((best, l) => (KIND_RANK[l.kind] < KIND_RANK[best] ? l.kind : best), 'mention');
    hits.push({ table: result.table, label: result.label, sysId: result.sysId, name: result.name, field: result.field, url: result.url || '', kind, lines });
  }
  hits.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.label.localeCompare(b.label) || String(a.name).localeCompare(String(b.name)));
  return { hits, commentOnly };
}

export function usageCounts(hits) {
  return { write: hits.filter((h) => h.kind === 'write').length, read: hits.filter((h) => h.kind === 'read').length, mention: hits.filter((h) => h.kind === 'mention').length };
}

/** One honest paragraph: what was found, how much was searched, and what could not be. */
export function usageSummary({ name, hits = [], searched = 0, capped = [], errors = [], commentOnly = 0 }) {
  const c = usageCounts(hits);
  const parts = [];
  if (c.read) parts.push(`read by ${c.read} ${c.read === 1 ? 'script' : 'scripts'}`);
  if (c.write) parts.push(`set by ${c.write} ${c.write === 1 ? 'script' : 'scripts'}`);
  if (c.mention) parts.push(`mentioned in ${c.mention} ${c.read || c.write ? 'more' : c.mention === 1 ? 'script' : 'scripts'}`);
  let text = parts.length ? `${clip(name, 80)} is ${parts.join(', ')}.` : `No active script uses ${clip(name, 80)}.`;
  text += ` ${searched} script ${searched === 1 ? 'table' : 'tables'} searched, active records only.`;
  if (commentOnly) text += ` ${commentOnly} ${commentOnly === 1 ? 'script has' : 'scripts have'} the name only in a comment and ${commentOnly === 1 ? 'is' : 'are'} left out.`;
  if (capped.length) text += ` Only the first 100 matches were read in ${capped.join(', ')}, so there may be more.`;
  if (errors.length) text += ` ${errors.length} ${errors.length === 1 ? 'table' : 'tables'} could not be searched (${errors.map((e) => e.label).join(', ')}).`;
  return text;
}

/** What a search of script text can never find. */
export const USAGE_LIMITS_NOTE = 'A name built up in code, such as "prefix." + key, cannot be found by searching. Flows, workflows and records that are not scripts are not searched.';

// --- Developer switches -------------------------------------------------------------------------------------------

// Properties developers genuinely flip or check, each with what it does and when to be careful. Only names that exist on a
// standard instance. The panel looks every one up and says "not present on this instance" for a missing one; it never
// creates a property.
export const DEV_SWITCHES = [
  {
    name: 'glide.ui.session_timeout',
    what: 'Seconds of inactivity before a user is logged out. Raise it while you test something long.',
    careful: 'It applies to every user. A very long timeout on production is a security risk.',
  },
  {
    name: 'glide.invalid_query.returns_no_rows',
    what: 'When true, a query on a field that does not exist returns no rows. When false, the instance ignores that condition and returns everything.',
    careful: 'Turning it on can make scripts that relied on the old behaviour start returning nothing. Try it on a test instance first.',
  },
  {
    name: 'glide.email.smtp.active',
    what: 'Turns outgoing email on or off for the whole instance.',
    careful: 'Off on production means nobody gets a notification. Turn it back on.',
  },
  {
    name: 'glide.email.read.active',
    what: 'Turns incoming email processing on or off.',
    careful: 'Off means replies and inbound email actions are no longer processed.',
  },
  {
    name: 'glide.email.test.user',
    what: 'When set, every outgoing email goes to this one address instead of the real recipients.',
    careful: 'Set on a test instance it keeps mail from real users. Left set on production, nobody else receives anything.',
  },
  {
    name: 'glide.servlet.uri',
    what: 'The base address used for links in emails and generated pages.',
    careful: 'After a clone it can still point at the source instance. Change it only if you know why.',
  },
  {
    name: 'glide.sys.default.tz',
    what: 'The system time zone, used for users who have none of their own.',
    careful: 'It changes how times are shown to those users. Stored times do not change.',
  },
  {
    name: 'com.glide.attachment.max_size',
    what: 'The largest file, in megabytes, that a user can attach.',
    careful: 'Large uploads load the application nodes and the database.',
  },
  {
    name: 'sn_atf.runner.enabled',
    what: 'Lets the Automated Test Framework run tests on this instance.',
    careful: 'Tests can create and change data. Keep it off on production.',
  },
];

export const DEV_SWITCH_NAMES = DEV_SWITCHES.map((s) => s.name);

/** The switches joined with what the instance returned: { ...switch, found, property }. */
export function mergeSwitches(properties = []) {
  const byName = new Map(properties.map((p) => [p.name, p]));
  return DEV_SWITCHES.map((s) => {
    const property = byName.get(s.name) || null;
    return { ...s, found: Boolean(property), property };
  });
}

// --- Changes made from the panel: what makes "restore" possible ----------------------------------------------------

/**
 * Note a change. `list` is the saved list (newest first). A second change to a property that is still unrestored keeps the
 * FIRST previous value as `original`, so Restore goes back to what the instance had before the panel touched it.
 */
export function recordChange(list, { host, sysId, name, previous, next, at }) {
  const rest = Array.isArray(list) ? list : [];
  const open = rest.find((c) => c.host === host && c.sysId === sysId && !c.restoredAt);
  if (open) {
    const updated = { ...open, current: next, lastAt: at, count: (open.count || 1) + 1 };
    return [updated, ...rest.filter((c) => c !== open)].slice(0, CHANGES_CAP);
  }
  const entry = { id: `${host}:${sysId}:${at}`, host, sysId, name, original: previous, current: next, firstAt: at, lastAt: at, count: 1 };
  return [entry, ...rest].slice(0, CHANGES_CAP);
}

/** Changes on this instance that have not been restored, newest change first. */
export function activeChanges(list, host) {
  return (Array.isArray(list) ? list : []).filter((c) => c.host === host && !c.restoredAt).sort((a, b) => b.lastAt - a.lastAt);
}

/** Changes on this instance that were restored (kept for a while so the list tells the whole story). */
export function restoredChanges(list, host) {
  return (Array.isArray(list) ? list : []).filter((c) => c.host === host && c.restoredAt).sort((a, b) => b.restoredAt - a.restoredAt);
}

export function changeFor(list, host, sysId) {
  return activeChanges(list, host).find((c) => c.sysId === sysId) || null;
}

export function markRestored(list, id, at) {
  return (Array.isArray(list) ? list : []).map((c) => (c.id === id ? { ...c, restoredAt: at } : c));
}

export function clearRestored(list, host) {
  return (Array.isArray(list) ? list : []).filter((c) => !(c.host === host && c.restoredAt));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n) => String(n).padStart(2, '0');

/** "14:32" for today, "Oct 22, 14:32" for another day (the browser's local time). */
export function formatClock(ms, now = Date.now()) {
  const d = new Date(ms);
  const n = new Date(now);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? clock : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock}`;
}

/** The persistent nudge: "You changed this at 14:32 - restore?" */
export function nudgeText(change, now = Date.now(), { withName = false } = {}) {
  const subject = withName ? `You changed ${change.name}` : 'You changed this';
  const when = change.count > 1 ? `${change.count} times, first at ${formatClock(change.firstAt, now)}` : `at ${formatClock(change.firstAt, now)}`;
  return `${subject} ${when} - restore?`;
}

/** Has someone else changed the property since we did? */
export function restoreDrift(change, liveValue) {
  return String(liveValue ?? '') !== String(change.current ?? '');
}

// --- What the confirmations say -----------------------------------------------------------------------------------

const SECURITY_NAME_RE = /(^|\.)(security|authenticate|login|sso|saml|ldap|acl|csrf|encrypt|ssl|tls|cors|cert)/i;

const quoteValue = (value, max = 600) => {
  const text = String(value ?? '');
  if (text === '') return '(empty)';
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
};

/**
 * On a guarded instance (production, or one NowBuddy cannot place) a change or a restore needs the instance name typed
 * first, the same rule My work and Push use. `guard` is propertyGuard() ({ guarded, instance }). Fails closed: a guarded
 * instance without a known name can never be unlocked.
 * @returns {{ needed: boolean, instance: string, ok: boolean }}
 */
export function writeUnlock(guard, typed) {
  const needed = !guard || guard.guarded !== false;
  const instance = String(guard?.instance || '').trim();
  const ok = !needed || (Boolean(instance) && String(typed || '').trim().toLowerCase() === instance.toLowerCase());
  return { needed, instance, ok };
}

/** The sentence about the instance: production, an instance NowBuddy cannot place, or one that is not production. */
export function guardNote(guard = {}) {
  const host = guard.host || 'this instance';
  if (guard.env === 'prod') return `${host} is a PRODUCTION instance. The change reaches every user at once.`;
  if (guard.guarded) return `NowBuddy cannot tell whether ${host} is production, so it treats it as production. The change reaches every user at once.`;
  return `${host} does not look like production, but the change still reaches every user of it at once.`;
}

const onWhere = (guard = {}) => (guard.env === 'prod' ? ' on production' : guard.guarded ? ' on an instance that may be production' : '');

/** Plain warnings for this particular change (shown in the confirmation). */
export function riskNotes(prop, nextValue) {
  const notes = [];
  const curated = DEV_SWITCHES.find((s) => s.name === prop?.name);
  if (curated) notes.push(curated.careful);
  if (SECURITY_NAME_RE.test(prop?.name || '')) notes.push('This looks like a security setting.');
  if (String(nextValue) === '' && prop?.value !== '') notes.push('Clearing the value makes scripts fall back to the default they pass to gs.getProperty.');
  if (String(nextValue) === 'false' && /[._](active|enabled?)$/i.test(prop?.name || '') && !curated) notes.push('Turning off a property called "active" or "enabled" can stop a feature for everyone.');
  return notes;
}

/**
 * Where the change is recorded. A system property is configuration: while an update set is current, a change to it is
 * captured there and travels with the set to the next instance. `updateSet` is { name } or null when it could not be read.
 */
export function updateSetNote(updateSet) {
  const name = updateSet && updateSet.name ? String(updateSet.name) : '';
  if (!name) return 'NowBuddy could not read the current update set, so it cannot say where this change is captured.';
  if (/^default(\s|\[|$)/i.test(name.trim())) return `The current update set is "${clip(name, 60)}". The change is captured there, where it is easy to lose or ship by accident.`;
  return `The current update set is "${clip(name, 60)}". The change is captured in it and travels with it to the next instance.`;
}

const updateSetLine = (updateSet) => `Update set: ${updateSet && updateSet.name ? clip(updateSet.name, 60) : '(unknown)'}`;

/** The confirmation for a change (pass it to askConfirm). */
export function changeAsk({ prop, next, guard = {}, host = '', updateSet = null }) {
  const notes = riskNotes(prop, next);
  const details = [`Property:   ${prop.name}`, `Now:        ${quoteValue(prop.value)}`, `New:        ${quoteValue(next)}`, `Instance:   ${host || guard.host || ''}`, `${updateSetLine(updateSet)}`].join('\n');
  return {
    title: `Change ${clip(prop.name, 50)}${onWhere(guard)}?`,
    message: [guardNote(guard), ...notes, updateSetNote(updateSet), 'NowBuddy keeps the old value so you can restore it.'].join('\n\n'),
    details,
    confirmLabel: guard.env === 'prod' ? 'Change on production' : 'Change property',
    danger: Boolean(guard.guarded),
  };
}

/** The confirmation for a restore. `live` is what the property holds now. */
export function restoreAsk({ change, live, guard = {}, host = '', updateSet = null }) {
  const drifted = restoreDrift(change, live);
  const drift = drifted ? `It now holds ${quoteValue(live, 120)}, not the ${quoteValue(change.current, 120)} you set. Restoring replaces that too.` : '';
  const details = [`Property:   ${change.name}`, `Now:        ${quoteValue(live)}`, `Restore:    ${quoteValue(change.original)}`, `Instance:   ${host || guard.host || ''}`, `${updateSetLine(updateSet)}`].join('\n');
  return {
    title: `Restore ${clip(change.name, 50)}${onWhere(guard)}?`,
    message: [guardNote(guard), drift, updateSetNote(updateSet), 'This puts back the value it had before NowBuddy changed it.'].filter(Boolean).join('\n\n'),
    details,
    confirmLabel: guard.env === 'prod' ? 'Restore on production' : 'Restore value',
    danger: Boolean(guard.guarded),
  };
}

/** The reason line recorded with the write (the agent's audit log shows it). */
export function changeReason(prop, next, restoring = false) {
  return restoring ? `NowBuddy restored system property ${prop.name}` : `NowBuddy changed system property ${prop.name} for a test`;
}

// --- Opening on a property ----------------------------------------------------------------------------------------

/**
 * What was typed or pasted, as a search. Code pasted from a script (gs.getProperty('x_acme.timeout', '30')) becomes the
 * property name it holds.
 */
export function queryFromText(text) {
  const value = String(text || '').trim();
  const call = /\b(?:get|set)Property\w*\s*\(\s*(['"])([^'"\s]+)\1/.exec(value);
  return call ? call[2] : value;
}

/** Where the panel starts: a typed search, the sys_properties record on screen, or the home view. */
export function startTarget({ args = '', context = null } = {}) {
  const text = queryFromText(args);
  if (text) return { kind: 'search', query: text, openExact: looksLikePropertyName(text) };
  if (context?.table === PROPERTY_TABLE && SYS_ID_RE.test(context.sysId || '')) return { kind: 'record', sysId: context.sysId };
  return { kind: 'home' };
}

// --- Comparing with another instance ------------------------------------------------------------------------------

/**
 * From the cross-instance record compare (compareWithInstance) to a sentence about the value.
 * `remote.changes` lists the fields that differ as { name, before (here), after (there) }.
 */
export function compareOutcome(prop, remote) {
  if (!remote || !remote.found) return { state: 'missing', text: 'That instance has no property with this name (or it could not be matched).' };
  if (prop.hidden) return { state: 'hidden', text: 'This property is hidden, so it is not compared.' };
  const changes = remote.changes || [];
  const valueChange = changes.find((c) => c.name === 'value');
  const others = changes.filter((c) => c.name !== 'value' && !['sys_mod_count', 'sys_updated_on', 'sys_updated_by'].includes(c.name)).map((c) => c.name);
  const there = valueChange ? valueChange.after : prop.value;
  const typeThere = changes.find((c) => c.name === 'type')?.after ?? prop.type;
  if (valueChange && secretReason({ name: prop.name, type: typeThere, value: there })) return { state: 'hidden', text: 'The value there looks like a credential or the property is a password there, so it is not shown.' };
  if (!valueChange) return { state: 'same', text: 'The value is the same on both instances.', others };
  return { state: 'differs', text: 'The value differs.', here: prop.value, there, others };
}
