// Read-only security and configuration audit.
//
// SCOPE: this ONLY reads configuration the signed-in user is already allowed
// to read, through the standard Table API, and reports on it. It does not
// attempt to bypass ACLs, escalate privilege, or exploit anything it finds.
// It is a review aid for administrators auditing their own instance.

import { queryTable } from './tableApi.js';

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

/** ACLs that grant access with no role, no condition and no script. */
async function auditOpenAcls(findings) {
  const rows = await queryTable(
    'sys_security_acl',
    'active=true^ORDERBYname',
    ['sys_id', 'name', 'operation', 'admin_overrides', 'script', 'condition', 'description'],
    { limit: 500 }
  );

  // The roles M2M lives on sys_security_acl_role, so fetch it separately and
  // index by ACL rather than relying on a dot-walked field.
  const roleRows = await queryTable(
    'sys_security_acl_role',
    '',
    ['sys_security_acl', 'sys_user_role'],
    { limit: 1000 }
  ).catch(() => []);

  const aclsWithRoles = new Set(
    roleRows.map((r) => r.sys_security_acl?.value || r.sys_security_acl).filter(Boolean)
  );

  rows.forEach((acl) => {
    const hasRole = aclsWithRoles.has(acl.sys_id);
    const hasCondition = Boolean((acl.condition || '').trim());
    const hasScript = Boolean((acl.script || '').trim());

    if (hasRole || hasCondition || hasScript) return;

    findings.push(
      finding(
        acl.operation === 'read' ? SEVERITY.MEDIUM : SEVERITY.HIGH,
        'ACL',
        `ACL "${acl.name}" (${acl.operation}) grants access with no role, condition or script.`,
        'Any authenticated user satisfies this rule. Confirm it is intentional.',
        `/sys_security_acl.do?sys_id=${acl.sys_id}`
      )
    );
  });

  return rows.length;
}

/** Publicly reachable pages and processors. */
async function auditPublicPages(findings) {
  const rows = await queryTable('sys_public', 'active=true', ['sys_id', 'page', 'description'], {
    limit: 200,
  }).catch(() => []);

  rows.forEach((row) => {
    findings.push(
      finding(
        SEVERITY.MEDIUM,
        'Public access',
        `Page "${row.page}" is publicly accessible without authentication.`,
        row.description || 'Confirm this page exposes no sensitive data.',
        `/sys_public.do?sys_id=${row.sys_id}`
      )
    );
  });

  return rows.length;
}

/** Service Portal widgets flagged public. */
async function auditPublicWidgets(findings) {
  const rows = await queryTable('sp_widget', 'public=true', ['sys_id', 'name', 'id'], {
    limit: 200,
  }).catch(() => []);

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
  }).catch(() => []);

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
  ).catch(() => []);

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
async function auditOpenRestOperations(findings) {
  const rows = await queryTable(
    'sys_ws_operation',
    'active=true',
    ['sys_id', 'name', 'http_method', 'relative_path', 'requires_authentication', 'requires_acl_authorization'],
    { limit: 300 }
  ).catch(() => []);

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

  return rows.length;
}

/**
 * Run the full audit.
 * @returns {Promise<{findings:Array, counts:object, errors:Array}>}
 */
export async function runSecurityAudit() {
  const findings = [];
  const errors = [];
  const counts = {};

  const checks = [
    ['Open ACLs', auditOpenAcls],
    ['Public pages', auditPublicPages],
    ['Public widgets', auditPublicWidgets],
    ['System properties', auditProperties],
    ['Admin roles', auditAdminRoles],
    ['Scripted REST', auditOpenRestOperations],
  ];

  const settled = await Promise.allSettled(checks.map(([, fn]) => fn(findings)));

  settled.forEach((outcome, index) => {
    const [label] = checks[index];
    if (outcome.status === 'fulfilled') {
      counts[label] = outcome.value;
    } else {
      errors.push({ check: label, error: outcome.reason?.message || String(outcome.reason) });
    }
  });

  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category));

  return { findings, counts, errors };
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

  const errorText = errors.length
    ? `\n\nChecks that could not run (usually insufficient read access): ${errors
        .map((e) => `${e.check} (${e.error})`)
        .join('; ')}`
    : '';

  return `${header}\n${scanned}\n\n${body}${errorText}`;
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
