// Client script simulator: runs a Client Script handler against a simulated
// form and reports exactly what it did (every g_form call, messages, GlideAjax
// calls, final field state).
//
// It is pure and takes the evaluator as a parameter. The extension passes one
// that lives in a sandboxed page (MV3 forbids eval in extension contexts); Node
// tests use the default `new Function`. Nothing here touches a real form.
import { CLIENT_APIS } from './apiCatalog/clientApis.js';

const G_FORM_CATALOG = CLIENT_APIS.find((a) => a.name === 'g_form')?.methods.map((m) => m.name) || [];
const MAX_SETTLE_ROUNDS = 60;

const fmtArg = (v) => {
  if (typeof v === 'function') return 'function';
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserialisable object]'; // circular: recording a call must never throw inside the user's script
  }
};
const fmtCall = (api, args) => `${api}(${args.map(fmtArg).join(', ')})`;

function defaultEvaluate(source, names, values) {
  // eslint-disable-next-line no-new-func -- only ever reached in Node tests and the sandboxed page.
  return new Function(...names, source)(...values);
}

function blockedDom(label) {
  const fail = () => {
    throw new Error(`${label} is not available: DOM access is unsupported in Service Portal, workspaces and mobile, and breaks on upgrade. Use the g_form API.`);
  };
  return new Proxy(function blocked() {}, { get: fail, apply: fail, construct: fail });
}

export function createMockEnvironment(scenario = {}) {
  const calls = [];
  const messages = [];
  const ajaxCalls = [];
  const warnings = [];
  const fieldChanges = [];
  const queue = [];

  const warn = (code, message) => {
    if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ code, message });
  };
  const record = (api, args) => calls.push(fmtCall(api, args));
  const later = (fn) => queue.push(fn);

  // ---- fields ----------------------------------------------------------------------
  const fields = new Map();
  Object.entries(scenario.fields || {}).forEach(([name, def]) => {
    const spec = def && typeof def === 'object' && !Array.isArray(def) ? def : { value: def };
    fields.set(name, {
      value: spec.value == null ? '' : String(spec.value),
      displayValue: spec.displayValue,
      label: spec.label || name,
      type: spec.type || 'string',
      mandatory: Boolean(spec.mandatory),
      readOnly: Boolean(spec.readOnly),
      visible: spec.visible !== false,
      options: spec.options ? [...spec.options] : [],
      initial: spec.value == null ? '' : String(spec.value),
    });
  });
  const hasFieldDefs = fields.size > 0;
  const field = (name, via) => {
    if (!fields.has(name)) {
      const blank = { value: '', label: name, type: 'string', mandatory: false, readOnly: false, visible: true, options: [], initial: '' };
      if (hasFieldDefs) {
        // A scenario that lists its fields is the form: a field it does not list does not exist, so touching it
        // must not create it (hasField() would otherwise start returning true). Changes to it are discarded.
        warn('unknown-field', `g_form.${via}("${name}"): the scenario has no field called "${name}". On a real form this would log an error or do nothing.`);
        return blank;
      }
      fields.set(name, blank); // no field list given: stay lenient so a script's own setValue/getValue round-trips
    }
    return fields.get(name);
  };

  const referenceFor = (name) => {
    const row = scenario.references?.[name] || {};
    return {
      getValue: (col) => (row[col] == null ? '' : String(row[col])),
      getDisplayValue: (col) => (row[col] == null ? '' : String(row[col])),
      hasOwnProperty: (k) => Object.prototype.hasOwnProperty.call(row, k),
      ...row,
    };
  };

  const impl = {
    getValue: (name) => field(name, 'getValue').value,
    setValue: (name, value, displayValue) => {
      const f = field(name, 'setValue');
      const next = value == null ? '' : String(value);
      if (f.readOnly) warn('set-readonly', `g_form.setValue("${name}") on a read-only field still changes the value on screen, but the server may reject it.`);
      if (f.value !== next) {
        fieldChanges.push({ field: name, from: f.value, to: next });
        warn('onchange-cascade', `setValue changes "${name}", which fires that field's own onChange scripts on a real form. The simulator does not run them.`);
      }
      f.value = next;
      if (displayValue !== undefined) f.displayValue = displayValue;
    },
    clearValue: (name) => {
      const f = field(name, 'clearValue');
      if (f.value !== '') fieldChanges.push({ field: name, from: f.value, to: '' });
      f.value = '';
    },
    getBooleanValue: (name) => field(name, 'getBooleanValue').value === 'true',
    getIntValue: (name) => parseInt(field(name, 'getIntValue').value, 10) || 0,
    getDecimalValue: (name) => parseFloat(field(name, 'getDecimalValue').value) || 0,
    getDisplayBox: (name) => ({ value: field(name, 'getDisplayBox').displayValue ?? field(name, 'getDisplayBox').value }),
    setMandatory: (name, flag) => void (field(name, 'setMandatory').mandatory = Boolean(flag)),
    isMandatory: (name) => field(name, 'isMandatory').mandatory,
    setReadOnly: (name, flag) => void (field(name, 'setReadOnly').readOnly = Boolean(flag)),
    setDisabled: (name, flag) => void (field(name, 'setDisabled').readOnly = Boolean(flag)),
    setDisplay: (name, flag) => void (field(name, 'setDisplay').visible = Boolean(flag)),
    setVisible: (name, flag) => void (field(name, 'setVisible').visible = Boolean(flag)),
    hasField: (name) => fields.has(name),
    getLabelOf: (name) => field(name, 'getLabelOf').label,
    setLabelOf: (name, label) => void (field(name, 'setLabelOf').label = label),
    getFieldNames: () => [...fields.keys()],
    getTableName: () => scenario.table || '',
    getUniqueValue: () => scenario.sysId || '',
    isNewRecord: () => Boolean(scenario.isNewRecord),
    getActionName: () => scenario.actionName || 'sysverb_update',
    addInfoMessage: (text) => void messages.push({ type: 'info', text: String(text) }),
    addErrorMessage: (text) => void messages.push({ type: 'error', text: String(text) }),
    clearMessages: () => void (messages.length = 0),
    showFieldMsg: (name, text, type) => void messages.push({ type: `field:${type || 'info'}`, field: name, text: String(text) }),
    hideFieldMsg: () => undefined,
    addOption: (name, value, label) => {
      const f = field(name, 'addOption');
      if (!f.options.some((o) => o.value === value)) f.options.push({ value, label });
    },
    removeOption: (name, value) => {
      const f = field(name, 'removeOption');
      f.options = f.options.filter((o) => o.value !== value);
    },
    clearOptions: (name) => void (field(name, 'clearOptions').options = []),
    getReference: (name, callback) => {
      const ref = referenceFor(name);
      if (typeof callback === 'function') {
        later(() => callback(ref));
        return undefined;
      }
      warn('sync-getreference', `g_form.getReference("${name}") without a callback is synchronous: it blocks the form and is unsupported in Service Portal. Pass a callback.`);
      return ref;
    },
    getControl: () => {
      warn('getcontrol', 'g_form.getControl() returns a DOM element and is unsupported in portal, workspaces and mobile.');
      return blockedDom('g_form.getControl() element');
    },
  };
  impl.setReadonly = impl.setReadOnly;

  const gForm = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        const base = impl[prop];
        if (base || G_FORM_CATALOG.includes(prop)) {
          return (...args) => {
            record(`g_form.${prop}`, args);
            return base ? base(...args) : undefined;
          };
        }
        return (...args) => {
          record(`g_form.${prop}`, args);
          warn('unmodelled-api', `g_form.${prop}() is not in the verified catalog and the simulator cannot model it. If it does not exist on a real form, this will throw.`);
          return undefined;
        };
      },
    }
  );

  // ---- user ------------------------------------------------------------------------
  const user = { userName: 'sim.user', firstName: 'Sim', lastName: 'User', userID: 'sim-user-sys-id', roles: [], ...(scenario.user || {}) };
  const roles = new Set(user.roles || []);
  const gUser = {
    userName: user.userName,
    firstName: user.firstName,
    lastName: user.lastName,
    userID: user.userID,
    roles: [...roles].join(','),
    hasRole: (r) => roles.has('admin') || roles.has(r),
    hasRoleExactly: (r) => roles.has(r),
    hasRoles: () => roles.size > 0,
    hasRoleFromList: (list) => String(list).split(',').some((r) => roles.has('admin') || roles.has(r.trim())),
    getFullName: () => `${user.firstName} ${user.lastName}`,
    getClientData: (key) => scenario.clientData?.[key],
  };

  // ---- GlideAjax ---------------------------------------------------------------------
  class GlideAjax {
    constructor(scriptInclude) {
      this.scriptInclude = scriptInclude;
      this.params = {};
    }

    addParam(key, value) {
      this.params[key] = value;
    }

    resolveAnswer() {
      const method = this.params.sysparm_name;
      ajaxCalls.push({ scriptInclude: this.scriptInclude, method: method || null, params: { ...this.params } });
      if (!method) warn('ajax-no-method', `GlideAjax("${this.scriptInclude}") was sent without sysparm_name, so no Script Include method runs.`);
      const stubs = scenario.ajax || {};
      const key = `${this.scriptInclude}.${method}`;
      const answer = key in stubs ? stubs[key] : this.scriptInclude in stubs ? stubs[this.scriptInclude] : undefined;
      if (answer === undefined) warn('ajax-no-stub', `No answer stubbed for ${key}; the callback received an empty answer. Add scenario.ajax["${key}"].`);
      return answer === undefined ? '' : typeof answer === 'string' ? answer : JSON.stringify(answer);
    }

    response(answer) {
      // A real response carries the XML document, and responseText is that XML as a string. Scripts that
      // JSON.parse(response.responseText) work only on the bare answer, so they must fail here as they do for real.
      const escaped = String(answer).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return {
        responseText: `<?xml version="1.0" encoding="UTF-8"?><xml answer="${escaped}" sysparm_max="15"/>`,
        responseXML: { documentElement: { getAttribute: (n) => (n === 'answer' ? answer : null) } },
      };
    }

    /** The answer of the last getXMLWait(), as in `ga.getXMLWait(); var answer = ga.getAnswer();`. */
    getAnswer() {
      if (this.lastAnswer === undefined) warn('ajax-getanswer-early', 'GlideAjax.getAnswer() was called before getXMLWait(), so there is no answer yet.');
      return this.lastAnswer === undefined ? '' : this.lastAnswer;
    }

    getXML(callback) {
      record('GlideAjax.getXML', [this.params.sysparm_name]);
      const answer = this.resolveAnswer();
      if (typeof callback === 'function') later(() => callback(this.response(answer)));
      else warn('ajax-no-callback', 'GlideAjax.getXML() was called without a callback; the answer is delivered only to the callback.');
    }

    getXMLAnswer(callback) {
      record('GlideAjax.getXMLAnswer', [this.params.sysparm_name]);
      const answer = this.resolveAnswer();
      if (typeof callback === 'function') later(() => callback(answer));
      else warn('ajax-no-callback', 'GlideAjax.getXMLAnswer() was called without a callback.');
    }

    getXMLWait() {
      record('GlideAjax.getXMLWait', [this.params.sysparm_name]);
      warn('ajax-sync', 'GlideAjax.getXMLWait() is synchronous: it freezes the form and is unsupported in Service Portal and mobile. Use getXML(callback).');
      this.lastAnswer = this.resolveAnswer();
      return this.response(this.lastAnswer);
    }
  }

  // ---- client GlideRecord (discouraged) ------------------------------------------------
  class GlideRecord {
    constructor(table) {
      this.__table = table;
      this.__filters = [];
      this.__rows = [];
      this.__i = -1;
      warn('client-gliderecord', 'Client-side GlideRecord is synchronous-ish, slow and unsupported in Service Portal and mobile. Use GlideAjax with a client-callable Script Include.');
    }

    addQuery(a, b, c) {
      this.__filters.push(c === undefined ? [a, '=', b] : [a, String(b).toUpperCase(), c]);
    }

    addActiveQuery() {
      this.__filters.push(['active', '=', 'true']);
    }

    addNullQuery(col) {
      this.__filters.push([col, '=', '']);
    }

    addNotNullQuery(col) {
      this.__filters.push([col, '!=', '']);
    }

    /** Plain `a=b^c!=d` conditions are applied; anything else (OR, NQ, other operators) is flagged, not guessed. */
    addEncodedQuery(encoded) {
      String(encoded || '')
        .split('^')
        .filter(Boolean)
        .forEach((token) => {
          const m = token.match(/^([A-Za-z0-9_.]+)(!=|=)(.*)$/);
          if (m && !/^(OR|NQ)/.test(token)) this.__filters.push([m[1], m[2], m[3]]);
          else warn('encoded-query-unmodelled', `addEncodedQuery("${token}") uses syntax the simulator does not evaluate, so it was not applied to the simulated rows.`);
        });
    }

    setLimit(n) {
      this.__limit = Number(n);
    }

    orderBy(col) {
      this.__sort = [col, 1];
    }

    orderByDesc(col) {
      this.__sort = [col, -1];
    }

    get(a, b) {
      // get(sysId) or get(column, value); like the real call it loads the first match and positions on it.
      this.__filters = [b === undefined ? ['sys_id', '=', a] : [a, '=', b]];
      this.queryNow();
      return this.next();
    }

    queryNow() {
      const source = scenario.records?.[this.__table] || [];
      const matches = (row, [col, op, expected]) => {
        const actual = row[col] == null ? '' : String(row[col]);
        const want = String(expected);
        switch (op) {
          case '=': return actual === want;
          case '!=': return actual !== want;
          case '>': return Number(actual) > Number(want);
          case '<': return Number(actual) < Number(want);
          case '>=': return Number(actual) >= Number(want);
          case '<=': return Number(actual) <= Number(want);
          case 'CONTAINS': case 'LIKE': return actual.toLowerCase().includes(want.toLowerCase());
          case 'STARTSWITH': return actual.toLowerCase().startsWith(want.toLowerCase());
          case 'ENDSWITH': return actual.toLowerCase().endsWith(want.toLowerCase());
          case 'IN': return want.split(',').includes(actual);
          default:
            warn('query-operator-unmodelled', `GlideRecord addQuery operator "${op}" is not modelled by the simulator; the condition was ignored.`);
            return true;
        }
      };
      let rows = source.filter((row) => this.__filters.every((f) => matches(row, f)));
      if (this.__sort) {
        const [col, dir] = this.__sort;
        rows = [...rows].sort((x, y) => (String(x[col]) < String(y[col]) ? -dir : String(x[col]) > String(y[col]) ? dir : 0));
      }
      this.__rows = Number.isFinite(this.__limit) ? rows.slice(0, this.__limit) : rows;
      this.__i = -1; // a second query() on the same object starts again from the first row
    }

    query(callback) {
      this.queryNow();
      record('GlideRecord.query', [this.__table]);
      if (typeof callback === 'function') later(() => callback(this));
    }

    next() {
      this.__i += 1;
      const row = this.__rows[this.__i];
      // Real client GlideRecord exposes the current row's columns as properties (gr.short_description).
      if (row) Object.entries(row).forEach(([k, v]) => { if (!(k in GlideRecord.prototype)) this[k] = v == null ? '' : String(v); });
      return this.__i < this.__rows.length;
    }

    getValue(col) {
      const v = this.__rows[this.__i]?.[col];
      return v == null ? '' : String(v);
    }

    getRowCount() {
      return this.__rows.length;
    }

    hasNext() {
      return this.__i + 1 < this.__rows.length;
    }

    insert() {
      record('GlideRecord.insert', [this.__table]);
      warn('client-gliderecord-write', 'Client-side GlideRecord writes are not applied by the simulator, and are discouraged: use a Script Include.');
    }

    update() {
      record('GlideRecord.update', [this.__table]);
      warn('client-gliderecord-write', 'Client-side GlideRecord writes are not applied by the simulator, and are discouraged: use a Script Include.');
    }

    deleteRecord() {
      record('GlideRecord.deleteRecord', [this.__table]);
      warn('client-gliderecord-write', 'Client-side GlideRecord writes are not applied by the simulator, and are discouraged: use a Script Include.');
    }
  }

  // g_modal.confirm/alert take an optional callback as well as returning a promise; honour both.
  const modal = {
    confirm: (...a) => {
      record('g_modal.confirm', a);
      const answer = scenario.modalConfirm !== false;
      const callback = a.find((x) => typeof x === 'function');
      if (callback) later(() => callback(answer));
      return Promise.resolve(answer);
    },
    alert: (...a) => {
      record('g_modal.alert', a);
      const callback = a.find((x) => typeof x === 'function');
      if (callback) later(() => callback());
      return Promise.resolve();
    },
    showFrame: (...a) => (record('g_modal.showFrame', a), Promise.resolve()),
    showFields: (...a) => (record('g_modal.showFields', a), Promise.resolve({})),
  };

  const navigation = new Proxy(
    {},
    {
      get: (_t, prop) => (typeof prop === 'string' ? (...a) => void record(`g_navigation.${prop}`, a) : undefined),
    }
  );

  const confirmFn = (text) => {
    record('confirm', [text]);
    warn('native-dialog', 'confirm()/alert() are blocking native dialogs. Use g_modal.confirm() or g_form.addInfoMessage().');
    return scenario.confirm !== false;
  };
  const alertFn = (text) => {
    record('alert', [text]);
    warn('native-dialog', 'confirm()/alert() are blocking native dialogs. Use g_modal.alert() or g_form.addInfoMessage().');
  };

  // Virtual time: timer callbacks run during settle(), earliest first, instead of after the result is built.
  const timers = [];
  let timerSeq = 0;
  const addTimer = (kind) => (fn, delay = 0) => {
    if (typeof fn !== 'function') return 0;
    timerSeq += 1;
    timers.push({ id: timerSeq, fn, delay: Number(delay) || 0, order: timerSeq });
    warn('timer', `${kind}() callbacks run in simulated time, once, in order of delay. Real timers fire later, after the user may have changed the form.`);
    return timerSeq;
  };
  const clearTimer = (id) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };

  // onCellEdit must call callback(true|false) or the list editor waits forever.
  let cellCallback = null;
  const cellEditCallback = (ok) => {
    cellCallback = Boolean(ok);
    record('onCellEdit callback', [Boolean(ok)]);
  };

  const globals = {
    setTimeout: addTimer('setTimeout'),
    setInterval: addTimer('setInterval'),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
    g_form: gForm,
    g_user: gUser,
    g_modal: modal,
    g_navigation: navigation,
    g_scratchpad: { ...(scenario.scratchpad || {}) },
    g_list: undefined,
    GlideAjax,
    GlideRecord,
    GlideModal: undefined,
    getMessage: (key) => scenario.messages?.[key] ?? key,
    confirm: confirmFn,
    alert: alertFn,
    console: { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    document: blockedDom('document'),
    window: blockedDom('window'),
    jQuery: blockedDom('jQuery'),
    $j: blockedDom('$j'),
  };

  async function settle() {
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round += 1) {
      // Run only the callbacks queued before this round started: a callback that schedules itself
      // again would otherwise keep this loop (and the MAX_SETTLE_ROUNDS guard) from ever finishing.
      for (let pending = queue.length; pending > 0 && queue.length; pending -= 1) queue.shift()();
      // eslint-disable-next-line no-await-in-loop -- let promise chains (g_modal) run between rounds.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!queue.length && timers.length) {
        timers.sort((x, y) => x.delay - y.delay || x.order - y.order);
        timers.shift().fn(); // an interval is run once: simulating every tick would never finish
        continue;
      }
      if (!queue.length) return;
    }
    warn('settle-limit', 'Callbacks kept scheduling more callbacks; the simulation stopped waiting.');
  }

  return {
    globals,
    settle,
    cellEditCallback,
    cellCallbackCalled: () => cellCallback,
    warn,
    result: () => ({
      calls,
      messages,
      ajaxCalls,
      warnings,
      fieldChanges,
      finalFields: Object.fromEntries(
        [...fields].map(([name, f]) => [name, { value: f.value, mandatory: f.mandatory, readOnly: f.readOnly, visible: f.visible, label: f.label }])
      ),
    }),
  };
}

/**
 * @param {{ code: string, clientType: 'onLoad'|'onChange'|'onSubmit'|'onCellEdit', scenario?: object,
 *           evaluate?: (source: string, names: string[], values: any[]) => any }} input
 */
export async function runClientScript({ code, clientType, scenario = {}, evaluate = defaultEvaluate }) {
  const env = createMockEnvironment(scenario);
  const names = Object.keys(env.globals);
  const values = names.map((n) => env.globals[n]);

  let error = null;
  let returned;
  let handlerFound = false;

  try {
    const source = `${code}\n;return (typeof ${clientType} === 'function') ? ${clientType} : undefined;`;
    const handler = evaluate(source, names, values);
    if (typeof handler !== 'function') {
      error = { message: `No function ${clientType}() was found in the script.` };
    } else {
      handlerFound = true;
      const changed = scenario.changedField || 'field';
      if (clientType === 'onChange') {
        returned = handler({ name: changed }, scenario.oldValue ?? '', scenario.newValue ?? '', Boolean(scenario.isLoading), Boolean(scenario.isTemplate));
      } else if (clientType === 'onCellEdit') {
        returned = handler(scenario.sysIDs || [], scenario.table || '', scenario.oldValues || {}, scenario.newValue ?? '', env.cellEditCallback);
      } else {
        returned = handler();
      }
      if (returned && typeof returned.then === 'function') returned = await returned;
    }
  } catch (err) {
    error = { message: err?.message || String(err) };
  }

  await env.settle().catch((err) => {
    error = error || { message: err?.message || String(err) };
  });

  if (handlerFound && !error && clientType === 'onCellEdit' && env.cellCallbackCalled() === null) {
    env.warn('cell-callback-missing', 'onCellEdit never called callback(true) or callback(false). The list editor would wait forever and the cell would stay locked.');
  }

  const out = env.result();
  return {
    ok: !error,
    handlerFound,
    error,
    returned: returned === undefined ? null : returned,
    submitAllowed: clientType === 'onSubmit' ? returned !== false : undefined,
    ...out,
  };
}

/** Compact, model-friendly summary of a run. */
export function describeRun(run, clientType) {
  const lines = [];
  lines.push(run.ok ? `${clientType} ran without errors.` : `${clientType} FAILED: ${run.error.message}`);
  if (clientType === 'onSubmit') lines.push(run.submitAllowed ? 'Submit would be allowed.' : 'Submit would be BLOCKED (returned false).');
  if (run.calls.length) lines.push('', 'Calls:', ...run.calls.map((c) => `  ${c}`));
  else if (run.ok) lines.push('The script made no g_form calls.');
  if (run.fieldChanges.length) lines.push('', 'Field changes:', ...run.fieldChanges.map((c) => `  ${c.field}: "${c.from}" -> "${c.to}"`));
  if (run.messages.length) lines.push('', 'Messages shown:', ...run.messages.map((m) => `  [${m.type}] ${m.text}`));
  if (run.ajaxCalls.length) lines.push('', 'GlideAjax:', ...run.ajaxCalls.map((a) => `  ${a.scriptInclude}.${a.method}(${JSON.stringify(a.params)})`));
  if (run.warnings.length) lines.push('', 'Warnings:', ...run.warnings.map((w) => `  - ${w.message}`));
  return lines.join('\n');
}
