// List power tools: copy the rows of the classic list on screen (Excel, Markdown, JSON), their sys_ids, open the
// ticked rows in tabs, copy the filtered list as a link and count the values of one column. Read-only: nothing here
// writes to the instance, it reads the page, the clipboard and navigation. Text shaping is in src/lib/listCopy.js.
//
// The list is read from the page's classic documents (xrayDocuments(): the page, the gsft_main frame, the
// Next Experience shell's classic frame). Native Next Experience lists are not reachable, the same limit as X-ray.

import { xrayDocuments } from './xray.js';
import { copyText, navigate, listUrl, recordUrl, absoluteUrl } from './quickActions.js';
import { detectListInfo } from './context.js';
import { getUiState, saveUiState } from './storage.js';
import { askConfirm } from './confirmDialog.js';
import {
  FORMATS,
  buildModel,
  formatRows,
  describeCopy,
  describeIds,
  sysIdsOf,
  toIdList,
  toJsArray,
  distinctValues,
  planOpen,
} from '../lib/listCopy.js';

const FORMAT_KEY = 'listCopyFormat';
const OUR_NODES = '[data-msb-inline],[data-msb-xray],script,style';
const SYS_ID_AT_END = /([0-9a-f]{32})$/i;

const errorText = (err) => (err && err.message) || String(err);

/** The visible text of a node without the buttons and chips this extension placed in it. */
function textOf(node) {
  if (!node) return '';
  if (!node.querySelector?.(OUR_NODES)) return node.textContent || '';
  const clone = node.cloneNode(true);
  clone.querySelectorAll(OUR_NODES).forEach((n) => n.remove());
  return clone.textContent || '';
}

function headerText(th) {
  return textOf(th.querySelector('a.column_head, .column_head') || th);
}

function rowSysId(tr) {
  const attr = tr.getAttribute('sys_id') || '';
  if (/^[0-9a-f]{32}$/i.test(attr)) return attr;
  const fromId = SYS_ID_AT_END.exec(tr.id || '') || SYS_ID_AT_END.exec(tr.querySelector('input[id^="check_"]')?.id || '');
  return fromId ? fromId[1] : '';
}

function rowsOf(tbl) {
  const real = tbl.querySelectorAll('tbody tr.list_row');
  if (real.length) return [...real];
  const withIds = tbl.querySelectorAll('tbody tr[sys_id]');
  return withIds.length ? [...withIds] : [...tbl.querySelectorAll('tbody tr')];
}

/**
 * The classic list on screen as { table, model, column(name) } or null. With several lists (related lists under a
 * form) the one with the most rows is the page's list.
 */
export function readList() {
  let best = null;
  xrayDocuments().forEach((doc) => {
    try {
      doc.querySelectorAll('table[glide_table]').forEach((tbl) => {
        const headerCells = [...(tbl.querySelector('thead tr.list_header, thead tr')?.children || [])];
        if (!headerCells.some((th) => th.getAttribute('name'))) return;
        const trs = rowsOf(tbl);
        if (!best || trs.length > best.trs.length) best = { tbl, headerCells, trs };
      });
    } catch {
      // The frame navigated away mid-read.
    }
  });
  if (!best) return null;
  const table = best.tbl.getAttribute('glide_table') || '';
  const headers = best.headerCells.map((th) => ({ name: th.getAttribute('name') || '', text: headerText(th) }));
  const rows = best.trs.map((tr) => {
    const box = tr.querySelector('input.list_checkbox, input[type="checkbox"]');
    return { sysId: rowSysId(tr), selected: Boolean(box?.checked), cells: [...tr.children].map((td) => textOf(td)) };
  });
  return { table, model: buildModel({ headers, rows }) };
}

// --- The remembered copy format -----------------------------------------------------------------

export async function getCopyFormat() {
  try {
    const ui = await getUiState();
    return FORMATS.some((f) => f.id === ui[FORMAT_KEY]) ? ui[FORMAT_KEY] : 'tsv';
  } catch {
    return 'tsv';
  }
}

function rememberFormat(format) {
  saveUiState({ [FORMAT_KEY]: format }).catch(() => {});
}

const noList = (toast) => toast.info('No classic list is on screen. Open a list first (Next Experience lists cannot be read).');

// --- Actions ------------------------------------------------------------------------------------

/** Copy the ticked rows (else every visible row) as `format` ('tsv' | 'markdown' | 'json'). */
export async function copyRows({ toast, format }) {
  const list = readList();
  if (!list) return noList(toast);
  const chosen = FORMATS.some((f) => f.id === format) ? format : await getCopyFormat();
  const copy = formatRows(chosen, list.model);
  if (!copy) return toast.info('There are no rows to copy.');
  try {
    await copyText(copy.text);
    rememberFormat(chosen);
    toast.success(`${describeCopy(copy)} (${FORMATS.find((f) => f.id === chosen).short})`);
  } catch (err) {
    toast.error(errorText(err));
  }
  return undefined;
}

/** Copy the sys_ids of the ticked rows (else every visible row) as a comma list or as a JavaScript array. */
export async function copyIds({ toast, kind = 'list' }) {
  const list = readList();
  if (!list) return noList(toast);
  const { ids, scope } = sysIdsOf(list.model);
  if (!ids.length) return toast.info('No sys_ids were found on this list.');
  try {
    await copyText(kind === 'array' ? toJsArray(ids) : toIdList(ids));
    toast.success(`${describeIds(ids.length, scope)}${kind === 'array' ? ' as a JavaScript array' : ''}`);
  } catch (err) {
    toast.error(errorText(err));
  }
  return undefined;
}

/** Open the ticked rows in new tabs (at most 8; more than 3 asks first). */
export async function openSelected({ toast }) {
  const list = readList();
  if (!list) return noList(toast);
  const ticked = list.model.rows.filter((r) => r.selected && r.sysId).map((r) => r.sysId);
  if (!ticked.length) return toast.info('Tick the rows you want to open first.');
  const plan = planOpen(ticked);
  if (plan.needsConfirm) {
    const ok = await askConfirm({
      title: `Open ${plan.open.length} records in new tabs?`,
      message: `${plan.open.length} tabs of ${list.table} records will open.${plan.skipped ? ` ${plan.skipped} more ticked rows are skipped: at most 8 open at once.` : ''}`,
      confirmLabel: `Open ${plan.open.length} tabs`,
    });
    if (!ok) return undefined;
  }
  plan.open.forEach((id) => navigate(recordUrl(list.table, id), { newTab: true }));
  toast.success(`Opened ${plan.open.length} ${plan.open.length === 1 ? 'record' : 'records'}${plan.open.length > 1 ? '. If fewer tabs appeared, allow pop-ups for this site.' : ''}`);
  return undefined;
}

/** Copy a link to this list with its filter: opens the same list for whoever you send it to. */
export async function copyListLink({ toast }) {
  const info = await detectListInfo().catch(() => null);
  if (!info) return noList(toast);
  try {
    await copyText(absoluteUrl(listUrl(info.table, info.query)));
    toast.success(info.query ? 'Copied the link to this filtered list' : 'Copied the link to this list (it has no filter)');
  } catch (err) {
    toast.error(errorText(err));
  }
  return undefined;
}

/** { label, name, result } for the values in one column of the visible rows, or null without such a list. */
export function columnStats(columnName) {
  const list = readList();
  if (!list) return null;
  const index = list.model.columns.findIndex((c) => c.name === columnName);
  if (index < 0) return null;
  return { label: list.model.columns[index].label, name: columnName, result: distinctValues(list.model.rows, index) };
}

export { FORMATS };
