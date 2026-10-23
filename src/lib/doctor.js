// Self-check, the pure half: how to read what the instance answered, which tools have what they need, and the
// report. No DOM, no chrome.*, no network: src/content/doctor.js asks the instance and hands the raw answers here;
// src/sidebar/DoctorPanel.jsx shows the result; tests/doctor.test.js covers all of it.
//
// The idea: when a tool shows nothing, a developer cannot tell "there is nothing" from "NowBuddy cannot read it".
// Every check below is independent, says in plain words what happened and, when it is not fine, what to do.

export const RESULT_VERSION = 1;

/** The release the extension was calibrated against on a real instance (PROGRESS.md "Live calibration"). */
export const CALIBRATED_ON = 'Australia patch 7';

// Columns the platform adds to every table. Older dictionaries list them only on the root table, and a half-read
// hierarchy would call them missing, so they are assumed to be there.
export const UNIVERSAL_COLUMNS = ['sys_id', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count'];
const UNIVERSAL = new Set(UNIVERSAL_COLUMNS);

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$/;
const MAX_DEPTH = 10;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (text, max = 160) => {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

/** "850 ms" or "2.4 s". */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// ---- 1. Reading an HTTP answer ---------------------------------------------------------------------------------

const LOGIN_PAGE = /<form[^>]*login\.do|name=["']user_password["']|id=["']user_password["']|sysverb_login|<title>[^<]*log ?in\b/i;
const LOGIN_URL = /\/(?:login|logout|login_redirect|external_logout_complete)\.do\b|\/login\b|saml|\/sso\b/i;
const NO_SUCH_TABLE = /invalid table|invalid object|no such table|table .{0,80}(does not exist|not found|is not valid)/i;

/** { message, detail } from a ServiceNow JSON error body, or empty strings. */
export function serviceNowError(body) {
  try {
    const err = JSON.parse(body)?.error;
    if (!err) return { message: '', detail: '' };
    if (typeof err === 'string') return { message: err, detail: '' };
    return { message: typeof err.message === 'string' ? err.message : '', detail: typeof err.detail === 'string' ? err.detail : '' };
  } catch {
    return { message: '', detail: '' };
  }
}

/**
 * What an HTTP answer means for the Self-check.
 * kind: ok | session (expired or logged out) | denied (403) | missing (no such table) | notfound (no such endpoint) |
 *       badrequest | busy (429/503) | server (5xx) | html (a web page instead of data) | notoken | timeout | network | error
 * @param {{ status?: number, redirected?: boolean, url?: string, loggedIn?: string|null, contentType?: string, body?: string, failed?: Error|string|null }} reply
 * @returns {{ kind: string, status: number, message: string }}
 */
export function classifyHttp(reply = {}) {
  const { status = 0, redirected = false, url = '', loggedIn = null, body = '', failed = null } = reply;
  if (failed) {
    const name = failed.name || '';
    const text = String(failed.message || failed);
    if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'timeout', status: 0, message: 'No answer in time.' };
    if (/session token/i.test(text)) return { kind: 'notoken', status: 0, message: text };
    return { kind: 'network', status: 0, message: clip(text) };
  }
  const text = String(body || '');
  const isHtml = /^\s*</.test(text);
  if (status === 401 || String(loggedIn ?? '').toLowerCase() === 'false' || (redirected && LOGIN_URL.test(url)) || (isHtml && LOGIN_PAGE.test(text))) {
    return { kind: 'session', status, message: 'The session has ended.' };
  }
  const err = serviceNowError(text);
  const said = [err.message, err.detail].filter(Boolean).join(' - ');
  if (status >= 200 && status < 300) {
    if (isHtml) return { kind: 'html', status, message: 'A web page came back instead of data.' };
    if (text) {
      try {
        JSON.parse(text);
      } catch {
        return { kind: 'html', status, message: 'The answer was not JSON.' };
      }
    }
    return { kind: 'ok', status, message: '' };
  }
  if (status === 403) return { kind: 'denied', status, message: clip(said || 'Not allowed.') };
  if (status === 400 || status === 404) {
    if (NO_SUCH_TABLE.test(said)) return { kind: 'missing', status, message: clip(said) };
    if (status === 404) return { kind: 'notfound', status, message: clip(said || 'Not found.') };
    return { kind: 'badrequest', status, message: clip(said || 'The request was refused.') };
  }
  if (status === 429 || status === 503) return { kind: 'busy', status, message: clip(said || 'The instance is busy.') };
  if (status >= 500) return { kind: 'server', status, message: clip(said || 'The instance had an internal error.') };
  return { kind: 'error', status, message: clip(said || `Unexpected answer (${status}).`) };
}

/** The same classification for an Error thrown by src/content/tableApi.js (its messages are fixed wording). */
export function classifyThrown(err) {
  const message = String(err?.message ?? err ?? '');
  if (err?.code === 'SESSION_EXPIRED' || /session has expired|session token/i.test(message)) return { kind: /token/i.test(message) ? 'notoken' : 'session', status: 401, message };
  if (/\(403\)|not allowed|not authorized|insufficient rights/i.test(message)) return { kind: 'denied', status: 403, message: clip(message) };
  if (/invalid table/i.test(message)) return { kind: 'missing', status: 400, message: clip(message) };
  if (/\(404\)/.test(message)) return { kind: 'notfound', status: 404, message: clip(message) };
  if (/\(400\)/.test(message)) return { kind: 'badrequest', status: 400, message: clip(message) };
  if (/busy|\((429|503)\)/i.test(message)) return { kind: 'busy', status: 503, message: clip(message) };
  if (/\(5\d\d\)/.test(message)) return { kind: 'server', status: 500, message: clip(message) };
  if (/abort|timed out|timeout/i.test(message)) return { kind: 'timeout', status: 0, message: clip(message) };
  if (/failed to fetch|networkerror|load failed|network/i.test(message)) return { kind: 'network', status: 0, message: clip(message) };
  return { kind: 'error', status: 0, message: clip(message) };
}

/**
 * Plain words for an outcome: what happened and what to do about it.
 * @param {string} kind     from classifyHttp / classifyThrown
 * @param {{ what?: string, table?: string, status?: number, message?: string, ms?: number }} [ctx]
 * @returns {{ summary: string, action: string }}
 */
export function describeOutcome(kind, ctx = {}) {
  const what = ctx.what || (ctx.table ? `the table ${ctx.table}` : 'this');
  const server = ctx.message ? ` The instance said: ${ctx.message}` : '';
  switch (kind) {
    case 'ok':
      return { summary: ctx.ms ? `Answered in ${formatMs(ctx.ms)}.` : 'Answered.', action: '' };
    case 'session':
      return { summary: 'Your ServiceNow session has ended (the instance asked for a login).', action: 'Log in to the instance again, then run the self-check again.' };
    case 'denied':
      return { summary: `Your user is not allowed to read ${what} (403).${server}`, action: 'Ask an admin for a role that can read it. Tools that need it will show nothing for you.' };
    case 'missing':
      return { summary: `${ctx.table ? `Table ${ctx.table}` : 'The table'} does not exist on this instance.`, action: 'The plugin or release that adds it is not installed here. Tools that need it will not work on this instance.' };
    case 'notfound':
      return { summary: `${what} was not found on this instance (404).${server}`, action: 'This release or configuration does not offer it. The tools that use it fall back or show a note.' };
    case 'badrequest':
      return { summary: `The instance refused the request for ${what} (400).${server}`, action: 'Copy the report and send it to the NowBuddy developer: the request is probably wrong for this release.' };
    case 'busy':
      return { summary: `The instance was busy and did not answer for ${what} (${ctx.status || '429 or 503'}).`, action: 'Wait a minute and run the self-check again.' };
    case 'server':
      return { summary: `The instance had an internal error answering for ${what} (${ctx.status || 500}).${server}`, action: 'Run it again. If it repeats, check the instance health or the system log.' };
    case 'html':
      return { summary: 'The instance answered with a web page instead of data.', action: 'Reload the ServiceNow page and run the self-check again. A login, maintenance or proxy page may be in the way.' };
    case 'notoken':
      return { summary: 'The session token could not be read from the page, so no request was sent.', action: 'Reload the ServiceNow page and try again.' };
    case 'timeout':
      return { summary: `No answer for ${what} in time.`, action: 'The instance or your connection is slow. Run it again.' };
    case 'network':
      return { summary: `The request for ${what} did not reach the instance.${server}`, action: 'Check your connection or VPN, then run the self-check again.' };
    default:
      return { summary: `Unexpected result for ${what}.${server}`, action: 'Run it again. If it repeats, copy the report and send it to the NowBuddy developer.' };
  }
}

// ---- 2. The page, the release, the settings --------------------------------------------------------------------

/**
 * Which ServiceNow page layout the tab is on and whether NowBuddy's page tools can reach the form.
 * @param {{ pathname?: string, directFrame?: boolean, foundFrame?: boolean, frameReadable?: boolean|null, isTop?: boolean }} facts
 * @returns {{ kind: string, label: string, status: 'ok'|'warn', note: string }}
 */
export function classifyPage(facts = {}) {
  const path = String(facts.pathname || '/');
  const readable = facts.frameReadable !== false;
  if (/^\/now\/nav\/ui\//.test(path) || (/^\/now\//.test(path) && facts.foundFrame)) {
    if (facts.foundFrame && readable) return { kind: 'shell', label: 'Next Experience shell with the classic frame', status: 'ok', note: 'The classic content frame sits inside the shell (in a shadow root); NowBuddy finds it.' };
    if (facts.foundFrame) return { kind: 'shell-blocked', label: 'Next Experience shell, classic frame not readable', status: 'warn', note: 'The classic frame was found but the browser will not let the extension read it.' };
    return { kind: 'shell-noframe', label: 'Next Experience shell, no classic frame found', status: 'warn', note: 'Page tools (Page X-ray, field menus, the save guard) need the classic form. Table-based tools still work.' };
  }
  if (/^\/now\/(?:workspace|sow|cwf|hr|csm|sales|agent)/.test(path)) return { kind: 'workspace', label: 'Workspace page', status: 'warn', note: 'Workspaces do not use the classic form, so tools that read the form on screen are limited. Table-based tools still work. Open the record in the classic UI to use them all.' };
  if (/^\/(?:sp|esc|csm|ess|hrportal)(?:\/|\?|$)/.test(path)) return { kind: 'portal', label: 'Service Portal page', status: 'warn', note: 'On a portal page only the table-based tools and the portal inspector apply; form tools need the classic UI.' };
  if (facts.directFrame) return { kind: 'classic-frame', label: 'Classic UI with the content frame (gsft_main)', status: 'ok', note: 'The navigator and the content frame are both reachable.' };
  if (facts.isTop === false) return { kind: 'classic-inner', label: 'Inside the classic content frame', status: 'ok', note: '' };
  if (/\.do$|_list\.do$|\.do\?/.test(path) || /^\/(?:nav_to|navpage)\.do/.test(path)) return { kind: 'classic', label: 'Classic UI page', status: 'ok', note: '' };
  return { kind: 'other', label: 'A ServiceNow page that is not a record or a list', status: 'ok', note: 'Table-based tools work here. Page tools need a form or a list.' };
}

/** { family, patch, hotfix, date, tag, label } from the build properties. Every part may be ''. */
export function parseBuild(info = {}) {
  const tag = String(info.buildtag || info.tag || info.war || '').trim();
  const name = String(info.buildname || info.name || '').trim();
  const fromTag = /(?:^|[\s_-])glide-([a-z]+)-/i.exec(tag) || /^glide-([a-z]+)-/i.exec(tag);
  const raw = (fromTag ? fromTag[1] : name.split(/[\s-]/)[0]) || '';
  const family = raw ? raw[0].toUpperCase() + raw.slice(1).toLowerCase() : '';
  const patch = (/__patch(\d+)/i.exec(tag) || [])[1] || '';
  const hotfix = (/hotfix(\d+)/i.exec(tag) || [])[1] || '';
  const date = String(info.builddate || info.buildDate || '').trim() || ((/(\d{2}-\d{2}-\d{4})/.exec(tag) || [])[1] || '');
  const label = [family, patch ? `patch ${patch}` : '', hotfix ? `hotfix ${hotfix}` : ''].filter(Boolean).join(' ');
  return { family, patch, hotfix, date, tag, label };
}

/** The settings worth showing, by an allow-list: nothing that could be a key or a token ever gets in. */
export function summariseSettings(settings = {}) {
  const on = (v, fallback = true) => (v === undefined ? fallback : v !== false);
  const rows = [
    ['Sidebar', on(settings.sidebarEnabled) ? 'on' : 'off'],
    ['Command palette', on(settings.paletteEnabled) ? 'on' : 'off'],
    ['Tools open in', settings.toolSurface === 'sidebar' ? 'the sidebar' : 'floating windows'],
    ['Page tools (toolbar, field and list menus)', on(settings.inlineEnabled) ? 'on' : 'off'],
    ['Safety guards (production save guard, confirmations)', on(settings.guardsEnabled) ? 'on' : 'off'],
    ['Instance tag in the tab', on(settings.instanceTagEnabled) ? 'on' : 'off'],
    ['Show tools by role', on(settings.roleTiersEnabled) ? 'on' : 'off'],
  ];
  if (on(settings.roleTiersEnabled) && settings.developerRoles) rows.push(['Roles that count as developer', clip(settings.developerRoles, 120)]);
  rows.push(['AI agent', on(settings.agentEnabled) ? `on (${settings.agentAutonomy || 'ask'})` : 'off']);
  rows.push(['Local MCP bridge', settings.mcpBridgeEnabled ? 'on' : 'off']);
  return rows.map(([label, value]) => ({ label, value }));
}

// ---- 3. Building the checks ------------------------------------------------------------------------------------

/** { id, group, title, status, summary, action, details, ms } with every field present. */
export function makeCheck(id, group, title, status, summary, { action = '', details = [], ms = null, rerun = '' } = {}) {
  const check = { id, group, title, status, summary, action, details: details.filter(Boolean), ms: Number.isFinite(ms) ? Math.round(ms) : null };
  // rerun: the run option that would fill this check in ("scriptProbe"); the panel offers it as a button.
  if (rerun) check.rerun = rerun;
  return check;
}

/**
 * "This page": the extension, the layout, the page bridge, the session token, the settings.
 * @param {{ version?: string, host?: string, page?: object, bridge?: { ok: boolean, ms?: number, error?: string, hasUser?: boolean }, token?: { present: boolean, ms?: number }, settings?: object }} f
 */
export function pageChecks(f = {}) {
  const out = [];
  out.push(
    makeCheck('page.extension', 'page', 'NowBuddy on this page', 'ok', f.version ? `Version ${f.version} is running on ${f.host || 'this page'}.` : `Running on ${f.host || 'this page'}; the version could not be read from the manifest.`, {
      details: [f.version ? `Extension version: ${f.version}` : '', f.host ? `Host: ${f.host}` : ''],
    })
  );

  const layout = classifyPage(f.page || {});
  out.push(
    makeCheck('page.frame', 'page', 'Page layout', layout.status, layout.label, {
      action: layout.status === 'warn' ? layout.note : '',
      details: [layout.status === 'ok' ? layout.note : ''],
    })
  );

  const b = f.bridge || {};
  if (!b.ok) {
    out.push(
      makeCheck('page.bridge', 'page', 'Page bridge', 'fail', `The page bridge did not answer${b.error ? ` (${clip(b.error, 100)})` : ''}.`, {
        action: 'Reload this tab. If it keeps failing, the page blocks injected scripts: check that the extension has access to this site in chrome://extensions.',
        ms: b.ms,
      })
    );
  } else if (!b.hasUser) {
    out.push(makeCheck('page.bridge', 'page', 'Page bridge', 'warn', 'The page bridge answered, but this page has no signed-in user object (g_user).', { action: 'Open a normal ServiceNow page (a form or a list), then run the self-check again.', ms: b.ms }));
  } else {
    out.push(makeCheck('page.bridge', 'page', 'Page bridge', 'ok', `Answered in ${formatMs(b.ms)}.`, { ms: b.ms }));
  }

  const t = f.token || {};
  out.push(
    t.present
      ? makeCheck('page.token', 'page', 'Session token', 'ok', 'Found (the value is never shown).', { ms: t.ms })
      : makeCheck('page.token', 'page', 'Session token', 'fail', 'No session token could be read, so every request to the instance would be refused.', { action: 'Reload the page. If you see a login screen, sign in first.', ms: t.ms })
  );

  const rows = summariseSettings(f.settings || {});
  out.push(makeCheck('page.settings', 'page', 'Your NowBuddy settings', 'ok', `${rows.filter((r) => r.value === 'off').length ? 'Some options are off.' : 'Default options.'} No keys or tokens are shown or copied.`, { details: rows.map((r) => `${r.label}: ${r.value}`) }));
  return out;
}

/**
 * "You and the instance".
 * @param {{ session?: object|null, tier?: string|null, tiersOn?: boolean, impersonation?: { state: string, note?: string }, instance?: object, build?: { info?: object|null, source?: string, error?: string, ms?: number } }} f
 */
export function youChecks(f = {}) {
  const out = [];
  const s = f.session;
  if (!s) {
    out.push(makeCheck('you.identity', 'you', 'Who you are', 'warn', 'The page did not say who is signed in.', { action: 'Open a normal ServiceNow form or list and run the self-check again. Tools that depend on your roles show everything meanwhile.' }));
  } else {
    const roles = Array.isArray(s.roles) ? s.roles : null;
    const tier = f.tier || null;
    const tierText = !f.tiersOn ? 'role-based hiding of tools is off' : tier ? `tier "${tier}"` : 'tier unknown (roles unreadable), so every tool is shown';
    out.push(
      makeCheck('you.identity', 'you', 'Who you are', 'ok', `${roles ? plural(roles.length, 'role') : 'Roles unreadable'}, ${tierText}.`, {
        details: [
          `Admin: ${s.admin === true ? 'yes' : s.admin === false ? 'no' : 'unknown'}`,
          s.securityAdmin === true ? 'security_admin is elevated now' : s.securityAdmin === false ? 'security_admin is not elevated' : '',
          tier === 'user' ? 'Tools that read or change configuration, and the admin tools, are hidden for your roles.' : tier === 'developer' ? 'The admin-only tools are hidden for your roles.' : '',
        ],
      })
    );
  }

  const imp = f.impersonation || { state: 'unknown' };
  out.push(
    imp.state === 'active'
      ? makeCheck('you.impersonation', 'you', 'Impersonation', 'warn', 'You are impersonating another user (started from NowBuddy).', { action: 'Every check below ran as the impersonated user. End the impersonation to check as yourself.', details: [imp.note] })
      : makeCheck('you.impersonation', 'you', 'Impersonation', 'ok', imp.state === 'none' ? 'Not impersonating anyone (from NowBuddy).' : 'Could not tell.', {
          details: ['An impersonation started from the ServiceNow menu cannot be seen from here.'],
        })
  );

  const i = f.instance || {};
  const prod = i.env === 'prod' || i.tone === 'danger';
  // A host name that is not recognisably dev, test or stage is not "not production": NowBuddy treats it as production.
  const unsure = !prod && i.guarded === true;
  out.push(
    makeCheck('you.instance', 'you', 'Instance and environment', 'ok', `${i.host || 'This instance'}: ${i.label || 'no environment tag'}${prod ? ', looks like production' : unsure ? ', could be production (the name does not say)' : ''}.`, {
      details: [i.instance ? `Instance name: ${i.instance}` : '', i.label ? `Tag: ${i.label}` : '', `Looks like production: ${prod ? 'yes' : unsure ? 'cannot tell from the name, so it is treated as production' : 'no'}`, i.guarded ? 'Production safeguards apply to saves from NowBuddy.' : ''],
    })
  );

  const b = f.build || {};
  const parsed = b.info ? parseBuild(b.info) : null;
  if (parsed && (parsed.family || parsed.tag)) {
    const other = parsed.family && !CALIBRATED_ON.toLowerCase().startsWith(parsed.family.toLowerCase());
    out.push(
      makeCheck('you.build', 'you', 'ServiceNow release', other ? 'warn' : 'ok', parsed.label || parsed.tag, {
        action: other ? `NowBuddy was checked against ${CALIBRATED_ON}. This release may name tables or columns differently; the Tools section below shows what differs.` : '',
        details: [parsed.tag ? `Build tag: ${parsed.tag}` : '', parsed.date ? `Build date: ${parsed.date}` : '', b.source ? `Read from: ${b.source}` : ''],
        ms: b.ms,
      })
    );
  } else {
    out.push(makeCheck('you.build', 'you', 'ServiceNow release', 'warn', 'The release could not be read.', { action: 'Reading it needs the admin role (stats page) or read access to sys_properties. Nothing else depends on it; just tell the NowBuddy developer which release you run.', details: [b.error], ms: b.ms }));
  }
  return out;
}

const STATS_USED_BY = 'Used by: counts in Break this list down, Hot spots, the list tools and several panels.';

/**
 * "API access". `r` holds one outcome per probe: { kind, status, message, ms, ... } as classifyHttp returns it.
 * @param {object} r  { table, stats, group, pickers: { update, app }, script, dictionary, sessionExpired }
 */
export function apiChecks(r = {}) {
  const out = [];
  const skipped = (id, title, why) => makeCheck(id, 'api', title, 'skip', why || 'Not run because the session has ended.');
  const sessionGone = r.table?.kind === 'session';

  const t = r.table;
  if (!t) out.push(skipped('api.table', 'Table API (read)', 'Not run.'));
  else if (t.kind === 'ok') out.push(makeCheck('api.table', 'api', 'Table API (read)', 'ok', `A read answered in ${formatMs(t.ms)}.`, { ms: t.ms, details: ['Used by nearly every tool.'] }));
  else {
    const d = describeOutcome(t.kind, { what: 'the Table API', status: t.status, message: t.message });
    out.push(makeCheck('api.table', 'api', 'Table API (read)', 'fail', d.summary, { action: d.action, ms: t.ms }));
  }

  const s = r.stats;
  if (sessionGone) out.push(skipped('api.stats', 'Stats API (counts)'));
  else if (!s) out.push(skipped('api.stats', 'Stats API (counts)', 'Not run.'));
  else if (s.kind === 'ok' && s.countOk !== false) out.push(makeCheck('api.stats', 'api', 'Stats API (counts)', 'ok', `A count answered in ${formatMs(s.ms)}.`, { ms: s.ms, details: [STATS_USED_BY] }));
  else if (s.kind === 'ok') out.push(makeCheck('api.stats', 'api', 'Stats API (counts)', 'warn', 'The Stats API answered, but not with a count.', { action: 'Counts shown by NowBuddy may be missing. Copy the report and send it to the NowBuddy developer.', ms: s.ms }));
  else {
    const d = describeOutcome(s.kind, { what: 'the Stats API', status: s.status, message: s.message });
    out.push(makeCheck('api.stats', 'api', 'Stats API (counts)', 'warn', d.summary, { action: `${d.action} ${s.kind === 'denied' || s.kind === 'notfound' ? 'Counts and breakdowns will be missing in NowBuddy.' : ''}`.trim(), ms: s.ms, details: [STATS_USED_BY] }));
  }

  const g = r.group;
  if (sessionGone) out.push(skipped('api.group', 'Stats API (group by)'));
  else if (!g) out.push(skipped('api.group', 'Stats API (group by)', 'Not run.'));
  else if (g.kind === 'ok' && g.groupsOk !== false) out.push(makeCheck('api.group', 'api', 'Stats API (group by)', 'ok', `A grouped count answered in ${formatMs(g.ms)}.`, { ms: g.ms, details: ['Used by: Break this list down and Hot spots.'] }));
  else if (g.kind === 'ok') out.push(makeCheck('api.group', 'api', 'Stats API (group by)', 'warn', 'The Stats API answered, but not with groups.', { action: 'Break this list down and Hot spots may show no bars. Copy the report and send it to the NowBuddy developer.', ms: g.ms }));
  else {
    const d = describeOutcome(g.kind, { what: 'the grouped Stats API', status: g.status, message: g.message });
    out.push(makeCheck('api.group', 'api', 'Stats API (group by)', 'warn', d.summary, { action: d.action, ms: g.ms }));
  }

  const dict = r.dictionary;
  if (sessionGone) out.push(skipped('api.dictionary', 'Dictionary (tables and columns)'));
  else if (!dict) out.push(skipped('api.dictionary', 'Dictionary (tables and columns)', 'Not run.'));
  else if (dict.dbObject === 'ok' && dict.dictionary === 'ok') {
    out.push(makeCheck('api.dictionary', 'api', 'Dictionary (tables and columns)', dict.truncated ? 'warn' : 'ok', dict.truncated ? 'Readable, but the column list was cut off, so some columns could not be checked.' : `sys_db_object and sys_dictionary are readable (${plural(dict.tables || 0, 'table')} looked up).`, { ms: dict.ms, details: ['Used to tell a missing column from an empty one.'] }));
  } else {
    const which = [dict.dbObject !== 'ok' ? 'sys_db_object' : '', dict.dictionary !== 'ok' ? 'sys_dictionary' : ''].filter(Boolean).join(' and ');
    out.push(
      makeCheck('api.dictionary', 'api', 'Dictionary (tables and columns)', 'warn', `${which} could not be read, so table and column names cannot be checked against the dictionary.`, {
        action: 'The check falls back to reading one row of each table; a table with no rows cannot be fully checked. Table explorer, Page X-ray and the field tools also need the dictionary.',
        ms: dict.ms,
      })
    );
  }

  const p = r.pickers;
  if (sessionGone) out.push(skipped('api.pickers', 'Update set and scope pickers'));
  else if (!p) out.push(skipped('api.pickers', 'Update set and scope pickers', 'Not run.'));
  else {
    const bad = [p.update && p.update.kind !== 'ok' ? 'update set picker' : '', p.app && p.app.kind !== 'ok' ? 'application picker' : ''].filter(Boolean);
    const unreadable = [p.update && p.update.kind === 'ok' && p.update.hasCurrent === false ? 'update set' : '', p.app && p.app.kind === 'ok' && p.app.hasCurrent === false ? 'application' : ''].filter(Boolean);
    if (!bad.length && !unreadable.length) out.push(makeCheck('api.pickers', 'api', 'Update set and scope pickers', 'ok', 'Both pickers answered with your current update set and application.', { ms: Math.max(p.update?.ms || 0, p.app?.ms || 0), details: ['Used by: My work, Ship check and the update set and scope switchers.'] }));
    else out.push(makeCheck('api.pickers', 'api', 'Update set and scope pickers', 'warn', bad.length ? `The ${bad.join(' and ')} did not answer.` : `The pickers answered without a current ${unreadable.join(' or ')}.`, { action: 'My work and the update set switchers fall back to your saved preferences, which can be out of date.', ms: Math.max(p.update?.ms || 0, p.app?.ms || 0) }));
  }

  const sc = r.script;
  if (!sc) out.push(skipped('api.script', 'Background script endpoint', 'Not run.'));
  else if (sc.kind === 'skipped') out.push(makeCheck('api.script', 'api', 'Background script endpoint', 'skip', sc.message || 'Not run.', { action: sc.action || '', rerun: sc.productionSkip ? 'scriptProbe' : '' }));
  else if (sc.kind === 'ok') out.push(makeCheck('api.script', 'api', 'Background script endpoint', sc.printed === false ? 'warn' : 'ok', sc.printed === false ? 'The endpoint ran the probe but its output was empty.' : `A one-line read-only script ran in ${formatMs(sc.ms)}.`, { ms: sc.ms, action: sc.printed === false ? 'The Access debugger runtime check and test runs may show no output. Copy the report and send it to the NowBuddy developer.' : '', details: ['Used by: the script runner, the Access debugger runtime check, Test kit runs.'] }));
  else {
    const refused = sc.kind === 'denied';
    out.push(
      makeCheck('api.script', 'api', 'Background script endpoint', 'warn', refused ? 'The instance refused to run a background script for your user.' : describeOutcome(sc.kind, { what: 'the background script endpoint', status: sc.status, message: sc.message }).summary, {
        action: refused ? 'Background scripts need the admin role (and security_admin on some releases). The script runner, the Access debugger runtime check and Test kit runs will not work for you.' : describeOutcome(sc.kind, { status: sc.status }).action,
        ms: sc.ms,
      })
    );
  }
  return out;
}

/** The one script the Self-check can run (the background script endpoint check): it prints a marker and does nothing else. */
export const SCRIPT_PROBE_MARKER = 'NOWBUDDY_SELFCHECK_OK';
export const SCRIPT_PROBE = `gs.print('${SCRIPT_PROBE_MARKER}');`;

/**
 * The confirmation before the script check runs on an instance where it is not run on its own (production, or one
 * NowBuddy cannot place). `instance` is the result's instance ({ host, looksProduction }).
 */
export function scriptProbeAsk(instance = {}) {
  const host = instance.host || 'this instance';
  return {
    title: `Run the script check on ${host}?`,
    message: `${instance.looksProduction ? `${host} looks like production.` : `NowBuddy cannot tell whether ${host} is production.`} The check runs one line through the background script page. It changes no data, but the run is recorded in the instance's script history, as any background script is.`,
    details: SCRIPT_PROBE,
    confirmLabel: 'Run the check',
    danger: true,
  };
}

// ---- 4. Requirements: which tools have what they need ----------------------------------------------------------

/** Problems with the shape of a requirement list, one string each (the unit test asserts there are none). */
export function validateRequirements(list, label = 'requirements') {
  const problems = [];
  if (!Array.isArray(list)) return [`${label}: not an array`];
  list.forEach((e, i) => {
    const at = `${label}[${i}]${e && e.feature ? ` (${e.feature})` : ''}`;
    if (!e || typeof e !== 'object') return problems.push(`${at}: not an object`);
    if (typeof e.feature !== 'string' || !e.feature.trim()) problems.push(`${at}: feature must be a non-empty string`);
    if (typeof e.table !== 'string' || !TABLE_RE.test(e.table)) problems.push(`${at}: table "${e.table}" is not a table name`);
    if (!Array.isArray(e.columns)) problems.push(`${at}: columns must be an array`);
    else {
      e.columns.forEach((c) => {
        if (typeof c !== 'string' || !COLUMN_RE.test(c)) problems.push(`${at}: column "${c}" is not a column name`);
      });
    }
    if (e.optional !== undefined && typeof e.optional !== 'boolean') problems.push(`${at}: optional must be true or false`);
    if (e.fallbackFor !== undefined && (typeof e.fallbackFor !== 'string' || !TABLE_RE.test(e.fallbackFor))) problems.push(`${at}: fallbackFor must be a table name`);
    if (e.alternates !== undefined && (!Array.isArray(e.alternates) || e.alternates.some((c) => typeof c !== 'string' || !COLUMN_RE.test(c)))) problems.push(`${at}: alternates must be an array of column names`);
    if (e.optionalColumns !== undefined) {
      if (!Array.isArray(e.optionalColumns) || e.optionalColumns.some((c) => typeof c !== 'string' || !COLUMN_RE.test(c))) problems.push(`${at}: optionalColumns must be an array of column names`);
    }
    if (e.note !== undefined && typeof e.note !== 'string') problems.push(`${at}: note must be a string`);
    if (e.panel !== undefined && typeof e.panel !== 'string') problems.push(`${at}: panel must be a string`);
  });
  return problems;
}

const baseColumn = (column) => String(column).split('.')[0];

/**
 * One merged table requirement per feature and table. A column is optional when its entry is optional or it is listed
 * in optionalColumns; a column that is required anywhere stays required. Malformed entries are dropped.
 * @returns {Array<{ feature: string, panel: string, tables: Array<{ table: string, optional: boolean, required: string[], optionalColumns: string[], notes: string[] }> }>}
 */
export function groupByFeature(list) {
  const features = new Map();
  (Array.isArray(list) ? list : []).forEach((e) => {
    if (validateRequirements([e]).length) return;
    const feature = e.feature.trim();
    if (!features.has(feature)) features.set(feature, { feature, panel: '', tables: new Map() });
    const f = features.get(feature);
    if (e.panel && !f.panel) f.panel = e.panel;
    if (!f.tables.has(e.table)) f.tables.set(e.table, { table: e.table, optional: true, fallbackFor: '', required: new Set(), optionalColumns: new Set(), notes: [] });
    const t = f.tables.get(e.table);
    if (!e.optional) t.optional = false;
    if (e.fallbackFor && !t.fallbackFor) t.fallbackFor = e.fallbackFor;
    (e.columns || []).forEach((c) => (e.optional ? t.optionalColumns.add(c) : t.required.add(c)));
    (e.optionalColumns || []).forEach((c) => t.optionalColumns.add(c));
    if (e.note && !t.notes.includes(e.note)) t.notes.push(e.note);
  });
  return [...features.values()].map((f) => ({
    feature: f.feature,
    panel: f.panel,
    tables: [...f.tables.values()].map((t) => ({
      table: t.table,
      optional: t.optional,
      fallbackFor: t.fallbackFor,
      required: [...t.required],
      optionalColumns: [...t.optionalColumns].filter((c) => !t.required.has(c)),
      notes: t.notes,
    })),
  }));
}

/** Every table that needs looking at and the base columns wanted from each (system columns left out). */
export function planTables(list) {
  const columns = new Map();
  groupByFeature(list).forEach((f) =>
    f.tables.forEach((t) => {
      if (!columns.has(t.table)) columns.set(t.table, new Set());
      [...t.required, ...t.optionalColumns].map(baseColumn).filter((c) => !UNIVERSAL.has(c)).forEach((c) => columns.get(t.table).add(c));
    })
  );
  const tables = [...columns.keys()].sort();
  return { tables, columns: Object.fromEntries(tables.map((t) => [t, [...columns.get(t)].sort()])) };
}

/** The distinct column names wanted anywhere, for one batched dictionary query. */
export function wantedColumns(plan) {
  return [...new Set(Object.values(plan.columns).flat())].sort();
}

/** table -> parent table ('' for none) from sys_db_object rows { name, 'super_class.name' }. */
export function parseDbObjectRows(rows, into = new Map()) {
  (rows || []).forEach((r) => {
    const name = flat(r?.name);
    if (!name) return;
    const parent = flat(r['super_class.name'] ?? r.super_class_name ?? '');
    into.set(name, /^[a-z][a-z0-9_]*$/.test(parent) ? parent : '');
  });
  return into;
}

/** Parent tables seen in `parents` that have not been asked about yet. */
export function unaskedParents(parents, asked) {
  return [...new Set([...parents.values()].filter((p) => p && !asked.has(p)))].sort();
}

/** table -> Set of columns from sys_dictionary rows { name, element }. */
export function parseDictionaryRows(rows, into = new Map()) {
  (rows || []).forEach((r) => {
    const name = flat(r?.name);
    const element = flat(r?.element);
    if (!name || !element) return;
    if (!into.has(name)) into.set(name, new Set());
    into.get(name).add(element);
  });
  return into;
}

function flat(value) {
  if (value && typeof value === 'object') return String(value.value ?? value.display_value ?? '');
  return value === undefined || value === null ? '' : String(value);
}

/** The table and its parents, nearest first. Stops at a cycle or at MAX_DEPTH. */
export function chainOf(parents, table) {
  const chain = [];
  let current = table;
  while (current && !chain.includes(current) && chain.length < MAX_DEPTH) {
    chain.push(current);
    current = parents.get(current) || '';
  }
  return chain;
}

/**
 * What the dictionary says, in a shape the evaluation can ask questions of.
 * @param {{ parents: Map<string,string>, columns: Map<string,Set<string>>, dbObject?: string, dictionary?: string, truncated?: boolean }} s
 */
export function makeSchema(s = {}) {
  return {
    parents: s.parents || new Map(),
    columns: s.columns || new Map(),
    dbObject: s.dbObject || 'unread', // ok | denied | missing | session | error | unread
    dictionary: s.dictionary || 'unread',
    truncated: Boolean(s.truncated),
  };
}

/** 'yes' | 'no' | 'unknown': does the table exist, going by sys_db_object. */
export function tableExists(schema, table) {
  if (schema.dbObject !== 'ok') return 'unknown';
  return schema.parents.has(table) ? 'yes' : 'no';
}

/**
 * Is the column defined on the table or on any parent (dictionary entries are inherited: a column on task is on
 * incident)? 'yes' (with definedOn) | 'no' | 'unknown' (dictionary unreadable, cut off, or the table is not known).
 */
export function columnDefined(schema, table, column) {
  const name = baseColumn(column);
  if (UNIVERSAL.has(name)) return { state: 'yes', definedOn: '' };
  if (schema.dictionary !== 'ok' || schema.dbObject !== 'ok' || !schema.parents.has(table)) return { state: 'unknown', definedOn: '' };
  for (const t of chainOf(schema.parents, table)) {
    if (schema.columns.get(t)?.has(name)) return { state: 'yes', definedOn: t };
  }
  return { state: schema.truncated ? 'unknown' : 'no', definedOn: '' };
}

/**
 * One column of one table: ok | missing | hidden | unverified.
 * hidden = the dictionary has it but a sampled row from the Table API did not include it (a field ACL, usually).
 */
export function columnState(schema, probe, table, column) {
  const name = baseColumn(column);
  if (UNIVERSAL.has(name)) return { state: 'ok', definedOn: '' };
  const defined = columnDefined(schema, table, name);
  // A sampled row only speaks for the columns that were asked for (large and secret ones are left out of the request).
  const asked = Array.isArray(probe?.requestedKeys) ? probe.requestedKeys : null;
  const sample = probe?.kind === 'ok' && Array.isArray(probe.sampleKeys) && probe.sampleKeys.length && (!asked || asked.includes(name)) ? probe.sampleKeys : null;
  if (defined.state === 'yes') return sample && !sample.includes(name) ? { state: 'hidden', definedOn: defined.definedOn } : { state: 'ok', definedOn: defined.definedOn };
  if (defined.state === 'no') return { state: 'missing', definedOn: '' };
  // The dictionary could not say: a sampled row is the only evidence left.
  if (sample) return sample.includes(name) ? { state: 'ok', definedOn: '' } : { state: 'missing', definedOn: '' };
  return { state: 'unverified', definedOn: '' };
}

/** A few words for why a read did not answer, for "could not be read: ...". */
export function shortReason(kind, status) {
  switch (kind) {
    case 'busy':
      return `the instance was busy (${status || '429 or 503'})`;
    case 'server':
      return `the instance had an internal error (${status || 500})`;
    case 'timeout':
      return 'no answer in time';
    case 'network':
      return 'the request did not reach the instance';
    case 'html':
      return 'a web page came back instead of data';
    case 'notoken':
      return 'no session token';
    case 'badrequest':
      return `the instance refused the request (${status || 400})`;
    case 'notfound':
      return `not found (${status || 404})`;
    default:
      return 'an unexpected answer';
  }
}

/** { state: ok | missing | denied | unknown, detail } for a table: the dictionary first, then the read probe. */
export function tableState(ctx, table) {
  if (ctx.sessionExpired) return { state: 'unknown', detail: 'Not checked: the session has ended.' };
  const exists = tableExists(ctx.schema, table);
  if (exists === 'no') return { state: 'missing', detail: `${table} does not exist on this instance.` };
  const probe = ctx.probes?.[table];
  if (!probe) return { state: 'unknown', detail: `${table} was not read.` };
  switch (probe.kind) {
    case 'ok':
      return { state: 'ok', detail: '' };
    case 'missing':
      return { state: 'missing', detail: `${table} does not exist on this instance.` };
    case 'denied':
      return { state: 'denied', detail: `Your user cannot read ${table} (403).` };
    case 'session':
      return { state: 'unknown', detail: 'Not checked: the session has ended.' };
    default:
      return { state: 'unknown', detail: `${table} could not be read: ${shortReason(probe.kind, probe.status)}.` };
  }
}

/** What to do about one problem, by its kind. */
export function problemAdvice(kind) {
  switch (kind) {
    case 'table-missing':
      return 'The plugin or release that adds this table is not on this instance. If the table has another name on your release, send the report to the NowBuddy developer.';
    case 'table-denied':
      return 'Your roles cannot read this table. Ask an admin for a role that can, or sign in as someone who can.';
    case 'column-missing':
      return 'This release names or stores it differently. Send the report to the NowBuddy developer so the tool can be fixed for your release.';
    case 'column-hidden':
      return 'A field ACL (or a column type the Table API does not return) keeps it from your user. The tool will show it blank.';
    default:
      return 'Run the self-check again. If it repeats, send the report to the NowBuddy developer.';
  }
}

const STATUS_RANK = { broken: 3, gaps: 2, unverified: 1, ok: 0 };

/**
 * Per feature: ok | gaps | broken | unverified, with the exact tables and columns behind it.
 * @param {Array} list    requirement entries (src/lib/requirements)
 * @param {{ schema: object, probes: Object<string, { kind: string, status?: number, sampleKeys?: string[] }>, sessionExpired?: boolean }} ctx
 */
export function evaluateTools(list, ctx) {
  const context = { schema: makeSchema(ctx?.schema), probes: ctx?.probes || {}, sessionExpired: Boolean(ctx?.sessionExpired) };
  return groupByFeature(list).map((f) => {
    const problems = [];
    const tables = f.tables.map((t) => {
      const ts = tableState(context, t.table);
      const row = { table: t.table, optional: t.optional, note: t.notes.join(' '), state: ts.state, detail: ts.detail, columns: [] };
      const level = t.optional ? 'gap' : 'blocking';
      // A table the tool reads only when another cannot be read is no gap while that other one is readable.
      if ((ts.state === 'missing' || ts.state === 'denied') && t.fallbackFor && tableState(context, t.fallbackFor).state === 'ok') {
        row.state = 'unused';
        row.detail = `Not needed: ${t.fallbackFor} can be read, and this is only read when it cannot.`;
        return row;
      }
      if (ts.state === 'missing' || ts.state === 'denied') {
        problems.push({ level, kind: ts.state === 'missing' ? 'table-missing' : 'table-denied', table: t.table, column: '', text: ts.detail });
        return row;
      }
      if (ts.state === 'unknown') {
        problems.push({ level: 'unverified', kind: 'table-unknown', table: t.table, column: '', text: ts.detail });
        return row;
      }
      const probe = context.probes[t.table];
      const check = (column, optional) => {
        const cs = columnState(context.schema, probe, t.table, column);
        row.columns.push({ name: column, optional, state: cs.state, definedOn: cs.definedOn });
        if (cs.state === 'missing') {
          const cannotSay = context.schema.dictionary !== 'ok' || context.schema.dbObject !== 'ok';
          problems.push({ level: optional ? 'gap' : 'blocking', kind: 'column-missing', table: t.table, column, text: `${t.table}.${column} is not a column on this instance${cannotSay ? ' (or your user cannot read it): the dictionary was not readable, so this comes from a sampled row' : ''}.` });
        } else if (cs.state === 'hidden') {
          problems.push({ level: 'gap', kind: 'column-hidden', table: t.table, column, text: `${t.table}.${column} is defined, but the instance did not return it for your user (a field ACL, or a column type the Table API leaves out).` });
        } else if (cs.state === 'unverified') {
          problems.push({ level: 'unverified', kind: 'column-unverified', table: t.table, column, text: `${t.table}.${column} could not be checked (the dictionary could not be read and the table had no rows to sample).` });
        }
      };
      t.required.forEach((c) => check(c, t.optional));
      t.optionalColumns.forEach((c) => check(c, true));
      return row;
    });

    const blocking = problems.filter((p) => p.level === 'blocking');
    const gaps = problems.filter((p) => p.level === 'gap');
    const unverified = problems.filter((p) => p.level === 'unverified');
    let status = 'ok';
    let summary = 'Has everything it reads.';
    if (blocking.length) {
      status = 'broken';
      summary = `Will not work: ${blocking[0].text}${blocking.length > 1 ? ` (and ${plural(blocking.length - 1, 'more problem')})` : ''}`;
    } else if (gaps.length) {
      status = 'gaps';
      summary = `Works, with gaps: ${gaps[0].text}${gaps.length > 1 ? ` (and ${plural(gaps.length - 1, 'more')})` : ''}`;
    } else if (unverified.length) {
      status = 'unverified';
      summary = `Not fully checked: ${unverified[0].text}${unverified.length > 1 ? ` (and ${plural(unverified.length - 1, 'more')})` : ''}`;
    }
    return { feature: f.feature, panel: f.panel, status, summary, tables, problems };
  });
}

/** Broken first, then gaps, unverified, ok; alphabetical inside a group. */
export function sortTools(tools) {
  return [...tools].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.feature.localeCompare(b.feature));
}

export function countTools(tools) {
  const counts = { total: tools.length, ok: 0, gaps: 0, broken: 0, unverified: 0 };
  tools.forEach((t) => {
    counts[t.status] = (counts[t.status] || 0) + 1;
  });
  return counts;
}

/** "table.column" lines for everything missing, split by whether the tool needs it. For the report and the panel. */
export function missingList(tools) {
  const required = [];
  const optional = [];
  tools.forEach((tool) =>
    tool.problems
      .filter((p) => p.kind !== 'table-unknown' && p.kind !== 'column-unverified')
      .forEach((p) => {
        const name = p.column ? `${p.table}.${p.column}` : p.table;
        const entry = { name, kind: p.kind, feature: tool.feature };
        (p.level === 'blocking' ? required : optional).push(entry);
      })
  );
  return { required, optional };
}

/**
 * The same problem seen by several tools is one cause: "sys_security_acl cannot be read" is one line that explains
 * fifteen tools. Blocking causes first, then the ones that touch most tools.
 * @returns {Array<{ kind: string, table: string, column: string, text: string, advice: string, blocking: boolean, features: string[] }>}
 */
export function rootCauses(tools) {
  const causes = new Map();
  tools.forEach((tool) =>
    tool.problems.forEach((p) => {
      const key = `${p.kind}|${p.table}|${p.column}`;
      if (!causes.has(key)) causes.set(key, { kind: p.kind, table: p.table, column: p.column, text: p.text, advice: problemAdvice(p.kind), blocking: false, features: [] });
      const cause = causes.get(key);
      if (p.level === 'blocking') cause.blocking = true;
      if (!cause.features.includes(tool.feature)) cause.features.push(tool.feature);
    })
  );
  return [...causes.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.features.length - a.features.length || `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

// ---- 5. The verdict --------------------------------------------------------------------------------------------

// A failure here means NowBuddy cannot read the instance at all; anything else is a gap in one tool.
const CORE = new Set(['page.bridge', 'page.token', 'api.table']);

/**
 * The traffic light: red when NowBuddy cannot work on this page at all, amber when something is off or some tool
 * lacks what it needs, green when every check passed.
 * @returns {{ status: 'ok'|'warn'|'fail', headline: string, detail: string }}
 */
export function overallStatus(checks, tools) {
  const counts = countTools(tools);
  const core = checks.filter((c) => CORE.has(c.id) && c.status === 'fail');
  if (core.length) {
    const sessionGone = checks.some((c) => c.id === 'api.table' && /session has ended/i.test(c.summary));
    return {
      status: 'fail',
      headline: sessionGone ? 'Your session has ended: NowBuddy cannot read the instance.' : 'NowBuddy cannot read this instance from this page.',
      detail: `${core[0].title}: ${core[0].summary}${core[0].action ? ` ${core[0].action}` : ''}`,
    };
  }
  const warned = checks.filter((c) => c.status === 'warn' || c.status === 'fail');
  const parts = [];
  if (counts.broken) parts.push(`${plural(counts.broken, 'tool')} will not work here`);
  if (counts.gaps) parts.push(`${plural(counts.gaps, 'tool')} work${counts.gaps === 1 ? 's' : ''} with gaps`);
  if (counts.unverified) parts.push(`${plural(counts.unverified, 'tool')} could not be fully checked`);
  if (warned.length) parts.push(`${plural(warned.length, 'check')} to look at`);
  if (!parts.length) return { status: 'ok', headline: `Everything checked is fine: ${plural(counts.total, 'tool')} have what they need.`, detail: '' };
  return { status: 'warn', headline: `${parts[0][0].toUpperCase()}${parts[0].slice(1)}${parts.length > 1 ? '; ' : '.'}${parts.slice(1).join('; ')}${parts.length > 1 ? '.' : ''}`, detail: `${counts.ok} of ${counts.total} tools are fine.` };
}

/** The structured result of a whole run (also what doctorRun returns to an AI agent). Plain data only. */
export function assembleResult({ startedAt, finishedAt, extension = {}, instance = {}, page = {}, user = {}, checks = [], tools = [], schema = null, requests = 0, notes = [], slowest = [] }) {
  const sorted = sortTools(tools);
  return {
    resultVersion: RESULT_VERSION,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
    extension: { name: 'NowBuddy', version: extension.version || '' },
    instance: { host: instance.host || '', instance: instance.instance || '', label: instance.label || '', env: instance.env || '', looksProduction: Boolean(instance.looksProduction), release: instance.release || '', family: instance.family || '', buildTag: instance.buildTag || '' },
    page: { kind: page.kind || '', label: page.label || '' },
    user: { tier: user.tier || null, roleCount: Number.isFinite(user.roleCount) ? user.roleCount : null, admin: user.admin ?? null },
    checks,
    tools: sorted,
    counts: countTools(sorted),
    missing: missingList(sorted),
    causes: rootCauses(sorted),
    schema: schema ? { dbObject: schema.dbObject, dictionary: schema.dictionary, tablesLooked: schema.tablesLooked ?? 0, truncated: Boolean(schema.truncated) } : null,
    requests,
    slowest: slowest.filter((s) => s && s.table && Number.isFinite(s.ms)).slice(0, 5),
    notes,
    overall: overallStatus(checks, sorted),
  };
}

// ---- 6. The report ---------------------------------------------------------------------------------------------

const STATUS_WORD = { ok: 'OK', warn: 'Look', fail: 'Problem', skip: 'Not run' };
const TOOL_WORD = { ok: 'OK', gaps: 'Works with gaps', broken: 'Will not work', unverified: 'Not fully checked' };
const cell = (text) => String(text ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();

/**
 * A Markdown report to paste into a ticket or a message. It names versions, tiers, statuses, tables, columns and
 * timings; it never contains a token, a key, a user name or a record value.
 */
export function buildReport(result) {
  const r = result;
  const lines = [];
  const when = String(r.startedAt || '').replace('T', ' ').slice(0, 16);
  lines.push('# NowBuddy self-check', '');
  lines.push(`- Verdict: **${{ ok: 'Green', warn: 'Amber', fail: 'Red' }[r.overall.status] || r.overall.status}** - ${r.overall.headline}`);
  lines.push(`- Run: ${when} UTC, ${formatMs(r.durationMs)}, ${plural(r.requests || 0, 'request')}`);
  lines.push(`- Extension: ${r.extension.name} ${r.extension.version || '(version unknown)'}`);
  lines.push(`- Instance: ${r.instance.host || 'unknown'}${r.instance.label ? ` (${r.instance.label}${r.instance.looksProduction ? ', looks like production' : ''})` : ''}`);
  lines.push(`- ServiceNow release: ${r.instance.release || 'not readable'}${r.instance.buildTag ? ` (${r.instance.buildTag})` : ''}; NowBuddy was checked against ${CALIBRATED_ON}`);
  lines.push(`- Page: ${r.page.label || 'unknown'}`);
  lines.push(`- You: tier ${r.user.tier || 'unknown'}, ${r.user.roleCount === null ? 'roles unreadable' : plural(r.user.roleCount, 'role')}, admin ${r.user.admin === true ? 'yes' : r.user.admin === false ? 'no' : 'unknown'}`);
  if (r.schema) lines.push(`- Dictionary: sys_db_object ${r.schema.dbObject}, sys_dictionary ${r.schema.dictionary}, ${plural(r.schema.tablesLooked, 'table')} looked up${r.schema.truncated ? ' (column list cut off)' : ''}`);
  lines.push(`- Tools: ${r.counts.ok} OK, ${r.counts.gaps} with gaps, ${r.counts.broken} will not work, ${r.counts.unverified} not fully checked (of ${r.counts.total})`);
  if (r.slowest?.length) lines.push(`- Slowest table reads: ${r.slowest.map((s) => `${s.table} ${formatMs(s.ms)}`).join(', ')}`);
  (r.notes || []).forEach((n) => lines.push(`- Note: ${n}`));

  lines.push('', '## Checks', '', '| Check | Result | Time | What happened |', '| --- | --- | --- | --- |');
  r.checks.forEach((c) => lines.push(`| ${cell(c.title)} | ${STATUS_WORD[c.status] || c.status} | ${c.ms === null ? '' : formatMs(c.ms)} | ${cell(c.summary)}${c.action && c.status !== 'ok' ? ` To do: ${cell(c.action)}` : ''} |`));

  if (r.causes?.length) {
    lines.push('', `## Causes (${r.causes.length})`, '', 'One line per problem, with every tool it touches. Blocking ones come first.', '');
    r.causes.forEach((c) => {
      const name = c.column ? `\`${c.table}.${c.column}\`` : `\`${c.table}\``;
      lines.push(`- ${c.blocking ? '[blocks] ' : ''}${name} - ${c.text} Affects ${plural(c.features.length, 'tool')}: ${c.features.join(', ')}.`);
    });
  }

  const broken = r.tools.filter((t) => t.status === 'broken');
  const gaps = r.tools.filter((t) => t.status === 'gaps');
  const unverified = r.tools.filter((t) => t.status === 'unverified');
  const nameOf = (p) => (p.column ? `\`${p.table}.${p.column}\`` : `\`${p.table}\``);
  if (broken.length) {
    lines.push('', `## Tools that will not work here (${broken.length})`, '');
    broken.forEach((t) => {
      lines.push(`- **${t.feature}**`);
      t.problems.forEach((p) => lines.push(`  - ${p.level === 'blocking' ? 'needs' : p.level === 'gap' ? 'optional' : 'unchecked'}: ${nameOf(p)} - ${p.text}`));
    });
  }
  const brief = (title, tools, label) => {
    if (!tools.length) return;
    lines.push('', `## ${title} (${tools.length})`, '');
    tools.forEach((t) => lines.push(`- **${t.feature}** - ${label}: ${t.problems.map(nameOf).join(', ')}`));
  };
  brief('Tools that work with gaps', gaps, 'optional or hidden');
  brief('Tools that could not be fully checked', unverified, 'unchecked');

  lines.push('', '## All tools', '', '| Tool | Status | Tables read |', '| --- | --- | --- |');
  r.tools.forEach((t) => lines.push(`| ${cell(t.feature)} | ${TOOL_WORD[t.status] || t.status} | ${cell(t.tables.map((x) => x.table).join(', '))} |`));

  lines.push('', '_Generated by the NowBuddy Self-check. It contains no tokens, keys, user names or record values._', '');
  return lines.join('\n');
}

// ---- 7. Where a tool opens from -------------------------------------------------------------------------------

/**
 * Registry panel names for features whose requirement entries do not name one. A feature that is not a registered
 * panel (Code search, Versions...) lists the slash command that opens it instead.
 */
export const FEATURE_OPEN = {
  'What went wrong?': { panel: 'failures' },
  'Hot spots': { panel: 'hotspots' },
  'What changed lately?': { panel: 'recent' },
  'Release notes': { panel: 'releasenotes' },
  'Save trace': { panel: 'savetrace' },
  "Why didn't my rule run?": { panel: 'whyrule' },
  'Break this list down': { panel: 'insight' },
  'What points at this record?': { panel: 'refs' },
  'Page X-ray': { panel: 'xray' },
  'Access debugger': { panel: 'access' },
  'Health scan': { panel: 'health' },
  'Change impact': { panel: 'impact' },
  'Where is this field used?': { panel: 'fieldusage' },
  'History of a field': { panel: 'fieldhistory' },
  'Compare with another record': { panel: 'recordcompare' },
  Test: { panel: 'testkit' },
  'Test data': { panel: 'testdata' },
  'Code search': { slash: '/search' },
  'Version history': { slash: '/versions' },
  'Table explorer': { slash: '/fields' },
  'Live log': { slash: '/tail' },
  'Triage errors': { slash: '/logs' },
  'Email tracer': { panel: 'notify' },
  'Go to anything': { slash: 'Ctrl+Shift+Space' },
  'Update sets': { slash: '/updateset' },
  'My work': { panel: 'mywork' },
  'Ship check': { panel: 'shipcheck' },
};
