// Lay out a scope's artifacts as plain files (one script per file) for git or code review.

export const SCOPE_ARTIFACTS = [
  { table: 'sys_script_include', dir: 'script_includes', label: 'Script Includes', scripts: [['script', 'js']], meta: ['name', 'api_name', 'active', 'access', 'client_callable', 'description'] },
  { table: 'sys_script', dir: 'business_rules', label: 'Business Rules', scripts: [['script', 'js']], meta: ['name', 'collection', 'when', 'order', 'active', 'condition', 'filter_condition'] },
  { table: 'sys_script_client', dir: 'client_scripts', label: 'Client Scripts', scripts: [['script', 'js']], meta: ['name', 'table', 'type', 'ui_type', 'active', 'field', 'condition'] },
  { table: 'sys_ui_action', dir: 'ui_actions', label: 'UI Actions', scripts: [['script', 'js']], meta: ['name', 'table', 'action_name', 'active', 'client', 'condition', 'onclick'] },
  { table: 'sys_ui_script', dir: 'ui_scripts', label: 'UI Scripts', scripts: [['script', 'js']], meta: ['name', 'active', 'global', 'description'] },
  { table: 'sys_ui_policy', dir: 'ui_policies', label: 'UI Policies', scripts: [['script_true', 'js'], ['script_false', 'js']], meta: ['short_description', 'table', 'active', 'conditions', 'on_load'] },
  { table: 'sys_security_acl', dir: 'acls', label: 'ACLs', scripts: [['script', 'js']], meta: ['name', 'operation', 'active', 'admin_overrides', 'condition'] },
  { table: 'sysauto_script', dir: 'scheduled_scripts', label: 'Scheduled Script Executions', scripts: [['script', 'js']], meta: ['name', 'active', 'run_type'] },
  { table: 'sys_script_fix', dir: 'fix_scripts', label: 'Fix Scripts', scripts: [['script', 'js']], meta: ['name', 'description'] },
  { table: 'sys_script_email', dir: 'email_scripts', label: 'Notification Email Scripts', scripts: [['script', 'js']], meta: ['name'] },
  { table: 'sysevent_script_action', dir: 'script_actions', label: 'Script Actions', scripts: [['script', 'js']], meta: ['name', 'event_name', 'active', 'order'] },
  { table: 'sys_ws_operation', dir: 'scripted_rest_operations', label: 'Scripted REST Resources', scripts: [['operation_script', 'js']], meta: ['name', 'http_method', 'relative_path', 'active', 'web_service_definition'] },
  { table: 'sys_ui_page', dir: 'ui_pages', label: 'UI Pages', scripts: [['html', 'html'], ['client_script', 'js'], ['processing_script', 'js']], meta: ['name', 'description', 'direct', 'category'] },
  { table: 'sp_widget', dir: 'widgets', label: 'Service Portal Widgets', scripts: [['template', 'html'], ['css', 'css'], ['script', 'js'], ['client_script', 'js'], ['link', 'js']], meta: ['name', 'id', 'description', 'option_schema'] },
];

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeFileName(name) {
  let out = String(name || '')
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (!out) out = 'unnamed';
  if (RESERVED.test(out)) out = `_${out}`;
  return out.slice(0, 100);
}

/** Fields to request for an artifact definition. */
export function scopeFields(def) {
  return ['sys_id', 'sys_updated_on', ...new Set([...def.meta, ...def.scripts.map(([f]) => f)])];
}

function sortedJson(obj) {
  const sorted = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      sorted[k] = obj[k];
    });
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

const lf = (text) => String(text).replace(/\r\n?/g, '\n');

/**
 * @param {string} scope scope name, used as the top-level folder
 * @param {Array<{def: object, records: object[]}>} sets records fetched per artifact definition
 * @returns {Array<{path: string, content: string}>}
 */
export function buildScopeFiles(scope, sets) {
  const root = safeFileName(scope);
  const files = [];
  const counts = {};

  sets.forEach(({ def, records }) => {
    const used = new Set();
    records.forEach((record) => {
      const nameField = def.meta[0];
      let base = safeFileName(record[nameField] || record.sys_id);
      if (used.has(base.toLowerCase())) base = `${base}__${String(record.sys_id).slice(0, 8)}`;
      used.add(base.toLowerCase());

      const prefix = `${root}/${def.dir}/${base}`;
      const withContent = def.scripts.filter(([field]) => String(record[field] || '').trim());
      const multiple = def.scripts.length > 1;

      withContent.forEach(([field, ext]) => {
        files.push({
          path: multiple ? `${prefix}.${field}.${ext}` : `${prefix}.${ext}`,
          content: `${lf(record[field]).replace(/\n*$/, '')}\n`,
        });
      });

      const meta = {};
      [...def.meta, 'sys_id', 'sys_updated_on'].forEach((field) => {
        if (record[field] !== undefined) meta[field] = record[field];
      });
      files.push({ path: `${prefix}.meta.json`, content: sortedJson(meta) });
    });
    counts[def.label] = records.length;
  });

  const summary = Object.entries(counts)
    .map(([label, n]) => `- ${label}: ${n}`)
    .join('\n');
  files.push({
    path: `${root}/README.txt`,
    content: `Scope export of ${scope}\nGenerated ${new Date().toISOString()} by MySnowBuddy\n\n${summary}\n\nScripts use LF line endings. Each record has a .meta.json with its non-script fields.\n`,
  });
  return files;
}
