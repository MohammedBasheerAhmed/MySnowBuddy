// The last few code searches, newest first, so a search done an hour ago is one click away.
// Pure: the panel keeps the list in the extension's UI state.

export const MAX_SEARCHES = 8;

/**
 * @param {Array<{ term: string, wholeWord?: boolean, activeOnly?: boolean, tables?: string[] }>} list
 * @param {{ term: string, wholeWord?: boolean, activeOnly?: boolean, tables?: string[] }} search
 * @returns the list with this search first; the same term with the same options moves up instead of repeating
 */
export function rememberSearch(list, search) {
  const term = String(search?.term || '').trim();
  if (term.length < 3) return Array.isArray(list) ? list : [];
  const entry = { term, wholeWord: Boolean(search.wholeWord), activeOnly: search.activeOnly !== false, tables: [...(search.tables || [])].sort() };
  const same = (a) => a.term === entry.term && a.wholeWord === entry.wholeWord && a.activeOnly === entry.activeOnly && a.tables.join() === entry.tables.join();
  return [entry, ...(Array.isArray(list) ? list : []).filter((a) => !same(a))].slice(0, MAX_SEARCHES);
}

/** A stored value that may be damaged or from an older build: only well-formed entries are kept. */
export function cleanSearches(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e.term === 'string' && e.term.trim().length >= 3 && e.term.length <= 200)
    .map((e) => ({ term: e.term, wholeWord: Boolean(e.wholeWord), activeOnly: e.activeOnly !== false, tables: Array.isArray(e.tables) ? e.tables.filter((t) => typeof t === 'string') : [] }))
    .slice(0, MAX_SEARCHES);
}

/** What a chip says about a remembered search besides its term ("whole word, 2 tables"). */
export function describeSearch(entry) {
  const bits = [];
  if (entry.wholeWord) bits.push('whole word');
  if (!entry.activeOnly) bits.push('inactive too');
  if (entry.tables?.length) bits.push(`${entry.tables.length} table${entry.tables.length === 1 ? '' : 's'}`);
  return bits.join(', ');
}
