// Dev-only fake instance data and a fake Service Portal page for the Portal inspector (see preview/fixtures/index.js).
//
//   http://localhost:<port>/preview.html?page=portal&open=portal            debug info on, three widgets, four instances
//   ...&debug=off                                                           Angular debug info off: scope() answers nothing
//   ...&q=banner                                                            /sp banner (opens the one matching widget)
//
// With ?page=portal this module turns the preview page into a portal page: the address becomes /sp?id=tickets, three widgets
// (four instances) are drawn with the markers a real portal uses (id="x<instance>", class="v<widget>", <sp-page-row>,
// <sp-widget>), each with a fake Angular scope, and the page-world bridge actions are answered by the REAL code the extension
// ships (src/lib/portalScope.js), so the serialiser, the scope finder and the debug-info check run for real in a browser.
// The buttons inside the widgets change their scope data, so Snapshot and compare can be tried.

import { portalActions } from '../../src/lib/portalScope.js';

const W = { list: 'a1b2c3d4e5f60718293a4b5c6d7e8f01', banner: 'a1b2c3d4e5f60718293a4b5c6d7e8f02', approvals: 'a1b2c3d4e5f60718293a4b5c6d7e8f03' };
const I = {
  list: 'b1b2c3d4e5f60718293a4b5c6d7e8f01',
  banner: 'b1b2c3d4e5f60718293a4b5c6d7e8f02',
  notice: 'b1b2c3d4e5f60718293a4b5c6d7e8f03',
  approvals: 'b1b2c3d4e5f60718293a4b5c6d7e8f04',
};
const PAGE_ID = 'c1b2c3d4e5f60718293a4b5c6d7e8f01';
const PORTAL_ID = 'd1b2c3d4e5f60718293a4b5c6d7e8f01';
const SI_UTILS = 'e1b2c3d4e5f60718293a4b5c6d7e8f01';

const LIST_SERVER = `(function() {
  data.title = options.title || 'My open tickets';
  data.limit = parseInt(options.limit) || 5;
  data.filter = { table: options.table || 'incident', query: 'active=true^caller_id=' + gs.getUserID() };
  data.canCreate = gs.hasRole('itil');
  data.items = [];
  var gr = new GlideRecord(data.filter.table);
  gr.addEncodedQuery(data.filter.query);
  gr.orderByDesc('sys_updated_on');
  gr.setLimit(data.limit);
  gr.query();
  while (gr.next()) {
    data.items.push({ number: gr.getValue('number'), short_description: gr.getValue('short_description'), sys_id: gr.getUniqueValue() });
  }
  data.count = data.items.length;
  var stats = new global.IncidentUtils().summary(data.filter.query);
  data.stats = stats;
  data.pageSize = parseInt($sp.getParameter('page_size')) || 10;
  data.label = gs.getProperty('x_acme.portal.ticket_label', 'Tickets');
  if (input.action === 'close') {
    var rec = new GlideRecord('incident');
    if (rec.get(input.sys_id)) { rec.state = 7; rec.update(); }
    data.closed = input.sys_id;
  }
  if (input.action === 'comment') {
    data.commented = true;
  }
})();`;

const LIST_CLIENT = `api.controller = function($scope, spUtil) {
  var c = this;
  c.close = function(sysId) {
    c.server.get({ action: 'close', sys_id: sysId }).then(function() { c.data.lastAction = 'closed'; });
  };
  c.refresh = function() { c.server.refresh(); };
  spUtil.recordWatch($scope, 'incident', 'active=true');
  $scope.$on('ticket.created', function() { c.server.update(); });
  if (c.data.showArchive) { c.archive(); }
};`;

const LIST_TEMPLATE = `<div class="panel panel-default">
  <div class="panel-heading">{{c.data.title}} <span class="badge">{{c.data.count}}</span></div>
  <ul class="list-group"><li class="list-group-item" ng-repeat="i in c.data.items">{{i.number}} {{i.short_description}}</li></ul>
  <button ng-click="c.close(c.data.items[0].sys_id)">Close first</button>
  <widget id="announcement-banner" options="c.options"></widget>
</div>`;

const WIDGETS = [
  {
    sys_id: W.list,
    name: 'Ticket list',
    id: 'ticket-list',
    script: LIST_SERVER,
    client_script: LIST_CLIENT,
    template: LIST_TEMPLATE,
    css: '.panel-heading { font-weight: 600; }',
    option_schema: JSON.stringify([
      { name: 'title', label: 'Title', type: 'string', default_value: 'My open tickets', section: 'Presentation', hint: 'Heading shown above the list' },
      { name: 'limit', label: 'Rows', type: 'integer', default_value: '10', section: 'Behavior', hint: 'How many tickets to load' },
      { name: 'table', label: 'Table', type: 'string', default_value: 'incident', section: 'Data' },
      { name: 'size', label: 'Size', type: 'string', default_value: 'md', section: 'Presentation' },
    ]),
    data_table: 'sp_instance',
    link: '',
    roles: '',
    public: 'false',
    sys_updated_on: '2026-10-14 09:31:07',
    sys_updated_by: 'maria.dev',
  },
  {
    sys_id: W.banner,
    name: 'Announcement banner',
    id: 'announcement-banner',
    script: "data.message = options.message || 'No announcements';\ndata.level = options.level || 'info';\nvar a = new GlideRecord('u_announcement');\na.addActiveQuery();\na.query();\ndata.hasMore = a.hasNext();",
    client_script: 'api.controller = function() { var c = this; c.dismiss = function() { c.data.dismissed = true; }; };',
    template: '<div class="alert alert-{{c.data.level}}" ng-if="!c.data.dismissed">{{c.data.message}} <button ng-click="c.dismiss()">Dismiss</button></div>',
    css: '',
    option_schema: JSON.stringify([{ name: 'message', label: 'Message', type: 'string', default_value: '' }, { name: 'level', label: 'Level', type: 'choice', default_value: 'info' }]),
    data_table: 'sp_instance',
    link: '',
    roles: '',
    public: 'true',
    sys_updated_on: '2026-09-02 15:12:44',
    sys_updated_by: 'admin',
  },
  {
    sys_id: W.approvals,
    name: 'Approval counter',
    id: 'approval-counter',
    script: "var ga = new GlideAggregate('sysapproval_approver');\nga.addQuery('approver', gs.getUserID());\nga.addQuery('state', 'requested');\nga.addAggregate('COUNT');\nga.query();\ndata.pending = ga.next() ? parseInt(ga.getAggregate('COUNT')) : 0;\ndata.credentials = { api_key: 'sk-live-1234567890abcdef', note: 'visible' };",
    client_script: '',
    template: '<a href="?id=approvals">{{c.data.pending}} waiting for you</a>',
    css: '',
    option_schema: '',
    data_table: 'sp_instance',
    link: '',
    roles: 'itil',
    public: 'false',
    sys_updated_on: '2026-08-21 11:05:30',
    sys_updated_by: 'maria.dev',
  },
];

const INSTANCES = [
  { sys_id: I.list, sp_widget: W.list, title: 'My open tickets', sys_class_name: 'sp_instance', widget_parameters: JSON.stringify({ limit: '5', table: 'incident', apiToken: 'abc123def456' }), sys_updated_on: '2026-10-14 09:40:00' },
  { sys_id: I.banner, sp_widget: W.banner, title: '', sys_class_name: 'sp_instance', widget_parameters: JSON.stringify({ message: 'Scheduled maintenance on Saturday', level: 'warning' }), sys_updated_on: '2026-09-02 15:20:00' },
  { sys_id: I.notice, sp_widget: W.banner, title: 'Footer notice', sys_class_name: 'sp_instance', widget_parameters: '', sys_updated_on: '2026-09-02 15:25:00' },
  { sys_id: I.approvals, sp_widget: W.approvals, title: '', sys_class_name: 'sp_instance', widget_parameters: '', sys_updated_on: '2026-08-21 11:10:00' },
];

const TABLES = {
  sp_widget: WIDGETS,
  sp_instance: INSTANCES,
  sp_page: [{ sys_id: PAGE_ID, id: 'tickets', title: 'My tickets' }],
  sp_portal: [{ sys_id: PORTAL_ID, title: 'Service Portal', url_suffix: 'sp' }],
  sys_script_include: [{ sys_id: SI_UTILS, name: 'IncidentUtils' }],
};

/** The rows an encoded query like sys_id=x, sys_idINa,b or id=x picks (only the shapes this feature uses). */
function pick(rows, query) {
  const q = String(query || '');
  let m;
  if ((m = /^(\w+)IN([^^]*)$/.exec(q))) {
    const wanted = new Set(m[2].split(','));
    return rows.filter((r) => wanted.has(r[m[1]]));
  }
  if ((m = /^(\w+)=([^^]*)$/.exec(q))) return rows.filter((r) => r[m[1]] === m[2]);
  return rows;
}

export function route(method, url) {
  if (method !== 'GET') return null;
  // Only on the fake portal page; on every other preview page its widget, page and Script Include rows would answer queries they do not match.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('page') !== 'portal') return null;
  const m = /^\/api\/now\/table\/([^/]+)$/.exec(url.pathname);
  if (!m || !TABLES[m[1]]) return null;
  const fields = (url.searchParams.get('sysparm_fields') || '').split(',').filter(Boolean);
  const rows = pick(TABLES[m[1]], url.searchParams.get('sysparm_query')).map((r) => (fields.length ? Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])) : r));
  return new Response(JSON.stringify({ result: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// --- The fake portal page -----------------------------------------------------------------------------------------

const params = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
const ON = params.get('page') === 'portal';
const state = { debug: params.get('debug') !== 'off' };

function makeData() {
  const items = [
    { number: 'INC0010041', short_description: 'Email not syncing on phone', state: 'New', priority: 2, sys_id: 'f1' },
    { number: 'INC0010038', short_description: 'VPN drops every hour', state: 'In Progress', priority: 3, sys_id: 'f2' },
    { number: 'INC0010027', short_description: 'Laptop battery swelling', state: 'On Hold', priority: 1, sys_id: 'f3' },
  ];
  const data = {
    title: 'My open tickets',
    limit: 5,
    count: items.length,
    items,
    filter: { table: 'incident', query: 'active=true^caller_id=6816f79cc0a8016401c5a33be04be441' },
    canCreate: true,
    stats: { open: 3, overdue: 1, byPriority: { 1: 1, 2: 1, 3: 1 } },
    pageSize: 10,
    label: 'Tickets',
    user: { name: 'Abel Tuter', sys_id: '62826bf03710200044e0bfc8bcbe5df1', roles: ['itil', 'snc_internal'], token: 'sk_live_51H8abcdefghijkl', password: 'hunter2' },
    refresh() {},
  };
  items[0].siblings = items; // a cycle, the way a real scope can have one
  return data;
}

function widgetScope(widget, instanceId, data, options) {
  return { widget: { sys_id: widget.sys_id, rectangle_id: instanceId, name: widget.name, id: widget.id, options, _server_time: 87 }, data, options, c: { data, options } };
}

/** Draws the portal into `root` and gives every widget a fake Angular scope. Returns the buttons' hooks. */
function renderPortal(root) {
  const listData = makeData();
  const listOptions = { title: 'My open tickets', limit: '5', table: 'incident', size: 'md', apiToken: 'abc123def456' };
  const bannerData = { message: 'Scheduled maintenance on Saturday', level: 'warning', dismissed: false, hasMore: true };
  const bannerOptions = { message: 'Scheduled maintenance on Saturday', level: 'warning' };
  const noticeData = { message: 'No announcements', level: 'info', dismissed: false, hasMore: false };
  const approvalData = { pending: 4, credentials: { api_key: 'sk-live-1234567890abcdef', note: 'visible' } };

  const mark = (cls) => (state.debug ? `${cls} ng-scope` : cls);
  root.innerHTML = `
<style>
  .fake{max-width:none!important}
  .sp-demo .row{display:flex;gap:16px;margin-bottom:16px}
  .sp-demo .col-md-8{flex:2 1 0}.sp-demo .col-md-4{flex:1 1 0}.sp-demo .col-md-12{flex:1 1 100%}
  .sp-demo .panel{background:#fff;border:1px solid #dde1e5;border-radius:6px;padding:12px}
  .sp-demo h2{font-size:15px;margin:0 0 8px}.sp-demo ul{margin:0;padding-left:18px}.sp-demo button{margin-top:8px}
  .sp-demo .alert{background:#fdf4e3;border:1px solid #eed6a4;border-radius:6px;padding:10px 12px}
</style>
<div class="sp-demo" ng-app="sn.$sp">
  <div class="bar">Service Portal &nbsp;·&nbsp; My tickets</div>
  <sp-page-row><div class="row">
    <div class="col-md-8">
      <div id="x${I.list}" class="${mark(`v${W.list}`)}"><div class="panel" id="demo-list">
        <h2>My open tickets</h2><ul id="demo-list-items"></ul>
        <button type="button" id="demo-close">Close first ticket</button>
        <button type="button" id="demo-add">New ticket arrives</button>
        <button type="button" id="demo-pagesize">Next page size</button>
      </div></div>
    </div>
    <div class="col-md-4">
      <div id="x${I.banner}" class="${mark(`v${W.banner}`)}"><div class="alert" id="demo-banner">Scheduled maintenance on Saturday</div></div>
    </div>
  </div></sp-page-row>
  <sp-page-row><div class="row">
    <div class="col-md-12">
      <div id="x${I.approvals}" class="${mark(`v${W.approvals}`)}"><div class="panel"><h2>Approvals</h2><span id="demo-pending">4 waiting for you</span>
        <button type="button" id="demo-approve">Approve one</button></div></div>
      <div id="x${I.notice}" class="${mark(`v${W.banner}`)}" style="margin-top:12px"><div class="alert">No announcements</div></div>
    </div>
  </div></sp-page-row>
</div>`;

  const byId = (id) => document.getElementById(id);
  const bind = (id, scope, widget, instance) => {
    const el = document.getElementById(`x${instance}`);
    el.__scope = scope;
    el.__widget = widget;
    return el;
  };
  bind('', widgetScope(WIDGETS[0], I.list, listData, listOptions), WIDGETS[0], I.list);
  bind('', widgetScope(WIDGETS[1], I.banner, bannerData, bannerOptions), WIDGETS[1], I.banner);
  bind('', widgetScope(WIDGETS[1], I.notice, noticeData, {}), WIDGETS[1], I.notice);
  bind('', widgetScope(WIDGETS[2], I.approvals, approvalData, {}), WIDGETS[2], I.approvals);

  const draw = () => {
    byId('demo-list-items').innerHTML = listData.items.map((i) => `<li>${i.number} ${i.short_description} <em>${i.state}</em></li>`).join('');
    byId('demo-pending').textContent = `${approvalData.pending} waiting for you`;
  };
  draw();
  byId('demo-close').onclick = () => {
    const first = listData.items[0];
    if (first) {
      first.state = 'Closed';
      listData.lastAction = 'closed';
      listData.closed = first.sys_id;
    }
    draw();
  };
  byId('demo-add').onclick = () => {
    listData.items.push({ number: `INC00100${50 + listData.items.length}`, short_description: 'New request from the portal', state: 'New', priority: 4, sys_id: `f${listData.items.length + 1}` });
    listData.count = listData.items.length;
    draw();
  };
  byId('demo-pagesize').onclick = () => {
    listData.pageSize += 10;
    draw();
  };
  byId('demo-approve').onclick = () => {
    approvalData.pending -= 1;
    draw();
  };
}

function installFakeAngular() {
  const wrap = (el) => ({
    scope: () => (state.debug ? el.__scope : undefined),
    isolateScope: () => undefined,
  });
  window.angular = {
    version: { full: '1.5.11' },
    element: wrap,
    reloadWithDebugInfo() {
      // A real call reloads the page; the preview flips debug info on and marks the elements the way Angular does.
      window.__portalReloaded = (window.__portalReloaded || 0) + 1;
      state.debug = true;
      document.querySelectorAll('[class*="v"][id^="x"]').forEach((el) => el.classList.add('ng-scope'));
    },
  };
  // The REAL bridge actions (src/lib/portalScope.js) answer for the page. They respond before the generic fake bridge does.
  const actions = portalActions(() => ({ doc: document, ng: window.angular }));
  document.addEventListener('msb-page-request', (event) => {
    const { id, action, args = [] } = event.detail || {};
    if (!Object.prototype.hasOwnProperty.call(actions, action)) return;
    event.stopImmediatePropagation(); // the generic fake bridge would answer "unknown action" otherwise
    let detail;
    try {
      detail = { id, ok: true, result: actions[action](...args) };
    } catch (err) {
      detail = { id, ok: false, error: err.message };
    }
    document.dispatchEvent(new CustomEvent('msb-page-response', { detail }));
  });
  window.__portalFake = { state };
}

if (ON && typeof document !== 'undefined') {
  // A portal address, so the panel recognises the page; the query string (open=, theme=...) stays.
  const next = new URLSearchParams(location.search);
  if (!next.has('id')) next.set('id', 'tickets');
  try {
    history.replaceState(null, '', `/sp?${next.toString()}`);
  } catch {
    /* an address that cannot be rewritten leaves the page "not a portal", which is also worth seeing */
  }
  installFakeAngular();
  // Run after preview.jsx has drawn its default page into .fake.
  setTimeout(() => renderPortal(document.querySelector('.fake') || document.body), 0);
}
