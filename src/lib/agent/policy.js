// Approval policy: which tool calls run on their own and which need a person.
// Reads the tier from toolSchemas.js so a new tool is "write" until someone
// deliberately classifies it otherwise.
import { toolTier, TIERS } from './toolSchemas.js';
import { analyzeScriptRisk, checkReadOnlyScript } from '../scriptSafety.js';
import { isSecurityTable, securityTableBlock, deniedTableBlock, nonAdminBlock } from './guardrails.js';

export const AUTONOMY_LEVELS = [
  { id: 'readonly', label: 'Read only', hint: 'The agent can look and draft, but never run or change anything.' },
  { id: 'ask', label: 'Ask first', hint: 'Dry runs and every change wait for your approval.' },
  { id: 'auto-runs', label: 'Auto dry runs', hint: 'Dry runs go ahead on their own. Changes still ask.' },
];

export const DEFAULT_AUTONOMY = 'ask';

/**
 * Whether writes on this instance get the typed-name confirmation. The environment badge may
 * leave an unrecognised hostname neutral, but a write guard must fail safe: only an instance
 * positively identified as dev, test or stage skips the extra confirmation.
 */
export const isGuardedEnv = (env) => env !== 'dev' && env !== 'test' && env !== 'stage';

/** The tier a specific call really needs. Only ever lowers a tier when the arguments prove nothing is started. */
export function effectiveTier(tool, args = {}) {
  // Polling an ATF run that is already going starts nothing.
  if (tool === 'run_atf' && args?.progressId && !args?.suite) return 'observe';
  return toolTier(tool);
}

// ---- External agents (MCP): a ceiling on what they may even ask for -------------------------------

export const MCP_CEILINGS = [
  { id: 'observe', label: 'Read only', hint: 'Look at pages, records, logs and screenshots. Nothing runs or changes.' },
  { id: 'draft', label: 'Read and draft', hint: 'Also verify and simulate scripts. Nothing runs on the instance.' },
  { id: 'run', label: 'Up to dry runs and tests', hint: 'Also dry runs and ATF suites, each approved by you in the browser.' },
  { id: 'write', label: 'Everything, with approval', hint: 'Also changes. Each one is approved by you in the browser.' },
];
export const DEFAULT_MCP_CEILING = 'write';

/** The ceiling in the settings. The older "read only" switch (mcpAutonomy) maps to "read and draft", what it allowed. */
export function resolveMcpCeiling(settings = {}) {
  if (MCP_CEILINGS.some((c) => c.id === settings?.mcpCeiling)) return settings.mcpCeiling;
  if (settings?.mcpAutonomy === 'readonly') return 'draft';
  return DEFAULT_MCP_CEILING;
}

/** True when a tool of `tier` is allowed under `ceiling`. Unknown values fail closed. */
export function ceilingAllows(ceiling, tier) {
  const c = TIERS.indexOf(ceiling);
  const t = TIERS.indexOf(tier);
  return c >= 0 && t >= 0 && t <= c;
}

export const ceilingLabel = (id) => MCP_CEILINGS.find((c) => c.id === id)?.label || id;

// ---- Sensitive tables and fields -------------------------------------------------------------------

// Tables the agent never reads or writes, whatever the user's ACLs allow.
export const CREDENTIAL_TABLE_RE = /(password|credential|secret|private_?key|certificate|oauth_(entity|credential)|sys_auth|keystore|_key$)/i;
const SECRET_FIELD_RE = /(password|passwd|secret|token|credential|private_?key|api_?key)/i;
// Deleting these loses data or breaks the instance in ways a re-insert cannot repair.
const NO_DELETE = {
  sys_db_object: 'Deleting a table definition drops the table and its data.',
  sys_dictionary: 'Deleting a dictionary entry drops the column and its data.',
  sys_scope: 'Deleting an application scope is not something to do from a chat.',
  sys_app: 'Deleting an application removes everything in it.',
  sys_store_app: 'Deleting an application removes everything in it.',
  sys_plugins: 'Plugins cannot be removed this way.',
  sys_user: 'Deactivate users instead (active=false): deleting one breaks references across the instance.',
};
// Script columns of the tables save_artifact writes: those go through save_artifact so the code is verified.
const ARTIFACT_SCRIPT_COLUMNS = {
  sys_script: ['script'],
  sys_script_include: ['script'],
  sys_script_client: ['script'],
  catalog_script_client: ['script'],
  sys_ui_policy: ['script_true', 'script_false'],
};
const CODE_COLUMN_RE = /^(script|operation_script|processing_script|client_script|script_true|script_false|condition|advanced_condition|html|template|script_plain)$/;
const ROLE_TABLES = new Set(['sys_user_has_role', 'sys_user_grmember', 'sys_group_has_role', 'sys_user_role', 'sys_user_role_contains']);

const RECORD_TOOLS = { create_record: 'create', update_record: 'update', delete_record: 'delete' };

/**
 * What a record write would touch. `block` is a reason to refuse outright; `warnings` go on the approval card.
 * Name-based only, so it runs before anyone is asked; the executor adds dictionary-type checks (password fields).
 * `guard` (resolveGuardrails of the saved settings) and `session` ({securityAdmin}) feed the user-configurable rules:
 * the denied-tables list, and ACL/role tables, which are refused unless an admin allowed them and the user elevated.
 * @param {{op: 'create'|'update'|'delete', table: string, fields?: object, guard?: object, session?: object}} write
 */
export function assessWrite({ op, table, fields = {}, restoring = false, guard = {}, session = {} } = {}) {
  const t = String(table || '').toLowerCase();
  const keys = Object.keys(fields || {});
  const warnings = [];
  if (CREDENTIAL_TABLE_RE.test(t)) return { block: `${table} holds credentials or keys; the agent never reads or changes it.`, warnings };
  const denied = deniedTableBlock(table, guard);
  if (denied) return { block: denied, warnings };
  const security = isSecurityTable(t) ? securityTableBlock(table, guard, session) : null;
  if (security) return { block: security, warnings };
  const secret = keys.find((k) => SECRET_FIELD_RE.test(k));
  if (secret) return { block: `"${secret}" looks like a password or secret; the agent never writes those.`, warnings };
  if (op === 'delete' && NO_DELETE[t]) return { block: NO_DELETE[t], warnings };
  // Undo puts back code that was there before, so the "verify new code with save_artifact" rule does not apply to it.
  const artifactScript = restoring ? null : (ARTIFACT_SCRIPT_COLUMNS[t] || []).find((k) => keys.includes(k));
  if (artifactScript && op !== 'delete') return { block: `Use save_artifact to write ${t}.${artifactScript}: it verifies the script first.`, warnings };

  if (ROLE_TABLES.has(t)) warnings.push('Changes who has which roles or groups: a privilege change.');
  if (t.startsWith('sys_security_acl') || t === 'sys_security_attribute') warnings.push('Changes access control: who can read or change data.');
  if (t === 'sys_properties') warnings.push('System properties apply to the whole instance, immediately.');
  if (t === 'sys_db_object' || t === 'sys_dictionary') warnings.push('Schema change: can add, alter or drop tables and columns.');
  if (t === 'sys_user') warnings.push('Changes a user account.');
  if (t === 'sys_update_set' && op === 'delete') warnings.push('Deleting an update set also deletes the changes captured in it.');
  if (t === 'sys_trigger' || t === 'sysauto_script') warnings.push('Scheduled jobs run code on a schedule.');
  const code = keys.filter((k) => CODE_COLUMN_RE.test(k));
  if (code.length) warnings.push(`Sets ${code.join(', ')}: code or conditions that run on the instance, not checked by NowBuddy.`);
  return { block: null, warnings };
}

/**
 * assessWrite over a record's whole table chain (the table named in the call, the record's real class and its
 * parents), so a parent table name (sys_metadata, task, sys_package) can never hide a blocked child class.
 * The first block wins; warnings are merged.
 */
export function assessWriteChain({ op, tables = [], fields = {}, restoring = false, guard = {}, session = {} } = {}) {
  const warnings = [];
  for (const table of [...new Set(tables.filter(Boolean))]) {
    const verdict = assessWrite({ op, table, fields, restoring, guard, session });
    if (verdict.block) return { block: verdict.block, warnings };
    verdict.warnings.forEach((w) => !warnings.includes(w) && warnings.push(w));
  }
  return { block: null, warnings };
}

/**
 * Why a call is refused before anyone is asked, or null. `ctx` = { guard, session } carries the user's safety settings
 * and what is known about the session; without it the safe defaults apply (ACL and role tables are refused).
 * This is only the early check: the executor repeats it with the session's real roles.
 */
export function writeBlockReason(tool, args = {}, ctx = {}) {
  const { guard = {}, session = {} } = ctx || {};
  const nonAdmin = nonAdminBlock(tool, guard, session);
  if (nonAdmin) return nonAdmin;
  const op = RECORD_TOOLS[tool];
  if (op) return assessWrite({ op, table: args?.table, fields: args?.fields, guard, session }).block;
  // save_artifact only writes configuration tables, but the user's denied list still applies to them.
  if (tool === 'save_artifact') return deniedTableBlock(args?.table, guard);
  return null;
}

/**
 * @returns {'auto'|'ask'|'ask-strong'|'deny'}
 *   ask-strong = a write on a production instance (shown with an extra warning and a typed confirmation)
 */
export function approvalMode({ tool, args, autonomy = DEFAULT_AUTONOMY, isProd = false, guard = {}, session = {} }) {
  const tier = effectiveTier(tool, args);
  if (tier === 'observe' || tier === 'draft') return 'auto';
  if (autonomy === 'readonly') return 'deny';
  if (writeBlockReason(tool, args, { guard, session })) return 'deny';
  if (tier === 'run') {
    // Code that runs on a production (or unrecognised) instance always gets the typed confirmation.
    if (isProd) return 'ask-strong';
    if (autonomy !== 'auto-runs' || tool !== 'dry_run_script') return 'ask';
    // A dry run only intercepts GlideRecord writes, and a script can find its way around that. It goes ahead
    // unasked only when a strict allow-list proves it uses nothing but read-only calls.
    if (!checkReadOnlyScript(args?.code).safe || analyzeScriptRisk(args?.code).hasWrites) return 'ask';
    return 'auto';
  }
  return isProd ? 'ask-strong' : 'ask';
}

// ---- Which instances get the typed confirmation ---------------------------------------------------------

const PROD_LABEL_RE = /\bprod(uction)?\d*\b|\bprd\d*\b|\blive\b|(prod|prd)\d*$/i;

/**
 * The one guard decision for every writer (agent, MCP, My Work, push): the hostname guess, RAISED to prod when
 * the user's own label for the instance says production. A label can never lower the guard.
 * @param {{env: string, label?: string}} input  env from the hostname classification
 * @returns {{env: string, guarded: boolean, raisedByLabel: boolean}}
 */
export function instanceGuard({ env, label = '' } = {}) {
  const raisedByLabel = env !== 'prod' && PROD_LABEL_RE.test(String(label || '').trim());
  const finalEnv = raisedByLabel ? 'prod' : env || 'unknown';
  return { env: finalEnv, guarded: isGuardedEnv(finalEnv), raisedByLabel };
}

/** The sentence a refused call gets back. */
export function denyMessage(tool, args = {}, ctx = {}) {
  const reason = writeBlockReason(tool, args, ctx);
  return reason ? `Not allowed: ${reason}` : 'Not allowed: the agent is in read-only mode. Draft the change for the user instead.';
}

// Approval cards never shorten or drop a value: what is approved is exactly what is shown (the card scrolls).
const fieldText = (v) => (typeof v === 'string' ? v : JSON.stringify(v)) ?? '';
const fieldLines = (fields = {}) =>
  Object.entries(fields || {})
    .map(([k, v]) => {
      const text = fieldText(v);
      return text.includes('\n') ? `${k} =\n  ${text.split('\n').join('\n  ')}` : `${k} = ${text}`;
    })
    .join('\n');

/**
 * Human-readable description of a call for approval cards and the audit log.
 * @returns {{title: string, risk: string, code?: string, detail?: string}}
 */
export function describeCall(tool, args = {}) {
  switch (tool) {
    case 'set_form_field':
      return {
        title: `Set "${args.name}" on the open form`,
        risk: 'Changes the unsaved form only. Nothing is stored until the form is saved.',
        code: String(args.value ?? ''),
      };
    case 'save_form':
      return { title: 'Save the open form', risk: 'Writes the form to the database and fires business rules, flows and notifications, same as pressing Save.' };
    case 'save_artifact': {
      const fields = args.fields || {};
      const verb = args.sysId ? 'Update' : 'Create';
      // Every field except the script itself (shown as code) is listed in full: condition, filter_condition,
      // script_true/false, active, table, when... nothing is ever dropped or shortened.
      const startsInactive = !args.sysId && fields.active === undefined;
      const others = fieldLines(
        Object.fromEntries([...Object.entries(fields).filter(([k]) => k !== 'script'), ...(startsInactive ? [['active', 'false (new records start inactive)']] : [])])
      );
      return {
        title: `${verb} ${args.table}${fields.name ? ` "${fields.name}"` : ''}`,
        risk: 'Writes configuration to this instance. It is captured in the current update set and takes effect immediately.',
        detail: [args.reason, others].filter(Boolean).join('\n\n'),
        code: typeof fields.script === 'string' ? fields.script : undefined,
      };
    }
    case 'dry_run_script':
      return {
        title: 'Dry run a server-side script',
        risk: 'Runs on the instance with GlideRecord writes intercepted. Reads, log output, and outbound calls or events still happen.',
        code: String(args.code ?? ''),
      };
    case 'undo_last_write':
      return { title: 'Undo the last change this agent made', risk: 'Restores the previous values it recorded, deletes a record it created, or re-inserts one it deleted.' };
    case 'navigate':
      return {
        title: `Leave this page and open ${args.path || args.table || 'another page'}`,
        risk: 'This page is a workspace or portal form. NowBuddy cannot see whether it has unsaved changes; leaving it would lose them.',
      };
    case 'screenshot':
      return {
        title: 'Send a screenshot of this tab to the external agent',
        risk: 'The image is NOT redacted: everything visible in this tab, including any secret on screen, goes to the agent.',
      };
    case 'run_ui_steps':
      return {
        title: `Drive the page (${(args.steps || []).length} steps)`,
        risk: 'Clicks and types on the live page as you.',
        detail: (args.steps || []).map((s, i) => `${i + 1}. ${s.action} ${s.target || ''}${s.value ? ` = ${s.value}` : ''}`).join('\n'),
      };
    case 'click_ui_action':
      return {
        title: `Click "${args.action}" on the open form`,
        risk: 'Runs the UI action as if you clicked it: it can save the form (with any unsaved edits), change the record, start flows or send notifications. NowBuddy cannot undo it.',
      };
    case 'create_record':
      return {
        title: `Create a ${args.table} record`,
        risk: 'Inserts a record as you. Business rules and flows on the table run. Undo deletes it.',
        detail: [args.reason, fieldLines(args.fields)].filter(Boolean).join('\n\n'),
      };
    case 'update_record':
      return {
        title: `Update ${args.table} ${args.sysId || ''}`.trim(),
        risk: 'Changes the record as you. Business rules and flows on the table run. Undo restores the previous values.',
        detail: [args.reason, fieldLines(args.fields)].filter(Boolean).join('\n\n'),
      };
    case 'delete_record':
      return {
        title: `Delete ${args.table} ${args.sysId || ''}`.trim(),
        risk: 'Deletes the record as you. Delete rules may also delete or clear related records.',
        detail: args.reason || undefined,
      };
    case 'run_background_script':
      return {
        title: 'Run a server-side script for real',
        risk: 'Runs on the instance as you, in the global scope, with full effect: writes, deletes, events and outbound calls really happen. NowBuddy cannot undo it.',
        detail: args.reason || undefined,
        code: String(args.code ?? ''),
      };
    case 'switch_update_set':
      return { title: `Switch the current update set to "${args.updateSet}"`, risk: 'New configuration changes in this session are captured in that update set. Undo switches back.' };
    case 'switch_application_scope':
      return { title: `Switch the application scope to "${args.scope}"`, risk: 'New configuration in this session is created in that application. Undo switches back.' };
    case 'impersonate_user':
      return {
        title: `Impersonate "${args.user}"`,
        risk: 'Everything in this browser session then runs as that user, with their roles and data access, until impersonation ends. The page reloads.',
        detail: args.reason || undefined,
      };
    case 'end_impersonation':
      return { title: 'End impersonation', risk: 'Returns the session to your own user. The page reloads.' };
    case 'run_atf':
      return {
        title: `Run the ATF suite "${args.suite}"`,
        risk: 'Runs the tests on this instance. Test steps create and change records (rolled back afterwards) and can call out or send notifications.',
      };
    default:
      return { title: tool, risk: 'Runs a tool that is not classified as read-only.', detail: JSON.stringify(args, null, 1) };
  }
}
