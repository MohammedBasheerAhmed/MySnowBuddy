// Automated Test Framework helpers: find suites and tests, start a suite run,
// and read recent results.
//
// UNVERIFIED on a live instance: the CI/CD ATF endpoint (requires the CI/CD
// plugin and its role) and the result table field names. See docs/decisions.md.

import { queryTable } from './tableApi.js';
import { sessionHeaders } from './sessionToken.js';

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

function assertSafeFilter(text) {
  if (String(text).includes('^')) throw new Error('Search text cannot contain "^".');
}

export function fetchAtfSuites(search = '', limit = 50) {
  assertSafeFilter(search);
  const filter = search.trim() ? `nameLIKE${search.trim()}^` : '';
  return queryTable('sys_atf_test_suite', `${filter}ORDERBYname`, ['sys_id', 'name', 'description', 'active'], { limit });
}

export function fetchAtfTests(search = '', limit = 50) {
  assertSafeFilter(search);
  const filter = search.trim() ? `nameLIKE${search.trim()}^` : '';
  return queryTable('sys_atf_test', `${filter}ORDERBYname`, ['sys_id', 'name', 'description', 'active'], { limit });
}

/** Most recent test results, newest first. Display values give readable test names. */
export function fetchAtfResults(limit = 25) {
  return queryTable(
    'sys_atf_test_result',
    'ORDERBYDESCsys_created_on',
    ['sys_id', 'test', 'status', 'start_time', 'run_time', 'output', 'sys_created_on'],
    { limit, displayValue: true }
  );
}

export function fetchAtfSuiteResults(limit = 15) {
  return queryTable(
    'sys_atf_test_suite_result',
    'ORDERBYDESCsys_created_on',
    ['sys_id', 'test_suite', 'status', 'start_time', 'end_time', 'success_count', 'failure_count', 'sys_created_on'],
    { limit, displayValue: true }
  );
}

/**
 * Start a suite run through the CI/CD API. Returns the progress id to poll.
 * This queues real test execution on the instance, so callers must confirm first.
 */
export async function runAtfSuite(suiteSysId, csrfToken) {
  if (!SYS_ID_RE.test(suiteSysId || '')) throw new Error('Invalid suite.');
  const response = await fetch(`/api/sn_cicd/testsuite/run?test_suite_sys_id=${suiteSysId}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'X-UserToken': csrfToken || '' },
  });
  if (!response.ok) {
    throw new Error(
      `Could not start the suite (${response.status}). The CI/CD API must be available and your role must allow running tests.`
    );
  }
  const data = await response.json();
  const progressId = data?.result?.links?.progress?.id;
  return { progressId: SYS_ID_RE.test(progressId || '') ? progressId : null, status: data?.result?.status_label || '' };
}

/** { percent, status, message } for a CI/CD progress id. */
export async function readAtfProgress(progressId) {
  if (!SYS_ID_RE.test(progressId || '')) throw new Error('Invalid progress id.');
  const response = await fetch(`/api/sn_cicd/progress/${progressId}`, {
    credentials: 'same-origin',
    headers: await sessionHeaders(),
  });
  if (!response.ok) throw new Error(`Progress check failed (${response.status}).`);
  const result = (await response.json())?.result || {};
  return {
    percent: Number(result.percent_complete) || 0,
    status: result.status_label || result.status || '',
    message: result.status_message || '',
  };
}
