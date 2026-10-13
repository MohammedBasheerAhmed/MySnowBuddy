// Read the XML stored in sys_update_version.payload. The shape is
// <record_update table="x"><table_name action="..."><field>value</field>...</table_name></record_update>

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return name in ENTITIES ? ENTITIES[name] : whole;
  });
}

function elementText(raw) {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return cdata ? cdata[1] : decode(raw);
}

const CHILD_RE = /<([A-Za-z_][\w.-]*)((?:\s[^>]*?)?)(?:\/>|>([\s\S]*?)<\/\1>)/g;

/** @returns {{table: string, action: string, fields: Record<string,string>}} */
export function parseVersionPayload(xml) {
  const result = { table: '', action: '', fields: {} };
  const text = String(xml || '');

  const root = text.match(/<record_update\b([^>]*)>([\s\S]*?)<\/record_update>/);
  if (!root) return result;

  const table = root[1].match(/\btable="([^"]*)"/);
  if (table) result.table = decode(table[1]);

  const record = root[2].match(/<([A-Za-z_][\w.-]*)((?:\s[^>]*?)?)>([\s\S]*)<\/\1>/);
  if (!record) return result;

  const action = record[2].match(/\baction="([^"]*)"/);
  if (action) result.action = decode(action[1]);

  CHILD_RE.lastIndex = 0;
  let match;
  while ((match = CHILD_RE.exec(record[3]))) {
    result.fields[match[1]] = match[3] === undefined ? '' : elementText(match[3]);
  }
  return result;
}

/** Fields whose values differ between two parsed payloads. */
export function changedFields(oldFields, newFields) {
  const names = [...new Set([...Object.keys(oldFields), ...Object.keys(newFields)])].sort();
  return names
    .filter((name) => (oldFields[name] ?? '') !== (newFields[name] ?? ''))
    .map((name) => ({ name, before: oldFields[name] ?? '', after: newFields[name] ?? '' }));
}
