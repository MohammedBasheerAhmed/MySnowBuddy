// In-page approval dialog for tool calls that did not originate in the sidebar
// (an external MCP client). Built node by node: tool arguments and script text
// are untrusted, so nothing here goes through innerHTML.
import { describeCall } from '../lib/agent/policy.js';
import { trustedDom } from '../sidebar/trusted.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A small table of untrusted values, built with textContent only. */
function fieldTable(headers, rows) {
  const table = el('table', 'msb-approval__fields');
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h) => {
    const th = el('th', null, h);
    th.scope = 'col';
    hr.append(th);
  });
  thead.append(hr);
  const tbody = el('tbody');
  // Every row and every value in full; a long value scrolls inside its cell instead of being cut.
  rows.forEach((cells) => {
    const tr = el('tr');
    cells.forEach((c, i) => {
      const text = c === '' || c == null ? '(empty)' : String(c);
      const cell = i === 0 ? el('th', null, text) : el('td');
      if (i === 0) cell.scope = 'row';
      else cell.append(el('div', 'msb-approval__cell', text));
      tr.append(cell);
    });
    tbody.append(tr);
  });
  table.append(thead, tbody);
  return table;
}

export function createApprovalDialog({ getInstanceInfo }) {
  const host = el('div', 'msb-approval');
  host.hidden = true;
  const queue = [];
  let active = false;
  let current = null; // the request on screen: { request, resolve }

  function close() {
    host.hidden = true;
    host.replaceChildren();
    active = false;
    current = null;
    next();
  }

  function next() {
    if (active || !queue.length) return;
    active = true;
    const { request, resolve } = queue.shift();
    current = { request, resolve };
    render(request, (approved, note) => {
      resolve({ approved, note });
      close();
    });
  }

  function render(request, done) {
    const info = describeCall(request.tool, request.args);
    const instance = getInstanceInfo();
    const strong = request.mode === 'ask-strong';

    const preview = request.preview || {};
    const structured = Boolean(preview.fieldDiff?.length || preview.fieldList?.length);
    const card = el('div', 'msb-approval__card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'msb-approval-title');

    const head = el('div', 'msb-approval__head');
    const source = { mcp: ['External agent', 'An MCP client connected to this browser is asking to:'], user: ['You', 'You asked to:'] }[request.source] || ['Agent', 'The agent is asking to:'];
    head.append(el('span', 'msb-approval__badge', source[0]), el('span', `msb-env msb-env--${instance.tone}`, instance.label));
    const title = el('h2', 'msb-approval__title', info.title);
    title.id = 'msb-approval-title';
    card.append(head, title);
    card.append(el('p', 'msb-approval__who', source[1]));
    if (preview.target) card.append(el('p', 'msb-approval__target', preview.target));
    if (structured && request.args?.reason) card.append(el('p', 'msb-approval__detail', String(request.args.reason)));
    else if (info.detail) card.append(el('p', 'msb-approval__detail', info.detail));
    card.append(el('p', 'msb-approval__risk', info.risk));
    if (preview.blocked) card.append(el('p', 'msb-approval__verify msb-approval__verify--bad', `This will be refused: ${preview.blocked}`));
    for (const w of preview.warnings || []) card.append(el('p', 'msb-approval__warn', w));
    for (const n of preview.notes || []) card.append(el('p', 'msb-approval__who', n));
    if (preview.fieldDiff?.length) card.append(fieldTable(['Field', 'Now', 'After'], preview.fieldDiff.map((r) => [r.label || r.field, r.before, r.after])));
    else if (preview.fieldList?.length) card.append(fieldTable(['Field', 'Value'], preview.fieldList.map((r) => [r.label || r.field, r.value])));
    // Code is shown in full (the block scrolls): what is approved is exactly what runs.
    if (info.code) card.append(el('pre', 'msb-approval__code', info.code));
    if (preview.verification) {
      const v = preview.verification;
      card.append(el('p', `msb-approval__verify msb-approval__verify--${v.ok ? 'ok' : 'bad'}`, v.summary));
    }
    if (preview.risk) card.append(el('pre', 'msb-approval__code msb-approval__code--risk', preview.risk));
    if (preview.undo) card.append(el('p', 'msb-approval__undo', preview.undo));

    let confirmInput = null;
    if (strong) {
      const kind = instance.env === 'prod' ? 'a production instance' : 'not recognisably a dev, test or stage instance';
      card.append(el('p', 'msb-approval__prod', `This is ${kind} (${instance.host}). Type its name to allow the change.`));
      confirmInput = el('input', 'msb-approval__confirm');
      confirmInput.placeholder = instance.instance;
      card.append(confirmInput);
    }

    const actions = el('div', 'msb-approval__actions');
    const deny = el('button', 'msb-btn', 'Deny');
    const allow = el('button', 'msb-btn msb-btn--primary', 'Allow once');
    deny.type = 'button';
    allow.type = 'button';
    // A call the executor will refuse anyway cannot be allowed.
    const blocked = Boolean(preview.blocked);
    if (strong || blocked) {
      allow.disabled = true;
      // Typed confirmation: only real keystrokes count, never a page script's synthetic input event.
      confirmInput?.addEventListener('input', trustedDom(() => {
        allow.disabled = blocked || confirmInput.value.trim().toLowerCase() !== instance.instance.toLowerCase();
      }));
    }
    deny.addEventListener('click', () => done(false, 'denied in the browser'));
    allow.addEventListener('click', trustedDom(() => done(true)));
    actions.append(deny, allow);
    card.append(actions);

    host.replaceChildren(card);
    host.hidden = false;
    (strong ? confirmInput : deny).focus();
  }

  return {
    element: host,
    /** Withdraw a request (on screen or still queued) whose caller has given up. Resolves it as not approved. */
    cancel(id) {
      if (id === undefined || id === null) return false;
      if (current && current.request.id === id) {
        current.resolve({ approved: false, note: 'cancelled' });
        close();
        return true;
      }
      const at = queue.findIndex((q) => q.request.id === id);
      if (at < 0) return false;
      queue.splice(at, 1)[0].resolve({ approved: false, note: 'cancelled' });
      return true;
    },
    /** @returns {Promise<{approved: boolean, note?: string}>} */
    request(request) {
      return new Promise((resolve) => {
        queue.push({ request, resolve });
        next();
      });
    },
  };
}
