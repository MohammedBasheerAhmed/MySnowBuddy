// "Records like this one": keyword matching on a record's short description, no AI tokens. The search is a plain
// LIKE query on the same table; the ranking is how many of the keywords each hit shares with the record on screen.

const STOP = new Set(
  (
    'a an and are as at be been but by can cannot could did do does for from had has have how i if in into is it its just ' +
    'me my no not of on or our out over so some than that the their them then there these they this to too up us was we ' +
    'were what when where which who why will with would you your please need needs unable issue problem error help ' +
    'cant dont doesnt wont isnt arent every not working work works since after before again still new getting get got'
  ).split(' ')
);

/**
 * The words worth searching for: not filler, acronyms (VPN, SAP, LDAP) first, then the longest (rarer) words, at most
 * `max`. Words need 3+ letters.
 */
export function similarKeywords(text, max = 4) {
  const original = String(text || '');
  const acronyms = new Set((original.match(/\b[A-Z]{2,6}\b/g) || []).map((w) => w.toLowerCase()));
  const seen = new Set();
  const words = (original.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || []).filter((w) => {
    if (STOP.has(w) || seen.has(w)) return false;
    seen.add(w);
    return true;
  });
  const weight = (w) => (acronyms.has(w) ? 100 : 0) + w.length;
  return words.sort((a, b) => weight(b) - weight(a) || a.localeCompare(b)).slice(0, max);
}

/** Encoded query for the candidates: any keyword in the short description, never the record itself. */
export function similarQuery(keywords, { excludeSysId = '', field = 'short_description' } = {}) {
  const safe = (keywords || []).map((w) => String(w).replace(/[^a-z0-9_-]/gi, '')).filter(Boolean);
  if (!safe.length) return '';
  const any = safe.map((w, i) => `${i ? 'OR' : ''}${field}LIKE${w}`).join('^');
  const exclude = /^[0-9a-f]{32}$/i.test(excludeSysId) ? `^sys_id!=${excludeSysId}` : '';
  return `${any}${exclude}^ORDERBYDESCsys_updated_on`;
}

/** Hits sorted by shared keywords, then newest first. Each gets { shared, total }. */
export function rankSimilar(rows, keywords, field = 'short_description') {
  const flat = (v) => (v && typeof v === 'object' ? v.display_value ?? v.value ?? '' : v ?? '');
  return (rows || [])
    .map((row) => {
      const text = String(flat(row[field])).toLowerCase();
      return { row, shared: keywords.filter((w) => text.includes(w)).length, total: keywords.length };
    })
    .filter((hit) => hit.shared > 0)
    .sort((a, b) => b.shared - a.shared || String(flat(b.row.sys_updated_on)).localeCompare(String(flat(a.row.sys_updated_on))));
}
