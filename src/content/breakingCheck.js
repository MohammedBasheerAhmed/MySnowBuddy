// Before a Script Include is saved: would this save break anything that calls it?
//
// It compares the script on the form with the saved record (src/lib/scriptApi.js: methods removed, renamed, given fewer
// or reordered parameters, or the class itself renamed), then searches the instance for scripts that still call them.
// If some do, an in-app dialog lists them and asks. Everything is read-only and fails open: if the check cannot finish
// (network, a table the user cannot read, too slow) the save goes ahead with a notice, never silently blocked.
//
// Two entry points share checkBeforeSave(): the form's Save buttons (a click is held, checked, then replayed once, the
// same way the production guard does it) and the script editor's "apply and save".

import { callPage } from './pageBridge.js';
import { queryTable } from './tableApi.js';
import { searchCode } from './codeSearch.js';
import { askConfirm } from './confirmDialog.js';
import { formDocuments } from './quickActions.js';
import { diffApi, selfCalls, callersOf } from '../lib/scriptApi.js';
import { breakingChangeAsk } from '../lib/confirmCopy.js';

const SAVE_BUTTON_RE = /^sysverb_update/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const CHECK_BUDGET_MS = 15000;
const MAX_METHODS = 8;
const MAX_LISTED = 8;
const SLOW_NOTICE_MS = 700;

const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('The check took too long.')), ms))]);

/** Scripts (other than `ownSysId`) that call any of `methods` on `className`, merged per record. */
async function findCallers({ className, methods, ownSysId }) {
  const found = new Map();
  let capped = [];
  let failed = 0;
  const searches = (methods.length ? methods : [className]).filter((term) => term.length >= 3);
  await Promise.all(
    searches.map(async (term) => {
      let result;
      try {
        result = await searchCode(term, { wholeWord: true, activeOnly: true, withSource: true, limitPerTable: 100 });
      } catch {
        failed += 1;
        return;
      }
      capped = capped.concat(result.capped || []);
      for (const hit of result.results) {
        if (hit.sysId === ownSysId) continue;
        const use = callersOf(hit.source, className, methods.length ? [term] : null);
        if (!use) continue;
        const key = `${hit.table}:${hit.sysId}`;
        const entry = found.get(key) || { label: hit.label, name: hit.name, table: hit.table, sysId: hit.sysId, methods: [], lines: [] };
        entry.methods = [...new Set([...entry.methods, ...use.methods])];
        entry.lines = [...new Set([...entry.lines, ...use.lines])].sort((a, b) => a - b);
        found.set(key, entry);
      }
    })
  );
  return { callers: [...found.values()], capped: [...new Set(capped)], skipped: (methods.length ? methods : [className]).length - searches.length, failed };
}

/**
 * Check the open Script Include against what is saved.
 * @returns {Promise<boolean>} true = go ahead and save; false = the person chose to go back.
 */
export async function checkBeforeSave({ toast } = {}) {
  let meta;
  try {
    meta = await callPage('getFormMeta');
  } catch {
    return true;
  }
  if (!meta || meta.table !== 'sys_script_include' || meta.isNewRecord || !SYS_ID_RE.test(meta.sysId || '')) return true;

  try {
    const formValues = (await callPage('getFormValues'))?.values || {};
    const [saved] = await queryTable('sys_script_include', `sys_id=${meta.sysId}`, ['name', 'script'], { limit: 1 });
    if (!saved || typeof formValues.script !== 'string') return true;

    const className = String(saved.name || '').trim();
    const newName = String(formValues.name || '').trim();
    const renamed = Boolean(className && newName && className !== newName);
    const { breaking } = diffApi(saved.script, formValues.script);
    if (!className || (!breaking.length && !renamed)) return true;

    const selfLines = selfCalls(formValues.script, breaking.filter((b) => b.kind === 'removed').map((b) => b.name));
    const methods = renamed ? [] : [...new Set(breaking.map((b) => b.name))].slice(0, MAX_METHODS);
    const slow = setTimeout(() => toast?.info?.('Checking what calls this Script Include…', { timeout: 4000 }), SLOW_NOTICE_MS);
    let search;
    try {
      search = await withTimeout(findCallers({ className, methods, ownSysId: meta.sysId }), CHECK_BUDGET_MS);
    } finally {
      clearTimeout(slow);
    }

    if (!search.callers.length && !selfLines.length) {
      const note = search.failed || search.capped.length ? ' (not every script could be read, so this is not a guarantee)' : '';
      toast?.info?.(`Nothing else calls ${renamed ? className : methods.join(', ')}${note}.`, { timeout: 6000 });
      return true;
    }
    return await askConfirm(
      breakingChangeAsk({
        className,
        renamedTo: renamed ? newName : '',
        issues: renamed ? [] : breaking,
        callers: search.callers.slice(0, MAX_LISTED),
        moreCallers: Math.max(0, search.callers.length - MAX_LISTED),
        selfLines,
      })
    );
  } catch (err) {
    // Fail open: a check that cannot run must never stop a save.
    toast?.info?.(`Could not check what calls this Script Include (${err.message || err}). Saving anyway.`, { timeout: 7000 });
    return true;
  }
}

/** Hold a Save click on a Script Include form until the check says it may go on. */
export function createBreakingCheck({ toast, getSettings, getContext }) {
  const attached = new WeakSet();
  let enabled = true;
  let replaying = null;
  let checking = null;

  const refresh = () => getSettings().then((s) => { enabled = s.guardsEnabled !== false; }).catch(() => {});
  refresh();
  setInterval(refresh, 15000);

  function onClick(event) {
    const button = event.target?.closest?.('button, input[type="button"], input[type="submit"]');
    if (!button || !SAVE_BUTTON_RE.test(button.id || '')) return;
    if (replaying === button) {
      replaying = null;
      return;
    }
    if (!enabled || getContext().table !== 'sys_script_include') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (checking) return;
    checking = button;
    checkBeforeSave({ toast })
      .then((ok) => {
        if (!ok || !button.isConnected) return;
        replaying = button;
        button.click();
        setTimeout(() => {
          if (replaying === button) replaying = null;
        }, 0);
      })
      .finally(() => {
        checking = null;
      });
  }

  function attach() {
    formDocuments().forEach((doc) => {
      if (attached.has(doc)) return;
      attached.add(doc);
      doc.addEventListener('click', onClick, true);
    });
  }
  attach();
  setInterval(attach, 3000);
}
