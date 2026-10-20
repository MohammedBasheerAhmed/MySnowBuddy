// Dev-only (not shipped): fake answers for the Hot spots panel in the preview harness. fakeInstance.js calls
// hotspotsFixture(method, url) first; it answers only the tables below and returns null for everything else.
//   syslog_transaction, syslog, sysevent, sys_trigger, sys_outbound_http_log, sys_audit (rows and Aggregate API)
// Counts scale with the window in the query (gs.minutesAgo(15) ... gs.daysAgo(7)) so changing the window visibly changes them.

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const hex = (n) => n.toString(16).padStart(8, '0').repeat(4);
const FAKE_RECORDS = [
  ['incident', 'INC0010042', 'Laptop will not boot', 41],
  ['incident', 'INC0010041', 'VPN drops every 10 minutes', 27],
  ['change_request', 'CHG0030012', 'Patch the payroll database', 19],
  ['problem', 'PRB0040007', 'Recurring SSO timeouts', 12],
].map(([table, number, short, changes], i) => ({ table, id: hex(0xabc000 + i), number, short, changes }));

function factor(query) {
  const m = /gs\.(minutesAgo|hoursAgo|daysAgo)\((\d+)\)/.exec(query);
  if (!m) return 1;
  const hours = m[1] === 'minutesAgo' ? Number(m[2]) / 60 : m[1] === 'hoursAgo' ? Number(m[2]) : Number(m[2]) * 24;
  return Math.max(0.25, hours);
}

const TX = [
  ['/incident.do?sys_id=abc', 2400, 1500, 90, 300, 40],
  ['/incident.do?sys_id=def', 4100, 2600, 140, 700, 80],
  ['/incident_list.do?sysparm_query=active%3Dtrue', 5200, 4300, 310, 100, 12],
  ['/api/now/table/task/6816f79cc0a8016401c5a33be04be441', 1800, 400, 20, 1100, 140],
  ['/api/now/table/task/287ebd7da9fe198100f92cc8d1d2154e', 2200, 600, 28, 1300, 160],
  ['/api/x_acme/orders/v1/42/lines', 3600, 900, 45, 2200, 22],
  ['/xmlhttp.do', 900, 200, 10, 100, 3],
  ['JOB: Cleanup old sessions', 62000, 21000, 900, 5000, 30],
  ['JOB: Cleanup old sessions', 71000, 24000, 1100, 6000, 40],
  ['JOB: Sync users from LDAP', 184000, 90000, 5200, 40000, 400],
  ['/home.do', 700, 120, 8, 40, 2],
];
const USERS = ['abel.tuter', 'beth.anglin', 'svc.integration', 'admin'];

function transactions(query, limit) {
  let rows = [];
  let n = 0;
  for (let rep = 0; rep < 4; rep += 1) {
    TX.forEach(([url, ms, sql, sqlCount, rules, ruleCount], i) => {
      n += 1;
      const wobble = 1 + ((n * 37) % 11) / 20;
      rows.push({
        sys_id: hex(0x500000 + n),
        url,
        response_time: String(Math.round(ms * wobble)),
        sql_time: String(Math.round(sql * wobble)),
        sql_count: String(Math.round(sqlCount * wobble)),
        business_rule_time: String(Math.round(rules * wobble)),
        business_rule_count: String(ruleCount),
        sys_created_by: USERS[(i + rep) % USERS.length],
        sys_created_on: '2026-10-20 12:00:00',
      });
    });
  }
  if (/urlSTARTSWITHJOB:/.test(query)) rows = rows.filter((r) => r.url.startsWith('JOB:'));
  const startsWith = /urlSTARTSWITH([^^]+)/.exec(query);
  if (startsWith && !startsWith[1].startsWith('JOB:')) rows = rows.filter((r) => r.url.startsWith(startsWith[1]));
  const order = /ORDERBYDESC(\w+)/.exec(query)?.[1] || 'response_time';
  rows.sort((a, b) => Number(b[order] || 0) - Number(a[order] || 0));
  return rows.slice(0, limit);
}

function logs(query, limit) {
  const messages = [
    ['MyIncidentBR', 'Record %n failed validation for %id', 2],
    ['MyIncidentBR', 'Record %n failed validation for %id', 2],
    ['Integration.Sync', 'Timeout calling https://api.acme.com/v1/users/%n after 30000ms', 2],
    ['Integration.Sync', 'Retry %n of 5 for user %n', 1],
    ['ScriptInclude.Utils', 'getDepartment called for %id', 0],
    ['ScriptInclude.Utils', 'getDepartment called for %id', 0],
    ['ScriptInclude.Utils', 'getDepartment called for %id', 0],
    ['Flow Designer', 'Flow "Approve change" started for CHG00%n', 0],
  ];
  const rows = [];
  for (let i = 0; i < 160; i += 1) {
    const [source, text, level] = messages[(i * 7 + (i % 3)) % messages.length];
    rows.push({
      sys_id: hex(0x600000 + i),
      source,
      level: String(level),
      message: text.replace(/%n/g, String(1000 + ((i * 131) % 9000))).replace(/%id/g, hex(0x700000 + i)),
      sys_created_on: `2026-10-20 12:${String(59 - (i % 60)).padStart(2, '0')}:00`,
    });
  }
  const filtered = /level=2/.test(query) ? rows.filter((r) => r.level === '2') : rows;
  return filtered.slice(0, limit);
}

const TRIGGERS = [
  { sys_id: hex(0x800001), name: 'Sync users from LDAP', state: '1', next_action: '2026-10-20 09:00:00', claimed_by: 'app123.node2' },
  { sys_id: hex(0x800002), name: 'Rebuild search index', state: '1', next_action: '2026-10-20 11:20:00', claimed_by: 'app124.node1' },
];

const OUTBOUND = Array.from({ length: 60 }, (_, i) => ({
  url: i % 4 === 0 ? `https://api.acme.com/v1/users/${i}` : i % 4 === 1 ? 'https://hooks.partner.io/notify' : `https://api.acme.com/v1/orders/${i}`,
  response_code: i % 9 === 0 ? '503' : '200',
  response_time: String(120 + ((i * 53) % 900)),
  sys_created_on: '2026-10-20 12:00:00',
}));

function groups(table, query, groupBy) {
  const f = factor(query);
  const g = (values, count) => ({ stats: { count: String(Math.round(count * f)) }, groupby_fields: Object.entries(values).map(([field, value]) => ({ field, value })) });
  if (table === 'syslog' && groupBy.join() === 'source') return [g({ source: 'MyIncidentBR' }, 420), g({ source: 'Integration.Sync' }, 260), g({ source: 'ScriptInclude.Utils' }, 910), g({ source: 'Flow Designer' }, 80)];
  if (table === 'sysevent' && groupBy.join() === 'name') return [g({ name: 'incident.updated' }, 300), g({ name: 'email.read' }, 120), g({ name: 'user.login' }, 45), g({ name: 'x_acme.sync.retry' }, 700)];
  if (table === 'syslog_transaction' && groupBy.join() === 'sys_created_by') return [g({ sys_created_by: 'svc.integration' }, 5200), g({ sys_created_by: 'abel.tuter' }, 340), g({ sys_created_by: 'admin' }, 90), g({ sys_created_by: 'guest' }, 30)];
  if (table === 'sys_audit' && groupBy.join() === 'tablename') return [g({ tablename: 'incident' }, 900), g({ tablename: 'sys_user' }, 300), g({ tablename: 'task' }, 650), g({ tablename: 'x_acme_order' }, 140)];
  if (table === 'sys_audit' && groupBy.join() === 'tablename,documentkey') return FAKE_RECORDS.map((r) => g({ tablename: r.table, documentkey: r.id }, r.changes));
  return [];
}

export function hotspotsFixture(method, u) {
  if (method !== 'GET') return null;
  const params = u.searchParams;
  const query = params.get('sysparm_query') || '';
  const limit = Number(params.get('sysparm_limit')) || 50;

  let m = /^\/api\/now\/stats\/([^/]+)$/.exec(u.pathname);
  if (m && ['syslog', 'sysevent', 'syslog_transaction', 'sys_audit'].includes(m[1])) {
    const table = decodeURIComponent(m[1]);
    const groupBy = (params.get('sysparm_group_by') || '').split(',').filter(Boolean);
    if (groupBy.length) return json({ result: groups(table, query, groupBy) });
    const total = { syslog: 4000, sysevent: 900, syslog_transaction: 6200, sys_audit: 3000 }[table];
    return json({ result: { stats: { count: String(Math.round(total * factor(query))) } } });
  }

  m = /^\/api\/now\/table\/([^/]+)$/.exec(u.pathname);
  if (!m) return null;
  const table = decodeURIComponent(m[1]);
  if (table === 'syslog_transaction') return json({ result: transactions(query, limit) });
  if (table === 'syslog') return json({ result: logs(query, limit) });
  if (table === 'sys_trigger') return json({ result: TRIGGERS });
  if (table === 'sys_outbound_http_log') return json({ result: OUTBOUND.slice(0, limit) });
  const names = /^sys_idIN(.+)$/.exec(query);
  if (names && ['incident', 'change_request', 'problem'].includes(table)) {
    const wanted = names[1].split(',');
    const rows = FAKE_RECORDS.filter((r) => r.table === table && wanted.includes(r.id)).map((r) => ({ sys_id: r.id, number: r.number, short_description: r.short }));
    return rows.length ? json({ result: rows }) : null;
  }
  return null;
}
