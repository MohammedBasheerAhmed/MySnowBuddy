// Live tail of the system log: polls for entries created in the last few
// seconds and reports the ones not seen yet.

import { queryTable } from './tableApi.js';
import { takeNewRows } from '../lib/logTail.js';

const LEVEL_VALUES = { error: '2', warn: '1', info: '0' };
const FIELDS = ['sys_id', 'sys_created_on', 'level', 'source', 'message'];
const MIN_INTERVAL_MS = 2000;

/**
 * @param {{level?: string, contains?: string, intervalMs?: number, onRows: (rows: object[]) => void, onError?: (err: Error) => void}} options
 * @returns {{stop: () => void}}
 */
export function startLogTail({ level = 'all', contains = '', intervalMs = 3000, onRows, onError }) {
  if (contains.includes('^')) throw new Error('Filter text cannot contain "^".');

  const seen = new Set();
  const interval = Math.max(MIN_INTERVAL_MS, intervalMs);
  let first = true;
  let stopped = false;
  let timer = null;

  async function poll() {
    if (stopped) return;
    try {
      // The first poll looks back a minute for context; later ones only need to overlap the last gap.
      const lookback = first ? 60 : Math.ceil((interval * 3) / 1000);
      const clauses = [`sys_created_on>=javascript:gs.secondsAgoStart(${lookback})`];
      if (LEVEL_VALUES[level] !== undefined) clauses.push(`level=${LEVEL_VALUES[level]}`);
      if (contains.trim()) clauses.push(`messageLIKE${contains.trim()}`);
      clauses.push('ORDERBYDESCsys_created_on');

      const rows = await queryTable('syslog', clauses.join('^'), FIELDS, { limit: 100 });
      first = false;
      const fresh = takeNewRows(seen, rows);
      if (fresh.length && !stopped) onRows(fresh);
    } catch (err) {
      if (onError && !stopped) onError(err);
    } finally {
      if (!stopped) timer = setTimeout(poll, interval);
    }
  }

  poll();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
