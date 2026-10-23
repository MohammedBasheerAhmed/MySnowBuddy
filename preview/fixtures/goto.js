// Dev-only fake instance data for "Go to anything" in the command palette (src/lib/goTo.js, src/content/storedCommands.js).
// Registered in preview/fixtures/index.js ahead of the fixtures that give canned rows for the same tables.
//
// It answers only the palette's own name searches (recognised by the columns it asks for: sys_created_by, sys_updated_by and
// sys_class_name together, with display values on) and returns null for every other request, so the fake instance and the
// other fixtures keep answering their own panels. It supplies what the fake instance does not have or shadows: script
// includes with realistic names, portal widgets and pages, flows (one inactive), UI pages and macros, a transform map. A table
// a limited user cannot read (403) and tables this release does not have (400) are there on purpose: the palette must skip them.
//
//   http://localhost:<port>/preview.html?palette=open&prefill=AjaxUtil        script includes, found through their capitals
//   ...&prefill=closed                                                       a UI policy, a flow, an inactive notification
//   ...&prefill=br:%20sync                                                   one kind
//   ...&prefill=es:%20foo                                                    "Email Scripts cannot be read here"
//   ...&prefill=widget:%20hostile                                            names that must render as plain text: markup,
//                                                                            a right-to-left override, Arabic, 500 characters
//   ...&prefill=ui%20page:%20ignored                                         a release that ignores the condition (see below)

// A stable 32-hex sys_id per key (fakeInstance.js imports the fixtures, so it cannot be imported back from here).
function sid(key) {
  let h = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 4; round += 1) {
    for (let i = 0; i < key.length; i += 1) {
      h ^= key.charCodeAt(i) + round;
      h = Math.imul(h, 16777619) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

const ago = (days) => new Date(Date.now() - days * 864e5).toISOString().replace('T', ' ').slice(0, 19);
const SCOPES = { global: ['global', 'Global'], x_acme_hr: [sid('scope:x_acme_hr'), 'HR Tweaks'], sn_hr_core: [sid('scope:sn_hr_core'), 'Human Resources: Core'] };

// created / updated: who wrote and last changed it ('system' is shipped content); days: since the last change.
const row = (table, name, f = {}) => ({ table, sys_id: sid(`goto:${table}:${name}`), name, active: 'true', scope: 'global', created: 'system', updated: 'system', days: 300, ...f });
const custom = (days, by = 'maria.dev') => ({ created: by, updated: by, days });

const DATA = {
  sys_script_include: [
    row('sys_script_include', 'AJAXMessagingUtils', { api_name: 'global.AJAXMessagingUtils', client_callable: 'true' }),
    row('sys_script_include', 'AjaxUtil', { api_name: 'x_acme_hr.AjaxUtil', client_callable: 'true', scope: 'x_acme_hr', ...custom(3) }),
    row('sys_script_include', 'IncidentUtils', { api_name: 'global.IncidentUtils', client_callable: 'true', ...custom(1) }),
    row('sys_script_include', 'IncidentAjaxHelper', { api_name: 'global.IncidentAjaxHelper', client_callable: 'true', ...custom(20, 'beth.anglin') }),
    row('sys_script_include', 'GlideRecordUtil', { api_name: 'global.GlideRecordUtil', client_callable: 'false' }),
    row('sys_script_include', 'PriorityLookup', { api_name: 'global.PriorityLookup', client_callable: 'false', ...custom(90, 'admin') }),
    row('sys_script_include', 'LegacyHelper', { api_name: 'global.LegacyHelper', client_callable: 'false', active: 'false', ...custom(200) }),
    row('sys_script_include', 'HRCaseUtils', { api_name: 'sn_hr_core.HRCaseUtils', client_callable: 'false', scope: 'sn_hr_core' }),
  ],
  sp_widget: [
    row('sp_widget', 'Incident Approval Card', { id: 'incident-approval', ...custom(6) }),
    row('sp_widget', 'My open tickets', { id: 'ticket-list', ...custom(2) }),
    row('sp_widget', 'Banner', { id: 'banner', ...custom(40) }),
    row('sp_widget', 'Approvals', { id: 'approvals', ...custom(70) }),
    row('sp_widget', 'Simple List', { id: 'widget-simple-list' }),
    // Hostile names: shown as text only, never as markup; the long one is cut with an ellipsis.
    row('sp_widget', 'Hostile <img src=x onerror=alert(1)> card', { id: 'hostile-markup', ...custom(4) }),
    row('sp_widget', 'Hostile \u202Egpj.exe\u202C override', { id: 'hostile-rtl', ...custom(5) }),
    row('sp_widget', 'Hostile \u0639\u0646\u0635\u0631 \u0648\u0627\u062C\u0647\u0629 Arabic', { id: 'hostile-arabic', ...custom(6) }),
    row('sp_widget', `Hostile ${'very long widget name '.repeat(23)}end`, { id: 'hostile-long', ...custom(7) }),
  ],
  sp_page: [
    row('sp_page', 'My tickets', { id: 'tickets', title: 'My tickets', ...custom(9) }),
    row('sp_page', 'Incident detail', { id: 'incident-detail', title: 'Incident detail', ...custom(15) }),
    row('sp_page', 'Service Catalog', { id: 'sc_home', title: 'Service Catalog' }),
  ],
  sys_hub_flow: [
    row('sys_hub_flow', 'Incident closed notification', { type: 'flow', status: 'Published', ...custom(5) }),
    row('sys_hub_flow', 'Close stale incidents', { type: 'subflow', status: 'Published', ...custom(33) }),
    row('sys_hub_flow', 'Onboard new hire', { type: 'flow', status: 'Draft', active: 'false', ...custom(120, 'beth.anglin') }),
  ],
  sys_ui_page: [
    row('sys_ui_page', 'incident_close_dialog', { description: 'Resolution notes dialog', ...custom(18) }),
    row('sys_ui_page', 'approval_summary', { description: 'Approval summary popup', ...custom(25) }),
  ],
  sys_ui_macro: [row('sys_ui_macro', 'incident_banner_macro', { description: '', ...custom(50) })],
  sys_transform_map: [row('sys_transform_map', 'Incident import', { source_table: 'u_incident_import', target_table: 'incident', ...custom(12) })],
};

// A user without the role cannot read this table; this release does not have the others.
const FAIL = {
  sys_hub_action_type_definition: [403, 'User Not Authorized'],
  sys_script_email: [400, 'Invalid table sys_script_email'],
  wf_workflow: [400, 'Invalid table wf_workflow'],
};

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The rows an encoded query of the shapes the palette builds picks: LIKE and STARTSWITH groups joined with ^OR, = and ORDERBY. */
function select(rows, query) {
  const groups = [];
  let order = null;
  String(query || '').split('^').filter(Boolean).forEach((token) => {
    if (token.startsWith('ORDERBYDESC')) order = { field: token.slice(11), desc: true };
    else if (token.startsWith('ORDERBY')) order = { field: token.slice(7), desc: false };
    else if (token.startsWith('OR') && groups.length) groups[groups.length - 1].push(token.slice(2));
    else groups.push([token]);
  });
  const test = (r, cond) => {
    let m;
    if ((m = /^([a-z_]+)LIKE(.*)$/.exec(cond))) return String(r[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase());
    if ((m = /^([a-z_]+)STARTSWITH(.*)$/.exec(cond))) return String(r[m[1]] ?? '').toLowerCase().startsWith(m[2].toLowerCase());
    if ((m = /^([a-z_]+)=(.*)$/.exec(cond))) return String(r[m[1]] ?? '') === m[2];
    return true;
  };
  const found = rows.filter((r) => groups.every((g) => g.some((cond) => test(r, cond))));
  if (!order) return found;
  const key = order.field === 'sys_updated_on' ? (r) => r.days : (r) => String(r[order.field] ?? '').toLowerCase();
  const recent = order.field === 'sys_updated_on';
  return [...found].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    const cmp = x < y ? -1 : x > y ? 1 : 0;
    // Most recently changed first means the fewest days since the change.
    return recent ? (order.desc ? cmp : -cmp) : order.desc ? -cmp : cmp;
  });
}

function display(r, fields) {
  const all = {
    sys_id: r.sys_id,
    sys_class_name: r.table,
    name: r.name,
    title: r.title ?? r.name,
    id: r.id,
    api_name: r.api_name,
    client_callable: r.client_callable,
    type: r.type,
    status: r.status,
    description: r.description,
    source_table: r.source_table,
    target_table: r.target_table,
    active: r.active,
    sys_created_by: r.created,
    sys_updated_by: r.updated,
    sys_updated_on: ago(r.days),
  };
  const out = {};
  fields.forEach((field) => {
    if (field === 'sys_scope') out[field] = { value: SCOPES[r.scope][0], display_value: SCOPES[r.scope][1] };
    else if (field === 'sys_scope.scope') out[field] = { value: r.scope, display_value: r.scope };
    else if (all[field] !== undefined) out[field] = { value: String(all[field]), display_value: String(all[field]) };
  });
  return out;
}

export function route(method, url) {
  if (method !== 'GET') return null;
  const m = /^\/api\/now\/table\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  const table = decodeURIComponent(m[1]);
  if (!DATA[table] && !FAIL[table]) return null;
  const fields = (url.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const isPaletteSearch = url.searchParams.get('sysparm_display_value') === 'all' && ['sys_created_by', 'sys_updated_by', 'sys_class_name'].every((f) => fields.includes(f));
  if (!isPaletteSearch) return null;
  if (FAIL[table]) return json(FAIL[table][0], { error: { message: FAIL[table][1], detail: null }, status: 'failure' });
  const limit = Number(url.searchParams.get('sysparm_limit') || 50);
  const query = url.searchParams.get('sysparm_query') || '';
  // ServiceNow drops a condition on a column it does not have and answers with every row. Searching UI pages for
  // "ignored" acts that out: the palette must not show these rows as matches.
  const ignored = table === 'sys_ui_page' && /LIKEignored/i.test(query);
  const rows = (ignored ? DATA[table] : select(DATA[table], query)).slice(0, limit);
  return json(200, { result: rows.map((r) => display(r, fields)) });
}
