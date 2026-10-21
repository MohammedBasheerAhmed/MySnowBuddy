// Alt+click a field label to copy its database name, Alt+Shift+click to copy its current value, double-click for the name,
// Ctrl+Alt+click to see where the field is used (the "Where is this field used?" panel).
// Classic forms live in the gsft_main iframe, which is replaced on every navigation, so the
// listeners are re-attached on a timer.

import { formDocuments, fieldNameFromLabel, copyText } from './quickActions.js';
import { callPage } from './pageBridge.js';

const ATTACH_MS = 2000;

export function installFieldTools({ toast, isEnabled = () => true, openUsage = null }) {
  const attached = new WeakSet();

  async function onClick(event) {
    if (!event.altKey || event.isTrusted !== true) return;
    const label = event.target.closest?.('label');
    const field = label && fieldNameFromLabel(label);
    if (!field) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      if (event.ctrlKey && openUsage) {
        const meta = await callPage('getFormMeta');
        if (!meta?.table) throw new Error('Open a record form first.');
        openUsage(meta.table, field);
      } else if (event.shiftKey) {
        const state = await callPage('getFieldState', [field]);
        const value = state?.value ?? '';
        await copyText(String(value));
        toast.success(`Copied value of ${field}`);
      } else {
        await copyText(field);
        toast.success(`Copied field name ${field}`);
      }
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  // Double-click a label to copy the database name (the quickest way to get a field name while scripting).
  async function onDoubleClick(event) {
    if (event.isTrusted !== true || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !isEnabled()) return;
    if (event.target.closest?.('[data-msb-inline],[data-msb-xray],a,input,select,textarea,button')) return;
    const label = event.target.closest?.('label');
    // A checkbox's label toggles it; two quick clicks must not become a copy.
    if (!label || label.querySelector('input[type="checkbox"]') || label.control?.type === 'checkbox') return;
    const field = fieldNameFromLabel(label);
    if (!field) return;
    event.preventDefault();
    try {
      label.ownerDocument.getSelection?.()?.removeAllRanges(); // the double-click selected a word
      await copyText(field);
      toast.success(`Copied field name ${field}`);
    } catch (err) {
      toast.error(err.message || String(err));
    }
  }

  function attach() {
    formDocuments().forEach((doc) => {
      if (attached.has(doc)) return;
      attached.add(doc);
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('dblclick', onDoubleClick, true);
    });
  }

  attach();
  setInterval(attach, ATTACH_MS);
}
