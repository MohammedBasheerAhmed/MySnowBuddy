// Test data: generate believable records for a table, preview them, create them (guarded) and clean them up again.
// This file is the pure half: seedable generators, the plan checks, the sequential runner and the journal of what was
// created. Nothing here touches the page or the instance; the panel (src/sidebar/TestDataPanel.jsx) passes in the
// functions that do (create, delete, exists), and src/content/testData.js reads the dictionary and keeps the journal.
//
// Guardrails live here so they are tested: a hard cap per run, no production-looking instance, the write policy of the
// agent (credential tables, secret-looking fields), a marker on every record, and a journal that cleanup works from.

import { assessWrite, isGuardedEnv } from './agent/policy.js';

export const MARKER = '[NB-test]';
export const MAX_PER_RUN = 50;
export const JOURNAL_KEY = 'mysnowbuddy_test_data_batches';
export const JOURNAL_CAP = 40;
const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const SYS_ID_RE = /^[0-9a-f]{32}$/i;

// --- Seedable random numbers ------------------------------------------------------------------------------

function hashSeed(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A deterministic generator: the same seed gives the same rows. */
export function createRng(seed = 1) {
  let a = hashSeed(seed) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p = 0.5) => next() < p,
    /** options: [{ value, weight }] */
    weighted(options) {
      const total = options.reduce((s, o) => s + (Number(o.weight) > 0 ? Number(o.weight) : 0), 0);
      if (!total) return options[0];
      let r = next() * total;
      for (const o of options) {
        r -= Number(o.weight) > 0 ? Number(o.weight) : 0;
        if (r < 0) return o;
      }
      return options[options.length - 1];
    },
  };
}

// --- Word banks -------------------------------------------------------------------------------------------

const FIRST = ['Ava', 'Noah', 'Mia', 'Liam', 'Zoe', 'Ethan', 'Isla', 'Lucas', 'Aria', 'Mason', 'Nora', 'Owen', 'Ruby', 'Leo', 'Maya', 'Ezra', 'Ivy', 'Kai', 'Esme', 'Finn', 'Tara', 'Omar', 'Priya', 'Sven', 'Yuki', 'Amara', 'Diego', 'Hana', 'Idris', 'Lena'];
const LAST = ['Archer', 'Bishop', 'Carver', 'Dalton', 'Ellis', 'Foster', 'Grant', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lambert', 'Mercer', 'Nolan', 'Osborne', 'Porter', 'Quinn', 'Reyes', 'Sutton', 'Turner', 'Underwood', 'Vance', 'Walker', 'Xu', 'Young', 'Zimmer', 'Okafor', 'Novak', 'Silva', 'Tanaka'];
const COMPANIES = ['Northwind Traders', 'Contoso Labs', 'Fabrikam Works', 'Tailspin Air', 'Litware Systems', 'Adatum Foods', 'Proseware', 'Wingtip Toys', 'Lucerne Publishing', 'Blue Yonder Freight', 'Alpine Ski House', 'Coho Winery'];
const CITIES = ['Austin', 'Berlin', 'Chennai', 'Dublin', 'Edinburgh', 'Frankfurt', 'Geneva', 'Hyderabad', 'Istanbul', 'Johannesburg', 'Kyoto', 'Lisbon', 'Melbourne', 'Nairobi', 'Oslo', 'Perth'];
const STREETS = ['Maple Street', 'Oak Avenue', 'Pine Road', 'Cedar Lane', 'Elm Court', 'Lake View Drive'];
const TITLES = ['Service Desk Analyst', 'Systems Engineer', 'Network Administrator', 'Release Manager', 'Product Owner', 'Security Analyst', 'Support Lead', 'Developer'];
const WORDS = ['alpha', 'bravo', 'cobalt', 'delta', 'ember', 'falcon', 'garnet', 'harbor', 'indigo', 'juniper', 'kestrel', 'lumen', 'meadow', 'nimbus', 'onyx', 'pebble', 'quartz', 'raven', 'summit', 'tundra'];
const SENTENCES = {
  generic: ['Sample record created for testing', 'Placeholder entry used to try a flow', 'Dummy data for a regression check', 'Test entry, safe to delete'],
  incident: ['VPN drops every ten minutes', 'Cannot log in to the expense system', 'Laptop will not boot after update', 'Shared printer on floor 3 is offline', 'Email attachments larger than 5 MB bounce', 'Application is slow during the morning peak', 'Password reset link never arrives', 'Meeting room display shows a blank screen'],
  change: ['Patch the application servers', 'Rotate the integration credentials', 'Increase the database storage quota', 'Move the batch window to 02:00', 'Upgrade the load balancer firmware', 'Enable multi-factor sign-in for contractors'],
  problem: ['Intermittent timeouts on the intranet', 'Recurring disk-full alerts on the file server', 'Duplicate tickets created by the email listener', 'Reports fail on the first day of the month'],
  request: ['Need a second monitor', 'Access to the finance share', 'New starter laptop set-up', 'Software licence for the design team'],
};
const PARAGRAPHS = ['Created by NowBuddy for testing. Steps: open the record, change the state, and check that the expected rule runs. Safe to delete.', 'Placeholder text for exercising notifications, SLAs and reports. It was generated, not reported by a person.', 'Generated sample data. Nothing here describes a real issue; use it to try a flow end to end and then clean it up.'];

// --- Values -----------------------------------------------------------------------------------------------

const pad = (n, width) => String(n).padStart(width, '0');

/** "YYYY-MM-DD HH:MM:SS" (UTC, the format the Table API writes) or "YYYY-MM-DD". */
export function formatGlideDate(date, withTime = true) {
  const d = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
  return withTime ? `${d} ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}` : d;
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** One person per row, so first name, last name, user name and email agree with each other. */
function persona(rng, n) {
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  return { first, last, userName: `${slug(first)}.${slug(last)}${n}`, email: `${slug(first)}.${slug(last)}${n}@example.com` };
}

/** Fill {n} {n:3} {first} {last} {email} {rand:4} {word} {date} {batch} in a pattern. */
export function expandPattern(pattern, ctx) {
  return String(pattern ?? '').replace(/\{(n|first|last|email|user|word|date|batch|rand|company|city)(?::(\d+))?\}/g, (_, key, width) => {
    switch (key) {
      case 'n':
        return width ? pad(ctx.n, Number(width)) : String(ctx.n);
      case 'first':
        return ctx.persona.first;
      case 'last':
        return ctx.persona.last;
      case 'email':
        return ctx.persona.email;
      case 'user':
        return ctx.persona.userName;
      case 'word':
        return ctx.rng.pick(WORDS);
      case 'date':
        return formatGlideDate(ctx.now, false);
      case 'batch':
        return ctx.batch || 'batch';
      case 'company':
        return ctx.rng.pick(COMPANIES);
      case 'city':
        return ctx.rng.pick(CITIES);
      default: {
        const digits = Math.min(Number(width) || 4, 12);
        return pad(ctx.rng.int(0, 10 ** digits - 1), digits);
      }
    }
  });
}

const TEXT = {
  firstName: (c) => c.persona.first,
  lastName: (c) => c.persona.last,
  name: (c) => `${c.persona.first} ${c.persona.last}`,
  userName: (c) => c.persona.userName,
  email: (c) => c.persona.email,
  phone: (c) => `+1-555-${pad(c.rng.int(100, 999), 3)}-${pad(c.rng.int(0, 9999), 4)}`,
  city: (c) => c.rng.pick(CITIES),
  company: (c) => c.rng.pick(COMPANIES),
  street: (c) => `${c.rng.int(10, 999)} ${c.rng.pick(STREETS)}`,
  zip: (c) => pad(c.rng.int(10000, 99999), 5),
  url: (c) => `https://example.com/${c.rng.pick(WORDS)}-${c.n}`,
  title: (c) => c.rng.pick(TITLES),
  word: (c) => `${c.rng.pick(WORDS)}-${c.rng.pick(WORDS)}`,
  sentence: (c) => c.rng.pick(SENTENCES.generic),
  incident: (c) => c.rng.pick(SENTENCES.incident),
  change: (c) => c.rng.pick(SENTENCES.change),
  problem: (c) => c.rng.pick(SENTENCES.problem),
  request: (c) => c.rng.pick(SENTENCES.request),
  paragraph: (c) => c.rng.pick(PARAGRAPHS),
};
export const TEXT_STYLES = Object.keys(TEXT);

/** Generator kinds, for the panel's picker. */
export const KINDS = [
  { id: 'text', label: 'Realistic text' },
  { id: 'pattern', label: 'Pattern' },
  { id: 'fixed', label: 'Fixed value' },
  { id: 'int', label: 'Whole number' },
  { id: 'decimal', label: 'Decimal' },
  { id: 'bool', label: 'True / false' },
  { id: 'date', label: 'Date' },
  { id: 'choice', label: 'Choice list' },
  { id: 'ref', label: 'Existing record' },
  { id: 'empty', label: 'Leave empty' },
];

/** The value one spec gives for one row. `ctx`: { rng, n, now, persona, batch }. */
export function generateValue(spec, ctx) {
  const rng = ctx.rng;
  switch (spec?.kind) {
    case 'fixed':
      return spec.value ?? '';
    case 'pattern':
      return expandPattern(spec.pattern, ctx);
    case 'text':
      return (TEXT[spec.style] || TEXT.word)(ctx);
    case 'int': {
      const min = Number.isFinite(Number(spec.min)) ? Number(spec.min) : 0;
      const max = Number.isFinite(Number(spec.max)) ? Number(spec.max) : 100;
      return String(rng.int(Math.min(min, max), Math.max(min, max)));
    }
    case 'decimal': {
      const min = Number(spec.min) || 0;
      const max = Number.isFinite(Number(spec.max)) ? Number(spec.max) : 1000;
      return (min + rng.next() * (max - min)).toFixed(Math.min(Math.max(Number(spec.places) || 2, 0), 6));
    }
    case 'bool':
      return rng.chance(spec.chance ?? 0.5) ? 'true' : 'false';
    case 'date': {
      const back = Math.max(Number(spec.daysBack) || 0, 0);
      const forward = Math.max(Number(spec.daysForward) || 0, 0);
      const span = (back + forward) * 86400000;
      const at = new Date(ctx.now.getTime() - back * 86400000 + (span ? Math.floor(rng.next() * span) : 0));
      return formatGlideDate(at, spec.time !== false);
    }
    case 'choice': {
      const options = (spec.options || []).filter((o) => o.value !== undefined);
      return options.length ? String(rng.weighted(options).value) : '';
    }
    case 'ref': {
      if (spec.mode === 'fixed') return spec.fixed || '';
      if (spec.mode === 'empty' || !spec.ids?.length) return '';
      return rng.pick(spec.ids);
    }
    default:
      return '';
  }
}

// --- Which fields, with which generator ------------------------------------------------------------------

const SKIP_TYPES = new Set(['journal_input', 'journal', 'journal_list', 'glide_list', 'document_id', 'conditions', 'condition_string', 'script', 'script_plain', 'script_server', 'user_input', 'password', 'password2', 'glide_var', 'collection', 'domain_id', 'sys_class_name', 'GUID', 'timer', 'glide_duration', 'user_image', 'image', 'translated_field', 'translated_html', 'field_name', 'table_name', 'sys_class_path', 'documentation_field', 'variables', 'template_value', 'related_tags', 'workflow', 'currency2', 'price']);
const SKIP_NAMES = new Set(['number', 'sys_id', 'user_password', 'password', 'sys_domain', 'sys_domain_path', 'sys_class_name', 'sys_mod_count', 'sys_tags']);

/** Whether a dictionary field can be given a generated value at all. */
export function isGeneratable(field) {
  if (!field || !field.name || field.active === false) return false;
  if (field.name.startsWith('sys_') || SKIP_NAMES.has(field.name)) return false;
  if (field.readOnly || field.calculated || field.array) return false;
  if (SKIP_TYPES.has(field.type)) return false;
  return true;
}

const NAME_STYLE = [
  [/^first_name$/, 'firstName'],
  [/^last_name$/, 'lastName'],
  [/^user_name$/, 'userName'],
  [/(^|_)e?mail($|_)/, 'email'],
  [/(^|_)(phone|mobile|fax)($|_)/, 'phone'],
  [/^city$/, 'city'],
  [/^(street|address)/, 'street'],
  [/^(zip|postal)/, 'zip'],
  [/^(url|website|web_?site)$/, 'url'],
  [/^title$/, 'title'],
  [/^short_description$/, 'sentence'],
  [/^(description|justification|reason|comments?|notes?)$/, 'paragraph'],
];

/** The default generator for a field, from its name first and its type second. */
export function defaultSpec(field, { choices = [], refs = [] } = {}) {
  const name = field.name;
  const type = String(field.type || '');
  if (field.choiceType && choices.length) {
    const usable = choices.filter((c) => !c.inactive && c.value !== '');
    if (usable.length) return { kind: 'choice', options: usable.map((c) => ({ value: c.value, label: c.label, weight: 1 })) };
  }
  if (type === 'reference') return refs.length ? { kind: 'ref', table: field.reference, mode: 'random', ids: refs.map((r) => r.sysId) } : { kind: 'ref', table: field.reference, mode: 'empty', ids: [] };
  for (const [re, style] of NAME_STYLE) if (re.test(name)) return { kind: 'text', style };
  if (type === 'boolean') return { kind: 'bool', chance: name === 'active' ? 1 : 0.5 };
  if (type === 'integer' || type === 'longint') return { kind: 'int', min: 0, max: 100 };
  if (['decimal', 'float', 'currency', 'percent_complete'].includes(type)) return { kind: 'decimal', min: 0, max: 1000, places: 2 };
  if (type === 'glide_date_time' || type === 'glide_date' || type === 'due_date') return { kind: 'date', daysBack: 30, daysForward: 0, time: type !== 'glide_date' };
  if (type === 'email') return { kind: 'text', style: 'email' };
  if (type === 'url') return { kind: 'text', style: 'url' };
  if (/phone/.test(type)) return { kind: 'text', style: 'phone' };
  if (type === 'html') return { kind: 'text', style: 'paragraph' };
  if (name === 'name') return { kind: 'pattern', pattern: 'test-{word}-{n}' };
  return { kind: 'text', style: Number(field.maxLength) > 80 ? 'sentence' : 'word' };
}

/** Per-table starting points: which fields are on, and the wording that suits the table. */
const TEMPLATES = {
  incident: {
    label: 'Incidents',
    include: ['short_description', 'description', 'caller_id', 'category', 'impact', 'urgency', 'contact_type'],
    specs: { short_description: { kind: 'text', style: 'incident' }, description: { kind: 'text', style: 'paragraph' } },
  },
  task: { label: 'Tasks', include: ['short_description', 'description'], specs: { short_description: { kind: 'text', style: 'request' } } },
  change_request: {
    label: 'Changes',
    include: ['short_description', 'description', 'type', 'category', 'justification', 'implementation_plan'],
    specs: { short_description: { kind: 'text', style: 'change' } },
  },
  problem: { label: 'Problems', include: ['short_description', 'description', 'category'], specs: { short_description: { kind: 'text', style: 'problem' } } },
  sys_user: {
    label: 'Users',
    include: ['first_name', 'last_name', 'user_name', 'email', 'title', 'phone', 'mobile_phone', 'city', 'notification', 'active'],
    specs: { active: { kind: 'fixed', value: 'true' } },
    prefer: { notification: /disable/i },
    note: 'Users are never deleted by NowBuddy; cleanup sets them inactive. New users can trigger welcome emails if notifications are on, so the notification choice is set to Disable where the list offers it.',
  },
  sys_user_group: {
    label: 'Groups',
    include: ['name', 'description', 'email', 'active'],
    specs: { name: { kind: 'pattern', pattern: 'Test group {n}' }, description: { kind: 'text', style: 'sentence' }, active: { kind: 'fixed', value: 'true' } },
  },
  cmdb_ci: {
    label: 'Configuration items',
    include: ['name', 'short_description', 'serial_number', 'ip_address', 'operational_status', 'asset_tag'],
    specs: { name: { kind: 'pattern', pattern: 'test-ci-{n}' }, serial_number: { kind: 'pattern', pattern: 'SN-{rand:8}' }, ip_address: { kind: 'pattern', pattern: '10.{rand:2}.{rand:2}.{n}' }, asset_tag: { kind: 'pattern', pattern: 'NB-{rand:6}' } },
  },
};

/** Tables offered in the picker (the last four are cmdb_ci classes that share the CI template). */
export const TABLE_PRESETS = [
  { table: 'incident', label: 'Incidents' },
  { table: 'task', label: 'Tasks' },
  { table: 'change_request', label: 'Changes' },
  { table: 'problem', label: 'Problems' },
  { table: 'sys_user', label: 'Users' },
  { table: 'sys_user_group', label: 'Groups' },
  { table: 'cmdb_ci', label: 'Configuration items' },
  { table: 'cmdb_ci_server', label: 'Servers' },
  { table: 'cmdb_ci_computer', label: 'Computers' },
  { table: 'cmdb_ci_linux_server', label: 'Linux servers' },
  { table: 'cmdb_ci_win_server', label: 'Windows servers' },
];

/** The template for a table, or null: cmdb_ci classes share the CI one. */
export function templateFor(table) {
  if (TEMPLATES[table]) return TEMPLATES[table];
  if (/^cmdb_ci_/.test(table)) return TEMPLATES.cmdb_ci;
  return null;
}

/**
 * Starting generators and the fields that are on, for a table.
 * @param {{table: string, fields: object[], choices?: Record<string, object[]>, refs?: Record<string, object[]>}} input
 * @returns {{ specs: Record<string, object>, include: string[], fields: object[], note?: string }}
 */
export function defaultPlanFields({ table, fields, choices = {}, refs = {} }) {
  const template = templateFor(table);
  const usable = fields.filter(isGeneratable);
  const specs = {};
  usable.forEach((f) => {
    specs[f.name] = defaultSpec(f, { choices: choices[f.name] || [], refs: refs[f.name] || [] });
    const override = template?.specs?.[f.name];
    if (override) specs[f.name] = override;
    const prefer = template?.prefer?.[f.name];
    if (prefer) {
      const hit = (choices[f.name] || []).find((c) => prefer.test(c.label || '') || prefer.test(c.value || ''));
      if (hit) specs[f.name] = { kind: 'fixed', value: hit.value };
    }
  });
  const display = usable.find((f) => f.display);
  const on = new Set([...(template?.include || [])]);
  usable.forEach((f) => {
    if (f.mandatory) on.add(f.name);
  });
  if (!template && display) on.add(display.name);
  if (!on.size && usable.length) on.add((usable.find((f) => f.name === 'short_description') || usable.find((f) => f.name === 'name') || usable[0]).name);
  return { specs, include: usable.filter((f) => on.has(f.name)).map((f) => f.name), fields: usable, note: template?.note };
}

// --- Rows ------------------------------------------------------------------------------------------------

/** The field that carries the marker: short_description, else the display field, else name. */
export function markerField(fields) {
  const names = new Set(fields.map((f) => f.name));
  if (names.has('short_description')) return 'short_description';
  const display = fields.find((f) => f.display && isGeneratable(f));
  if (display) return display.name;
  return names.has('name') ? 'name' : null;
}

const clipTo = (value, max) => (Number(max) > 0 && value.length > Number(max) ? value.slice(0, Number(max)) : value);

/**
 * The rows a plan would create. Same seed, same rows.
 * @param {{ table: string, fields: object[], specs: object, include: string[], count: number, seed?: string|number, now?: Date, batch?: string }} plan
 * @returns {{ rows: object[], notes: string[], problems: string[], marker: string|null }}
 */
export function buildRows({ table, fields, specs, include, count, seed = 1, now = new Date(), batch = '' }) {
  const rng = createRng(`${seed}:${table}`);
  const byName = new Map(fields.map((f) => [f.name, f]));
  const notes = [];
  const problems = [];
  const marker = markerField(fields);
  const wanted = new Set(include);
  fields.filter((f) => f.mandatory && isGeneratable(f)).forEach((f) => wanted.add(f.name));
  const names = [...wanted].filter((n) => byName.has(n));
  if (marker && !names.includes(marker)) names.unshift(marker);
  if (!marker) notes.push('This table has no short_description, display field or name, so the records carry no [NB-test] marker; cleanup relies on the journal only.');

  const seen = new Map();
  const rows = [];
  for (let n = 1; n <= count; n += 1) {
    const ctx = { rng, n, now, persona: persona(rng, n), batch };
    const row = {};
    names.forEach((name) => {
      const field = byName.get(name);
      const spec = specs[name] || defaultSpec(field);
      let value = generateValue(spec, ctx);
      if (typeof value !== 'string') value = String(value ?? '');
      if (value === '' && !field.mandatory) return;
      if (name === marker && !value.startsWith(MARKER)) value = `${MARKER} ${value}`.trim();
      value = clipTo(value, field.maxLength);
      if (field.unique) {
        const used = seen.get(name) || new Set();
        let candidate = value;
        // The suffix goes in before the column length is applied, so a long value is shortened to make room for it.
        for (let k = 2; used.has(candidate); k += 1) {
          const suffix = `-${k}`;
          const room = Number(field.maxLength) > 0 ? Math.max(Number(field.maxLength) - suffix.length, 1) : value.length;
          candidate = `${value.slice(0, room)}${suffix}`;
        }
        used.add(candidate);
        seen.set(name, used);
        value = candidate;
      }
      row[name] = value;
    });
    rows.push(row);
  }

  names.forEach((name) => {
    const field = byName.get(name);
    if (field.mandatory && rows.some((r) => !r[name])) problems.push(`"${field.label || name}" is mandatory but the generator leaves it empty. Pick a value or another generator.`);
    const spec = specs[name];
    if (spec?.kind === 'ref' && spec.mode !== 'fixed' && !spec.ids?.length && field.mandatory) problems.push(`"${field.label || name}" needs an existing ${spec.table || 'record'} to point at, and none was found. Enter a sys_id as a fixed value.`);
  });
  return { rows, notes, problems, marker };
}

// --- Plan checks and the confirmation ----------------------------------------------------------------------

/**
 * Whether a run may go ahead. Writes only on an instance positively identified as dev, test or stage.
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
export function validatePlan({ table, count, env, rows = [] }) {
  const problems = [];
  const warnings = [];
  if (!TABLE_RE.test(table || '')) problems.push('Name a table first, for example incident.');
  if (!Number.isInteger(count) || count < 1) problems.push('Choose how many records, from 1 to 50.');
  else if (count > MAX_PER_RUN) problems.push(`At most ${MAX_PER_RUN} records per run.`);
  if (isGuardedEnv(env)) problems.push('This instance is not recognised as dev, test or stage, so NowBuddy will not create test data on it. (A production-looking name or label always blocks it.)');
  if (TABLE_RE.test(table || '') && rows[0]) {
    const verdict = assessWrite({ op: 'create', table, fields: rows[0] });
    if (verdict.block) problems.push(verdict.block);
    verdict.warnings.forEach((w) => warnings.push(w));
  }
  return { ok: problems.length === 0, problems, warnings };
}

/** What the confirmation says. Honest about update sets: only tables the platform tracks are captured. */
export function createAsk({ table, count, updateSet = '', instance = '', fieldCount = 0 }) {
  const lines = [
    `Create ${count} ${table} record${count === 1 ? '' : 's'} on ${instance || 'this instance'}, one by one, as you.`,
    `Each gets ${MARKER} in its text so you can find it, and the list is saved here so "Clean up" removes exactly these.`,
  ];
  const details = [
    `Table: ${table}`,
    `Records: ${count} (cap ${MAX_PER_RUN} per run)`,
    `Fields filled: ${fieldCount}`,
    `Current update set: ${updateSet || 'unknown'}`,
    'Data tables (incident, user, task and so on) are not captured in update sets. A configuration table would be, and those records would then travel with the update set.',
    'Business rules, flows and notifications on this table run for every record, as they would for real ones.',
  ];
  return { title: `Create ${count} test ${table} record${count === 1 ? '' : 's'}?`, message: lines.join('\n'), details: details.join('\n'), confirmLabel: `Create ${count}`, danger: false };
}

/** What the cleanup confirmation says. */
export function cleanupAsk({ table = '', records = 0, deactivates = 0, scope = 'batch' }) {
  const where = scope === 'all' ? 'all your test data on this instance' : `this batch${table ? ` of ${table}` : ''}`;
  const lines = [`Remove ${records} record${records === 1 ? '' : 's'} from ${where}. Only the sys_ids NowBuddy journaled when it created them are touched; ones that are already gone are skipped.`];
  if (deactivates) lines.push(`${deactivates} of them are users: NowBuddy never deletes users, it sets them inactive instead.`);
  return { title: `Clean up ${records} test record${records === 1 ? '' : 's'}?`, message: lines.join('\n'), confirmLabel: 'Clean up', danger: true };
}

// --- Running a batch --------------------------------------------------------------------------------------

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create rows one at a time (never in parallel: business rules and number generators run per record).
 * Stops after two failures in a row (usually a policy or mandatory-field problem that would repeat).
 * @param {{ rows: object[], create: (row: object, index: number) => Promise<{sysId: string, display?: string}>, onRecord?: (state: object) => void, shouldStop?: () => boolean, delayMs?: number, sleep?: (ms: number) => Promise<void> }} deps
 */
export async function runBatch({ rows, create, onRecord, shouldStop = () => false, delayMs = 150, sleep = sleepFor }) {
  const created = [];
  const failed = [];
  let streak = 0;
  let stopped = '';
  for (let i = 0; i < rows.length; i += 1) {
    if (shouldStop()) {
      stopped = 'Stopped by you.';
      break;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- one record at a time, on purpose
      const made = await create(rows[i], i);
      if (!SYS_ID_RE.test(made?.sysId || '')) throw new Error('The instance did not return the new record.');
      created.push({ sysId: made.sysId, display: made.display || '' });
      streak = 0;
      onRecord?.({ index: i, ok: true, record: created[created.length - 1], created: created.length, failed: failed.length, total: rows.length });
    } catch (err) {
      failed.push({ index: i, error: err?.message || String(err) });
      streak += 1;
      onRecord?.({ index: i, ok: false, error: err?.message || String(err), created: created.length, failed: failed.length, total: rows.length });
      if (streak >= 2) {
        stopped = `Stopped after two failures in a row: ${err?.message || err}`;
        break;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    if (i < rows.length - 1) await sleep(delayMs);
  }
  return { created, failed, stopped };
}

// --- Journal ---------------------------------------------------------------------------------------------

/** Users are deactivated, everything else is deleted. */
export const cleanupMode = (table) => (table === 'sys_user' ? 'deactivate' : 'delete');

export function newBatchId(now = Date.now(), rng = Math.random) {
  return `${now.toString(36)}${Math.floor(rng() * 1296).toString(36).padStart(2, '0')}`;
}

/** Add created records to a batch (creating the batch if it is new). Pure: returns the new journal. */
export function addRecords(journal, { batchId, table, instance, at = Date.now(), seed = '', records }) {
  const list = Array.isArray(journal) ? journal.map((b) => ({ ...b, records: [...b.records] })) : [];
  let batch = list.find((b) => b.id === batchId);
  if (!batch) {
    batch = { id: batchId, table, instance, at, seed: String(seed), records: [] };
    list.unshift(batch);
  }
  records.forEach((r) => {
    if (SYS_ID_RE.test(r.sysId) && !batch.records.some((x) => x.sysId === r.sysId)) batch.records.push({ sysId: r.sysId, display: String(r.display || '').slice(0, 120) });
  });
  return list.slice(0, JOURNAL_CAP);
}

/** Take cleaned-up records out of the journal; an empty batch disappears. */
export function removeRecords(journal, batchId, sysIds) {
  const gone = new Set(sysIds);
  return (journal || [])
    .map((b) => (b.id === batchId ? { ...b, records: b.records.filter((r) => !gone.has(r.sysId)) } : b))
    .filter((b) => b.records.length > 0);
}

export const batchesFor = (journal, instance) => (journal || []).filter((b) => b.instance === instance);

/**
 * Clean records up. `exists(table, sysIds)` answers which of them are still on the instance; `remove(record)` returns
 * 'deleted' or 'deactivated' and throws when it cannot.
 */
export async function runCleanup({ table, records, exists, remove, onRecord, sleep = sleepFor, delayMs = 80 }) {
  const present = await exists(table, records.map((r) => r.sysId));
  const report = { removed: [], deactivated: [], alreadyGone: [], failed: [] };
  for (const record of records) {
    if (!present.has(record.sysId)) {
      report.alreadyGone.push(record.sysId);
      onRecord?.({ record, outcome: 'gone' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await remove(record);
      (outcome === 'deactivated' ? report.deactivated : report.removed).push(record.sysId);
      onRecord?.({ record, outcome });
    } catch (err) {
      report.failed.push({ sysId: record.sysId, error: err?.message || String(err) });
      onRecord?.({ record, outcome: 'failed', error: err?.message || String(err) });
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  return report;
}

/** The sys_ids a finished cleanup no longer needs to remember (gone, removed or deactivated). */
export const settledIds = (report) => [...report.removed, ...report.deactivated, ...report.alreadyGone];

/** One line for the toast / panel after a cleanup. */
export function cleanupSummary(report) {
  const parts = [];
  if (report.removed.length) parts.push(`${report.removed.length} deleted`);
  if (report.deactivated.length) parts.push(`${report.deactivated.length} deactivated`);
  if (report.alreadyGone.length) parts.push(`${report.alreadyGone.length} already gone`);
  if (report.failed.length) parts.push(`${report.failed.length} failed`);
  return parts.length ? `Cleanup: ${parts.join(', ')}.` : 'Nothing to clean up.';
}

/** Plain-text preview of the first rows, for copying. */
export function previewText(rows, limit = 5) {
  return rows
    .slice(0, limit)
    .map((row, i) => `${i + 1}. ${Object.entries(row).map(([k, v]) => `${k}=${v}`).join(' | ')}`)
    .join('\n');
}
