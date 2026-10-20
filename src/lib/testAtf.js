// ATF finder for the Test panel: which Automated Test Framework tests and suites reference this table or Script Include,
// and how their last run went. Pure: building the queries and putting the answers together. src/content/testKit.js runs them.
//
// UNVERIFIED on a live instance: where a step stores the table or script it uses. Step inputs live in
// sys_atf_step.inputs (a serialised variables field), so this searches that text, the step description and the test
// name and description. A test that reaches the table only through another test's setup will not be found; the panel
// says so instead of claiming nothing covers it.

const SYS_ID_RE = /^[0-9a-f]{32}$/i;
const TERM_RE = /^[A-Za-z0-9_.]{2,80}$/;

export const isSysId = (value) => SYS_ID_RE.test(String(value || ''));

/** The words to look for: the table name and/or the Script Include name, validated (a query value must not carry ^). */
export function searchTerms({ table = '', name = '', apiName = '' } = {}) {
  const terms = [table, name, apiName ? apiName.split('.').pop() : '']
    .map((t) => String(t || '').trim())
    .filter((t) => TERM_RE.test(t));
  return [...new Set(terms)];
}

export function stepQuery(terms) {
  return terms.map((t) => `inputsLIKE${t}^OR`).join('').replace(/\^OR$/, '') + `^ORDERBYtest`;
}

export function testNameQuery(terms) {
  return terms.map((t) => `nameLIKE${t}^ORdescriptionLIKE${t}`).join('^OR');
}

/** `testIN<ids>` style filters in chunks the Table API accepts. */
export function inQuery(field, ids, extra = '') {
  const clean = [...new Set(ids.filter(isSysId))];
  return clean.length ? `${field}IN${clean.join(',')}${extra}` : '';
}

export const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

const text = (cell) => {
  if (cell == null) return '';
  if (typeof cell === 'object') return String('display_value' in cell && cell.display_value !== '' ? cell.display_value : cell.value ?? '');
  return String(cell);
};
const raw = (cell) => (cell && typeof cell === 'object' ? String(cell.value ?? '') : String(cell ?? ''));

/** pass | fail | skip | running | unknown for an ATF status label. */
export function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (/^(success|passed|pass)\b/.test(s)) return 'pass';
  if (/(fail|error|abort)/.test(s)) return 'fail';
  if (/(skip|cancel)/.test(s)) return 'skip';
  if (/(run|queue|progress|wait|start)/.test(s)) return 'running';
  return 'unknown';
}

/** The newest row per key (rows come newest first). */
function newestBy(rows, keyOf) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const key = keyOf(row);
    if (key && !map.has(key)) map.set(key, row);
  });
  return map;
}

/**
 * Put the answers together.
 * @param {object} data
 * @param {Array} data.steps         sys_atf_step rows ({ test, description }) that mention a term
 * @param {Array} data.tests         sys_atf_test rows ({ sys_id, name, active, description })
 * @param {Array} data.results       sys_atf_test_result rows, newest first ({ test, status, start_time, run_time, output })
 * @param {Array} data.suiteLinks    sys_atf_test_suite_test rows ({ test_suite, test })
 * @param {Array} data.suites        sys_atf_test_suite rows ({ sys_id, name, active })
 * @param {Array} data.suiteResults  sys_atf_test_suite_result rows, newest first ({ test_suite, status, success_count, failure_count })
 */
export function buildAtfReport({ steps = [], tests = [], results = [], suiteLinks = [], suites = [], suiteResults = [] } = {}) {
  const stepsByTest = new Map();
  steps.forEach((s) => {
    const id = raw(s.test);
    if (!stepsByTest.has(id)) stepsByTest.set(id, []);
    stepsByTest.get(id).push(text(s.description) || 'a step');
  });
  const lastTest = newestBy(results, (r) => raw(r.test));
  const lastSuite = newestBy(suiteResults, (r) => raw(r.test_suite));
  const suiteById = new Map(suites.map((s) => [raw(s.sys_id), s]));
  const suitesByTest = new Map();
  suiteLinks.forEach((link) => {
    const t = raw(link.test);
    const s = suiteById.get(raw(link.test_suite));
    if (!s) return;
    if (!suitesByTest.has(t)) suitesByTest.set(t, new Map());
    suitesByTest.get(t).set(raw(s.sys_id), s);
  });

  const suiteEntry = (s) => {
    const last = lastSuite.get(raw(s.sys_id));
    return {
      sysId: raw(s.sys_id),
      name: text(s.name),
      active: raw(s.active) !== 'false',
      last: last ? { status: text(last.status), kind: statusClass(text(last.status)), passed: Number(raw(last.success_count)) || 0, failed: Number(raw(last.failure_count)) || 0 } : null,
    };
  };

  const testEntries = tests.map((t) => {
    const id = raw(t.sys_id);
    const last = lastTest.get(id);
    return {
      sysId: id,
      name: text(t.name),
      active: raw(t.active) !== 'false',
      matchedBy: stepsByTest.get(id) ? [`${stepsByTest.get(id).length} step${stepsByTest.get(id).length === 1 ? '' : 's'}`] : ['name or description'],
      steps: (stepsByTest.get(id) || []).slice(0, 5),
      last: last ? { status: text(last.status), kind: statusClass(text(last.status)), at: text(last.start_time) || text(last.sys_created_on), runTime: text(last.run_time), output: text(last.output).slice(0, 600) } : null,
      suites: [...(suitesByTest.get(id)?.values() || [])].map(suiteEntry),
    };
  });

  const suiteMap = new Map();
  testEntries.forEach((t) => t.suites.forEach((s) => suiteMap.set(s.sysId, s)));
  const count = (kind) => testEntries.filter((t) => t.last?.kind === kind).length;
  return {
    tests: testEntries,
    suites: [...suiteMap.values()],
    summary: { tests: testEntries.length, passed: count('pass'), failed: count('fail'), neverRun: testEntries.filter((t) => !t.last).length },
  };
}

/** What to tell the user when nothing was found: honest about what the search could not see. */
export const NO_ATF_NOTE =
  'No ATF test mentions it in its name, description or step inputs. Tests that reach it through another test or a flow will not show up here. To cover it: create a test in Automated Test Framework > Tests, add a "Record Update" or "Run Server Side Script" step that exercises it, and add the test to a suite.';
