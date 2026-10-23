// "What went wrong recently?" (/failed), the instance half. Reads the places failures leave a trace that the system
// log does not show (sys_email, sys_flow_context, the scheduler, ecc_queue and the HTTP logs, the import set tables,
// sysevent) and hands back normalised rows. Read-only. Every source fails soft: a table that is missing or that
// your user cannot read becomes a note, and the other sources still load.
// The pure half (what is read, how rows are explained and grouped) is src/lib/failures.js; the panel is
// src/sidebar/FailuresPanel.jsx.

import { queryTable, SESSION_EXPIRED_MESSAGE } from './tableApi.js';
import { withFlowNames } from './flowNames.js';
import { SOURCES, DEFAULT_WINDOW, MAX_ROWS, runProbeRows, softFail, mergeSource, countsBySource } from '../lib/failures.js';

const CONCURRENCY = 4;

/** Run at most `max` async functions at a time. */
function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

async function readProbe(probe, windowKey, now, limit) {
  try {
    const found = await queryTable(probe.table, probe.query(windowKey), probe.fields, {
      limit: probe.limit || MAX_ROWS,
      displayValue: Boolean(probe.displayValue),
    });
    const rows = probe.table === 'sys_flow_context' ? await withFlowNames(found) : found;
    return runProbeRows(probe, rows, now);
  } catch (err) {
    return softFail(err, probe.table);
  }
}

/** One source: its primary probes in parallel, then the fallbacks only when no primary could be read. */
async function readSource(source, windowKey, now, limit) {
  const results = {};
  const primary = source.probes.filter((p) => !p.fallbackFor);
  await Promise.all(primary.map(async (p) => void (results[p.id] = await limit(() => readProbe(p, windowKey, now, limit)))));
  const anyAnswered = primary.some((p) => results[p.id]?.available);
  const fallbacks = source.probes.filter((p) => p.fallbackFor);
  await Promise.all(
    fallbacks.map(async (p) => {
      if (results[p.fallbackFor]?.available || anyAnswered) {
        results[p.id] = { skipped: true };
        return;
      }
      results[p.id] = await limit(() => readProbe(p, windowKey, now, limit));
    })
  );
  return mergeSource(source, results);
}

/**
 * @param {{ window?: string, sources?: string[] }} [args]
 * @returns {Promise<{ window: string, generatedAt: string, instance: string, sources: object[], items: object[], counts: object }>}
 */
export async function buildFailureReport({ window: windowKey = DEFAULT_WINDOW, sources } = {}) {
  const now = Date.now();
  const limit = limiter(CONCURRENCY);
  const wanted = Array.isArray(sources) && sources.length ? SOURCES.filter((s) => sources.includes(s.id)) : SOURCES;
  const merged = await Promise.all(wanted.map((source) => readSource(source, windowKey, now, limit)));
  // Every source refused because the session ended: say that, instead of a screen of grey notes.
  if (merged.length && merged.every((s) => s.sessionExpired)) throw new Error(SESSION_EXPIRED_MESSAGE);
  const items = merged.flatMap((s) => s.items);
  return {
    window: windowKey,
    generatedAt: new Date(now).toISOString().replace('T', ' ').slice(0, 16),
    instance: globalThis.location?.hostname || '',
    sources: merged,
    items,
    counts: countsBySource(items),
  };
}

export const failureServices = {
  failureReport: (args) => buildFailureReport(args),
};
