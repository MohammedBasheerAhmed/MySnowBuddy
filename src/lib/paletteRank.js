// Pure ranking helpers for the command palette: how often and how recently a
// command was used, and which characters of a title a query matched.

const DAY_MS = 86400000;
const MAX_COUNTED_USES = 20;

/**
 * Frequency weighted by recency. A command used ten times today outranks one
 * used ten times last month; the use count is capped so one habit cannot bury
 * everything else for good.
 * @param {{n?: number, t?: number}} [stat] - use count and last-used epoch ms
 */
/** True for input that reads like code (`current.setValue`, `g_form`, `getUserByID(`, `a == b`) rather than a sentence. */
export function looksLikeCode(query) {
  const text = String(query || '').trim();
  if (!text) return false;
  if (/[(){};=]/.test(text)) return true;
  if (/\b[A-Za-z_]\w*\.[A-Za-z_]\w*/.test(text)) return true;
  return !/\s/.test(text) && (/[a-z][A-Z]/.test(text) || /^[a-z]+_[a-z_]+$/i.test(text));
}

export function frecency(stat, now = Date.now()) {
  if (!stat || !stat.n) return 0;
  const ageDays = Math.max(0, now - (stat.t || 0)) / DAY_MS;
  return Math.min(stat.n, MAX_COUNTED_USES) / (1 + ageDays / 7);
}

/**
 * Command ids to show as "Recent", best first. Ids that predate use counts
 * (only in the recency list) rank below any counted id, newest first.
 */
export function rankRecent(stats = {}, recentOrder = [], limit = 6, now = Date.now()) {
  const ids = [...new Set([...Object.keys(stats), ...recentOrder])];
  const scored = ids.map((id) => {
    const counted = frecency(stats[id], now);
    const position = recentOrder.indexOf(id);
    return { id, score: counted || (position === -1 ? 0 : 0.05 / (1 + position)) };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.id);
}

/** Drops the least useful entries so the stored map stays small. */
export function pruneStats(stats, max, now = Date.now()) {
  const ids = Object.keys(stats);
  if (ids.length <= max) return stats;
  const keep = ids.sort((a, b) => frecency(stats[b], now) - frecency(stats[a], now)).slice(0, max);
  return Object.fromEntries(keep.map((id) => [id, stats[id]]));
}

/**
 * Indices of `text` that `query` matched, using the same rules as the palette's
 * fuzzy score (a substring first, else an in-order subsequence). Empty when
 * the title itself does not match; the hint or keywords may have.
 */
export function matchPositions(query, text) {
  const q = String(query || '').trim().toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q) return [];
  const at = t.indexOf(q);
  if (at !== -1) return Array.from({ length: q.length }, (_, i) => at + i);

  const positions = [];
  let from = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, from);
    if (found === -1) return [];
    positions.push(found);
    from = found + 1;
  }
  return positions;
}

/** Splits `text` into [{ text, hit }] runs from the indices matchPositions returned. */
export function highlightRuns(text, positions) {
  const hits = new Set(positions);
  const runs = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = hits.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}
