// Read-only security and configuration audit.
//
// SCOPE: this ONLY reads configuration the signed-in user is already allowed
// to read, through the standard Table API, and reports on it. It does not
// attempt to bypass ACLs, escalate privilege, or exploit anything it finds.
// It is a review aid for administrators auditing their own instance.

import { queryTable, queryAll } from './tableApi.js';

export const SEVERITY = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/**
 * System properties whose value materially weakens the instance's security
 * posture. `risky` describes the value that should raise a finding.
 */
const RISKY_PROPERTIES = [
  {
    name: 'glide.basicauth.required.soap',
    risky: (v) => v === 'false',
    severity: SEVERITY.HIGH,
    message: 'SOAP endpoints do not require basic authentication.',
  },
  {
    name: 'glide.basicauth.required.strict',
    risky: (v) => v === 'false',
    severity: SEVERITY.MEDIUM,
    message: 'Strict basic authentication is disabled for inbound requests.',
  },
  {
    name: 'glide.ui.security.allow_codetag',
    risky: (v) => v === 'true',
    severity: SEVERITY.HIGH,
    message: 'Code tags are allowed in UI content, enabling stored script injection.',
  },
  {
    name: 'glide.script.block.client.globals',
    risky: (v) => v === 'false',
    severity: SEVERITY.MEDIUM,
    message: 'Client-side global script blocking is disabled.',
  },
  {
    name: 'glide.security.use_csrf_token',
    risky: (v) => v === 'false',
    severity: SEVERITY.HIGH,
    message: 'CSRF token validation is disabled.',
  },
  {
    name: 'glide.security.file.mime_type.validation',
    risky: (v) => v === 'false',
    severity: SEVERITY.MEDIUM,
    message: 'Attachment MIME type validation is disabled.',
  },
  {
    name: 'com.glide.communications.httpclient.verify_hostname',
    risky: (v) => v === 'false',
    severity: SEVERITY.HIGH,
    message: 'Outbound TLS hostname verification is disabled.',
  },
  {
    name: 'glide.email.read.active',
    risky: () => false,
    severity: SEVERITY.LOW,
    message: 'Inbound email processing is enabled (informational).',
  },
];

function finding(severity, category, message, detail, link) {
  return { severity, category, message, detail, link };
}

// Caps for the open-ACL check. When one is hit the check says it is incomplete; an ACL whose
// role rows might have been cut off is never reported as open.
export const ACL_CANDIDATE_CAP = 3000;
const ACL_ROLE_CHUNK = 40;
const ACL_ROLE_CHUNK_LIMIT = 1000;

const refValue = (v) => (v && typeof v === 'object' ? v.value || '' : String(v ?? ''));
const SYS_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Name of a reference column read through its dot-walked name field ("operation.name"),
 * falling back to the raw value on releases where the column is a plain choice. A bare
 * sys_id is never shown as a name.
 */
function refName(row, column) {
  const named = refValue(row[`${column}.name`]).trim();
  if (named) return named;
  const raw = refValue(row[column]).trim();
  return raw && !SYS_ID_RE.test(raw) ? raw : '';
}

/** Severity of an open ACL by operation: writes are high, reads and anything unrecognised medium. */
export function openAclSeverity(operation) {
  return ['write', 'create', 'delete'].includes(String(operation || '').toLowerCase()) ? SEVERITY.HIGH : SEVERITY.MEDIUM;
}

/** Only record ACLs are judged: other types (REST, UI page, client-callable...) follow other rules. */
export function isRecordAcl(row) {
  const type = refName(row, 'type');
  return !type || type === 'record';
}

/**
 * Optional `keepRecords(table, sysIds)` narrows record-level checks (open ACLs, public pages,
 * public widgets, scripted REST) to the records a caller cares about, e.g. custom records only.
 * It resolves to a Set of the sys_ids to keep; when it fails, the check fails (reported as an error).
 */
async function keepOnly(options, table, rows) {
  if (!options?.keepRecords || !rows.length) return rows;
  const keep = await options.keepRecords(table, rows.map((r) => refValue(r.sys_id)));
  return rows.filter((r) => keep.has(refValue(r.sys_id)));
}

/**
 * Record ACLs that grant access with no role, no condition and no script.
 *
 * Only ACLs without a condition and a script can be open, so the instance filters those first
 * (re-checked here). Roles are then read for those candidates only, in chunks, from
 * sys_security_acl_role. A role lookup that fails makes the whole check fail (reported as an
 * error), never "every ACL is open". `operation` and `type` are references, so their names are
 * read through the dot-walked name fields.
 */
async function auditOpenAcls(findings, incomplete, options) {
  const rows = await queryAll(
    'sys_security_acl',
    'active=true^conditionISEMPTY^scriptISEMPTY^ORDERBYname',
    // decision_type / security_attribute exist on newer releases only; absent columns are simply not returned.
    ['sys_id', 'name', 'operation', 'operation.name', 'type', 'type.name', 'admin_overrides', 'script', 'condition', 'description', 'decision_type', 'security_attribute'],
    { max: ACL_CANDIDATE_CAP, pageSize: 500 }
  );
  if (rows.length >= ACL_CANDIDATE_CAP) {
    incomplete.push(`only the first ${ACL_CANDIDATE_CAP} ACLs without a condition or script were checked`);
  }

  const candidates = await keepOnly(
    options,
    'sys_security_acl',
    rows.filter(
      (acl) =>
        isRecordAcl(acl) &&
        !String(acl.condition || '').trim() &&
        !String(acl.script || '').trim() &&
        !refValue(acl.security_attribute) &&
        String(acl.decision_type || 'allow').toLowerCase() !== 'deny'
    )
  );

  // Roles for the candidates only. A chunk whose answer may be cut off (cap reached) or does not
  // match what was asked for leaves its ACLs "unknown" rather than "open".
  const withRoles = new Set();
  const unknown = new Set();
  const ids = candidates.map((acl) => acl.sys_id);
  for (let i = 0; i < ids.length; i += ACL_ROLE_CHUNK) {
    const chunk = ids.slice(i, i + ACL_ROLE_CHUNK);
    const asked = new Set(chunk);
    // eslint-disable-next-line no-await-in-loop -- sequential chunks keep the load on the instance low.
    const roleRows = await queryTable('sys_security_acl_role', `sys_security_aclIN${chunk.join(',')}`, ['sys_security_acl', 'sys_user_role'], {
      limit: ACL_ROLE_CHUNK_LIMIT,
    });
    const aclIds = roleRows.map((r) => refValue(r.sys_security_acl)).filter(Boolean);
    if (roleRows.length >= ACL_ROLE_CHUNK_LIMIT || aclIds.some((id) => !asked.has(id))) {
      chunk.forEach((id) => unknown.add(id));
    }
    aclIds.forEach((id) => withRoles.add(id));
  }

  let skipped = 0;
  candidates.forEach((acl) => {
    if (withRoles.has(acl.sys_id)) return;
    if (unknown.has(acl.sys_id)) {
      skipped += 1;
      return;
    }

    const operation = refName(acl, 'operation');
    findings.push(
      finding(
        openAclSeverity(operation),
        'ACL',
        `ACL "${acl.name}" (${operation || 'unknown operation'}) grants access with no role, condition or script.`,
        'Any authenticated user satisfies this rule. Confirm it is intentional.',
        `/sys_security_acl.do?sys_id=${acl.sys_id}`
      )
    );
  });

  if (skipped) {
    incomplete.push(`${skipped} ACL(s) not judged: their role rows could not be read completely, so they are not reported as open`);
  }
  return rows.length;
}

/** Publicly reachable pages and processors. */
// The checks below let a failed read fail the check (it is listed in `errors`) instead of
// reporting "nothing found".
async function auditPublicPages(findings, incomplete, options) {
  const rows = await keepOnly(options, 'sys_public', await queryTable('sys_public', 'active=true', ['sys_id', 'page'], { limit: 200 }));

  rows.forEach((row) => {
    findings.push(
      finding(
        SEVERITY.MEDIUM,
        'Public access',
        `Page "${row.page}" is publicly accessible without authentication.`,
        'Confirm this page exposes no sensitive data.',
        `/sys_public.do?sys_id=${row.sys_id}`
      )
    );
  });

  return rows.length;
}

/** Service Portal widgets flagged public. */
async function auditPublicWidgets(findings, incomplete, options) {
  const rows = await keepOnly(options, 'sp_widget', await queryTable('sp_widget', 'public=true', ['sys_id', 'name', 'id'], { limit: 200 }));

  rows.forEach((row) => {
    findings.push(
      finding(
        SEVERITY.MEDIUM,
        'Public access',
        `Portal widget "${row.name}" is public.`,
        'Its server script runs for unauthenticated visitors. Verify it performs no privileged reads.',
        `/sp_widget.do?sys_id=${row.sys_id}`
      )
    );
  });

  return rows.length;
}

/** Risky system property values. */
async function auditProperties(findings) {
  const names = RISKY_PROPERTIES.map((p) => p.name).join(',');
  const rows = await queryTable('sys_properties', `nameIN${names}`, ['sys_id', 'name', 'value'], {
    limit: 100,
  });

  rows.forEach((row) => {
    const def = RISKY_PROPERTIES.find((p) => p.name === row.name);
    if (!def) return;
    const value = String(row.value ?? '').trim().toLowerCase();
    if (!def.risky(value)) return;

    findings.push(
      finding(
        def.severity,
        'System property',
        `${row.name} = ${row.value}`,
        def.message,
        `/sys_properties.do?sys_id=${row.sys_id}`
      )
    );
  });

  return rows.length;
}

/** Count of accounts holding admin, plus any active non-locked service accounts. */
async function auditAdminRoles(findings) {
  const rows = await queryTable(
    'sys_user_has_role',
    'role.name=admin^user.active=true',
    ['sys_id', 'user', 'role', 'granted_by'],
    { limit: 300 }
  );

  if (rows.length > 20) {
    findings.push(
      finding(
        SEVERITY.MEDIUM,
        'Roles',
        `${rows.length} active users hold the admin role.`,
        'Large admin populations are a common audit finding. Review whether all of them still need it.',
        '/sys_user_has_role_list.do?sysparm_query=role.name%3Dadmin'
      )
    );
  }

  return rows.length;
}

/** Scripted REST resources that do not require authentication. */
async function auditOpenRestOperations(findings, incomplete, options) {
  const all = await queryTable(
    'sys_ws_operation',
    'active=true',
    ['sys_id', 'name', 'http_method', 'relative_path', 'requires_authentication', 'requires_acl_authorization'],
    { limit: 300 }
  );
  const rows = await keepOnly(
    options,
    'sys_ws_operation',
    all.filter((row) => String(row.requires_authentication ?? 'true') === 'false' || String(row.requires_acl_authorization ?? 'true') === 'false')
  );

  rows.forEach((row) => {
    const noAuth = String(row.requires_authentication ?? 'true') === 'false';
    const noAcl = String(row.requires_acl_authorization ?? 'true') === 'false';
    if (!noAuth && !noAcl) return;

    findings.push(
      finding(
        noAuth ? SEVERITY.HIGH : SEVERITY.MEDIUM,
        'Scripted REST',
        `"${row.name}" (${row.http_method}) has ${noAuth ? 'authentication' : 'ACL authorization'} disabled.`,
        `Path: ${row.relative_path || 'unknown'}. Anything it returns is reachable with reduced checks.`,
        `/sys_ws_operation.do?sys_id=${row.sys_id}`
      )
    );
  });

  return all.length;
}

/**
 * Run the full audit.
 * @param {{keepRecords?: (table: string, sysIds: string[]) => Promise<Set<string>>}} [options]
 *   keepRecords narrows the record-level checks (see keepOnly); properties and admin roles stay instance-wide.
 * @returns {Promise<{findings:Array, counts:object, errors:Array, incomplete:Array}>}
 *   incomplete: checks that ran but hit a cap ({check, reason}); they are also listed in `errors`
 *   (with incomplete: true) so every consumer shows them.
 */
export async function runSecurityAudit(options = {}) {
  const findings = [];
  const errors = [];
  const incomplete = [];
  const counts = {};

  const checks = [
    ['Open ACLs', auditOpenAcls],
    ['Public pages', auditPublicPages],
    ['Public widgets', auditPublicWidgets],
    ['System properties', auditProperties],
    ['Admin roles', auditAdminRoles],
    ['Scripted REST', auditOpenRestOperations],
  ];

  const notes = checks.map(() => []);
  const settled = await Promise.allSettled(checks.map(([, fn], index) => fn(findings, notes[index], options)));

  settled.forEach((outcome, index) => {
    const [label] = checks[index];
    if (outcome.status === 'fulfilled') {
      counts[label] = outcome.value;
      notes[index].forEach((reason) => {
        incomplete.push({ check: label, reason });
        errors.push({ check: label, error: `incomplete: ${reason}`, incomplete: true });
      });
    } else {
      errors.push({ check: label, error: outcome.reason?.message || String(outcome.reason) });
    }
  });

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));

  return { findings, counts, errors, incomplete };
}

export function formatAuditFindings({ findings, counts, errors }) {
  const summary = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});

  const header =
    `Security audit: ${findings.length} finding(s) - ` +
    `${summary.high || 0} high, ${summary.medium || 0} medium, ${summary.low || 0} low.`;

  const scanned = Object.entries(counts)
    .map(([label, n]) => `${label}: ${n} record(s) scanned`)
    .join(', ');

  const body = findings.length
    ? findings
        .map((f) => `[${f.severity.toUpperCase()}] ${f.category}: ${f.message}\n    ${f.detail}`)
        .join('\n\n')
    : 'No findings from the deterministic checks.';

  const failed = errors.filter((e) => !e.incomplete);
  const partial = errors.filter((e) => e.incomplete);
  const errorText = failed.length
    ? `\n\nChecks that could not run (usually insufficient read access): ${failed
        .map((e) => `${e.check} (${e.error})`)
        .join('; ')}`
    : '';
  const partialText = partial.length
    ? `\n\nChecks that ran only partly (results are incomplete): ${partial.map((e) => `${e.check} (${e.error.replace(/^incomplete: /, '')})`).join('; ')}`
    : '';

  return `${header}\n${scanned}\n\n${body}${errorText}${partialText}`;
}

export function buildAuditPrompt(result) {
  return (
    'You are a ServiceNow security reviewer. Below are deterministic findings from a read-only ' +
    'configuration audit of an instance. Prioritise them by real exploitability and business impact ' +
    '(not just severity label), explain the concrete attack or failure each one enables, and give ' +
    'specific remediation steps. Explicitly call out any finding that is likely a false positive or ' +
    'an accepted design choice.\n\n' +
    formatAuditFindings(result).slice(0, 12000)
  );
}
