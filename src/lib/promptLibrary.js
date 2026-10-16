// Prompt library: built-in starter prompts, user-saved prompts, {{variable}}
// templating, and JSON import/export.
//
// Templates use {{name}}. A fixed set of names is filled automatically from the
// page (CONTEXT_VARIABLES); any other name becomes a field the user fills in
// before the prompt runs.

import { redactSecrets } from '../providers/redact.js';
import { EXTRA_PROMPTS } from './builtinPrompts.js';
import { BUILTIN_SNIPPETS, SNIPPET_CATEGORIES } from './builtinSnippets.js';

const EXPORT_VERSION = 1;
const SYNC_FLAG_KEY = 'mysnowbuddy_library_sync';
const SYNC_PREFIX = 'mysnowbuddy_sync_';
const SYNC_CHUNK_CHARS = 4000;
const SYNC_MAX_CHUNKS = 20;

export const LIMITS = {
  title: 80,
  category: 30,
  description: 200,
  template: 8000,
  maxPrompts: 500,
  scriptChars: 12000,
};

export const CATEGORIES = [
  'Review',
  'Security',
  'Performance',
  'Explain',
  'Generate',
  'Debug',
  'Testing',
  'Docs',
  'Admin',
  'Integration',
  'Flow',
  'Portal',
  'Data',
  'ITSM',
  'Platform',
  'Custom',
];

// Names resolved from the current page; everything else is user-supplied.
export const CONTEXT_VARIABLES = {
  table: 'Table of the current page',
  sys_id: 'sys_id of the current record',
  script: 'Script on the current form (secrets redacted)',
  field: 'Label of the detected script field',
  instance: 'Hostname of this instance',
  selection: 'Text currently selected on the page',
};

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const CORE_PROMPTS = [
  {
    id: 'builtin.perf-review',
    title: 'Performance review of this script',
    category: 'Review',
    description: 'Query patterns and behaviour at realistic data volumes.',
    template:
      'Review the following ServiceNow script for performance. Look at GlideRecord query shape ' +
      '(unbounded queries, queries in loops, missing indexes on filtered fields), GlideAggregate ' +
      'opportunities, repeated lookups that could be cached, and synchronous work that could be ' +
      'deferred. Assume {{volume}} records on {{table}}. Respond as a prioritised list with a concrete ' +
      'fix for each item.\n\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.security-review',
    title: 'Security review of this script',
    category: 'Review',
    description: 'Injection, ACL bypass and data-exposure risks.',
    template:
      'Security-review the following ServiceNow script from {{table}}. Check for encoded-query ' +
      'injection from user input, GlideRecord used where GlideRecordSecure is needed, missing ' +
      'ACL/role checks, sensitive data written to logs or returned to the client, unsafe ' +
      'eval-style execution, and hardcoded credentials or sys_ids. For each finding give severity, ' +
      'exploit scenario and the fix.\n\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.explain-script',
    title: 'Explain this script',
    category: 'Explain',
    description: 'Plain-language walkthrough for a new team member.',
    template:
      'Explain what this ServiceNow {{field}} on {{table}} does, step by step, in plain language for ' +
      'an admin who has not seen it before. Call out when it runs, what it reads and writes, and ' +
      'anything surprising.\n\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.refactor-si',
    title: 'Refactor into a Script Include',
    category: 'Generate',
    description: 'Extract reusable logic from a Business Rule or UI Action.',
    template:
      'Refactor the following script by extracting its reusable logic into a Script Include named ' +
      '{{className}}, leaving the original script as a thin caller. Use the class-based pattern, keep ' +
      'behaviour identical, add JSDoc, and list any assumptions you had to make.\n\n' +
      '```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.glideajax',
    title: 'Replace synchronous client GlideRecord with GlideAjax',
    category: 'Generate',
    description: 'Fix client-side performance anti-patterns.',
    template:
      'The client script below does server work in a way that blocks the browser. Rewrite it using ' +
      'an asynchronous GlideAjax call and give me the matching client-callable Script Include. ' +
      'Keep behaviour identical.\n\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.report-script',
    title: 'Read-only reporting background script',
    category: 'Generate',
    description: 'A safe GlideAggregate/GlideRecord report.',
    template:
      'Write a READ-ONLY ServiceNow background script that reports {{request}} on the {{table}} ' +
      'table. Prefer GlideAggregate where counting, bound the query, and print results with gs.info ' +
      'in a readable format. Do not modify any data. Return only a javascript code block followed by ' +
      'a short note on its cost.',
  },
  {
    id: 'builtin.rule-not-firing',
    title: 'Why is my rule not firing?',
    category: 'Debug',
    description: 'Checklist-driven diagnosis of a Business Rule or Flow.',
    template:
      'On {{instance}}, a {{artifact}} on the {{table}} table is not behaving as expected. Symptom: ' +
      '{{symptom}}.\n\nWalk me through the likely causes in order of probability: active flag, ' +
      'when/order, conditions, scope and domain, ACLs, update-set or application mismatch, ' +
      'async vs sync timing, and other rules that could override it. For each give a quick way to ' +
      'confirm or rule it out.\n\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.atf',
    title: 'ATF test plan for this behaviour',
    category: 'Testing',
    description: 'Ordered ATF steps with positive and negative cases.',
    template:
      'Design an Automated Test Framework test for the behaviour below on {{table}}: {{behaviour}}.\n\n' +
      'Provide the test name, data setup and impersonation, the ordered ATF steps (naming each step ' +
      'type), the assertions including at least one negative case, and cleanup. Include the script ' +
      'for any Run Server Side Script step.\n\nRelevant script, if any:\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.document',
    title: 'Technical documentation for this record',
    category: 'Docs',
    description: 'Maintainer-ready markdown documentation.',
    template:
      'Write technical documentation in markdown for this {{field}} on {{table}}. Sections: Purpose, ' +
      'Trigger, Inputs, Logic walkthrough, Outputs and side effects, Dependencies, Risks and ' +
      'gotchas, and a change checklist for a future maintainer. No filler.\n\n' +
      '```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.update-set-notes',
    title: 'Update set description and release notes',
    category: 'Docs',
    description: 'Turn a change list into a CAB-ready description.',
    template:
      'Write an update set description and release notes from the change list below. Include a ' +
      'one-line summary, what changed and why, the deployment order or prerequisites, a rollback ' +
      'plan, and a short test checklist.\n\nChanges:\n{{changes}}',
  },
  {
    id: 'builtin.flow-migration',
    title: 'Convert to Flow Designer',
    category: 'Admin',
    description: 'Assess whether and how to move logic into a flow.',
    template:
      'Assess whether the logic below should move to Flow Designer. If yes, outline the flow: ' +
      'trigger, conditions, actions or subflows, and any custom action script needed. If no, ' +
      'explain what should stay in code and why.\n\n```javascript\n{{script}}\n```',
  },
  {
    id: 'builtin.acl-design',
    title: 'Design an ACL',
    category: 'Admin',
    description: 'Least-privilege ACL proposal with tests.',
    template:
      'Propose a least-privilege ACL for {{operation}} on {{table}} where {{requirement}}. Give the ' +
      'ACL name, operation, roles, condition, and script if one is truly needed, then list the ' +
      'negative tests that prove it denies access correctly.',
  },
];

export const BUILTIN_PROMPTS = [...CORE_PROMPTS, ...EXTRA_PROMPTS];

// The same engine backs both the AI prompt library and the code snippet library.
export const KINDS = {
  prompts: {
    storageKey: 'mysnowbuddy_prompt_library',
    builtins: BUILTIN_PROMPTS,
    categories: CATEGORIES,
    noun: 'prompt',
  },
  snippets: {
    storageKey: 'mysnowbuddy_snippet_library',
    builtins: BUILTIN_SNIPPETS,
    categories: SNIPPET_CATEGORIES,
    noun: 'snippet',
    // Values are escaped for the JavaScript context they land in (see renderTemplate).
    code: true,
  },
};

// User ids are always 'user.*', so the prefix alone identifies shipped entries.
export function isBuiltin(id) {
  return typeof id === 'string' && id.startsWith('builtin.');
}

/** Unique variable names in first-appearance order. */
export function extractVariables(template) {
  const seen = [];
  for (const match of String(template || '').matchAll(VARIABLE_PATTERN)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/** Variables the user has to type, i.e. everything that is not page context. */
export function userVariables(template) {
  return extractVariables(template).filter((name) => !Object.hasOwn(CONTEXT_VARIABLES, name));
}

export function contextVariablesUsed(template) {
  return extractVariables(template).filter((name) => Object.hasOwn(CONTEXT_VARIABLES, name));
}

/** Resolve context variables from the page context object. */
export function contextValues(ctx, hostname) {
  return {
    table: ctx?.table || '',
    sys_id: ctx?.sysId || '',
    script: ctx?.scriptBody ? redactSecrets(ctx.scriptBody).slice(0, LIMITS.scriptChars) : '',
    field: ctx?.scriptFieldLabel || 'script',
    instance: hostname || '',
    selection: ctx?.selection ? redactSecrets(ctx.selection).slice(0, LIMITS.scriptChars) : '',
  };
}

/** Escape text for the inside of a JavaScript string literal delimited by `quote` (', " or `). */
export function escapeForJsString(value, quote = "'") {
  const out = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  if (quote === '`') return out.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return out.split(quote).join(`\\${quote}`);
}

/**
 * Lexical context of every {{placeholder}} in a code template, keyed by its
 * offset: 'code', a quote character (inside that string literal),
 * 'line-comment' or 'block-comment'. A light scanner, not a parser: regex
 * literals are skipped (so /'/ does not open a string), ${...} inside template
 * literals is not tracked.
 */
// After these, a "/" starts a regex literal; after an operand ( ) ] identifier number ) it divides.
const REGEX_AFTER_CHAR = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'else', 'do']);

function regexStartsAt(template, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(template[j])) j -= 1;
  if (j < 0) return true;
  if (template[j] === '}' && template[j - 1] === '}') return false; // {{value}} / 2: a placeholder is an operand
  if (REGEX_AFTER_CHAR.has(template[j])) return true;
  if (!/[\w$]/.test(template[j])) return false;
  let k = j;
  while (k > 0 && /[\w$]/.test(template[k - 1])) k -= 1;
  return REGEX_AFTER_WORD.has(template.slice(k, j + 1));
}

/** Index of the "/" that closes the regex literal opened at `i`, or -1 when it is not one. */
function regexEnd(template, i) {
  let inClass = false;
  for (let j = i + 1; j < template.length; j += 1) {
    const c = template[j];
    if (c === '\n') return -1;
    if (c === '\\') j += 1;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '/') return j;
  }
  return -1;
}

function codeContexts(template) {
  const contexts = new Map();
  const placeholder = new RegExp(`^${VARIABLE_PATTERN.source}`);
  let state = 'code';
  for (let i = 0; i < template.length; i += 1) {
    if (template[i] === '{' && template[i + 1] === '{') {
      const m = placeholder.exec(template.slice(i));
      if (m) {
        contexts.set(i, state);
        i += m[0].length - 1;
        continue;
      }
    }
    const ch = template[i];
    const next = template[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        i += 1;
      } else if (ch === '/' && next === '*') {
        state = 'block-comment';
        i += 1;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        state = ch;
      } else if (ch === '/' && regexStartsAt(template, i)) {
        // Skip the whole literal: a quote inside /'/ must not open a string. Unterminated = division.
        const end = regexEnd(template, i);
        if (end !== -1) i = end;
      }
    } else if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
    } else if (ch === '\\') {
      i += 1; // an escaped character never ends the string
    } else if (ch === state || (ch === '\n' && state !== '`')) {
      state = 'code';
    }
  }
  return contexts;
}

function escapeForContext(value, context) {
  if (context === "'" || context === '"' || context === '`') return escapeForJsString(value, context);
  // A newline would end a // comment and turn the rest of the value into code.
  if (context === 'line-comment') return value.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  if (context === 'block-comment') return value.replace(/\*\//g, '* /');
  return value; // code position: the user typed code (a number, a class name) on purpose
}

/**
 * Fill a template. Substitution is a single pass, so a value that itself
 * contains {{x}} is not expanded again.
 * Returns { text, missing } where `missing` lists names with no value.
 *
 * Prompts are plain text and get values unchanged. Code snippets (options.code,
 * or options.kind === 'snippets') escape each value for where it lands: inside
 * a string literal quotes, backslashes and newlines are escaped, so a value can
 * never break out of the literal and inject code.
 */
export function renderTemplate(template, values, options = {}) {
  const source = String(template || '');
  const isCode = options.code ?? Boolean(KINDS[options.kind]?.code);
  const contexts = isCode ? codeContexts(source) : null;
  const missing = [];
  const text = source.replace(VARIABLE_PATTERN, (_m, name, offset) => {
    const value = values[name];
    if (value === undefined || value === null || String(value).trim() === '') {
      if (!missing.includes(name)) missing.push(name);
      return `{{${name}}}`;
    }
    return isCode ? escapeForContext(String(value), contexts.get(offset) || 'code') : String(value);
  });
  return { text, missing };
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/** Validate and normalise a prompt from the editor or an import file. */
export function normalizePrompt(input, { keepId = true } = {}) {
  const title = clean(input?.title, LIMITS.title);
  const template = String(input?.template ?? '').trim().slice(0, LIMITS.template);
  if (!title) throw new Error('A title is required.');
  if (!template) throw new Error('The prompt text is required.');

  const now = Date.now();
  return {
    id: keepId && typeof input.id === 'string' && input.id && !isBuiltin(input.id) ? input.id : newId(),
    title,
    category: clean(input?.category, LIMITS.category) || 'Custom',
    description: clean(input?.description, LIMITS.description),
    template,
    createdAt: Number(input?.createdAt) || now,
    updatedAt: now,
  };
}

function newId() {
  return `user.${crypto.randomUUID()}`;
}

/** Whether this device mirrors libraries through chrome.storage.sync. */
export async function getSyncEnabled() {
  const res = await chrome.storage.local.get(SYNC_FLAG_KEY);
  return Boolean(res[SYNC_FLAG_KEY]);
}

export async function setSyncEnabled(enabled) {
  await chrome.storage.local.set({ [SYNC_FLAG_KEY]: Boolean(enabled) });
}

function syncKeys(kind) {
  return {
    meta: `${SYNC_PREFIX}${kind}_meta`,
    chunk: (i) => `${SYNC_PREFIX}${kind}_${i}`,
  };
}

async function readSynced(kind) {
  const keys = syncKeys(kind);
  const { [keys.meta]: meta } = await chrome.storage.sync.get(keys.meta);
  if (!meta?.count) return null;
  const names = Array.from({ length: meta.count }, (_, i) => keys.chunk(i));
  const parts = await chrome.storage.sync.get(names);
  try {
    return JSON.parse(names.map((n) => parts[n] || '').join(''));
  } catch {
    return null;
  }
}

async function writeSynced(kind, library) {
  const keys = syncKeys(kind);
  const json = JSON.stringify({
    prompts: library.prompts,
    favorites: library.favorites,
    updatedAt: library.updatedAt,
  });
  const chunks = [];
  for (let i = 0; i < json.length; i += SYNC_CHUNK_CHARS) chunks.push(json.slice(i, i + SYNC_CHUNK_CHARS));
  if (chunks.length > SYNC_MAX_CHUNKS) {
    throw new Error('Too large to sync across devices (limit is about 80 KB). Export it instead.');
  }

  const { [keys.meta]: previous } = await chrome.storage.sync.get(keys.meta);
  const items = { [keys.meta]: { count: chunks.length, updatedAt: library.updatedAt } };
  chunks.forEach((c, i) => {
    items[keys.chunk(i)] = c;
  });
  await chrome.storage.sync.set(items);
  const stale = [];
  for (let i = chunks.length; i < (previous?.count || 0); i += 1) stale.push(keys.chunk(i));
  if (stale.length) await chrome.storage.sync.remove(stale);
}

/** Load saved entries, favourites and usage counts. Newer synced data wins when sync is on. */
export async function loadLibrary(kind = 'prompts') {
  const storageKey = KINDS[kind].storageKey;
  const res = await chrome.storage.local.get(storageKey);
  const stored = res[storageKey] || {};
  let library = {
    prompts: Array.isArray(stored.prompts) ? stored.prompts : [],
    favorites: Array.isArray(stored.favorites) ? stored.favorites : [],
    usage: stored.usage && typeof stored.usage === 'object' ? stored.usage : {},
    updatedAt: Number(stored.updatedAt) || 0,
  };

  if (await getSyncEnabled()) {
    try {
      const remote = await readSynced(kind);
      if (remote && Number(remote.updatedAt) > library.updatedAt) {
        library = {
          prompts: Array.isArray(remote.prompts) ? remote.prompts : [],
          favorites: Array.isArray(remote.favorites) ? remote.favorites : [],
          usage: library.usage,
          updatedAt: Number(remote.updatedAt),
        };
        await chrome.storage.local.set({ [storageKey]: library });
      }
    } catch {
      // Sync is best-effort; fall back to the local copy.
    }
  }
  return library;
}

/** Save locally and, when enabled, mirror to sync. Returns the saved library. */
export async function saveLibrary(library, kind = 'prompts') {
  const saved = { ...library, updatedAt: Date.now() };
  await chrome.storage.local.set({
    [KINDS[kind].storageKey]: {
      prompts: saved.prompts,
      favorites: saved.favorites,
      usage: saved.usage || {},
      updatedAt: saved.updatedAt,
    },
  });
  if (await getSyncEnabled()) await writeSynced(kind, saved);
  return saved;
}

export function allPrompts(library, kind = 'prompts') {
  return [...KINDS[kind].builtins, ...library.prompts];
}

/** Count a use so frequently used entries float to the top. */
export function recordUse(library, id) {
  const usage = library.usage || {};
  return { ...library, usage: { ...usage, [id]: (usage[id] || 0) + 1 } };
}

export function upsertPrompt(library, prompt) {
  const exists = library.prompts.some((p) => p.id === prompt.id);
  if (!exists && library.prompts.length >= LIMITS.maxPrompts) {
    throw new Error(`The library is limited to ${LIMITS.maxPrompts} saved prompts.`);
  }
  const prompts = exists
    ? library.prompts.map((p) => (p.id === prompt.id ? prompt : p))
    : [...library.prompts, prompt];
  return { ...library, prompts };
}

export function removePrompt(library, id) {
  return {
    ...library,
    prompts: library.prompts.filter((p) => p.id !== id),
    favorites: library.favorites.filter((f) => f !== id),
  };
}

export function toggleFavorite(library, id) {
  const favorites = library.favorites.includes(id)
    ? library.favorites.filter((f) => f !== id)
    : [...library.favorites, id];
  return { ...library, favorites };
}

/** Case-insensitive match across title, category, description and text. */
export function filterPrompts(prompts, { query = '', category = '', favoritesOnly = false, favorites = [] }) {
  const needle = query.trim().toLowerCase();
  return prompts.filter((p) => {
    if (category && p.category !== category) return false;
    if (favoritesOnly && !favorites.includes(p.id)) return false;
    if (!needle) return true;
    return `${p.title} ${p.category} ${p.description} ${p.template}`.toLowerCase().includes(needle);
  });
}

/** Favourites first, then most used, then alphabetically by title. */
export function sortPrompts(prompts, favorites, usage = {}) {
  return [...prompts].sort((a, b) => {
    const fa = favorites.includes(a.id) ? 0 : 1;
    const fb = favorites.includes(b.id) ? 0 : 1;
    return fa - fb || (usage[b.id] || 0) - (usage[a.id] || 0) || a.title.localeCompare(b.title);
  });
}

export function exportLibraryJson(library) {
  return JSON.stringify({ version: EXPORT_VERSION, prompts: library.prompts }, null, 2);
}

/**
 * Parse an exported file. Imported prompts always get fresh ids so an import
 * can never overwrite an existing prompt or impersonate a built-in.
 * Returns { prompts, skipped }.
 */
export function parseImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const list = Array.isArray(data) ? data : data?.prompts;
  if (!Array.isArray(list)) throw new Error('No prompts found in that file.');

  const prompts = [];
  let skipped = 0;
  for (const item of list) {
    try {
      prompts.push(normalizePrompt(item, { keepId: false }));
    } catch {
      skipped += 1;
    }
  }
  return { prompts, skipped };
}
