// Turns the agent loop's event stream into the state the timeline renders.
// Pure and serialisable: a finished run is saved with the chat history, so
// heavy payloads are dropped and long text is clipped here.

const MAX_STEP_TEXT = 1200;
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}...` : s || '');

// label(args) is the sentence shown on the step; icon names exist in Icon.jsx.
const TOOLS = {
  get_skill_guide: { icon: 'book', label: (a) => `Loading the ${a.skill === 'server-script' ? 'server' : a.skill === 'client-script' ? 'client' : 'matching'} script guide` },
  get_page_context: { icon: 'eye', label: () => 'Reading the page you are on' },
  get_form_model: { icon: 'form', label: () => 'Reading the live form' },
  get_field_state: { icon: 'form', label: (a) => `Checking field ${a.name}` },
  get_schema: { icon: 'table', label: (a) => `Reading the ${a.table} dictionary` },
  query_table: { icon: 'database', label: (a) => `Querying ${a.table}${a.query ? ` where ${clip(a.query, 60)}` : ''}` },
  count_records: { icon: 'database', label: (a) => `Counting ${a.table} records` },
  read_artifact: { icon: 'code', label: (a) => `Reading ${a.name || a.table}` },
  list_logic_for_table: { icon: 'layers', label: (a) => `Listing what already runs on ${a.table}` },
  search_code: { icon: 'search', label: (a) => `Searching all scripts for "${clip(a.term, 40)}"` },
  read_logs: { icon: 'log', label: () => 'Reading recent errors' },
  lookup_api: { icon: 'book', label: (a) => `Looking up ${a.query}` },
  verify_script: { icon: 'shield', label: (a) => `Verifying the ${String(a.kind || 'script').replace(/_/g, ' ')}` },
  test_client_script: { icon: 'flask', label: (a) => `Simulating ${a.clientType || 'the client script'} in the sandbox` },
  dry_run_script: { icon: 'play', label: () => 'Dry-running the script on the instance' },
  set_form_field: { icon: 'edit', label: (a) => `Setting ${a.name} on the form` },
  save_form: { icon: 'save', label: () => 'Saving the form' },
  save_artifact: { icon: 'save', label: (a) => `${a.sysId ? 'Updating' : 'Creating'} ${a.fields?.name || a.fields?.short_description || a.table}` },
  undo_last_write: { icon: 'undo', label: () => 'Undoing the last change' },
  run_ui_steps: { icon: 'cursor', label: (a) => `Driving the page (${(a.steps || []).length} steps)` },
  read_page: { icon: 'eye', label: () => 'Reading the screen' },
  navigate: { icon: 'monitor', label: (a) => `Opening ${a.path ? clip(a.path, 60) : a.sysId ? `${a.table} record` : a.newRecord ? `a new ${a.table}` : `the ${a.table} list`}` },
  get_instance_info: { icon: 'settings', label: () => 'Checking the instance and session' },
  explain_access: { icon: 'lock', label: (a) => `Explaining ${a.operation || 'read'} access to ${a.field ? `${a.table}.${a.field}` : a.table}${a.user && a.user !== 'me' ? ` for ${clip(a.user, 30)}` : ''}` },
  explain_field: { icon: 'xray', label: (a) => `Looking at what controls ${a.table ? `${a.table}.` : ''}${a.field}` },
  check_update_set: { icon: 'layers', label: () => 'Checking the update set before commit' },
  scan_instance_health: { icon: 'pulse', label: (a) => `Scanning ${a.mode === 'recent' ? `changes from the last ${a.days} days` : a.mode === 'updateset' ? 'the update set' : a.mode === 'scope' ? 'the application' : 'the instance'} for health issues` },
  explain_email: { icon: 'mail', label: (a) => `Tracing why the email${a.notification ? ` "${clip(a.notification, 40)}"` : ''} was or was not sent${a.table ? ` for ${a.table}` : ''}` },
  explain_process: { icon: 'flow', label: (a) => `Checking the flows, approvals and SLAs on ${a.table ? `the ${a.table} record` : 'the open record'}` },
  map_table: { icon: 'graph', label: (a) => `Mapping how ${a.table || 'the open table'} relates to other tables${a.showSystem ? ' (including system tables)' : ''}` },
  find_dotwalk_path: { icon: 'braces', label: (a) => `Finding the dot-walk path from ${a.from || 'the open table'} to ${a.to}` },
  explain_preview_problems: { icon: 'layers', label: (a) => (a.updateSet ? `Explaining the preview problems of ${clip(a.updateSet, 40)}` : 'Listing the retrieved update sets') },
  find_artifact: { icon: 'search', label: (a) => `Finding ${a.kind ? `${a.kind} records` : 'records'} named "${clip(a.term, 40)}"` },
  run_selfcheck: { icon: 'stethoscope', label: () => 'Running the Self-check on this instance' },
  find_property: { icon: 'sliders', label: (a) => (a.mode === 'get' ? `Reading the property ${clip(a.query, 50)}` : a.mode === 'usage' ? `Finding the scripts that use ${clip(a.query, 50)}` : `Searching system properties for "${clip(a.query, 40)}"`) },
  read_client_trace: { icon: 'clock', label: (a) => `Reading the Client trace recording${a.field ? ` for ${clip(a.field, 40)}` : ''}` },
  run_atf: { icon: 'flask', label: (a) => (a.progressId && !a.suite ? 'Waiting for the test run' : `Running the ATF suite ${clip(a.suite, 40)}`) },
  click_ui_action: { icon: 'cursor', label: (a) => `Clicking "${clip(a.action, 40)}"` },
  create_record: { icon: 'edit', label: (a) => `Creating a ${a.table} record` },
  update_record: { icon: 'edit', label: (a) => `Updating a ${a.table} record` },
  delete_record: { icon: 'trash', label: (a) => `Deleting a ${a.table} record` },
  run_background_script: { icon: 'bolt', label: () => 'Running the script for real' },
  switch_update_set: { icon: 'layers', label: (a) => `Switching to update set ${clip(a.updateSet, 40)}` },
  switch_application_scope: { icon: 'braces', label: (a) => `Switching to application ${clip(a.scope, 40)}` },
  impersonate_user: { icon: 'lock', label: (a) => `Impersonating ${clip(a.user, 40)}` },
  end_impersonation: { icon: 'undo', label: () => 'Ending impersonation' },
};

export const toolIcon = (tool) => TOOLS[tool]?.icon || 'tool';
export const toolLabel = (tool, args = {}) => {
  try {
    return TOOLS[tool]?.label(args) || tool;
  } catch {
    return tool;
  }
};

/** One short line describing what a tool returned. */
export function summarizeResult(tool, data) {
  if (data == null) return '';
  try {
    switch (tool) {
      case 'get_schema':
        return `${data.fieldCount} fields`;
      case 'get_form_model':
        return `${data.fieldCount} fields on ${data.table}`;
      case 'query_table':
        return `${data.returned} row${data.returned === 1 ? '' : 's'}`;
      case 'count_records':
        return `${data.count} records`;
      case 'read_artifact':
        return data.found ? `${data.records.length} record${data.records.length === 1 ? '' : 's'}` : 'not found';
      case 'list_logic_for_table':
        return ['client_scripts', 'ui_policies', 'ui_actions', 'business_rules']
          .filter((k) => data[k])
          .map((k) => `${data[k].length} ${k.replace(/_/g, ' ')}`)
          .join(', ');
      case 'search_code':
        return `${data.totalRecords} record${data.totalRecords === 1 ? '' : 's'} match`;
      case 'read_logs':
        return `${data.groups.length} distinct error${data.groups.length === 1 ? '' : 's'}`;
      case 'verify_script':
        return data.summary;
      case 'test_client_script':
        return data.ok ? `${data.calls.length} g_form call${data.calls.length === 1 ? '' : 's'}${data.warnings.length ? `, ${data.warnings.length} warning(s)` : ''}` : 'script threw an error';
      case 'dry_run_script':
        return 'dry run finished';
      case 'save_artifact':
        return `${data.action} (${data.active === false || data.active === 'false' ? 'inactive' : 'active'})`;
      case 'set_form_field':
        return 'form updated, not saved';
      case 'save_form':
        return 'saved';
      case 'undo_last_write':
        return 'undone';
      case 'get_page_context':
        return `${data.page} on ${data.table || 'no table'}`;
      case 'read_page':
        return `${data.kind}${data.table ? ` on ${data.table}` : ''}${data.messages?.length ? `, ${data.messages.length} message(s)` : ''}`;
      case 'navigate':
        return data.pageReload ? 'page loading' : data.loaded === false ? 'still loading' : `opened ${data.page?.title || data.opened}`;
      case 'get_instance_info':
        return `${data.user?.userName || 'unknown user'} on ${data.environment}`;
      case 'explain_access':
        return String(data.verdict || 'traced').replace(/[-_]/g, ' ');
      case 'explain_field':
        return data.likelyCauses?.length ? `top reason: ${clip(data.likelyCauses[0].title, 60)}` : 'no live state to explain';
      case 'check_update_set':
        return `${data.verdict}: ${data.counts?.block || 0} blocker(s), ${data.counts?.warn || 0} warning(s)`;
      case 'scan_instance_health':
        return `${data.totals?.high || 0} high, ${data.totals?.medium || 0} medium${data.partial ? ' (partial)' : ''}`;
      case 'explain_email':
        return clip(data.summary || data.verdict?.summary || 'traced', 90);
      case 'explain_process':
        return clip(data.headline || 'read', 90);
      case 'map_table':
        return `${data.counts?.tablesPointingHere ?? 0} tables point here, ${data.counts?.tablesPointedAt ?? 0} referenced`;
      case 'find_dotwalk_path':
        return clip(data.summary || data.result || 'searched', 90);
      case 'explain_preview_problems':
        return data.retrievedUpdateSets ? `${data.retrievedUpdateSets.length} retrieved update set${data.retrievedUpdateSets.length === 1 ? '' : 's'}` : clip(data.verdict?.headline || 'read', 90);
      case 'find_artifact':
        return `${data.results.length} match${data.results.length === 1 ? '' : 'es'}${data.moreMatches ? ` (${data.moreMatches} more)` : ''}`;
      case 'run_selfcheck':
        return clip(data.verdict?.headline || 'checked', 90);
      case 'find_property':
        return data.results ? `${data.results.length} propert${data.results.length === 1 ? 'y' : 'ies'}${data.moreMatches ? ` (${data.moreMatches} more)` : ''}` : data.hits ? clip(data.summary, 90) : data.found ? (data.property.hidden ? 'found (value hidden)' : 'found') : 'not found';
      case 'read_client_trace':
        return data.note ? clip(data.note, 90) : `${data.events} event${data.events === 1 ? '' : 's'}, ${(data.findings || []).length + (data.moreFindings || 0)} finding(s)`;
      case 'click_ui_action':
        return `clicked, ${String(data.outcome || '').replace(/-/g, ' ')}`;
      case 'create_record':
        return `created ${data.display || data.sysId}`;
      case 'update_record':
        return data.updated ? `changed ${data.changed.join(', ')}` : 'nothing to change';
      case 'delete_record':
        return 'deleted';
      case 'run_background_script':
        return 'script ran';
      case 'switch_update_set':
      case 'switch_application_scope':
        return data.switched ? `now ${data.current?.name || 'switched'}` : 'did not switch';
      case 'impersonate_user':
        return `impersonating ${data.impersonating}`;
      case 'end_impersonation':
        return 'impersonation ended';
      case 'run_atf':
        return data.finished ? `${data.state}${data.result ? `: ${data.result.passed ?? '?'} passed, ${data.result.failed ?? '?'} failed` : ''}` : `${data.state} (${data.percent}%)`;
      default:
        return typeof data === 'string' ? clip(data, 80) : '';
    }
  } catch {
    return '';
  }
}

export function newRun(id, skill = null) {
  return { id, status: 'running', thinking: true, steps: [], skill, seq: 0 };
}

const withStep = (run, id, patch) => ({ ...run, steps: run.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

export function reduceRun(run, event) {
  switch (event.type) {
    case 'thinking':
      return { ...run, thinking: true };
    case 'assistant_text':
      if (event.final) return { ...run, thinking: false };
      return { ...run, thinking: false, seq: run.seq + 1, steps: [...run.steps, { kind: 'note', id: `n${run.seq + 1}`, text: clip(event.text, 800) }] };
    case 'tool_start':
      return {
        ...run,
        thinking: false,
        steps: [
          ...run.steps,
          // fullArgs (unclipped) lives only until the step settles: the approval card is built from it, the saved timeline is not.
          { kind: 'tool', id: event.id, tool: event.tool, args: trimArgs(event.args), fullArgs: event.args, mode: event.mode, status: 'running', startedAt: Date.now(), title: toolLabel(event.tool, event.args), icon: toolIcon(event.tool) },
        ],
      };
    case 'approval_request':
      return withStep(run, event.id, { status: 'awaiting' });
    case 'approval_result':
      return withStep(run, event.id, { status: event.approved ? 'running' : 'declined' });
    case 'approval_preview':
      return withStep(run, event.id, { preview: event.preview });
    case 'tool_result': {
      const step = run.steps.find((s) => s.id === event.id);
      const status = event.ok ? 'ok' : event.denied ? 'declined' : 'failed';
      return withStep(run, event.id, {
        status,
        ms: step?.startedAt ? Date.now() - step.startedAt : undefined,
        summary: event.ok ? summarizeResult(event.tool, event.data) : clip(event.text, 300),
        text: clip(event.text, MAX_STEP_TEXT),
        fullArgs: undefined,
      });
    }
    case 'limit':
      return { ...run, limited: true };
    case 'error':
      return { ...run, error: event.message };
    case 'done':
      return { ...run, thinking: false, status: event.stopped === 'done' ? 'done' : event.stopped, steps: run.steps.map(({ fullArgs, ...step }) => step) };
    default:
      return run;
  }
}

// Scripts can be long; the card shows the code once, in the approval preview.
function trimArgs(args = {}) {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? clip(v, 400) : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v, (kk, vv) => (typeof vv === 'string' ? clip(vv, 400) : vv))) : v]));
}
