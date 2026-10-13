// Safety guards for people who work across environments:
//  1. Warn when editing configuration while the current update set is a
//     "Default" one, where changes are easy to lose or ship by accident.
//  2. Ask for confirmation before saving or deleting configuration on PROD.
//
// Both are best-effort: the update set lookup and the classic save-button ids
// are unverified against a live instance (see docs/decisions.md).

import { isConfigTable, isDefaultUpdateSet } from '../lib/guards.js';
import { formDocuments } from './quickActions.js';

const SAVE_BUTTON_RE = /^sysverb_(update|insert|delete)/;
const UPDATE_SET_CACHE_MS = 20000;

export function createGuards({ toast, getSettings, getContext, getInstanceInfo, getCurrentUpdateSet, onChangeUpdateSet }) {
  let warning = null;
  let cached = { at: 0, value: null };
  const attached = new WeakSet();

  async function currentUpdateSet() {
    if (Date.now() - cached.at < UPDATE_SET_CACHE_MS) return cached.value;
    cached = { at: Date.now(), value: await getCurrentUpdateSet() };
    return cached.value;
  }

  function clearWarning() {
    if (warning) warning.dismiss();
    warning = null;
  }

  async function checkUpdateSet(ctx) {
    clearWarning();
    const settings = await getSettings();
    if (!settings.guardsEnabled || ctx.isList || !isConfigTable(ctx.table)) return;

    const updateSet = await currentUpdateSet();
    if (!updateSet || !isDefaultUpdateSet(updateSet.name)) return;

    warning = toast.show(`Current update set is "${updateSet.name}". Changes here are easy to lose or ship by accident.`, {
      tone: 'warn',
      timeout: 0,
      action: { label: 'Change update set', onClick: onChangeUpdateSet },
    });
  }

  // The click handler must decide synchronously, so the setting is cached here.
  let guardsOn = true;

  function confirmSync(event) {
    const button = event.target?.closest?.('button, input[type="button"], input[type="submit"]');
    if (!button || !SAVE_BUTTON_RE.test(button.id || '')) return;
    if (!guardsOn || getInstanceInfo().env !== 'prod') return;

    const ctx = getContext();
    if (!isConfigTable(ctx.table)) return;

    const verb = /delete/.test(button.id) ? 'delete' : 'save';
    const ok = window.confirm(`You are about to ${verb} ${ctx.table} configuration on PRODUCTION. Continue?`);
    if (!ok) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  const refreshSetting = () =>
    getSettings().then((s) => {
      guardsOn = Boolean(s.guardsEnabled);
    });
  refreshSetting();
  setInterval(refreshSetting, 15000);

  // Classic forms render in a frame that is replaced on navigation, so re-attach periodically.
  function attachListeners() {
    formDocuments().forEach((doc) => {
      if (attached.has(doc)) return;
      attached.add(doc);
      doc.addEventListener('click', confirmSync, true);
    });
  }
  attachListeners();
  setInterval(attachListeners, 3000);

  return {
    onPageChange(ctx) {
      cached = { at: 0, value: null };
      checkUpdateSet(ctx).catch(() => {});
    },
  };
}
