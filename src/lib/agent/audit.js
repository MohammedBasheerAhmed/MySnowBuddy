// Audit log and undo stack for everything the agent changes. Storage is
// injected ({ get(key), set(key, value) }) so this is testable; the extension
// passes a chrome.storage.local adapter.
export const AUDIT_KEY = 'mysnowbuddy_agent_audit';
const MAX_ENTRIES = 100;
const MAX_TEXT = 6000;

const clipValue = (value) => {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}...[clipped]` : value;
  if (Array.isArray(value)) return value.slice(0, 50).map(clipValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipValue(v)]));
  return value;
};

export function createAudit(storage) {
  async function load() {
    const list = await storage.get(AUDIT_KEY);
    return Array.isArray(list) ? list : [];
  }

  return {
    load,

    /**
     * @param {{instance?: string, tool: string, args?: object, ok: boolean, summary?: string, source?: string,
     *          undo?: {kind: 'record'|'field', table?: string, sysId?: string, previous?: object, created?: boolean, field?: string, value?: string}}} entry
     */
    async record(entry) {
      const list = await load();
      const stored = {
        id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        undone: false,
        ...entry,
        args: clipValue(entry.args || {}),
        // Never clipped: undo restores exactly what is stored, so a truncated copy would corrupt the record.
        undo: entry.undo || null,
      };
      await storage.set(AUDIT_KEY, [stored, ...list].slice(0, MAX_ENTRIES));
      return stored;
    },

    /** Most recent change that can still be undone on this instance. */
    async lastUndoable(instance) {
      const list = await load();
      return list.find((e) => e.ok && e.undo && !e.undone && (!instance || e.instance === instance)) || null;
    },

    async markUndone(id) {
      const list = await load();
      await storage.set(
        AUDIT_KEY,
        list.map((e) => (e.id === id ? { ...e, undone: true } : e))
      );
    },

    async clear() {
      await storage.set(AUDIT_KEY, []);
    },
  };
}

export const chromeStorageAdapter = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};
