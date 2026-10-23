// Keeps track of a snippet's blanks while you type in them: where each blank is after every edit, copies of a blank
// (the same number twice in a template) that follow what you type in the first, and Tab / Shift+Tab to move between
// blanks. Everything is plain text and offsets; if an edit lands anywhere the session did not expect, the session
// ends rather than guess, so it can never rewrite text it does not own. Tested in tests/editorplus.test.js.
//
// A session is {stops: [{ranges: [{start, end}]}], active: number, synced: string}: `stops` in Tab order with the
// final stop last, `ranges[0]` of a stop is the one you type in and the others are its copies, `synced` is the text
// the copies currently hold.

/** Start a session from an expansion (see snippets.expandSnippet). Null when there is nothing to tab through. */
export function startSession(expansion) {
  if (!expansion || expansion.stops.length < 2) return null;
  const stops = expansion.stops.map((s) => ({ ranges: s.ranges.map((r) => ({ start: r.start, end: r.end })) }));
  return { stops, active: 0, synced: '' };
}

/** The range to select for the active blank. */
export function activeRange(session) {
  return session.stops[session.active].ranges[0];
}

/** Fill in `synced` from the text (after the snippet went in and the first blank holds its suggestion). */
export function withText(session, text) {
  const r = activeRange(session);
  return { ...session, synced: text.slice(r.start, r.end) };
}

/** True when the selection sits inside the active blank (or one of its copies), so Tab should move on. */
export function selectionInBlank(session, start, end) {
  return session.stops[session.active].ranges.some((r) => start >= r.start && end <= r.end);
}

/**
 * The single edit that turned `prev` into `next`, using where the caret ended up to place it. For typing, deleting
 * and replacing a selection the edit ends at the caret; when that does not fit, the smallest difference is used.
 * @returns {{from: number, to: number, insert: string} | null} `from`/`to` are offsets in `prev`
 */
export function locateEdit(prev, next, caret) {
  if (prev === next) return null;
  const c = Math.max(0, Math.min(caret, next.length));
  const tail = next.length - c;
  const prevEnd = prev.length - tail;
  if (prevEnd >= 0 && prev.endsWith(next.slice(c)) && prev.slice(prevEnd) === next.slice(c)) {
    const a = prev.slice(0, prevEnd);
    const b = next.slice(0, c);
    let p = 0;
    const max = Math.min(a.length, b.length);
    while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p += 1;
    return { from: p, to: prevEnd, insert: b.slice(p) };
  }
  let p = 0;
  const max = Math.min(prev.length, next.length);
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p += 1;
  let s = 0;
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s += 1;
  return { from: p, to: prev.length - s, insert: next.slice(p, next.length - s) };
}

/**
 * Move the blanks to where they are after `edit`. Null (end the session) when the edit is not inside the blank
 * being typed in.
 */
export function trackEdit(session, edit) {
  if (!edit) return session;
  const master = activeRange(session);
  if (edit.from < master.start || edit.to > master.end) return null;
  const delta = edit.insert.length - (edit.to - edit.from);
  const stops = session.stops.map((stop, si) => ({
    ranges: stop.ranges.map((r, ri) => {
      if (si === session.active && ri === 0) return { start: r.start, end: r.end + delta };
      return r.start >= master.end ? { start: r.start + delta, end: r.end + delta } : { start: r.start, end: r.end };
    }),
  }));
  return { ...session, stops };
}

/**
 * Make the copies of the active blank hold what the first one holds.
 * @returns {{text: string, session: object} | null} the new text and blanks; null when a copy no longer holds what it
 *   was given (the user edited it directly), in which case the session should end
 */
export function syncCopies(text, session) {
  const stop = session.stops[session.active];
  const master = stop.ranges[0];
  const value = text.slice(master.start, master.end);
  if (stop.ranges.length < 2 || value === session.synced) return { text, session: { ...session, synced: value } };
  const copies = stop.ranges.slice(1);
  for (const r of copies) {
    if (r.start < master.end || text.slice(r.start, r.end) !== session.synced) return null;
  }
  const sorted = [...copies].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of sorted) {
    out += text.slice(pos, r.start) + value;
    pos = r.end;
  }
  out += text.slice(pos);
  // Copies are replaced whole and nothing else moves inside them, so a position only needs the changes in front of it.
  // An empty copy sitting right at the end of a blank does not push that end along.
  const delta = value.length;
  const shiftStart = (at) => sorted.reduce((sum, c) => (c.end <= at ? sum + delta - (c.end - c.start) : sum), 0);
  const shiftEnd = (r) => sorted.reduce((sum, c) => (c.end <= r.end && !(c.start === c.end && c.start === r.end && r.end > r.start) ? sum + delta - (c.end - c.start) : sum), 0);
  const copySet = new Set(copies);
  const stops = session.stops.map((st, si) => ({
    ranges: st.ranges.map((r, ri) => {
      if (si === session.active && ri === 0) return { start: r.start, end: r.end };
      if (copySet.has(r)) {
        const start = r.start + sorted.reduce((sum, c) => (c !== r && c.end <= r.start ? sum + delta - (c.end - c.start) : sum), 0);
        return { start, end: start + delta };
      }
      return { start: r.start + shiftStart(r.start), end: r.end + shiftEnd(r) };
    }),
  }));
  return { text: out, session: { ...session, stops, synced: value } };
}

/**
 * Tab (dir 1) or Shift+Tab (dir -1). Returns the blank to select and the session to carry on with; the session is
 * null once the final stop is reached. Shift+Tab on the first blank stays where it is.
 * @returns {{select: {start: number, end: number}, session: object | null}}
 */
export function jump(session, text, dir) {
  const next = Math.max(0, Math.min(session.active + dir, session.stops.length - 1));
  const range = session.stops[next].ranges[0];
  if (next === session.stops.length - 1) return { select: { start: range.start, end: range.end }, session: null };
  return { select: { start: range.start, end: range.end }, session: { ...session, active: next, synced: text.slice(range.start, range.end) } };
}
