const test = require('node:test');
const assert = require('node:assert/strict');

const {
  serialize,
  isSecretKey,
  validateTarget,
  findTargetElement,
  classifyPage,
  urlParams,
  discoverWidgets,
  widgetAt,
  widgetLabel,
  matchWidgets,
  placementLabel,
  widgetLinks,
  analyzeWidget,
  parseOptionSchema,
  annotateOptions,
  diffValues,
  diffSummary,
  jsonText,
  isMarker,
  LIMITS,
  MARK,
} = require('../src/lib/portalInspector.js');
const scope = require('../src/lib/portalScope.js');

// ---- A tiny fake DOM: just enough tree for discovery and for finding a widget again ---------------------------

class El {
  constructor(tag, { id = '', classes = [], children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = classes;
    this.children = [];
    this.parentElement = null;
    children.forEach((c) => this.add(c));
  }
  add(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  walk() {
    return [this, ...this.children.flatMap((c) => c.walk())];
  }
  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const all = this.walk().slice(1);
    if (sel === 'sp-widget') return all.filter((e) => e.tagName === 'SP-WIDGET');
    if (sel === 'sp-page-row') return all.filter((e) => e.tagName === 'SP-PAGE-ROW');
    if (sel === '.ng-isolate-scope, .ng-scope') return all.filter((e) => e.classList.includes('ng-scope') || e.classList.includes('ng-isolate-scope'));
    return all;
  }
  closest(sel) {
    const tag = sel.toUpperCase();
    for (let n = this; n; n = n.parentElement) if (n.tagName === tag) return n;
    return null;
  }
}

class Doc {
  constructor(body) {
    this.body = body;
    this.documentElement = body;
  }
  querySelectorAll(sel) {
    if (sel === 'sp-page-row') return this.body.walk().filter((e) => e.tagName === 'SP-PAGE-ROW');
    return this.body.walk();
  }
  querySelector(sel) {
    if (sel === '.ng-scope, .ng-binding, .ng-isolate-scope') return this.body.walk().find((e) => e.classList.some((c) => /^ng-(scope|binding|isolate-scope)$/.test(c))) || null;
    return null;
  }
  getElementsByClassName(name) {
    return this.body.walk().filter((e) => e.classList.includes(name));
  }
  getElementById(id) {
    return this.body.walk().find((e) => e.id === id) || null;
  }
  getElementsByTagName(tag) {
    return this.body.walk().filter((e) => e.tagName === tag.toUpperCase());
  }
}

const W1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const W2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';
const I1 = '11111111111111111111111111111111';
const I2 = '22222222222222222222222222222222';
const I3 = '33333333333333333333333333333333';
const I4 = '44444444444444444444444444444444';

/** Two rows; row 1 has a heading widget (W1) and a list (W2); row 2 has the same heading widget again plus an unknown <sp-widget>. */
function portalPage() {
  const heading = new El('div', { id: `x${I1}`, children: [new El('div', { classes: [`v${W1}`, 'ng-scope'], children: [new El('h2')] })] });
  const list = new El('div', { id: `x${I2}`, children: [new El('div', { classes: [`v${W2}`, 'ng-scope'] })] });
  const again = new El('div', { id: `x${I3}`, children: [new El('div', { classes: [`v${W1}`] })] });
  const unknown = new El('sp-widget', { classes: ['custom'] });
  const row1 = new El('sp-page-row', { children: [new El('div', { classes: ['row'], children: [new El('div', { classes: ['col-md-4'], children: [heading] }), new El('div', { classes: ['col-md-8'], children: [list] })] })] });
  const row2 = new El('sp-page-row', { children: [new El('div', { classes: ['row'], children: [new El('div', { classes: ['col-md-12'], children: [again, unknown] })] })] });
  return new Doc(new El('body', { children: [new El('header'), row1, row2] }));
}

// ---- serialize ------------------------------------------------------------------------------------------------

test('serialize copies plain data as it is', () => {
  const out = serialize({ a: 1, b: 'x', c: true, d: null, e: [1, 2, { f: 3 }], g: {} });
  assert.deepEqual(out.value, { a: 1, b: 'x', c: true, d: null, e: [1, 2, { f: 3 }], g: {} });
  assert.equal(out.truncated, false);
  assert.equal(out.masked, 0);
});

test('serialize survives cycles, functions, getters that throw and Angular bookkeeping keys', () => {
  const data = { name: 'x', run() {}, $$hashKey: 'object:12' };
  data.self = data;
  data.list = [data];
  Object.defineProperty(data, 'boom', { enumerable: true, get() { throw new Error('nope'); } });
  const out = serialize(data).value;
  assert.equal(out.name, 'x');
  assert.equal(out.run, MARK.fn);
  assert.equal(out.self, MARK.circular);
  assert.deepEqual(out.list, [MARK.circular]);
  assert.equal(out.boom, MARK.unreadable);
  assert.ok(!('$$hashKey' in out));
});

test('serialize keeps the same object when it appears twice without a cycle', () => {
  const shared = { n: 1 };
  assert.deepEqual(serialize({ a: shared, b: shared }).value, { a: { n: 1 }, b: { n: 1 } });
});

test('serialize stops at the depth limit with a one-line summary', () => {
  const deep = { l1: { l2: { l3: { l4: { l5: { x: 1 } } } } } };
  const out = serialize(deep).value;
  assert.equal(LIMITS.depth, 4);
  assert.deepEqual(out.l1.l2.l3.l4, '[object, 1 keys]');
  assert.deepEqual(serialize({ a: { b: { c: { d: [1, 2, 3] } } } }).value.a.b.c.d, '[array, 3 items]');
});

test('serialize caps the size and says it truncated', () => {
  const big = {};
  for (let i = 0; i < 70; i += 1) big[`key${i}`] = 'v'.repeat(300);
  const out = serialize(big, { bytes: 2000 });
  assert.equal(out.truncated, true);
  assert.ok(JSON.stringify(out.value).length < 4500, 'output stays near the cap');
  assert.ok(out.value['[more]']);
  const items = serialize({ rows: Array.from({ length: 500 }, (_, i) => ({ i })) });
  assert.equal(items.truncated, true);
  assert.equal(items.value.rows.length, LIMITS.items + 1);
  assert.match(items.value.rows[LIMITS.items], /^\[\+\d+ more items\]$/);
  const long = serialize({ s: 'x'.repeat(1000) });
  assert.equal(long.truncated, true);
  assert.match(long.value.s, /\(\+600 more characters\)$/);
});

test('serialize hides secrets by key name and by value', () => {
  const out = serialize({
    user: 'maria',
    password: 'hunter2',
    clientSecret: 'abc',
    accessToken: 'tok',
    api_key: 'k',
    tokenCount: 3,
    nested: { Authorization: 'Bearer abcdefghijklmnop', note: 'Bearer abcdefghijklmnop', jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123', url: 'https://bob:pw@host/x', plain: 'hello' },
  });
  assert.equal(out.value.user, 'maria');
  assert.equal(out.value.password, MARK.masked);
  assert.equal(out.value.clientSecret, MARK.masked);
  assert.equal(out.value.accessToken, MARK.masked);
  assert.equal(out.value.api_key, MARK.masked);
  assert.equal(out.value.tokenCount, 3);
  assert.equal(out.value.nested.Authorization, MARK.masked);
  assert.equal(out.value.nested.note, MARK.masked);
  assert.equal(out.value.nested.jwt, MARK.masked);
  assert.equal(out.value.nested.url, MARK.masked);
  assert.equal(out.value.nested.plain, 'hello');
  assert.ok(out.masked >= 8);
  assert.ok(!JSON.stringify(out.value).includes('hunter2'));
  // sysparm_ck is the session's CSRF token, the same value as g_ck.
  assert.ok(isSecretKey('user_password') && isSecretKey('sysparm_ck') && isSecretKey('g_ck') && !isSecretKey('check') && !isSecretKey('back'));
});

test('serialize labels DOM nodes, windows, scopes and promises instead of walking them', () => {
  const node = { nodeType: 1, nodeName: 'DIV', parentNode: {} };
  const win = {};
  win.window = win;
  const ngScope = { $watch() {}, $digest() {}, $parent: {} };
  const promise = { then() {}, catch() {} };
  const out = serialize({ node, win, ngScope, promise, when: new Date(Date.UTC(2026, 9, 23)) }).value;
  assert.equal(out.node, '[element <div>]');
  assert.equal(out.win, '[window]');
  assert.equal(out.ngScope, '[angular scope]');
  assert.equal(out.promise, '[promise]');
  assert.equal(out.when, '2026-10-23T00:00:00.000Z');
  assert.ok(isMarker(out.node) && isMarker(MARK.masked) && isMarker('fn()') && !isMarker('hello'));
});

test('serialize handles odd roots', () => {
  assert.equal(serialize(undefined).value, undefined);
  assert.equal(serialize(null).value, null);
  assert.equal(serialize(NaN).value, 'NaN');
  assert.deepEqual(serialize([undefined, 1]).value, [null, 1]);
  assert.deepEqual(serialize({ gone: undefined, here: 1 }).value, { here: 1 });
});

// ---- addresses ------------------------------------------------------------------------------------------------

test('validateTarget accepts an address and drops everything that is not a sys_id or a small number', () => {
  assert.deepEqual(validateTarget({ widgetId: W1.toUpperCase(), instanceId: I1, nth: 2, spIndex: -1 }), { widgetId: W1, instanceId: I1, nth: 2, spIndex: -1 });
  assert.equal(validateTarget(null), null);
  assert.equal(validateTarget({ widgetId: 'x", alert(1), "', instanceId: '<img>' }), null);
  assert.deepEqual(validateTarget({ widgetId: W1, nth: '1; drop' }), { widgetId: W1, instanceId: '', nth: 0, spIndex: -1 });
  assert.equal(validateTarget({ spIndex: 3 }).spIndex, 3);
  assert.equal(validateTarget({ spIndex: 99999 }), null);
});

test('discoverWidgets finds every widget in page order, with place, count and keys that find the element again', () => {
  const doc = portalPage();
  const widgets = discoverWidgets(doc);
  assert.equal(widgets.length, 4);
  assert.deepEqual(widgets.map((w) => w.widgetId), [W1, W2, W1, '']);
  assert.deepEqual(widgets.map((w) => w.instanceId), [I1, I2, I3, '']);
  assert.equal(new Set(widgets.map((w) => w.key)).size, 4);
  assert.deepEqual(widgets[0].placement, { row: 1, column: 'col-md-4' });
  assert.deepEqual(widgets[1].placement, { row: 1, column: 'col-md-8' });
  assert.deepEqual(widgets[2].placement, { row: 2, column: 'col-md-12' });
  assert.equal(placementLabel(widgets[0].placement), 'Row 1, col-md-4');
  assert.equal(placementLabel({ row: null, column: null }), '');
  assert.equal(widgets[0].instances, 2);
  assert.equal(widgets[1].instances, 1);
  assert.equal(widgets[3].tag, 'sp-widget');
  // Round trip: the page-world side finds the same element from the address alone.
  widgets.forEach((w) => assert.equal(findTargetElement(doc, validateTarget(w.target)), w.el, `target of ${w.key}`));
  assert.equal(widgets[2].target.nth, 1);
});

test('discoverWidgets treats a nested copy of the same widget as one widget and does not reuse an instance id', () => {
  const inner = new El('div', { classes: [`v${W1}`] });
  const outer = new El('div', { id: `x${I1}`, classes: [`v${W1}`], children: [inner] });
  const embedded = new El('div', { classes: [`v${W2}`] });
  const host = new El('div', { id: `x${I2}`, classes: [`v${W2}`], children: [new El('div', { children: [embedded] })] });
  const doc = new Doc(new El('body', { children: [outer, host] }));
  const widgets = discoverWidgets(doc);
  assert.deepEqual(widgets.map((w) => w.widgetId), [W1, W2]);
  // The embedded widget shares the host's class, so it is the same widget, not a second instance.
  assert.equal(widgets[1].instanceId, I2);
});

test('discoverWidgets: an instance wrapper with no widget class is still listed, once', () => {
  const wrapper = new El('div', { id: `x${I4}`, children: [new El('div')] });
  const doc = new Doc(new El('body', { children: [wrapper] }));
  const widgets = discoverWidgets(doc);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].instanceId, I4);
  assert.equal(widgets[0].widgetId, '');
  assert.equal(findTargetElement(doc, validateTarget(widgets[0].target)), wrapper);
});

test('discoverWidgets on a page with no widgets is an empty list', () => {
  assert.deepEqual(discoverWidgets(new Doc(new El('body', { children: [new El('div', { classes: ['panel'] })] }))), []);
  assert.deepEqual(discoverWidgets(null), []);
});

test('widgetAt picks the deepest widget holding a node; matchWidgets and widgetLabel', () => {
  const doc = portalPage();
  const widgets = discoverWidgets(doc);
  const heading = doc.body.walk().find((e) => e.tagName === 'H2');
  assert.equal(widgetAt(widgets, heading), widgets[0]);
  assert.equal(widgetAt(widgets, doc.body.children[0]), null);
  const named = widgets.map((w, i) => ({ ...w, name: ['Heading', 'Simple List', 'Heading', ''][i], id: ['heading', 'simple-list', 'heading', ''][i] }));
  assert.equal(matchWidgets(named, 'list').length, 1);
  assert.equal(matchWidgets(named, 'head col-md-12').length, 1);
  assert.equal(matchWidgets(named, '').length, 4);
  assert.equal(widgetLabel(named[0]), 'Heading');
  assert.equal(widgetLabel({ id: 'x' }), 'x');
  assert.equal(widgetLabel({ widgetId: W1 }), 'Widget aaaaaaaa');
});

// ---- Angular scopes -------------------------------------------------------------------------------------------

function fakeAngular() {
  return {
    version: { full: '1.5.11' },
    reloadWithDebugInfo() {},
    element: (el) => ({ scope: () => el.__scope, isolateScope: () => el.__isolate }),
  };
}

test('pickWidgetScope finds the widget scope through <sp-widget> and rejects a scope of another widget', () => {
  const data = { title: 'Hello', items: [1, 2] };
  const widgetScope = { widget: { sys_id: W1, rectangle_id: I1, name: 'Heading', id: 'heading', options: { size: 'h2' }, _server_time: 42.4 }, data, options: { size: 'h2' }, c: { data } };
  Object.defineProperty(widgetScope, '$parent', { value: { widget: { sys_id: W1 } } });
  const root = new El('div', { classes: [`v${W1}`] });
  const sp = new El('sp-widget', { children: [root] });
  sp.__isolate = widgetScope;
  const ng = fakeAngular();
  const found = scope.pickWidgetScope(ng, root, { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 });
  assert.equal(found.scope, widgetScope);
  assert.match(found.how, /isolate scope of <sp-widget>/);
  const read = scope.readWidgetScope(found.scope);
  assert.deepEqual(read.data.value, data);
  assert.deepEqual(read.options.value, { size: 'h2' });
  assert.equal(read.serverTimeMs, 42);
  assert.deepEqual(read.identity, { sysId: W1, instanceId: I1, name: 'Heading', id: 'heading' });

  // The same element asked about a different widget finds nothing rather than the wrong data.
  assert.equal(scope.pickWidgetScope(ng, root, { widgetId: W2, instanceId: I2, nth: 0, spIndex: -1 }), null);
});

test('pickWidgetScope falls back to an inner scope, and reads data from the controller when the scope has none of its own', () => {
  const c = { data: { total: 3 }, options: { limit: 5 } };
  const inner = new El('span', { classes: ['ng-scope'] });
  const root = new El('div', { classes: [`v${W1}`], children: [inner] });
  inner.__scope = { widget: { sys_id: W1 }, c };
  const found = scope.pickWidgetScope(fakeAngular(), root, { widgetId: W1, instanceId: '', nth: 0, spIndex: -1 });
  assert.ok(found);
  const read = scope.readWidgetScope(found.scope);
  assert.deepEqual(read.data.value, { total: 3 });
  assert.deepEqual(read.options.value, { limit: 5 });
});

test('pickWidgetScope returns null when debug info is off (scope() answers nothing) or angular is missing', () => {
  const root = new El('div', { classes: [`v${W1}`] });
  assert.equal(scope.pickWidgetScope(fakeAngular(), root, { widgetId: W1, instanceId: '', nth: 0, spIndex: -1 }), null);
  assert.equal(scope.pickWidgetScope(undefined, root, { widgetId: W1 }), null);
  assert.equal(scope.pickWidgetScope(fakeAngular(), null, { widgetId: W1 }), null);
});

test('pickWidgetScope does not take a scope that only looks vaguely like a widget (data and options with no controller or widget)', () => {
  const root = new El('div', { classes: [`v${W1}`, 'ng-scope'] });
  root.__scope = { data: { page: 'x' }, options: {} };
  assert.equal(scope.pickWidgetScope(fakeAngular(), root, { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 }), null);
  // The same scope with the controller that every widget scope has is accepted.
  root.__scope = { data: { a: 1 }, options: {}, c: { data: { a: 1 } } };
  assert.ok(scope.pickWidgetScope(fakeAngular(), root, { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 }));
});

test("pickWidgetScope: an embedded widget gets its own scope, never its parent widget's", () => {
  const parentData = { who: 'parent' };
  const childData = { who: 'child' };
  const parentScope = { widget: { sys_id: W1, rectangle_id: I1 }, data: parentData, options: {}, c: { data: parentData } };
  const childScope = { widget: { sys_id: W2, rectangle_id: '' }, data: childData, options: {}, c: { data: childData } };
  Object.defineProperty(childScope, '$parent', { value: parentScope });
  const child = new El('div', { classes: [`v${W2}`] });
  const parent = new El('div', { classes: [`v${W1}`], children: [child] });
  child.__scope = childScope;
  parent.__scope = parentScope;
  const ng = fakeAngular();
  assert.deepEqual(scope.readWidgetScope(scope.pickWidgetScope(ng, child, { widgetId: W2, instanceId: '', nth: 0, spIndex: -1 }).scope).data.value, childData);
  assert.deepEqual(scope.readWidgetScope(scope.pickWidgetScope(ng, parent, { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 }).scope).data.value, parentData);
  // If only the parent's scope exists (the child has none), asking for the child finds nothing instead of the parent's data.
  child.__scope = undefined;
  assert.equal(scope.pickWidgetScope(ng, child, { widgetId: W2, instanceId: '', nth: 0, spIndex: -1 }), null);
});

test('debugInfoState: on when Angular marked the DOM, off when scope() answers nothing, unknown without angular', () => {
  const marked = portalPage();
  assert.deepEqual(scope.debugInfoState(fakeAngular(), marked), { angular: true, version: '1.5.11', debugInfo: true, canReload: true });
  const plain = new Doc(new El('body', { children: [new El('div', { classes: [`v${W1}`] })] }));
  assert.equal(scope.debugInfoState(fakeAngular(), plain).debugInfo, false);
  const body = new El('body');
  body.__scope = { $id: 1 };
  assert.equal(scope.debugInfoState(fakeAngular(), new Doc(body)).debugInfo, true);
  assert.deepEqual(scope.debugInfoState(undefined, plain), { angular: false, version: null, debugInfo: null, canReload: false });
  const old = { element: fakeAngular().element };
  assert.equal(scope.debugInfoState(old, plain).canReload, false);
});

test('readPageScope reads the portal and page records the scope carries, as plain strings', () => {
  const body = new El('body');
  body.__scope = { page: { sys_id: I1, id: 'index', title: 'Home', rows: [{}] }, $root: { portal: { sys_id: I2, title: 'Service Portal', url_suffix: 'sp' } } };
  const out = scope.readPageScope(fakeAngular(), new Doc(body));
  assert.deepEqual(out.page, { sysId: I1, id: 'index', title: 'Home', urlSuffix: '' });
  assert.deepEqual(out.portal, { sysId: I2, id: '', title: 'Service Portal', urlSuffix: 'sp' });
  assert.deepEqual(scope.readPageScope(fakeAngular(), new Doc(new El('body'))), { page: null, portal: null });
});

// ---- page kind and URL ----------------------------------------------------------------------------------------

test('classifyPage: portal, empty portal, workspace, classic and other', () => {
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/sp?id=index', widgetCount: 3 }).kind, 'portal');
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/esc?id=homepage', widgetCount: 1 }).pageId, 'homepage');
  const loading = classifyPage({ href: 'https://dev1.service-now.com/sp?id=index', widgetCount: 0 });
  assert.equal(loading.kind, 'portal-empty');
  assert.match(loading.message, /no widgets were found/i);
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/sp', widgetCount: 0 }).kind, 'portal-empty');
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/x', widgetCount: 0, hasMarkup: true }).kind, 'portal-empty');
  const ws = classifyPage({ href: 'https://dev1.service-now.com/now/workspace/home' });
  assert.equal(ws.kind, 'workspace');
  assert.match(ws.message, /^This is not a Service Portal page\./);
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/incident.do?sys_id=1' }).kind, 'classic');
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/now/nav/ui/classic/params/target/incident_list.do' }).kind, 'classic');
  assert.equal(classifyPage({ href: 'https://dev1.service-now.com/$pa_dashboard.do' }).kind, 'classic');
  const other = classifyPage({ href: 'https://dev1.service-now.com/some/deep/path' });
  assert.equal(other.kind, 'other');
  assert.match(other.message, /not a Service Portal page/);
  assert.equal(classifyPage({ href: 'not a url' }).kind, 'other');
  assert.equal(classifyPage({}).kind, 'other');
});

test('urlParams lists the parameters and hides secret-looking ones', () => {
  const params = urlParams('https://dev1.service-now.com/sp?id=form&table=incident&sys_id=abc&access_token=zzz');
  assert.deepEqual(params.map((p) => p.name), ['id', 'table', 'sys_id', 'access_token']);
  assert.equal(params[3].value, '[hidden]');
  assert.equal(params[3].secret, true);
  assert.deepEqual(urlParams('nonsense'), []);
  // The CSRF token in a URL is never shown.
  assert.equal(urlParams('https://dev1.service-now.com/sp?id=x&sysparm_ck=abc123def456').find((p) => p.name === 'sysparm_ck').value, '[hidden]');
});

// ---- review fixes: the serialiser runs in the customer's page, so no value may make it slow or lose the whole copy ----

test('serialize: a huge string is checked for secrets in bounded time, and secrets at its start are still hidden', () => {
  const huge = 'a'.repeat(200000);
  const started = Date.now();
  const out = serialize({ blob: huge, hex: '0f'.repeat(100000), url: `https://${'b'.repeat(50000)}` });
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  assert.match(out.value.blob, /\(\+199600 more characters\)$/);
  assert.equal(out.truncated, true);
  // Long secrets are still caught by how they start; a credential inside a URL is caught anywhere in the first 4 KB.
  const jwt = `eyJ${'a'.repeat(3000)}.${'b'.repeat(3000)}.${'c'.repeat(300)}`;
  assert.equal(serialize({ note: jwt }).value.note, MARK.masked);
  assert.equal(serialize({ note: `Bearer ${'x'.repeat(5000)}` }).value.note, MARK.masked);
  assert.equal(serialize({ note: `${'x '.repeat(500)} see https://bob:pw@host/x` }).value.note, MARK.masked);
  assert.equal(serialize({ note: 'hello world' }).value.note, 'hello world');
});

test('serialize: typed arrays are labelled, never walked; a revoked proxy is unreadable and the rest survives', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const out = serialize({ bytes: new Uint8Array(5000000), view: new DataView(new ArrayBuffer(8)), buf: new ArrayBuffer(16), gone: proxy, ok: 1 }).value;
  assert.equal(out.bytes, '[typed array, 5000000 items]');
  assert.equal(out.view, '[typed array, 8 items]');
  assert.equal(out.buf, '[typed array, 16 bytes]');
  assert.equal(out.gone, MARK.unreadable);
  assert.equal(out.ok, 1);
  assert.ok(isMarker(out.bytes) && isMarker(out.buf));
});

// ---- links ----------------------------------------------------------------------------------------------------

test('widgetLinks builds record, editor, instance, usage, page and portal links from ids only', () => {
  const links = widgetLinks({ widgetId: W1, instanceId: I1, instanceTable: 'sp_instance_carousel', pageSysId: I2, pageId: 'index', portalSysId: I3 });
  const by = Object.fromEntries(links.map((l) => [l.id, l.href]));
  assert.equal(by.widget, `/sp_widget.do?sys_id=${W1}`);
  assert.equal(by.editor, `/sp_config?id=widget_editor&sys_id=${W1}`);
  assert.equal(by.instance, `/sp_instance_carousel.do?sys_id=${I1}`);
  assert.equal(by.instances, `/sp_instance_list.do?sysparm_query=${encodeURIComponent(`sp_widget=${W1}`)}`);
  assert.equal(by.page, `/sp_page.do?sys_id=${I2}`);
  assert.equal(by.pageEditor, '/sp_config?id=page_edit&p=index');
  assert.equal(by.portal, `/sp_portal.do?sys_id=${I3}`);
  assert.deepEqual(widgetLinks({}), []);
  const odd = widgetLinks({ widgetId: 'x"><script>', instanceId: I1, instanceTable: '../evil', pageId: 'a b/../c' });
  assert.deepEqual(odd.map((l) => l.id), ['instance']);
  assert.equal(odd[0].href, `/sp_instance.do?sys_id=${I1}`);
});

// ---- what a widget's code touches -----------------------------------------------------------------------------

const SERVER = `(function() {
  // var legacy = new GlideRecord('commented_out');
  data.title = options.title || 'Open incidents';
  data.limit = parseInt($sp.getParameter('limit')) || 10;
  data.items = [];
  var gr = new GlideRecord('incident');
  gr.addQuery('caller_id', gs.getUserID());
  gr.setLimit(data.limit);
  gr.query();
  while (gr.next()) {
    data.items.push({ number: gr.getValue('number'), sys_id: gr.getUniqueValue() });
  }
  var util = new global.IncidentUtils();
  data.stats = util.summary();
  var agg = new GlideAggregate('task');
  agg.query();
  if (input.action === 'close') {
    var rec = new GlideRecord('incident');
    if (rec.get(input.sys_id)) { rec.state = 7; rec.update(); }
  }
  if (input.action == 'reopen') { data.reopened = true; }
  var label = gs.getProperty('x_acme.portal.label', 'Incidents');
  var other = gs.getProperty("glide.ui.date_format");
  if (gs.hasRole('itil')) data.canEdit = true;
  var w = $sp.getWidget('widget-simple-list', { table: 'task' });
  var t = new GlideRecord(tableName);
})();`;

const CLIENT = `api.controller = function($scope, $rootScope, spUtil) {
  var c = this;
  c.close = function(sysId) {
    c.server.get({ action: 'close', sys_id: sysId }).then(function() { c.data.closedCount = 1; });
  };
  c.refresh = function() { c.server.refresh(); spUtil.recordWatch($scope, 'incident', 'active=true'); };
  $rootScope.$broadcast('incident.closed', { id: 1 });
  $scope.$on('list.refresh', function() { c.server.update(); });
  var ga = new GlideAjax('IncidentAjax');
  ga.addParam('sysparm_name', 'getCount');
  if (c.data.canDelete) { c.data.missing = false; }
};`;

const TEMPLATE = `<div class="panel">
  <h2>{{c.data.title}}</h2>
  <div ng-repeat="i in c.data.items">{{i.number}} {{c.data.showMissing}}</div>
  <button ng-click="c.server.get({action: 'archive'})">Archive</button>
  <widget id="widget-simple-list" options="c.options"></widget>
  <div ng-include="'portal_footer'"></div>
</div>`;

test('analyzeWidget reads tables, script includes, properties, $sp calls, actions and data keys from a widget record', () => {
  const a = analyzeWidget({
    script: SERVER,
    client_script: CLIENT,
    template: TEMPLATE,
    css: '.panel { color: red }',
    option_schema: JSON.stringify([{ name: 'title', label: 'Title', type: 'string', default_value: 'Open incidents', section: 'Behavior', hint: 'Heading text' }, { name: 'size', label: 'Size', type: 'integer', default_value: '5' }]),
    data_table: 'sp_instance',
  });

  const tables = Object.fromEntries(a.server.tables.map((t) => [t.table, t]));
  assert.deepEqual(Object.keys(tables).sort(), ['incident', 'task']);
  assert.equal(tables.incident.writes, true, 'rec.update() is a write');
  assert.ok(tables.incident.ops.includes('read') && tables.incident.ops.includes('update'));
  assert.deepEqual(tables.incident.fields, ['state']);
  assert.deepEqual(tables.incident.classes, ['GlideRecord']);
  assert.deepEqual(tables.task.classes, ['GlideAggregate']);
  assert.equal(a.server.dynamicTables, 1);
  assert.ok(!Object.keys(tables).includes('commented_out'), 'comments are ignored');

  assert.deepEqual(a.server.scriptIncludes.map((s) => s.name), ['IncidentUtils']);
  assert.deepEqual(a.server.scriptIncludes[0].methods, ['summary']);
  assert.deepEqual(a.server.properties.map((p) => p.name), ['glide.ui.date_format', 'x_acme.portal.label']);
  assert.deepEqual(a.server.roles.map((r) => r.name), ['itil']);
  assert.deepEqual(a.server.spCalls.map((s) => s.name), ['getParameter', 'getWidget']);
  assert.deepEqual(a.server.urlParamsRead.map((p) => p.name), ['limit']);
  assert.deepEqual(a.server.embeddedWidgets.map((p) => p.name), ['widget-simple-list']);
  assert.deepEqual(a.server.inputActions.map((x) => x.name), ['close', 'reopen']);
  assert.deepEqual(a.server.inputFields.map((x) => x.name), ['sys_id']);
  assert.deepEqual(a.server.optionsRead.map((x) => x.name), ['title']);
  const keys = Object.fromEntries(a.server.dataKeys.map((k) => [k.name, k.line]));
  assert.deepEqual(Object.keys(keys).sort(), ['canEdit', 'items', 'limit', 'reopened', 'stats', 'title']);
  assert.equal(keys.title, 3);

  assert.deepEqual(a.client.serverCalls.map((c) => c.name), ['get', 'refresh', 'update']);
  assert.deepEqual(a.client.actionsSent.map((x) => x.name), ['archive', 'close']);
  assert.deepEqual(a.client.spUtil.map((x) => x.name), ['recordWatch']);
  assert.deepEqual(a.client.events, [{ name: 'incident.closed', role: 'sends', line: 7 }, { name: 'list.refresh', role: 'listens', line: 8 }]);
  assert.deepEqual(a.client.scriptIncludes.map((s) => s.name), ['IncidentAjax']);
  assert.equal(a.client.usesHttp, false);

  assert.deepEqual(a.template.embeddedWidgets.map((w) => w.name), ['widget-simple-list']);
  assert.deepEqual(a.template.includes.map((w) => w.name), ['portal_footer']);
  assert.equal(a.css.chars, 21);

  // Hints: used by the page but never set, and actions the two halves disagree on.
  assert.deepEqual(a.hints.dataNotSet, ['canDelete', 'showMissing']);
  assert.deepEqual(a.hints.actionsNotHandled, ['archive']);
  assert.deepEqual(a.hints.actionsNeverSent, ['reopen']);

  assert.equal(a.optionSchema.options.length, 2);
  assert.equal(a.dataTable, 'sp_instance');
});

test('analyzeWidget: an empty record, a record with dynamic data keys, and a script without a table', () => {
  const empty = analyzeWidget({});
  assert.equal(empty.server.present, false);
  assert.deepEqual(empty.server.tables, []);
  assert.deepEqual(empty.hints.dataNotSet, []);
  assert.equal(analyzeWidget(null).client.present, false);

  const dynamic = analyzeWidget({ script: 'for (var k in obj) { data[k] = obj[k]; }', template: '<p>{{c.data.anything}}</p>' });
  assert.equal(dynamic.hints.dynamicDataKeys, true);
  assert.deepEqual(dynamic.hints.dataNotSet, [], 'with dynamic keys a missing key is not claimed');

  const plain = analyzeWidget({ script: 'data.msg = "hi";', template: '<p>{{c.data.msg}} {{c.data.nope}}</p>' });
  assert.deepEqual(plain.hints.dataNotSet, ['nope']);
  assert.deepEqual(plain.server.tables, []);
});

test('parseOptionSchema and annotateOptions', () => {
  assert.deepEqual(parseOptionSchema(''), { options: [], error: '' });
  assert.match(parseOptionSchema('{nope').error, /not valid JSON/);
  assert.match(parseOptionSchema('{"a":1}').error, /not a list/);
  const schema = parseOptionSchema(JSON.stringify([{ name: 'title', label: 'Title', default_value: 'A' }, { name: 'rows', type: 'integer', value: 5 }, { nolabel: true }]));
  assert.deepEqual(schema.options.map((o) => o.name), ['title', 'rows']);
  const out = annotateOptions(schema, { title: 'B', rows: '5', extra: 1 });
  assert.equal(out.rows[0].differs, true);
  assert.equal(out.rows[1].differs, false, 'compared as text, so 5 equals "5"');
  assert.deepEqual(out.extra, [{ name: 'extra', current: 1 }]);
  const none = annotateOptions(schema, undefined);
  assert.equal(none.rows[0].present, false);
  assert.equal(none.rows[0].differs, false);
});

// ---- snapshots ------------------------------------------------------------------------------------------------

test('diffValues lists exactly the keys that changed, were added or were removed', () => {
  const before = { count: 3, user: { name: 'maria', roles: ['a', 'b'] }, gone: true, same: 'x' };
  const after = { count: 4, user: { name: 'maria', roles: ['a', 'c', 'd'] }, added: { deep: 1 }, same: 'x' };
  const diff = diffValues(before, after);
  const flat = diff.entries.map((e) => `${e.kind} ${e.path}`);
  assert.deepEqual(flat, ['added added', 'changed count', 'removed gone', 'changed user.roles[1]', 'added user.roles[2]']);
  assert.equal(diff.total, 5);
  assert.equal(diff.entries[1].before, '3');
  assert.equal(diff.entries[1].after, '4');
  assert.equal(diffSummary(diff), '2 changed, 2 added, 1 removed');
});

test('diffValues: identical values, whole-value changes, containers turning into scalars, and the entry cap', () => {
  assert.deepEqual(diffValues({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), { entries: [], more: 0, total: 0 });
  assert.equal(diffSummary(diffValues(1, 1)), 'No changes');
  const scalar = diffValues(1, 2).entries;
  assert.deepEqual(scalar, [{ path: '(whole value)', kind: 'changed', before: '1', after: '2' }]);
  const turned = diffValues({ a: { b: 1 } }, { a: 5 }).entries.map((e) => `${e.kind} ${e.path}`);
  assert.deepEqual(turned, ['changed a']);
  assert.deepEqual(diffValues({ a: { b: 1 } }, { a: 5 }).entries[0], { path: 'a', kind: 'changed', before: '{1 key}', after: '5' });
  const empty = diffValues({ list: [] }, { list: [1] });
  assert.deepEqual(empty.entries.map((e) => `${e.kind} ${e.path}`), ['added list[0]']);
  const big = {};
  const bigger = {};
  for (let i = 0; i < 300; i += 1) {
    big[`k${i}`] = i;
    bigger[`k${i}`] = i + 1;
  }
  const capped = diffValues(big, bigger, { max: 50 });
  assert.equal(capped.entries.length, 50);
  assert.equal(capped.more, 250);
  assert.match(diffSummary(capped), /and 250 more/);
  assert.equal(diffValues({ a: 'x'.repeat(200) }, { a: 'y' }).entries[0].before.length, 80);
});

test('diffValues reports a whole new or removed object once, at its top', () => {
  const diff = diffValues({ items: [{ n: 1 }], gone: { a: 1, b: { c: 2 } } }, { items: [{ n: 1 }, { n: 2, state: 'New', tags: ['x'] }] });
  assert.deepEqual(diff.entries.map((e) => `${e.kind} ${e.path} ${e.before}${e.after}`), ['removed gone {2 keys}', 'added items[1] {3 keys}']);
  assert.deepEqual(diffValues({ l: [1, 2, 3] }, { l: [1] }).entries.map((e) => `${e.kind} ${e.path}`), ['removed l[1]', 'removed l[2]']);
});

test('diffValues treats the hidden-value marker as an ordinary value, so a masked secret never shows a change', () => {
  assert.equal(diffValues({ password: MARK.masked, n: 1 }, { password: MARK.masked, n: 1 }).total, 0);
});

test('jsonText pretty-prints and never throws', () => {
  assert.equal(jsonText({ a: 1 }), '{\n  "a": 1\n}');
  assert.equal(jsonText(undefined), 'null');
  const cyclic = {};
  cyclic.me = cyclic;
  assert.equal(jsonText(cyclic), '');
});

// ---- The page-world actions (what src/page/bridge.js runs) ------------------------------------------------------

function portalWorld({ debug = true, withAngular = true } = {}) {
  const data = { title: 'Open incidents', items: [{ number: 'INC1' }], api_key: 'secret-value' };
  const widgetScope = { widget: { sys_id: W1, rectangle_id: I1, name: 'Ticket list', id: 'ticket-list', options: { limit: 5 }, _server_time: 120 }, data, options: { limit: 5 }, c: { data } };
  const root = new El('div', { id: `x${I1}`, classes: [`v${W1}`, ...(debug ? ['ng-scope'] : [])] });
  if (debug) root.__scope = widgetScope;
  const body = new El('body', { children: [root] });
  if (debug) body.__scope = { page: { sys_id: I2, id: 'index', title: 'Home' }, $root: { portal: { sys_id: I3, title: 'Service Portal', url_suffix: 'sp' } } };
  const ng = withAngular ? fakeAngular() : undefined;
  const reloads = [];
  if (ng) ng.reloadWithDebugInfo = () => reloads.push(1);
  return { world: { doc: new Doc(body), ng }, reloads, root };
}

test('portalScan reports debug info, the page records and each widget\'s own identity', () => {
  const { world } = portalWorld();
  const actions = scope.portalActions(() => world);
  const out = actions.portalScan('', [{ widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 }, { widgetId: W2, instanceId: '', nth: 0, spIndex: -1 }, { widgetId: 'bad' }]);
  assert.equal(out.angular, true);
  assert.equal(out.debugInfo, true);
  assert.equal(out.canReload, true);
  assert.equal(out.page.id, 'index');
  assert.equal(out.portal.urlSuffix, 'sp');
  assert.deepEqual(out.widgets[0].identity, { sysId: W1, instanceId: I1, name: 'Ticket list', id: 'ticket-list' });
  assert.equal(out.widgets[0].serverTimeMs, 120);
  assert.deepEqual(out.widgets[1], { found: false, scope: false });
  assert.deepEqual(out.widgets[2], { found: false, scope: false });
  assert.deepEqual(scope.portalActions(() => null).portalScan('', []), { frame: false });
  assert.equal(actions.portalScan('', 'nonsense').widgets.length, 0);
});

test('portalWidgetState returns serialised data and options, with secrets hidden', () => {
  const { world } = portalWorld();
  const out = scope.portalActions(() => world).portalWidgetState('', { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 });
  assert.equal(out.scope, true);
  assert.equal(out.reason, '');
  assert.deepEqual(out.data.value, { title: 'Open incidents', items: [{ number: 'INC1' }], api_key: MARK.masked });
  assert.equal(out.data.masked, 1);
  assert.deepEqual(out.options.value, { limit: 5 });
  assert.match(out.how, /scope/);
  assert.equal(out.serverTimeMs, 120);
  assert.ok(!JSON.stringify(out).includes('secret-value'));
});

test('portalWidgetState gives the reason when there is no scope: no debug info, no angular, no element, bad address', () => {
  const addr = { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 };
  const off = scope.portalActions(() => portalWorld({ debug: false }).world).portalWidgetState('', addr);
  assert.equal(off.scope, false);
  assert.equal(off.reason, 'no-debug-info');
  assert.equal(off.debugInfo, false);
  assert.equal(off.canReload, true);
  assert.equal(scope.portalActions(() => portalWorld({ withAngular: false }).world).portalWidgetState('', addr).reason, 'no-angular');
  assert.equal(scope.portalActions(() => portalWorld().world).portalWidgetState('', { widgetId: W2, nth: 0 }).reason, 'no-element');
  assert.throws(() => scope.portalActions(() => portalWorld().world).portalWidgetState('', { widgetId: 'x' }), /not a widget address/);
  assert.equal(scope.portalActions(() => null).portalWidgetState('', addr).reason, 'no-frame');
});

test('portalReloadWithDebugInfo calls the documented Angular function once, and refuses when it is missing', () => {
  const { world, reloads } = portalWorld();
  assert.equal(scope.portalActions(() => world).portalReloadWithDebugInfo(''), true);
  assert.equal(reloads.length, 1);
  assert.throws(() => scope.portalActions(() => ({ doc: world.doc, ng: { element: () => ({}) } })).portalReloadWithDebugInfo(''), /cannot be reloaded/);
  assert.throws(() => scope.portalActions(() => null).portalReloadWithDebugInfo(''), /cannot be reloaded/);
});

test('scopeExplanation has a plain sentence for every reason', () => {
  const { scopeExplanation } = require('../src/lib/portalInspector.js');
  ['no-debug-info', 'no-angular', 'no-scope', 'no-element', 'no-frame', 'bridge-error'].forEach((reason) => assert.ok(scopeExplanation(reason, { error: 'timed out' }).length > 20, reason));
  assert.match(scopeExplanation('no-debug-info'), /debug info is switched off/i);
  assert.match(scopeExplanation('bridge-error', { error: 'timed out' }), /timed out/);
  assert.equal(scopeExplanation('whatever'), '');
});

// ---- The copy of portalScope.js inside the page bridge ------------------------------------------------------------

// src/page/bridge.js has to stay a plain script (other tests run it as one, and it is injected as one), so it cannot
// import src/lib/portalScope.js. It carries a copy of that module between two marker lines instead. This test makes the
// copy impossible to forget: edit portalScope.js, then run  UPDATE_PORTAL_BRIDGE=1 node tests/run.js portalinspector
// to rewrite the block, and review the diff.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const BRIDGE_FILE = nodePath.join(__dirname, '..', 'src', 'page', 'bridge.js');
const MODULE_FILE = nodePath.join(__dirname, '..', 'src', 'lib', 'portalScope.js');
const START = '  // >>> portalScope: generated from src/lib/portalScope.js, do not edit here (UPDATE_PORTAL_BRIDGE=1 node tests/run.js portalinspector)\n';
const END = '  // <<< portalScope\n';
const unix = (text) => text.replace(/\r\n/g, '\n');

function expectedBlock() {
  const body = unix(nodeFs.readFileSync(MODULE_FILE, 'utf8')).replace(/^export /gm, '').replace(/\s+$/, '') + '\n';
  return `${START}  var portalScope = (function () {\n${body}    return { portalActions: portalActions };\n  })();\n${END}`;
}

test('the page bridge carries an exact copy of src/lib/portalScope.js, so the code that runs in the page is the code that is tested', () => {
  let bridge = unix(nodeFs.readFileSync(BRIDGE_FILE, 'utf8'));
  const from = bridge.indexOf(START);
  const to = bridge.indexOf(END);
  assert.ok(from >= 0 && to > from, 'the marker lines are missing from src/page/bridge.js');
  const current = bridge.slice(from, to + END.length);
  if (process.env.UPDATE_PORTAL_BRIDGE && current !== expectedBlock()) {
    bridge = bridge.slice(0, from) + expectedBlock() + bridge.slice(to + END.length);
    nodeFs.writeFileSync(BRIDGE_FILE, bridge);
    return;
  }
  assert.equal(current, expectedBlock(), 'src/lib/portalScope.js changed: run  UPDATE_PORTAL_BRIDGE=1 node tests/run.js portalinspector  to refresh the copy in src/page/bridge.js');
});

test('the page bridge is still a plain script: no import or export statements, and it registers the portal actions', () => {
  const bridge = nodeFs.readFileSync(BRIDGE_FILE, 'utf8');
  assert.ok(!/^\s*(import|export)\s/m.test(bridge), 'import/export would break running the bridge as a plain script');
  ['portalScan', 'portalWidgetState', 'portalReloadWithDebugInfo'].forEach((name) => assert.match(bridge, new RegExp(`${name}: portal\.${name}`)));
  // The header comment about what the bridge may do is kept in step with what it does.
  assert.match(bridge, /portal\* actions .*only READ/s);
});

test('run as a plain script (the way the extension and the other bridge tests do), the bridge answers the portal actions', () => {
  const vm = require('node:vm');
  const listeners = {};
  const responses = [];
  const body = new El('body', { children: [new El('div', { id: `x${I1}`, classes: [`v${W1}`, 'ng-scope'] })] });
  body.children[0].__scope = { widget: { sys_id: W1, rectangle_id: I1, name: 'Ticket list', id: 'ticket-list' }, data: { n: 1, password: 'x' }, options: {}, c: { data: { n: 1 } } };
  const doc = new Doc(body);
  doc.addEventListener = (type, fn) => (listeners[type] = fn);
  doc.dispatchEvent = (event) => {
    if (event.type === 'msb-page-response') responses.push(event.detail);
    return true;
  };
  const win = { document: doc, angular: fakeAngular(), frames: {} };
  win.window = win;
  vm.runInNewContext(nodeFs.readFileSync(BRIDGE_FILE, 'utf8'), { window: win, document: doc, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } } });
  listeners['msb-page-request']({ detail: { id: 'r1', action: 'portalWidgetState', args: ['', { widgetId: W1, instanceId: I1, nth: 0, spIndex: -1 }] } });
  listeners['msb-page-request']({ detail: { id: 'r2', action: 'portalWidgetState', args: ['', { widgetId: 'bad' }] } });
  assert.equal(responses[0].ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(responses[0].result.data.value)), { n: 1, password: MARK.masked }); // through JSON: the answer was made in another realm
  assert.equal(responses[0].result.identity.name, 'Ticket list');
  assert.equal(responses[1].ok, false);
  assert.match(responses[1].error, /not a widget address/);
});
