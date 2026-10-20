// What each confirmation says (src/content/confirmDialog.js shows it). Pure, so the wording is tested: say what will
// happen and to what, and name the action on the button ("Run script", "Discard changes") instead of "OK".

const clip = (text, max = 80) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Save or delete clicked on a configuration record of a production instance. */
export function prodGuardAsk(verb, table) {
  const del = verb === 'delete';
  return {
    title: `${del ? 'Delete' : 'Save'} ${table} configuration on production?`,
    message: `You are about to ${del ? 'delete' : 'save'} a ${table} record on a PRODUCTION instance. It takes effect for every user straight away.`,
    confirmLabel: del ? 'Delete on production' : 'Save to production',
    danger: true,
  };
}

/** An automation step that clicks something labelled like a destructive action. */
export function automationClickAsk(label) {
  return {
    title: 'Automation wants to click a button that may change data',
    message: `The step is about to click "${clip(label, 60)}".`,
    confirmLabel: 'Click it',
    danger: true,
  };
}

/** The script has a syntax problem; apply it to the form or run it anyway? */
export function syntaxAsk(kind, syntax) {
  const run = kind === 'run';
  return {
    title: `Syntax problem on line ${syntax.line}`,
    message: `${syntax.message}\n\n${run ? 'Run the script anyway? It will probably fail.' : 'Apply it to the form anyway?'}`,
    confirmLabel: run ? 'Run anyway' : 'Apply anyway',
  };
}

/** Apply & save on a production instance. */
export function prodApplySaveAsk() {
  return {
    title: 'Apply and save on production?',
    message: 'This is a PRODUCTION instance. The script is written to the form and the record is saved, which takes effect for every user.',
    confirmLabel: 'Apply and save',
    danger: true,
  };
}

/** A live background script run. `riskSummary` lists the writes it will make (may be empty). */
export function runScriptAsk({ part = false, hostname = '', riskSummary = '', prod = false } = {}) {
  return {
    title: prod ? `Run ${part ? 'the selected code' : 'this script'} on PRODUCTION?` : `Run ${part ? 'the selected code' : 'this script'}?`,
    message: `It runs as you on ${hostname || 'this instance'} and takes effect immediately.${riskSummary ? ' It changes data.' : ''}`,
    details: riskSummary || '',
    confirmLabel: 'Run script',
    danger: prod || Boolean(riskSummary),
  };
}

/** The sidebar's script runner with dry run off and writes in the script. */
export function runWritesAsk(count) {
  return {
    title: 'Run a script that changes data?',
    message: `This script contains ${count} write operation${count === 1 ? '' : 's'} and dry run is OFF. It will modify data on this instance.`,
    confirmLabel: 'Run script',
    danger: true,
  };
}

/** Closing the editor or switching field with edits that were not applied. */
export function discardAsk(kind) {
  const sw = kind === 'switch';
  return {
    title: 'Discard your changes?',
    message: sw
      ? 'The edits in this field have not been applied to the form. Switching field throws them away.'
      : 'The edits in this editor have not been applied to the form. Closing it throws them away.',
    confirmLabel: 'Discard changes',
    cancelLabel: 'Keep editing',
    danger: true,
  };
}

export function clearHistoryAsk() {
  return { title: 'Clear the script history?', message: 'Every saved background script run is removed from this browser.', confirmLabel: 'Clear history', danger: true };
}

export function atfRunAsk(name, hostname) {
  return {
    title: `Run the ATF suite "${clip(name, 60)}"?`,
    message: `It runs on ${hostname || 'this instance'}. Tests can create, change and delete records, and take effect immediately.`,
    confirmLabel: 'Run suite',
    danger: true,
  };
}

export function deletePromptAsk(title) {
  return { title: `Delete "${clip(title, 60)}"?`, message: 'This saved prompt is removed from the library.', confirmLabel: 'Delete prompt', danger: true };
}

const ISSUE_VERB = { removed: 'is removed', fewer: 'takes fewer parameters', reordered: 'has its parameters reordered' };

/**
 * Saving a Script Include would break callers. `issues` are diffApi().breaking entries, `callers` the scripts that still
 * call them ({ label, name, methods, lines }), `selfLines` the `this.x()` calls left in the script itself.
 */
export function breakingChangeAsk({ className, renamedTo = '', issues = [], callers = [], moreCallers = 0, selfLines = [] }) {
  const method = (i) => `${className ? `${className}.` : ''}${i.name}`;
  const lines = [];
  if (renamedTo) lines.push(`• the class ${className} is renamed to ${clip(renamedTo, 40)}`);
  lines.push(...issues.map((i) => `• ${method(i)} ${ISSUE_VERB[i.kind] || 'changes'}${i.renamedTo ? ` (renamed to ${i.renamedTo}?)` : ''}`));
  const total = callers.length + moreCallers;
  const who = callers.map((c) => `• ${c.label}: ${clip(c.name, 50)} ${c.methods.length ? `calls ${c.methods.join(', ')}` : 'uses the class'}${c.lines?.length ? ` (line ${c.lines[0]})` : ''}`);
  if (moreCallers > 0) who.push(`• and ${moreCallers} more`);
  const own = selfLines.length ? `\n\nThis script still calls ${[...new Set(selfLines.map((s) => `this.${s.name}()`))].join(', ')} itself (line ${selfLines[0].line}).` : '';
  const callerText = total ? `\n\nStill called by ${total} ${total === 1 ? 'script' : 'scripts'}:\n${who.join('\n')}` : '';
  return {
    title: total ? `Saving this breaks ${total} ${total === 1 ? 'caller' : 'callers'}` : 'Saving this removes methods the script still calls',
    message: `${lines.join('\n')}${callerText}${own}`,
    confirmLabel: 'Save anyway',
    cancelLabel: 'Go back',
    danger: true,
  };
}
