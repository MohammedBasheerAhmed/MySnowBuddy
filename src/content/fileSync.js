// Two-way sync between the script field on the open form and a file in a local folder you pick,
// so the script can be edited in VS Code (or any editor). The folder handle lives in memory only:
// nothing is remembered between pages, and nothing outside the chosen folder is touched.
// Needs the File System Access API (Chrome and Edge).

import { callPage } from './pageBridge.js';
import { bestScriptField } from './scriptEditor.js';

const POLL_MS = 1000;
let session = null;

const safeName = (text) => String(text || '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'untitled';

export const isFileSyncActive = () => !!session;

export function stopFileSync() {
  if (!session) return;
  clearInterval(session.timer);
  session = null;
}

/** @param {{toast: object}} deps */
export async function startFileSync({ toast }) {
  if (typeof window.showDirectoryPicker !== 'function') {
    toast.error('This browser cannot sync to a local folder. Use Chrome or Edge.');
    return;
  }
  stopFileSync();

  // Must be the first await so the click/Enter that started this still counts as a user gesture.
  let dir;
  try {
    dir = await window.showDirectoryPicker({ id: 'mysnowbuddy-sync', mode: 'readwrite' });
  } catch {
    return;
  }

  const fields = await callPage('getScriptFields').catch(() => []);
  if (!fields?.length) {
    toast.error('No script field was found on this page.');
    return;
  }
  const field = bestScriptField(fields);
  const meta = await callPage('getFormMeta').catch(() => null);
  const nameState = await callPage('getFieldState', ['name']).catch(() => null);
  const table = meta?.table || 'record';
  const sysId = meta?.sysId || '';
  const fileName = `${safeName(nameState?.value || sysId)}.${safeName(field.name)}.js`;

  const tableDir = await dir.getDirectoryHandle(safeName(table), { create: true });
  const handle = await tableDir.getFileHandle(fileName, { create: true });

  const write = async (text) => {
    const stream = await handle.createWritable();
    await stream.write(text);
    await stream.close();
  };

  const initial = String((await callPage('getFieldState', [field.name]))?.value ?? '');
  await write(initial);

  session = { timer: null, lastSynced: initial, busy: false };
  const mine = session;

  async function tick() {
    if (session !== mine || mine.busy) return;
    mine.busy = true;
    try {
      const current = await callPage('getFormMeta');
      if (!current || current.sysId !== sysId) {
        stopFileSync();
        toast.info('File sync stopped because you left the record.');
        return;
      }
      const fileText = await (await handle.getFile()).text();
      const formText = String((await callPage('getFieldState', [field.name]))?.value ?? '');

      if (fileText !== mine.lastSynced) {
        // The editor saved: the file wins.
        const formEdited = formText !== mine.lastSynced;
        await callPage('setFieldValue', [field.name, fileText]);
        mine.lastSynced = fileText;
        toast.success(
          formEdited ? `Updated ${field.name} from the file (replaced unsaved form edits)` : `Updated ${field.name} from the file`
        );
      } else if (formText !== mine.lastSynced) {
        await write(formText);
        mine.lastSynced = formText;
      }
    } catch (err) {
      stopFileSync();
      toast.error(`File sync stopped: ${err.message || err}`);
    } finally {
      mine.busy = false;
    }
  }

  mine.timer = setInterval(tick, POLL_MS);
  toast.success(`Syncing ${field.name} to ${safeName(table)}/${fileName}. Open it in VS Code.`, { timeout: 8000 });
}
