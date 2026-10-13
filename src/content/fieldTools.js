// Alt+click a field label to copy its database name, Alt+Shift+click to copy its current value.
// Classic forms live in the gsft_main iframe, which is replaced on every navigation, so the
// listeners are re-attached on a timer.

import { formDocuments, fieldNameFromLabel, copyText } from './quickActions.js';
import { callPage } from './pageBridge.js';

const ATTACH_MS = 2000;

export function installFieldTools({ toast }) {
  const attached = new WeakSet();

  async function onClick(event) {
    if (!event.altKey) return;
    const label = event.target.closest?.('label');
    const field = label && fieldNameFromLabel(label);
    if (!field) return;

    event.preventDefault();
    event.stopPropagation();

    try {
      if (event.shiftKey) {
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

  function attach() {
    formDocuments().forEach((doc) => {
      if (attached.has(doc)) return;
      attached.add(doc);
      doc.addEventListener('click', onClick, true);
    });
  }

  attach();
  setInterval(attach, ATTACH_MS);
}
