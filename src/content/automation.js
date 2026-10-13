// Page automation runner: navigates and clicks through ServiceNow screens on
// behalf of the user.
//
// SECURITY:
//  - Steps come only from the user (sidebar panel). A run is kept in the
//    service worker keyed by tab, not in page-readable storage, so a page
//    script cannot inject steps.
//  - `goto` is limited to root-relative paths on the current instance.
//  - Clicks whose label looks like a data change ask for confirmation first.
//  - Password fields are never typed into.

import { shellUrl } from './quickActions.js';
import { describeStep, isRiskyLabel, normalizeRun } from '../lib/automation.js';

const HOST_ID = 'mysnowbuddy-root';
const STEP_TIMEOUT_MS = 15000;
const POLL_MS = 250;
const MAX_RUN_AGE_MS = 10 * 60 * 1000;

const CLICKABLE = 'button, a, input[type="button"], input[type="submit"], [role="button"], [role="tab"], [role="menuitem"], [role="link"], label';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

/** The document, same-origin iframes (classic `gsft_main`) and open shadow roots. */
function collectRoots() {
  const roots = [document];
  for (let i = 0; i < roots.length && roots.length < 500; i++) {
    const root = roots[i];
    for (const el of root.querySelectorAll('*')) {
      if (el.id === HOST_ID) continue;
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.tagName === 'IFRAME') {
        try {
          if (el.contentDocument) roots.push(el.contentDocument);
        } catch {
          // Cross-origin frame.
        }
      }
    }
  }
  return roots;
}

function isVisible(el) {
  const view = el.ownerDocument.defaultView;
  return el.getClientRects().length > 0 && view.getComputedStyle(el).visibility !== 'hidden';
}

function labelOf(el) {
  return [el.getAttribute('aria-label'), el.value, el.innerText || el.textContent, el.title]
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => s.replace(/\s+/g, ' ').trim())[0] || '';
}

function findElement(selector) {
  const roots = collectRoots();
  if (selector.startsWith('text:')) {
    const wanted = selector.slice(5).trim().toLowerCase();
    for (const root of roots) {
      for (const el of root.querySelectorAll(CLICKABLE)) {
        if (labelOf(el).toLowerCase() === wanted && isVisible(el)) return el;
      }
    }
    return null;
  }
  for (const root of roots) {
    let matches;
    try {
      matches = root.querySelectorAll(selector);
    } catch {
      throw new Error(`Invalid selector: ${selector}`);
    }
    for (const el of matches) if (isVisible(el)) return el;
  }
  return null;
}

async function waitForElement(selector, isCancelled) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isCancelled()) throw new Error('Stopped.');
    const el = findElement(selector);
    if (el) return el;
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  const Evt = el.ownerDocument.defaultView.Event;
  el.dispatchEvent(new Evt('input', { bubbles: true }));
  el.dispatchEvent(new Evt('change', { bubbles: true }));
}

const FIELDS = 'input, select, textarea';
const SNAPSHOT_LIMIT = 120;

function selectorFor(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const name = el.getAttribute('name');
  return name ? `[name="${name.replace(/["\\]/g, '\\$&')}"]` : null;
}

function fieldLabel(el) {
  const text = el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.placeholder || el.title || '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Compact text description of what can be clicked or filled on the page. Field values are left out. */
function snapshotPage() {
  const lines = [`Path: ${window.location.pathname}${window.location.search}`.slice(0, 200), `Title: ${document.title.slice(0, 100)}`];
  const seen = new Set();
  for (const root of collectRoots()) {
    for (const el of root.querySelectorAll(`${CLICKABLE}, ${FIELDS}`)) {
      if (lines.length >= SNAPSHOT_LIMIT) return lines.join('\n');
      if (el.type === 'hidden' || el.type === 'password' || !isVisible(el)) continue;

      let line;
      if (el.matches(FIELDS)) {
        const selector = selectorFor(el);
        if (!selector) continue;
        line = `field ${el.tagName.toLowerCase()}${el.type ? `:${el.type}` : ''} ${selector} "${fieldLabel(el)}"`;
      } else {
        const label = labelOf(el).slice(0, 60);
        const selector = selectorFor(el) || (label ? `text:${label}` : null);
        if (!selector) continue;
        line = `click ${selector} "${label}"`;
      }
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines.join('\n');
}

export function createAutomation({ toast }) {
  const listeners = new Set();
  let running = false;
  let cancelled = false;

  const emit = (event) => listeners.forEach((fn) => fn(event));

  async function runStep(step) {
    if (step.action === 'wait') return sleep(Number(step.value));
    if (step.action === 'waitfor') return void (await waitForElement(step.target, () => cancelled));

    const el = await waitForElement(step.target, () => cancelled);

    if (step.action === 'click') {
      const label = `${el.id || ''} ${el.getAttribute('name') || ''} ${labelOf(el)}`;
      if (isRiskyLabel(label)) {
        const ok = window.confirm(`Automation is about to click "${labelOf(el) || el.id}", which may change data. Continue?`);
        if (!ok) throw new Error('Declined at the confirmation prompt.');
      }
      el.scrollIntoView({ block: 'center' });
      el.click();
      return undefined;
    }

    if (step.action === 'type') {
      if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) throw new Error(`${step.target} is not a text field.`);
      if (el.type === 'password') throw new Error('Typing into password fields is not allowed.');
      el.focus();
      setNativeValue(el, step.value);
      return undefined;
    }

    if (step.action === 'select') {
      if (el.tagName !== 'SELECT') throw new Error(`${step.target} is not a drop-down.`);
      const wanted = step.value.trim().toLowerCase();
      const option = [...el.options].find((o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted);
      if (!option) throw new Error(`No option "${step.value}" in ${step.target}.`);
      setNativeValue(el, option.value);
      return undefined;
    }
    return undefined;
  }

  async function execute(run) {
    running = true;
    cancelled = false;
    const total = run.steps.length;
    try {
      while (run.index < total) {
        if (cancelled) throw new Error('Stopped.');
        const i = run.index;
        const step = run.steps[i];
        emit({ type: 'step', index: i, total, text: describeStep(step), status: 'running' });

        // Saved first: a click or goto can reload the page and end this script.
        run.index = i + 1;
        await send('AUTOMATION_SAVE', run);

        if (step.action === 'newtab' || step.action === 'switchtab') {
          const response = await send('AUTOMATION_HANDOFF', {
            run,
            mode: step.action,
            path: step.action === 'newtab' ? shellUrl(step.target) : undefined,
            tab: Number(step.target),
          });
          if (!response?.ok) throw new Error(response?.error || 'Could not change tab.');
          emit({ type: 'step', index: i, total, text: describeStep(step), status: 'done' });
          emit({ type: 'handoff', total });
          running = false;
          return;
        }

        if (step.action === 'goto') {
          emit({ type: 'step', index: i, total, text: describeStep(step), status: 'done' });
          window.location.assign(shellUrl(step.target));
          return;
        }
        await runStep(step);
        emit({ type: 'step', index: i, total, text: describeStep(step), status: 'done' });
      }
      emit({ type: 'finished', total });
      toast.success(`Automation finished (${total} steps).`);
    } catch (err) {
      emit({ type: 'failed', index: run.index - 1, message: err.message });
      toast.error(`Automation stopped at step ${run.index}: ${err.message}`);
    }
    running = false;
    await send('AUTOMATION_SAVE', null);
  }

  return {
    isRunning: () => running,
    snapshot: snapshotPage,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async run(steps) {
      if (running) throw new Error('An automation is already running.');
      const run = normalizeRun({ id: String(Date.now()), origin: window.location.origin, startedAt: Date.now(), steps, index: 0 });
      if (!run) throw new Error('Invalid steps.');
      return execute(run);
    },

    cancel() {
      cancelled = true;
      return send('AUTOMATION_SAVE', null);
    },

    /** Continue a run that was interrupted by a page navigation. */
    async resume() {
      if (running) return;
      const response = await send('AUTOMATION_LOAD').catch(() => null);
      const run = normalizeRun(response?.run);
      if (!run || run.origin !== window.location.origin || Date.now() - run.startedAt > MAX_RUN_AGE_MS) {
        if (response?.run) await send('AUTOMATION_SAVE', null);
        return;
      }
      if (run.index >= run.steps.length) {
        await send('AUTOMATION_SAVE', null);
        toast.success(`Automation finished (${run.steps.length} steps).`);
        return;
      }
      await execute(run);
    },
  };
}
