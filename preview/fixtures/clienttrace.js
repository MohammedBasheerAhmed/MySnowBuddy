// Dev-only (not shipped): sample data for the Client trace panel in the preview harness (see preview/fixtures/index.js).
//
// The events below are a REAL recording of the recorder (src/lib/clientTraceRecorder.js) running in headless Chrome against a
// fake classic form (a shell page with a gsft_main iframe whose scripts look like GlideForm and GlideAjax), so they have the
// exact shape the panel gets in the extension. Only the sys_ids, the script names and the table checks are invented.
//
// Two things make the panel show them:
//   1. This module sets globalThis.__msbClientTraceFixture when the page address has ?trace=demo (or ?trace=demo-armed),
//      which src/content/clientTrace.js honours only on hosts that are not *.service-now.com.
//   2. route() answers the script lookups ("which script was that?") for the two sample sys_ids.
// Open: preview.html?open=clienttrace&trace=demo   (add &theme=dark, and &width=380)

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const ID_LOAD = '6816f79cc0a8016401c5a33be04be441';
const ID_CHANGE = '287ebd7da9fe198100f92cc8d1d2154e';

const EVENTS = [
  {"seq":1,"kind":"page","name":"page load started","t":50.3,"at":1792703752492,"frame":"top","id":1,"args":["/","loading"],"stack":[],"rid":"demo-1"},
  {"seq":2,"kind":"page","name":"DOMContentLoaded","t":57.7,"at":1792703752500,"frame":"top","id":2,"stack":[],"rid":"demo-1"},
  {"seq":3,"kind":"page","name":"load","t":114.1,"at":1792703752556,"frame":"top","id":3,"stack":[],"rid":"demo-1"},
  {"seq":4,"kind":"longtask","name":"Long task","t":114.8,"at":1792703752557,"frame":"top","id":4,"durationMs":376,"stack":[],"rid":"demo-1"},
  {"seq":1,"kind":"page","name":"page load started","t":21.1,"at":1792703752519,"frame":"gsft_main","id":1,"args":["/incident.do","loading"],"stack":[],"rid":"demo-2"},
  {"seq":2,"kind":"page","name":"DOMContentLoaded","t":25.8,"at":1792703752523,"frame":"gsft_main","id":2,"stack":[],"rid":"demo-2"},
  {"seq":3,"kind":"page","name":"load","t":58.9,"at":1792703752556,"frame":"gsft_main","id":3,"stack":[],"rid":"demo-2"},
  {"seq":4,"kind":"field","name":"g_form.setValue","t":61.9,"at":1792703752559,"frame":"gsft_main","id":4,"field":"short_description","args":["Printer broken"],"result":{"before":"","after":"Printer broken","changed":true},"durationMs":1.5,"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":51,"col":10,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":5,"kind":"field","name":"g_form.setMandatory","t":63.5,"at":1792703752561,"frame":"gsft_main","id":5,"field":"short_description","args":[true],"durationMs":0.2,"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":52,"col":10,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":6,"kind":"field","name":"g_form.setValue","t":63.7,"at":1792703752561,"frame":"gsft_main","id":6,"field":"u_password","args":["[hidden]"],"durationMs":0.2,"flags":{"hidden":true},"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":53,"col":10,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":7,"kind":"field","name":"g_form.setValue","t":63.9,"at":1792703752561,"frame":"gsft_main","id":7,"field":"u_not_on_form","args":["x"],"durationMs":0.1,"flags":{"unknownField":true},"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":54,"col":10,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":8,"kind":"field","name":"g_form.setValue","t":64.2,"at":1792703752562,"frame":"gsft_main","id":9,"field":"priority","args":["1"],"result":{"before":"3","after":"1","changed":true},"durationMs":0.2,"depth":1,"parent":8,"stack":[{"fn":"Object.onChange_287ebd7da9fe198100f92cc8d1d2154e [as category]","line":68,"col":10,"url":"/incident.do"},{"fn":"GlideForm.setValue","line":36,"col":56,"url":"/incident.do"},{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":55,"col":10,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":9,"kind":"field","name":"g_form.setValue","t":64,"at":1792703752561,"frame":"gsft_main","id":8,"field":"category","args":["hardware"],"result":{"before":"software","after":"hardware","changed":true},"durationMs":0.4,"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":55,"col":10,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":10,"kind":"ajax","name":"GlideAjax.getXML","t":65.1,"at":1792703752563,"frame":"gsft_main","id":10,"args":["IncidentUtils","getDefaults",{"sysparm_caller":"abc","sysparm_api_key":"[hidden]"}],"phase":"start","stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":60,"col":6,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":11,"kind":"ajax","name":"GlideAjax.getXMLAnswer","t":67.7,"at":1792703752565,"frame":"gsft_main","id":11,"args":["Repeat","again",{}],"phase":"start","stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":61,"col":108,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":12,"kind":"ajax","name":"GlideAjax.getXMLAnswer","t":68.6,"at":1792703752566,"frame":"gsft_main","id":12,"args":["Repeat","again",{}],"phase":"start","stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":61,"col":108,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":13,"kind":"ajax","name":"GlideAjax.getXMLAnswer","t":69.5,"at":1792703752567,"frame":"gsft_main","id":13,"args":["Repeat","again",{}],"phase":"start","stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":61,"col":108,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":14,"kind":"ajax","name":"GlideAjax.getXMLWait","t":70.5,"at":1792703752568,"frame":"gsft_main","id":14,"args":["Slow","slow",{}],"durationMs":363.9,"flags":{"blocking":true},"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":62,"col":81,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":15,"kind":"console","name":"console.error","t":435.4,"at":1792703752933,"frame":"gsft_main","id":15,"args":["onLoad console error password=[hidden]","{a: 1}"],"stack":[{"fn":"onLoad_6816f79cc0a8016401c5a33be04be441","line":63,"col":11,"url":"/incident.do"},{"fn":"","line":48,"col":3,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":16,"kind":"ajax","name":"GlideAjax.getXML","t":442.1,"at":1792703752940,"frame":"gsft_main","id":16,"result":{"status":200,"answer":"42"},"durationMs":377,"phase":"end","ref":10,"stack":[],"rid":"demo-2"},
  {"seq":17,"kind":"message","name":"g_form.addInfoMessage","t":442.3,"at":1792703752940,"frame":"gsft_main","id":17,"args":["answer 42"],"durationMs":0.2,"stack":[{"fn":"","line":60,"col":35,"url":"/incident.do"},{"fn":"x.onreadystatechange","line":10,"col":66,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":18,"kind":"longtask","name":"Long task","t":60.2,"at":1792703752558,"frame":"gsft_main","id":18,"durationMs":376,"stack":[],"rid":"demo-2"},
  {"seq":19,"kind":"ajax","name":"GlideAjax.getXMLAnswer","t":446.3,"at":1792703752944,"frame":"gsft_main","id":19,"result":{"answer":"42"},"durationMs":378.6,"phase":"end","ref":11,"stack":[],"rid":"demo-2"},
  {"seq":20,"kind":"ajax","name":"GlideAjax.getXMLAnswer","t":447,"at":1792703752944,"frame":"gsft_main","id":20,"result":{"answer":"42"},"durationMs":378.4,"phase":"end","ref":12,"stack":[],"rid":"demo-2"},
  {"seq":21,"kind":"ajax","name":"GlideAjax.getXMLAnswer","t":447.6,"at":1792703752945,"frame":"gsft_main","id":21,"result":{"answer":"42"},"durationMs":378.1,"phase":"end","ref":13,"stack":[],"rid":"demo-2"},
  {"seq":22,"kind":"error","name":"TypeError","t":650.3,"at":1792703753148,"frame":"gsft_main","id":22,"args":["Uncaught TypeError: Cannot read properties of null (reading 'boom')"],"flags":{"exception":true},"stack":[{"fn":"","line":64,"col":33,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":23,"kind":"error","name":"Unhandled promise rejection","t":697.9,"at":1792703753195,"frame":"gsft_main","id":23,"args":["Error: rejected later"],"flags":{"exception":true},"stack":[{"fn":"","line":65,"col":43,"url":"/incident.do"}],"rid":"demo-2"},
  // The UI policy engine (frames in /scripts/ui_policy.jsx, as seen live) and the platform's jslog noise.
  {"seq":24,"kind":"field","name":"g_form.setMandatory","t":70.1,"at":1792703752568,"frame":"gsft_main","id":24,"field":"close_notes","args":[true],"durationMs":0.3,"stack":[{"fn":"klass._runAction","line":683,"col":11,"url":"/scripts/ui_policy.jsx"},{"fn":"klass._processActions","line":669,"col":9,"url":"/scripts/ui_policy.jsx"}],"rid":"demo-2"},
  {"seq":25,"kind":"field","name":"g_form.setDisplay","t":70.4,"at":1792703752568,"frame":"gsft_main","id":25,"field":"u_bsm","args":[false],"durationMs":0.2,"stack":[{"fn":"klass._runAction","line":711,"col":11,"url":"/scripts/ui_policy.jsx"}],"rid":"demo-2"},
  {"seq":26,"kind":"log","name":"jslog","t":71.0,"at":1792703752569,"frame":"gsft_main","id":26,"args":["added render event for incident.caller_id"],"stack":[{"fn":"","line":5530,"col":4,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":27,"kind":"log","name":"jslog","t":71.2,"at":1792703752569,"frame":"gsft_main","id":27,"args":["added render event for incident.category"],"stack":[{"fn":"","line":5530,"col":4,"url":"/incident.do"}],"rid":"demo-2"},
  {"seq":28,"kind":"log","name":"jslog","t":71.3,"at":1792703752569,"frame":"gsft_main","id":28,"args":["added render event for incident.priority"],"stack":[{"fn":"","line":5530,"col":4,"url":"/incident.do"}],"rid":"demo-2"}
];

const SCRIPTS = {
  [ID_LOAD]: { sys_id: ID_LOAD, name: 'Set incident defaults', table: 'incident', type: 'onLoad', field: '' },
  [ID_CHANGE]: { sys_id: ID_CHANGE, name: 'Reset priority when category changes', table: 'incident', type: 'onChange', field: 'category' },
};

// Note: on a real classic form the hex in onLoad_<hex> is NOT a sys_id (confirmed live, 2026-10-23); there the extension
// names such functions by their source text (`sources`, per page load, label '... (matched by its source text)'). This
// sample still names its two scripts through `ids` because tests/insights.test.js pins those labels. The UI policy rows
// below use the live shape (frames in /scripts/ui_policy.jsx, policies read from the page's ui_policy_add data).
const RESOLVED = {
  ids: {
    [ID_LOAD]: { table: 'sys_script_client', kind: 'Client script', name: 'Set incident defaults', type: 'onLoad', field: '', tableName: 'incident' },
    [ID_CHANGE]: { table: 'sys_script_client', kind: 'Client script', name: 'Reset priority when category changes', type: 'onChange', field: 'category', tableName: 'incident' },
  },
  names: {},
  classes: { IncidentUtils: { found: true, clientCallable: true }, Repeat: { found: true, clientCallable: true }, Slow: { found: true, clientCallable: false } },
  sources: {},
  policies: {
    'demo-2': [
      { sysId: 'c3c1e2f4b5d6478899aabbccddeeff03', name: 'Close notes mandatory when resolved', table: 'incident', actions: [{ field: 'close_notes', mandatory: 'true', visible: 'ignore', disabled: 'ignore', cleared: 'false' }] },
      { sysId: 'd3c1e2f4b5d6478899aabbccddeeff04', name: 'Hide BSM for HR incidents', table: 'incident', actions: [{ field: 'u_bsm', mandatory: 'ignore', visible: 'false', disabled: 'ignore', cleared: 'false' }] },
      { sysId: 'e3c1e2f4b5d6478899aabbccddeeff05', name: 'Show BSM for IT incidents', table: 'incident', actions: [{ field: 'u_bsm', mandatory: 'ignore', visible: 'true', disabled: 'ignore', cleared: 'false' }] },
    ],
  },
  notes: [],
};

const trace = new URLSearchParams(globalThis.location?.search || '').get('trace');
if (trace === 'demo' || trace === 'demo-armed') {
  const armed = trace === 'demo-armed';
  globalThis.__msbClientTraceFixture = {
    state: { armed, until: Date.now() + 27 * 60000, minutesLeft: 27, recorder: 'running', recorderArmed: armed, frames: [], host: 'dev12345.service-now.com', page: '/now/nav/ui/classic/params/target/incident.do' },
    events: EVENTS,
    version: 1,
    resolved: RESOLVED,
  };
}

/** The script lookups of src/content/clientTrace.js (sys_idIN..., read-only). Everything else returns null. */
export function route(method, url) {
  if (method !== 'GET') return null;
  const m = /^\/api\/now\/table\/(sys_script_client|sys_ui_policy|sys_ui_action|sys_ui_script|catalog_script_client|catalog_ui_policy)$/.exec(url.pathname);
  if (!m) return null;
  const query = url.searchParams.get('sysparm_query') || '';
  const ids = (/^sys_idIN(.+)$/.exec(query) || [])[1];
  if (!ids) return null;
  const rows = m[1] === 'sys_script_client' ? ids.split(',').filter((id) => SCRIPTS[id]).map((id) => SCRIPTS[id]) : [];
  return json({ result: rows });
}
