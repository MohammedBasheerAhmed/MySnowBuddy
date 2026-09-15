// Deterministic (non-AI) conflict detection. Runs entirely locally against
// records fetched from the current instance via the Table API, under the
// user's own session/permissions.
import { queryTable } from './tableApi.js';

// Artifact types we know how to check, keyed by the ServiceNow table.
const SUPPORTED = {
  sys_script: {
    label: 'Business Rule',
    fields: ['sys_id', 'name', 'collection', 'when', 'order', 'condition', 'active', 'filter_condition'],
    scopeField: 'collection',
  },
  sys_security_acl: {
    label: 'ACL',
    fields: ['sys_id', 'name', 'operation', 'condition', 'active', 'admin_overrides'],
    scopeField: 'name',
  },
  sys_script_include: {
    label: 'Script Include',
    fields: ['sys_id', 'name', 'api_name', 'active'],
    scopeField: null,
  },
  sys_script_client: {
    label: 'Client Script',
    fields: ['sys_id', 'name', 'table', 'type', 'order', 'condition', 'active'],
    scopeField: 'table',
  },
};

export function isConflictCheckSupported(table) {
  return Boolean(SUPPORTED[table]);
}

export function supportedTables() {
  return Object.keys(SUPPORTED);
}

// Fetch the sibling records that could plausibly conflict with the current one.
export async function fetchRelatedRecords(table, current) {
  const def = SUPPORTED[table];
  if (!def) return [];

  let query = 'active=true';
  if (def.scopeField && current?.[def.scopeField]) {
    query += `^${def.scopeField}=${current[def.scopeField]}`;
  }
  if (current?.sys_id) {
    query += `^sys_id!=${current.sys_id}`;
  }

  return queryTable(table, query, def.fields);
}

export async function fetchCurrentRecord(table, sysId) {
  const def = SUPPORTED[table];
  if (!def || !sysId) return null;
  const results = await queryTable(table, `sys_id=${sysId}`, def.fields);
  return results[0] || null;
}

function normalize(value) {
  return (value || '').toString().trim().toLowerCase();
}

export function runDeterministicChecks(table, current, related) {
  const findings = [];
  if (!current) return findings;

  const currentName = normalize(current.name);

  related.forEach((other) => {
    // Naming collision — same display name as another active artifact.
    if (currentName && normalize(other.name) === currentName) {
      findings.push({
        severity: 'medium',
        type: 'Naming collision',
        message: `Another active ${SUPPORTED[table].label} shares the name "${other.name}".`,
        recordSysId: other.sys_id,
        recordName: other.name,
      });
    }

    if (table === 'sys_script' || table === 'sys_script_client') {
      const sameTrigger =
        normalize(other.when || other.type) === normalize(current.when || current.type);
      const sameOrder = String(other.order ?? '') === String(current.order ?? '');
      const sameCondition = normalize(other.condition) === normalize(current.condition);

      if (sameTrigger && sameOrder) {
        findings.push({
          severity: 'high',
          type: 'Execution order collision',
          message:
            `"${other.name}" runs at the same trigger point (${other.when || other.type}) ` +
            `with the same order (${other.order}). Execution sequence between them is not deterministic.`,
          recordSysId: other.sys_id,
          recordName: other.name,
        });
      } else if (sameTrigger && sameCondition && current.condition) {
        findings.push({
          severity: 'medium',
          type: 'Duplicate trigger condition',
          message: `"${other.name}" has an identical condition and trigger point — possible duplicated logic.`,
          recordSysId: other.sys_id,
          recordName: other.name,
        });
      }
    }

    if (table === 'sys_security_acl') {
      const sameOperation = normalize(other.operation) === normalize(current.operation);
      if (sameOperation) {
        const sameCondition = normalize(other.condition) === normalize(current.condition);
        findings.push({
          severity: sameCondition ? 'medium' : 'low',
          type: 'Overlapping ACL',
          message:
            `"${other.name}" also defines the "${other.operation}" operation` +
            (sameCondition
              ? ' with an identical condition — one of them is likely redundant.'
              : '. ACLs on the same operation are evaluated together; verify the combined effect.'),
          recordSysId: other.sys_id,
          recordName: other.name,
        });
      }
    }
  });

  return findings;
}
