// Definitions of the artifact types Instance Compare knows how to diff.
// `key` is the field used to match records across instances (NOT sys_id, which
// differs between instances for the same logical artifact).
export const COMPARE_ARTIFACTS = {
  sys_script: {
    label: 'Business Rules',
    key: 'name',
    fields: ['sys_id', 'name', 'collection', 'when', 'order', 'active', 'condition', 'script'],
    compareFields: ['collection', 'when', 'order', 'active', 'condition', 'script'],
  },
  sys_script_include: {
    label: 'Script Includes',
    key: 'name',
    fields: ['sys_id', 'name', 'api_name', 'active', 'access', 'script'],
    compareFields: ['api_name', 'active', 'access', 'script'],
  },
  sys_security_acl: {
    label: 'ACLs',
    key: 'name',
    fields: ['sys_id', 'name', 'operation', 'active', 'admin_overrides', 'condition', 'script'],
    compareFields: ['operation', 'active', 'admin_overrides', 'condition', 'script'],
  },
  sys_script_client: {
    label: 'Client Scripts',
    key: 'name',
    fields: ['sys_id', 'name', 'table', 'type', 'order', 'active', 'condition', 'script'],
    compareFields: ['table', 'type', 'order', 'active', 'condition', 'script'],
  },
  sys_properties: {
    label: 'System Properties',
    key: 'name',
    fields: ['sys_id', 'name', 'value', 'type', 'description'],
    compareFields: ['value', 'type'],
  },
  sys_hub_flow: {
    label: 'Flows',
    key: 'name',
    fields: ['sys_id', 'name', 'active', 'description', 'type'],
    compareFields: ['active', 'type', 'description'],
  },
};

export function artifactOptions() {
  return Object.entries(COMPARE_ARTIFACTS).map(([table, def]) => ({ table, label: def.label }));
}
