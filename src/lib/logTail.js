// Pure helpers for the live log tail and background-script output.

const MAX_SEEN = 3000;

/**
 * Pick out rows not shown before, oldest first. `seen` is a Set of sys_ids that
 * is updated in place and trimmed so it cannot grow without bound.
 */
export function takeNewRows(seen, rows) {
  const fresh = rows
    .filter((row) => row.sys_id && !seen.has(row.sys_id))
    .sort((a, b) => String(a.sys_created_on).localeCompare(String(b.sys_created_on)));
  fresh.forEach((row) => seen.add(row.sys_id));
  while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  return fresh;
}

/** Append lines, keeping only the newest `max`. */
export function appendCapped(existing, fresh, max = 300) {
  const next = existing.concat(fresh);
  return next.length > max ? next.slice(next.length - max) : next;
}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      // fromCodePoint throws a RangeError above U+10FFFF; keep such a reference as written.
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : whole;
  });
}

/** Plain text of the script output from the sys.scripts.do result page. */
export function extractScriptOutput(html) {
  const parts = [...String(html || '').matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)].map((m) => m[1]);
  if (!parts.length) return '';
  return decodeEntities(
    parts
      .join('\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((line) => line.replace(/^\*\*\* Script: /, '').replace(/\s+$/, ''))
    .join('\n')
    .trim();
}
