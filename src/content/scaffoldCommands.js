// Palette rows for "New ... from a template": "/new br on incident", "new business rule", "start a new script
// include", "/new si MyHelper ajax". The builder (src/lib/scaffolds.js) is pure; this file only turns what it
// returns into rows and acts on them: open a NEW record form with the template already filled in (the developer
// presses Submit), or copy the template. Missing pieces are asked for in the row text, not in a dialog.

import { copyText, navigate } from './quickActions.js';
import { KINDS, KIND_IDS, build, isNewRequest, splitRequest, parseNewArgs, suggestTable, describeRequest } from '../lib/scaffolds.js';

const GROUP = 'New from a template';
const COMMON_TABLES = ['incident', 'change_request', 'problem', 'task'];

// What each kind can vary: the option to set, and its choices (the first is the default).
const VARIANTS = {
  br: ['when', ['before', 'after', 'async', 'display']],
  cs: ['type', ['onChange', 'onLoad', 'onSubmit', 'onCellEdit']],
  uia: ['variant', ['roundtrip', 'client', 'server']],
  si: ['variant', ['class', 'ajax']],
  rest: ['method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']],
};

const VARIANT_LABEL = {
  roundtrip: 'client + server',
  class: 'plain class',
  ajax: 'client callable (GlideAjax)',
};

/** Open the new form with the template in it (or copy it first when it is too long for a link). */
async function openForm(made, toast) {
  if (!made.ok) {
    toast?.error(made.error);
    return;
  }
  if (made.copyOnly) {
    await copyText(made.script).catch(() => {});
    toast?.success('The template is on your clipboard. Paste it into the script field.', { timeout: 10000 });
  }
  navigate(made.url);
}

async function copyTemplate(made, toast) {
  if (!made.ok) {
    toast?.error(made.error);
    return;
  }
  await copyText(made.script);
  toast?.success(`Copied the ${made.label} template.`);
}

function kindRows(text, reopen) {
  const q = text.toLowerCase();
  return KIND_IDS.filter((id) => !q || KINDS[id].words.some((w) => w.startsWith(q)) || KINDS[id].label.toLowerCase().includes(q)).map((id, index) => ({
    id: `new.pick.${id}`,
    title: `New ${KINDS[id].label}`,
    hint: `/new ${id} · starts from a verified template`,
    group: GROUP,
    icon: 'tools',
    score: 1100 - index,
    run: () => reopen?.(`/new ${id} `),
  }));
}

/**
 * @param {{ ctx?: object, toast?: object, reopen?: (text: string) => void }} deps
 * @returns {(query: string) => Promise<object[]>}
 */
export function scaffoldProvider({ ctx = {}, toast, reopen } = {}) {
  return async (query) => {
    const text = String(query || '').trim();
    if (!isNewRequest(text)) return [];
    const { kind, rest, text: typed } = splitRequest(text);
    if (!kind) return kindRows(typed, reopen);

    const { options, missing } = parseNewArgs(kind, rest, { table: suggestTable(ctx.table) });
    const label = KINDS[kind].label;

    if (missing.includes('table')) {
      return COMMON_TABLES.map((table, index) => ({
        id: `new.${kind}.table.${table}`,
        title: `${label} on ${table}`,
        hint: 'Or type the table: /new ' + kind + ' on <table>',
        group: GROUP,
        icon: 'table',
        score: 1100 - index,
        run: () => reopen?.(`/new ${kind} ${rest} on ${table}`.replace(/\s+/g, ' ')),
      }));
    }
    if (missing.includes('name')) {
      return [
        {
          id: `new.${kind}.name`,
          title: `${label}: type a name`,
          hint: `For example /new ${kind} MyHelper. Letters, digits and _ only; it is the class name.`,
          group: GROUP,
          icon: 'tools',
          score: 1100,
          run: () => reopen?.(`/new ${kind} `),
        },
      ];
    }

    const made = build(kind, options);
    if (!made.ok) {
      return [{ id: `new.${kind}.error`, title: made.error, hint: `/new ${kind} ${rest}`.trim(), group: GROUP, icon: 'tools', score: 1100, run: () => reopen?.(`/new ${kind} ${rest}`.trim()) }];
    }

    const rows = [
      {
        id: `new.${kind}.open`,
        title: `New ${describeRequest(kind, options)}`,
        hint: `${made.notes[0] || 'Opens a new form with the template filled in.'} You press Submit.`,
        group: GROUP,
        icon: 'tools',
        score: 1100,
        run: () => openForm(made, toast),
      },
      {
        id: `new.${kind}.copy`,
        title: `Copy the ${label} template`,
        hint: `${made.script.split('\n').length} lines of script, nothing is opened`,
        group: GROUP,
        icon: 'copy',
        score: 1095,
        run: () => copyTemplate(made, toast),
      },
    ];

    const variants = VARIANTS[kind];
    if (variants) {
      const [key, choices] = variants;
      const chosen = options[key] || choices[0];
      choices
        .filter((choice) => String(choice).toLowerCase() !== String(chosen).toLowerCase())
        .forEach((choice, index) => {
          const variant = build(kind, { ...options, [key]: choice });
          if (!variant.ok) return;
          rows.push({
            id: `new.${kind}.variant.${choice}`,
            title: `Same, but ${VARIANT_LABEL[choice] || choice}`,
            hint: variant.notes[0] || label,
            group: GROUP,
            icon: 'tools',
            score: 1090 - index,
            run: () => openForm(variant, toast),
          });
        });
    }
    return rows;
  };
}
