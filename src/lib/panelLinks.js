// Where one tool hands the developer on to the next one. Pure, so each hook is unit-tested (tests/glue.test.js):
//   - opening a panel on a record other than the one on screen (a failed email's record, a flow's source record)
//   - which "explain it" button a failure row gets
//   - the one-line value shown when the pointer rests on a system property name in the script editor
//   - the entries of the "Why?" menu on a ticket form

import { nameLooksSecret } from './properties.js';
import { redactSecrets } from '../providers/redact.js';

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

// --- Opening a panel on a record --------------------------------------------------------------------------------

/** { table, sysId } when both look like a table name and a sys_id, else null. Nothing else ever becomes a record. */
export function recordRef(table, sysId) {
  const name = String(table ?? '').trim();
  const id = String(sysId ?? '').trim();
  return TABLE_RE.test(name) && SYS_ID_RE.test(id) ? { table: name, sysId: id.toLowerCase() } : null;
}

/** The page context a panel receives, for a record that is not the one on screen. */
export function recordContext(ref) {
  const record = ref && recordRef(ref.table, ref.sysId);
  return record ? { table: record.table, sysId: record.sysId, isList: false, isPortal: false, selection: '', scriptBody: null, scriptFieldLabel: null } : null;
}

/**
 * Split the params of an "open this panel" request into the record to open it on (when the caller named one) and the
 * rest. A `context` that is not a valid table and sys_id is dropped, and the panel opens on the page's record.
 * @returns {{ context: object | null, params: object }}
 */
export function splitOpenParams(params) {
  const { context, ...rest } = params && typeof params === 'object' ? params : {};
  return { context: recordContext(context), params: rest };
}

// --- Failures -> the tool that explains them ----------------------------------------------------------------------

/**
 * The buttons a failure group gets. `group` is a groupFailures() group: `source`, `target` (the failing row itself) and
 * `meta` (what the row said about the record it was about). A button exists only when the row names a record.
 * @returns {Array<{ id: string, panel: string, label: string, title: string, params: { context: { table: string, sysId: string } } }>}
 */
export function failureLinks(group) {
  if (!group) return [];
  const meta = group.meta || {};
  // A group of repeats opens the newest one.
  const newest = group.count > 1 ? ` (the most recent of ${group.count})` : '';
  const out = [];
  if (group.source === 'email') {
    // The failed email is itself a record, and the email page of the tracer starts from it.
    const email = recordRef(group.target?.table, group.target?.sysId);
    if (email && email.table === 'sys_email') {
      out.push({
        id: 'notify',
        panel: 'notify',
        label: 'Why was it not sent?',
        title: `Open this email in the email tracer: what triggered it, who it was for and where it stopped${newest}`,
        params: { context: email },
      });
    }
  } else if (group.source === 'flow') {
    const record = recordRef(meta.sourceTable, meta.sourceRecord);
    if (record) {
      out.push({
        id: 'process',
        panel: 'process',
        label: 'What is running on this record?',
        title: `Flows, workflows, approvals, SLAs and tasks on the ${record.table} this flow ran for${newest}`,
        params: { context: record },
      });
    }
  } else if (group.source === 'event') {
    const record = recordRef(meta.table, meta.record);
    if (record) {
      out.push({
        id: 'notify',
        panel: 'notify',
        label: 'Check the email for this record',
        title: `Trace the notifications and emails of the ${record.table} this event was queued for${newest}`,
        params: { context: record },
      });
    }
  }
  return out;
}

// --- System property values in the script editor ------------------------------------------------------------------

const PROPERTY_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** True when a property named like this may have its value looked up: a plain name that does not say "secret". */
export function canLookUpProperty(name) {
  const text = String(name ?? '');
  return text.length >= 3 && text.length <= 200 && PROPERTY_NAME_RE.test(text) && !nameLooksSecret(text);
}

const oneLine = (text, max = 80) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The one line to show under a property name, from what the properties service returned ({ property, others }).
 * Empty when there is nothing safe to say: a property that is hidden (a password, a secret-looking name or value) or
 * whose value was not readable shows no line at all.
 */
export function propertyHoverLine(result) {
  if (!result || typeof result !== 'object') return '';
  const prop = result.property;
  if (!prop) return 'No property with this name was found here, or your user cannot read it.';
  if (prop.hidden || prop.unreadable || nameLooksSecret(prop.name)) return '';
  const shown = prop.empty || prop.value === '' ? '(empty)' : oneLine(redactSecrets(String(prop.value ?? '')));
  const more = result.others > 0 ? ` (${result.others} more ${result.others === 1 ? 'property has' : 'properties have'} this name)` : '';
  return `Value on this instance: ${shown}${more}`;
}

/**
 * A per-session cache of those lines. `fetch(name)` returns the properties service answer; a name that may not be looked
 * up is never passed to it; a failed read is remembered as "show nothing" so one hover never repeats a failing request.
 */
export function createValueLookup(fetch) {
  const lines = new Map();
  const pending = new Map();
  return {
    /** The line for a name that has been looked up ('' for nothing to show), or undefined when it has not been. */
    peek: (name) => lines.get(name),
    load(name) {
      if (!canLookUpProperty(name) || typeof fetch !== 'function') return Promise.resolve('');
      if (lines.has(name)) return Promise.resolve(lines.get(name));
      if (!pending.has(name)) {
        pending.set(
          name,
          Promise.resolve()
            .then(() => fetch(name))
            .then(propertyHoverLine)
            .catch(() => '')
            .then((line) => {
              lines.set(name, line);
              pending.delete(name);
              return line;
            })
        );
      }
      return pending.get(name);
    },
  };
}

// --- The "Why?" menu on a ticket form -------------------------------------------------------------------------------

/**
 * Entries of the "Why?" menu: each opens a panel on the record on screen. `id` is the palette id of the panel, so the
 * role filter (src/lib/roleTier.js) hides what the user's roles cannot use.
 */
export function whyMenuModel() {
  return [
    { id: 'panel.process', panel: 'process', label: 'What is running on it' },
    { id: 'panel.notify', panel: 'notify', label: 'Why was an email not sent' },
    { id: 'panel.access', panel: 'access', label: "Why can't a user see it" },
    { id: 'panel.clienttrace', panel: 'clienttrace', label: 'What the form scripts did' },
  ];
}
